/** Plain copy for known API `error` fields (wire codes stay on the server). */
const API_ERROR_COPY: Record<string, string> = {
  gone: "This link was already used or expired.",
  "invalid json": "Couldn't send. Try again.",
  "origin not allowed": "Sending isn't allowed from this page.",
  "payload too large": "That's too large to send.",
};

export const HOW_IT_WORKS =
  "Values are locked in the browser with the recipient's public key before upload. Each link works once. The server keeps only the sealed bundle and never sees plaintext or your private key.";

const CRYPTO_JARGON =
  /PODAJ1|podaj version|expected PODAJ1 ciphertext|unsupported podaj version/iu;

/** User-visible status: only swap wire/crypto wording; keep the rest of the message. */
export const userStatusText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "Something went wrong.";
  }
  if (CRYPTO_JARGON.test(trimmed)) {
    return "That key file didn't open this handoff.";
  }
  return trimmed;
};

export const causeMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
};

export const apiHandoffErrorText = (
  errorCode: string | undefined,
  status: number,
): string => {
  const code = errorCode?.trim() ?? "";
  if (code.length > 0 && API_ERROR_COPY[code]) {
    return API_ERROR_COPY[code];
  }
  if (code.length > 0) {
    return `Couldn't send (${status}): ${code}.`;
  }
  return `Couldn't send (${status}).`;
};

export const statusError = (text: string): { _tag: "Error"; text: string } => ({
  _tag: "Error",
  text: userStatusText(text),
});
