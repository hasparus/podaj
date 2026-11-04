import { randomBytes } from "node:crypto";

/**
 * @param {string} raw
 */
export const originOf = (raw) => {
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`not an http url: ${raw}`);
  }
  return url.origin;
};

/**
 * @typedef {"ok" | "unauthorized" | "locked" | "unreachable"} Probe
 */

/**
 * @param {number} status
 * @returns {Probe}
 */
export const tokenVerdict = (status) => {
  if (status === 200 || status === 410) {
    return "ok";
  }
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 503) {
    return "locked";
  }
  return "unreachable";
};

export const probePath = () =>
  `/api/handoffs/${randomBytes(16).toString("hex")}/status`;

/**
 * @param {string} origin
 * @param {string} token
 * @returns {Promise<Probe>}
 */
export const probeInstance = async (origin, token) => {
  const response = await fetch(new URL(probePath(), origin), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return tokenVerdict(response.status);
};
