import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { CapabilityPolicy } from "./policy.js";
import { Quota } from "./errors.js";
import { CAPABILITY, HANDOFF_ID } from "./protocol.js";
import { CreateContextInput, StoredRequestContextSchema } from "./context-contract.js";

export const HandoffId = Schema.String.check(Schema.isPattern(HANDOFF_ID));
export const Capability = Schema.String.check(Schema.isPattern(CAPABILITY));
export const PublicKey = Schema.String.check(Schema.isMaxLength(2048));
export const VerificationFields = Schema.Struct({
  challenge: Capability,
  turnstileToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export const RecipientBody = Schema.Struct({ recipientPublicKey: PublicKey });
export const ReserveBody = Schema.Union([
  RecipientBody,
  Schema.Struct({ ...RecipientBody.fields, id: HandoffId, writeToken: Capability }),
]);
export const ApprovalBody = Schema.Struct({
  ...RecipientBody.fields,
  ...VerificationFields.fields,
});
export const CreatedContext = StoredRequestContextSchema.annotate({ httpApiStatus: 201 });
export const FillBody = Schema.Struct({ sealed: Schema.String });
export const Config = Schema.Struct({
  access: Schema.Literals(["private", "public"]),
  handoffTtlSeconds: Schema.Number,
  maxHandoffBytes: Schema.Number,
  turnstileSiteKey: Schema.optional(Schema.String),
});
export const Access = Schema.Struct({ access: Schema.Literals(["private", "public"]), authorized: Schema.Literal(true) });
export const Reserved = Schema.Struct({
  id: HandoffId,
  expiresAt: Schema.Number,
  recipientFingerprint: Capability,
});
export const Reservation = Schema.Struct({
  ...Reserved.fields,
  writeToken: Capability,
  readToken: Capability,
  subscribeToken: Capability,
  handoffTtlSeconds: Schema.Number,
}).annotate({ httpApiStatus: 201 });
export const Writable = Schema.Struct({ authorized: Schema.Literal(true) });
export const Filled = Schema.Struct({ id: HandoffId, expiresAt: Schema.Number });
export const Status = Schema.Struct({ status: Schema.Literals(["pending", "ready"]), expiresAt: Schema.Number });
export const Consumed = Schema.Struct({ sealed: Schema.String, recipientFingerprint: Capability });
export const Approved = Schema.Struct({ approved: Schema.Literal(true), expiresAt: Schema.Number });
export const CredentialPending = Schema.Struct({ status: Schema.Literal("pending") }).annotate({ httpApiStatus: 202 });
export const CredentialApproved = Schema.Struct({
  status: Schema.Literal("approved"),
  expiresAt: Schema.Number,
  recipientFingerprint: Capability,
});
export const ErrorBody = Schema.Struct({ error: Schema.String, quota: Schema.optional(Quota) });
export const Gone = Schema.Struct({ status: Schema.Literal("gone") }).annotate({ httpApiStatus: 410 });
const errors = [400, 401, 403, 404, 408, 409, 413, 415, 429, 503].map((httpApiStatus) => ErrorBody.annotate({ httpApiStatus }));

export class SchemaRefusal extends HttpApiMiddleware.Service<SchemaRefusal>()("podaj/SchemaRefusal") {}

export const HandoffsApi = HttpApi.make("podaj").add(
  HttpApiGroup.make("handoffs").add(
    HttpApiEndpoint.get("config", "/api/config", { success: Config, error: errors }),
    HttpApiEndpoint.get("access", "/api/access", { success: Access, error: errors }),
    HttpApiEndpoint.post("approveDemo", "/api/demo/approve", {
      payload: ApprovalBody, success: Approved, error: errors,
    }),
    HttpApiEndpoint.get("demoStatus", "/api/demo/status", {
      success: [CredentialPending, CredentialApproved], error: errors,
    }),
    HttpApiEndpoint.post("createContext", "/api/contexts", {
      payload: CreateContextInput, success: CreatedContext, error: errors,
    }),
    HttpApiEndpoint.get("getContext", "/api/contexts/:id", {
      params: { id: HandoffId }, success: StoredRequestContextSchema, error: errors,
    }),
    HttpApiEndpoint.post("reserve", "/api/handoffs/reserve", {
      payload: ReserveBody, success: Reservation, error: [...errors, Gone],
    }),
    HttpApiEndpoint.put("fill", "/api/handoffs/:id", {
      params: { id: HandoffId }, payload: FillBody, success: Filled, error: [...errors, Gone],
    }).middleware(CapabilityPolicy),
    HttpApiEndpoint.get("writable", "/api/handoffs/:id/writable", {
      params: { id: HandoffId }, success: Writable, error: [...errors, Gone],
    }).middleware(CapabilityPolicy),
    HttpApiEndpoint.get("status", "/api/handoffs/:id/status", {
      params: { id: HandoffId }, success: Status, error: [...errors, Gone],
    }).middleware(CapabilityPolicy),
    HttpApiEndpoint.post("consume", "/api/handoffs/:id/consume", {
      params: { id: HandoffId }, success: Consumed, error: [...errors, Gone],
    }).middleware(CapabilityPolicy),
    HttpApiEndpoint.get("rejectRead", "/api/handoffs/:id", { params: { id: HandoffId } }),
  ).middleware(SchemaRefusal),
).annotate(HttpApi.SuccessParseOptions, { onExcessProperty: "error" });
