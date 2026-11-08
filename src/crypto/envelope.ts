const PREFIX = "PODAJ1.";

/** Decoded ciphertext only; the wire version and environment are fixed. */
export interface Podaj1Envelope {
  iv: Uint8Array<ArrayBuffer>;
  wrappedKey: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

const encodeBase64 = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return btoa(chunks.join(""));
};

const decodeBase64 = (value: unknown): Uint8Array<ArrayBuffer> => {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error("invalid PODAJ1 base64");
  }
  const decoded = atob(value);
  if (btoa(decoded) !== value) throw new Error("invalid PODAJ1 base64");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const validateLengths = (envelope: Podaj1Envelope): Podaj1Envelope => {
  if (envelope.iv.length !== 12 || envelope.wrappedKey.length < 256 || envelope.wrappedKey.length > 512 || envelope.ciphertext.length < 16) {
    throw new Error("invalid PODAJ1 ciphertext lengths");
  }
  return envelope;
};

export const encodePodaj1Envelope = (envelope: Podaj1Envelope): string => {
  validateLengths(envelope);
  return PREFIX + btoa(JSON.stringify({
    v: 1,
    env: "default",
    iv: encodeBase64(envelope.iv),
    ciphertext: encodeBase64(envelope.ciphertext),
    wrappedKey: encodeBase64(envelope.wrappedKey),
  }));
};

export const parsePodaj1Envelope = (sealed: string): Podaj1Envelope => {
  if (!sealed.startsWith(PREFIX)) throw new Error("expected PODAJ1 ciphertext");
  const bytes = decodeBase64(sealed.slice(PREFIX.length));
  const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)
    || Object.keys(envelope).toSorted().join(",") !== "ciphertext,env,iv,v,wrappedKey"
    || !("v" in envelope) || envelope.v !== 1 || !("env" in envelope) || envelope.env !== "default"
    || !("iv" in envelope) || !("wrappedKey" in envelope) || !("ciphertext" in envelope)) {
    throw new Error("invalid PODAJ1 envelope");
  }
  return validateLengths({
    iv: decodeBase64(envelope.iv),
    wrappedKey: decodeBase64(envelope.wrappedKey),
    ciphertext: decodeBase64(envelope.ciphertext),
  });
};
