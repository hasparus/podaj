import { Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import type { Env } from "../env.js";
import {
  type ApprovalBody, ErrorBody, FillBody, Gone, RecipientBody, ReserveBody, VerificationFields,
} from "./api.js";
import { CreateContextInput } from "./context-contract.js";
import { onlyFields, readJsonBody } from "./body.js";
import { bearerCapability, digest, randomCapability, recipientFingerprint, validSealedEnvelope } from "./capabilities.js";
import { HandoffsApiError, quotaRetryHeaders } from "./errors.js";
import { randomHandoffId } from "./id.js";
import { admissionConfig, authorizeCreation, clientConfig, dailyIpHash, handoffLimits, handoffService, requestIp, requireOwner } from "./policy.js";
import { REQUEST_CONTEXT_LIMITS, type FailureReply, type GoneReply } from "./protocol.js";

const input = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S, body: unknown, status: number, code: string,
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(body);
  } catch {
    throw new HandoffsApiError({ status, code });
  }
};

const refusal = (result: FailureReply<400 | 401 | 404 | 409 | 413 | 429> | GoneReply): HttpServerResponse.HttpServerResponse => {
  const schema = result.status === 410 ? Gone : ErrorBody;
  return HttpServerResponse.jsonUnsafe(Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(result.body), {
    status: result.status,
    headers: result.status === 429 ? quotaRetryHeaders(result.body.quota) : {},
  });
};

export const createContext = async (request: Request, env: Env) => {
  const config = admissionConfig(env);
  if (config.access === "private") requireOwner(request, env);
  const body = await readJsonBody(request, REQUEST_CONTEXT_LIMITS.maxEncodedBytes + 1024);
  const context = input(CreateContextInput, body, 400, "invalid context");
  const result = await handoffService(env).createContext(
    context.id, context.writeHash, context.encryptedContext, await dailyIpHash(request),
  );
  return result.status === 201 ? result.body : refusal(result);
};

export const getContext = async (env: Env, id: string) => {
  const result = await handoffService(env).getContext(id);
  return result.status === 200 ? result.body : refusal(result);
};

export const getConfig = (env: Env) => clientConfig(env);

export const getAccess = (request: Request, env: Env) => {
  const config = clientConfig(env);
  if (config.access === "private") requireOwner(request, env);
  return { access: config.access, authorized: true as const };
};

const requireDemo = (env: Env): void => {
  if (clientConfig(env).access !== "public") throw new HandoffsApiError({ status: 404, code: "not found" });
};

export const getDemoStatus = async (request: Request, env: Env) => {
  requireDemo(env);
  const result = await handoffService(env).credentialStatus(await digest(bearerCapability(request)));
  return result.status === 200 || result.status === 202 ? result.body : refusal(result);
};

const approvalInput = async (request: Request) => {
  const body = await readJsonBody(request, 8192);
  onlyFields(body, ["challenge", "recipientPublicKey", "turnstileToken"]);
  const verification = input(VerificationFields, {
    challenge: body.challenge, turnstileToken: body.turnstileToken,
  }, 400, "invalid verification");
  const recipient = input(RecipientBody, { recipientPublicKey: body.recipientPublicKey }, 400, "invalid recipient key");
  return { ...verification, ...recipient };
};

const verifyTurnstile = async (
  request: Request, env: Env, body: typeof ApprovalBody.Type, fingerprint: string,
): Promise<void> => {
  const expectedCdata = await digest(`${body.challenge}.${fingerprint}`);
  let validation: unknown;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY ?? "", response: body.turnstileToken, remoteip: requestIp(request),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("verification failed");
    validation = await response.json();
  } catch {
    throw new HandoffsApiError({ status: 503, code: "verification unavailable" });
  }
  if (typeof validation !== "object" || validation === null ||
      !("success" in validation) || validation.success !== true ||
      !("hostname" in validation) || validation.hostname !== new URL(request.url).hostname ||
      !("action" in validation) || validation.action !== "podaj-admission" ||
      !("cdata" in validation) || validation.cdata !== expectedCdata) {
    throw new HandoffsApiError({ status: 403, code: "verification failed" });
  }
};

export const approveDemo = async (request: Request, env: Env) => {
  requireDemo(env);
  admissionConfig(env);
  const body = await approvalInput(request);
  const service = handoffService(env);
  const admitted = await service.approvalAttempt(await dailyIpHash(request));
  if (admitted.status !== 200) return refusal(admitted);
  const fingerprint = await recipientFingerprint(body.recipientPublicKey);
  await verifyTurnstile(request, env, body, fingerprint);
  const result = await service.approveCredential(body.challenge, fingerprint);
  return result.status === 200 ? result.body : refusal(result);
};

export const reserveHandoff = async (request: Request, env: Env) => {
  const grant = await authorizeCreation(request, env);
  const body = await readJsonBody(request, 4096);
  const reservation = input(ReserveBody, body, 400, "invalid reservation");
  const fingerprint = await recipientFingerprint(reservation.recipientPublicKey);
  const address = "id" in reservation ? reservation : { id: randomHandoffId(), writeToken: randomCapability() };
  const { writeToken } = address;
  let readToken = randomCapability();
  while (readToken === writeToken) readToken = randomCapability();
  let subscribeToken = randomCapability();
  while (subscribeToken === writeToken || subscribeToken === readToken) subscribeToken = randomCapability();
  const [writeHash, readHash, subscribeHash] = await Promise.all([
    digest(writeToken), digest(readToken), digest(subscribeToken),
  ]);
  const result = await handoffService(env).reserve({
    source: "id" in reservation ? "draft" : "generated",
    id: address.id, recipientFingerprint: fingerprint,
    writeHash, readHash, subscribeHash, creatorHash: grant.creatorHash,
  });
  if (result.status !== 201) return refusal(result);
  return { ...result.body, writeToken, readToken, subscribeToken, handoffTtlSeconds: grant.config.handoffTtlSeconds };
};

export const fillHandoff = async (request: Request, env: Env, id: string, writeHash: string) => {
  const service = handoffService(env);
  const authorization = await service.authorizeWrite(id, writeHash);
  if (authorization.status !== 200) return refusal(authorization);
  const authorized: unknown = authorization.body.authorized;
  if (authorized !== true) throw new HandoffsApiError({ status: 503, code: "service unavailable" });
  const { maxHandoffBytes } = handoffLimits(env);
  const body = await readJsonBody(request, maxHandoffBytes + 1024);
  onlyFields(body, ["sealed"]);
  const { sealed } = input(FillBody, body, 413, "payload too large");
  if (sealed.length > maxHandoffBytes) throw new HandoffsApiError({ status: 413, code: "payload too large" });
  if (!validSealedEnvelope(sealed)) throw new HandoffsApiError({ status: 400, code: "invalid ciphertext" });
  const result = await service.fill(id, writeHash, sealed);
  return result.status === 200 ? result.body : refusal(result);
};

export const writableHandoff = async (env: Env, id: string, writeHash: string) => {
  const result = await handoffService(env).authorizeWrite(id, writeHash);
  return result.status === 200 ? { authorized: true as const } : refusal(result);
};

export const handoffStatus = async (env: Env, id: string, subscribeHash: string) => {
  const result = await handoffService(env).status(id, subscribeHash);
  return result.status === 200 ? result.body : refusal(result);
};

export const consumeHandoff = async (env: Env, id: string, readHash: string) => {
  const result = await handoffService(env).consume(id, readHash);
  return result.status === 200 ? result.body : refusal(result);
};

export const rejectHandoffRead = () => HttpServerResponse.empty({ status: 405, headers: { Allow: "PUT" } });
