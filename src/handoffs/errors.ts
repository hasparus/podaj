import { Schema } from "effect";
import { QUOTA_KINDS, type QuotaInfo } from "./quota.js";

export const Quota = Schema.Struct({
  kind: Schema.Literals(QUOTA_KINDS),
  limit: Schema.optional(Schema.Number),
  periodSeconds: Schema.optional(Schema.Number),
  resetAt: Schema.optional(Schema.Number),
});

/** Only fixed-window quotas have an authoritative retry time. */
export const quotaRetryHeaders = (quota: QuotaInfo | undefined): Record<string, string> =>
  quota?.resetAt === undefined ? {} : {
    "Retry-After": String(Math.max(0, Math.ceil((quota.resetAt - Date.now()) / 1000))),
  };

export class HandoffsApiError extends Schema.TaggedError<HandoffsApiError>()(
  "HandoffsApiError",
  {
    code: Schema.String,
    status: Schema.Number,
    quota: Schema.optional(Quota),
  },
) {}
