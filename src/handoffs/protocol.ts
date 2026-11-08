export type HandoffAccess = "private" | "public";

export interface ClientConfig {
  access: HandoffAccess;
  handoffTtlSeconds: number;
  maxHandoffBytes: number;
  turnstileSiteKey?: string;
}

export interface ReservedHandoff {
  readonly id: string;
  readonly expiresAt: number;
  readonly recipientFingerprint: string;
}

export interface Reservation extends ReservedHandoff {
  writeToken: string;
  readToken: string;
  subscribeToken: string;
}

export interface FailureReply<Status extends 400 | 401 | 404 | 409 | 413 | 429> {
  status: Status;
  body: { readonly error: string };
}
export interface GoneReply {
  status: 410;
  body: { readonly status: "gone" };
}

export type ReserveReply =
  | { status: 201; body: ReservedHandoff }
  | FailureReply<400 | 401 | 409 | 429>;
export type AuthorizeWriteReply =
  | { status: 200; body: { readonly authorized: true } }
  | GoneReply
  | FailureReply<401 | 409>;
export type FillReply =
  | { status: 200; body: { readonly id: string; readonly expiresAt: number } }
  | GoneReply
  | FailureReply<400 | 401 | 409 | 413>;
export type ConsumeReply =
  | { status: 200; body: { readonly sealed: string; readonly recipientFingerprint: string } }
  | GoneReply
  | FailureReply<401 | 404>;
export type StatusReply =
  | { status: 200; body: { readonly status: "pending" | "ready"; readonly expiresAt: number } }
  | GoneReply
  | FailureReply<401>;
export type ApprovalAttemptReply =
  | { status: 200; body: { readonly allowed: true } }
  | FailureReply<400 | 429>;
export type ApproveCredentialReply =
  | { status: 200; body: { readonly approved: true; readonly expiresAt: number } }
  | FailureReply<400 | 409 | 429>;
export type CredentialStatusReply =
  | { status: 200; body: { readonly status: "approved"; readonly expiresAt: number; readonly recipientFingerprint: string } }
  | { status: 202; body: { readonly status: "pending" } }
  | FailureReply<400>;

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
