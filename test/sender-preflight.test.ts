import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seal } from "../src/crypto/podaj1.js";
import { digest, recipientFingerprint } from "../src/handoffs/capabilities.js";
import type { Reservation } from "../src/handoffs/protocol.js";
import { nativeRuntime, OWNER, type NativeRuntime } from "./helpers/native-runtime.js";

const keypair = () => generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const recipient = keypair();
const otherRecipient = keypair();
const capability = () => randomBytes(32).toString("hex");
const address = () => ({ id: randomBytes(16).toString("hex"), writeToken: capability() });
let demo: NativeRuntime;
let ip = 0;

const send = (path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  demo.request(path, {
    method,
    headers: {
      "CF-Connecting-IP": `192.0.2.${ip}`,
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const approvalBody = async (verifier: string) => ({
  challenge: await digest(verifier), recipientPublicKey: recipient.publicKey, turnstileToken: "synthetic-turnstile-proof",
});
const approve = async () => {
  const verifier = capability();
  const body = await approvalBody(verifier);
  demo.proof({
    success: true, hostname: new URL(demo.origin).hostname, action: "podaj-admission",
    cdata: await digest(`${body.challenge}.${await recipientFingerprint(recipient.publicKey)}`),
  });
  expect((await send("/api/demo/approve", undefined, body)).status).toBe(200);
  return verifier;
};
const stage = async (chosen = address()) => {
  const staged = await send("/api/contexts", undefined, {
    id: chosen.id, writeHash: await digest(chosen.writeToken), encryptedContext: "a".repeat(39),
  });
  expect(staged.status).toBe(201);
  return chosen;
};
const reserve = async (verifier: string, chosen = address()) => {
  await stage(chosen);
  const response = await send("/api/handoffs/reserve", verifier, { ...chosen, recipientPublicKey: recipient.publicKey });
  expect(response.status).toBe(201);
  return await response.json() as Reservation;
};

beforeAll(async () => { demo = await nativeRuntime(true); }, 30_000);
beforeEach(async () => { ip += 1; await demo.reset(); demo.proof({ success: false }); });
afterAll(async () => { await demo?.runtime.dispose(); });

describe("single-link public approval and writer preflight", () => {
  it("reserves the chosen address only after recipient-bound approval", async () => {
    const chosen = address();
    const unapproved = capability();
    expect((await send(`/api/handoffs/${chosen.id}/writable`, chosen.writeToken)).status).toBe(410);
    expect((await send("/api/handoffs/reserve", unapproved, { ...chosen, recipientPublicKey: recipient.publicKey })).status).toBe(401);
    expect((await demo.snapshot()).handoffs).toEqual([]);

    const failed = await send("/api/demo/approve", undefined, await approvalBody(unapproved));
    expect(failed.status).toBe(403);
    expect((await demo.snapshot()).credentials).toEqual([]);
    expect((await send("/api/handoffs/reserve", unapproved, { ...chosen, recipientPublicKey: recipient.publicKey })).status).toBe(401);

    const verifier = await approve();
    expect((await demo.snapshot()).handoffs).toEqual([]);
    expect((await send(`/api/handoffs/${chosen.id}/writable`, chosen.writeToken)).status).toBe(410);
    const slot = await reserve(verifier, chosen);
    expect(slot).toMatchObject({ ...chosen, recipientFingerprint: await recipientFingerprint(recipient.publicKey), handoffTtlSeconds: 7200 });
    expect(new Set([slot.writeToken, slot.readToken, slot.subscribeToken]).size).toBe(3);
    expect(slot.readToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(slot.subscribeToken).toMatch(/^[a-f0-9]{64}$/u);
    const response = await send(`/api/handoffs/${slot.id}/writable`, chosen.writeToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorized: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await demo.snapshot()).handoffs).toHaveLength(1);
  });

  it("requires a live writer-bound draft for supplied addresses, without allocating on refusal", async () => {
    const verifier = await approve();
    const chosen = address();
    const before = await demo.snapshot();
    const activate = (writeToken = chosen.writeToken) => send("/api/handoffs/reserve", verifier, {
      id: chosen.id, writeToken, recipientPublicKey: recipient.publicKey,
    });
    const missing = await activate();
    expect(missing.status).toBe(410);
    expect(await missing.json()).toEqual({ status: "gone" });
    expect(await demo.snapshot()).toEqual(before);
    await stage(chosen);
    const staged = await demo.snapshot();
    expect((await activate(capability())).status).toBe(401);
    expect(await demo.snapshot()).toEqual(staged);
    expect((await activate()).status).toBe(201);
    expect((await demo.snapshot()).handoffs).toHaveLength(1);
  });

  it("rejects absent, wrong, owner and challenge credentials before parsing reservation bodies", async () => {
    const verifier = await approve();
    for (const token of [undefined, capability(), OWNER, await digest(verifier)]) {
      const response = await demo.request("/api/handoffs/reserve", {
        method: "POST", body: "not json",
        headers: {
          "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${ip}`,
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect((await demo.snapshot()).handoffs).toEqual([]);
  });

  it("requires both valid reserve options, rejects excess fields and preserves recipient binding", async () => {
    const verifier = await approve();
    const chosen = address();
    const base = { recipientPublicKey: recipient.publicKey };
    const badBodies = [
      { ...base, id: chosen.id }, { ...base, writeToken: chosen.writeToken },
      { ...base, ...chosen, id: "a".repeat(31) }, { ...base, ...chosen, id: "A".repeat(32) },
      { ...base, ...chosen, writeToken: "b".repeat(63) }, { ...base, ...chosen, writeToken: 123 },
      { ...base, ...chosen, id: null }, { ...base, ...chosen, writeToken: null },
      { ...base, ...chosen, readToken: capability() }, { ...base, ...chosen, subscribeToken: capability() },
      { ...chosen }, { ...chosen, recipientPublicKey: 123 }, { ...chosen, recipientPublicKey: "not a key" },
      { ...base, ...chosen, recipientPublicKey: "x".repeat(2049) },
    ];
    for (const body of badBodies) {
      expect((await send("/api/handoffs/reserve", verifier, body)).status).toBe(400);
    }
    expect((await send("/api/handoffs/reserve", verifier, { ...chosen, recipientPublicKey: otherRecipient.publicKey })).status).toBe(401);
    expect((await demo.snapshot()).handoffs).toEqual([]);
    expect((await reserve(verifier, chosen)).id).toBe(chosen.id);
  });

  it("does not accept reservation options in the recipient-only approval payload", async () => {
    const body = await approvalBody(capability());
    const chosen = address();
    for (const extra of [{ id: chosen.id }, { writeToken: chosen.writeToken }, chosen]) {
      expect((await send("/api/demo/approve", undefined, { ...body, ...extra })).status).toBe(400);
    }
    expect(demo.verifications).toEqual([]);
    expect((await demo.snapshot()).credentials).toEqual([]);
    expect((await demo.snapshot()).handoffs).toEqual([]);
  });

  it("permits only the writer to preflight, without giving it collection or subscription authority", async () => {
    const verifier = await approve();
    const slot = await reserve(verifier);
    const path = `/api/handoffs/${slot.id}`;
    for (const token of [undefined, capability(), slot.readToken, slot.subscribeToken, verifier, OWNER]) {
      const response = await send(`${path}/writable`, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    const before = await demo.snapshot();
    for (let count = 0; count < 3; count += 1) {
      const response = await send(`${path}/writable`, slot.writeToken);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authorized: true });
    }
    expect(await demo.snapshot()).toEqual(before);
    expect((await send(`${path}/status`, slot.writeToken)).status).toBe(401);
    expect((await send(`${path}/consume`, slot.writeToken, undefined, "POST")).status).toBe(401);
    const socket = await demo.runtime.dispatchFetch(`${demo.origin}/parties/handoff-party/${slot.id}`, {
      headers: { Authorization: `Bearer ${slot.writeToken}`, Upgrade: "websocket", "CF-Connecting-IP": `192.0.2.${ip}` },
    });
    expect(socket.status).toBe(401);
    expect((await demo.snapshot()).sockets).toEqual([]);

    const sealed = await seal({ vars: [{ key: "TEST_LABEL", value: "synthetic-test-value" }] }, recipient.publicKey);
    expect((await send(path, slot.writeToken, { sealed }, "PUT")).status).toBe(200);
    const filled = await demo.snapshot();
    const response = await send(`${path}/writable`, slot.writeToken);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already filled" });
    expect((await send(`${path}/consume`, slot.writeToken, undefined, "POST")).status).toBe(401);
    expect(await demo.snapshot()).toEqual(filled);
    const consumed = await send(`${path}/consume`, slot.readToken, undefined, "POST");
    expect(consumed.status).toBe(200);
    expect(await consumed.json()).toMatchObject({ sealed });
  });

  it("refuses address collisions without overwriting or spending the existing reservation budget", async () => {
    const verifier = await approve();
    const chosen = address();
    const slot = await reserve(verifier, chosen);
    const before = await demo.snapshot();
    const conflictingWriter = capability();
    const collision = await send("/api/handoffs/reserve", verifier, {
      recipientPublicKey: recipient.publicKey, id: chosen.id, writeToken: conflictingWriter,
    });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "already exists" });
    expect(await demo.snapshot()).toEqual(before);
    expect((await send(`/api/handoffs/${slot.id}/writable`, slot.writeToken)).status).toBe(200);
    expect((await send(`/api/handoffs/${slot.id}/writable`, conflictingWriter)).status).toBe(401);
    for (let count = 1; count < 5; count += 1) await reserve(verifier);
    const exhausted = await send("/api/handoffs/reserve", verifier, { ...await stage(), recipientPublicKey: recipient.publicKey });
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toMatchObject({ quota: { kind: "reservations_per_credential", limit: 5 } });
    expect((await demo.snapshot()).handoffs).toHaveLength(5);
  });

  it("keeps private recipient-only reservations server-generated", async () => {
    const privateRuntime = await nativeRuntime(false);
    try {
      const response = await privateRuntime.request("/api/handoffs/reserve", {
        method: "POST", headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipientPublicKey: recipient.publicKey }),
      });
      expect(response.status).toBe(201);
      const slot = await response.json() as Reservation;
      expect(slot.id).toMatch(/^[a-f0-9]{32}$/u);
      expect(new Set([slot.writeToken, slot.readToken, slot.subscribeToken]).size).toBe(3);
      const preflight = await privateRuntime.request(`/api/handoffs/${slot.id}/writable`, {
        headers: { Authorization: `Bearer ${slot.writeToken}` },
      });
      expect(preflight.status).toBe(200);
      expect(await preflight.json()).toEqual({ authorized: true });
    } finally {
      await privateRuntime.runtime.dispose();
    }
  });
});
