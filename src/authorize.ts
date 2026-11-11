import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/500.css";
import type { AdmissionProof, Writer } from "./client/admission.js";
import { admissionProofData, approveAdmission, parseLegacyAdmissionProof, requestIsWritable, waitForReservation } from "./client/admission.js";
import { responseJson } from "./client/http.js";
import type { ContextLink } from "./client/request-context.js";
import { loadRequestContext, parseContextLink } from "./client/request-context.js";
import { AUTHORIZATION_STATUS, HandoffApiError, isHostedDemoLimit, SELF_HOST_URL } from "./client/user-facing.js";

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

const approvalMarker = (id: string) => `podaj:approved:${id}`;

const hasApproval = (id: string, challenge: string): boolean => {
  try { return globalThis.sessionStorage.getItem(approvalMarker(id)) === challenge; }
  catch { return false; }
};

const recordApproval = (id: string, challenge: string): boolean => {
  try { globalThis.sessionStorage.setItem(approvalMarker(id), challenge); return true; }
  catch { return false; }
};

type VerificationState = "loading" | "idle" | "checking" | "approved" | "failed" | "finished";
type AuthorizationRequest =
  | { kind: "legacy"; proof: AdmissionProof }
  | { kind: "short"; proof: AdmissionProof; writer: Writer; link: ContextLink };

const showVerified = (status: HTMLElement): void => {
  status.className = "status ok";
  status.textContent = AUTHORIZATION_STATUS.verified;
};

const loadVerificationSiteKey = async (signal: AbortSignal): Promise<string> => {
  const failure = "Verification isn't configured on this instance.";
  let config: unknown;
  try {
    config = await responseJson(await fetch("/api/config", {
      cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }), failure);
  } catch (error) {
    if (error instanceof HandoffApiError) { throw error; }
    // eslint-disable-next-line preserve-caught-error
    throw new Error(failure);
  }
  if (typeof config !== "object" || config === null || !("access" in config) || config.access !== "public"
    || !("turnstileSiteKey" in config) || typeof config.turnstileSiteKey !== "string" || !config.turnstileSiteKey) {
    throw new Error(failure);
  }
  return config.turnstileSiteKey;
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
  let state: VerificationState = "loading";
  const stopped = new AbortController();
  const finished = () => state === "finished";
  const fail = (error: unknown, fallback: string) => {
    if (finished()) { return; }
    state = "finished";
    stopped.abort();
    showFailure(error, fallback);
  };
  status.textContent = AUTHORIZATION_STATUS.loading;
  try {
    let request: AuthorizationRequest;
    if (["/authorize", "/authorize/", "/authorize.html"].includes(globalThis.location.pathname)) {
      request = { kind: "legacy", proof: parseLegacyAdmissionProof(globalThis.location.hash) };
    } else {
      const link = parseContextLink(globalThis.location.pathname, globalThis.location.hash);
      if (link === null || !globalThis.location.pathname.startsWith("/authorize/")) {
        throw new Error("This verification link is incomplete. Ask for a new link.");
      }
      const context = await loadRequestContext(link);
      const writer = { id: link.id, writeToken: context.writeToken };
      if (context.challenge === undefined || await requestIsWritable(writer)) {
        state = "finished";
        globalThis.location.replace(`/s/${link.id}#${link.key}`);
        return;
      }
      request = {
        kind: "short", link,
        proof: { challenge: context.challenge, recipientPublicKey: context.recipientPublicKey }, writer,
      };
    }
    const { proof } = request;
    if (request.kind === "short") {
      const { writer, link } = request;
      const watchReservation = async () => {
        try {
          await waitForReservation(writer, { intervalMs: 3000, signal: stopped.signal });
          if (finished()) { return; }
          state = "finished";
          stopped.abort();
          globalThis.location.replace(`/s/${link.id}#${link.key}`);
        } catch (error) { fail(error, "Couldn't open this request. Ask for a new link."); }
      };
      if (hasApproval(link.id, proof.challenge)) {
        state = "approved";
        showVerified(status);
        void watchReservation();
        return;
      }
      void watchReservation();
    }
    const cData = await admissionProofData(proof);
    if (finished()) { return; }
    const sitekey = await loadVerificationSiteKey(stopped.signal);
    if (finished()) { return; }
    const turnstile = await loadTurnstile();
    if (finished()) { return; }
    state = "idle";
    status.textContent = AUTHORIZATION_STATUS.waiting;
    turnstile.render(container, {
      action: "podaj-admission",
      cData,
      callback: async (token) => {
        if (state !== "idle" && state !== "failed") { return; }
        state = "checking";
        status.className = "status";
        status.textContent = AUTHORIZATION_STATUS.checking;
        try {
          try { await approveAdmission(proof, token, stopped.signal); }
          catch (error) {
            if (request.kind !== "short" || !(error instanceof HandoffApiError) || error.status !== 409) { throw error; }
          }
          if (finished()) { return; }
          if (request.kind === "legacy") {
            state = "finished";
            status.className = "status ok";
            status.textContent = "Verified. Return to your CLI.";
            return;
          }
          recordApproval(request.link.id, proof.challenge);
          state = "approved";
          showVerified(status);
        } catch (error) {
          if (finished()) { return; }
          state = "failed";
          showFailure(error, "Verification failed. Reload this page to try again.");
        }
      },
      "error-callback": () => {
        if (state !== "idle" && state !== "failed") { return; }
        state = "failed";
        showError(AUTHORIZATION_STATUS.failed);
      },
      "expired-callback": () => {
        if (state !== "idle" && state !== "failed") { return; }
        state = "failed";
        showError(AUTHORIZATION_STATUS.expired);
      },
      sitekey,
      theme: "dark",
    });
  } catch (error) {
    fail(error, "Couldn't start verification. Ask for a new link.");
  }
};

if (typeof document !== "undefined" && document.querySelector("#authorize-status")) {
  void mountAuthorizationPage();
}
