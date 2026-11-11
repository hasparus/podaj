import { generateKeyPairSync } from "node:crypto";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init, Message, update } from "../src/client/app.js";
import { parseAppRoute } from "../src/client/parse-route.js";
import { prepareCompose } from "../src/client/compose.js";
import { approveAdmission, requestIsWritable, waitForReservation, type Writer } from "../src/client/admission.js";
import { sealRequestContext } from "../src/crypto/request-context.js";

const id = "a".repeat(32);
const writeToken = "b".repeat(64);
const challenge = "c".repeat(64);
const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const request: Writer = { id, writeToken };
const requestedKeys = ["PASSWORD", "the other token"];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const link = (publicRequest = false) => sealRequestContext(id, {
  version: 1, recipientPublicKey: publicKey, writeToken, requestedKeys,
  ...(publicRequest ? { challenge } : {}),
});
const commandMessage = async (result: ReturnType<typeof init>) => {
  const command = result.commands?.[0];
  if (command === undefined) { throw new Error("missing command"); }
  return Effect.runPromise(command.effect);
};

describe("short encrypted links in the production app", () => {
  it("loads encrypted context before prefilling, without putting the fragment secret on the wire", async () => {
    const { key, encryptedContext } = await link();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (url === `/api/contexts/${id}`) { return Response.json({ id, encryptedContext, expiresAt: Date.now() + 60_000 }); }
      if (url === `/api/handoffs/${id}/writable`) { return Response.json({ authorized: true }); }
      if (url === "/api/config") { return Response.json({ maxHandoffBytes: 32768 }); }
      throw new Error("unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    const initial = init(parseAppRoute(`/s/${id}`, `#${key}`), "https://podaj.fyi");
    expect(Option.isNone(initial.model.sender)).toBe(true);
    expect(initial.model.status._tag).toBe("Hidden");
    expect(fetcher).not.toHaveBeenCalled();
    const loaded = update(initial.model, await commandMessage(initial));
    expect(loaded.model.hostedDemo).toBe(true);
    expect(loaded.model.rows.map(({ key: name, value, revealed }) => ({ name, value, revealed }))).toEqual([
      { name: "PASSWORD", value: "", revealed: false }, { name: "the other token", value: "", revealed: false },
    ]);
    expect(loaded.commands ?? []).toHaveLength(0);
    const ready = loaded.model;
    expect(Option.isSome(ready.sender)).toBe(true);
    expect(Object.keys(Option.getOrThrow(ready.sender)).sort()).toEqual(["fingerprint", "handoffId", "maxHandoffBytes", "publicKeyPem", "writeToken"]);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/config")).toHaveLength(1);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(key);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("PASSWORD");
    expect(fetcher.mock.calls.every(([, options]) => options?.method !== "POST" && options?.method !== "PUT")).toBe(true);
    expect(update(ready, Message.ClickedSend()).commands ?? []).toHaveLength(0);
  });

  it("takes an unapproved public link to verification automatically, keeping the URL short", async () => {
    const { key, encryptedContext } = await link(true);
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id, encryptedContext, expiresAt: Date.now() + 60_000 }))
      .mockResolvedValueOnce(Response.json({ status: "gone" }, { status: 410 })));
    const initial = init(parseAppRoute(`/s/${id}`, `#${key}`));
    expect((await commandMessage(initial))._tag).toBe("OpenedVerification");
    expect(replace).toHaveBeenCalledExactlyOnceWith(`/authorize/${id}#${key}`);
  });

  it("fails closed on context tampering before verification or recipient loading", async () => {
    const { key, encryptedContext } = await link(true);
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      id, encryptedContext: `${encryptedContext[0] === "A" ? "B" : "A"}${encryptedContext.slice(1)}`, expiresAt: Date.now() + 60_000,
    }));
    vi.stubGlobal("fetch", fetcher);
    const initial = init(parseAppRoute(`/s/${id}`, `#${key}`));
    const failed = update(initial.model, await commandMessage(initial));
    expect(failed.model.status._tag).toBe("Error");
    expect(Option.isNone(failed.model.sender)).toBe(true);
    expect(failed.commands ?? []).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows expired context and capacity errors without offering an empty form", async () => {
    const { key } = await link();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "gone" }, { status: 410 }));
    vi.stubGlobal("fetch", fetcher);
    const initial = init(parseAppRoute(`/s/${id}`, `#${key}`));
    expect(update(initial.model, await commandMessage(initial)).model.status).toMatchObject({ _tag: "Error", text: expect.stringContaining("expired") });
    fetcher.mockResolvedValueOnce(Response.json({ quota: { kind: "api_requests" } }, { status: 429 }));
    expect(update(initial.model, await commandMessage(initial)).model.status).toMatchObject({ _tag: "RateLimited" });
  });
});

