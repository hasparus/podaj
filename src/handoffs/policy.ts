import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import { accessFor } from "../access.js";
import type { Env } from "../env.js";
import type { HandoffParty } from "./party.js";
import { handoffTtlSeconds, maxHandoffBytes, sameOrigin } from "../security.js";
import { handoffAccess } from "./access.js";
import { bearerCapability, digest } from "./capabilities.js";
import { HandoffsApiError, quotaRetryHeaders } from "./errors.js";
import { jsonResponse } from "./http.js";
import { HANDOFF_ID, HANDOFF_SERVICE_NAME, type ClientConfig } from "./protocol.js";

type RequestBindingsId = { readonly requestBindings: unique symbol };
export const RequestBindings = Context.Service<RequestBindingsId, Env>("podaj/RequestBindings");

export { handoffAccess } from "./access.js";

/** Existing capabilities remain usable when new public admission is unavailable. */
export const handoffLimits = (env: Env) => {
  const isPublic = handoffAccess(env) === "public";
  return {
    handoffTtlSeconds: Math.min(handoffTtlSeconds(env.HANDOFF_TTL_SECONDS), isPublic ? 7200 : 86400),
    maxHandoffBytes: Math.min(maxHandoffBytes(env.MAX_HANDOFF_BYTES), isPublic ? 32768 : Number.MAX_SAFE_INTEGER),
  };
};

export const clientConfig = (env: Env): ClientConfig => {
  const access = handoffAccess(env);
  return {
    access,
    ...handoffLimits(env),
    ...(access === "public" ? { turnstileSiteKey: env.TURNSTILE_SITE_KEY } : {}),
  };
};

export const admissionConfig = (env: Env): ClientConfig => {
  const config = clientConfig(env);
  if (config.access === "public" && ((env.TURNSTILE_SITE_KEY ?? "").length === 0 || (env.TURNSTILE_SECRET_KEY ?? "").length === 0 || env.PUBLIC_API_LIMITER === undefined)) {
    throw new HandoffsApiError({ status: 503, code: "verification unavailable" });
  }
  return config;
};

type HandoffService = Pick<HandoffParty, "createContext" | "getContext" | "reserve" | "authorizeWrite" | "fill" | "consume" | "status" | "approvalAttempt" | "approveCredential" | "credentialStatus" | "fetch">;

export const handoffService = (env: Env): HandoffService =>
  env.HANDOFF_PARTY.get(env.HANDOFF_PARTY.idFromName(HANDOFF_SERVICE_NAME));

export const requireOwner = (request: Request, env: Env): void => {
  const access = accessFor(request, env.PODAJ_API_AUTH_SECRET);
  if (access !== "ok") {
    throw new HandoffsApiError({
      status: access === "locked" ? 503 : 401,
      code: access === "locked" ? "locked" : "unauthorized",
    });
  }
};

export const requestIp = (request: Request): string => {
  const forwarded = request.headers.get("CF-Connecting-IP");
  if (forwarded !== null && forwarded.length > 0 && forwarded.length <= 64) return forwarded;
  const hostname = new URL(request.url).hostname;
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return "localhost";
  throw new HandoffsApiError({ status: 403, code: "verification unavailable" });
};

export const dailyIpHash = (request: Request): Promise<string> =>
  digest(`${new Date().toISOString().slice(0, 10)}:${requestIp(request)}`);

export const enforcePublicRateLimit = async (request: Request, env: Env): Promise<void> => {
  if (env.PUBLIC_API_LIMITER === undefined) return;
  const admitted = await env.PUBLIC_API_LIMITER.limit({ key: await dailyIpHash(request) });
  if (!admitted.success) throw new HandoffsApiError({ status: 429, code: "rate limited", quota: { kind: "api_requests" } });
};

export const enforceApiPolicy = async (request: Request, env: Env): Promise<void> => {
  if (accessFor(request, env.PODAJ_API_AUTH_SECRET) === "closed") {
    throw new HandoffsApiError({ status: 404, code: "not found" });
  }
  const access = handoffAccess(env);
  if (!sameOrigin(request)) throw new HandoffsApiError({ status: 403, code: "origin not allowed" });
  if (access === "public") await enforcePublicRateLimit(request, env);
  if (request.method === "HEAD" || new URL(request.url).pathname.includes("%")) {
    throw new HandoffsApiError({ status: 404, code: "not found" });
  }
};

export const apiErrorResponse = (error: unknown): HttpServerResponse.HttpServerResponse =>
  error instanceof HandoffsApiError
    ? HttpServerResponse.setHeaders(
      HttpServerResponse.fromWeb(jsonResponse({
        error: error.code, ...(error.quota === undefined ? {} : { quota: error.quota }),
      }, error.status)),
      error.status === 429 ? quotaRetryHeaders(error.quota) : {},
    )
    : HttpServerResponse.fromWeb(jsonResponse({ error: "service unavailable" }, 503));

/** Keep exceptions and schema diagnostics out of public replies and logs. */
export const attempt = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
    Effect.catch((error) => Effect.succeed(apiErrorResponse(error))),
  );

type CreationGrant = { config: ClientConfig; creatorHash: string | null };

export const authorizeCreation = async (request: Request, env: Env): Promise<CreationGrant> => {
  const config = admissionConfig(env);
  if (config.access === "private") {
    requireOwner(request, env);
    return { config, creatorHash: null };
  }
  const creatorHash = await digest(bearerCapability(request));
  const credential = await handoffService(env).credentialStatus(creatorHash);
  if (credential.status !== 200 || credential.body.status !== "approved") {
    throw new HandoffsApiError({ status: 401, code: "unauthorized" });
  }
  return { config, creatorHash };
};

type CapabilityHashId = { readonly capabilityHash: unique symbol };
export const CapabilityHash = Context.Service<CapabilityHashId, string>("podaj/CapabilityHash");
export class CapabilityPolicy extends HttpApiMiddleware.Service<CapabilityPolicy, {
  provides: CapabilityHashId;
}>()("podaj/CapabilityPolicy") {}

/** Parsing is not authorization: each DO method atomically validates its own role hash. */
export const capabilityPolicyLayer = Layer.succeed(CapabilityPolicy, (next) =>
  Effect.gen(function* () {
    const { id } = yield* HttpRouter.params;
    if (id === undefined || !HANDOFF_ID.test(id)) {
      return apiErrorResponse(new HandoffsApiError({ status: 404, code: "not found" }));
    }
    const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest).pipe(Effect.orDie);
    const hash = yield* attempt(() => digest(bearerCapability(request)));
    if (HttpServerResponse.isHttpServerResponse(hash)) return hash;
    return yield* Effect.provideService(next, CapabilityHash, hash);
  }),
);
