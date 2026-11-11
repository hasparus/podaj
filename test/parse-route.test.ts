import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseAppRoute } from "../src/client/parse-route.js";
import { parseRequestedKeys } from "../src/client/requested-keys.js";
import { composeUrl } from "../scripts/deploy-text.js";
import { publicKeyFromFragment, publicKeyToFragment } from "../src/crypto/podaj1.js";

const id = "a".repeat(32);
const write = "b".repeat(64);
const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const recipient = publicKeyToFragment(publicKey);

describe("CLI fill links", () => {
  it("accepts only write authority and the CLI public key", () => {
    expect(parseAppRoute(`/s/${id}`, `#write=${write}&recipient=${recipient}`)).toEqual({
      page: "compose", source: { _tag: "Expanded", id, writeToken: write,
        recipientPublicKey: publicKeyFromFragment(recipient), requestedKeys: [] },
    });
  });

  it("round-trips arbitrary editable labels in the fragment only", () => {
    const labels = ["PASSWORD", "MY.KEY", "service-token", "the token I use", "ключ 🔑", '<script>alert("x")</script>', "a&b=#c?d"];
    const url = new URL(composeUrl("https://example.test", id, write, publicKey, labels));
    expect(url.search).toBe("");
    expect(`${url.origin}${url.pathname}`).toBe(`https://example.test/s/${id}`);
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.getAll("keys")).toEqual([JSON.stringify(labels)]);
    expect(parseAppRoute(url.pathname, url.hash)).toEqual({
      page: "compose", source: { _tag: "Expanded", id, writeToken: write,
        recipientPublicKey: publicKeyFromFragment(recipient), requestedKeys: labels },
    });
  });

  it("keeps old generated links unchanged when no labels are requested", () => {
    const expected = `https://example.test/s/${id}#${new URLSearchParams({ write, recipient }).toString()}`;
    expect(composeUrl("https://example.test", id, write, publicKey)).toBe(expected);
    expect(composeUrl("https://example.test", id, write, publicKey, [])).toBe(expected);
  });

  it("trims and deduplicates labels in first-seen order", () => {
    const params = new URLSearchParams({ keys: JSON.stringify([" PASSWORD ", "my label", "PASSWORD", "my label ", "名"]) });
    expect(parseRequestedKeys(params)).toEqual(["PASSWORD", "my label", "名"]);
    expect(parseRequestedKeys(new URLSearchParams())).toEqual([]);
    expect(parseRequestedKeys(new URLSearchParams({ keys: "[]" }))).toEqual([]);
  });

  it.each(["", "[", "null", "{}", '"PASSWORD"', "123", "[123]", "[null]", "[{}]", '["PASSWORD",false]', '[""]', '["   "]'])("rejects malformed requested labels: %s", (keys) => {
    const params = new URLSearchParams({ write, recipient, keys });
    expect(() => parseRequestedKeys(params)).toThrow(Error);
    expect(parseAppRoute(`/s/${id}`, `#${params.toString()}`)).toMatchObject({
      page: "compose", source: { _tag: "Invalid", id },
    });
  });

  it("rejects multiple keys fragment parameters rather than picking one", () => {
    const params = new URLSearchParams({ write, recipient, keys: '["PASSWORD"]' });
    params.append("keys", '["OTHER"]');
    expect(() => parseRequestedKeys(params)).toThrow(Error);
    expect(parseAppRoute(`/s/${id}`, `#${params.toString()}`)).toMatchObject({
      source: { _tag: "Invalid", id },
    });
  });

  it.each([
    "", `#${write}`, `#write=${write}`, `#recipient=${recipient}`,
    `#write=${write}&recipient=${recipient}&token=owner-secret`,
    `#write=${write}&write=${write}&recipient=${recipient}`,
    `#write=${write}&recipient=${recipient}&read=${"c".repeat(64)}`,
  ])("rejects incomplete links and unrelated authority: %s", (hash) => {
    const route = parseAppRoute(`/s/${id}`, hash);
    expect(route.page).toBe("compose");
    if (route.page !== "compose") throw new Error("missing compose route");
    expect(route.source).toEqual({ _tag: "Invalid", id });
  });

  it.each(["/", `/h/${id}`, "/s/not-an-id", "/unknown"])("does not offer browser collection or recipient creation at %s", (path) => {
    expect(parseAppRoute(path, "")).toEqual({ page: "landing" });
  });
});