describe("canonical bounded client HTTP responses", () => {
  const endpoints = ["writable", "approval", "configuration"] as const;
  const failure = "synthetic-secret-response";
  const call = async (endpoint: typeof endpoints[number]) => {
    if (endpoint === "writable") { return await requestIsWritable(request); }
    if (endpoint === "approval") { return await approveAdmission({ challenge, recipientPublicKey: publicKey }, "synthetic-proof"); }
    return await prepareCompose({ _tag: "Expanded", id, writeToken, recipientPublicKey: publicKey, requestedKeys: [] });
  };

  it.each(endpoints)("rejects malformed, oversized, and invalid UTF-8 success bodies safely for %s", async (endpoint) => {
    const invalidReplies = [
      () => new Response(`{"${failure}":`),
      () => new Response(new Uint8Array([255, 254])),
      () => new Response(failure.repeat(2000)),
      () => new Response("{}", { headers: { "Content-Length": "999999" } }),
      () => new Response("{}", { headers: { "Content-Length": "invalid" } }),
      () => new Response(null),
    ];
    for (const response of invalidReplies) {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(response()));
      const error = await call(endpoint).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(failure);
      expect(String(error)).not.toContain("JSON");
      expect(String(error)).not.toContain("SyntaxError");
    }
  });

  it.each(endpoints)("preserves sanitized HTTP status and quota details for %s", async (endpoint) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      error: failure, quota: { kind: "reservations_daily", limit: 137, periodSeconds: 86400 },
    }, { status: 429 })));
    await expect(call(endpoint)).rejects.toMatchObject({
      status: 429, message: expect.stringContaining("137"), ownerHelp: expect.stringContaining("reservationsPerDay"),
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(`{"${failure}":`, { status: 503 })));
    const error = await call(endpoint).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain(failure);
  });

  it.each(endpoints)("does not surface untrusted network rejection reasons for %s", async (endpoint) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(failure)));
    const error = await call(endpoint).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(failure);
  });

  it("validates approval and configuration shapes instead of exposing decoder diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ approved: failure, expiresAt: 1 })));
    await expect(call("approval")).rejects.toThrow("Verification failed");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ maxHandoffBytes: failure })));
    await expect(call("configuration")).rejects.toThrow("invalid limits");
  });
});

describe("sender-only reservation waiting", () => {
  it("waits across the CLI reservation race using only writer authority", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "gone" }, { status: 410 }))
      .mockResolvedValueOnce(Response.json({ authorized: true }));
    vi.stubGlobal("fetch", fetcher);
    expect(await waitForReservation(request, { intervalMs: 1 })).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url, options]) => url === `/api/handoffs/${id}/writable`
      && new Headers(options?.headers).get("Authorization") === `Bearer ${writeToken}`)).toBe(true);
  });

  it.each([401, 403, 409, 429, 503])("does not retry a definitive sender error %i", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(waitForReservation(request)).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed success instead of continuing", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ authorized: "true" })));
    await expect(requestIsWritable(request)).rejects.toThrow("Couldn't open");
  });

  it("bounds the wait when the requesting CLI never reserves", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "gone" }, { status: 410 })));
    await expect(waitForReservation(request, { timeoutMs: 10, intervalMs: 1 })).rejects.toThrow("keep the requesting CLI running");
  });

  it("aborts a hung sender preflight at the shared deadline", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) =>
      Effect.runPromise(Effect.never, { signal: options?.signal ?? undefined }));
    vi.stubGlobal("fetch", fetcher);
    await expect(waitForReservation(request, { timeoutMs: 10 })).rejects.toThrow("keep the requesting CLI running");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels in-flight writer requests when its owner stops watching", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => {
      fetchSignal = options?.signal;
      return Effect.runPromise(Effect.never, { signal: options?.signal ?? undefined });
    });
    vi.stubGlobal("fetch", fetcher);
    const waiting = waitForReservation(request, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(fetchSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

});
