import { securityHeaders } from "../security.js";

export const jsonResponse = (
  body: unknown,
  status: number,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...securityHeaders(),
    },
  });
