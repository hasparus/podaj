import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authorizeDemo, instanceConfig, originOf, probeInstance, recipientIdentity, tokenVerdict } from "../scripts/instance.js";

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

it("reads explicit configuration and refuses invalid modes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ mode: "unknown" })));
  await expect(instanceConfig("http://localhost:8787")).rejects.toThrow("invalid instance configuration");
});

describe("proof-bound demo authorization", () => {
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

  it("fails closed on status errors without reserving", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "limited" }, { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(authorizeDemo("http://localhost:8787", pair.publicKey, () => undefined)).rejects.toThrow("429");
    expect(fetcher).toHaveBeenCalledTimes(1);
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
