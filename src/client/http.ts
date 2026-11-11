import { handoffApiError } from "./user-facing.js";

const boundedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const length = response.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new Error("Invalid response length.");
  }
  if (response.body === null) { throw new Error("Missing response body."); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const next = await reader.read();
      if (next.done) { break; }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) { throw new Error("Response too large."); }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => null);
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
};

/** Bound every response before decoding. Never expose server text or JSON parser diagnostics. */
export const responseJson = async (response: Response, failure: string, maxBytes = 16_384): Promise<unknown> => {
  const data = await boundedJson(response, maxBytes).catch(() => {
    if (response.ok) { throw new Error(failure); }
    return null;
  });
  if (!response.ok) { throw handoffApiError(response.status, data); }
  return data;
};
