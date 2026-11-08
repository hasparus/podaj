import { HandoffsApiError } from "./errors.js";
import type { HandoffAccess } from "./protocol.js";

export const handoffAccess = (config: { PODAJ_ACCESS?: string }): HandoffAccess => {
  const { PODAJ_ACCESS: access = "private" } = config;
  if (access !== "private" && access !== "public") {
    throw new HandoffsApiError({ status: 503, code: "invalid access" });
  }
  return access;
};
