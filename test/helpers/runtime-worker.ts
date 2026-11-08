import worker from "../../src/worker.js";
import type { Env } from "../../src/env.js";
import { HandoffParty } from "../../src/handoffs/party.js";
import { HANDOFF_SERVICE_NAME } from "../../src/handoffs/protocol.js";
import { digest } from "../../src/handoffs/capabilities.js";

const realNow = Date.now;
let offset = 0;
const requests: { method: string; path: string; authorization: string | null; body: string }[] = [];
Date.now = () => realNow() + offset;

export class InspectableHandoffParty extends HandoffParty {
  snapshot() {
    return {
      handoffs: this.ctx.storage.sql.exec("SELECT * FROM handoffs").toArray(),
      credentials: this.ctx.storage.sql.exec("SELECT * FROM credentials").toArray(),
      counters: this.ctx.storage.sql.exec("SELECT * FROM counters").toArray(),
      sockets: this.ctx.getWebSockets().map((socket) => socket.deserializeAttachment()),
    };
  }

  async reset() {
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, "test reset");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM handoffs");
      this.ctx.storage.sql.exec("DELETE FROM credentials");
      this.ctx.storage.sql.exec("DELETE FROM counters");
    });
    offset = 0;
    await this.ctx.storage.deleteAlarm();
  }

  async advance(milliseconds: number) {
    offset += milliseconds;
    await this.alarm();
    return this.snapshot();
  }
}

type TestEnv = Omit<Env, "HANDOFF_PARTY"> & {
  HANDOFF_PARTY: DurableObjectNamespace<InspectableHandoffParty>;
};

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__test/")) {
      const stub = env.HANDOFF_PARTY.get(env.HANDOFF_PARTY.idFromName(HANDOFF_SERVICE_NAME));
      switch (url.pathname) {
        case "/__test/native-close":
        case "/__test/native-expire": {
          const id = url.searchParams.get("id") ?? "";
          const response = await stub.fetch(new Request(`https://podaj.test/parties/handoff-party/${id}`, {
            headers: { Authorization: request.headers.get("Authorization") ?? "", Upgrade: "websocket" },
          }));
          const socket = response.webSocket;
          if (socket === null) return Response.json({ error: "upgrade failed" }, { status: 500 });
          const events: unknown[] = [];
          const closed = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("native close deadline")), 2000);
            socket.addEventListener("message", (event) => { events.push(JSON.parse(String(event.data))); });
            socket.addEventListener("close", (event) => {
              clearTimeout(timer);
              events.push({ type: "close", code: event.code, reason: event.reason });
              socket.close(event.code, event.reason);
              resolve();
            });
          });
          socket.accept();
          if (url.pathname === "/__test/native-expire") await stub.advance(600_001);
          else await stub.consume(id, await digest(request.headers.get("X-Test-Read-Capability") ?? ""));
          await closed;
          return Response.json({ events, clientState: socket.readyState, snapshot: await stub.snapshot() });
        }
        case "/__test/snapshot": return Response.json(await stub.snapshot());
        case "/__test/requests": return Response.json(requests);
        case "/__test/reset": requests.length = 0; await stub.reset(); return Response.json({ reset: true });
        case "/__test/advance": return Response.json(await stub.advance(Number(url.searchParams.get("ms"))));
        default: return new Response(null, { status: 404 });
      }
    }
    const observed = { method: request.method, path: url.pathname, authorization: request.headers.get("Authorization"), body: "" };
    requests.push(observed);
    const body = request.method === "POST" || request.method === "PUT" ? request.clone() : null;
    const response = await worker.fetch(request, env);
    if (body !== null) observed.body = await body.text();
    return response;
  },
};
