import type { QuotaInfo } from "../handoffs/quota.js";

export interface QuotaExplanation {
  text: string;
  ownerHelp: string;
}

const sourceSetting = (name: string) =>
  `Raise DEMO_LIMITS.${name} in src/handoffs/protocol.ts and redeploy.`;

const resetText = (quota: QuotaInfo): string => {
  if (quota.resetAt === undefined) { return ""; }
  const reset = new Date(quota.resetAt);
  if (!Number.isFinite(reset.getTime())) { return ""; }
  return ` Resets at ${reset.toISOString().slice(11, 16)} UTC.`;
};

const UNKNOWN_QUOTA: QuotaExplanation = {
  text: "Request limit reached.",
  ownerHelp: "",
};

export const quotaExplanation = (quota?: QuotaInfo): QuotaExplanation => {
  if (quota === undefined || (quota.kind !== "api_requests" && quota.limit === undefined)) {
    return UNKNOWN_QUOTA;
  }
  const limit = quota.limit;
  switch (quota.kind) {
    case "api_requests": {
      return {
        text: "Too many requests from this IP.",
        ownerHelp: "Adjust PUBLIC_API_LIMITER’s simple.limit and simple.period in wrangler.jsonc, then redeploy.",
      };
    }
    case "context_drafts_daily": {
      return {
        text: `Daily request-link limit reached (${limit}).${resetText(quota)}`,
        ownerHelp: sourceSetting("draftsPerDay"),
      };
    }
    case "context_drafts_per_ip": {
      return {
        text: `Request-link limit reached for this IP (${limit}${quota.periodSeconds === undefined ? "" : ` per ${quota.periodSeconds} seconds`}).${resetText(quota)}`,
        ownerHelp: sourceSetting("draftsPerMinutePerIp"),
      };
    }
    case "context_drafts_live": {
      return {
        text: `Pending request-link limit reached (${limit}). Wait for expiry.`,
        ownerHelp: `${sourceSetting("liveDrafts")} Adjust REQUEST_CONTEXT_LIMITS.draftTtlMs in src/handoffs/protocol.ts to expire pending links sooner.`,
      };
    }
    case "live_handoffs": {
      return {
        text: `Active handoff limit reached (${limit}). Collect one or wait for expiry.`,
        ownerHelp: `${sourceSetting("liveHandoffs")} Lower HANDOFF_TTL_SECONDS to expire new handoffs sooner.`,
      };
    }
    case "reservations_daily": {
      return {
        text: `Daily handoff limit reached (${limit}).${resetText(quota)}`,
        ownerHelp: sourceSetting("reservationsPerDay"),
      };
    }
    case "reservations_per_credential": {
      return {
        text: `Daily limit reached: ${limit} handoffs per approval.${resetText(quota)}`,
        ownerHelp: sourceSetting("reservationsPerCredentialPerDay"),
      };
    }
    case "verification_attempts_daily": {
      return {
        text: `Daily verification limit reached (${limit} attempts).${resetText(quota)}`,
        ownerHelp: sourceSetting("approvalAttemptsPerDay"),
      };
    }
    case "verification_attempts_per_ip": {
      return {
        text: `Verification limit reached for this IP (${limit} attempts${quota.periodSeconds === undefined ? "" : ` per ${quota.periodSeconds} seconds`}).${resetText(quota)}`,
        ownerHelp: sourceSetting("approvalAttemptsPerMinutePerIp"),
      };
    }
    case "approvals_daily": {
      return {
        text: `Daily CLI approval limit reached (${limit}).${resetText(quota)}`,
        ownerHelp: sourceSetting("approvalsPerDay"),
      };
    }
    case "sockets_global": {
      return {
        text: `Live connection limit reached (${limit}). Close unused CLI sessions.`,
        ownerHelp: sourceSetting("sockets"),
      };
    }
    case "sockets_per_handoff": {
      return {
        text: `Connection limit reached for this handoff (${limit}). Close duplicate CLI sessions.`,
        ownerHelp: sourceSetting("socketsPerHandoff"),
      };
    }
    default: {
      return UNKNOWN_QUOTA;
    }
  }
};
