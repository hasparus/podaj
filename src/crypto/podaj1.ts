import { encodePodaj1Envelope } from "./envelope.js";

export type EnvVar = { key: string; value: string };

export type HandoffVariables = { vars: EnvVar[] };

const b64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

const b64dec = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
};

const pemBody = (pem: string, label: string): Uint8Array =>
  b64dec(
    pem
      .replace(`-----BEGIN ${label}-----`, "")
      .replace(`-----END ${label}-----`, "")
      .replace(/\s/g, ""),
  );

export const publicKeyFingerprint = async (pem: string): Promise<string> => {
  const spki = owned(pemBody(pem, "PUBLIC KEY")).buffer;
  const hash = await crypto.subtle.digest("SHA-256", spki);
  const hex = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
};

export const publicKeyToFragment = (pem: string): string =>
  b64(pemBody(pem, "PUBLIC KEY"))
    .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/[=]+$/u, "");

export const publicKeyFromFragment = (fragment: string): string => {
  if (!/^[A-Za-z0-9_-]{300,1600}$/u.test(fragment) || fragment.length % 4 === 1) {
    throw new Error("Invalid recipient key in link.");
  }
  const base64 = fragment.replace(/-/gu, "+").replace(/_/gu, "/");
  const bytes = b64dec(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64(bytes)}\n-----END PUBLIC KEY-----`;
  if (publicKeyToFragment(pem) !== fragment) throw new Error("Invalid recipient key in link.");
  return pem;
};

export const validateRecipientPublicKey = async (pem: string): Promise<void> => {
  const key = await crypto.subtle.importKey(
    "spki", owned(pemBody(pem, "PUBLIC KEY")).buffer,
    { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
  const algorithm = key.algorithm;
  if (!("modulusLength" in algorithm) || typeof algorithm.modulusLength !== "number"
    || algorithm.modulusLength < 2048 || algorithm.modulusLength > 4096) {
    throw new Error("Choose an RSA key between 2048 and 4096 bits.");
  }
};

export async function seal(
  payload: HandoffVariables,
  publicKeyPem: string,
): Promise<string> {
  const pubKey = await crypto.subtle.importKey(
    "spki",
    owned(pemBody(publicKeyPem, "PUBLIC KEY")).buffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    plaintext,
  );
  const rawAes = await crypto.subtle.exportKey("raw", aesKey);
  const ekBuf = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    pubKey,
    rawAes,
  );
  return encodePodaj1Envelope({
    iv,
    ciphertext: new Uint8Array(ctBuf),
    wrappedKey: new Uint8Array(ekBuf),
  });
}
