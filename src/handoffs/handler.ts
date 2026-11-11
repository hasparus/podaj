import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware, type HttpApiError } from "effect/http-api";
import type { Env } from "../env.js";
import { securityHeaders } from "../security.js";
import { HandoffsApi, SchemaRefusal } from "./api.js";
import { HandoffsApiError } from "./errors.js";
import {
  approveDemo, consumeHandoff, createContext, fillHandoff, getAccess, getConfig, getContext, getDemoStatus,
  handoffStatus, rejectHandoffRead, reserveHandoff, writableHandoff,
} from "./operations.js";
import {
  apiErrorResponse, attempt, CapabilityHash, capabilityPolicyLayer,
  enforceApiPolicy, RequestBindings,
} from "./policy.js";

export { handoffAccess, handoffService } from "./policy.js";

const requestOperation = <A>(operation: (request: Request, env: Env) => A | Promise<A>) =>
  Effect.gen(function* () {
    const env = yield* RequestBindings;
    const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest).pipe(Effect.orDie);
    return yield* attempt(async () => await operation(request, env));
  });

const capabilityOperation = <A>(id: string, operation: (env: Env, id: string, hash: string) => Promise<A>) =>
  Effect.gen(function* () {
    const env = yield* RequestBindings;
    const hash = yield* CapabilityHash;
    return yield* attempt(() => operation(env, id, hash));
  });

const schemaRefusal = (error: HttpApiError.HttpApiSchemaError) => {
  if (error.kind === "Params") return new HandoffsApiError({ status: 404, code: "not found" });
  if (error.kind === "Body" || error.kind === "ResponseHeaders") {
    return new HandoffsApiError({ status: 503, code: "service unavailable" });
  }
  return new HandoffsApiError({ status: 400, code: "invalid json" });
};

const schemaRefusals = HttpApiMiddleware.layerSchemaErrorTransform(SchemaRefusal, (error) =>
  Effect.succeed(apiErrorResponse(schemaRefusal(error))),
);

const handlers = HttpApiBuilder.group(HandoffsApi, "handoffs", (group) => group
  .handle("config", () => requestOperation((_request, env) => getConfig(env)))
  .handle("access", () => requestOperation(getAccess))
  .handleRaw("approveDemo", () => requestOperation(approveDemo))
  .handle("demoStatus", () => requestOperation(getDemoStatus))
  .handleRaw("createContext", () => requestOperation(createContext))
  .handle("getContext", ({ params }) => requestOperation((_request, env) => getContext(env, params.id)))
  .handleRaw("reserve", () => requestOperation(reserveHandoff))
  .handleRaw("fill", ({ params }) => Effect.gen(function* () {
    const writeHash = yield* CapabilityHash;
    return yield* requestOperation((request, env) => fillHandoff(request, env, params.id, writeHash));
  }))
  .handle("writable", ({ params }) => capabilityOperation(params.id, writableHandoff))
  .handle("status", ({ params }) => capabilityOperation(params.id, handoffStatus))
  .handleRaw("consume", ({ params }) => capabilityOperation(params.id, consumeHandoff))
  .handle("rejectRead", () => Effect.succeed(rejectHandoffRead())),
).pipe(Layer.provide(Layer.mergeAll(capabilityPolicyLayer, schemaRefusals)));

const sharedPolicy = HttpRouter.middleware<{ handles: HttpServerError.HttpServerError }>()(
  (next) => Effect.gen(function* () {
    const env = yield* RequestBindings;
    const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest).pipe(Effect.orDie);
    const rejected = yield* attempt(() => enforceApiPolicy(request, env));
    if (HttpServerResponse.isHttpServerResponse(rejected)) return rejected;
    return yield* next;
  }).pipe(
    Effect.catchIf(HttpServerError.isHttpServerError, (error) => Effect.succeed(apiErrorResponse(
      error.reason._tag === "RouteNotFound"
        ? new HandoffsApiError({ status: 404, code: "not found" })
        : error,
    ))),
    Effect.catchDefect((error) => Effect.succeed(apiErrorResponse(error))),
    Effect.map((response) => HttpServerResponse.setHeaders(response, {
      ...securityHeaders(), "Cache-Control": "no-store",
    })),
  ),
  { global: true },
);

const app = HttpRouter.toWebHandler(
  Layer.mergeAll(HttpApiBuilder.layer(HandoffsApi).pipe(Layer.provide(handlers)), sharedPolicy).pipe(
    Layer.provide(HttpServer.layerServices),
  ),
  {
    disableLogger: true,
    routerConfig: { caseSensitive: true, ignoreDuplicateSlashes: false, ignoreTrailingSlash: false },
  },
);

export const handleHandoffsApi = (request: Request, env: Env): Effect.Effect<Response, never> =>
  Effect.tryPromise({
    try: () => app.handler(request, Context.make(RequestBindings, env)),
    catch: (error) => error,
  }).pipe(Effect.catch((error) => Effect.succeed(HttpServerResponse.toWeb(apiErrorResponse(error)))));
