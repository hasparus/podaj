const API_ERRORS: Record<string, string> = {
  "origin not allowed": "Sending isn't allowed from this page.",
  "payload too large": "That's too large to send.",
  "invalid json": "Couldn't send. Try again.",
  gone: "This link was already used or expired.",
};

export const userError = (e: unknown): string => {
  if (!(e instanceof Error)) return "Something went wrong.";
  const msg = e.message.trim();
  if (API_ERRORS[msg]) return API_ERRORS[msg];
  if (msg.includes("PODAJ1") || msg.includes("podaj version")) {
    return "That key file didn't open this handoff.";
  }
  if (msg === "could not load environments.json") {
    return "This site isn't set up yet.";
  }
  if (msg === "environments.json needs a default public key") {
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
