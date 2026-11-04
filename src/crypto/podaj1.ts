export type EnvVar = { key: string; value: string };

export type HandoffVariables = { vars: EnvVar[] };

const PREFIX = "PODAJ1.";

type Podaj1Envelope = {
  v: 1;
  env: string;
  iv: string;
  ciphertext: string;
  wrappedKey: string;
};

const b64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

const b64dec = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
};

const pemBody = (pem: string, label: string): Uint8Array =>
  b64dec(
    pem
      .replace(`-----BEGIN ${label}-----`, "")
      .replace(`-----END ${label}-----`, "")
      .replace(/\s/g, ""),
  );

export const publicKeyFingerprint = async (pem: string): Promise<string> => {
  const spki = owned(pemBody(pem, "PUBLIC KEY")).buffer;
  const hash = await crypto.subtle.digest("SHA-256", spki);
  const hex = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
};

export async function seal(
  payload: HandoffVariables,
  publicKeyPem: string,
  env: string,
): Promise<string> {
  const pubKey = await crypto.subtle.importKey(
    "spki",
    owned(pemBody(publicKeyPem, "PUBLIC KEY")).buffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    plaintext,
  );
  const rawAes = await crypto.subtle.exportKey("raw", aesKey);
  const ekBuf = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    pubKey,
    rawAes,
  );
  const envelope: Podaj1Envelope = {
    v: 1,
    env,
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ctBuf)),
    wrappedKey: b64(new Uint8Array(ekBuf)),
  };
  return PREFIX + btoa(JSON.stringify(envelope));
}

export async function open(
  sealed: string,
  privateKeyPem: string,
): Promise<{ env: string; payload: HandoffVariables }> {
  if (!sealed.startsWith(PREFIX)) {
    throw new Error("expected PODAJ1 ciphertext");
  }
  const envelope = JSON.parse(atob(sealed.slice(PREFIX.length))) as Podaj1Envelope;
  if (envelope.v !== 1) throw new Error("unsupported podaj version");
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    owned(pemBody(privateKeyPem, "PRIVATE KEY")).buffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const rawAes = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    priv,
    owned(b64dec(envelope.wrappedKey)),
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAes,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: owned(b64dec(envelope.iv)) },
    aesKey,
    owned(b64dec(envelope.ciphertext)),
  );
  const payload = JSON.parse(
    new TextDecoder().decode(plainBuf),
  ) as HandoffVariables;
  return { env: envelope.env, payload };
}
