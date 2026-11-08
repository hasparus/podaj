/** Plain copy for known API `error` fields (wire codes stay on the server). */
const API_ERROR_COPY: Record<string, string> = {
  gone: "This link was already used or expired.",
  "invalid json": "Couldn't send. Try again.",
  "origin not allowed": "Sending isn't allowed from this page.",
  "payload too large": "That's too large to send.",
  "not ready": "Nothing has been shared to this link yet.",
  "invalid write": "This fill link isn't valid.",
  "already shared": "This link was already filled.",
  locked: "This instance isn't configured for private requests. Ask its owner to finish setup.",
  unauthorized: "This fill link was refused. Ask for a new link from the CLI.",
  "rate limited": "This instance has reached its limit. Try again later.",
  "invalid recipient": "This link has an invalid recipient key. Ask for a new link.",
  "invalid recipient key": "This link has an invalid recipient key. Ask for a new link.",
};

export const HOW_IT_WORKS =
  "Names and values are encrypted here with the requesting CLI’s public key. Only its private key can open the bundle. The server stores ciphertext, not your variables.";

const CRYPTO_JARGON =
  /PODAJ1|podaj version|expected PODAJ1 ciphertext|unsupported podaj version/iu;

/** User-visible status: only swap wire/crypto wording; keep the rest of the message. */
export const userStatusText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "Something went wrong.";
  }
  if (CRYPTO_JARGON.test(trimmed)) {
    return "Couldn't encrypt this handoff.";
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
  if (status === 410) {return API_ERROR_COPY.gone;}
  if (status === 401 || status === 403) {return API_ERROR_COPY.unauthorized;}
  if (status === 429) {return "This instance has reached its limit. Try again later.";}
  if (status === 503) {return "This instance is unavailable or not fully configured. Try again later.";}
  return `Couldn't complete this request (${status}).`;
};

export const statusError = (text: string): { _tag: "Error"; text: string } => ({
  _tag: "Error",
  text: userStatusText(text),
});
