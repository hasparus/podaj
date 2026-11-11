import { Schema } from "effect";
import { publicKeyFingerprint, validateRecipientPublicKey } from "../crypto/podaj1.js";
import type { SenderContextV1 } from "../crypto/request-context.js";
import { requestIsWritable } from "./admission.js";
import { responseJson } from "./http.js";
import type { ComposeSource } from "./parse-route.js";
import { loadRequestContext } from "./request-context.js";
import { HandoffApiError } from "./user-facing.js";

export const Sender = Schema.Struct({
  handoffId: Schema.String, writeToken: Schema.String, publicKeyPem: Schema.String,
  fingerprint: Schema.String, maxHandoffBytes: Schema.Number,
});
export type Sender = typeof Sender.Type;

type PreparedCompose =
  | { _tag: "Ready"; sender: Sender; requestedKeys: readonly string[] }
  | { _tag: "Verify"; url: string };

const loadLimits = async (): Promise<number> => {
  const failure = "This instance has invalid limits.";
  let data: unknown;
  try {
    data = await responseJson(await fetch("/api/config", {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    }), failure);
  } catch (error) {
    if (error instanceof HandoffApiError) { throw error; }
    // eslint-disable-next-line preserve-caught-error
    throw new Error(failure);
  }
  if (typeof data !== "object" || data === null || !("maxHandoffBytes" in data)
    || typeof data.maxHandoffBytes !== "number" || !Number.isInteger(data.maxHandoffBytes)
    || data.maxHandoffBytes <= 0 || data.maxHandoffBytes > 1_048_576) { throw new Error(failure); }
  return data.maxHandoffBytes;
};

export const prepareCompose = async (source: ComposeSource): Promise<PreparedCompose> => {
  let context: Pick<SenderContextV1, "writeToken" | "recipientPublicKey" | "requestedKeys">;
  if (source._tag === "Encrypted") {
    const decrypted = await loadRequestContext(source);
    if (!await requestIsWritable({ id: source.id, writeToken: decrypted.writeToken })) {
      if (decrypted.challenge === undefined) { throw new Error("This link was already used or expired."); }
      return { _tag: "Verify", url: `/authorize/${source.id}#${source.key}` };
    }
    context = decrypted;
  } else {
    try { await validateRecipientPublicKey(source.recipientPublicKey); }
    catch { throw new Error("This fill link has an invalid recipient key. Ask for a new link."); }
    context = source;
  }
  const [fingerprint, maxHandoffBytes] = await Promise.all([
    publicKeyFingerprint(context.recipientPublicKey).catch(() => {
      throw new Error("Couldn't open this request. Ask for a new link.");
    }),
    loadLimits(),
  ]);
  return {
    _tag: "Ready",
    sender: {
      handoffId: source.id, writeToken: context.writeToken, publicKeyPem: context.recipientPublicKey,
      fingerprint, maxHandoffBytes,
    },
    requestedKeys: context.requestedKeys,
  };
};
