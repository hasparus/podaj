import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRequestContext, parseContextLink } from "../src/client/request-context.js";
import { HandoffApiError } from "../src/client/user-facing.js";
import { openRequestContext, sealRequestContext, type SenderContextV1 } from "../src/crypto/request-context.js";
import { REQUEST_CONTEXT_LIMITS } from "../src/handoffs/protocol.js";

const id = "a".repeat(32);
const otherId = "b".repeat(32);
const FAILURE = "Couldn't open this request. Ask for a new link.";
const labels = ["VARIABLE_NAME", "my.key", "token-value", "The token I use", "ключ 🔑", "a&b=#c?d", "<script>synthetic</script>"];
let context: SenderContextV1;
let sealed: { key: string; encryptedContext: string };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  const der = await crypto.subtle.exportKey("spki", pair.publicKey);
  context = {
    version: 1, recipientPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PUBLIC KEY-----`,
    writeToken: "c".repeat(64), requestedKeys: labels, challenge: "d".repeat(64),
  };
  sealed = await sealRequestContext(id, context);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const forged = (value: unknown): { key: string; encryptedContext: string } => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`podaj-request-context:v1:${id}`));
  const plaintext = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { key: key.toString("base64url"), encryptedContext: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url") };
};

const open = (input = sealed, requestId = id) => openRequestContext(requestId, input.key, input.encryptedContext);
const reply = (overrides: Record<string, unknown> = {}) => ({ id, encryptedContext: sealed.encryptedContext, expiresAt: Date.now() + 60_000, ...overrides });
const mockReply = (body: unknown, status = 200) => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};
const invalidContext = (value: unknown) => value as SenderContextV1;

const invalidContexts = (): [string, unknown][] => [
  ["null", null], ["array", []], ["string", "synthetic"],
  ["version", { ...context, version: 2 }], ["string version", { ...context, version: "1" }],
  ...["recipientPublicKey", "writeToken", "requestedKeys", "version"].map((name): [string, unknown] => [
    `missing ${name}`, Object.fromEntries(Object.entries(context).filter(([key]) => key !== name)),
  ]),
  ...["privateKey", "private", "readToken", "subscribeToken", "extra", "toJSON"].map((name): [string, unknown] => [name, { ...context, [name]: "synthetic-secret" }]),
  ["invalid recipient", { ...context, recipientPublicKey: "synthetic-private-key" }],
  ["invalid public DER", { ...context, recipientPublicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----" }],
  ["private PEM", { ...context, recipientPublicKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }],
  ["bad write token", { ...context, writeToken: "c".repeat(63) }],
  ["uppercase challenge", { ...context, challenge: "D".repeat(64) }],
  ["null challenge", { ...context, challenge: null }],
  ["non-array labels", { ...context, requestedKeys: "label" }],
  ...[[""], ["   "], [1], [null], ["valid", false]].map((requestedKeys): [string, unknown] => [`invalid labels ${JSON.stringify(requestedKeys)}`, { ...context, requestedKeys }]),
];

describe("encrypted request context", () => {
  it("round-trips using browser WebCrypto without changing arbitrary labels", async () => {
    expect(await open()).toEqual(context);
    expect(sealed.key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(sealed.encryptedContext).toMatch(/^[A-Za-z0-9_-]+$/u);
    const bytes = Buffer.from(sealed.encryptedContext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(sealed.key, "base64url"), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`podaj-request-context:v1:${id}`));
    decipher.setAuthTag(bytes.subarray(-16));
    expect(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"))).toEqual(context);
    expect(await open(forged(context))).toEqual(context);
  });

  it("creates independent fresh 256-bit keys and 96-bit nonces for every seal", async () => {
    const second = await sealRequestContext(id, context);
    expect(second.key).not.toBe(sealed.key);
    expect(Buffer.from(second.encryptedContext, "base64url").subarray(0, 12)).not.toEqual(Buffer.from(sealed.encryptedContext, "base64url").subarray(0, 12));
    expect(await open(second)).toEqual(context);
    await expect(open({ ...second, key: sealed.key })).rejects.toThrow(FAILURE);
  });

  it("normalizes duplicate labels by trimming and preserving first-seen order", async () => {
    const input = { ...context, requestedKeys: [" token ", "token", "名", " 名 ", "arbitrary sentence!"] };
    expect((await open(await sealRequestContext(id, input))).requestedKeys).toEqual(["token", "名", "arbitrary sentence!"]);
    expect((await open(forged(input))).requestedKeys).toEqual(["token", "名", "arbitrary sentence!"]);
    const { challenge: _challenge, ...withoutChallenge } = context;
    expect(await open(await sealRequestContext(id, { ...withoutChallenge, requestedKeys: [] }))).toEqual({ ...withoutChallenge, requestedKeys: [] });
  });

  it("rejects tampered nonce, ciphertext and tag, wrong keys, swapped IDs and truncation", async () => {
    for (const offset of [0, 12, Buffer.from(sealed.encryptedContext, "base64url").length - 1]) {
      const bytes = Buffer.from(sealed.encryptedContext, "base64url");
      bytes[offset] ^= 1;
      await expect(open({ ...sealed, encryptedContext: bytes.toString("base64url") })).rejects.toThrow(FAILURE);
    }
    await expect(open(sealed, otherId)).rejects.toThrow(FAILURE);
    await expect(open({ ...sealed, key: randomBytes(32).toString("base64url") })).rejects.toThrow(FAILURE);
    await expect(open({ ...sealed, encryptedContext: sealed.encryptedContext.slice(0, -4) })).rejects.toThrow(FAILURE);
  });

  it("rejects malformed and noncanonical base64url before cryptographic work", async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = sealed.key.at(-1) ?? "A";
    const noncanonical = sealed.key.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    for (const key of ["", "a".repeat(42), "a".repeat(44), `${sealed.key}=`, ` ${sealed.key}`, sealed.key.replace(/./u, "+"), noncanonical]) {
      await expect(open({ ...sealed, key })).rejects.toThrow(FAILURE);
    }
    for (const encryptedContext of ["", "a", "a===", "a+b/", `${sealed.encryptedContext}=`, Buffer.alloc(28).toString("base64url"), `${Buffer.alloc(29).toString("base64url").slice(0, -1)}B`, "A".repeat(REQUEST_CONTEXT_LIMITS.maxEncodedBytes + 1)]) {
      await expect(open({ ...sealed, encryptedContext })).rejects.toThrow(FAILURE);
    }
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("rejects invalid IDs in both directions", async () => {
    for (const requestId of ["", "A".repeat(32), "a".repeat(31), `${id}/extra`, `${id}\n`]) {
      await expect(open(sealed, requestId)).rejects.toThrow(FAILURE);
      await expect(sealRequestContext(requestId, context)).rejects.toThrow(FAILURE);
    }
  });

  it("rejects incomplete fields, unsupported versions and any collection/private authority in both directions", async () => {
    for (const [_name, value] of invalidContexts()) {
      await expect(sealRequestContext(id, invalidContext(value))).rejects.toThrow(FAILURE);
      await expect(open(forged(value))).rejects.toThrow(FAILURE);
    }
    await expect(sealRequestContext(id, { ...context, challenge: undefined })).rejects.toThrow(FAILURE);
    await expect(sealRequestContext(id, { ...context, [Symbol("secret")]: "synthetic-secret" })).rejects.toThrow(FAILURE);
  });

  it("rejects RSA sizes outside 2048–4096 and accepts 4096-bit recipients", async () => {
    for (const modulusLength of [1024, 4096, 4352]) {
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      const input = { ...context, recipientPublicKey: publicKey };
      if (modulusLength !== 4096) {
        await expect(sealRequestContext(id, input)).rejects.toThrow(FAILURE);
        await expect(open(forged(input))).rejects.toThrow(FAILURE);
      } else {
        const encrypted = await sealRequestContext(id, input);
        expect(await open(encrypted)).toEqual(input);
        expect(`/s/${id}#${encrypted.key}`.length).toBe(`/s/${id}#${sealed.key}`.length);
      }
    }
  }, 20_000);

  it("bounds encoded ciphertext exactly, including nonce/tag and UTF-8 labels", async () => {
    const empty = { ...context, requestedKeys: [""] };
    const overhead = Buffer.byteLength(JSON.stringify(empty));
    const maxPlaintext = Math.floor(REQUEST_CONTEXT_LIMITS.maxEncodedBytes * 3 / 4) - 28;
    const input = { ...context, requestedKeys: ["x".repeat(maxPlaintext - overhead)] };
    const full = await sealRequestContext(id, input);
    expect(full.encryptedContext.length).toBe(REQUEST_CONTEXT_LIMITS.maxEncodedBytes);
    expect(await open(full)).toEqual(input);
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");
    await expect(sealRequestContext(id, { ...input, requestedKeys: [`${input.requestedKeys[0]}x`] })).rejects.toThrow(FAILURE);
    await expect(sealRequestContext(id, { ...context, requestedKeys: ["名".repeat(REQUEST_CONTEXT_LIMITS.maxEncodedBytes / 2)] })).rejects.toThrow(FAILURE);
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("does not leak malformed decrypted JSON or invalid UTF-8 in errors", async () => {
    for (const plaintext of [Buffer.from('{"synthetic-secret":'), Buffer.from([255, 254])]) {
      await expect(open(forged(plaintext))).rejects.toThrow(FAILURE);
    }
  });
});

