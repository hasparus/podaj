import { Effect } from "effect";
import { routePartykitRequest } from "partyserver";

import { accessFor } from "./access.js";
import type { Env } from "./env.js";
import { handleHandoffsApi } from "./handoffs/handler.js";
import { securityHeaders } from "./security.js";

const gateParty = (request: Request, env: Env): Request | Response => {
  const access = accessFor(request, env.PODAJ_TOKEN);
  switch (access) {
    case "ok": {
      return request;
    }
    case "locked": {
      return Response.json({ error: "locked" }, { status: 503 });
    }
    case "closed":
    case "unauthorized": {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
};

export type { Env } from "./env.js";
export { HandoffParty } from "./handoffs/party.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (accessFor(request, env.PODAJ_TOKEN) === "closed") {
      return new Response("not found", { status: 404 });
    }

    const partyResponse = await routePartykitRequest(request, env, {
      onBeforeConnect: (req) => gateParty(req, env),
      onBeforeRequest: (req) => gateParty(req, env),
    });
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
