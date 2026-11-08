import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { CapabilityPolicy } from "./policy.js";
import { CAPABILITY, HANDOFF_ID } from "./protocol.js";

export const HandoffId = Schema.String.check(Schema.isPattern(HANDOFF_ID));
export const Capability = Schema.String.check(Schema.isPattern(CAPABILITY));
export const PublicKey = Schema.String.check(Schema.isMaxLength(2048));
export const VerificationFields = Schema.Struct({
  challenge: Capability,
  turnstileToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export const ReserveBody = Schema.Struct({ recipientPublicKey: PublicKey });
export const ApprovalBody = Schema.Struct({
  ...ReserveBody.fields,
  ...VerificationFields.fields,
});
export const FillBody = Schema.Struct({ sealed: Schema.String });
export const Config = Schema.Struct({
  mode: Schema.Literals(["private", "demo"]),
  handoffTtlSeconds: Schema.Number,
  maxHandoffBytes: Schema.Number,
  turnstileSiteKey: Schema.optional(Schema.String),
});
export const Access = Schema.Struct({ mode: Schema.Literals(["private", "demo"]), authorized: Schema.Literal(true) });
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
export const ErrorBody = Schema.Struct({ error: Schema.String });
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
    HttpApiEndpoint.post("reserve", "/api/handoffs/reserve", {
      payload: ReserveBody, success: Reservation, error: errors,
    }),
    HttpApiEndpoint.put("fill", "/api/handoffs/:id", {
      params: { id: HandoffId }, payload: FillBody, success: [Filled, Gone], error: errors,
    }).middleware(CapabilityPolicy),
    HttpApiEndpoint.get("status", "/api/handoffs/:id/status", {
      params: { id: HandoffId }, success: [Status, Gone], error: errors,
    }).middleware(CapabilityPolicy),
    HttpApiEndpoint.post("consume", "/api/handoffs/:id/consume", {
      params: { id: HandoffId }, success: [Consumed, Gone], error: errors,
    }).middleware(CapabilityPolicy),
    HttpApiEndpoint.get("rejectRead", "/api/handoffs/:id", { params: { id: HandoffId } }),
  ).middleware(SchemaRefusal),
);
