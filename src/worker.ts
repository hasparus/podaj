import { Hono } from "hono";

type Env = {
  HANDOFFS: KVNamespace;
  ASSETS: Fetcher;
  MAX_HANDOFF_BYTES: string;
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const securityHeaders = (): Record<string, string> => ({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
});

const maxBytes = (env: Env): number => {
  const n = Number.parseInt(env.MAX_HANDOFF_BYTES, 10);
  if (!Number.isFinite(n) || n <= 0) return 32768;
  return n;
};

const sameOrigin = (req: Request): boolean => {
  const origin = req.headers.get("Origin");
  if (origin === null) return true;
  const url = new URL(req.url);
  return origin === url.origin;
};

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  if (!sameOrigin(c.req.raw)) {
    return c.json({ error: "origin not allowed" }, 403);
  }
  await next();
});

app.get("/api/environments", async (c) => {
  const res = await c.env.ASSETS.fetch(
    new URL("/environments.json", c.req.url),
  );
  if (!res.ok) return c.json({ error: "environments unavailable" }, 503);
  const body = await res.text();
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      ...securityHeaders(),
    },
  });
});

app.post("/api/handoffs", async (c) => {
  const limit = maxBytes(c.env);
  const cl = c.req.header("Content-Length");
  if (cl !== undefined && Number.parseInt(cl, 10) > limit) {
    return c.json({ error: "payload too large" }, 413);
  }
  const raw = await c.req.text();
  if (raw.length > limit) {
    return c.json({ error: "payload too large" }, 413);
  }
  let body: { sealed?: string };
  try {
    body = JSON.parse(raw) as { sealed?: string };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const sealed = body.sealed;
  if (typeof sealed !== "string" || !sealed.startsWith("PODAJ1.")) {
    return c.json({ error: "sealed must be PODAJ1 ciphertext" }, 400);
  }
  const id = randomId();
  await c.env.HANDOFFS.put(id, sealed, { expirationTtl: 86400 });
  const url = new URL(`/h/${id}`, c.req.url);
  return c.json({ id, url: url.toString() }, 201, securityHeaders());
});

app.get("/api/handoffs/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f0-9]{32}$/.test(id)) {
    return c.json({ error: "invalid id" }, 400);
  }
  const sealed = await c.env.HANDOFFS.get(id);
  if (sealed === null) {
    return c.json({ error: "gone" }, 410);
  }
  await c.env.HANDOFFS.delete(id);
  return c.json({ sealed }, 200, securityHeaders());
});

app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(securityHeaders())) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
});

export default app;
