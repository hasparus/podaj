import { build } from "esbuild";
import { resolve } from "node:path";
import { Miniflare, Response as RuntimeResponse } from "miniflare";

export const OWNER = "synthetic-instance-token-for-test";
export interface ObservedRequest { method: string; path: string; authorization: string | null; body: string }
export interface RuntimeSnapshot {
  handoffs: { id: string; state: string; sealed: string | null }[];
  credentials: unknown[];
  sockets: unknown[];
}

/** Same inspectable production Worker/SQLite/native-WebSocket entry as the backend runtime suite. */
export const nativeRuntime = async (demo: boolean) => {
  const compiled = await build({
    entryPoints: [resolve("test/helpers/runtime-worker.ts")], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"],
  });
  let verification: Record<string, unknown> = { success: false };
  const verifications: string[] = [];
  const runtime = new Miniflare({
    modules: true, script: compiled.outputFiles[0].text, compatibilityDate: "2025-10-11",
    durableObjects: { HANDOFF_PARTY: { className: "InspectableHandoffParty", useSQLite: true } },
    bindings: {
      PODAJ_MODE: demo ? "demo" : "private", PODAJ_API_AUTH_SECRET: OWNER, MAX_HANDOFF_BYTES: "32768",
      ...(demo ? { TURNSTILE_SITE_KEY: "synthetic-site-key", TURNSTILE_SECRET_KEY: "synthetic-siteverify-secret" } : {}),
    },
    ratelimits: demo ? { PUBLIC_API_LIMITER: { simple: { limit: 60, period: 60 } } } : {},
    assets: {
      directory: resolve("dist/client"), binding: "ASSETS",
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "challenges.cloudflare.com" || url.pathname !== "/turnstile/v0/siteverify" || request.method !== "POST") {
        throw new Error(`unexpected outbound request: ${request.method} ${url.origin}${url.pathname}`);
      }
      verifications.push(await request.text());
      return RuntimeResponse.json(verification);
    },
  });
  const origin = (await runtime.ready).origin;
  const fetcher = globalThis.fetch.bind(globalThis);
  const request = (path: string, init?: RequestInit) => fetcher(new URL(path, origin), init);
  return {
    runtime, origin, request, verifications,
    proof: (data: Record<string, unknown>) => { verification = data; },
    snapshot: async () => await (await request("/__test/snapshot")).json() as RuntimeSnapshot,
    requests: async () => await (await request("/__test/requests")).json() as ObservedRequest[],
    reset: async () => {
      verifications.length = 0;
      const response = await request("/__test/reset");
      if (!response.ok) throw new Error(await response.text());
    },
  };
};
export type NativeRuntime = Awaited<ReturnType<typeof nativeRuntime>>;
