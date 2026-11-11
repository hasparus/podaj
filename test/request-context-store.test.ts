import { Effect } from "effect";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env.js";
import { handleHandoffsApi } from "../src/handoffs/handler.js";
import { HandoffParty } from "../src/handoffs/party.js";
import { DEMO_LIMITS, REQUEST_CONTEXT_LIMITS, type ReserveInput } from "../src/handoffs/protocol.js";
import { HandoffStore } from "../src/handoffs/store.js";
import { quotaExplanation } from "../src/client/quota-copy.js";
import { sqliteStorage } from "./helpers/sqlite.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected readonly ctx: DurableObjectState, protected readonly env: unknown) {}
  },
}));

const DAY = 86_400_000;
const hex = (value: number, length = 64) => value.toString(16).padStart(length, "0");
const encryptedContext = "a".repeat(39);
const writeHash = hex(100);
const ipHash = hex(200);
const slot = (value = 1, source: ReserveInput["source"] = "draft"): ReserveInput => ({
  source,
  id: hex(value, 32), writeHash, readHash: hex(101), subscribeHash: hex(102),
  recipientFingerprint: hex(103), creatorHash: null,
});
const draft = (value = 1) => ({ id: slot(value).id, writeHash, encryptedContext });
const databases: ReturnType<typeof sqliteStorage>["database"][] = [];
const setup = (access: "private" | "public" = "private") => {
  const { database, storage, statements } = sqliteStorage();
  databases.push(database);
  let now = 10 * DAY;
  const store = new HandoffStore(storage, { PODAJ_ACCESS: access }, () => now);
  const create = (value = 1, ip = ipHash) => store.createContext(slot(value).id, writeHash, encryptedContext, ip);
  const contexts = () => database.prepare("SELECT * FROM contexts ORDER BY id").all();
  const counters = () => database.prepare("SELECT * FROM counters ORDER BY kind, subject, bucket").all();
  return { store, storage, database, statements, create, contexts, counters, now: () => now, advance: (ms: number) => { now += ms; } };
};
const partySetup = () => {
  const { storage, database } = setup();
  let alarm: number | null = null;
  const ctx = {
    id: { equals: () => true },
    storage: {
      ...storage,
      getAlarm: vi.fn(async () => alarm),
      setAlarm: vi.fn(async (value: number) => { alarm = value; }),
      deleteAlarm: vi.fn(async () => { alarm = null; }),
    },
    getWebSockets: vi.fn(() => []),
    blockConcurrencyWhile: async (work: () => Promise<void>) => await work(),
  };
  const party = new HandoffParty(ctx as unknown as DurableObjectState, {
    HANDOFF_PARTY: { idFromName: () => "fixed-object" },
  } as unknown as ConstructorParameters<typeof HandoffParty>[1]);
  return { party, ctx, database, alarm: () => alarm };
};
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("encrypted request context storage", () => {
  it("stages only opaque ciphertext without approval or a handoff, and exposes no role hashes", () => {
    const { store, create, contexts, database, now } = setup();
    expect(create()).toEqual({ status: 201, body: {
      id: slot().id, encryptedContext, expiresAt: now() + REQUEST_CONTEXT_LIMITS.draftTtlMs,
    } });
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM credentials").all()).toEqual([]);
    expect(contexts()).toEqual([{ id: slot().id, write_hash: writeHash, ciphertext: encryptedContext, expires_at: now() + 180_000 }]);
    expect(store.context(slot().id)).toEqual({ status: 200, body: {
      id: slot().id, encryptedContext, expiresAt: now() + 180_000,
    } });
    expect(store.context(hex(999, 32)).status).toBe(404);
    expect(store.context("bad").status).toBe(400);
  });

  it("expires authoritatively without cleanup and includes drafts in cleanup deadlines", () => {
    const { store, create, advance, contexts, now } = setup();
    expect(store.nextExpiry()).toBeNull();
    create();
    expect(store.nextExpiry()).toBe(now() + 180_000);
    advance(179_999);
    expect(store.context(slot().id).status).toBe(200);
    advance(1);
    expect(store.context(slot().id).status).toBe(404);
    expect(contexts()).toHaveLength(1);
    store.cleanup();
    expect(contexts()).toEqual([]);
    expect(store.nextExpiry()).toBe(12 * DAY + 1);
    advance(2 * DAY);
    store.cleanup();
    expect(store.nextExpiry()).toBeNull();
  });

  it("binds reservations to the draft writer, extends both deadlines, and deletes on consumption", () => {
    const { store, create, advance, now, contexts, counters } = setup();
    create();
    const original = contexts();
    const budget = counters();
    expect(store.reserve({ ...slot(), writeHash: hex(999) }).status).toBe(401);
    expect(contexts()).toEqual(original);
    expect(counters()).toEqual(budget);
    advance(100_000);
    const reserved = store.reserve(slot());
    assert(reserved.status === 201);
    expect(store.context(slot().id)).toMatchObject({ status: 200, body: { expiresAt: reserved.body.expiresAt } });
    advance(180_000);
    expect(store.context(slot().id).status).toBe(200);
    const filled = store.fill(slot().id, writeHash, "PODAJ1.ciphertext");
    assert(filled.status === 200);
    expect(filled.body.expiresAt).toBe(now() + 7_200_000);
    expect(store.context(slot().id)).toMatchObject({ status: 200, body: { expiresAt: filled.body.expiresAt } });
    expect(store.consume(slot().id, slot().readHash).status).toBe(200);
    expect(contexts()).toEqual([]);
    expect(store.context(slot().id).status).toBe(404);
    expect(create().status).toBe(409);
    expect(store.reserve(slot()).status).toBe(409);
    expect(store.reserve(slot(2, "generated")).status).toBe(201);
  });

  it("requires a live draft for activation, without charging reservation quota or resurrecting expired context", () => {
    const { store, create, advance, contexts, counters, database } = setup();
    expect(store.reserve(slot()).status).toBe(410);
    expect(counters()).toEqual([]);
    create();
    const budget = counters();
    expect(store.reserve({ ...slot(), source: "generated" }).status).toBe(409);
    expect(contexts()).toHaveLength(1);
    advance(180_000);
    expect(store.reserve(slot()).status).toBe(410);
    expect(contexts()).toEqual([]);
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
    expect(counters()).toEqual(budget);
    expect(store.reserve(slot(2, "generated")).status).toBe(201);
  });

  it("rejects collisions without overwriting or charging quota, including existing legacy handoffs", () => {
    const { store, create, contexts, counters, advance } = setup();
    create();
    const rows = contexts();
    const budget = counters();
    expect(store.createContext(slot().id, hex(999), "b".repeat(39), ipHash).status).toBe(409);
    expect(contexts()).toEqual(rows);
    expect(counters()).toEqual(budget);
    store.reserve(slot(2, "generated"));
    expect(create(2).status).toBe(409);
    advance(180_000);
    expect(create().status).toBe(201);
  });

  it("rejects malformed or oversized RPC inputs without allocating rows", () => {
    const { store, contexts, counters } = setup();
    for (const invalid of ["", "a".repeat(38), "a".repeat(32769), "a".repeat(39) + "=", "é".repeat(39), "a.b".repeat(15), null]) {
      expect(store.createContext(slot().id, writeHash, invalid as string, ipHash).status).toBe(400);
    }
    for (const id of ["bad", "A".repeat(32), "a".repeat(31)]) {
      expect(store.createContext(id, writeHash, encryptedContext, ipHash).status).toBe(400);
    }
    expect(store.createContext(slot().id, "bad", encryptedContext, ipHash).status).toBe(400);
    expect(store.createContext(slot().id, writeHash, encryptedContext, "raw IP").status).toBe(400);
    expect(contexts()).toEqual([]);
    expect(counters()).toEqual([]);
    expect(store.createContext(slot().id, writeHash, "a".repeat(32768), ipHash).status).toBe(201);
  });

  it.each(["private", "public"] as const)("bounds %s per-IP staging without extra counters and resets on minute boundaries", (access) => {
    const { create, counters, advance, contexts } = setup(access);
    for (let index = 1; index <= DEMO_LIMITS.draftsPerMinutePerIp; index++) expect(create(index).status).toBe(201);
    const before = counters();
    expect(create(11)).toEqual({ status: 429, body: { error: "limit reached", quota: {
      kind: "context_drafts_per_ip", limit: 10, periodSeconds: 60, resetAt: 10 * DAY + 60_000,
    } } });
    expect(counters()).toEqual(before);
    expect(contexts()).toHaveLength(10);
    advance(60_000);
    expect(create(11).status).toBe(201);
  });

  it("counts only unattached drafts against live capacity", () => {
    const { store, create, contexts, counters } = setup();
    for (let index = 1; index <= DEMO_LIMITS.liveDrafts; index++) expect(create(index, hex(index + 1000)).status).toBe(201);
    const before = counters();
    expect(create(201, hex(2000))).toEqual({ status: 429, body: { error: "limit reached", quota: { kind: "context_drafts_live", limit: 200 } } });
    expect(counters()).toEqual(before);
    expect(store.reserve(slot()).status).toBe(201);
    expect(create(201, hex(2000)).status).toBe(201);
    expect(contexts()).toHaveLength(201);
  });

  it("enforces the daily cap across draft expiries, without counters for rejected IPs", () => {
    const { create, advance, counters, now } = setup();
    for (let index = 1; index <= DEMO_LIMITS.draftsPerDay; index++) {
      if (index % 200 === 1 && index > 1) advance(180_000);
      expect(create(index, hex(index + 1000)).status).toBe(201);
    }
    const before = counters();
    for (let index = 501; index <= 510; index++) {
      expect(create(index, hex(index + 1000))).toEqual({ status: 429, body: { error: "limit reached", quota: {
        kind: "context_drafts_daily", limit: 500, periodSeconds: 86400, resetAt: 11 * DAY,
      } } });
    }
    expect(counters()).toEqual(before);
    advance(11 * DAY - now());
    expect(create(501).status).toBe(201);
  });

  it("rolls back insertion and all counters when a staging write fails", () => {
    const { create, database, contexts, counters } = setup();
    database.exec(`CREATE TRIGGER fail_context_ip BEFORE INSERT ON counters WHEN NEW.kind = 'context_ip'
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    expect(() => create()).toThrow("simulated failure");
    expect(contexts()).toEqual([]);
    expect(counters()).toEqual([]);
  });

  it("rolls back reservation, fill, and consumption if their context mutation fails", () => {
    const { store, create, database, contexts, counters } = setup();
    create();
    const before = contexts();
    const budget = counters();
    database.exec(`CREATE TRIGGER fail_context_update BEFORE UPDATE ON contexts
      BEGIN SELECT RAISE(ABORT, 'context update failure'); END`);
    expect(() => store.reserve(slot())).toThrow("context update failure");
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
    expect(contexts()).toEqual(before);
    expect(counters()).toEqual(budget);
    database.exec("DROP TRIGGER fail_context_update");
    expect(store.reserve(slot()).status).toBe(201);
    database.exec(`CREATE TRIGGER fail_context_update BEFORE UPDATE ON contexts
      BEGIN SELECT RAISE(ABORT, 'context update failure'); END`);
    expect(() => store.fill(slot().id, writeHash, "PODAJ1.ciphertext")).toThrow("context update failure");
    expect(database.prepare("SELECT state, sealed FROM handoffs").get()).toEqual({ state: "pending", sealed: null });
    database.exec("DROP TRIGGER fail_context_update");
    store.fill(slot().id, writeHash, "PODAJ1.ciphertext");
    database.exec(`CREATE TRIGGER fail_context_delete BEFORE DELETE ON contexts
      BEGIN SELECT RAISE(ABORT, 'context delete failure'); END`);
    expect(() => store.consume(slot().id, slot().readHash)).toThrow("context delete failure");
    expect(database.prepare("SELECT state, sealed FROM handoffs").get()).toEqual({ state: "ready", sealed: "PODAJ1.ciphertext" });
    expect(store.context(slot().id).status).toBe(200);
  });

  it("arms a coordinator cleanup alarm after staging and removes expired drafts", async () => {
    let now = 10 * DAY;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { party, alarm, ctx, database } = partySetup();
    expect((await party.createContext(slot().id, writeHash, encryptedContext, ipHash)).status).toBe(201);
    expect(alarm()).toBe(now + 180_000);
    now += 180_000;
    expect((await party.getContext(slot().id)).status).toBe(404);
    await party.alarm();
    expect(database.prepare("SELECT * FROM contexts").all()).toEqual([]);
    expect(alarm()).toBe(12 * DAY + 1);
    const budget = database.prepare("SELECT * FROM counters").all();
    ctx.storage.setAlarm.mockRejectedValue(new Error("alarm unavailable"));
    await expect(party.createContext(slot(2).id, writeHash, encryptedContext, ipHash)).rejects.toThrow("alarm unavailable");
    expect(database.prepare("SELECT * FROM contexts").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM counters").all()).toEqual(budget);
  });

  it.each(["getAlarm", "setAlarm"] as const)("fails staging %s before allocation and never scans delivery sockets", async (method) => {
    const { party, ctx, database } = partySetup();
    ctx.storage[method].mockRejectedValue(new Error("alarm unavailable"));
    await expect(party.createContext(slot().id, writeHash, encryptedContext, ipHash)).rejects.toThrow("alarm unavailable");
    expect(database.prepare("SELECT * FROM contexts").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM counters").all()).toEqual([]);
    expect(ctx.getWebSockets).not.toHaveBeenCalled();
  });

  it("does not reconcile sockets when committing a draft under an existing earlier alarm", async () => {
    const { party, ctx } = partySetup();
    ctx.storage.getAlarm.mockResolvedValue(Date.now() + 1000);
    expect((await party.createContext(slot().id, writeHash, encryptedContext, ipHash)).status).toBe(201);
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(ctx.getWebSockets).not.toHaveBeenCalled();
  });
});

const apiSetup = (publicAccess = false) => {
  const { party, database } = partySetup();
  const limiter = vi.fn(async () => ({ success: true }));
  const env = {
    PODAJ_ACCESS: publicAccess ? "public" : "private", PODAJ_API_AUTH_SECRET: "owner-secret",
    HANDOFF_PARTY: { idFromName: () => "fixed-object", get: () => party },
    ...(publicAccess ? {
      TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "site-secret", PUBLIC_API_LIMITER: { limit: limiter },
    } : {}),
  } as unknown as Env;
  const request = (path: string, init?: RequestInit) => Effect.runPromise(handleHandoffsApi(new Request(`https://podaj.test${path}`, {
    ...init, headers: { "CF-Connecting-IP": "192.0.2.1", ...init?.headers },
  }), env));
  const post = (body: unknown = draft(), headers: Record<string, string> = { Authorization: "Bearer owner-secret" }) => request("/api/contexts", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { env, party, database, limiter, request, post };
};

describe("encrypted context HTTP boundary", () => {
  it("requires private creation authority but permits encrypted public reads without it", async () => {
    const { post, request, database } = apiSetup();
    expect((await post(draft(), {})).status).toBe(401);
    expect((await post()).status).toBe(201);
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
    const read = await request(`/api/contexts/${slot().id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ id: slot().id, encryptedContext, expiresAt: expect.any(Number) });
    expect(read.headers.get("Cache-Control")).toBe("no-store");
    expect((await request(`/api/contexts/${"A".repeat(32)}`)).status).toBe(404);
    expect((await request(`/api/contexts/${hex(999, 32)}`)).status).toBe(404);
  });

  it("stages public drafts before verification, but requires configured admission and the outer IP limiter", async () => {
    const { post, request, env, database, limiter } = apiSetup(true);
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no captcha expected"));
    expect((await post(draft(), {})).status).toBe(201);
    expect(limiter).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT * FROM handoffs").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM credentials").all()).toEqual([]);
    expect(outbound).not.toHaveBeenCalled();
    for (const setting of ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "PUBLIC_API_LIMITER"] as const) {
      const saved = env[setting];
      delete env[setting];
      expect((await post(draft(2), {})).status).toBe(503);
      expect((await request(`/api/contexts/${slot().id}`)).status).toBe(200);
      Object.assign(env, { [setting]: saved });
    }
    limiter.mockResolvedValue({ success: false });
    const limited = await post(draft(2), {});
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate limited", quota: { kind: "api_requests" } });
  });

  it("rejects excess fields, malformed metadata and bounded bodies with sanitized errors", async () => {
    const { post, request, database } = apiSetup();
    for (const body of [
      { ...draft(), names: ["SECRET_NAME"] }, { ...draft(), key: "secret-key" },
      { ...draft(), readToken: hex(999) }, { ...draft(), id: "A".repeat(32) },
      { ...draft(), writeHash: "bad" }, { ...draft(), encryptedContext: "bad" },
      { ...draft(), encryptedContext: "a".repeat(32769) }, { id: slot().id }, null, [],
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/invalid/u) });
    }
    const oversized = await post({ ...draft(), encryptedContext: "a".repeat(34000) });
    expect(oversized.status).toBe(413);
    const announced = await request("/api/contexts", {
      method: "POST", headers: { Authorization: "Bearer owner-secret", "Content-Type": "application/json", "Content-Length": "99999" }, body: "{}",
    });
    expect(announced.status).toBe(413);
    expect(database.prepare("SELECT * FROM contexts").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM counters").all()).toEqual([]);
  });

  it("does not turn publicly readable ciphertext or its write digest into collection authority", async () => {
    const { post, request, party } = apiSetup();
    expect((await post()).status).toBe(201);
    expect((await party.reserve(slot())).status).toBe(201);
    expect((await request(`/api/contexts/${slot().id}`)).status).toBe(200);
    for (const path of [`/api/handoffs/${slot().id}/status`, `/api/handoffs/${slot().id}/writable`]) {
      expect((await request(path)).status).toBe(401);
      expect((await request(path, { headers: { Authorization: `Bearer ${writeHash}` } })).status).toBe(401);
    }
    expect((await request(`/api/handoffs/${slot().id}/consume`, { method: "POST" })).status).toBe(401);
    expect((await party.fetch(new Request(`https://podaj.test/parties/handoff-party/${slot().id}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${writeHash}` },
    }))).status).toBe(401);
  });

  it.each([
    ["context_drafts_daily", "draftsPerDay"],
    ["context_drafts_per_ip", "draftsPerMinutePerIp"],
    ["context_drafts_live", "liveDrafts"],
  ] as const)("maps %s to the actual owner setting", (kind, setting) => {
    expect(quotaExplanation({ kind, limit: 10 }).ownerHelp).toContain(`DEMO_LIMITS.${setting}`);
  });
});
