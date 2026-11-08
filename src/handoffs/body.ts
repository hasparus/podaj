import { HandoffsApiError } from "./errors.js";

const requireJsonMetadata = (request: Request, maxBytes: number): void => {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    throw new HandoffsApiError({ status: 413, code: "payload too large" });
  }
  const encoding = request.headers.get("Content-Encoding");
  if (encoding !== null && encoding !== "identity") {
    throw new HandoffsApiError({ status: 415, code: "unsupported encoding" });
  }
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HandoffsApiError({ status: 415, code: "expected json" });
  }
};

export const readJsonBody = async (request: Request, maxBytes: number): Promise<Record<string, unknown>> => {
  requireJsonMetadata(request, maxBytes);
  const reader = request.body?.getReader();
  if (reader === undefined) throw new HandoffsApiError({ status: 400, code: "invalid json" });
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  const deadline = AbortSignal.timeout(10_000);
  const cancel = () => { void reader.cancel().catch(() => null); };
  deadline.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (deadline.aborted) throw new HandoffsApiError({ status: 408, code: "request timed out" });
      if (chunk.done) break;
      if (size + chunk.value.byteLength > maxBytes) {
        cancel();
        throw new HandoffsApiError({ status: 413, code: "payload too large" });
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } catch (error) {
    if (error instanceof HandoffsApiError) throw error;
    cancel();
    throw new HandoffsApiError({ status: 400, code: "invalid json" });
  } finally {
    deadline.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HandoffsApiError({ status: 400, code: "invalid json" });
  }
};

export const onlyFields = (body: Record<string, unknown>, fields: readonly string[]): void => {
  if (Object.keys(body).some((name) => !fields.includes(name))) {
    throw new HandoffsApiError({ status: 400, code: "invalid json" });
  }
};
