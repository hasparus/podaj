import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseAppRoute } from "../src/client/parse-route.js";
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
      page: "compose", handoffId: id, writeToken: write,
      publicKeyPem: publicKeyFromFragment(recipient),
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
    expect(route.writeToken === null || route.publicKeyPem === null).toBe(true);
  });

  it.each(["/", `/h/${id}`, "/s/not-an-id", "/unknown"])("does not offer browser collection or recipient creation at %s", (path) => {
    expect(parseAppRoute(path, "")).toEqual({ page: "landing" });
  });
});
