export const PENDING_PREFIX = "PENDING:";

export const isPendingValue = (value: string): boolean =>
  value.startsWith(PENDING_PREFIX);

export const isSealedValue = (value: string): boolean =>
  value.startsWith("PODAJ1.");

export const pendingValue = (writeTokenHash: string): string =>
  `${PENDING_PREFIX}${writeTokenHash}`;

export const hashWriteToken = async (writeToken: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(writeToken),
  );
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

export const verifyPendingWriteToken = async (
  stored: string,
  writeToken: string,
): Promise<boolean> => {
  if (!isPendingValue(stored)) {
    return false;
  }
  const expected = stored.slice(PENDING_PREFIX.length);
  const actual = await hashWriteToken(writeToken);
  if (expected.length !== actual.length) {
    return false;
  }
  if (expected === actual) {
    return true;
  }
  return false;
};

export const randomWriteToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};
