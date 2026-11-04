import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";

import { open, seal } from "../src/crypto/podaj1.js";

const subtle = webcrypto.subtle;

const generatePair = async () => {
  const pair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
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
  it("roundtrips environment variables", async () => {
    const { publicPem, privatePem } = await generatePair();
    const payload = {
      vars: [
        { key: "OPENAI_API_KEY", value: "sk-test" },
        { key: "DATABASE_URL", value: "postgres://local/dev" },
      ],
    };
    const sealed = await seal(payload, publicPem, "production");
    expect(sealed.startsWith("PODAJ1.")).toBe(true);
    const opened = await open(sealed, privatePem);
    expect(opened.env).toBe("production");
    expect(opened.payload).toEqual(payload);
  });
});
