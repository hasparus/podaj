import { recipientIdentity } from "./instance.js";

export const composeUrl = (base: string, id: string, writeToken: string, publicPem: string, requestedKeys: readonly string[] = []) => {
  const url = new URL(`/s/${id}`, base);
  const fragment = new URLSearchParams({
    write: writeToken,
    recipient: recipientIdentity(publicPem).encoded,
  });
  if (requestedKeys.length > 0) { fragment.set("keys", JSON.stringify(requestedKeys)); }
  url.hash = fragment.toString();
  return url.toString();
};
