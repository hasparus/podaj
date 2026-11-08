import { Effect } from "effect";
import { afterEach, assert, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { Env } from "../src/env.js";
import { digest } from "../src/handoffs/capabilities.js";
import { handleHandoffsApi } from "../src/handoffs/handler.js";
import { HandoffParty } from "../src/handoffs/party.js";
import { HandoffStore, type HandoffRow, type HandoffStoreConfig } from "../src/handoffs/store.js";
import type {
  ApprovalAttemptReply, ApproveCredentialReply, AuthorizeWriteReply, ConsumeReply,
  CredentialStatusReply, FillReply, ReserveInput, ReserveReply, StatusReply,
} from "../src/handoffs/protocol.js";
import { sqliteStorage } from "./helpers/sqlite.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected readonly ctx: DurableObjectState, protected readonly env: unknown) {}
  },
}));

const DAY = 86_400_000;
const HOUR = 3_600_000;
const hex = (value: number, length = 64): string => value.toString(16).padStart(length, "0");
const fingerprint = hex(10);
const input = (value = 1, creatorHash: string | null = null): ReserveInput => ({
  id: hex(value, 32),
  recipientFingerprint: fingerprint,
  writeHash: hex(100),
  readHash: hex(101),
  subscribeHash: hex(102),
  creatorHash,
});
const ciphertext = "PODAJ1.encrypted";
const databases: ReturnType<typeof sqliteStorage>["database"][] = [];
const setup = (config: HandoffStoreConfig = { PODAJ_ACCESS: "public" }, start = 10 * DAY) => {
  const { database, storage, statements } = sqliteStorage();
  databases.push(database);
  let now = start;
  const store = new HandoffStore(storage, config, () => now);
  const counts = () => database.prepare("SELECT kind, subject, bucket, count FROM counters ORDER BY kind, subject, bucket").all();
  return { database, storage, statements, store, counts, advance: (ms: number) => { now += ms; }, now: () => now };
};
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

const socketFor = (id: string, expiresAt: number) => {
  let attachment = { id, expiresAt };
  return {
    deserializeAttachment: vi.fn(() => attachment),
    serializeAttachment: vi.fn((value: typeof attachment) => { attachment = value; }),
    send: vi.fn(),
    close: vi.fn(),
  };
};

const partySetup = () => {
  const { database, storage, statements } = sqliteStorage();
  databases.push(database);
  let alarm: number | null = null;
  const sockets: ReturnType<typeof socketFor>[] = [];
  const ctx = {
    id: { equals: () => true },
    storage: {
      ...storage,
      getAlarm: vi.fn(async () => alarm),
      setAlarm: vi.fn(async (value: number) => { alarm = value; }),
      deleteAlarm: vi.fn(async () => { alarm = null; }),
    },
    getWebSockets: vi.fn((id?: string) => sockets.filter((socket) => id === undefined || socket.deserializeAttachment().id === id)),
    blockConcurrencyWhile: vi.fn(async (work: () => Promise<unknown>) => await work()),
  };
  const env = { HANDOFF_PARTY: { idFromName: () => "fixed-object" } };
  const party = new HandoffParty(
    ctx as unknown as DurableObjectState,
    env as unknown as ConstructorParameters<typeof HandoffParty>[1],
  );
  return { party, ctx, database, statements, sockets, alarm: () => alarm };
};

