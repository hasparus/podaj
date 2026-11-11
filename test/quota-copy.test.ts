import { describe, expect, it } from "vitest";
import { quotaExplanation } from "../src/client/quota-copy.js";
import { handoffApiError } from "../src/client/user-facing.js";
import { parseQuotaInfo, type QuotaInfo } from "../src/handoffs/quota.js";

const resetAt = Date.UTC(2030, 0, 2, 12, 34);

describe("quota diagnostics", () => {
  it.each([
    [{ kind: "context_drafts_daily", limit: 37, periodSeconds: 86400, resetAt }, "37", "draftsPerDay"],
    [{ kind: "context_drafts_per_ip", limit: 4, periodSeconds: 60, resetAt }, "4", "draftsPerMinutePerIp"],
    [{ kind: "context_drafts_live", limit: 23 }, "23", "liveDrafts"],
    [{ kind: "live_handoffs", limit: 29 }, "Active handoff limit reached (29)", "liveHandoffs"],
    [{ kind: "reservations_daily", limit: 137, periodSeconds: 86400, resetAt }, "Daily handoff limit reached (137)", "reservationsPerDay"],
    [{ kind: "reservations_per_credential", limit: 3, periodSeconds: 86400, resetAt }, "3 handoffs", "reservationsPerCredentialPerDay"],
    [{ kind: "verification_attempts_daily", limit: 99, periodSeconds: 86400, resetAt }, "Daily verification limit reached (99 attempts)", "approvalAttemptsPerDay"],
    [{ kind: "verification_attempts_per_ip", limit: 7, periodSeconds: 90, resetAt }, "7 attempts per 90 seconds", "approvalAttemptsPerMinutePerIp"],
    [{ kind: "approvals_daily", limit: 41, periodSeconds: 86400, resetAt }, "Daily CLI approval limit reached (41)", "approvalsPerDay"],
    [{ kind: "sockets_global", limit: 17 }, "Live connection limit reached (17)", "sockets"],
    [{ kind: "sockets_per_handoff", limit: 4 }, "Connection limit reached for this handoff (4)", "socketsPerHandoff"],
  ] satisfies [QuotaInfo, string, string][])("uses reported numbers and real owner controls for %j", (quota, text, setting) => {
    const explanation = quotaExplanation(quota);
    expect(explanation.text).toContain(text);
    expect(explanation.ownerHelp).toContain(`DEMO_LIMITS.${setting}`);
    expect(explanation.ownerHelp).toContain("and redeploy");
    expect(explanation.text.length).toBeLessThanOrEqual(130);
    expect(explanation.ownerHelp.length).toBeLessThanOrEqual(180);
    expect(explanation.text).not.toMatch(/did not report|does not report/u);
    if ("resetAt" in quota) { expect(explanation.text).toContain("12:34 UTC"); }
    else { expect(explanation.text).not.toContain("Resets at"); }
  });

  it("does not invent numbers or reset times for the native rate-limit binding", () => {
    const explanation = quotaExplanation({ kind: "api_requests" });
    expect(explanation.text).toBe("Too many requests from this IP.");
    expect(explanation.text).not.toMatch(/\d/u);
    expect(explanation.ownerHelp).toContain("PUBLIC_API_LIMITER");
    expect(explanation.ownerHelp).toContain("wrangler.jsonc");
    expect(explanation.ownerHelp.length).toBeLessThan(100);
  });

  it("distinguishes freeing active capacity from restoring the daily quota", () => {
    const capacity = quotaExplanation({ kind: "live_handoffs", limit: 200 });
    const daily = quotaExplanation({ kind: "reservations_daily", limit: 200, resetAt });
    expect(capacity.text).toContain("Collect one or wait for expiry");
    expect(capacity.ownerHelp).toContain("expire new handoffs sooner");
    expect(daily.text).not.toContain("Collect");
    expect(daily.ownerHelp).not.toContain("HANDOFF_TTL_SECONDS");
  });

  it.each([
    undefined, null, [], {}, { kind: "unknown", limit: 200 },
    { kind: "live_handoffs" }, { kind: "live_handoffs", limit: "200" },
    { kind: "live_handoffs", limit: -1 }, { kind: "live_handoffs", limit: 1.5 },
    { kind: "reservations_daily", limit: 200, resetAt: Number.POSITIVE_INFINITY },
    { kind: "verification_attempts_per_ip", limit: 10, periodSeconds: 0 },
  ])("rejects unusable quota metadata without inventing a diagnosis: %j", (quota) => {
    expect(parseQuotaInfo(quota)).toBeUndefined();
    const error = handoffApiError(429, { error: "private-secret", message: "private-secret", quota });
    expect(error.message).toBe("Request limit reached.");
    expect(error.ownerHelp).toBe("");
    expect(error.message).not.toContain("private-secret");
  });

  it("copies only recognized metadata fields and handles unrepresentable dates safely", () => {
    expect(parseQuotaInfo({ kind: "live_handoffs", limit: 200, secret: "private-secret" })).toEqual({ kind: "live_handoffs", limit: 200 });
    expect(quotaExplanation({ kind: "reservations_daily", limit: 200, resetAt: Number.MAX_SAFE_INTEGER }).text).toBe("Daily handoff limit reached (200).");
  });
});
