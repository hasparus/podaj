import { parsePodaj1Envelope } from "../crypto/envelope.js";
import { HandoffsApiError } from "./errors.js";
import { CAPABILITY } from "./protocol.js";

export const randomCapability = (): string =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const digest = async (value: string | Uint8Array<ArrayBuffer>): Promise<string> => {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const bearerCapability = (request: Request): string => {
  const header = request.headers.get("Authorization");
  const token = header !== null && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!CAPABILITY.test(token)) {
    throw new HandoffsApiError({ status: 401, code: "unauthorized" });
  }
  return token;
};

const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) {
    throw new Error("invalid base64");
  }
  const decoded = atob(text);
  if (btoa(decoded) !== text) throw new Error("invalid base64");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

export const recipientFingerprint = async (pem: string): Promise<string> => {
  try {
    const trimmed = pem.trim();
    const header = "-----BEGIN PUBLIC KEY-----";
    const footer = "-----END PUBLIC KEY-----";
    if (!trimmed.startsWith(header) || !trimmed.endsWith(footer)) throw new Error("not SPKI");
    const encoded = trimmed.slice(header.length, -footer.length).replace(/\s/gu, "");
    const bytes = decodeBase64(encoded);
    if (bytes.byteLength > 1024) throw new Error("key too large");
    const key = await crypto.subtle.importKey(
      "spki", bytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
    );
    const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
    if (algorithm.modulusLength < 2048 || algorithm.modulusLength > 4096) throw new Error("unsupported key size");
    return await digest(bytes);
  } catch {
    throw new HandoffsApiError({ status: 400, code: "invalid recipient key" });
  }
};

export const validSealedEnvelope = (sealed: string): boolean => {
  try {
    parsePodaj1Envelope(sealed);
    return true;
  } catch {
    return false;
  }
};
