import type { HandoffParty } from "./handoffs/party.js";

export interface Env {
  HANDOFF_PARTY: DurableObjectNamespace<HandoffParty>;
  ASSETS: Fetcher;
  MAX_HANDOFF_BYTES: string;
  HANDOFF_TTL_SECONDS?: string;
  PODAJ_API_AUTH_SECRET?: string;
  PODAJ_ACCESS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  PUBLIC_API_LIMITER?: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
}
