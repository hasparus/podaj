import { recipientIdentity } from "./instance.js";

export const workersUrl = (text: string) => {
  const match = text.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/u);
  if (match === null) throw new Error("deploy did not print a workers.dev url");
  return match[0];
};

export const composeUrl = (base: string, id: string, writeToken: string, publicPem: string) => {
  const url = new URL(`/s/${id}`, base);
  url.hash = new URLSearchParams({
    write: writeToken,
    recipient: recipientIdentity(publicPem).encoded,
  }).toString();
  return url.toString();
};
