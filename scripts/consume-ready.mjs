#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createPrivateKey, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const BLOB_PREFIX = "PODAJ1.";
const KEY_DIR = process.env.PODAJ_KEY_DIR || join(homedir(), ".local/share/podaj");
const AGENT_BROWSER = process.env.AGENT_BROWSER || "agent-browser";

function parseBlob(blob) {
  if (!blob.startsWith(BLOB_PREFIX)) throw new Error("expected PODAJ1. blob");
  const json = Buffer.from(blob.slice(BLOB_PREFIX.length), "base64").toString("utf8");
  return JSON.parse(json);
}

const raw = readFileSync(0, "utf8");
const session = JSON.parse(raw);
const blob = session.ciphertext;
if (typeof blob !== "string") {
  console.error("missing ciphertext");
  process.exit(1);
}

const payload = parseBlob(blob);
const privateKey = createPrivateKey(readFileSync(join(KEY_DIR, "private.pem")));
const wrappedKey = Buffer.from(payload.wrappedKey, "base64");
const iv = Buffer.from(payload.iv, "base64");
const ciphertext = Buffer.from(payload.ciphertext, "base64");
const aesKey = privateDecrypt(
  { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
  wrappedKey
);
const decipher = createDecipheriv("aes-256-gcm", aesKey, iv, { authTagLength: 16 });
const tag = ciphertext.subarray(ciphertext.length - 16);
const data = ciphertext.subarray(0, ciphertext.length - 16);
decipher.setAuthTag(tag);
const password = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");

const name = session.name || session.defaults?.name || session.environment?.name || "default";
const url = session.url || session.defaults?.url || "";
const username = session.username || session.defaults?.username || "";

await new Promise((resolve, reject) => {
  const child = spawn(
    AGENT_BROWSER,
    ["auth", "save", name, "--url", url, "--username", username, "--password-stdin"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    err += d;
  });
  child.on("close", (code) => {
    if (code === 0) {
      console.log(JSON.stringify({ ok: true, name, username, url }));
      resolve();
    } else reject(new Error((err || out || `exit ${code}`).slice(0, 400)));
  });
  child.stdin.write(password);
  child.stdin.end();
});
