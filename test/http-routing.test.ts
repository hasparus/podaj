import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { digest, recipientFingerprint } from "../src/handoffs/capabilities.js";
import type { Reservation, ReserveInput, ServiceReply } from "../src/handoffs/protocol.js";
import { handleHandoffsApi } from "../src/handoffs/handler.js";
import { CSP } from "../src/security.js";
import { HandoffStore } from "../src/handoffs/store.js";
import { sqliteStorage } from "./helpers/sqlite.js";

const id = "0123456789abcdef0123456789abcdef";
const token = "a".repeat(64);
const fingerprint = "b".repeat(64);
const expiresAt = 123456;
const sealed = `PODAJ1.${btoa(JSON.stringify({
  v: 1, env: "default", iv: btoa("0".repeat(12)),
  wrappedKey: btoa("0".repeat(256)), ciphertext: btoa("0".repeat(16)),
}))}`;

const setup = (overrides: Partial<Env> = {}) => {
  const service = {
    reserve: vi.fn<(input: ReserveInput) => Promise<ServiceReply>>(async () => ({ status: 201, body: { id, expiresAt, recipientFingerprint: fingerprint } })),
    authorizeWrite: vi.fn<(id: string, hash: string) => Promise<ServiceReply>>(async () => ({ status: 200, body: { authorized: true } })),
    fill: vi.fn<(id: string, hash: string, sealed: string) => Promise<ServiceReply>>(async () => ({ status: 200, body: { id, expiresAt } })),
    status: vi.fn(async (): Promise<ServiceReply> => ({ status: 200, body: { status: "ready", expiresAt } })),
    consume: vi.fn(async () => ({ status: 200, body: { sealed, recipientFingerprint: fingerprint } })),
    credentialStatus: vi.fn<(hash: string) => Promise<ServiceReply>>(async () => ({ status: 202, body: { status: "pending" } })),
    approvalAttempt: vi.fn(async () => ({ status: 200, body: { allowed: true } })),
    approveCredential: vi.fn(async () => ({ status: 200, body: { approved: true, expiresAt } })),
  };
  const namespace = { idFromName: vi.fn(() => "fixed-object"), get: vi.fn(() => service) };
  const env = {
    MAX_HANDOFF_BYTES: "32768",
    PODAJ_API_AUTH_SECRET: "owner",
    HANDOFF_PARTY: namespace,
    ...overrides,
  } as unknown as Env;
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await Effect.runPromise(handleHandoffsApi(new Request(`https://podaj.test${path}`, init), env));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    return response;
  };
  return { env, service, namespace, request };
};

const recipientKey = async (): Promise<string> => {
  const keys = await crypto.subtle.generateKey({
    name: "RSA-OAEP", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ["encrypt", "decrypt"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  return `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PUBLIC KEY-----`;
};

const bearer = { Authorization: `Bearer ${token}` };
const json = { ...bearer, "Content-Type": "application/json" };

const untouchedBody = () => {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new TextEncoder().encode("not-json"));
    controller.close();
  });
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { body, pull, cancel };
};

