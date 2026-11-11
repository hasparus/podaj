import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authorizeDemo, instanceConfig, originOf, probeInstance, recipientIdentity, requestFailure, tokenVerdict } from "../scripts/instance.js";
import { HOSTED_DEMO_ORIGIN, SELF_HOST_URL } from "../src/client/user-facing.js";

const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const fingerprint = recipientIdentity(pair.publicKey).fingerprint;
afterEach(() => vi.unstubAllGlobals());

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

  it("reports authorization quota details even when its error body is not a record", async () => {
    const response = new Response("synthetic-secret", { status: 429 });
    const json = vi.spyOn(response, "json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(authorizeDemo("https://private.example", pair.publicKey, () => undefined)).rejects.toThrow("authorization failed (429): Request limit reached.");
    expect(json).toHaveBeenCalledTimes(1);
  });
});

describe("proof-bound public authorization", () => {
  it("shows only the challenge and own SPKI, polls using verifier, and verifies full fingerprint", async () => {
    let link = "";
    let verifier = "";
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      verifier = new Headers(init.headers).get("Authorization")!.slice(7);
      expect(verifier).toMatch(/^[a-f0-9]{64}$/u);
      const hash = new URLSearchParams(new URL(link.split("\n")[1]!).hash.slice(1));
      expect(hash.get("challenge")).toBe(createHash("sha256").update(verifier).digest("hex"));
      expect(hash.get("recipient")).toBe(recipientIdentity(pair.publicKey).encoded);
      expect(link).not.toContain(verifier);
      expect(link).not.toContain("PRIVATE");
      expect(String(_url)).toBe("http://localhost:8787/api/demo/status");
      expect(init.redirect).toBe("error");
      return Response.json({ status: "approved", expiresAt: Date.now() + 60_000, recipientFingerprint: fingerprint });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await authorizeDemo("http://localhost:8787", pair.publicKey, (message) => { link = message; })).toBe(verifier);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a different key even if its short fingerprint prefix matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      status: "approved", expiresAt: Date.now() + 60_000,
      recipientFingerprint: `${fingerprint.slice(0, 12)}${"0".repeat(52)}`,
    })));
    await expect(authorizeDemo("http://localhost:8787", pair.publicKey, () => undefined)).rejects.toThrow("fingerprint");
  });

  it("bounds pending status polling and does not allocate requests", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "pending" }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(authorizeDemo("http://localhost:8787", pair.publicKey, () => undefined, { attempts: 100, intervalMs: 0 })).rejects.toThrow("timed out");
    expect(fetcher).toHaveBeenCalledTimes(60);
  });

  it("aborts a hung status request at the shared authorization deadline", async () => {
    const fetcher = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    await expect(authorizeDemo("http://localhost:8787", pair.publicKey, () => undefined, { timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on status errors without reserving and reports authorization quotas", async () => {
    const response = Response.json({ error: "synthetic-secret", quota: { kind: "approvals_daily", limit: 41, resetAt: Date.UTC(2030, 0, 2) } }, { status: 429 });
    const json = vi.spyOn(response, "json");
    const fetcher = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetcher);
    const failure = await authorizeDemo("http://localhost:8787", pair.publicKey, () => undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("authorization failed (429)");
    expect((failure as Error).message).toContain("Daily CLI approval limit reached (41)");
    expect((failure as Error).message).toContain("00:00 UTC");
    expect((failure as Error).message).toContain("DEMO_LIMITS.approvalsPerDay");
    expect((failure as Error).message).not.toContain("synthetic-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledTimes(1);
  });

  it.each([200, 202])("preserves malformed-success validation for HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(null, { status })));
    await expect(authorizeDemo("http://localhost:8787", pair.publicKey, () => undefined)).rejects.toThrow("unexpected JSON response");
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
