import type { ClientConfig } from "../src/handoffs/protocol.js";
import { createHash, createPublicKey } from "node:crypto";
import { handoffApiError, HOSTED_DEMO_ORIGIN, SELF_HOST_URL } from "../src/client/user-facing.js";

export type Probe = "ok" | "unauthorized" | "locked" | "unreachable";

export const originOf = (raw: string) => {
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("enter an HTTPS URL, or HTTP for localhost");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local) {
    throw new Error("HTTP is only allowed for localhost; use HTTPS for a remote worker");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("worker URLs must not contain credentials");
  }
  return url.origin;
};

export const tokenVerdict = (status: number): Probe => {
  if (status === 200) return "ok";
  if (status === 401) return "unauthorized";
  if (status === 503) return "locked";
  return "unreachable";
};

export const authHeaders = (token: string): Record<string, string> =>
  token.length > 0 ? { Authorization: `Bearer ${token}` } : {};

/** Only shared, validated quota copy may include details from a failed response. */
export const requestFailure = async (response: Response, context: string, origin: string): Promise<Error> => {
  const prefix = `${context} (${response.status})`;
  if (response.status !== 429) return new Error(prefix);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = handoffApiError(429, body);
  const selfHost = origin === HOSTED_DEMO_ORIGIN ? `Self-host: ${SELF_HOST_URL}` : "";
  return new Error([`${prefix}: ${error.message}`, error.ownerHelp, selfHost].filter(Boolean).join("\n"));
};

export const probeInstance = async (origin: string, token: string): Promise<Probe> => {
  const response = await fetch(new URL("/api/access", originOf(origin)), {
    headers: authHeaders(token),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 429) throw await requestFailure(response, "access check failed", origin);
  return tokenVerdict(response.status);
};

const jsonRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unexpected JSON response");
  }
  return value as Record<string, unknown>;
};

export const instanceConfig = async (origin: string): Promise<ClientConfig> => {
  const response = await fetch(new URL("/api/config", originOf(origin)), {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await requestFailure(response, "configuration unavailable", origin);
  const body = jsonRecord(await response.json());
  const { access, handoffTtlSeconds, maxHandoffBytes, turnstileSiteKey } = body;
  if ((access !== "private" && access !== "public") ||
      typeof handoffTtlSeconds !== "number" || !Number.isInteger(handoffTtlSeconds) || handoffTtlSeconds <= 0 ||
      typeof maxHandoffBytes !== "number" || !Number.isInteger(maxHandoffBytes) || maxHandoffBytes <= 0 ||
      (turnstileSiteKey !== undefined && typeof turnstileSiteKey !== "string")) {
    throw new Error("invalid instance configuration");
  }
  return {
    access, handoffTtlSeconds, maxHandoffBytes,
    ...(typeof turnstileSiteKey === "string" ? { turnstileSiteKey } : {}),
  };
};

/** Canonical local SPKI; never substitute a key returned by the server. */
export const recipientIdentity = (publicPem: string) => {
  const key = createPublicKey(publicPem);
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 4096) {
    throw new Error("recipient key must be RSA, 2048–4096 bits");
  }
  const spki = key.export({ format: "der", type: "spki" });
  return {
    encoded: spki.toString("base64url"),
    fingerprint: createHash("sha256").update(spki).digest("hex"),
  };
};
