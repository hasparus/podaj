import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";

import { openPodaj1 } from "../scripts/open-podaj1.js";
import { publicKeyFingerprint, publicKeyFromFragment, publicKeyToFragment, seal, validateRecipientPublicKey } from "../src/crypto/podaj1.js";

const subtle = webcrypto.subtle;

const generatePair = async (modulusLength = 2048) => {
  const pair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = await subtle.exportKey("spki", pair.publicKey);
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  const toPem = (label: string, der: ArrayBuffer) => {
    const b64 = Buffer.from(der).toString("base64");
    const lines = b64.match(/.{1,64}/g) ?? [];
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
  };
  return {
    publicPem: toPem("PUBLIC KEY", spki),
    privatePem: toPem("PRIVATE KEY", pkcs8),
  };
};

describe("PODAJ1", () => {
  it.each([2048, 3072, 4096])("roundtrips browser ciphertext through the CLI with %i-bit RSA", async (bits) => {
    const { publicPem, privatePem } = await generatePair(bits);
    const payload = {
      vars: [
        { key: "OPENAI_API_KEY", value: "sk-test" },
        { key: "DATABASE_URL", value: "postgres://local/dev" },
        { key: "UNICODE", value: "zażółć 日本語\n\"quoted\"\u0000" },
      ],
    };
    const sealed = await seal(payload, publicPem);
    expect(sealed.startsWith("PODAJ1.")).toBe(true);
    expect(openPodaj1(sealed, privatePem)).toBe(JSON.stringify(payload));
  }, 15_000);

  it("encodes and fingerprints CLI-supplied public keys", async () => {
    const { publicPem: publicKeyPem } = await generatePair();
    await validateRecipientPublicKey(publicKeyPem);
    const fragment = publicKeyToFragment(publicKeyPem);
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(publicKeyToFragment(publicKeyFromFragment(fragment))).toBe(fragment);
    const hash = await crypto.subtle.digest("SHA-256", Buffer.from(fragment, "base64url"));
    expect(await publicKeyFingerprint(publicKeyPem)).toBe(Buffer.from(hash).toString("hex"));
  });

  it.each(["", "%%%", "a".repeat(393), "a".repeat(400) + "=="])("rejects malformed recipient fragments (%s)", (fragment) => {
    expect(() => publicKeyFromFragment(fragment)).toThrow();
  });
});
