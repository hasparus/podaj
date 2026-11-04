export const KV_PLACEHOLDER = "00000000000000000000000000000000";

/**
 * @param {string} text
 */
export const workersUrl = (text) => {
  const match = text.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/u);
  if (match === null) {
    throw new Error("deploy did not print a workers.dev url");
  }
  return match[0];
};

/**
 * @param {string} text
 */
export const kvNamespaceId = (text) => {
  const ids = [...text.matchAll(/\b[a-f0-9]{32}\b/gu)].map((match) => match[0]);
  const id = ids.find((value) => value !== KV_PLACEHOLDER);
  if (id === undefined) {
    throw new Error("wrangler did not return a KV namespace id");
  }
  return id;
};

/**
 * @param {string} source
 * @param {string} id
 */
export const bindNamespace = (source, id) => {
  if (!source.includes(KV_PLACEHOLDER)) {
    return source;
  }
  return source.replace(KV_PLACEHOLDER, id);
};

/**
 * @param {string} base
 * @param {string} id
 * @param {string} writeToken
 * @param {string} instanceToken
 */
export const composeUrl = (base, id, writeToken, instanceToken) => {
  const url = new URL(`/s/${id}`, base);
  const hash = new URLSearchParams();
  hash.set("write", writeToken);
  hash.set("token", instanceToken);
  url.hash = hash.toString();
  return url.toString();
};
