#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  createPrivateKey,
  privateDecrypt,
  createDecipheriv,
  constants,
} from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const BLOB_PREFIX = "PODAJ1.";
const KEY_DIR =
  process.env.PODAJ_KEY_DIR || join(homedir(), ".local/share/podaj");

/** @typedef {{ wrappedKey: string; iv: string; ciphertext: string }} Podaj1Payload */

/**
 * @param {string} blob
 * @returns {Podaj1Payload}
 */
function parseBlob(blob) {
  if (!blob.startsWith(BLOB_PREFIX)) throw new Error("expected PODAJ1. blob");
  const json = Buffer.from(blob.slice(BLOB_PREFIX.length), "base64").toString(
    "utf8",
  );
  return /** @type {Podaj1Payload} */ (JSON.parse(json));
}

const arg = process.argv[2];
const blob =
  arg !== undefined && arg.startsWith(BLOB_PREFIX)
    ? arg
    : readFileSync(0, "utf8").trim();

const payload = parseBlob(blob);
const privateKey = createPrivateKey(
  readFileSync(join(KEY_DIR, "private.pem")),
);
const wrappedKey = Buffer.from(payload.wrappedKey, "base64");
const iv = Buffer.from(payload.iv, "base64");
const ciphertext = Buffer.from(payload.ciphertext, "base64");
const aesKey = privateDecrypt(
  {
    key: privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  },
  wrappedKey,
);
const decipher = createDecipheriv("aes-256-gcm", aesKey, iv, {
  authTagLength: 16,
});
const tag = ciphertext.subarray(ciphertext.length - 16);
const data = ciphertext.subarray(0, ciphertext.length - 16);
decipher.setAuthTag(tag);
const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString(
  "utf8",
);

process.stdout.write(`${plain}\n`);
