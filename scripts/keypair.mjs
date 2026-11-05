import { mkdir, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

/**
 * @param {string} label
 * @param {ArrayBuffer} der
 */
const exportPem = (label, der) => {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

/**
 * @param {string} dir
 */
export const generateKeypair = async (dir) => {
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
  await writeFile(joinPublic(dir), exportPem("PUBLIC KEY", spki), {
    mode: 0o644,
  });
  await writeFile(joinPrivate(dir), exportPem("PRIVATE KEY", pkcs8), {
    mode: 0o600,
  });
  return dir;
};

/**
 * @param {string} dir
 */
export const joinPublic = (dir) => `${dir}/public.pem`;

/**
 * @param {string} dir
 */
export const joinPrivate = (dir) => `${dir}/private.pem`;
