import type { ClientConfig } from "../src/handoffs/protocol.js";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandoffRequest, waitForPublicApproval } from "../scripts/handoff-request.js";
import { recipientIdentity } from "../scripts/instance.js";
import { openRequestContext } from "../src/crypto/request-context.js";

const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const { fingerprint, encoded } = recipientIdentity(pair.publicKey);
const origin = "http://localhost:8787";
const owner = "synthetic-owner-token";
const config = (access: ClientConfig["access"]): ClientConfig => ({
  access, handoffTtlSeconds: 7200, maxHandoffBytes: 32768,
});
const options = (access: ClientConfig["access"], onLink = vi.fn()) => ({
  origin, token: owner, config: config(access), recipientPublicKey: pair.publicKey,
  requestedKeys: ["API_KEY", "service token"], onLink,
});
const approval = () => ({ status: "approved", expiresAt: Date.now() + 60_000, recipientFingerprint: fingerprint });
const stagedReply = (init: RequestInit) => Response.json({
  id: (JSON.parse(String(init.body)) as { id: string }).id, expiresAt: Date.now() + 180_000,
}, { status: 201 });
const reservation = (init: RequestInit) => ({
  ...(JSON.parse(String(init.body)) as { id: string; writeToken: string }),
  readToken: "c".repeat(64), subscribeToken: "d".repeat(64),
  expiresAt: Date.now() + 7200_000, recipientFingerprint: fingerprint,
});
const withStage = (status: (url: URL, init: RequestInit) => Promise<Response>) =>
  vi.fn(async (url: URL, init: RequestInit) => url.pathname === "/api/contexts" ? stagedReply(init) : status(url, init));
afterEach(() => vi.unstubAllGlobals());

