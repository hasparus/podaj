import {
  constants,
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
} from "node:crypto";

const BLOB_PREFIX = "PODAJ1.";

/**
 * @param {string} blob
 * @param {string} privatePem
 */
export const openPodaj1 = (blob, privatePem) => {
  if (!blob.startsWith(BLOB_PREFIX)) {
    throw new Error("expected PODAJ1. blob");
  }
  const payload = JSON.parse(
    Buffer.from(blob.slice(BLOB_PREFIX.length), "base64").toString("utf8"),
  );
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.wrappedKey !== "string" ||
    typeof payload.iv !== "string" ||
    typeof payload.ciphertext !== "string"
  ) {
    throw new Error("expected PODAJ1. blob");
  }
  const privateKey = createPrivateKey(privatePem);
  const aesKey = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(payload.wrappedKey, "base64"),
  );
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    aesKey,
    Buffer.from(payload.iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  return plain.toString("utf8");
};
