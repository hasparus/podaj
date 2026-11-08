import { Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import type { Env } from "../env.js";
import {
  Approved, ApprovalBody, Consumed, CredentialApproved, CredentialPending,
  ErrorBody, Filled, FillBody, Gone, ReserveBody, Reserved, Status, VerificationFields,
} from "./api.js";
import { onlyFields, readJsonBody } from "./body.js";
import { bearerCapability, digest, randomCapability, recipientFingerprint, validSealedEnvelope } from "./capabilities.js";
import { HandoffsApiError } from "./errors.js";
import { randomHandoffId } from "./id.js";
import { admissionConfig, authorizeCreation, clientConfig, dailyIpHash, handoffLimits, handoffService, requestIp, requireOwner } from "./policy.js";
import type { ServiceReply } from "./protocol.js";

const checked = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);

const input = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S, body: unknown, status: number, code: string,
): S["Type"] => {
  try {
    return checked(schema, body);
  } catch {
    throw new HandoffsApiError({ status, code });
  }
};

const refusal = (result: ServiceReply): HttpServerResponse.HttpServerResponse => {
  const body = result.status === 410 ? checked(Gone, result.body) : checked(ErrorBody, result.body);
  return HttpServerResponse.jsonUnsafe(body, { status: result.status });
};

const serviceReply = <S extends Schema.ConstraintDecoder<unknown>>(
  result: ServiceReply, schema: S, successStatus = 200,
): S["Type"] | HttpServerResponse.HttpServerResponse =>
  result.status === successStatus ? checked(schema, result.body) : refusal(result);

export const getConfig = (env: Env) => clientConfig(env);

export const getAccess = (request: Request, env: Env) => {
  const config = clientConfig(env);
  if (config.mode === "private") requireOwner(request, env);
  return { mode: config.mode, authorized: true as const };
};

const requireDemo = (env: Env): void => {
  if (clientConfig(env).mode !== "demo") throw new HandoffsApiError({ status: 404, code: "not found" });
};

export const getDemoStatus = async (request: Request, env: Env) => {
  requireDemo(env);
  const result = await handoffService(env).credentialStatus(await digest(bearerCapability(request)));
  if (result.status === 202) return checked(CredentialPending, result.body);
  return serviceReply(result, CredentialApproved);
};

const approvalInput = async (request: Request) => {
  const body = await readJsonBody(request, 8192);
  onlyFields(body, ["challenge", "recipientPublicKey", "turnstileToken"]);
  const verification = input(VerificationFields, {
    challenge: body.challenge, turnstileToken: body.turnstileToken,
  }, 400, "invalid verification");
  const recipient = input(ReserveBody, { recipientPublicKey: body.recipientPublicKey }, 400, "invalid recipient key");
  return checked(ApprovalBody, { ...verification, ...recipient });
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
  return serviceReply(await service.approveCredential(body.challenge, fingerprint), Approved);
};

export const reserveHandoff = async (request: Request, env: Env) => {
  const grant = await authorizeCreation(request, env);
  const body = await readJsonBody(request, 4096);
  onlyFields(body, ["recipientPublicKey"]);
  const { recipientPublicKey } = input(ReserveBody, body, 400, "invalid recipient key");
  const fingerprint = await recipientFingerprint(recipientPublicKey);
  const writeToken = randomCapability();
  const readToken = randomCapability();
  const subscribeToken = randomCapability();
  const [writeHash, readHash, subscribeHash] = await Promise.all([
    digest(writeToken), digest(readToken), digest(subscribeToken),
  ]);
  const result = await handoffService(env).reserve({
    id: randomHandoffId(), recipientFingerprint: fingerprint,
    writeHash, readHash, subscribeHash, creatorHash: grant.creatorHash,
  });
  const reserved = serviceReply(result, Reserved, 201);
  if (HttpServerResponse.isHttpServerResponse(reserved)) return reserved;
  return { ...reserved, writeToken, readToken, subscribeToken, handoffTtlSeconds: grant.config.handoffTtlSeconds };
};

const WriteAuthorized = Schema.Struct({ authorized: Schema.Literal(true) });

export const fillHandoff = async (request: Request, env: Env, id: string, writeHash: string) => {
  const service = handoffService(env);
  const authorization = serviceReply(await service.authorizeWrite(id, writeHash), WriteAuthorized);
  if (HttpServerResponse.isHttpServerResponse(authorization)) return authorization;
  const { maxHandoffBytes } = handoffLimits(env);
  const body = await readJsonBody(request, maxHandoffBytes + 1024);
  onlyFields(body, ["sealed"]);
  const { sealed } = input(FillBody, body, 413, "payload too large");
  if (sealed.length > maxHandoffBytes) throw new HandoffsApiError({ status: 413, code: "payload too large" });
  if (!validSealedEnvelope(sealed)) throw new HandoffsApiError({ status: 400, code: "invalid ciphertext" });
  return serviceReply(await service.fill(id, writeHash, sealed), Filled);
};

export const handoffStatus = async (env: Env, id: string, subscribeHash: string) =>
  serviceReply(await handoffService(env).status(id, subscribeHash), Status);

export const consumeHandoff = async (env: Env, id: string, readHash: string) =>
  serviceReply(await handoffService(env).consume(id, readHash), Consumed);

export const rejectHandoffRead = () => HttpServerResponse.empty({ status: 405, headers: { Allow: "PUT" } });
