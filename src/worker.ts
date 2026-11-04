import {
  maxHandoffBytes,
  sameOrigin,
  securityHeaders,
} from "./security.js";

export type Env = {
  HANDOFFS: KVNamespace;
  ASSETS: Fetcher;
  MAX_HANDOFF_BYTES: string;
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...securityHeaders() },
  });

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const parseStoreBody = (
  raw: string,
): { sealed: string } | null => {
  try {
    const body = JSON.parse(raw) as { sealed?: unknown };
    if (typeof body.sealed !== "string" || !body.sealed.startsWith("PODAJ1.")) {
      return null;
    }
    return { sealed: body.sealed };
  } catch {
    return null;
  }
};

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!sameOrigin(request)) {
    return json({ error: "origin not allowed" }, 403);
  }

  if (url.pathname === "/api/handoffs" && request.method === "POST") {
    const limit = maxHandoffBytes(env.MAX_HANDOFF_BYTES);
    const cl = request.headers.get("Content-Length");
    if (cl !== null && Number.parseInt(cl, 10) > limit) {
      return json({ error: "payload too large" }, 413);
    }
    const raw = await request.text();
    if (raw.length > limit) return json({ error: "payload too large" }, 413);
    const body = parseStoreBody(raw);
    if (body === null) return json({ error: "invalid json" }, 400);
    const id = randomId();
    await env.HANDOFFS.put(id, body.sealed, { expirationTtl: 86400 });
    return json({ id, url: new URL(`/h/${id}`, request.url).toString() }, 201);
  }

  const match = url.pathname.match(/^\/api\/handoffs\/([a-f0-9]{32})$/u);
  if (match && request.method === "GET") {
    const id = match[1] ?? "";
    const sealed = await env.HANDOFFS.get(id);
    if (sealed === null) return json({ error: "gone" }, 410);
    await env.HANDOFFS.delete(id);
    return json({ sealed }, 200);
  }

  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(securityHeaders())) {
      headers.set(k, v);
    }
    return new Response(res.body, { status: res.status, headers });
  },
};
