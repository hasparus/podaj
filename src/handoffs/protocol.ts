export type HandoffMode = "private" | "demo";

export interface ClientConfig {
  mode: HandoffMode;
  handoffTtlSeconds: number;
  maxHandoffBytes: number;
  turnstileSiteKey?: string;
}

export interface Reservation {
  id: string;
  writeToken: string;
  readToken: string;
  subscribeToken: string;
  expiresAt: number;
  recipientFingerprint: string;
}

export interface ServiceReply {
  status: number;
  body: Record<string, unknown>;
}

export interface ReserveInput {
  id: string;
  recipientFingerprint: string;
  writeHash: string;
  readHash: string;
  subscribeHash: string;
  creatorHash: string | null;
}

export const HANDOFF_ID = /^[a-f0-9]{32}$/u;
export const CAPABILITY = /^[a-f0-9]{64}$/u;
export const HANDOFF_SERVICE_NAME = "handoffs";

export const DEMO_LIMITS = {
  approvalsPerDay: 200,
  approvalAttemptsPerDay: 500,
  approvalAttemptsPerMinutePerIp: 10,
  reservationsPerDay: 200,
  reservationsPerCredentialPerDay: 5,
  liveHandoffs: 200,
  sockets: 20,
  socketsPerHandoff: 2,
  socketLifetimeMs: 600_000,
} as const;
