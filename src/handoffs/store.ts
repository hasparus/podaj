import { handoffTtlSeconds, maxHandoffBytes } from "../security.js";
import { handoffAccess } from "./access.js";
import { decodeCreateContextInput } from "./context-contract.js";
import type { QuotaInfo } from "./quota.js";
import {
  CAPABILITY,
  DEMO_LIMITS,
  HANDOFF_ID,
  REQUEST_CONTEXT_LIMITS,
  type CreateContextReply,
  type GetContextReply,
  type ApprovalAttemptReply,
  type ApproveCredentialReply,
  type AuthorizeWriteReply,
  type ConsumeReply,
  type CredentialStatusReply,
  type FailureReply,
  type FillReply,
  type GoneReply,
  type ReserveInput,
  type ReserveReply,
  type StatusReply,
} from "./protocol.js";

const DAY = 86_400_000;
const MINUTE = 60_000;
const CREDENTIAL_TTL = 7_200_000;

const WINDOWS = {
  context_drafts_daily: { counter: "context_draft", periodMs: DAY, limit: DEMO_LIMITS.draftsPerDay },
  context_drafts_per_ip: { counter: "context_ip", periodMs: MINUTE, limit: DEMO_LIMITS.draftsPerMinutePerIp },
  reservations_daily: { counter: "reserve", periodMs: DAY, limit: DEMO_LIMITS.reservationsPerDay },
  reservations_per_credential: { counter: "actor", periodMs: DAY, limit: DEMO_LIMITS.reservationsPerCredentialPerDay },
  verification_attempts_daily: { counter: "attempt", periodMs: DAY, limit: DEMO_LIMITS.approvalAttemptsPerDay },
  verification_attempts_per_ip: { counter: "ip", periodMs: MINUTE, limit: DEMO_LIMITS.approvalAttemptsPerMinutePerIp },
  approvals_daily: { counter: "approve", periodMs: DAY, limit: DEMO_LIMITS.approvalsPerDay },
} as const satisfies Partial<Record<QuotaInfo["kind"], { counter: string; periodMs: number; limit: number }>>;
type WindowKind = keyof typeof WINDOWS;
const windowBucket = (now: number, periodMs: number): number => Math.floor(now / periodMs) * periodMs;

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
export type HandoffStoreConfig = {
  PODAJ_ACCESS?: string;
  HANDOFF_TTL_SECONDS?: string;
  MAX_HANDOFF_BYTES?: string;
};
/** The handoffs CHECK constraint guarantees this state/ciphertext relationship. */
type HandoffState =
  | { state: "pending"; sealed: null }
  | { state: "ready"; sealed: string }
  | { state: "consumed"; sealed: null };
export type HandoffRow = {
  id: string;
  fingerprint: string;
  write_hash: string;
  read_hash: string;
  subscribe_hash: string;
  expires_at: number;
} & HandoffState;
type Credential = { fingerprint: string; expires_at: number };
const gone = (): GoneReply => ({ status: 410, body: { status: "gone" } });
const unauthorized = (): FailureReply<401> => ({ status: 401, body: { error: "unauthorized" } });
const exhausted = (quota: QuotaInfo): FailureReply<429> => ({ status: 429, body: { error: "limit reached", quota } });

/** All authoritative reads and mutations are synchronous SQLite transactions. */
export class HandoffStore {
  private readonly storage: Storage;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  /** New records cannot expire sooner; existing earlier alarms are never postponed by a commit. */
  readonly cleanupDelayMs: number;

