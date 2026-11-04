const API_ERRORS: Record<string, string> = {
  gone: "This link was already used or expired.",
  "invalid json": "Couldn't send. Try again.",
  "origin not allowed": "Sending isn't allowed from this page.",
  "payload too large": "That's too large to send.",
};

export const userError = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return "Something went wrong.";
  }
  const msg = error.message.trim();
  if (API_ERRORS[msg]) {
    return API_ERRORS[msg];
  }
  if (msg.includes("PODAJ1") || msg.includes("podaj version")) {
    return "That key file didn't open this handoff.";
  }
  if (msg === "could not load recipient.pem") {
    return "This site isn't set up yet.";
  }
  if (msg === "recipient.pem needs a public key") {
    return "No recipient key is configured yet.";
  }
  if (msg.startsWith("Fetch failed") || msg.startsWith("store failed")) {
    return "Couldn't reach the server. Try again.";
  }
  if (msg === "Decrypt failed" || msg === "Failed") {
    return "Something went wrong.";
  }
  return msg;
};

export const HOW_IT_WORKS =
  "Values are locked in the browser with the recipient's public key before upload. Each link works once. The server keeps only the sealed bundle and never sees plaintext or your private key.";
