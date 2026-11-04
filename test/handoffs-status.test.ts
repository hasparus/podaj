import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { handleHandoffsApi } from "../src/handoffs/handler.js";
import { pendingValue } from "../src/handoffs/kv-encoding.js";
import type { Env } from "../src/env.js";

const mockEnv = (store: Map<string, string>): Env => ({
  ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
  HANDOFF_PARTY: {
    get: async () => ({
      fetch: async () => new Response("ok", { status: 200 }),
    }),
  } as unknown as Env["HANDOFF_PARTY"],
  HANDOFFS: {
    delete: async (key: string) => {
      store.delete(key);
    },
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as KVNamespace,
  MAX_HANDOFF_BYTES: "32768",
});

describe("handoff status API", () => {
  it("reports pending then ready", async () => {
    const store = new Map<string, string>();
    const id = "0123456789abcdef0123456789abcdef";
    store.set(id, pendingValue("abc"));

    const pending = await Effect.runPromise(
      handleHandoffsApi(
        new Request(`https://podaj.test/api/handoffs/${id}/status`),
        mockEnv(store),
      ),
    );
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ status: "pending" });

    store.set(id, "PODAJ1.e");

    const ready = await Effect.runPromise(
      handleHandoffsApi(
        new Request(`https://podaj.test/api/handoffs/${id}/status`),
        mockEnv(store),
      ),
    );
    expect(await ready.json()).toEqual({ status: "ready" });
  });
});
