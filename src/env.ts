export interface Env {
  HANDOFFS: KVNamespace;
  HANDOFF_PARTY: DurableObjectNamespace;
  ASSETS: Fetcher;
  MAX_HANDOFF_BYTES: string;
}