describe("short context links and browser loading", () => {
  it("accepts only exact sender/authorization routes and bare canonical key fragments", () => {
    for (const prefix of ["s", "authorize"]) {
      expect(parseContextLink(`/${prefix}/${id}`, `#${sealed.key}`)).toEqual({ id, key: sealed.key });
    }
    for (const pathname of ["/", `/s/${id}/`, `/s/${id}?q=1`, `/s/${id}/extra`, `/s/${id.toUpperCase()}`, `/h/${id}`, `/authorize/${id}/`]) {
      expect(parseContextLink(pathname, `#${sealed.key}`)).toBeNull();
    }
    for (const hash of ["", sealed.key, `#key=${sealed.key}`, `#${sealed.key}=`, `#${sealed.key}&x=1`, `#${sealed.key}\n`, `#${"A".repeat(42)}B`, `#${"A".repeat(44)}`]) {
      expect(parseContextLink(`/s/${id}`, hash)).toBeNull();
    }
  });

  it("does no network work until loading and requests only the ID, never key or plaintext", async () => {
    const fetchMock = mockReply(reply());
    const link = parseContextLink(`/s/${id}`, `#${sealed.key}`);
    expect(link).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await loadRequestContext(link!)).toEqual(context);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/contexts/${id}`);
    expect(options).toMatchObject({ method: "GET", cache: "no-store", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(options.headers).toBeUndefined();
    expect(options.body).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(sealed.key);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(sealed.encryptedContext);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(context.writeToken);
  });

  it("keeps link lengths constant regardless of recipient/key count", async () => {
    for (const requestedKeys of [[], labels, Array.from({ length: 1000 }, (_value, index) => `long label ${index}`)]) {
      const encrypted = await sealRequestContext(id, { ...context, requestedKeys });
      const url = new URL(`https://example.test/s/${id}#${encrypted.key}`);
      expect(url.href.length).toBe(`https://example.test/s/${id}#${sealed.key}`.length);
      expect(url.search).toBe("");
      expect(`${url.origin}${url.pathname}`).not.toContain(encrypted.key);
    }
  });

  it("rejects malformed links before making any request", async () => {
    const fetchMock = mockReply(reply());
    for (const link of [{ id: "../secrets", key: sealed.key }, { id, key: "invalid" }]) {
      await expect(loadRequestContext(link)).rejects.toThrow(FAILURE);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched/missing IDs, expired/nonfinite expiry and malformed or extra reply fields", async () => {
    for (const body of [null, [], {}, reply({ id: otherId }), reply({ id: 3 }), reply({ expiresAt: Date.now() - 1 }), reply({ expiresAt: "later" }), reply({ expiresAt: null }), reply({ encryptedContext: 1 }), reply({ encryptedContext: "A".repeat(REQUEST_CONTEXT_LIMITS.maxEncodedBytes + 1) }), reply({ encryptedContext: sealed.encryptedContext.slice(0, -4) }), reply({ readToken: "synthetic-secret" })]) {
      mockReply(body);
      await expect(loadRequestContext({ id, key: sealed.key })).rejects.toThrow(FAILURE);
    }
    for (const body of ['{"id":"synthetic-secret"', JSON.stringify(reply()).replace(/"expiresAt":\d+/u, '"expiresAt":1e999')]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      await expect(loadRequestContext({ id, key: sealed.key })).rejects.toThrow(FAILURE);
    }
  });

  it("bounds streamed replies, ignoring untrusted Content-Length", async () => {
    for (const headers of [new Headers(), new Headers({ "Content-Length": "999999999" })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(" ".repeat(REQUEST_CONTEXT_LIMITS.maxEncodedBytes + 1025), { headers })));
      await expect(loadRequestContext({ id, key: sealed.key })).rejects.toThrow(FAILURE);
    }
  });

  it("maps missing and expired context responses to plain language", async () => {
    for (const status of [404, 410]) {
      mockReply({ error: "not found" }, status);
      await expect(loadRequestContext({ id, key: sealed.key })).rejects.toThrow("This link was already used or expired. Ask for a new link.");
    }
  });

  it("uses shared sanitized HTTP errors without echoing keys or response content", async () => {
    for (const status of [401, 404, 410, 429, 500, 503]) {
      mockReply({ error: `${sealed.key} ${sealed.encryptedContext} synthetic-secret` }, status);
      try {
        await loadRequestContext({ id, key: sealed.key });
        expect.fail("expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(HandoffApiError);
        expect(String(error)).not.toContain(sealed.key);
        expect(String(error)).not.toContain(sealed.encryptedContext);
        expect(String(error)).not.toContain("synthetic-secret");
      }
    }
    for (const name of ["TypeError", "AbortError", "TimeoutError"]) {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException(`synthetic-secret ${sealed.key}`, name)));
      await expect(loadRequestContext({ id, key: sealed.key })).rejects.toThrow(FAILURE);
    }
  });
});
