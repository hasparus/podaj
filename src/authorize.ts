import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/500.css";
import { publicKeyFingerprint, publicKeyFromFragment, validateRecipientPublicKey } from "./crypto/podaj1.js";
import { CAPABILITY } from "./handoffs/protocol.js";
import { apiHandoffErrorText } from "./client/user-facing.js";

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

interface Turnstile {
  render: (container: HTMLElement, options: {
    sitekey: string;
    action: "podaj-admission";
    cData: string;
    callback: (token: string) => Promise<void>;
    "error-callback": () => void;
    "expired-callback": () => void;
    theme: "dark";
  }) => string;
}

declare global {
  interface Window { turnstile?: Turnstile }
}

const loadTurnstile = async (): Promise<Turnstile> => {
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  const loaded = new Promise<void>((resolve, reject) => {
    script.addEventListener("load", () => { resolve(); }, { once: true });
    script.addEventListener("error", () => {
      reject(new Error("Couldn't load verification. Check your connection and reload this page."));
    }, { once: true });
  });
  document.head.appendChild(script);
  await loaded;
  if (!window.turnstile) {throw new Error("Verification isn't available. Reload this page to try again.");}
  return window.turnstile;
};

export const mountAuthorizationPage = async (): Promise<void> => {
  const status = document.querySelector("#authorize-status");
  const container = document.querySelector("#turnstile");
  if (!(status instanceof HTMLElement) || !(container instanceof HTMLElement)) {return;}
  const showError = (text: string) => { status.textContent = text; status.className = "status error"; };
  try {
    const request = parseAuthorizationRequest(globalThis.location.hash);
    await validateRecipientPublicKey(request.recipientPublicKey);
    const fingerprint = await publicKeyFingerprint(request.recipientPublicKey);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${request.challenge}.${fingerprint}`));
    const cData = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const response = await fetch("/api/config", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {throw new Error("Verification isn't configured on this instance.");}
    const config: unknown = await response.json();
    if (typeof config !== "object" || config === null || !("mode" in config) || config.mode !== "demo"
      || !("turnstileSiteKey" in config) || typeof config.turnstileSiteKey !== "string" || !config.turnstileSiteKey) {
      throw new Error("Verification isn't configured on this instance.");
    }
    const turnstile = await loadTurnstile();
    let approving = false;
    let approved = false;
    turnstile.render(container, {
      action: "podaj-admission",
      cData,
      callback: async (token) => {
        if (approving || approved) {
          return;
        }
        approving = true;
        status.textContent = "checking verification…";
        try {
          await approveAdmission(request, token);
          approved = true;
          status.className = "status ok";
          status.textContent = "verified. Your CLI can now create the fill link. You can close this tab.";
        } catch (error) {
          showError(error instanceof Error ? error.message : "Verification failed. Reload this page to try again.");
        } finally {
          approving = false;
        }
      },
      "error-callback": () => { showError("Verification failed. Check your connection and reload this page."); },
      "expired-callback": () => {
        if (!approved && !approving) {
          showError("Verification expired. Reload this page to try again.");
        }
      },
      sitekey: config.turnstileSiteKey,
      theme: "dark",
    });
    status.textContent = "complete verification above, then return to your CLI.";
  } catch (error) {
    showError(error instanceof Error ? error.message : "Couldn't start verification. Ask the CLI for a new link.");
  }
};

if (typeof document !== "undefined" && document.querySelector("#authorize-status")) {
  void mountAuthorizationPage();
}
