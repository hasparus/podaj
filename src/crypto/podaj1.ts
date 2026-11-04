const PREFIX = "PODAJ1.";

export type HandoffPayload = {
  profile: string;
  loginUrl: string;
  username: string;
  password: string;
};

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

export const pemToSpki = (pem: string): ArrayBuffer => {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  return owned(b64dec(body)).buffer;
};

export const pemToPkcs8 = (pem: string): ArrayBuffer => {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  return owned(b64dec(body)).buffer;
};

export const importPublicKey = (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "spki",
    pemToSpki(pem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );

export const importPrivateKey = (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );

export const publicKeyFingerprint = async (pem: string): Promise<string> => {
  const spki = pemToSpki(pem);
  const hash = await crypto.subtle.digest("SHA-256", spki);
  const hex = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
};

export async function seal(
  payload: HandoffPayload,
  publicKeyPem: string,
  env: string,
): Promise<string> {
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
  const pubKey = await importPublicKey(publicKeyPem);
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
): Promise<{ env: string; payload: HandoffPayload }> {
  if (!sealed.startsWith(PREFIX)) {
    throw new Error("expected PODAJ1 ciphertext");
  }
  const envelope = JSON.parse(atob(sealed.slice(PREFIX.length))) as Podaj1Envelope;
  if (envelope.v !== 1) throw new Error("unsupported podaj version");
  const priv = await importPrivateKey(privateKeyPem);
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
  const iv = owned(b64dec(envelope.iv));
  const ct = owned(b64dec(envelope.ciphertext));
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ct,
  );
  const payload = JSON.parse(new TextDecoder().decode(plainBuf)) as HandoffPayload;
  return { env: envelope.env, payload };
}

export const isPodaj1 = (s: string): boolean => s.startsWith(PREFIX);
