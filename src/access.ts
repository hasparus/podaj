const CLOSED_HOST = "podaj.hasparus.workers.dev";

export type Access = "closed" | "locked" | "ok" | "unauthorized";

const localHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "::1";

const bearerOk = (request: Request, expected: string): boolean => {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return false;
  }
  const got = header.slice("Bearer ".length);
  return got === expected;
};

/** Local dev is open. Every other host needs PODAJ_TOKEN. The upstream URL is closed. */
export const accessFor = (
  request: Request,
  token: string | undefined,
): Access => {
  const url = new URL(request.url);
  if (url.hostname === CLOSED_HOST) {
    return "closed";
  }
  if (token === undefined || token.length === 0) {
    return localHost(url.hostname) ? "ok" : "locked";
  }
  return bearerOk(request, token) ? "ok" : "unauthorized";
};
