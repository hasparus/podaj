import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { instanceConfig, originOf, probeInstance, recipientIdentity, requestFailure, tokenVerdict } from "../scripts/instance.js";
import { HOSTED_DEMO_ORIGIN, SELF_HOST_URL } from "../src/client/user-facing.js";

const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
afterEach(() => vi.unstubAllGlobals());

it("derives the full fingerprint from the local RSA SPKI", () => {
  const spki = Buffer.from(pair.publicKey.split("\n").slice(1, -2).join(""), "base64");
  expect(recipientIdentity(pair.publicKey)).toEqual({
    encoded: spki.toString("base64url"),
    fingerprint: createHash("sha256").update(spki).digest("hex"),
  });
});

it("probes access, not a random handoff, with bounded nonredirecting requests", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await probeInstance("http://localhost:8787", "synthetic-token")).toBe("ok");
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://localhost:8787/api/access");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    headers: { Authorization: "Bearer synthetic-token" }, redirect: "error",
  });
  expect(fetcher.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  expect(tokenVerdict(410)).toBe("unreachable");
  expect(tokenVerdict(401)).toBe("unauthorized");
  expect(tokenVerdict(503)).toBe("locked");
});

it.each(["private", "public"] as const)("reads explicit %s access configuration without sending credentials", async (access) => {
  const config = { access, handoffTtlSeconds: 7200, maxHandoffBytes: 32768, ...(access === "public" ? { turnstileSiteKey: "synthetic-site-key" } : {}) };
  const fetcher = vi.fn().mockResolvedValue(Response.json(config));
  vi.stubGlobal("fetch", fetcher);
  expect(await instanceConfig("http://localhost:8787")).toEqual(config);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://localhost:8787/api/config");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  expect(fetcher.mock.calls[0]?.[1].headers).toBeUndefined();
});

it.each([{ access: "demo" }, { access: "unknown" }, { mode: "private" }, { mode: "demo" }])("refuses obsolete or invalid access configuration %j", async (fields) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...fields, handoffTtlSeconds: 7200, maxHandoffBytes: 32768 })));
  await expect(instanceConfig("http://localhost:8787")).rejects.toThrow("invalid instance configuration");
});

describe("CLI rate-limit diagnostics", () => {
  it.each([
    { quota: { kind: "reservations_daily", limit: 137, resetAt: Date.UTC(2030, 0, 2) }, details: ["Daily handoff limit reached (137)", "00:00 UTC", "DEMO_LIMITS.reservationsPerDay", "src/handoffs/protocol.ts"] },
    { quota: { kind: "live_handoffs", limit: 29 }, details: ["Active handoff limit reached (29)", "Collect one", "DEMO_LIMITS.liveHandoffs", "HANDOFF_TTL_SECONDS", "expire new handoffs sooner"] },
    { quota: { kind: "verification_attempts_per_ip", limit: 7, periodSeconds: 90, resetAt: Date.UTC(2030, 0, 2, 12, 34) }, details: ["7 attempts per 90 seconds", "12:34 UTC", "DEMO_LIMITS.approvalAttemptsPerMinutePerIp"] },
    { quota: { kind: "api_requests" }, details: ["Too many requests from this IP.", "simple.limit", "simple.period", "PUBLIC_API_LIMITER", "wrangler.jsonc"] },
  ])("reports validated quota and actual owner settings for $quota.kind", async ({ quota, details }) => {
    const response = Response.json({ error: "synthetic-private-error", message: "synthetic-secret", quota }, { status: 429 });
    const json = vi.spyOn(response, "json");
    const failure = await requestFailure(response, "reserve failed", "https://private.example");
    expect(failure.message).toMatch(/^reserve failed \(429\):/u);
    for (const detail of details) expect(failure.message).toContain(detail);
    expect(json).toHaveBeenCalledTimes(1);
    expect(failure.message).not.toMatch(/synthetic|self-hosting/iu);
  });

  it.each([
    "not JSON: synthetic-secret",
    JSON.stringify({ error: "synthetic-secret", message: "synthetic-secret", quota: { kind: "unknown-synthetic-secret", limit: 55 } }),
    JSON.stringify({ quota: { kind: "live_handoffs", limit: "synthetic-secret" } }),
    JSON.stringify(null),
  ])("safely handles missing, malformed or unknown quota metadata", async (body) => {
    const response = new Response(body, { status: 429, headers: { "X-Secret": "synthetic-secret" } });
    const json = vi.spyOn(response, "json");
    const failure = await requestFailure(response, "read failed", "https://private.example");
    expect(failure.message).toContain("read failed (429)");
    expect(failure.message).toBe("read failed (429): Request limit reached.");
    expect(failure.message).not.toMatch(/synthetic|X-Secret|55/u);
    expect(json).toHaveBeenCalledTimes(1);
  });

  it.each([
    HOSTED_DEMO_ORIGIN,
    "https://private.example",
    "https://public.example",
    "https://podaj.fyi.private.example",
    "https://podaj.fyi:8443",
    "http://podaj.fyi",
    "http://localhost:8787",
  ])("offers self-hosting only for the exact hosted demo origin: %s", async (origin) => {
    const failure = await requestFailure(new Response(null, { status: 429 }), "reserve failed", origin);
    expect(failure.message.includes(SELF_HOST_URL)).toBe(origin === HOSTED_DEMO_ORIGIN);
  });

  it.each([400, 401, 403, 404, 410, 500, 503])("preserves the generic HTTP %s error without reading its body", async (status) => {
    const response = Response.json({ error: "synthetic-secret", message: "synthetic-secret" }, { status });
    const json = vi.spyOn(response, "json");
    const failure = await requestFailure(response, "read failed", HOSTED_DEMO_ORIGIN);
    expect(failure.message).toBe(`read failed (${status})`);
    expect(json).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it("reports configuration and access-probe limits instead of masking them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ quota: { kind: "live_handoffs", limit: 29 } }, { status: 429 })));
    await expect(instanceConfig("https://private.example")).rejects.toThrow("configuration unavailable (429): Active handoff limit reached (29)");
    await expect(probeInstance("https://private.example", "synthetic-secret")).rejects.toThrow("access check failed (429): Active handoff limit reached (29)");
  });
});

describe("worker origins", () => {
  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])("allows %s", (origin) => {
    expect(originOf(origin)).toBe(origin);
  });
  it("requires HTTPS remotely and redacts URL credentials", () => {
    expect(() => originOf("http://podaj.example")).toThrow(/use HTTPS/);
    expect(() => originOf("https://operator:synthetic-password@podaj.example")).toThrow("worker URLs must not contain credentials");
  });
});
