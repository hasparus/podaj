import { generateKeyPairSync, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { openPodaj1 } from "../scripts/open-podaj1.js";
import { encodePodaj1Envelope, parsePodaj1Envelope } from "../src/crypto/envelope.js";
import { seal } from "../src/crypto/podaj1.js";
import { validSealedEnvelope } from "../src/handoffs/capabilities.js";

const base64 = (length: number) => Buffer.alloc(length).toString("base64");
const fields = { v: 1, env: "default", iv: base64(12), wrappedKey: base64(256), ciphertext: base64(16) };
const blob = (value: unknown) => `PODAJ1.${Buffer.from(JSON.stringify(value)).toString("base64")}`;
const changed = (overrides: Record<string, unknown>) => blob({ ...fields, ...overrides });
const without = (name: string) => blob(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== name)));
const valid = blob(fields);
const paddedJson = `${JSON.stringify(fields)}${" ".repeat((3 - JSON.stringify(fields).length % 3) % 3 + 1)}`;
const padded = Buffer.from(paddedJson).toString("base64");
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const noncanonical = padded.replace(/([A-Za-z0-9+/])(?==+$)/u, (character) => alphabet[alphabet.indexOf(character) + 1]);

const malformed: [string, string][] = [
  ["missing prefix", valid.slice(7)],
  ["wrong prefix", valid.replace("PODAJ1.", "PODAJ2.")],
  ["lowercase prefix", valid.replace("PODAJ1.", "podaj1.")],
  ["leading whitespace", ` ${valid}`],
  ["trailing whitespace", `${valid}\n`],
  ["empty outer base64", "PODAJ1."],
  ["invalid outer base64", "PODAJ1.%%%="],
  ["unpadded outer base64", `PODAJ1.${padded.replace(/=+$/u, "")}`],
  ["noncanonical outer padding bits", `PODAJ1.${noncanonical}`],
  ["non-JSON content", `PODAJ1.${Buffer.from("not JSON").toString("base64")}`],
  ["invalid UTF-8", `PODAJ1.${Buffer.from([255]).toString("base64")}`],
  ...[null, [], "text", 1].map((value): [string, string] => [`non-object ${JSON.stringify(value)}`, blob(value)]),
  ["extra field", changed({ extra: true })],
  ...Object.keys(fields).map((name): [string, string] => [`missing ${name}`, without(name)]),
  ["unsupported version", changed({ v: 2 })],
  ["string version", changed({ v: "1" })],
  ["unsupported environment", changed({ env: "production" })],
  ["null environment", changed({ env: null })],
  ...(["iv", "wrappedKey", "ciphertext"] as const).flatMap((name): [string, string][] => [
    [`non-string ${name}`, changed({ [name]: 12 })],
    [`empty ${name}`, changed({ [name]: "" })],
    [`whitespace in ${name}`, changed({ [name]: ` ${fields[name]}` })],
    [`invalid base64 ${name}`, changed({ [name]: "%%%=" })],
  ]),
  ["short IV", changed({ iv: base64(11) })],
  ["long IV", changed({ iv: base64(13) })],
  ["short wrapped key", changed({ wrappedKey: base64(255) })],
  ["long wrapped key", changed({ wrappedKey: base64(513) })],
  ["short ciphertext", changed({ ciphertext: base64(15) })],
  ["unpadded wrapped key", changed({ wrappedKey: base64(256).replace(/=+$/u, "") })],
  ["noncanonical wrapped key padding bits", changed({ wrappedKey: `${base64(256).slice(0, -3)}B==` })],
  ["noncanonical ciphertext padding bits", changed({ ciphertext: `${base64(16).slice(0, -3)}B==` })],
  ["base64url ciphertext", changed({ ciphertext: Buffer.alloc(16, 255).toString("base64url") })],
];

let privatePem: string;
let sealed: string;

beforeAll(async () => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privatePem = pair.privateKey;
  sealed = await seal({ vars: [{ key: "EXAMPLE", value: "synthetic" }] }, pair.publicKey);
});

describe("shared strict PODAJ1 envelope", () => {
  it.each(malformed)("rejects %s in both the server and CLI", (_name, value) => {
    expect(() => parsePodaj1Envelope(value)).toThrow();
    expect(validSealedEnvelope(value)).toBe(false);
    expect(() => openPodaj1(value, privatePem)).toThrow();
  });

  it.each([256, 384, 512])("encodes and parses a %i-byte wrapped key", (length) => {
    const envelope = { iv: new Uint8Array(12), wrappedKey: new Uint8Array(length), ciphertext: new Uint8Array(16) };
    const encoded = encodePodaj1Envelope(envelope);
    expect(parsePodaj1Envelope(encoded)).toEqual(envelope);
    expect(validSealedEnvelope(encoded)).toBe(true);
  });

  it.each([
    ["iv", 11], ["iv", 13], ["wrappedKey", 255], ["wrappedKey", 513], ["ciphertext", 15],
  ] as const)("refuses to encode invalid %s length %i", (name, length) => {
    const envelope = { iv: new Uint8Array(12), wrappedKey: new Uint8Array(256), ciphertext: new Uint8Array(16) };
    envelope[name] = new Uint8Array(length);
    expect(() => encodePodaj1Envelope(envelope)).toThrow();
  });

  it("handles large ciphertext without spreading it into one function call", () => {
    const envelope = { iv: new Uint8Array(12), wrappedKey: new Uint8Array(256), ciphertext: new Uint8Array(randomBytes(500_000)) };
    const { ciphertext, ...header } = parsePodaj1Envelope(encodePodaj1Envelope(envelope));
    expect(header).toEqual({ iv: envelope.iv, wrappedKey: envelope.wrappedKey });
    expect(Buffer.from(ciphertext).equals(envelope.ciphertext)).toBe(true);
  });

  it.each([["v", 2], ["v", null], ["env", "production"], ["env", null]] as const)("rejects mutated %s even with otherwise valid ciphertext", (name, value) => {
    const json = Buffer.from(sealed.slice(7), "base64").toString("utf8");
    const mutated = `PODAJ1.${Buffer.from(json.replace(name === "v" ? '"v":1' : '"env":"default"', `"${name}":${JSON.stringify(value)}`)).toString("base64")}`;
    expect(() => parsePodaj1Envelope(mutated)).toThrow();
    expect(validSealedEnvelope(mutated)).toBe(false);
    expect(() => openPodaj1(mutated, privatePem)).toThrow();
  });

  it.each(["iv", "wrappedKey", "ciphertext"] as const)("rejects authenticated decryption after tampering with %s", (name) => {
    const envelope = parsePodaj1Envelope(sealed);
    envelope[name][0] ^= 1;
    const mutated = encodePodaj1Envelope(envelope);
    expect(validSealedEnvelope(mutated)).toBe(true);
    expect(() => openPodaj1(mutated, privatePem)).toThrow();
  });
});
