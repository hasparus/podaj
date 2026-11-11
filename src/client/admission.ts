import { Effect, Schedule } from "effect";
import { publicKeyFingerprint, publicKeyFromFragment, validateRecipientPublicKey } from "../crypto/podaj1.js";
import { CAPABILITY } from "../handoffs/protocol.js";
import { responseJson } from "./http.js";
import { HandoffApiError } from "./user-facing.js";

export interface AdmissionProof {
  challenge: string;
  recipientPublicKey: string;
}

export interface Writer {
  id: string;
  writeToken: string;
}

const FAILURE = "Couldn't open this request. Ask for a new link.";

export const parseLegacyAdmissionProof = (hash: string): AdmissionProof => {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const challenge = params.get("challenge");
  const recipient = params.get("recipient");
  if (challenge === null || !CAPABILITY.test(challenge) || recipient === null
    || params.getAll("challenge").length !== 1 || params.getAll("recipient").length !== 1
    || [...params.keys()].some((key) => key !== "challenge" && key !== "recipient")) {
    throw new Error("This verification link is incomplete. Ask for a new link.");
  }
  return { challenge, recipientPublicKey: publicKeyFromFragment(recipient) };
};

export const admissionProofData = async (request: AdmissionProof): Promise<string> => {
  await validateRecipientPublicKey(request.recipientPublicKey);
  const fingerprint = await publicKeyFingerprint(request.recipientPublicKey);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${request.challenge}.${fingerprint}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const approveAdmission = async (
  request: AdmissionProof, turnstileToken: string, signal = AbortSignal.timeout(10_000),
): Promise<void> => {
  const failure = "Verification failed. Reload this page to try again.";
  try {
    const data = await responseJson(await fetch("/api/demo/approve", {
      body: JSON.stringify({ challenge: request.challenge, recipientPublicKey: request.recipientPublicKey, turnstileToken }),
      headers: { "Content-Type": "application/json" }, method: "POST",
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }), failure);
    if (typeof data !== "object" || data === null || !("approved" in data) || data.approved !== true
      || !("expiresAt" in data) || typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt)) {
      throw new Error(failure);
    }
  } catch (error) {
    if (error instanceof HandoffApiError) { throw error; }
    // eslint-disable-next-line preserve-caught-error
    throw new Error(failure);
  }
};

export const requestIsWritable = async (
  request: Writer, signal = AbortSignal.timeout(10_000),
): Promise<boolean> => {
  try {
    const body = await responseJson(await fetch(`/api/handoffs/${request.id}/writable`, {
      headers: { Authorization: `Bearer ${request.writeToken}` },
      cache: "no-store", redirect: "error", signal,
    }), FAILURE);
    if (typeof body !== "object" || body === null || !("authorized" in body) || body.authorized !== true) {
      throw new Error(FAILURE);
    }
    return true;
  } catch (error) {
    if (error instanceof HandoffApiError) {
      if (error.status === 410) { return false; }
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error
    throw new Error(FAILURE);
  }
};

/** Wait with writer authority only. Navigation and link secrets belong to the caller. */
export const waitForReservation = async (
  writer: Writer, options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> => {
  const deadline = AbortSignal.timeout(Math.min(options.timeoutMs ?? 130_000, 130_000));
  const signal = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
  const poll = Effect.tryPromise({
    try: (abort) => requestIsWritable(writer, AbortSignal.any([abort, AbortSignal.timeout(10_000)])),
    catch: (error) => error,
  }).pipe(
    Effect.repeat({ until: (writable) => writable, schedule: Schedule.spaced(Math.max(1, options.intervalMs ?? 1000)) }),
    Effect.match({
      onSuccess: () => ({ ok: true as const }),
      onFailure: (error) => ({ ok: false as const, error }),
    }),
  );
  try {
    const result = await Effect.runPromise(poll, { signal });
    if (!result.ok) { throw result.error; }
  } catch (error) {
    if (!deadline.aborted) { throw error; }
    // eslint-disable-next-line preserve-caught-error
    throw new Error("The request didn't become available. Ask for a new link and keep the requesting CLI running.");
  }
};
