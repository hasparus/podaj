import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/500.css";
import { admissionProofData, approveAdmission, parseAuthorizationRequest } from "./client/admission.js";
import { AUTHORIZATION_STATUS, handoffApiError, HandoffApiError, isHostedDemoLimit, SELF_HOST_URL } from "./client/user-facing.js";

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
  const showFailure = (error: unknown, fallback: string) => {
    if (error instanceof HandoffApiError && error.status === 429) {
      status.replaceChildren(document.createTextNode(error.message));
      if (isHostedDemoLimit(globalThis.location.origin, error)) {
        const link = document.createElement("a");
        link.href = SELF_HOST_URL;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "self-host Podaj";
        status.appendChild(document.createTextNode(" You can also "));
        status.appendChild(link);
        status.appendChild(document.createTextNode("."));
      }
      if (error.ownerHelp) {
        const details = document.createElement("details");
        details.className = "limit-help";
        const summary = document.createElement("summary");
        summary.textContent = "Owner settings";
        const help = document.createElement("p");
        help.textContent = error.ownerHelp;
        details.replaceChildren(summary, help);
        status.appendChild(details);
      }
      status.className = "status error";
      return;
    }
    showError(error instanceof Error ? error.message : fallback);
  };
  status.textContent = AUTHORIZATION_STATUS.loading;
  try {
    const request = parseAuthorizationRequest(globalThis.location.hash);
    const cData = await admissionProofData(request);
    const response = await fetch("/api/config", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      if (response.status === 429) { throw handoffApiError(response.status, await response.json().catch(() => ({}))); }
      throw new HandoffApiError(response.status, "Verification isn't configured on this instance.");
    }
    const config: unknown = await response.json();
    if (typeof config !== "object" || config === null || !("access" in config) || config.access !== "public"
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
        status.textContent = AUTHORIZATION_STATUS.checking;
        try {
          await approveAdmission(request, token);
          approved = true;
          status.className = "status ok";
          status.textContent = AUTHORIZATION_STATUS.verified;
        } catch (error) {
          showFailure(error, "Verification failed. Reload this page to try again.");
        } finally {
          approving = false;
        }
      },
      "error-callback": () => { showError(AUTHORIZATION_STATUS.failed); },
      "expired-callback": () => {
        if (!approved && !approving) {
          showError(AUTHORIZATION_STATUS.expired);
        }
      },
      sitekey: config.turnstileSiteKey,
      theme: "dark",
    });
    status.textContent = AUTHORIZATION_STATUS.waiting;
  } catch (error) {
    showFailure(error, "Couldn't start verification. Ask the CLI for a new link.");
  }
};

if (typeof document !== "undefined" && document.querySelector("#authorize-status")) {
  void mountAuthorizationPage();
}
