import { recipientIdentity } from "./instance.js";

export const composeUrl = (base: string, id: string, writeToken: string, publicPem: string) => {
  const url = new URL(`/s/${id}`, base);
  url.hash = new URLSearchParams({
    write: writeToken,
    recipient: recipientIdentity(publicPem).encoded,
  }).toString();
  return url.toString();
};
