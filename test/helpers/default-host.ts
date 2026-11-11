import { appendFileSync } from "node:fs";

const log = process.env.PODAJ_TEST_DEFAULT_HOST_LOG;
if (log === undefined) throw new Error("missing isolated default host log");

/** Observe the real CLI's default origin without contacting the hosted service. */
globalThis.fetch = (input, options) => {
  const url = input instanceof Request ? input.url : String(input);
  appendFileSync(log, `${JSON.stringify({ url, authenticated: new Headers(options?.headers).has("Authorization") })}\n`);
  if (url === "https://podaj.fyi/api/config") {
    return Promise.resolve(Response.json({ access: "public", handoffTtlSeconds: 7200, maxHandoffBytes: 32768, turnstileSiteKey: "synthetic-site-key" }));
  }
  if (url === "https://podaj.fyi/api/contexts") {
    const body = JSON.parse(String(options?.body)) as { id: string; encryptedContext: string };
    return Promise.resolve(Response.json({ id: body.id, encryptedContext: body.encryptedContext, expiresAt: Date.now() + 180_000 }, { status: 201 }));
  }
  if (url === "https://podaj.fyi/api/demo/status") {
    return Promise.resolve(Response.json({ error: "synthetic authorization stop" }, { status: 503 }));
  }
  throw new Error(`unexpected default-host request: ${url}`);
};