describe("typed handoff contracts", () => {
  it("keeps each method's literal statuses and concrete payloads", () => {
    expectTypeOf<HandoffStore["reserve"]>().returns.toEqualTypeOf<ReserveReply>();
    expectTypeOf<HandoffStore["authorizeWrite"]>().returns.toEqualTypeOf<AuthorizeWriteReply>();
    expectTypeOf<HandoffStore["fill"]>().returns.toEqualTypeOf<FillReply>();
    expectTypeOf<HandoffStore["consume"]>().returns.toEqualTypeOf<ConsumeReply>();
    expectTypeOf<HandoffStore["status"]>().returns.toEqualTypeOf<StatusReply>();
    expectTypeOf<HandoffStore["approvalAttempt"]>().returns.toEqualTypeOf<ApprovalAttemptReply>();
    expectTypeOf<HandoffStore["approveCredential"]>().returns.toEqualTypeOf<ApproveCredentialReply>();
    expectTypeOf<HandoffStore["credentialStatus"]>().returns.toEqualTypeOf<CredentialStatusReply>();
    expectTypeOf<ReserveReply["status"]>().toEqualTypeOf<201 | 400 | 401 | 409 | 429>();
    expectTypeOf<ConsumeReply["status"]>().toEqualTypeOf<200 | 401 | 404 | 410>();
    expectTypeOf<Extract<ConsumeReply, { status: 200 }>["body"]["sealed"]>().toEqualTypeOf<string>();
    expectTypeOf<{ status: 200; body: { sealed: null; recipientFingerprint: string } }>().not.toExtend<ConsumeReply>();
    expectTypeOf<{ status: 200; body: { status: "gone" } }>().not.toExtend<StatusReply>();
    expectTypeOf<{ status: 201; body: { id: string } }>().not.toExtend<ReserveReply>();
    expectTypeOf<{ status: 201; body: { authorized: true } }>().not.toExtend<AuthorizeWriteReply>();
    expectTypeOf<{ status: 202; body: { status: "approved" } }>().not.toExtend<CredentialStatusReply>();
    expectTypeOf<Extract<HandoffRow, { state: "pending" }>["sealed"]>().toEqualTypeOf<null>();
    expectTypeOf<Extract<HandoffRow, { state: "ready" }>["sealed"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<HandoffRow, { state: "consumed" }>["sealed"]>().toEqualTypeOf<null>();
  });

  it("backs the row discriminant with SQLite CHECK constraints", () => {
    const { store, database } = setup();
    store.reserve(input());
    expect(() => database.prepare("UPDATE handoffs SET state = 'ready' WHERE id = ?").run(input().id)).toThrow(/CHECK/);
    expect(() => database.prepare("UPDATE handoffs SET sealed = ? WHERE id = ?").run(ciphertext, input().id)).toThrow(/CHECK/);
    store.fill(input().id, input().writeHash, ciphertext);
    expect(() => database.prepare("UPDATE handoffs SET state = 'consumed' WHERE id = ?").run(input().id)).toThrow(/CHECK/);
    expect(store.consume(input().id, input().readHash)).toMatchObject({ status: 200, body: { sealed: ciphertext } });
  });
});

describe("read-only RPCs and delivery maintenance", () => {
  it.each(["pending", "ready", "consumed", "expired"] as const)("does no global maintenance or ciphertext reads for %s lookups", async (state) => {
    let now = Date.UTC(2026, 10, 1);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { party, ctx, database, statements } = partySetup();
    const challenge = hex(500);
    await party.approveCredential(challenge, fingerprint);
    await party.reserve(input());
    if (state === "ready" || state === "consumed") await party.fill(input().id, input().writeHash, ciphertext);
    if (state === "consumed") await party.consume(input().id, input().readHash);
    if (state === "expired") now += 2 * HOUR;
    statements.length = 0;
    ctx.blockConcurrencyWhile.mockClear();
    ctx.getWebSockets.mockClear();
    ctx.storage.getAlarm.mockClear();
    ctx.storage.setAlarm.mockClear();
    ctx.storage.deleteAlarm.mockClear();
    expect((await party.status(input().id, input().subscribeHash)).status).toBe(state === "consumed" || state === "expired" ? 410 : 200);
    expect((await party.status(input().id, input().readHash)).status).toBe(401);
    expect((await party.status(hex(999, 32), input().subscribeHash)).status).toBe(410);
    expect((await party.credentialStatus(challenge)).status).toBe(state === "expired" ? 202 : 200);
    expect((await party.credentialStatus(hex(999))).status).toBe(202);
    expect((await party.credentialStatus("invalid")).status).toBe(400);
    expect(statements).toHaveLength(5);
    expect(statements.every(({ query }) => /^SELECT\b/u.test(query))).toBe(true);
    expect(statements.flatMap(({ columns }) => columns)).not.toContain("sealed");
    expect(ctx.blockConcurrencyWhile).not.toHaveBeenCalled();
    expect(ctx.getWebSockets).not.toHaveBeenCalled();
    expect(ctx.storage.getAlarm).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM handoffs").get()?.count).toBe(1);
  });

  it("reconciles each subscribed slot once using only expiry metadata", async () => {
    const { party, statements, sockets, alarm } = partySetup();
    await party.reserve(input());
    await party.fill(input().id, input().writeHash, ciphertext);
    const deadline = Date.now() + 600_000;
    sockets.push(socketFor(input().id, deadline), socketFor(input().id, deadline));
    statements.length = 0;
    await party.alarm();
    const lookups = statements.filter(({ query }) => /FROM handoffs WHERE id/u.test(query));
    expect(lookups).toHaveLength(1);
    expect(lookups[0].columns).toEqual(["expires_at"]);
    expect(statements.flatMap(({ columns }) => columns)).not.toContain("sealed");
    expect(alarm()).toBe(deadline);
  });

  it("acknowledges consumption over HTTP and immediately notifies gone despite unavailable post-commit maintenance", async () => {
    const { party, ctx, database, statements, sockets, alarm } = partySetup();
    const readToken = hex(1234);
    const slot = { ...input(), readHash: await digest(readToken) };
    await party.reserve(slot);
    await party.fill(slot.id, slot.writeHash, ciphertext);
    const armed = alarm();
    expect(armed).not.toBeNull();
    const socket = socketFor(input().id, Date.now() + 600_000);
    sockets.push(socket);
    ctx.storage.getAlarm.mockRejectedValue(new Error("alarm storage unavailable"));
    ctx.blockConcurrencyWhile.mockClear();
    statements.length = 0;
    const env = {
      MAX_HANDOFF_BYTES: "32768",
      HANDOFF_PARTY: { idFromName: () => "fixed-object", get: () => party },
    } as unknown as Env;
    const response = await Effect.runPromise(handleHandoffsApi(new Request(`https://podaj.test/api/handoffs/${slot.id}/consume`, {
      method: "POST", headers: { Authorization: `Bearer ${readToken}` },
    }), env));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sealed: ciphertext, recipientFingerprint: fingerprint });
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "gone" }));
    expect(socket.close).toHaveBeenCalledWith(1000, "gone");
    expect(alarm()).toBe(armed);
    expect(ctx.blockConcurrencyWhile).not.toHaveBeenCalled();
    expect(statements.map(({ query }) => query)).toEqual([
      "SELECT read_hash, fingerprint, state, sealed, expires_at FROM handoffs WHERE id = ?",
      "UPDATE handoffs SET state = 'consumed', sealed = NULL WHERE id = ?",
    ]);
    expect(database.prepare("SELECT state, sealed FROM handoffs").get()).toEqual({ state: "consumed", sealed: null });
    expect((await party.consume(slot.id, slot.readHash)).status).toBe(410);
    await expect(party.alarm()).rejects.toThrow("alarm storage unavailable");
  });

  it("does not suppress critical alarm scheduling failures during reservation", async () => {
    const { party, ctx } = partySetup();
    ctx.storage.setAlarm.mockRejectedValue(new Error("cannot arm cleanup"));
    await expect(party.reserve(input())).rejects.toThrow("cannot arm cleanup");
    expect(ctx.storage.setAlarm).toHaveBeenCalled();
  });

  it("cleans consumed tombstones on the already armed expiry alarm", async () => {
    let now = Date.UTC(2026, 10, 1);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { party, database, alarm } = partySetup();
    await party.reserve(input());
    await party.fill(input().id, input().writeHash, ciphertext);
    await party.consume(input().id, input().readHash);
    const armed = alarm();
    assert(armed !== null);
    now = armed;
    await party.alarm();
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
    expect((await party.status(input().id, input().subscribeHash)).status).toBe(410);
  });
});

