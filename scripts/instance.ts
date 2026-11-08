import type { ClientConfig } from "../src/handoffs/protocol.js";

export type Probe = "ok" | "unauthorized" | "locked" | "unreachable";
export interface AuthorizationOptions { attempts?: number; intervalMs?: number; timeoutMs?: number }

import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

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

export const probeInstance = async (origin: string, token: string): Promise<Probe> => {
  const response = await fetch(new URL("/api/access", originOf(origin)), {
    headers: authHeaders(token),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
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
  if (!response.ok) throw new Error(`configuration unavailable (${response.status})`);
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

/** The browser receives the challenge, never the verifier. */
export const authorizeDemo = async (origin: string, publicPem: string, note: (message: string) => void, options: AuthorizationOptions = {}) => {
  const { encoded, fingerprint } = recipientIdentity(publicPem);
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("hex");
  const url = new URL("/authorize", originOf(origin));
  url.hash = new URLSearchParams({ challenge, recipient: encoded }).toString();
  note(`authorize this request in your browser:\n${url}`);
  const deadline = AbortSignal.timeout(Math.min(options.timeoutMs ?? 130_000, 130_000));
  const attempts = Math.min(options.attempts ?? 60, 60);
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await fetch(new URL("/api/demo/status", originOf(origin)), {
        headers: authHeaders(verifier),
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      });
      const body = jsonRecord(await response.json());
      if (response.status === 200 && body.status === "approved") {
        if (body.recipientFingerprint !== fingerprint) {
          throw new Error("authorization recipient fingerprint does not match local key");
        }
        if (typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt) || body.expiresAt <= 0) {
          throw new Error("invalid authorization expiry");
        }
        return verifier;
      }
      if (response.status !== 202 || body.status !== "pending") {
        throw new Error(`authorization failed (${response.status})`);
      }
      if (attempt + 1 < attempts) {
        await delay(options.intervalMs ?? 2_000, undefined, { signal: deadline });
      }
    }
  } catch (error) {
    if (!deadline.aborted) throw error;
  }
  throw new Error("timed out waiting for browser authorization");
};
