import { readFileSync } from "node:fs";

export const tokenFromText = (raw: string): string | undefined => {
  const text = raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
  if (text.length === 0) {
    return undefined;
  }
  if (text.includes("\n")) {
    throw new Error("PODAJ_API_AUTH_SECRET on stdin must be a single line");
  }
  return text;
};

export const readStdinToken = (force = false) => {
  if (!force && process.stdin.isTTY === true) {
    return undefined;
  }
  return tokenFromText(readFileSync(0, "utf8"));
};
