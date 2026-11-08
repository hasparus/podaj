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
    if (!sealed.startsWith("PODAJ1.")) return false;
    const bytes = decodeBase64(sealed.slice(7));
    const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return false;
    if (Object.keys(envelope).toSorted().join(",") !== "ciphertext,env,iv,v,wrappedKey") return false;
    if (!("v" in envelope) || envelope.v !== 1 || !("env" in envelope) || envelope.env !== "default") return false;
    if (!("iv" in envelope) || typeof envelope.iv !== "string" || decodeBase64(envelope.iv).length !== 12) return false;
    if (!("wrappedKey" in envelope) || typeof envelope.wrappedKey !== "string") return false;
    const wrappedLength = decodeBase64(envelope.wrappedKey).length;
    if (wrappedLength < 256 || wrappedLength > 512) return false;
    if (!("ciphertext" in envelope) || typeof envelope.ciphertext !== "string") return false;
    return decodeBase64(envelope.ciphertext).length >= 16;
  } catch {
    return false;
  }
};
