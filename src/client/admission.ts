import { publicKeyFingerprint, publicKeyFromFragment, validateRecipientPublicKey } from "../crypto/podaj1.js";
import { CAPABILITY } from "../handoffs/protocol.js";
import { apiHandoffErrorText } from "./user-facing.js";

export interface AuthorizationRequest {
  challenge: string;
  recipientPublicKey: string;
}

export const parseAuthorizationRequest = (hash: string): AuthorizationRequest => {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const challenge = params.get("challenge");
  const recipient = params.get("recipient");
  if (challenge === null || !CAPABILITY.test(challenge) || recipient === null
    || params.getAll("challenge").length !== 1 || params.getAll("recipient").length !== 1
    || [...params.keys()].some((key) => key !== "challenge" && key !== "recipient")) {
    throw new Error("This verification link is incomplete. Ask the CLI for a new one.");
  }
  return { challenge, recipientPublicKey: publicKeyFromFragment(recipient) };
};

export const admissionProofData = async (request: AuthorizationRequest): Promise<string> => {
  await validateRecipientPublicKey(request.recipientPublicKey);
  const fingerprint = await publicKeyFingerprint(request.recipientPublicKey);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${request.challenge}.${fingerprint}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const approveAdmission = async (request: AuthorizationRequest, turnstileToken: string): Promise<void> => {
  const response = await fetch("/api/demo/approve", {
    body: JSON.stringify({ ...request, turnstileToken }), headers: { "Content-Type": "application/json" }, method: "POST",
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => ({}));
    const code = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : undefined;
    throw new Error(apiHandoffErrorText(code, response.status));
  }
};
