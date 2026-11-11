import { CAPABILITY, HANDOFF_ID, REQUEST_CONTEXT_LIMITS } from "../handoffs/protocol.js";
import { validateRecipientPublicKey } from "./podaj1.js";

export interface SenderContextV1 {
  version: 1;
  recipientPublicKey: string;
  writeToken: string;
  requestedKeys: readonly string[];
  challenge?: string;
}

const FAILURE = "Couldn't open this request. Ask for a new link.";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const encoder = new TextEncoder();

const encode = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join("")).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/[=]+$/u, "");
};

const decode = (value: unknown, maxLength: number): Uint8Array<ArrayBuffer> => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(FAILURE);
  }
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
  if (encode(bytes) !== value) { throw new Error(FAILURE); }
  return bytes;
};

/** Copy only the sender-facing fields, trimming and deduplicating labels in first-seen order. */
const contextRecord = (value: unknown): Record<string, unknown> => {
  const required = ["version", "recipientPublicKey", "writeToken", "requestedKeys"];
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...required, "challenge"].includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(FAILURE);
  }
  return value as Record<string, unknown>;
};

const parseContext = (input: unknown): SenderContextV1 => {
  const value = contextRecord(input);
  if (value.version !== 1 || typeof value.recipientPublicKey !== "string"
    || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/u.test(value.recipientPublicKey)
    || typeof value.writeToken !== "string" || !CAPABILITY.test(value.writeToken)
    || !Array.isArray(value.requestedKeys)) {
    throw new Error(FAILURE);
  }
  const requestedKeys = new Set<string>();
  for (const key of value.requestedKeys) {
    if (typeof key !== "string" || key.trim().length === 0) { throw new Error(FAILURE); }
    requestedKeys.add(key.trim());
  }
  const result: SenderContextV1 = {
    version: 1, recipientPublicKey: value.recipientPublicKey,
    writeToken: value.writeToken, requestedKeys: [...requestedKeys],
  };
  if (Object.hasOwn(value, "challenge")) {
    if (!("challenge" in value) || typeof value.challenge !== "string" || !CAPABILITY.test(value.challenge)) {
      throw new Error(FAILURE);
    }
    result.challenge = value.challenge;
  }
  return result;
};

const associatedData = (id: string): Uint8Array<ArrayBuffer> => {
  if (typeof id !== "string" || !HANDOFF_ID.test(id)) { throw new Error(FAILURE); }
  return encoder.encode(`podaj-request-context:v1:${id}`);
};

export const sealRequestContext = async (id: string, context: SenderContextV1): Promise<{ key: string; encryptedContext: string }> => {
  try {
    const additionalData = associatedData(id);
    const validated = parseContext(context);
    const plaintext = encoder.encode(JSON.stringify(validated));
    if (Math.ceil((plaintext.length + NONCE_BYTES + TAG_BYTES) * 4 / 3) > REQUEST_CONTEXT_LIMITS.maxEncodedBytes) {
      throw new Error(FAILURE);
    }
    await validateRecipientPublicKey(validated.recipientPublicKey);
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 }, key, plaintext);
    const sealed = new Uint8Array(NONCE_BYTES + ciphertext.byteLength);
    sealed.set(nonce);
    sealed.set(new Uint8Array(ciphertext), NONCE_BYTES);
    return { key: encode(rawKey), encryptedContext: encode(sealed) };
  } catch {
    throw new Error(FAILURE);
  }
};

export const openRequestContext = async (id: string, key: string, encryptedContext: string): Promise<SenderContextV1> => {
  try {
    const additionalData = associatedData(id);
    const rawKey = decode(key, 43);
    if (rawKey.length !== 32) { throw new Error(FAILURE); }
    const sealed = decode(encryptedContext, REQUEST_CONTEXT_LIMITS.maxEncodedBytes);
    if (sealed.length < NONCE_BYTES + TAG_BYTES + 1) { throw new Error(FAILURE); }
    const aesKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: sealed.subarray(0, NONCE_BYTES), additionalData, tagLength: 128,
    }, aesKey, sealed.subarray(NONCE_BYTES));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    const context = parseContext(parsed);
    await validateRecipientPublicKey(context.recipientPublicKey);
    return context;
  } catch {
    throw new Error(FAILURE);
  }
};
