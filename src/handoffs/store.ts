import { handoffTtlSeconds, maxHandoffBytes } from "../security.js";
import {
  CAPABILITY,
  DEMO_LIMITS,
  HANDOFF_ID,
  type ReserveInput,
  type ServiceReply,
} from "./protocol.js";

const DAY = 86_400_000;
const MINUTE = 60_000;
const CREDENTIAL_TTL = 7_200_000;

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
export type HandoffStoreConfig = {
  PODAJ_MODE?: string;
  HANDOFF_TTL_SECONDS?: string;
  MAX_HANDOFF_BYTES?: string;
};
type Handoff = {
  id: string;
  fingerprint: string;
  write_hash: string;
  read_hash: string;
  subscribe_hash: string;
  state: "pending" | "ready" | "consumed";
  sealed: string | null;
  expires_at: number;
};
type Credential = { fingerprint: string; expires_at: number };
const reply = (status: number, body: ServiceReply["body"]): ServiceReply => ({ status, body });
const gone = (): ServiceReply => reply(410, { status: "gone" });
const unauthorized = (): ServiceReply => reply(401, { error: "unauthorized" });
const exhausted = (): ServiceReply => reply(429, { error: "limit reached" });

/** All authoritative reads and mutations are synchronous SQLite transactions. */
export class HandoffStore {
  private readonly storage: Storage;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;