  constructor(storage: Storage, config: HandoffStoreConfig = {}, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
    const isPublic = handoffAccess(config) === "public";
    this.ttlMs = Math.min(handoffTtlSeconds(config.HANDOFF_TTL_SECONDS), isPublic ? 7200 : 86400) * 1000;
    this.maxBytes = Math.min(maxHandoffBytes(config.MAX_HANDOFF_BYTES), isPublic ? 32768 : Number.MAX_SAFE_INTEGER);
    this.cleanupDelayMs = Math.min(this.ttlMs, REQUEST_CONTEXT_LIMITS.draftTtlMs, CREDENTIAL_TTL);
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
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        write_hash TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS contexts_expiry ON contexts(expires_at)");
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

  private writableHandoff(id: string) {
    return this.storage.sql.exec<Pick<HandoffRow, "write_hash" | "state" | "expires_at">>(
      "SELECT write_hash, state, expires_at FROM handoffs WHERE id = ?", id,
    ).toArray().at(0);
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

  private checkWindow(kind: WindowKind, subject: string, now: number): FailureReply<429> | null {
    const { counter, periodMs, limit } = WINDOWS[kind];
    const bucket = windowBucket(now, periodMs);
    return this.count(counter, subject, bucket) < limit ? null : exhausted({
      kind, limit, periodSeconds: periodMs / 1000, resetAt: bucket + periodMs,
    });
  }

  private chargeWindow(kind: WindowKind, subject: string, now: number): void {
    const { counter, periodMs } = WINDOWS[kind];
    this.increment(counter, subject, windowBucket(now, periodMs));
  }

  private purge(now: number): void {
    this.storage.sql.exec("DELETE FROM contexts WHERE expires_at <= ?", now);
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
      UNION ALL SELECT MIN(expires_at) FROM contexts
      UNION ALL SELECT MIN(expires_at) FROM credentials
      UNION ALL SELECT MIN(bucket) + ${2 * DAY + 1} FROM counters
    )`).toArray()[0]?.deadline ?? null;
  }

  activeExpiry(id: string): number | null {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ expires_at: number }>(
        "SELECT expires_at FROM handoffs WHERE id = ? AND state != 'consumed' AND expires_at > ?", id, this.now(),
      ).toArray().at(0);
      return row?.expires_at ?? null;
    });
  }

  createContext(id: string, writeHash: string, encryptedContext: string, ipHash: string): CreateContextReply {
    try {
      decodeCreateContextInput({ id, writeHash, encryptedContext });
      if (typeof ipHash !== "string" || !CAPABILITY.test(ipHash)) throw new Error("invalid IP digest");
    } catch {
      return { status: 400, body: { error: "invalid context" } };
    }
    return this.storage.transactionSync(() => {
      const now = this.now();
      this.purge(now);
      const existing = this.storage.sql.exec<{ id: string }>(
        "SELECT id FROM contexts WHERE id = ? UNION ALL SELECT id FROM handoffs WHERE id = ?", id, id,
      ).toArray();
      if (existing.length > 0) return { status: 409, body: { error: "already exists" } };
      const rejected = this.checkWindow("context_drafts_daily", "", now) ?? this.checkWindow("context_drafts_per_ip", ipHash, now);
      if (rejected !== null) return rejected;
      const live = this.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM contexts WHERE NOT EXISTS (SELECT 1 FROM handoffs WHERE handoffs.id = contexts.id)",
      ).toArray()[0].count;
      if (live >= DEMO_LIMITS.liveDrafts) {
        return exhausted({ kind: "context_drafts_live", limit: DEMO_LIMITS.liveDrafts });
      }
      const expiresAt = now + REQUEST_CONTEXT_LIMITS.draftTtlMs;
      this.storage.sql.exec("INSERT INTO contexts(id, write_hash, ciphertext, expires_at) VALUES (?, ?, ?, ?)",
        id, writeHash, encryptedContext, expiresAt);
      this.chargeWindow("context_drafts_daily", "", now);
      this.chargeWindow("context_drafts_per_ip", ipHash, now);
      return { status: 201, body: { id, encryptedContext, expiresAt } };
    });
  }

  context(id: string): GetContextReply {
    if (typeof id !== "string" || !HANDOFF_ID.test(id)) return { status: 400, body: { error: "invalid context" } };
    const row = this.storage.sql.exec<{ id: string; ciphertext: string; expires_at: number }>(
      "SELECT id, ciphertext, expires_at FROM contexts WHERE id = ? AND expires_at > ?", id, this.now(),
    ).toArray().at(0);
    return row === undefined
      ? { status: 404, body: { error: "not found" } }
      : { status: 200, body: { id: row.id, encryptedContext: row.ciphertext, expiresAt: row.expires_at } };
  }

  reserve(input: ReserveInput): ReserveReply {
    if ((input.source !== "draft" && input.source !== "generated") ||
      !HANDOFF_ID.test(input.id) || !CAPABILITY.test(input.recipientFingerprint) ||
      !CAPABILITY.test(input.writeHash) || !CAPABILITY.test(input.readHash) ||
      !CAPABILITY.test(input.subscribeHash) ||
      new Set([input.writeHash, input.readHash, input.subscribeHash]).size !== 3 ||
      (input.creatorHash !== null && !CAPABILITY.test(input.creatorHash))) {
      return { status: 400, body: { error: "invalid reservation" } };
    }
    return this.storage.transactionSync(() => {
      const now = this.now();
      this.purge(now);
      if (input.creatorHash !== null) {
        const credential = this.credential(input.creatorHash);
        if (!credential || credential.expires_at <= now || credential.fingerprint !== input.recipientFingerprint) {
          return unauthorized();
        }
      }
      if (this.storage.sql.exec<{ id: string }>("SELECT id FROM handoffs WHERE id = ?", input.id).toArray().length > 0) {
        return { status: 409, body: { error: "already exists" } };
      }
      const context = this.storage.sql.exec<{ write_hash: string }>(
        "SELECT write_hash FROM contexts WHERE id = ?", input.id,
      ).toArray().at(0);
      if (input.source === "draft") {
        if (context === undefined) return gone();
        if (context.write_hash !== input.writeHash) return unauthorized();
      } else if (context !== undefined) {
        return { status: 409, body: { error: "already exists" } };
      }
      const dailyRejection = this.checkWindow("reservations_daily", "", now);
      if (dailyRejection !== null) return dailyRejection;
      const live = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM handoffs WHERE state != 'consumed'").toArray()[0].count;
      if (live >= DEMO_LIMITS.liveHandoffs) {
        return exhausted({ kind: "live_handoffs", limit: DEMO_LIMITS.liveHandoffs });
      }
      if (input.creatorHash !== null) {
        const credentialRejection = this.checkWindow("reservations_per_credential", input.creatorHash, now);
        if (credentialRejection !== null) return credentialRejection;
      }
      const expiresAt = now + this.ttlMs;
      this.storage.sql.exec(`INSERT INTO handoffs
        (id, fingerprint, write_hash, read_hash, subscribe_hash, state, sealed, expires_at)
        VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)`, input.id, input.recipientFingerprint,
      input.writeHash, input.readHash, input.subscribeHash, expiresAt);
      this.storage.sql.exec("UPDATE contexts SET expires_at = ? WHERE id = ?", expiresAt, input.id);
      this.chargeWindow("reservations_daily", "", now);
      if (input.creatorHash !== null) this.chargeWindow("reservations_per_credential", input.creatorHash, now);
      return { status: 201, body: { id: input.id, expiresAt, recipientFingerprint: input.recipientFingerprint } };
    });
  }

  /** Read-only preflight; fill must revalidate after the request body arrives. */
  authorizeWrite(id: string, writeHash: string): AuthorizeWriteReply {
    return this.storage.transactionSync(() => {
      const row = this.writableHandoff(id);
      if (!CAPABILITY.test(writeHash) || (row && row.write_hash !== writeHash)) return unauthorized();
      if (!row || row.expires_at <= this.now()) return gone();
      if (row.state !== "pending") return { status: 409, body: { error: "already filled" } };
      return { status: 200, body: { authorized: true } };
    });
  }

  fill(id: string, writeHash: string, sealed: string): FillReply {
    return this.storage.transactionSync(() => {
      const row = this.writableHandoff(id);
      if (!CAPABILITY.test(writeHash) || (row && row.write_hash !== writeHash)) return unauthorized();
      const now = this.now();
      if (!row || row.expires_at <= now) return gone();
      if (row.state !== "pending") return { status: 409, body: { error: "already filled" } };
      if (typeof sealed !== "string" || !sealed.startsWith("PODAJ1.")) return { status: 400, body: { error: "invalid ciphertext" } };
      if (new TextEncoder().encode(sealed).byteLength > this.maxBytes) return { status: 413, body: { error: "ciphertext too large" } };
      const expiresAt = Math.max(row.expires_at, now + this.ttlMs);
      this.storage.sql.exec("UPDATE handoffs SET state = 'ready', sealed = ?, expires_at = ? WHERE id = ?", sealed, expiresAt, id);
      this.storage.sql.exec("UPDATE contexts SET expires_at = ? WHERE id = ?", expiresAt, id);
      return { status: 200, body: { id, expiresAt } };
    });
  }

  consume(id: string, readHash: string): ConsumeReply {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<Pick<HandoffRow, "read_hash" | "fingerprint" | "expires_at"> & HandoffState>(
        "SELECT read_hash, fingerprint, state, sealed, expires_at FROM handoffs WHERE id = ?", id,
      ).toArray().at(0);
      if (!CAPABILITY.test(readHash) || (row && row.read_hash !== readHash)) return unauthorized();
      if (!row || row.expires_at <= this.now() || row.state === "consumed") return gone();
      if (row.state === "pending") return { status: 404, body: { error: "not ready" } };
      this.storage.sql.exec("UPDATE handoffs SET state = 'consumed', sealed = NULL WHERE id = ?", id);
      this.storage.sql.exec("DELETE FROM contexts WHERE id = ?", id);
      return { status: 200, body: { sealed: row.sealed, recipientFingerprint: row.fingerprint } };
    });
  }

  status(id: string, subscribeHash: string): StatusReply {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<Pick<HandoffRow, "subscribe_hash" | "state" | "expires_at">>(
        "SELECT subscribe_hash, state, expires_at FROM handoffs WHERE id = ?", id,
      ).toArray().at(0);
      if (!CAPABILITY.test(subscribeHash) || (row && row.subscribe_hash !== subscribeHash)) return unauthorized();
      if (!row || row.expires_at <= this.now() || row.state === "consumed") return gone();
      return { status: 200, body: { status: row.state, expiresAt: row.expires_at } };
    });
  }

  approvalAttempt(ipHash: string): ApprovalAttemptReply {
    if (!CAPABILITY.test(ipHash)) return { status: 400, body: { error: "invalid IP digest" } };
    return this.storage.transactionSync(() => {
      const now = this.now();
      this.purge(now);
      const rejected = this.checkWindow("verification_attempts_daily", "", now) ?? this.checkWindow("verification_attempts_per_ip", ipHash, now);
      if (rejected !== null) return rejected;
      this.chargeWindow("verification_attempts_daily", "", now);
      this.chargeWindow("verification_attempts_per_ip", ipHash, now);
      return { status: 200, body: { allowed: true } };
    });
  }

  approveCredential(challenge: string, fingerprint: string): ApproveCredentialReply {
    if (!CAPABILITY.test(challenge) || !CAPABILITY.test(fingerprint)) return { status: 400, body: { error: "invalid credential" } };
    return this.storage.transactionSync(() => {
      const now = this.now();
      this.purge(now);
      const existing = this.credential(challenge);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return { status: 409, body: { error: "recipient mismatch" } };
        return { status: 200, body: { approved: true, expiresAt: existing.expires_at } };
      }
      const rejected = this.checkWindow("approvals_daily", "", now);
      if (rejected !== null) return rejected;
      const expiresAt = now + CREDENTIAL_TTL;
      this.storage.sql.exec("INSERT INTO credentials(challenge, fingerprint, expires_at) VALUES (?, ?, ?)", challenge, fingerprint, expiresAt);
      this.chargeWindow("approvals_daily", "", now);
      return { status: 200, body: { approved: true, expiresAt } };
    });
  }

  credentialStatus(challenge: string): CredentialStatusReply {
    if (!CAPABILITY.test(challenge)) return { status: 400, body: { error: "invalid credential" } };
    return this.storage.transactionSync(() => {
      const credential = this.credential(challenge);
      if (!credential || credential.expires_at <= this.now()) return { status: 202, body: { status: "pending" } };
      return { status: 200, body: { status: "approved", expiresAt: credential.expires_at, recipientFingerprint: credential.fingerprint } };
    });
  }
}
