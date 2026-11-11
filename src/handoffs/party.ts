import { DurableObject } from "cloudflare:workers";

import { securityHeaders } from "../security.js";
import {
  CAPABILITY,
  DEMO_LIMITS,
  HANDOFF_ID,
  HANDOFF_SERVICE_NAME,
  type ApprovalAttemptReply,
  type ApproveCredentialReply,
  type AuthorizeWriteReply,
  type ConsumeReply,
  type CredentialStatusReply,
  type FailureReply,
  type GoneReply,
  type FillReply,
  type ReserveInput,
  type ReserveReply,
  type StatusReply,
} from "./protocol.js";
import { HandoffStore, type HandoffStoreConfig } from "./store.js";

type HandoffPartyEnv = HandoffStoreConfig & {
  HANDOFF_PARTY: DurableObjectNamespace<HandoffParty>;
};
type Subscription = { id: string; expiresAt: number };

const json = (result: FailureReply<401 | 404 | 429> | GoneReply | { status: 426; body: { error: string } }): Response => Response.json(result.body, {
  status: result.status,
  headers: { ...securityHeaders(), "Cache-Control": "no-store" },
});

const subscription = (socket: WebSocket): Subscription | null => {
  const value: unknown = socket.deserializeAttachment();
  if (typeof value !== "object" || value === null || !("id" in value) || !("expiresAt" in value) ||
    typeof value.id !== "string" || !HANDOFF_ID.test(value.id) ||
    typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
  return { id: value.id, expiresAt: value.expiresAt };
};

const closeSocket = (socket: WebSocket, gone: boolean, code = 1000): boolean => {
  try {
    if (gone) socket.send(JSON.stringify({ type: "gone" }));
    socket.close(code, gone ? "gone" : "closed");
    return true;
  } catch {
    return false;
  }
};

export class HandoffParty extends DurableObject<HandoffPartyEnv> {
  private readonly store: HandoffStore;

  constructor(ctx: DurableObjectState, env: HandoffPartyEnv) {
    super(ctx, env);
    if (!ctx.id.equals(env.HANDOFF_PARTY.idFromName(HANDOFF_SERVICE_NAME))) {
      throw new Error("handoff coordinator requires the fixed service object");
    }
    this.store = new HandoffStore(ctx.storage, env);
  }

  private notify(id: string, ready: boolean): void {
    for (const socket of this.ctx.getWebSockets(id)) {
      if (!ready) {
        closeSocket(socket, true);
        continue;
      }
      const attached = subscription(socket);
      if (attached === null || attached.expiresAt <= Date.now()) {
        closeSocket(socket, false);
        continue;
      }
      try {
        socket.send(JSON.stringify({ type: "ready" }));
      } catch {
        closeSocket(socket, false);
      }
    }
  }

  private async reconcile(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.store.cleanup();
      let deadline = this.store.nextExpiry();
      const now = Date.now();
      const expiries = new Map<string, number | null>();
      for (const socket of this.ctx.getWebSockets()) {
        const attached = subscription(socket);
        if (attached === null) {
          closeSocket(socket, false, 1008);
          continue;
        }
        if (!expiries.has(attached.id)) expiries.set(attached.id, this.store.activeExpiry(attached.id));
        const activeExpiry = expiries.get(attached.id) ?? null;
        if (activeExpiry === null) {
          closeSocket(socket, true);
          continue;
        }
        if (attached.expiresAt <= now) {
          closeSocket(socket, false);
          continue;
        }
        const expiresAt = Math.min(activeExpiry, attached.expiresAt);
        if (expiresAt !== attached.expiresAt) socket.serializeAttachment({ id: attached.id, expiresAt } satisfies Subscription);
        deadline = Math.min(deadline ?? expiresAt, expiresAt);
      }
      const current = await this.ctx.storage.getAlarm();
      const target = deadline === null ? null : Math.max(now + 1, deadline);
      if (current !== target) {
        await (target === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(target));
      }
    });
  }

  async reserve(input: ReserveInput): Promise<ReserveReply> {
    const result = this.store.reserve(input);
    if (result.status === 201) await this.reconcile();
    return result;
  }

  authorizeWrite(id: string, writeHash: string): Promise<AuthorizeWriteReply> {
    return Promise.resolve(this.store.authorizeWrite(id, writeHash));
  }

  async fill(id: string, writeHash: string, sealed: string): Promise<FillReply> {
    const result = this.store.fill(id, writeHash, sealed);
    if (result.status === 200) {
      this.notify(id, true);
      await this.reconcile();
    }
    return result;
  }

  consume(id: string, readHash: string): Promise<ConsumeReply> {
    const result = this.store.consume(id, readHash);
    if (result.status === 200) this.notify(id, false);
    return Promise.resolve(result);
  }

  status(id: string, subscribeHash: string): Promise<StatusReply> {
    return Promise.resolve(this.store.status(id, subscribeHash));
  }

  async approvalAttempt(ipHash: string): Promise<ApprovalAttemptReply> {
    const result = this.store.approvalAttempt(ipHash);
    if (result.status === 200) await this.reconcile();
    return result;
  }

  async approveCredential(challenge: string, fingerprint: string): Promise<ApproveCredentialReply> {
    const result = this.store.approveCredential(challenge, fingerprint);
    if (result.status === 200) await this.reconcile();
    return result;
  }

  credentialStatus(challenge: string): Promise<CredentialStatusReply> {
    return Promise.resolve(this.store.credentialStatus(challenge));
  }

  async fetch(request: Request): Promise<Response> {
    const match = /^\/parties\/handoff-party\/([a-f0-9]{32})$/u.exec(new URL(request.url).pathname);
    if (!match || request.method !== "GET") return json({ status: 404, body: { error: "not found" } });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ status: 426, body: { error: "websocket required" } });
    }
    const token = /^Bearer ([a-f0-9]{64})$/iu.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (token === undefined || !CAPABILITY.test(token)) return json({ status: 401, body: { error: "unauthorized" } });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const subscribeHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const id = match[1];
    const result = this.store.status(id, subscribeHash);
    if (result.status !== 200) return json(result);
    if (this.ctx.getWebSockets().length >= DEMO_LIMITS.sockets) {
      return json({ status: 429, body: { error: "socket limit reached", quota: { kind: "sockets_global", limit: DEMO_LIMITS.sockets } } });
    }
    if (this.ctx.getWebSockets(id).length >= DEMO_LIMITS.socketsPerHandoff) {
      return json({ status: 429, body: { error: "socket limit reached", quota: { kind: "sockets_per_handoff", limit: DEMO_LIMITS.socketsPerHandoff } } });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.serializeAttachment({
      id,
      expiresAt: Math.min(result.body.expiresAt, Date.now() + DEMO_LIMITS.socketLifetimeMs),
    } satisfies Subscription);
    this.ctx.acceptWebSocket(server, [id]);
    server.send(JSON.stringify(result.body.status === "ready" ? { type: "ready" } : { type: "subscribed", status: "pending" }));
    await this.reconcile();
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    await this.reconcile();
  }

  async webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    closeSocket(socket, false, 1008);
    await this.reconcile();
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    closeSocket(socket, false);
    await this.reconcile();
  }

  async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    closeSocket(socket, false, 1011);
    await this.reconcile();
  }
}
