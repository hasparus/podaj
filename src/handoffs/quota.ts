export const QUOTA_KINDS = [
  "api_requests",
  "live_handoffs",
  "reservations_daily",
  "reservations_per_credential",
  "verification_attempts_daily",
  "verification_attempts_per_ip",
  "approvals_daily",
  "sockets_global",
  "sockets_per_handoff",
] as const;

export type QuotaKind = (typeof QUOTA_KINDS)[number];

export interface QuotaInfo {
  kind: QuotaKind;
  limit?: number;
  periodSeconds?: number;
  resetAt?: number;
}

export const parseQuotaInfo = (value: unknown): QuotaInfo | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("kind" in value)) { return undefined; }
  const kind = QUOTA_KINDS.find((candidate) => candidate === value.kind);
  if (kind === undefined) { return undefined; }
  const limit = "limit" in value ? value.limit : undefined;
  const periodSeconds = "periodSeconds" in value ? value.periodSeconds : undefined;
  const resetAt = "resetAt" in value ? value.resetAt : undefined;
  for (const number of [limit, periodSeconds, resetAt]) {
    if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)) { return undefined; }
  }
  if (kind !== "api_requests" && limit === undefined) { return undefined; }
  return {
    kind,
    ...(typeof limit === "number" ? { limit } : {}),
    ...(typeof periodSeconds === "number" ? { periodSeconds } : {}),
    ...(typeof resetAt === "number" ? { resetAt } : {}),
  };
};