describe("declarative HTTP routing", () => {
  it("provides isolated bindings to concurrent requests", async () => {
    const first = setup({ MAX_HANDOFF_BYTES: "2048" });
    const second = setup({ MAX_HANDOFF_BYTES: "4096" });
    const responses = await Promise.all([first.request("/api/config"), second.request("/api/config")]);
    expect(await responses[0].json()).toMatchObject({ mode: "private", maxHandoffBytes: 2048 });
    expect(await responses[1].json()).toMatchObject({ mode: "private", maxHandoffBytes: 4096 });
  });

  it.each([
    ["/api/missing", "GET"], ["/api/handoffs", "POST"],
    ["/api/config/", "GET"], ["/API/config", "GET"], ["/api//config", "GET"],
    ["/api/config", "HEAD"], ["/api/config", "POST"],
    ["/api/handoffs/bad/status", "GET"], ["/api/handoffs/bad", "GET"],
    [`/api/handoffs/%30${id.slice(1)}/status`, "GET"],
    [`/api/handoffs/${id}/consume`, "GET"], [`/api/handoffs/${id}`, "DELETE"],
  ])("rejects unknown or noncanonical %s %s", async (path, method) => {
    const { request, service } = setup();
    const response = await request(path, { method });
    expect(response.status).toBe(404);
    expect(service.consume).not.toHaveBeenCalled();
    expect(service.fill).not.toHaveBeenCalled();
  });

  it("does not consume on the handoff GET", async () => {
    const { request, service } = setup();
    const response = await request(`/api/handoffs/${id}`, { headers: bearer });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("PUT");
    expect(await response.text()).toBe("");
    expect(service.consume).not.toHaveBeenCalled();
  });

  it("authorizes creation before reading its body", async () => {
    const { request, service } = setup();
    const response = await request("/api/handoffs/reserve", { method: "POST", body: "not-json" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(service.reserve).not.toHaveBeenCalled();
  });

  it.each(["pending", "ready", "consumed", "expired"] as const)(
    "rejects actual wrong-role/cross-slot write authority without touching a %s body",
    async (state) => {
      const { storage, database } = sqliteStorage();
      let now = Date.UTC(2026, 10, 1);
      const store = new HandoffStore(storage, {}, () => now);
      const { request, service } = setup();
      service.authorizeWrite.mockImplementation(async (slotId, hash) => store.authorizeWrite(slotId, hash));
      const readToken = "c".repeat(64);
      const subscribeToken = "d".repeat(64);
      const otherWriteToken = "e".repeat(64);
      const unknownToken = "f".repeat(64);
      try {
        const hashes = await Promise.all([token, readToken, subscribeToken, otherWriteToken].map(digest));
        const slot = {
          id, recipientFingerprint: fingerprint, writeHash: hashes[0], readHash: hashes[1],
          subscribeHash: hashes[2], creatorHash: null,
        };
        expect(store.reserve(slot).status).toBe(201);
        expect(store.reserve({ ...slot, id: "2".repeat(32), writeHash: hashes[3] }).status).toBe(201);
        if (state === "ready" || state === "consumed") store.fill(id, hashes[0], sealed);
        if (state === "consumed") store.consume(id, hashes[1]);
        if (state === "expired") now += 7_200_000;
        const rejected = [
          [readToken, 401], [subscribeToken, 401], [otherWriteToken, 401], [unknownToken, 401],
          ...(state === "pending" ? [] : [[token, state === "expired" ? 410 : 409]]),
        ] as const;
        for (const [credential, status] of rejected) {
          const { body, pull, cancel } = untouchedBody();
          const response = await request(`/api/handoffs/${id}`, {
            method: "PUT", headers: { ...json, Authorization: `Bearer ${credential}` }, body, duplex: "half",
          } as RequestInit);
          expect(response.status).toBe(status);
          expect(pull).not.toHaveBeenCalled();
          expect(cancel).not.toHaveBeenCalled();
          expect(service.fill).not.toHaveBeenCalled();
        }
      } finally { database.close(); }
    },
  );

  it.each([
    { status: 410, body: { status: "gone" }, expected: 410 },
    { status: 200, body: { authorized: false }, expected: 503 },
    { status: 401, body: { unexpected: "refusal" }, expected: 503 },
  ])("does not touch the body for absent slots or malformed preflight replies: $status/$expected", async ({ status, body: replyBody, expected }) => {
    const { request, service } = setup();
    service.authorizeWrite.mockResolvedValueOnce({ status, body: replyBody });
    const { body, pull, cancel } = untouchedBody();
    const response = await request(`/api/handoffs/${id}`, {
      method: "PUT", headers: json, body, duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(expected);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(service.fill).not.toHaveBeenCalled();
  });

  it("uses actual write preflight without granting permission to skip the final commit checks", async () => {
    const { storage, database } = sqliteStorage();
    const store = new HandoffStore(storage);
    const { request, service } = setup();
    const writeHash = await digest(token);
    try {
      store.reserve({
        id, recipientFingerprint: fingerprint, writeHash, readHash: "c".repeat(64),
        subscribeHash: "d".repeat(64), creatorHash: null,
      });
      service.authorizeWrite.mockImplementation(async (slotId, hash) => store.authorizeWrite(slotId, hash));
      service.fill.mockImplementation(async (slotId, hash, ciphertext) => store.fill(slotId, hash, ciphertext));
      const response = await request(`/api/handoffs/${id}`, {
        method: "PUT", headers: json, body: JSON.stringify({ sealed }),
      });
      expect(response.status).toBe(200);
      expect(service.authorizeWrite).toHaveBeenCalledWith(id, writeHash);
      expect(service.fill).toHaveBeenCalledWith(id, writeHash, sealed);
      expect(store.authorizeWrite(id, writeHash).status).toBe(409);
    } finally { database.close(); }
  });

  it.each(["unknown", "expired"] as const)("rejects %s demo credentials before touching the body", async (state) => {
    const { storage, database } = sqliteStorage();
    let now = Date.UTC(2026, 10, 1);
    const store = new HandoffStore(storage, { PODAJ_MODE: "demo" }, () => now);
    const { request, service } = setup({
      PODAJ_MODE: "demo", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret",
      PUBLIC_API_LIMITER: { limit: async () => ({ success: true }) },
    });
    service.credentialStatus.mockImplementation(async (hash) => store.credentialStatus(hash));
    try {
      const creatorHash = await digest(token);
      if (state === "expired") {
        store.approveCredential(creatorHash, fingerprint);
        now += 7_200_000;
      }
      const { body, pull, cancel } = untouchedBody();
      const response = await request("/api/handoffs/reserve", {
        method: "POST", headers: { ...json, "CF-Connecting-IP": "192.0.2.1" }, body, duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(service.credentialStatus).toHaveBeenCalledWith(creatorHash);
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(service.reserve).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it("allows approved demo creation and still revalidates recipient binding at reservation", async () => {
    const { storage, database } = sqliteStorage();
    const store = new HandoffStore(storage, { PODAJ_MODE: "demo" });
    const { request, service } = setup({
      PODAJ_MODE: "demo", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret",
      PUBLIC_API_LIMITER: { limit: async () => ({ success: true }) },
    });
    service.credentialStatus.mockImplementation(async (hash) => store.credentialStatus(hash));
    service.reserve.mockImplementation(async (reservation) => store.reserve(reservation));
    try {
      const recipientPublicKey = await recipientKey();
      const creatorHash = await digest(token);
      store.approveCredential(creatorHash, await recipientFingerprint(recipientPublicKey));
      const headers = { ...json, "CF-Connecting-IP": "192.0.2.1" };
      const response = await request("/api/handoffs/reserve", {
        method: "POST", headers, body: JSON.stringify({ recipientPublicKey }),
      });
      expect(response.status).toBe(201);
      expect(service.reserve).toHaveBeenCalledWith(expect.objectContaining({ creatorHash }));
      const mismatch = await request("/api/handoffs/reserve", {
        method: "POST", headers, body: JSON.stringify({ recipientPublicKey: await recipientKey() }),
      });
      expect(mismatch.status).toBe(401);
    } finally { database.close(); }
  });

  it("applies shared origin and rate policy before body parsing", async () => {
    const crossOrigin = setup();
    const response = await crossOrigin.request(`/api/handoffs/${id}`, {
      method: "PUT", headers: { ...json, Origin: "https://other.test" }, body: "invalid",
    });
    expect(response.status).toBe(403);
    const limited = setup({
      PODAJ_MODE: "demo", PUBLIC_API_LIMITER: { limit: async () => ({ success: false }) },
    });
    const blocked = await limited.request(`/api/handoffs/${id}`, {
      method: "PUT", headers: { ...json, "CF-Connecting-IP": "192.0.2.1" }, body: "invalid",
    });
    expect(blocked.status).toBe(429);
    expect(limited.service.fill).not.toHaveBeenCalled();
  });

  it("counts streaming bytes before attempting JSON/schema decoding", async () => {
    const { request, service } = setup({ MAX_HANDOFF_BYTES: "1" });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1026)); },
      cancel,
    });
    const init = { method: "PUT", headers: json, body, duplex: "half" };
    const response = await request(`/api/handoffs/${id}`, init);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload too large" });
    expect(cancel).toHaveBeenCalled();
    expect(service.fill).not.toHaveBeenCalled();
  });

  it("preserves malformed-body error codes after bounded reads", async () => {
    const { request } = setup();
    const response = await request(`/api/handoffs/${id}`, {
      method: "PUT", headers: json, body: JSON.stringify({ sealed, extra: true }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid json" });
    const invalid = await request(`/api/handoffs/${id}`, {
      method: "PUT", headers: json, body: JSON.stringify({ sealed: 123 }),
    });
    expect(invalid.status).toBe(413);
  });

  it("delivers existing capabilities without public-admission configuration", async () => {
    const { request, service, namespace } = setup({ PODAJ_MODE: "demo" });
    const config = await request("/api/config");
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ mode: "demo", maxHandoffBytes: 32768 });
    expect((await request("/api/handoffs/reserve", { method: "POST", headers: json, body: "not-json" })).status).toBe(503);
    expect((await request("/api/demo/approve", { method: "POST", body: "not-json" })).status).toBe(503);
    const filled = await request(`/api/handoffs/${id}`, {
      method: "PUT", headers: json, body: JSON.stringify({ sealed }),
    });
    expect(filled.status).toBe(200);
    expect(await filled.json()).toEqual({ id, expiresAt });
    const status = await request(`/api/handoffs/${id}/status`, { headers: bearer });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "ready", expiresAt });
    const consumed = await request(`/api/handoffs/${id}/consume`, { method: "POST", headers: bearer });
    expect(consumed.status).toBe(200);
    expect(await consumed.json()).toEqual({ sealed, recipientFingerprint: fingerprint });
    const hash = await digest(token);
    expect(service.fill).toHaveBeenCalledWith(id, hash, sealed);
    expect(service.status).toHaveBeenCalledWith(id, hash);
    expect(service.consume).toHaveBeenCalledWith(id, hash);
    expect(namespace.idFromName).toHaveBeenCalledWith("handoffs");
  });

  it("creates owner reservations with distinct raw capabilities and only hashes in RPC", async () => {
    const { request, service } = setup();
    const recipientPublicKey = await recipientKey();
    const response = await request("/api/handoffs/reserve", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
      body: JSON.stringify({ recipientPublicKey }),
    });
    expect(response.status).toBe(201);
    const reservation = await response.json() as Reservation;
    expect(new Set([reservation.writeToken, reservation.readToken, reservation.subscribeToken]).size).toBe(3);
    expect(service.reserve).toHaveBeenCalledWith(expect.objectContaining({
      recipientFingerprint: await recipientFingerprint(recipientPublicKey), creatorHash: null,
      writeHash: await digest(reservation.writeToken), readHash: await digest(reservation.readToken),
      subscribeHash: await digest(reservation.subscribeToken),
    }));
  });

  it("binds Turnstile proof to both the challenge and recipient fingerprint", async () => {
    const { request, service } = setup({ PODAJ_MODE: "demo", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret", PUBLIC_API_LIMITER: { limit: async () => ({ success: true }) } });
    const recipientPublicKey = await recipientKey();
    const keyFingerprint = await recipientFingerprint(recipientPublicKey);
    const challenge = "d".repeat(64);
    const cdata = await digest(`${challenge}.${keyFingerprint}`);
    const siteverify = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ success: true, hostname: "podaj.test", action: "podaj-admission", cdata: challenge }))
      .mockResolvedValueOnce(Response.json({ success: true, hostname: "podaj.test", action: "podaj-admission", cdata }));
    try {
      const init = {
        method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" },
        body: JSON.stringify({ recipientPublicKey, challenge, turnstileToken: "captcha" }),
      };
      const unbound = await request("/api/demo/approve", init);
      expect(unbound.status).toBe(403);
      expect(service.approveCredential).not.toHaveBeenCalled();
      const bound = await request("/api/demo/approve", init);
      expect(bound.status).toBe(200);
      expect(await bound.json()).toEqual({ approved: true, expiresAt });
      expect(service.approveCredential).toHaveBeenCalledWith(challenge, keyFingerprint);
      expect(service.approvalAttempt).toHaveBeenCalledTimes(2);
    } finally {
      siteverify.mockRestore();
    }
  });

  it("preserves gone status without exposing ciphertext", async () => {
    const { request, service } = setup();
    service.status.mockResolvedValueOnce({ status: 410, body: { status: "gone" } });
    const response = await request(`/api/handoffs/${id}/status`, { headers: bearer });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ status: "gone" });
  });

  it("checks successful RPC replies before returning them", async () => {
    const { request, service } = setup();
    service.status.mockResolvedValueOnce({ status: 200, body: { status: "unexpected", expiresAt } });
    const response = await request(`/api/handoffs/${id}/status`, { headers: bearer });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service unavailable" });
  });

  it("keeps demo status and private-only approval handshakes exact", async () => {
    const demo = setup({ PODAJ_MODE: "demo", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret", PUBLIC_API_LIMITER: { limit: async () => ({ success: true }) } });
    const pending = await demo.request("/api/demo/status", { headers: { ...bearer, "CF-Connecting-IP": "192.0.2.1" } });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending" });
    const privateInstance = setup();
    const hidden = await privateInstance.request("/api/demo/approve", { method: "POST" });
    expect(hidden.status).toBe(404);
  });

  it("enforces the closed hostname even when called without the Worker", async () => {
    const { env } = setup();
    const response = await Effect.runPromise(handleHandoffsApi(
      new Request("https://podaj.hasparus.workers.dev/api/config"), env,
    ));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