describe("SQLite handoff state machine", () => {
  it("authorizes only the pending slot's write hash without mutating rows, expiry, or quotas", () => {
    const { store, database, counts, advance } = setup();
    store.reserve(input());
    store.reserve({ ...input(2), writeHash: hex(200), readHash: hex(201), subscribeHash: hex(202) });
    const rows = () => database.prepare("SELECT * FROM handoffs ORDER BY id").all();
    const before = rows();
    const beforeCounts = counts();
    advance(HOUR);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(store.authorizeWrite(input().id, input().writeHash)).toEqual({ status: 200, body: { authorized: true } });
    }
    for (const wrong of [input().readHash, input().subscribeHash, hex(200), hex(999), "", "bad"]) {
      expect(store.authorizeWrite(input().id, wrong).status).toBe(401);
    }
    expect(store.authorizeWrite(input(999).id, input().writeHash).status).toBe(410);
    expect(rows()).toEqual(before);
    expect(counts()).toEqual(beforeCounts);
  });

  it.each(["ready", "consumed", "expired"] as const)("rejects write preflight for %s state without revealing it to another role", (state) => {
    const { store, database, advance, counts } = setup();
    store.reserve(input());
    if (state !== "expired") store.fill(input().id, input().writeHash, ciphertext);
    if (state === "consumed") store.consume(input().id, input().readHash);
    if (state === "expired") advance(2 * HOUR);
    const rows = database.prepare("SELECT * FROM handoffs").all();
    const beforeCounts = counts();
    expect(store.authorizeWrite(input().id, input().readHash).status).toBe(401);
    expect(store.authorizeWrite(input().id, input().subscribeHash).status).toBe(401);
    expect(store.authorizeWrite(input().id, input().writeHash).status).toBe(state === "expired" ? 410 : 409);
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual(rows);
    expect(counts()).toEqual(beforeCounts);
  });

  it("does not let a successful write preflight authorize a later expired or already-filled commit", () => {
    const { store, advance } = setup();
    store.reserve(input());
    expect(store.authorizeWrite(input().id, input().writeHash).status).toBe(200);
    expect(store.fill(input().id, input().writeHash, ciphertext).status).toBe(200);
    expect(store.fill(input().id, input().writeHash, "PODAJ1.replay").status).toBe(409);
    store.reserve(input(2));
    expect(store.authorizeWrite(input(2).id, input().writeHash).status).toBe(200);
    advance(2 * HOUR);
    expect(store.fill(input(2).id, input().writeHash, ciphertext).status).toBe(410);
  });

  it("stores hashes only, never exposes ciphertext on status, and removes it on atomic consumption", () => {
    const { store, database, now } = setup();
    const reservation = store.reserve(input());
    expect(reservation).toEqual({ status: 201, body: { id: input().id, expiresAt: now() + 2 * HOUR, recipientFingerprint: fingerprint } });
    assert(reservation.status === 201);
    expect(store.status(input().id, input().subscribeHash)).toEqual({ status: 200, body: { status: "pending", expiresAt: reservation.body.expiresAt } });
    expect(store.consume(input().id, input().readHash).status).toBe(404);
    expect(store.fill(input().id, input().writeHash, ciphertext).status).toBe(200);
    expect(store.status(input().id, input().subscribeHash).body).toEqual({ status: "ready", expiresAt: reservation.body.expiresAt });
    expect(store.consume(input().id, input().readHash)).toEqual({ status: 200, body: { sealed: ciphertext, recipientFingerprint: fingerprint } });
    expect(store.consume(input().id, input().readHash).status).toBe(410);
    expect(store.status(input().id, input().subscribeHash)).toEqual({ status: 410, body: { status: "gone" } });
    expect(store.fill(input().id, input().writeHash, "PODAJ1.replay").status).toBe(409);
    expect(store.reserve(input()).status).toBe(409);
    expect(database.prepare("SELECT state, sealed FROM handoffs").all()).toEqual([{ state: "consumed", sealed: null }]);
    expect(Object.keys(database.prepare("SELECT * FROM handoffs").get()!)).toEqual([
      "id", "fingerprint", "write_hash", "read_hash", "subscribe_hash", "state", "sealed", "expires_at",
    ]);
  });

  it.each(["pending", "ready", "consumed", "expired"] as const)("checks every independent scope before revealing %s state", (state) => {
    const { store, advance } = setup();
    store.reserve(input());
    if (state !== "pending") store.fill(input().id, input().writeHash, ciphertext);
    if (state === "consumed") store.consume(input().id, input().readHash);
    if (state === "expired") advance(2 * HOUR);
    for (const wrong of [input().readHash, input().subscribeHash, hex(999), "", "bad"]) {
      expect(store.fill(input().id, wrong, ciphertext).status).toBe(401);
    }
    for (const wrong of [input().writeHash, input().subscribeHash, hex(999), "", "bad"]) {
      expect(store.consume(input().id, wrong).status).toBe(401);
    }
    for (const wrong of [input().writeHash, input().readHash, hex(999), "", "bad"]) {
      expect(store.status(input().id, wrong).status).toBe(401);
    }
  });

  it("never authorizes capabilities from another handoff", () => {
    const { store } = setup();
    store.reserve(input());
    store.reserve({ ...input(2), writeHash: hex(200), readHash: hex(201), subscribeHash: hex(202) });
    expect(store.fill(input(2).id, input().writeHash, ciphertext).status).toBe(401);
    expect(store.consume(input(2).id, input().readHash).status).toBe(401);
    expect(store.status(input(2).id, input().subscribeHash).status).toBe(401);
  });

  it("expires authoritatively even without alarms, restarts retention only on first commit, and never resurrects", () => {
    const { store, advance, now } = setup();
    store.reserve(input());
    advance(HOUR);
    const filled = store.fill(input().id, input().writeHash, ciphertext);
    assert(filled.status === 200);
    expect(filled.body.expiresAt).toBe(now() + 2 * HOUR);
    advance(HOUR);
    expect(store.fill(input().id, input().writeHash, "PODAJ1.other").status).toBe(409);
    const status = store.status(input().id, input().subscribeHash);
    assert(status.status === 200);
    expect(status.body.expiresAt).toBe(filled.body.expiresAt);
    advance(HOUR);
    expect(store.fill(input().id, input().writeHash, ciphertext).status).toBe(410);
    expect(store.consume(input().id, input().readHash).status).toBe(410);
    expect(store.status(input().id, input().subscribeHash).status).toBe(410);
    store.cleanup();
    expect(store.fill(input().id, input().writeHash, ciphertext).status).toBe(410);
  });

  it("expires an unfilled reservation and a consumed tombstone at their deadlines", () => {
    const { store, advance, database } = setup();
    store.reserve(input());
    store.reserve(input(2));
    store.fill(input(2).id, input().writeHash, ciphertext);
    store.consume(input(2).id, input().readHash);
    advance(2 * HOUR);
    expect(store.fill(input().id, input().writeHash, ciphertext).status).toBe(410);
    expect(store.consume(input(2).id, input().readHash).status).toBe(410);
    store.cleanup();
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
  });

  it("enforces prefix and UTF-8 byte size without changing state on rejection", () => {
    const { store } = setup({ MAX_HANDOFF_BYTES: "12" });
    store.reserve(input());
    expect(store.fill(input().id, input().writeHash, "PODAJ2.data").status).toBe(400);
    expect(store.fill(input().id, input().writeHash, "PODAJ1.ééé").status).toBe(413);
    expect(store.fill(input().id, input().writeHash, "PODAJ1.éé").status).toBe(200);
  });

  it.each(["demo", "", "PUBLIC", "unknown", null, 1])("rejects invalid store access %j before creating or mutating tables", (access) => {
    const { database, storage, statements } = sqliteStorage();
    databases.push(database);
    expect(() => new HandoffStore(storage, { PODAJ_ACCESS: access as string })).toThrow(expect.objectContaining({
      code: "invalid access", status: 503,
    }));
    expect(statements).toHaveLength(0);
  });

  it("defaults absent access to private and ignores the removed binding", () => {
    for (const config of [
      { MAX_HANDOFF_BYTES: "40000", HANDOFF_TTL_SECONDS: "86400" },
      { PODAJ_MODE: "demo", MAX_HANDOFF_BYTES: "40000", HANDOFF_TTL_SECONDS: "86400" },
    ]) {
      const instance = setup(config);
      expect(instance.store.reserve(input())).toMatchObject({ status: 201, body: { expiresAt: instance.now() + DAY } });
      expect(instance.store.fill(input().id, input().writeHash, `PODAJ1.${"a".repeat(32762)}`).status).toBe(200);
    }
  });

  it("clamps public byte and TTL overrides but supports private retention", () => {
    const demo = setup({ PODAJ_ACCESS: "public", MAX_HANDOFF_BYTES: "1000000", HANDOFF_TTL_SECONDS: "86400" });
    expect(demo.store.reserve(input())).toMatchObject({ status: 201, body: { expiresAt: demo.now() + 2 * HOUR } });
    expect(demo.store.fill(input().id, input().writeHash, `PODAJ1.${"a".repeat(32762)}`).status).toBe(413);
    expect(demo.store.fill(input().id, input().writeHash, `PODAJ1.${"a".repeat(32761)}`).status).toBe(200);
    const privateInstance = setup({ PODAJ_ACCESS: "private", MAX_HANDOFF_BYTES: "40000", HANDOFF_TTL_SECONDS: "86400" });
    expect(privateInstance.store.reserve(input())).toMatchObject({ status: 201, body: { expiresAt: privateInstance.now() + DAY } });
    expect(privateInstance.store.fill(input().id, input().writeHash, `PODAJ1.${"a".repeat(32762)}`).status).toBe(200);
  });

  it.each([
    ["fill", "consume", "fill", "consume"],
    ["consume", "fill", "fill", "consume", "consume"],
    ["fill", "fill", "consume", "fill"],
  ])("serializes concurrent request schedule %j", async (...schedule) => {
    const { store, database } = setup();
    store.reserve(input());
    const replies = await Promise.all(schedule.map(async (operation) => operation === "fill"
      ? store.fill(input().id, input().writeHash, ciphertext)
      : store.consume(input().id, input().readHash)));
    expect(replies.filter((result) => result.status === 200 && "sealed" in result.body)).toHaveLength(1);
    expect(database.prepare("SELECT state, sealed FROM handoffs").get()).toEqual({ state: "consumed", sealed: null });
    expect(store.fill(input().id, input().writeHash, ciphertext).status).toBe(409);
  });
});

