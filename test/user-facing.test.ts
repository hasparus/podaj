import { describe, expect, it } from "vitest";
import { apiHandoffErrorText, HandoffApiError, isHostedDemoLimit } from "../src/client/user-facing.js";

describe("hosted-demo limit detection", () => {
  it("explains the actual already-filled server error without exposing HTTP plumbing", () => {
    expect(apiHandoffErrorText("already filled", 409)).toBe("This link has already been filled.");
  });
  it.each([
    ["https://podaj.fyi", 429, true],
    ["https://podaj.fyi", 503, false],
    ["https://podaj.fyi", 401, false],
    ["https://self-hosted.example", 429, false],
    ["https://podaj.fyi.attacker.example", 429, false],
    ["http://localhost:5180", 429, false],
  ] as const)("uses the exact demo origin and actual HTTP status: %s / %i", (origin, status, expected) => {
    expect(isHostedDemoLimit(origin, new HandoffApiError(status, "response failure"))).toBe(expected);
  });

  it("does not mistake arbitrary errors or matching message text for an HTTP limit", () => {
    expect(isHostedDemoLimit("https://podaj.fyi", new Error("rate limited"))).toBe(false);
    expect(isHostedDemoLimit("https://podaj.fyi", { status: 429 })).toBe(false);
  });

  it("keeps unidentified limit errors brief", () => {
    expect(apiHandoffErrorText("rate limited", 429)).toBe("Request limit reached.");
    expect(apiHandoffErrorText(undefined, 429)).toBe("Request limit reached.");
  });
});
