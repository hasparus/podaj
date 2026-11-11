import type { SenderContextV1 } from "../src/crypto/request-context.js";
import type { ClientConfig, Reservation } from "../src/handoffs/protocol.js";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sealRequestContext } from "../src/crypto/request-context.js";
import { authHeaders, originOf, recipientIdentity, requestFailure } from "./instance.js";

const jsonRecord = (value: unknown, message = "unexpected JSON response"): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
};

/** Stage only ciphertext and a sender-capability hash; the decryption key stays in the link. */
const stageRequestContext = async ({ origin, id, token, context }: {
  origin: string; id: string; token: string; context: SenderContextV1;
}): Promise<string> => {
  const { key, encryptedContext } = await sealRequestContext(id, context);
  const response = await fetch(new URL("/api/contexts", originOf(origin)), {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ id, writeHash: createHash("sha256").update(context.writeToken).digest("hex"), encryptedContext }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 201) throw await requestFailure(response, "request context staging failed", origin);
  const body = jsonRecord(await response.json());
  if (body.id !== id || typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
    throw new Error("request context staging returned an invalid id or expiry");
  }
  const link = new URL(`/s/${id}`, originOf(origin));
  link.hash = key;
  return link.href;
};

/** Poll only with the verifier; browser approval is bound to the full local fingerprint. */
export const waitForPublicApproval = async ({ origin, verifier, fingerprint, attempts = 60, intervalMs = 2_000, timeoutMs = 130_000 }: {
  origin: string; verifier: string; fingerprint: string;
  attempts?: number; intervalMs?: number; timeoutMs?: number;
}): Promise<void> => {
  const deadline = AbortSignal.timeout(Math.min(timeoutMs, 130_000));
  const boundedAttempts = Math.min(attempts, 60);
  try {
    for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
      const response = await fetch(new URL("/api/demo/status", originOf(origin)), {
        headers: authHeaders(verifier),
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      });
      if (response.status === 429) throw await requestFailure(response, "authorization failed", origin);
      const body = jsonRecord(await response.json());
      if (response.status === 200 && body.status === "approved") {
        if (body.recipientFingerprint !== fingerprint) {
          throw new Error("authorization recipient fingerprint does not match local key");
        }
        if (typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
          throw new Error("invalid authorization expiry");
        }
        return;
      }
      if (response.status !== 202 || body.status !== "pending") {
        throw await requestFailure(response, "authorization failed", origin);
      }
      if (attempt + 1 < boundedAttempts) {
        await delay(intervalMs, undefined, { signal: deadline });
      }
    }
  } catch (error) {
    if (!deadline.aborted) throw error;
  }
  throw new Error("timed out waiting for browser authorization");
};

const reservedBody = (value: unknown, fingerprint: string): Reservation => {
  const body = jsonRecord(value, "unexpected json");
  const { id, writeToken, readToken, subscribeToken, expiresAt, recipientFingerprint } = body;
  const validCapability = (cap: unknown): cap is string =>
    typeof cap === "string" && /^[a-f0-9]{64}$/u.test(cap);
  const capabilities = [writeToken, readToken, subscribeToken];
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/u.test(id) ||
      !validCapability(writeToken) || !validCapability(readToken) || !validCapability(subscribeToken) ||
      new Set(capabilities).size !== 3 ||
      typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0 ||
      typeof recipientFingerprint !== "string" || recipientFingerprint !== fingerprint) {
    throw new Error("reserve returned an unexpected body or recipient fingerprint");
  }
  return { id, writeToken, readToken, subscribeToken, expiresAt, recipientFingerprint };
};

/** Create one sender context and reservation, exposing its link only when it can be used. */
export const createHandoffRequest = async ({ origin, token, config, recipientPublicKey, requestedKeys, onLink }: {
  origin: string; token: string; config: ClientConfig; recipientPublicKey: string;
  requestedKeys: readonly string[]; onLink: (link: string) => void;
}): Promise<Reservation> => {
  const { fingerprint } = recipientIdentity(recipientPublicKey);
  const id = randomBytes(16).toString("hex");
  const writeToken = randomBytes(32).toString("hex");
  const verifier = config.access === "public" ? randomBytes(32).toString("hex") : undefined;
  const link = await stageRequestContext({
    origin, id, token: verifier === undefined ? token : "",
    context: {
      version: 1, recipientPublicKey, writeToken, requestedKeys,
      ...(verifier === undefined ? {} : { challenge: createHash("sha256").update(verifier).digest("hex") }),
    },
  });
  if (verifier !== undefined) {
    onLink(link);
    await waitForPublicApproval({ origin, verifier, fingerprint });
  }
  const response = await fetch(new URL("/api/handoffs/reserve", origin), {
    body: JSON.stringify({ recipientPublicKey, id, writeToken }),
    headers: { ...authHeaders(verifier ?? token), "Content-Type": "application/json" },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await requestFailure(response, "reserve failed", origin);
  const reserved = reservedBody(await response.json(), fingerprint);
  if (reserved.id !== id || reserved.writeToken !== writeToken) {
    throw new Error("reserve returned a different handoff id or write capability");
  }
  if (verifier === undefined) onLink(link);
  return reserved;
};