describe("strict reservation admission", () => {
  it("counts global quotas for owner bypass, never grants beyond 200/day, and rejected creates allocate nothing", async () => {
    const { store, counts, database } = setup();
    const replies = await Promise.all(Array.from({ length: 210 }, async (_, index) => store.reserve(input(index + 1))));
    expect(replies.filter((result) => result.status === 201)).toHaveLength(200);
    expect(replies.filter((result) => result.status === 429)).toHaveLength(10);
    const before = counts();
    expect(store.reserve(input(999)).status).toBe(429);
    expect(counts()).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) AS n FROM handoffs").get()).toEqual({ n: 200 });
    store.fill(input().id, input().writeHash, ciphertext);
    store.consume(input().id, input().readHash);
    expect(store.reserve(input(999)).status).toBe(429);
    expect(counts()).toEqual(before);
  });

  it("enforces live quota independently across UTC days without incrementing the new daily budget", () => {
    const { store, advance, counts } = setup({ HANDOFF_TTL_SECONDS: "86400" }, 10 * DAY + 23 * HOUR);
    for (let index = 1; index <= 200; index++) expect(store.reserve(input(index)).status).toBe(201);
    advance(HOUR);
    const before = counts();
    expect(store.reserve(input(201)).status).toBe(429);
    expect(counts()).toEqual(before);
    store.fill(input().id, input().writeHash, ciphertext);
    store.consume(input().id, input().readHash);
    expect(store.reserve(input(201)).status).toBe(201);
    expect(counts().filter((row) => row.kind === "reserve").map((row) => row.count)).toEqual([200, 1]);
  });

  it("binds the credential to the recipient, enforces five/day, and does not reset usage on reapproval", () => {
    const { store, counts, advance } = setup();
    const challenge = hex(500);
    expect(store.reserve(input(1, challenge)).status).toBe(401);
    expect(counts()).toEqual([]);
    store.approveCredential(challenge, fingerprint);
    const before = counts();
    expect(store.reserve({ ...input(1, challenge), recipientFingerprint: hex(11) }).status).toBe(401);
    expect(counts()).toEqual(before);
    for (let index = 1; index <= 5; index++) expect(store.reserve(input(index, challenge)).status).toBe(201);
    const used = counts();
    expect(store.reserve(input(6, challenge)).status).toBe(429);
    expect(store.reserve(input(1, challenge)).status).toBe(409);
    expect(store.reserve({ ...input(7, challenge), readHash: input().writeHash }).status).toBe(400);
    store.approveCredential(challenge, fingerprint);
    expect(store.reserve(input(6, challenge)).status).toBe(429);
    expect(counts()).toEqual(used);
    advance(2 * HOUR);
    expect(store.reserve(input(6, challenge)).status).toBe(401);
    store.approveCredential(challenge, fingerprint);
    expect(store.reserve(input(6, challenge)).status).toBe(429);
  });

  it("rolls back insertion and every quota increment together when storage fails", () => {
    const { store, database, counts } = setup();
    const challenge = hex(500);
    store.approveCredential(challenge, fingerprint);
    const before = counts();
    database.exec(`CREATE TRIGGER fail_actor BEFORE INSERT ON counters WHEN NEW.kind = 'actor'
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
    expect(() => store.reserve(input(1, challenge))).toThrow("simulated storage failure");
    expect(counts()).toEqual(before);
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
    database.exec("DROP TRIGGER fail_actor");
    expect(store.reserve(input(1, challenge)).status).toBe(201);
  });
});

describe("bounded verification metadata and approvals", () => {
  it("enforces per-minute and global attempt quotas before allocating IP rows", () => {
    const { store, counts, advance } = setup();
    const ip = hex(1000);
    for (let index = 0; index < 10; index++) expect(store.approvalAttempt(ip).status).toBe(200);
    const before = counts();
    expect(store.approvalAttempt(ip).status).toBe(429);
    expect(counts()).toEqual(before);
    advance(60_000);
    expect(store.approvalAttempt(ip).status).toBe(200);
    for (let index = 0; index < 489; index++) expect(store.approvalAttempt(hex(index + 2000)).status).toBe(200);
    const exhausted = counts();
    for (let index = 0; index < 1000; index++) expect(store.approvalAttempt(hex(index + 10000)).status).toBe(429);
    expect(counts()).toEqual(exhausted);
    expect(counts().filter((row) => row.kind === "attempt")[0].count).toBe(500);
    advance(DAY);
    expect(store.approvalAttempt(ip).status).toBe(200);
  });

  it("does not allocate unknown credential lookups and rejects invalid metadata", () => {
    const { store, database, counts } = setup();
    for (let index = 0; index < 1000; index++) expect(store.credentialStatus(hex(index)).status).toBe(202);
    expect(database.prepare("SELECT * FROM credentials").all()).toEqual([]);
    expect(counts()).toEqual([]);
    expect(store.approvalAttempt("raw IP").status).toBe(400);
    expect(store.approveCredential("invalid", fingerprint).status).toBe(400);
    expect(store.approveCredential(hex(500), "invalid").status).toBe(400);
    expect(store.credentialStatus("invalid").status).toBe(400);
    expect(counts()).toEqual([]);
  });

  it("limits approvals, preserves existing key and expiry even when exhausted, and expires without an alarm", () => {
    const { store, counts, now, advance } = setup();
    const approved = store.approveCredential(hex(500), fingerprint);
    expect(approved).toEqual({ status: 200, body: { approved: true, expiresAt: now() + 2 * HOUR } });
    assert(approved.status === 200);
    advance(HOUR);
    expect(store.approveCredential(hex(500), fingerprint)).toEqual(approved);
    expect(store.approveCredential(hex(500), hex(11)).status).toBe(409);
    expect(store.credentialStatus(hex(500))).toEqual({ status: 200, body: { status: "approved", expiresAt: approved.body.expiresAt, recipientFingerprint: fingerprint } });
    for (let index = 1; index < 200; index++) expect(store.approveCredential(hex(index + 500), fingerprint).status).toBe(200);
    const before = counts();
    expect(store.approveCredential(hex(900), fingerprint).status).toBe(429);
    expect(store.approveCredential(hex(500), fingerprint)).toEqual(approved);
    expect(counts()).toEqual(before);
    advance(HOUR);
    expect(store.credentialStatus(hex(500))).toEqual({ status: 202, body: { status: "pending" } });
    expect(store.reserve(input(1, hex(500))).status).toBe(401);
    expect(store.approveCredential(hex(900), fingerprint).status).toBe(429);
  });

  it("purges expired state and counters older than two days, including on an otherwise idle alarm", () => {
    const { store, database, advance, now } = setup();
    expect(store.nextExpiry()).toBeNull();
    store.approveCredential(hex(500), fingerprint);
    store.approvalAttempt(hex(1000));
    store.reserve(input());
    expect(store.nextExpiry()).toBe(now() + 2 * HOUR);
    advance(2 * HOUR);
    store.cleanup();
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM credentials").all()).toEqual([]);
    expect(store.nextExpiry()).toBe(12 * DAY + 1);
    advance(2 * DAY);
    store.cleanup();
    expect(database.prepare("SELECT * FROM counters").all()).toEqual([]);
    expect(store.nextExpiry()).toBeNull();
  });
});
