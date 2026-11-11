import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSchema, Message } from "../src/client/app.js";
import { AUTHORIZATION_STATUS } from "../src/client/user-facing.js";
import { isScreenId, previewUpdate, SCREENS, screenModel, verificationPreview } from "../dev/screens.js";

afterEach(() => vi.unstubAllGlobals());

describe("development screen canvas", () => {
  it("covers the browser surfaces and meaningful states with unique stable IDs", () => {
    expect(new Set(SCREENS.map((screen) => screen.id)).size).toBe(SCREENS.length);
    expect(new Set(SCREENS.map((screen) => screen.route))).toEqual(new Set(["/", "/authorize", "/s/:id"]));
    expect(new Set(SCREENS.map((screen) => screen.group))).toEqual(new Set(["start", "verify", "fill", "problems"]));
    expect(isScreenId("fill-editing")).toBe(true);
    expect(isScreenId("untrusted-screen")).toBe(false);
    expect(isScreenId(null)).toBe(false);
  });

  it("constructs every app fixture without executing load or transport commands", () => {
    const network = vi.fn(() => { throw new Error("canvas must remain offline"); });
    vi.stubGlobal("fetch", network);
    for (const screen of SCREENS.filter((entry) => entry.group !== "verify")) {
      expect(() => Schema.decodeUnknownSync(ModelSchema)(screenModel(screen.id))).not.toThrow();
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps the loading, editing, sending and cleared success views distinct", () => {
    expect(screenModel("fill-loading")).toMatchObject({ recipientReady: false, limitsReady: false });
    expect(screenModel("fill-empty")).toMatchObject({ recipientReady: true, limitsReady: true, rows: [{ key: "", value: "" }] });
    expect(screenModel("fill-editing").rows.filter((row) => row.value)).toHaveLength(2);
    expect(screenModel("fill-sending")).toMatchObject({ sending: true, sent: false });
    const sent = screenModel("fill-sent");
    expect(sent).toMatchObject({ sending: false, sent: true, status: { _tag: "Ok", text: "Sent." } });
    expect(sent.rows.every((row) => row.value === "" && !row.revealed)).toBe(true);
  });

  it("uses real form validation and API error copy", () => {
    expect(screenModel("fill-validation").status).toEqual({ _tag: "Error", text: "Duplicate key: OPENAI_API_KEY." });
    expect(screenModel("link-incomplete").status).toMatchObject({ _tag: "Error", text: expect.stringContaining("incomplete") });
    expect(screenModel("link-expired").status).toEqual({ _tag: "Error", text: "This link was already used or expired." });
    expect(screenModel("send-limited").status).toMatchObject({ _tag: "RateLimited", text: expect.stringContaining("Active handoff limit reached (200)"), ownerHelp: expect.stringContaining("HANDOFF_TTL_SECONDS") });
    expect(screenModel("send-unavailable").rows.some((row) => row.value)).toBe(true);
  });

  it("supports local form edits and simulated send without returning effects or calling an API", () => {
    const network = vi.fn(() => { throw new Error("canvas must remain offline"); });
    vi.stubGlobal("fetch", network);
    const start = screenModel("fill-editing");
    const shown = previewUpdate(start, Message.ClickedToggleReveal({ rowId: start.rows[0].id })).model;
    expect(shown.rows[0]?.revealed).toBe(true);
    const result = previewUpdate(shown, Message.ClickedSend());
    expect(Object.keys(result)).toEqual(["model"]);
    expect(result.model.sent).toBe(true);
    expect(result.model.rows.every((row) => !row.value)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps authorization copy sentence case and shared with the controller and initial HTML", () => {
    expect(AUTHORIZATION_STATUS).toEqual({
      loading: "Loading verification…",
      waiting: "Complete verification to continue.",
      checking: "Checking verification…",
      verified: "Verified. Return to your CLI.",
      failed: "Verification failed. Check your connection and reload this page.",
      expired: "Verification expired. Reload this page to try again.",
    });
    const html = readFileSync(new URL("../authorize.html", import.meta.url), "utf8");
    expect(html.match(/<p\b[^>]*id="authorize-status"[^>]*>([^<]*)<\/p>/u)?.[1]).toBe(AUTHORIZATION_STATUS.loading);
    const controller = readFileSync(new URL("../src/authorize.ts", import.meta.url), "utf8");
    for (const state of Object.keys(AUTHORIZATION_STATUS)) {
      expect(controller).toContain(`AUTHORIZATION_STATUS.${state}`);
    }
  });

  it("uses sentence case for preview paragraph metadata without changing fixture IDs or headings", () => {
    for (const screen of SCREENS) {
      expect(screen.state).toMatch(/^[A-Z]/u);
      expect(screen.id).toBe(screen.id.toLowerCase());
      expect(screen.title).toBe(screen.title.toLowerCase());
      if ("note" in screen) { expect(screen.note).toMatch(/^[A-Z]/u); }
    }
  });

  it("labels verification fixtures as simulated and represents each controller state", () => {
    expect(verificationPreview("verify-loading")).toMatchObject({ widget: "loading", text: AUTHORIZATION_STATUS.loading });
    expect(verificationPreview("verify-challenge")).toMatchObject({ widget: "waiting", text: AUTHORIZATION_STATUS.waiting });
    expect(verificationPreview("verify-success")).toMatchObject({ widget: "verified", status: "status ok", text: AUTHORIZATION_STATUS.verified });
    expect(verificationPreview("verify-error")).toMatchObject({ widget: "failed", status: "status error", text: AUTHORIZATION_STATUS.failed });
    expect(SCREENS.filter((screen) => screen.group === "verify").every((screen) => screen.note === "Turnstile placeholder")).toBe(true);
  });
});
