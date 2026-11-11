import { Schema } from "effect";
import { CAPABILITY, ENCRYPTED_CONTEXT, HANDOFF_ID, REQUEST_CONTEXT_LIMITS } from "./protocol.js";

/** Opaque sender-context transport. Plaintext authority is defined separately by SenderContextV1. */
export const EncryptedContext = Schema.String.check(
  Schema.isMinLength(39),
  Schema.isMaxLength(REQUEST_CONTEXT_LIMITS.maxEncodedBytes),
  Schema.isPattern(ENCRYPTED_CONTEXT),
);
export const CreateContextInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(HANDOFF_ID)),
  writeHash: Schema.String.check(Schema.isPattern(CAPABILITY)),
  encryptedContext: EncryptedContext,
});
export const StoredRequestContextSchema = Schema.Struct({
  id: CreateContextInput.fields.id,
  encryptedContext: EncryptedContext,
  expiresAt: Schema.Number.check(Schema.isFinite()),
});
export type StoredRequestContext = typeof StoredRequestContextSchema.Type;

export const decodeCreateContextInput = Schema.decodeUnknownSync(CreateContextInput, { onExcessProperty: "error" });
export const decodeStoredRequestContext = Schema.decodeUnknownSync(StoredRequestContextSchema, { onExcessProperty: "error" });
