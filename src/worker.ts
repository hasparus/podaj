import { Effect } from "effect";
import { routePartykitRequest } from "partyserver";

import type { Env } from "./env.js";
import { handleHandoffsApi } from "./handoffs/handler.js";
import { securityHeaders } from "./security.js";

export type { Env } from "./env.js";
export { HandoffParty } from "./handoffs/party.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const partyResponse = await routePartykitRequest(request, env);
    if (partyResponse !== null) {
      return partyResponse;
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return Effect.runPromise(handleHandoffsApi(request, env));
    }
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(securityHeaders())) {
      headers.set(k, v);
    }
    return new Response(res.body, { status: res.status, headers });
  },
};
