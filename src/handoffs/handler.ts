import { Effect, Schema } from "effect";
import { accessFor } from "../access.js";
import { maxHandoffBytes, sameOrigin } from "../security.js";
import type { Env } from "../env.js";
import { HandoffsApiError } from "./errors.js";
import { randomHandoffId } from "./id.js";
import { jsonResponse } from "./http.js";
import {
  hashWriteToken,
  isPendingValue,
  isSealedValue,
  pendingValue,
  randomWriteToken,
  verifyPendingWriteToken,
} from "./kv-encoding.js";
import { notifyHandoffReady } from "./notify-ready.js";
import {
  assertPodaj1Sealed,
  PutHandoffBody,
  type PutHandoffBodyType,
  StoreHandoffBody,
  type StoreHandoffBodyType,
} from "./schema.js";

const TTL_SECONDS = 86400;

const readBodyText = (request: Request): Effect.Effect<string, HandoffsApiError> =>
  Effect.tryPromise({
    try: () => request.text(),
    catch: () => new HandoffsApiError({ code: "invalid json", status: 400 }),
  });

const decodeStoreBody = (
  raw: string,
): Effect.Effect<StoreHandoffBodyType, HandoffsApiError> =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(StoreHandoffBody)(
        JSON.parse(raw) as unknown,
      ),
    catch: () => new HandoffsApiError({ code: "invalid json", status: 400 }),
  });

const decodePutBody = (
  raw: string,
): Effect.Effect<PutHandoffBodyType, HandoffsApiError> =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(PutHandoffBody)(JSON.parse(raw) as unknown),
    catch: () => new HandoffsApiError({ code: "invalid json", status: 400 }),
  });

const assertBodySize = (
  request: Request,
  raw: string,
  env: Env,
): Effect.Effect<void, HandoffsApiError> =>
  Effect.gen(function* () {
    const limit = maxHandoffBytes(env.MAX_HANDOFF_BYTES);
    const contentLength = request.headers.get("Content-Length");
    if (
      contentLength !== null &&
      Number.parseInt(contentLength, 10) > limit
    ) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "payload too large", status: 413 }),
      );
    }
    if (raw.length > limit) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "payload too large", status: 413 }),
      );
    }
  });

const reserveHandoff = (
  request: Request,
  env: Env,
): Effect.Effect<Response, HandoffsApiError> =>
  Effect.gen(function* () {
    const id = randomHandoffId();
    const writeToken = randomWriteToken();
    const writeTokenHash = yield* Effect.tryPromise({
      try: () => hashWriteToken(writeToken),
      catch: () =>
        new HandoffsApiError({ code: "store failed", status: 503 }),
    });
    yield* Effect.tryPromise({
      try: () =>
        env.HANDOFFS.put(id, pendingValue(writeTokenHash), {
          expirationTtl: TTL_SECONDS,
        }),
      catch: () =>
        new HandoffsApiError({ code: "store failed", status: 503 }),
    });
    const origin = new URL(request.url).origin;
    return jsonResponse(
      {
        id,
        receiveUrl: `${origin}/h/${id}`,
        sendUrl: `${origin}/s/${id}#${writeToken}`,
        writeToken,
      },
      201,
    );
  });

const storeHandoff = (
  request: Request,
  env: Env,
): Effect.Effect<Response, HandoffsApiError> =>
  Effect.gen(function* () {
    const raw = yield* readBodyText(request);
    yield* assertBodySize(request, raw, env);
    const body = yield* decodeStoreBody(raw);
    if (!assertPodaj1Sealed(body.sealed)) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "invalid json", status: 400 }),
      );
    }
    const id = randomHandoffId();
    yield* Effect.tryPromise({
      try: () =>
        env.HANDOFFS.put(id, body.sealed, { expirationTtl: TTL_SECONDS }),
      catch: () =>
        new HandoffsApiError({ code: "store failed", status: 503 }),
    });
    const receiveUrl = new URL(`/h/${id}`, request.url).toString();
    void notifyHandoffReady(env, id, receiveUrl);
    return jsonResponse({ id, url: receiveUrl }, 201);
  });

