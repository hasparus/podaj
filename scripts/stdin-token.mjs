import { readFileSync } from "node:fs";

/**
 * @param {string} raw
 * @returns {string | undefined}
 */
export const tokenFromText = (raw) => {
  const text = raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
  if (text.length === 0) {
    return undefined;
  }
  if (text.includes("\n")) {
    throw new Error("PODAJ_TOKEN on stdin must be a single line");
  }
  return text;
};

/**
 * @param {boolean} [force]
 * @returns {string | undefined}
 */
export const readStdinToken = (force = false) => {
  if (!force && process.stdin.isTTY === true) {
    return undefined;
  }
  return tokenFromText(readFileSync(0, "utf8"));
};
