export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export const AUTHORIZE_CSP =
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export const securityHeaders = (authorize = false): Record<string, string> => ({
  "Content-Security-Policy": authorize ? AUTHORIZE_CSP : CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
});

export const maxHandoffBytes = (
  raw: string | undefined,
  fallback = 32768,
): number => {
  if (raw === undefined) return fallback;
  if (/[^0-9]/u.test(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 1_048_576) return fallback;
  return n;
};

export const handoffTtlSeconds = (raw: string | undefined): number => {
  const fallback = 7200;
  if (raw === undefined || /[^0-9]/u.test(raw)) return fallback;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) {
    return fallback;
  }
  return seconds;
};

export const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  return origin === new URL(request.url).origin;
};