  constructor(storage: Storage, config: HandoffStoreConfig = {}, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
    const demo = config.PODAJ_MODE === "demo";
    this.ttlMs = Math.min(handoffTtlSeconds(config.HANDOFF_TTL_SECONDS), demo ? 7200 : 86400) * 1000;
    this.maxBytes = Math.min(maxHandoffBytes(config.MAX_HANDOFF_BYTES), demo ? 32768 : Number.MAX_SAFE_INTEGER);
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        write_hash TEXT NOT NULL,
        read_hash TEXT NOT NULL,
        subscribe_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'consumed')),
        sealed TEXT,
        expires_at INTEGER NOT NULL,
        CHECK ((state = 'ready' AND sealed IS NOT NULL) OR (state != 'ready' AND sealed IS NULL))
      )`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS handoffs_expiry ON handoffs(expires_at)");
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS credentials (
        challenge TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS credentials_expiry ON credentials(expires_at)");
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS counters (
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK (count > 0),
        PRIMARY KEY (kind, subject, bucket)
      )`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS counters_expiry ON counters(bucket)");
    });
  }

  private handoff(id: string): Handoff | undefined {
    return this.storage.sql.exec<Handoff>("SELECT * FROM handoffs WHERE id = ?", id).toArray()[0];
  }

  private credential(challenge: string): Credential | undefined {
    return this.storage.sql.exec<Credential>(
      "SELECT fingerprint, expires_at FROM credentials WHERE challenge = ?", challenge,
    ).toArray()[0];
  }

  private count(kind: string, subject: string, bucket: number): number {
    return this.storage.sql.exec<{ count: number }>(
      "SELECT count FROM counters WHERE kind = ? AND subject = ? AND bucket = ?", kind, subject, bucket,
    ).toArray()[0]?.count ?? 0;
  }

  private increment(kind: string, subject: string, bucket: number): void {
    this.storage.sql.exec(`INSERT INTO counters(kind, subject, bucket, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(kind, subject, bucket) DO UPDATE SET count = count + 1`, kind, subject, bucket);
  }

  private purge(now: number): void {
    this.storage.sql.exec("DELETE FROM handoffs WHERE expires_at <= ?", now);
    this.storage.sql.exec("DELETE FROM credentials WHERE expires_at <= ?", now);
    this.storage.sql.exec("DELETE FROM counters WHERE bucket < ?", now - 2 * DAY);
  }

  cleanup(): void {
    this.storage.transactionSync(() => {
      this.purge(this.now());
    });
  }

  /** Includes counters so an idle object eventually discards admission metadata. */
  nextExpiry(): number | null {
    return this.storage.sql.exec<{ deadline: number | null }>(`SELECT MIN(deadline) AS deadline FROM (
      SELECT MIN(expires_at) AS deadline FROM handoffs
      UNION ALL SELECT MIN(expires_at) FROM credentials
      UNION ALL SELECT MIN(bucket) + ${2 * DAY + 1} FROM counters
    )`).toArray()[0]?.deadline ?? null;
  }

  activeExpiry(id: string): number | null {
    return this.storage.transactionSync(() => {
      const row = this.handoff(id);
      return row && row.state !== "consumed" && row.expires_at > this.now() ? row.expires_at : null;
    });
  }

  reserve(input: ReserveInput): ServiceReply {
    if (!HANDOFF_ID.test(input.id) || !CAPABILITY.test(input.recipientFingerprint) ||
      !CAPABILITY.test(input.writeHash) || !CAPABILITY.test(input.readHash) ||
      !CAPABILITY.test(input.subscribeHash) ||
      new Set([input.writeHash, input.readHash, input.subscribeHash]).size !== 3 ||
      (input.creatorHash !== null && !CAPABILITY.test(input.creatorHash))) {
      return reply(400, { error: "invalid reservation" });
    }
    return this.storage.transactionSync(() => {
      const now = this.now();
      const day = Math.floor(now / DAY) * DAY;
      this.purge(now);
      if (input.creatorHash !== null) {
        const credential = this.credential(input.creatorHash);
        if (!credential || credential.expires_at <= now || credential.fingerprint !== input.recipientFingerprint) {
          return unauthorized();
        }
      }
      if (this.handoff(input.id)) return reply(409, { error: "already exists" });
      const live = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM handoffs WHERE state != 'consumed'").toArray()[0].count;
      if (live >= DEMO_LIMITS.liveHandoffs ||
        this.count("reserve", "", day) >= DEMO_LIMITS.reservationsPerDay ||
        (input.creatorHash !== null && this.count("actor", input.creatorHash, day) >= DEMO_LIMITS.reservationsPerCredentialPerDay)) {
        return exhausted();
      }
      const expiresAt = now + this.ttlMs;
      this.storage.sql.exec(`INSERT INTO handoffs
        (id, fingerprint, write_hash, read_hash, subscribe_hash, state, sealed, expires_at)
        VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)`, input.id, input.recipientFingerprint,
      input.writeHash, input.readHash, input.subscribeHash, expiresAt);
      this.increment("reserve", "", day);
      if (input.creatorHash !== null) this.increment("actor", input.creatorHash, day);
      return reply(201, { id: input.id, expiresAt, recipientFingerprint: input.recipientFingerprint });
    });
  }

  /** Read-only preflight; fill must revalidate after the request body arrives. */
  authorizeWrite(id: string, writeHash: string): ServiceReply {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<Pick<Handoff, "write_hash" | "state" | "expires_at">>(
        "SELECT write_hash, state, expires_at FROM handoffs WHERE id = ?", id,
      ).toArray().at(0);
      if (!CAPABILITY.test(writeHash) || (row && row.write_hash !== writeHash)) return unauthorized();
      if (!row || row.expires_at <= this.now()) return gone();
      if (row.state !== "pending") return reply(409, { error: "already filled" });
      return reply(200, { authorized: true });
    });
  }

  fill(id: string, writeHash: string, sealed: string): ServiceReply {
    return this.storage.transactionSync(() => {
      const row = this.handoff(id);
      if (!CAPABILITY.test(writeHash) || (row && row.write_hash !== writeHash)) return unauthorized();
      const now = this.now();
      if (!row || row.expires_at <= now) return gone();
      if (row.state !== "pending") return reply(409, { error: "already filled" });
      if (typeof sealed !== "string" || !sealed.startsWith("PODAJ1.")) return reply(400, { error: "invalid ciphertext" });
      if (new TextEncoder().encode(sealed).byteLength > this.maxBytes) return reply(413, { error: "ciphertext too large" });
      const expiresAt = now + this.ttlMs;
      this.storage.sql.exec("UPDATE handoffs SET state = 'ready', sealed = ?, expires_at = ? WHERE id = ?", sealed, expiresAt, id);
      return reply(200, { id, expiresAt });
    });
  }

  consume(id: string, readHash: string): ServiceReply {
    return this.storage.transactionSync(() => {
      const row = this.handoff(id);
      if (!CAPABILITY.test(readHash) || (row && row.read_hash !== readHash)) return unauthorized();
      if (!row || row.expires_at <= this.now() || row.state === "consumed") return gone();
      if (row.state === "pending") return reply(404, { error: "not ready" });
      this.storage.sql.exec("UPDATE handoffs SET state = 'consumed', sealed = NULL WHERE id = ?", id);
      return reply(200, { sealed: row.sealed, recipientFingerprint: row.fingerprint });
    });
  }

  status(id: string, subscribeHash: string): ServiceReply {
    return this.storage.transactionSync(() => {
      const row = this.handoff(id);
      if (!CAPABILITY.test(subscribeHash) || (row && row.subscribe_hash !== subscribeHash)) return unauthorized();
      if (!row || row.expires_at <= this.now() || row.state === "consumed") return gone();
      return reply(200, { status: row.state, expiresAt: row.expires_at });
    });
  }

  approvalAttempt(ipHash: string): ServiceReply {
    if (!CAPABILITY.test(ipHash)) return reply(400, { error: "invalid IP digest" });
    return this.storage.transactionSync(() => {
      const now = this.now();
      const day = Math.floor(now / DAY) * DAY;
      const minute = Math.floor(now / MINUTE) * MINUTE;
      this.purge(now);
      if (this.count("attempt", "", day) >= DEMO_LIMITS.approvalAttemptsPerDay ||
        this.count("ip", ipHash, minute) >= DEMO_LIMITS.approvalAttemptsPerMinutePerIp) return exhausted();
      this.increment("attempt", "", day);
      this.increment("ip", ipHash, minute);
      return reply(200, { allowed: true });
    });
  }

  approveCredential(challenge: string, fingerprint: string): ServiceReply {
    if (!CAPABILITY.test(challenge) || !CAPABILITY.test(fingerprint)) return reply(400, { error: "invalid credential" });
    return this.storage.transactionSync(() => {
      const now = this.now();
      const day = Math.floor(now / DAY) * DAY;
      this.purge(now);
      const existing = this.credential(challenge);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return reply(409, { error: "recipient mismatch" });
        return reply(200, { approved: true, expiresAt: existing.expires_at });
      }
      if (this.count("approve", "", day) >= DEMO_LIMITS.approvalsPerDay) return exhausted();
      const expiresAt = now + CREDENTIAL_TTL;
      this.storage.sql.exec("INSERT INTO credentials(challenge, fingerprint, expires_at) VALUES (?, ?, ?)", challenge, fingerprint, expiresAt);
      this.increment("approve", "", day);
      return reply(200, { approved: true, expiresAt });
    });
  }

  credentialStatus(challenge: string): ServiceReply {
    if (!CAPABILITY.test(challenge)) return reply(400, { error: "invalid credential" });
    return this.storage.transactionSync(() => {
      const credential = this.credential(challenge);
      if (!credential || credential.expires_at <= this.now()) return reply(202, { status: "pending" });
      return reply(200, { status: "approved", expiresAt: credential.expires_at, recipientFingerprint: credential.fingerprint });
    });
  }
}