const putHandoff = (
  request: Request,
  env: Env,
  id: string,
): Effect.Effect<Response, HandoffsApiError> =>
  Effect.gen(function* () {
    const raw = yield* readBodyText(request);
    yield* assertBodySize(request, raw, env);
    const body = yield* decodePutBody(raw);
    if (!assertPodaj1Sealed(body.sealed)) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "invalid json", status: 400 }),
      );
    }
    if (body.writeToken.trim().length === 0) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "invalid write", status: 403 }),
      );
    }
    const current = yield* Effect.tryPromise({
      try: () => env.HANDOFFS.get(id),
      catch: () =>
        new HandoffsApiError({ code: "store failed", status: 503 }),
    });
    if (current === null) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "gone", status: 410 }),
      );
    }
    if (isSealedValue(current)) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "already shared", status: 409 }),
      );
    }
    if (!isPendingValue(current)) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "invalid json", status: 400 }),
      );
    }
    const allowed = yield* Effect.tryPromise({
      try: () => verifyPendingWriteToken(current, body.writeToken),
      catch: () =>
        new HandoffsApiError({ code: "store failed", status: 503 }),
    });
    if (!allowed) {
      return yield* Effect.fail(
        new HandoffsApiError({ code: "invalid write", status: 403 }),
      );
    }
    yield* Effect.tryPromise({
      try: () =>
        env.HANDOFFS.put(id, body.sealed, { expirationTtl: TTL_SECONDS }),
      catch: () =>
        new HandoffsApiError({ code: "store failed", status: 503 }),
    });
    const receiveUrl = new URL(`/h/${id}`, request.url).toString();
    void notifyHandoffReady(env, id, receiveUrl);
    return jsonResponse({ id, url: receiveUrl }, 200);
  });

const handoffStatus = (
  id: string,
  env: Env,
): Effect.Effect<Response, HandoffsApiError> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => env.HANDOFFS.get(id),
      catch: () =>
        new HandoffsApiError({ code: "fetch failed", status: 503 }),
    });
    if (stored === null) {
      return jsonResponse({ status: "gone" }, 410);
    }
    if (isPendingValue(stored)) {
      return jsonResponse({ status: "pending" }, 200);
    }
    if (isSealedValue(stored)) {
      return jsonResponse({ status: "ready" }, 200);
    }
    return jsonResponse({ status: "gone" }, 410);
  });

const fetchHandoffOnce = (
  id: string,
  env: Env,
): Effect.Effect<Response, HandoffsApiError> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => env.HANDOFFS.get(id),
      catch: () =>
        new HandoffsApiError({ code: "fetch failed", status: 503 }),
    });
    if (stored === null) {
      return jsonResponse({ error: "gone" }, 410);
    }
    if (isPendingValue(stored)) {
      return jsonResponse({ error: "not ready" }, 404);
    }
    if (!isSealedValue(stored)) {
      return jsonResponse({ error: "gone" }, 410);
    }
    yield* Effect.tryPromise({
      try: () => env.HANDOFFS.delete(id),
      catch: () =>
        new HandoffsApiError({ code: "fetch failed", status: 503 }),
    });
    return jsonResponse({ sealed: stored }, 200);
  });

const apiErrorResponse = (error: HandoffsApiError): Response =>
  jsonResponse({ error: error.code }, error.status);

export const handleHandoffsApi = (
  request: Request,
  env: Env,
): Effect.Effect<Response, never> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const access = accessFor(request, env.PODAJ_TOKEN);
    switch (access) {
      case "ok": {
        break;
      }
      case "closed": {
        return new Response("not found", { status: 404 });
      }
      case "locked": {
        return jsonResponse({ error: "locked" }, 503);
      }
      case "unauthorized": {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      default: {
        const unreachable: never = access;
        return unreachable;
      }
    }
    if (!sameOrigin(request)) {
      return jsonResponse({ error: "origin not allowed" }, 403);
    }

    if (url.pathname === "/api/handoffs/reserve" && request.method === "POST") {
      return yield* reserveHandoff(request, env);
    }

    if (url.pathname === "/api/handoffs" && request.method === "POST") {
      return yield* storeHandoff(request, env);
    }

    const statusMatch = url.pathname.match(
      /^\/api\/handoffs\/([a-f0-9]{32})\/status$/u,
    );
    const statusId = statusMatch?.[1];
    if (statusId !== undefined && request.method === "GET") {
      return yield* handoffStatus(statusId, env);
    }

    const match = url.pathname.match(/^\/api\/handoffs\/([a-f0-9]{32})$/u);
    const id = match?.[1];
    if (id !== undefined && request.method === "PUT") {
      return yield* putHandoff(request, env, id);
    }
    if (id !== undefined && request.method === "GET") {
      return yield* fetchHandoffOnce(id, env);
    }

    return new Response("not found", { status: 404 });
  }).pipe(
    Effect.catchTag("HandoffsApiError", (error) =>
      Effect.succeed(apiErrorResponse(error)),
    ),
  );
