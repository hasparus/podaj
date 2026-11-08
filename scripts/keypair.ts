import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

const exportPem = (label: string, der: ArrayBuffer) => {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

const keyExists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const keyFiles = (dir: string) =>
  Promise.all([keyExists(joinPublic(dir)), keyExists(joinPrivate(dir))]);

const pemDer = (pem: string, label: string) => {
  const header = `-----BEGIN ${label}-----`;
  const footer = `-----END ${label}-----`;
  const trimmed = pem.trim();
  if (!trimmed.startsWith(header) || !trimmed.endsWith(footer)) {
    throw new Error(`expected ${label} PEM`);
  }
  const body = trimmed.slice(header.length, -footer.length).replace(/\s/gu, "");
  const der = Buffer.from(body, "base64");
  if (der.length === 0 || der.toString("base64") !== body) {
    throw new Error("invalid PEM encoding");
  }
  return Uint8Array.from(der).buffer;
};

/** Validate both keys and prove RSA-OAEP SHA-256 decryption without rewriting them. */
export const validateKeypair = async (dir: string) => {
  const [hasPublic, hasPrivate] = await keyFiles(dir);
  if (!hasPublic || !hasPrivate) {
    throw new Error(`both public.pem and private.pem are required in ${dir}`);
  }
  const [publicPem, privatePem] = await Promise.all([
    readFile(joinPublic(dir), "utf8"),
    readFile(joinPrivate(dir), "utf8"),
  ]);
  try {
    const algorithm = { name: "RSA-OAEP", hash: "SHA-256" };
    const [publicKey, privateKey] = await Promise.all([
      subtle.importKey("spki", pemDer(publicPem, "PUBLIC KEY"), algorithm, false, ["encrypt"]),
      subtle.importKey("pkcs8", pemDer(privatePem, "PRIVATE KEY"), algorithm, false, ["decrypt"]),
    ]);
    const plain = webcrypto.getRandomValues(new Uint8Array(32));
    const encrypted = await subtle.encrypt("RSA-OAEP", publicKey, plain);
    const decrypted = await subtle.decrypt("RSA-OAEP", privateKey, encrypted);
    if (!Buffer.from(decrypted).equals(plain)) {
      throw new Error("RSA-OAEP SHA-256 decryption failed");
    }
  } catch {
    throw new Error(`invalid or mismatched recipient keypair in ${dir}`);
  }
  return dir;
};

export const ensureKeypair = async (dir: string) => {
  const [hasPublic, hasPrivate] = await keyFiles(dir);
  return hasPublic || hasPrivate ? validateKeypair(dir) : generateKeypair(dir);
};

export const generateKeypair = async (dir: string) => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const [hasPublic, hasPrivate] = await keyFiles(dir);
  if (hasPublic || hasPrivate) {
    throw new Error(`refusing to replace existing recipient key files in ${dir}`);
  }
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
  await writeFile(joinPrivate(dir), exportPem("PRIVATE KEY", pkcs8), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(joinPublic(dir), exportPem("PUBLIC KEY", spki), {
    flag: "wx",
    mode: 0o644,
  });
  return dir;
};

export const joinPublic = (dir: string) => `${dir}/public.pem`;

export const joinPrivate = (dir: string) => `${dir}/private.pem`;
