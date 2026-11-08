import {
  constants,
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
} from "node:crypto";

import { parsePodaj1Envelope } from "../src/crypto/envelope.js";

export const openPodaj1 = (blob: string, privatePem: string) => {
  const envelope = parsePodaj1Envelope(blob);
  const privateKey = createPrivateKey(privatePem);
  const aesKey = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    envelope.wrappedKey,
  );
  const { ciphertext } = envelope;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    aesKey,
    envelope.iv,
    { authTagLength: 16 },
  );
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  return plain.toString("utf8");
};
