import { build } from "esbuild";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seal } from "../src/crypto/podaj1.js";
import { digest, recipientFingerprint } from "../src/handoffs/capabilities.js";
import type { Reservation } from "../src/handoffs/protocol.js";

const OWNER = "synthetic-owner-auth-not-a-cloudflare-credential";
const HOST = "https://podaj.test";
const PRIVATE_NAME = "CONFIDENTIAL_VARIABLE_NAME_FOR_RUNTIME_TEST";
const PRIVATE_VALUE = "synthetic-sensitive-value-not-for-storage";
const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
let runtime: Miniflare;
let privateRuntime: Miniflare;
let demoRuntime: Miniflare;
let sealed: string;
const DEMO_OWNER = "f".repeat(64);
let verification: Record<string, unknown> = {};
let verificationCalls = 0;
let demoIp = 1;
const token = () => randomBytes(32).toString("hex");
const headers = (credential: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${credential}`, ...extra });
const send = (path: string, credential?: string, body?: unknown, method = body === undefined ? "GET" : "POST", extra: Record<string, string> = {}) => runtime.dispatchFetch(`${HOST}${path}`, {
  method,
  headers: { ...(runtime === demoRuntime ? { "CF-Connecting-IP": `192.0.2.${demoIp}` } : {}), ...(credential === undefined ? {} : headers(credential)), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const reserve = async () => {
  const response = await send("/api/handoffs/reserve", OWNER, { recipientPublicKey: pair.publicKey });
  expect(response.status).toBe(201);
  return await response.json() as Reservation;
};
const snapshot = async () => await (await send("/__test/snapshot")).json() as {
  handoffs: Array<{ id: string; sealed: string | null; state: string }>;
  credentials: unknown[]; counters: unknown[]; sockets: unknown[];
};

beforeAll(async () => {
  const compiled = await build({
    entryPoints: [resolve("test/helpers/runtime-worker.ts")], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"],
  });
  const create = (demo: boolean) => new Miniflare({
    modules: true, script: compiled.outputFiles[0].text, compatibilityDate: "2025-10-11",
    durableObjects: { HANDOFF_PARTY: { className: "InspectableHandoffParty", useSQLite: true } },
    bindings: {
      PODAJ_MODE: demo ? "demo" : "private", PODAJ_API_AUTH_SECRET: demo ? DEMO_OWNER : OWNER, MAX_HANDOFF_BYTES: "32768",
      ...(demo ? { TURNSTILE_SITE_KEY: "synthetic-site-key", TURNSTILE_SECRET_KEY: "synthetic-siteverify-secret" } : {}),
    },
    ratelimits: demo ? { PUBLIC_API_LIMITER: { simple: { limit: 60, period: 60 } } } : {},
    serviceBindings: { ASSETS: async () => new RuntimeResponse("static", { headers: { "Content-Type": "text/html" } }) },
    outboundService: async (request) => {
      const target = new URL(request.url);
      if (target.hostname !== "challenges.cloudflare.com" || target.pathname !== "/turnstile/v0/siteverify" || request.method !== "POST") throw new Error("unexpected outbound request");
      verificationCalls += 1;
      return RuntimeResponse.json(verification);
    },
  });
  privateRuntime = create(false);
  demoRuntime = create(true);
  runtime = privateRuntime;
  await Promise.all([privateRuntime.ready, demoRuntime.ready]);
  sealed = await seal({ vars: [{ key: PRIVATE_NAME, value: PRIVATE_VALUE }] }, pair.publicKey, "default");
}, 30_000);
beforeEach(async () => { runtime = privateRuntime; verificationCalls = 0; await send("/__test/reset"); });
afterAll(async () => { await Promise.all([privateRuntime?.dispose(), demoRuntime?.dispose()]); });

describe("actual Workers HTTP/RPC/SQLite runtime", () => {
  it("encrypts both names and values, stores only ciphertext and hashes, then atomically removes ciphertext", async () => {
    const slot = await reserve();
    const pending = await snapshot();
    expect(pending.handoffs).toHaveLength(1);
    expect(pending.handoffs[0].sealed).toBeNull();
    expect((await send(`/api/handoffs/${slot.id}`, slot.writeToken, { sealed }, "PUT")).status).toBe(200);
    const stored = await snapshot();
    const serialized = JSON.stringify(stored);
    for (const secret of [PRIVATE_NAME, PRIVATE_VALUE, slot.writeToken, slot.readToken, slot.subscribeToken, pair.privateKey, OWNER]) {
      expect(serialized).not.toContain(secret);
    }
    expect(stored.handoffs[0]).toMatchObject({ state: "ready", sealed });
    const consumed = await send(`/api/handoffs/${slot.id}/consume`, slot.readToken, undefined, "POST");
    expect(consumed.status).toBe(200);
    expect(await consumed.json()).toMatchObject({ sealed });
    expect((await snapshot()).handoffs[0]).toMatchObject({ state: "consumed", sealed: null });
    expect((await send(`/api/handoffs/${slot.id}/consume`, slot.readToken, undefined, "POST")).status).toBe(410);
  });

  it("enforces the complete cross-slot and wrong-role capability matrix", async () => {
    const first = await reserve();
    const second = await reserve();
    const roles = [first.writeToken, first.readToken, first.subscribeToken, second.writeToken, second.readToken, second.subscribeToken, OWNER, token()];
    for (const capability of roles) {
      if (capability !== first.writeToken) expect((await send(`/api/handoffs/${first.id}`, capability, { sealed }, "PUT")).status).toBe(401);
      if (capability !== first.readToken) expect((await send(`/api/handoffs/${first.id}/consume`, capability, undefined, "POST")).status).toBe(401);
      if (capability !== first.subscribeToken) expect((await send(`/api/handoffs/${first.id}/status`, capability)).status).toBe(401);
    }
    expect((await snapshot()).handoffs.every((row) => row.state === "pending")).toBe(true);
    expect((await send(`/api/handoffs/${first.id}/status`, first.subscribeToken)).status).toBe(200);
  });

  it("allows exactly one concurrent fill and one consume, with no resurrection", async () => {
    const slot = await reserve();
    const writes = await Promise.all(Array.from({ length: 8 }, () => send(`/api/handoffs/${slot.id}`, slot.writeToken, { sealed }, "PUT")));
    expect(writes.filter((response) => response.status === 200)).toHaveLength(1);
    expect(writes.filter((response) => response.status === 409)).toHaveLength(7);
    const reads = await Promise.all(Array.from({ length: 8 }, () => send(`/api/handoffs/${slot.id}/consume`, slot.readToken, undefined, "POST")));
    expect(reads.filter((response) => response.status === 200)).toHaveLength(1);
    expect(reads.filter((response) => response.status === 410)).toHaveLength(7);
    expect((await send(`/api/handoffs/${slot.id}`, slot.writeToken, { sealed }, "PUT")).status).toBe(409);
    expect((await snapshot()).handoffs[0].sealed).toBeNull();
  });

  it("never consumes through GET, HEAD, navigation, or status", async () => {
    const slot = await reserve();
    await send(`/api/handoffs/${slot.id}`, slot.writeToken, { sealed }, "PUT");
    for (const method of ["GET", "HEAD"]) {
      for (const path of [`/api/handoffs/${slot.id}`, `/api/handoffs/${slot.id}/consume`]) {
        expect([404, 405]).toContain((await send(path, slot.readToken, undefined, method)).status);
      }
    }
    expect((await send(`/api/handoffs/${slot.id}/status`, slot.subscribeToken)).status).toBe(200);
    expect((await snapshot()).handoffs[0].state).toBe("ready");
  });

  it("fails closed on cross-origin mutation, plaintext uploads, extra fields, malformed envelopes, and oversize bodies", async () => {
    const slot = await reserve();
    const path = `/api/handoffs/${slot.id}`;
    expect((await send(path, slot.writeToken, { sealed }, "PUT", { Origin: "https://evil.test" })).status).toBe(403);
    for (const body of [{ vars: [{ key: PRIVATE_NAME, value: PRIVATE_VALUE }] }, { sealed, vars: [] }, { sealed: "PODAJ1.not-an-envelope" }]) {
      expect((await send(path, slot.writeToken, body, "PUT")).status).toBe(400);
    }
    expect((await send(path, slot.writeToken, { sealed: "PODAJ1." + "a".repeat(40_000) }, "PUT")).status).toBe(413);
    expect((await snapshot()).handoffs[0].state).toBe("pending");
  });

  it("sets no-store and strict CSP on successful and failing API responses", async () => {
    for (const response of [await send("/api/config"), await send("/api/missing"), await send("/api/handoffs/reserve", "wrong", { recipientPublicKey: pair.publicKey })]) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Security-Policy")).not.toContain("challenges.cloudflare.com");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    }
    expect((await send("/authorize")).headers.get("Content-Security-Policy")).toContain("challenges.cloudflare.com");
    expect((await send("/")).headers.get("Content-Security-Policy")).not.toContain("challenges.cloudflare.com");
    expect((await runtime.dispatchFetch("https://podaj.hasparus.workers.dev/api/config")).status).toBe(404);
  });

  it("uses the native hibernating WebSocket API and closes subscriptions after collection", async () => {
    const slot = await reserve();
    const url = new URL(`/parties/handoff-party/${slot.id}`, await runtime.ready);
    url.protocol = "ws:";
    const socket = new WebSocket(url, { headers: headers(slot.subscribeToken) });
    const messages: unknown[] = [];
    socket.on("message", (data) => { messages.push(JSON.parse(String(data))); });
    await vi.waitFor(() => { expect(messages).toContainEqual({ type: "subscribed", status: "pending" }); });
    expect((await snapshot()).sockets).toHaveLength(1);
    await send(`/api/handoffs/${slot.id}`, slot.writeToken, { sealed }, "PUT");
    await vi.waitFor(() => { expect(messages).toContainEqual({ type: "ready" }); });
    const consumed = await send(`/api/handoffs/${slot.id}/consume`, slot.readToken, undefined, "POST");
    expect(consumed.status).toBe(200);
    await vi.waitFor(() => { expect(messages).toContainEqual({ type: "gone" }); });
    await vi.waitFor(async () => { expect((await snapshot()).sockets).toHaveLength(0); });
    socket.terminate();
  });

  it("enforces socket scope and both per-slot and global socket budgets", async () => {
    const first = await reserve();
    for (const wrong of [first.writeToken, first.readToken, OWNER, token()]) {
      expect((await send(`/parties/handoff-party/${first.id}`, wrong, undefined, "GET", { Upgrade: "websocket" })).status).toBe(401);
    }
    expect((await send(`/parties/handoff-party/${first.id}`, first.subscribeToken, undefined, "GET", { Upgrade: "websocket", Origin: "https://evil.test" })).status).toBe(403);
    const clients = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const slot = index === 0 ? first : await reserve();
        for (let count = 0; count < 2; count += 1) {
          const response = await send(`/parties/handoff-party/${slot.id}`, slot.subscribeToken, undefined, "GET", { Upgrade: "websocket" });
          expect(response.status).toBe(101);
          if (!response.webSocket) throw new Error("missing socket");
          response.webSocket.accept();
          clients.push(response.webSocket);
        }
        if (index === 0) expect((await send(`/parties/handoff-party/${slot.id}`, slot.subscribeToken, undefined, "GET", { Upgrade: "websocket" })).status).toBe(429);
      }
      const extra = await reserve();
      expect((await send(`/parties/handoff-party/${extra.id}`, extra.subscribeToken, undefined, "GET", { Upgrade: "websocket" })).status).toBe(429);
      expect((await snapshot()).sockets).toHaveLength(20);
    } finally {
      for (const socket of clients) socket.close();
    }
    await vi.waitFor(async () => { expect((await snapshot()).sockets).toHaveLength(0); });
  });

  it("delivers a native close event and releases the server subscription", async () => {
    const slot = await reserve();
    await send(`/api/handoffs/${slot.id}`, slot.writeToken, { sealed }, "PUT");
    const response = await send(`/__test/native-close?id=${slot.id}`, slot.subscribeToken, undefined, "GET", { "X-Test-Read-Capability": slot.readToken });
    expect(response.status).toBe(200);
    const observed = await response.json() as { events: unknown[]; clientState: number; snapshot: { sockets: unknown[] } };
    expect(observed).toMatchObject({ clientState: 3 });
    await vi.waitFor(async () => { expect((await snapshot()).sockets).toHaveLength(0); });
    expect(observed.events).toContainEqual({ type: "gone" });
    expect(observed.events).toContainEqual({ type: "close", code: 1000, reason: "gone" });
  });

  it("expires a socket without falsely reporting that its pending handoff is gone", async () => {
    const slot = await reserve();
    const response = await send(`/__test/native-expire?id=${slot.id}`, slot.subscribeToken);
    expect(response.status).toBe(200);
    const observed = await response.json() as { events: unknown[] };
    expect(observed.events).not.toContainEqual({ type: "gone" });
    expect(observed.events).toContainEqual({ type: "close", code: 1000, reason: "closed" });
    expect((await send(`/api/handoffs/${slot.id}/status`, slot.subscribeToken)).status).toBe(200);
    expect((await snapshot()).handoffs[0].state).toBe("pending");
  });

  it("rejects actual wrong write authority before malformed body decoding", async () => {
    const slot = await reserve();
    const response = await runtime.dispatchFetch(`${HOST}/api/handoffs/${slot.id}`, {
      method: "PUT", headers: headers(token(), { "Content-Type": "application/json" }), body: "not json",
    });
    expect(response.status).toBe(401);
    expect((await snapshot()).handoffs[0].state).toBe("pending");
  });

  it("expires an unfilled request after the two-hour default and removes it through its alarm", async () => {
    const before = Date.now();
    const slot = await reserve();
    expect(slot.expiresAt - before).toBeGreaterThanOrEqual(7_199_000);
    expect(slot.expiresAt - before).toBeLessThanOrEqual(7_201_000);
    await send("/__test/advance?ms=7200001");
    expect((await send(`/api/handoffs/${slot.id}/status`, slot.subscribeToken)).status).toBe(410);
    expect((await snapshot()).handoffs).toHaveLength(0);
  });

  it("atomically enforces the 200-reservation global budget under concurrent requests", async () => {
    const responses = await Promise.all(Array.from({ length: 201 }, () => send("/api/handoffs/reserve", OWNER, { recipientPublicKey: pair.publicKey })));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(200);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect((await snapshot()).handoffs).toHaveLength(200);
  }, 20_000);
});

describe("public admission through actual Workers and SQLite", () => {
  beforeEach(async () => { runtime = demoRuntime; demoIp += 1; await send("/__test/reset"); });

  const approval = async (verifier = token()) => {
    const challenge = await digest(verifier);
    verification = { success: true, hostname: "podaj.test", action: "podaj-admission", cdata: await digest(`${challenge}.${await recipientFingerprint(pair.publicKey)}`) };
    const response = await send("/api/demo/approve", undefined, { challenge, recipientPublicKey: pair.publicKey, turnstileToken: "synthetic-captcha" });
    const body = await response.json();
    expect(response.status, JSON.stringify({ body, verificationCalls })).toBe(200);
    return verifier;
  };

  it("rejects unapproved and owner credentials before reading creation bodies", async () => {
    for (const credential of [token(), DEMO_OWNER]) {
      const response = await runtime.dispatchFetch(`${HOST}/api/handoffs/reserve`, {
        method: "POST", headers: headers(credential, { "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${demoIp}` }), body: "not json",
      });
      expect(response.status).toBe(401);
    }
    expect((await snapshot()).handoffs).toHaveLength(0);
    expect(verificationCalls).toBe(0);
  });

  it("binds proof, credential, recipient and five-request budget without persisting raw verifiers", async () => {
    const verifier = await approval();
    const status = await send("/api/demo/status", verifier);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "approved", recipientFingerprint: await recipientFingerprint(pair.publicKey) });
    const encoded = JSON.stringify(await snapshot());
    expect(encoded).not.toContain(verifier);
    expect(encoded).not.toContain(pair.publicKey);
    for (let index = 0; index < 6; index += 1) {
      const response = await send("/api/handoffs/reserve", verifier, { recipientPublicKey: pair.publicKey });
      expect(response.status).toBe(index < 5 ? 201 : 429);
    }
    expect((await snapshot()).handoffs).toHaveLength(5);
    expect(verificationCalls).toBe(1);
  });

  it("rechecks the recipient binding inside reservation after credential preflight", async () => {
    const verifier = await approval();
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect((await send("/api/handoffs/reserve", verifier, { recipientPublicKey: other.publicKey })).status).toBe(401);
    expect((await snapshot()).handoffs).toHaveLength(0);
  });

  it.each(["success", "hostname", "action", "cdata"])("refuses unbound Siteverify field %s", async (field) => {
    const challenge = token();
    verification = { success: true, hostname: "podaj.test", action: "podaj-admission", cdata: await digest(`${challenge}.${await recipientFingerprint(pair.publicKey)}`), [field]: field === "success" ? false : "wrong" };
    const response = await send("/api/demo/approve", undefined, { challenge, recipientPublicKey: pair.publicKey, turnstileToken: "synthetic-captcha" });
    expect(response.status).toBe(403);
    expect((await snapshot()).credentials).toHaveLength(0);
    expect(verificationCalls).toBe(1);
  });

  it("limits native HTTP traffic to 60 per minute before verification work", async () => {
    const responses = await Promise.all(Array.from({ length: 61 }, () => send("/api/config")));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(60);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect(verificationCalls).toBe(0);
  });
});
