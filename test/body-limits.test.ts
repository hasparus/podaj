import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonBody } from "../src/handoffs/body.js";

afterEach(() => { vi.restoreAllMocks(); });
const request = (body: string | Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => new Request("https://podaj.test/api/body", {
  method: "POST", body, headers: { "Content-Type": "application/json", ...headers }, duplex: "half",
} as RequestInit);

describe("bounded JSON streaming", () => {
  it("counts actual UTF-8 bytes even without a length header", async () => {
    const body = JSON.stringify({ value: "🫛" });
    await expect(readJsonBody(request(body), body.length)).rejects.toMatchObject({ status: 413 });
    await expect(readJsonBody(request(body), new TextEncoder().encode(body).length)).resolves.toEqual({ value: "🫛" });
  });

  it.each(["999999", "-1", "NaN", "1e2"])("rejects invalid or oversized declared length %s", async (length) => {
    await expect(readJsonBody(request("{}", { "Content-Length": length }), 20)).rejects.toMatchObject({ status: 413 });
  });

  it.each<Record<string, string>>([
    { "Content-Type": "text/plain" }, { "Content-Encoding": "gzip" },
  ])("rejects unsupported body metadata %j", async (headers) => {
    await expect(readJsonBody(request("{}", headers), 20)).rejects.toMatchObject({ status: 415 });
  });

  it.each(["null", "[]", "123", '"string"', "not-json"])("requires a JSON object: %s", async (body) => {
    await expect(readJsonBody(request(body), 100)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects malformed UTF-8 rather than silently replacing bytes", async () => {
    await expect(readJsonBody(request(new Uint8Array([0xff])), 20)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a stalled stream at its deadline even if complete JSON bytes arrived before EOF", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{}")); }, cancel,
    });
    const result = readJsonBody(request(body), 20);
    await Promise.resolve();
    deadline.abort();
    await expect(result).rejects.toMatchObject({ status: 408, code: "request timed out" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
