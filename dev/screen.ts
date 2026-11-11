import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/500.css";
import "../src/client/styles.css";
import "./screen.css";
import { Runtime } from "foldkit";
import { ModelSchema, view } from "../src/client/app.js";
import authorizationHtml from "../authorize.html?raw";
import { isScreenId, previewUpdate, SCREENS, screenModel, verificationPreview } from "./screens.js";

const id = new URLSearchParams(globalThis.location.search).get("screen");
if (!isScreenId(id)) { throw new TypeError("choose a known canvas screen"); }
const screen = SCREENS.find((entry) => entry.id === id);
if (!screen) { throw new TypeError("screen fixture missing"); }

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location.href);
  if (url.origin !== globalThis.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/parties/")) {
    throw new Error("canvas previews never contact a handoff API");
  }
  return await originalFetch(input, options);
};

if (screen.group === "verify") {
  const parsed = new DOMParser().parseFromString(authorizationHtml, "text/html");
  for (const script of parsed.body.querySelectorAll("script")) { script.remove(); }
  document.body.className = parsed.body.className;
  document.body.replaceChildren(...parsed.body.childNodes);
  const status = document.querySelector("#authorize-status");
  const slot = document.querySelector("#turnstile");
  if (!(status instanceof HTMLElement) || !(slot instanceof HTMLElement)) { throw new TypeError("authorization markup missing"); }
  const state = verificationPreview(screen.id);
  status.textContent = state.text;
  status.className = state.status;
  if (state.widget !== "loading") {
    const placeholder = document.createElement("div");
    placeholder.className = `canvas-turnstile ${state.widget}`;
    placeholder.setAttribute("role", "img");
    placeholder.setAttribute("aria-label", `Turnstile ${state.widget} — simulated preview`);
    const name = document.createElement("strong");
    name.textContent = "Turnstile";
    const label = document.createElement("span");
    label.textContent = `${state.widget.charAt(0).toUpperCase()}${state.widget.slice(1)} · visual placeholder`;
    placeholder.replaceChildren(name, label);
    slot.appendChild(placeholder);
  }
} else {
  const container = document.querySelector("#app");
  if (!(container instanceof HTMLElement)) { throw new TypeError("preview container missing"); }
  const application = Runtime.makeApplication({
    Model: ModelSchema,
    container,
    init: () => ({ model: screenModel(screen.id) }),
    update: previewUpdate,
    view,
  });
  Runtime.run(application);
}
