import type { Model } from "../src/client/app.js";
import { init, Message, update } from "../src/client/app.js";
import { apiHandoffErrorText, AUTHORIZATION_STATUS } from "../src/client/user-facing.js";
import { quotaExplanation } from "../src/client/quota-copy.js";

export interface CanvasScreen {
  id: string;
  group: "start" | "verify" | "fill" | "problems";
  title: string;
  state: string;
  route: string;
  note?: string;
}

export const SCREENS = [
  { group: "start", id: "landing", route: "/", state: "No request", title: "landing" },
  { group: "verify", id: "verify-loading", note: "Turnstile placeholder", route: "/authorize", state: "Loading", title: "verification" },
  { group: "verify", id: "verify-challenge", note: "Turnstile placeholder", route: "/authorize", state: "Waiting", title: "verification" },
  { group: "verify", id: "verify-success", note: "Turnstile placeholder", route: "/authorize", state: "Verified", title: "verification" },
  { group: "verify", id: "verify-error", note: "Turnstile placeholder", route: "/authorize", state: "Failed", title: "verification" },
  { group: "fill", id: "fill-loading", route: "/s/:id", state: "Loading", title: "fill request" },
  { group: "fill", id: "fill-empty", route: "/s/:id", state: "Empty", title: "fill request" },
  { group: "fill", id: "fill-editing", note: "Try add, show, or send", route: "/s/:id", state: "Editing", title: "fill request" },
  { group: "fill", id: "fill-sending", route: "/s/:id", state: "Sending", title: "fill request" },
  { group: "fill", id: "fill-sent", route: "/s/:id", state: "Sent", title: "fill request" },
  { group: "problems", id: "link-incomplete", route: "/s/:id", state: "Missing capability", title: "incomplete link" },
  { group: "problems", id: "recipient-invalid", route: "/s/:id", state: "Key refused", title: "invalid recipient" },
  { group: "problems", id: "fill-validation", route: "/s/:id", state: "Fix before sending", title: "duplicate name" },
  { group: "problems", id: "link-expired", route: "/s/:id", state: "Request a new link", title: "expired or used link" },
  { group: "problems", id: "send-unavailable", route: "/s/:id", state: "Values retained", title: "send unavailable" },
  { group: "problems", id: "send-limited", route: "/s/:id", state: "Try again later", title: "instance at capacity" },
] as const satisfies readonly CanvasScreen[];

export type ScreenId = (typeof SCREENS)[number]["id"];
type VerificationScreenId = Extract<ScreenId, `verify-${string}`>;
type AppScreenId = Exclude<ScreenId, VerificationScreenId>;

export const isScreenId = (value: string | null): value is ScreenId =>
  SCREENS.some((screen) => screen.id === value);

const pending = (): Model => init({
  page: "compose", source: { _tag: "Encrypted", id: "0".repeat(32), key: "canvas-only" },
}).model;

const ready = (): Model => update(pending(), Message.PreparedCompose({
  requestedKeys: [],
  sender: {
    fingerprint: "71a8d4e2c9f036b5".repeat(4), handoffId: "0".repeat(32), maxHandoffBytes: 32_768,
    publicKeyPem: "canvas-only: never execute transport commands", writeToken: "0".repeat(64),
  },
})).model;

const filled = (): Model => update(ready(), Message.PastedEnv({
  text: "DATABASE_URL=postgresql://demo:demo@localhost/example\nOPENAI_API_KEY=demo-only-not-a-real-key",
})).model;

const APP_MODELS: Record<AppScreenId, () => Model> = {
  "fill-editing": filled,
  "fill-empty": ready,
  "fill-loading": pending,
  "fill-sending": () => update(filled(), Message.ClickedSend()).model,
  "fill-sent": () => update(filled(), Message.SucceededSend()).model,
  "fill-validation": () => {
    const model = filled();
    const invalid = update(model, Message.ChangedRowKey({ key: "OPENAI_API_KEY", rowId: model.rows[0].id })).model;
    return update(invalid, Message.ClickedSend()).model;
  },
  "landing": () => init({ page: "landing" }).model,
  "link-expired": () => update(filled(), Message.FailedSend({ text: apiHandoffErrorText("gone", 410) })).model,
  "link-incomplete": () => init({ page: "compose", source: { _tag: "Invalid", id: "0".repeat(32) } }).model,
  "recipient-invalid": () => update(pending(), Message.FailedLoad({ text: "This fill link has an invalid recipient key. Ask for a new link." })).model,
  "send-limited": () => update(filled(), Message.ReachedRateLimit(quotaExplanation({ kind: "live_handoffs", limit: 200 }))).model,
  "send-unavailable": () => update(filled(), Message.FailedSend({ text: apiHandoffErrorText(undefined, 503) })).model,
};

export const screenModel = (id: AppScreenId): Model => APP_MODELS[id]();

export const previewUpdate = (model: Model, message: typeof Message.Type): { model: Model } => {
  const next = update(model, message).model;
  return { model: message._tag === "ClickedSend" && next.sending ? update(next, Message.SucceededSend()).model : next };
};

interface VerificationState {
  status: "status" | "status ok" | "status error";
  text: string;
  widget: "loading" | "waiting" | "verified" | "failed";
}

const VERIFICATION_STATES: Record<VerificationScreenId, VerificationState> = {
  "verify-challenge": { status: "status", text: AUTHORIZATION_STATUS.waiting, widget: "waiting" },
  "verify-error": { status: "status error", text: AUTHORIZATION_STATUS.failed, widget: "failed" },
  "verify-loading": { status: "status", text: AUTHORIZATION_STATUS.loading, widget: "loading" },
  "verify-success": { status: "status ok", text: AUTHORIZATION_STATUS.verified, widget: "verified" },
};

export const verificationPreview = (id: VerificationScreenId): VerificationState => VERIFICATION_STATES[id];