describe("handoff request creation", () => {
  it.each(["private", "public"] as const)("uses one sender and encrypted stage for %s access, emitting one link at the right time", async (access) => {
    const events: string[] = [];
    const onLink = vi.fn((link: string) => { events.push("link"); expect(link).toMatch(/^http:\/\/localhost:8787\/s\//u); });
    let staged: { id: string; writeHash: string; encryptedContext: string } | undefined;
    let verifier = "";
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const authorization = new Headers(init.headers).get("Authorization");
      if (url.pathname === "/api/contexts") {
        events.push("stage");
        expect(onLink).not.toHaveBeenCalled();
        expect(init.method).toBe("POST");
        expect(authorization).toBe(access === "private" ? `Bearer ${owner}` : null);
        staged = JSON.parse(String(init.body)) as typeof staged;
        expect(Object.keys(staged!)).toEqual(["id", "writeHash", "encryptedContext"]);
        expect(staged!.id).toMatch(/^[a-f0-9]{32}$/u);
        return stagedReply(init);
      }
      if (url.pathname === "/api/demo/status") {
        events.push("approval");
        expect(onLink).toHaveBeenCalledTimes(1);
        verifier = authorization!.slice(7);
        expect(verifier).toMatch(/^[a-f0-9]{64}$/u);
        expect(verifier).not.toBe(owner);
        return Response.json(approval());
      }
      expect(url.pathname).toBe("/api/handoffs/reserve");
      events.push("reserve");
      expect(onLink).toHaveBeenCalledTimes(access === "public" ? 1 : 0);
      expect(init.method).toBe("POST");
      expect(authorization).toBe(`Bearer ${access === "public" ? verifier : owner}`);
      expect(Object.keys(JSON.parse(String(init.body)) as object)).toEqual(["recipientPublicKey", "id", "writeToken"]);
      return Response.json(reservation(init), { status: 201 });
    });
    vi.stubGlobal("fetch", fetcher);
    const reserved = await createHandoffRequest(options(access, onLink));
    expect(events).toEqual(access === "public" ? ["stage", "link", "approval", "reserve"] : ["stage", "reserve", "link"]);
    expect(onLink).toHaveBeenCalledTimes(1);
    const link = new URL(onLink.mock.calls[0]![0]);
    expect(link.pathname).toBe(`/s/${reserved.id}`);
    expect(link.search).toBe("");
    expect(link.hash.slice(1)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(link.href.length).toBeLessThan(110);
    const context = await openRequestContext(reserved.id, link.hash.slice(1), staged!.encryptedContext);
    expect(context).toEqual({
      version: 1, recipientPublicKey: pair.publicKey, writeToken: reserved.writeToken,
      requestedKeys: ["API_KEY", "service token"],
      ...(access === "public" ? { challenge: createHash("sha256").update(verifier).digest("hex") } : {}),
    });
    expect(staged!.id).toBe(reserved.id);
    expect(staged!.writeHash).toBe(createHash("sha256").update(reserved.writeToken).digest("hex"));
    expect(reserved.recipientFingerprint).toBe(fingerprint);
    for (const secret of [owner, verifier, reserved.writeToken, reserved.readToken, reserved.subscribeToken, pair.privateKey, pair.publicKey, encoded, "API_KEY", "service token"].filter(Boolean)) {
      expect(link.href).not.toContain(secret);
    }
    for (const secret of [owner, verifier, reserved.readToken, reserved.subscribeToken, pair.privateKey].filter(Boolean)) {
      expect(JSON.stringify(context)).not.toContain(secret);
    }
    const stageBody = String(fetcher.mock.calls[0]![1].body);
    for (const secret of [link.hash.slice(1), owner, verifier, reserved.writeToken, pair.publicKey, "service token"].filter(Boolean)) {
      expect(stageBody).not.toContain(secret);
    }
    for (const [url, init] of fetcher.mock.calls) expect(`${url}${String(init.body)}`).not.toContain(link.hash.slice(1));
    expect(fetcher).toHaveBeenCalledTimes(access === "public" ? 3 : 2);
  });

  it.each(["private", "public"] as const)("rejects invalid staging metadata before showing a %s URL or proceeding", async (access) => {
    for (const fields of [{ id: "wrong", expiresAt: Date.now() + 60_000 }, { expiresAt: "future" }, { expiresAt: 0 }, { expiresAt: 1 }, { expiresAt: Infinity }]) {
      const fetcher = vi.fn(async (_url: URL, init: RequestInit) => Response.json({
        id: (JSON.parse(String(init.body)) as { id: string }).id, ...fields,
      }, { status: 201 }));
      vi.stubGlobal("fetch", fetcher);
      const request = options(access);
      await expect(createHandoffRequest(request)).rejects.toThrow("invalid id or expiry");
      expect(request.onLink).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("requires the staging-created response status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 200 })));
    const request = options("public");
    await expect(createHandoffRequest(request)).rejects.toThrow("request context staging failed (200)");
    expect(request.onLink).not.toHaveBeenCalled();
  });

  it.each(["private", "public"] as const)("rejects invalid reservation bodies for %s access without emitting a second URL", async (access) => {
    const mutations = [
      { id: "a".repeat(32) }, { writeToken: "b".repeat(64) }, { id: "invalid" },
      { readToken: "invalid" }, { subscribeToken: "invalid" }, { readToken: "d".repeat(64) },
      { recipientFingerprint: `${fingerprint.slice(0, 12)}${"0".repeat(52)}` },
      { expiresAt: 0 }, { expiresAt: "future" }, { expiresAt: Infinity },
    ];
    for (const mutation of mutations) {
      const fetcher = withStage(async (url, init) => url.pathname === "/api/demo/status"
        ? Response.json(approval()) : Response.json({ ...reservation(init), ...mutation }));
      vi.stubGlobal("fetch", fetcher);
      const request = options(access);
      await expect(createHandoffRequest(request)).rejects.toThrow(/reserve returned/u);
      expect(request.onLink).toHaveBeenCalledTimes(access === "public" ? 1 : 0);
    }
  });

  it.each(["readToken", "subscribeToken"] as const)("rejects %s overlapping the generated write capability", async (capability) => {
    vi.stubGlobal("fetch", withStage(async (_url, init) => {
      const body = reservation(init);
      return Response.json({ ...body, [capability]: body.writeToken });
    }));
    const request = options("private");
    await expect(createHandoffRequest(request)).rejects.toThrow("unexpected body or recipient fingerprint");
    expect(request.onLink).not.toHaveBeenCalled();
  });

  it.each(["private", "public"] as const)("reports reserve quotas and preserves %s link timing on failure", async (access) => {
    vi.stubGlobal("fetch", withStage(async (url) => url.pathname === "/api/demo/status" ? Response.json(approval())
      : Response.json({ quota: { kind: "live_handoffs", limit: 29 } }, { status: 429 })));
    const request = options(access);
    await expect(createHandoffRequest(request)).rejects.toThrow("reserve failed (429): Active handoff limit reached (29)");
    expect(request.onLink).toHaveBeenCalledTimes(access === "public" ? 1 : 0);
  });
});

describe("proof-bound public approval", () => {
  it("rejects a different key even if its short fingerprint prefix matches", async () => {
    vi.stubGlobal("fetch", withStage(async () => Response.json({
      ...approval(), recipientFingerprint: `${fingerprint.slice(0, 12)}${"0".repeat(52)}`,
    })));
    await expect(createHandoffRequest(options("public"))).rejects.toThrow("fingerprint");
  });

  it.each([undefined, "future", 0, -1, 1, Date.now() - 1])("rejects invalid or expired approval expiry %s", async (expiresAt) => {
    vi.stubGlobal("fetch", withStage(async () => Response.json({ ...approval(), expiresAt })));
    await expect(createHandoffRequest(options("public"))).rejects.toThrow("invalid authorization expiry");
  });

  it("bounds pending polling attempts without allocating handoffs", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "pending" }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(waitForPublicApproval({ origin, verifier: "e".repeat(64), fingerprint, attempts: 100, intervalMs: 0 })).rejects.toThrow("timed out");
    expect(fetcher).toHaveBeenCalledTimes(60);
  });

  it("honors a shorter attempt budget", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "pending" }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(waitForPublicApproval({ origin, verifier: "e".repeat(64), fingerprint, attempts: 2, intervalMs: 0 })).rejects.toThrow("timed out");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung status request at the shared deadline", async () => {
    const fetcher = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    await expect(waitForPublicApproval({ origin, verifier: "e".repeat(64), fingerprint, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds the interval wait with the same deadline", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "pending" }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(waitForPublicApproval({ origin, verifier: "e".repeat(64), fingerprint, timeoutMs: 10, intervalMs: 60_000 })).rejects.toThrow("timed out");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on status errors without reserving and reports authorization quotas", async () => {
    const response = Response.json({ error: "synthetic-secret", quota: { kind: "approvals_daily", limit: 41, resetAt: Date.UTC(2030, 0, 2) } }, { status: 429 });
    const json = vi.spyOn(response, "json");
    const fetcher = withStage(async () => response);
    vi.stubGlobal("fetch", fetcher);
    const request = options("public");
    const failure = await createHandoffRequest(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("authorization failed (429)");
    expect((failure as Error).message).toContain("Daily CLI approval limit reached (41)");
    expect((failure as Error).message).toContain("00:00 UTC");
    expect((failure as Error).message).toContain("DEMO_LIMITS.approvalsPerDay");
    expect((failure as Error).message).not.toContain("synthetic-secret");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(json).toHaveBeenCalledTimes(1);
    expect(request.onLink).toHaveBeenCalledTimes(1);
  });

  it("reports authorization quotas even when the error body is not a record", async () => {
    const response = new Response("synthetic-secret", { status: 429 });
    const json = vi.spyOn(response, "json");
    vi.stubGlobal("fetch", withStage(async () => response));
    await expect(createHandoffRequest(options("public"))).rejects.toThrow("authorization failed (429): Request limit reached.");
    expect(json).toHaveBeenCalledTimes(1);
  });

  it.each([200, 202])("preserves malformed-success validation for HTTP %s", async (status) => {
    vi.stubGlobal("fetch", withStage(async () => Response.json(null, { status })));
    await expect(createHandoffRequest(options("public"))).rejects.toThrow("unexpected JSON response");
  });
});
