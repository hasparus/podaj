import { openRequestContext, type SenderContextV1 } from "../crypto/request-context.js";
import { decodeStoredRequestContext } from "../handoffs/context-contract.js";
import { REQUEST_CONTEXT_LIMITS } from "../handoffs/protocol.js";
import { responseJson } from "./http.js";
import { HandoffApiError } from "./user-facing.js";

export interface ContextLink {
  id: string;
  key: string;
}

const FAILURE = "Couldn't open this request. Ask for a new link.";
const CONTEXT_PATH = /^\/(?:s|authorize)\/(?<id>[a-f0-9]{32})$/u;
const KEY_FRAGMENT = /^#[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const MAX_REPLY_BYTES = REQUEST_CONTEXT_LIMITS.maxEncodedBytes + 1024;

export const parseContextLink = (pathname: string, hash: string): ContextLink | null => {
  const id = CONTEXT_PATH.exec(pathname)?.groups?.id;
  if (id === undefined || !KEY_FRAGMENT.test(hash)) { return null; }
  return { id, key: hash.slice(1) };
};

export const loadRequestContext = async (link: ContextLink): Promise<SenderContextV1> => {
  try {
    if (parseContextLink(`/s/${link.id}`, `#${link.key}`) === null) { throw new Error(FAILURE); }
    const response = await fetch(`/api/contexts/${link.id}`, {
      method: "GET", cache: "no-store", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(10_000),
    });
    const data = decodeStoredRequestContext(await responseJson(response, FAILURE, MAX_REPLY_BYTES));
    // eslint-disable-next-line foldkit/no-impure-call-at-decision-time
    const now = Date.now();
    if (data.id !== link.id || data.expiresAt <= now) {
      throw new Error(FAILURE);
    }
    return await openRequestContext(link.id, link.key, data.encryptedContext);
  } catch (error) {
    if (error instanceof HandoffApiError) {
      if ([404, 410].includes(error.status)) {
        throw new HandoffApiError(error.status, "This link was already used or expired. Ask for a new link.");
      }
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error
    throw new Error(FAILURE);
  }
};
