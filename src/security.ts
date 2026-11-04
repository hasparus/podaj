export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export const securityHeaders = (): Record<string, string> => ({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
});

export const maxHandoffBytes = (
  raw: string | undefined,
  fallback = 32768,
): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
};

export const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  return origin === new URL(request.url).origin;
};
