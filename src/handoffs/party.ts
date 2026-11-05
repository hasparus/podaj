import { Server, type Connection, type ConnectionContext } from "partyserver";

import { isPendingValue, isSealedValue } from "./kv-encoding.js";

export type HandoffPartyEnv = {
  HANDOFFS: KVNamespace;
};

type ReadyNotifyBody = {
  receiveUrl: string;
};

export class HandoffParty extends Server<HandoffPartyEnv> {
  static options = { hibernate: true };

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const stored = await this.env.HANDOFFS.get(this.name);
    const receiveUrl = new URL(`/h/${this.name}`, ctx.request.url).toString();

    if (stored !== null && isSealedValue(stored)) {
      connection.send(
        JSON.stringify({
          type: "ready",
          handoffId: this.name,
          receiveUrl,
        }),
      );
      return;
    }

    let status: "pending" | "gone" = "gone";
    if (stored !== null && isPendingValue(stored)) {
      status = "pending";
    }

    connection.send(
      JSON.stringify({
        type: "subscribed",
        handoffId: this.name,
        status,
      }),
    );
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.endsWith("/notify")) {
      return new Response("not found", { status: 404 });
    }

    let body: ReadyNotifyBody;
    try {
      body = (await request.json()) as ReadyNotifyBody;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (typeof body.receiveUrl !== "string" || body.receiveUrl.length === 0) {
      return new Response("bad request", { status: 400 });
    }

    this.broadcast(
      JSON.stringify({
        type: "ready",
        handoffId: this.name,
        receiveUrl: body.receiveUrl,
      }),
    );

    return new Response("ok", { status: 200 });
  }
}
