import { Effect } from "effect";
import { accessFor } from "./access.js";
import type { Env } from "./env.js";
import { handleHandoffsApi, handoffMode, handoffService } from "./handoffs/handler.js";
import { jsonResponse } from "./handoffs/http.js";
import { HandoffsApiError } from "./handoffs/errors.js";
import { enforcePublicRateLimit } from "./handoffs/policy.js";
import { securityHeaders, sameOrigin } from "./security.js";

export type { Env } from "./env.js";
export { HandoffParty } from "./handoffs/party.js";

const secured = (response: Response, authorize = false): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders(authorize))) headers.set(name, value);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const websocket = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET" || !/^\/parties\/handoff-party\/[a-f0-9]{32}$/u.test(new URL(request.url).pathname)) {
    return jsonResponse({ error: "not found" }, 404);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "origin not allowed" }, 403);
  try {
    if (handoffMode(env) === "demo") await enforcePublicRateLimit(request, env);
    const response = await handoffService(env).fetch(request);
    return response.status === 101 ? response : secured(response);
  } catch (error) {
    if (error instanceof HandoffsApiError) return jsonResponse({ error: error.code }, error.status);
    return jsonResponse({ error: "service unavailable" }, 503);
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (accessFor(request, env.PODAJ_API_AUTH_SECRET) === "closed") {
      return jsonResponse({ error: "not found" }, 404);
    }
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return Effect.runPromise(handleHandoffsApi(request, env));
    if (url.pathname === "/parties" || url.pathname.startsWith("/parties/")) return websocket(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") return jsonResponse({ error: "not found" }, 404);

    const authorize = ["/authorize", "/authorize/", "/authorize.html"].includes(url.pathname);
    const document = url.pathname === "/" || /^\/s\/[a-f0-9]{32}$/u.test(url.pathname);
    if (authorize || document) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = authorize ? "/authorize" : "/";
      return secured(await env.ASSETS.fetch(new Request(assetUrl, request)), authorize);
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "text/html") {
      return jsonResponse({ error: "not found" }, 404);
    }
    return secured(asset);
  },
};
