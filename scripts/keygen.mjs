import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

const dir = join(homedir(), ".local", "share", "podaj");

const exportPem = (label, der) => {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

const pair = await subtle.generateKey(
  {
    name: "RSA-OAEP",
    modulusLength: 4096,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["encrypt", "decrypt"],
);

const spki = await subtle.exportKey("spki", pair.publicKey);
const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);

await mkdir(dir, { recursive: true, mode: 0o700 });

const publicPem = exportPem("PUBLIC KEY", spki);
const privatePem = exportPem("PRIVATE KEY", pkcs8);

await writeFile(join(dir, "public.pem"), publicPem, { mode: 0o644 });
await writeFile(join(dir, "private.pem"), privatePem, { mode: 0o600 });

process.stdout.write(`${dir}\n`);
