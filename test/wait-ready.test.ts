import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { waitReady } from "../scripts/wait-ready.js";

const ID = "0123456789abcdef0123456789abcdef";
const SUBSCRIBE = "3".repeat(64);
let server: Server | undefined;
let sockets: WebSocketServer | undefined;

const start = async (
  onConnect: (socket: WebSocket) => void,
  status: "ready" | "gone" | "hang" = "ready",
) => {
  let polls = 0;
  const authorizations: (string | undefined)[] = [];
  server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    expect(request.url).toBe(`/api/handoffs/${ID}/status`);
    polls += 1;
    if (status === "hang") return;
    response.writeHead(status === "gone" ? 410 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status }));
  });
  sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    authorizations.push(request.headers.authorization);
    expect(request.url).toBe(`/parties/handoff-party/${ID}`);
    onConnect(socket);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  return { origin: `http://127.0.0.1:${address.port}`, polls: () => polls, authorizations };
};

afterEach(async () => {
  for (const socket of sockets?.clients ?? []) socket.terminate();
  if (sockets !== undefined) await new Promise<void>((resolve) => sockets!.close(() => resolve()));
  server?.closeAllConnections();
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  sockets = undefined;
});

describe("ready waiting", () => {
  it("reports terminal gone instead of swallowing it as malformed JSON", async () => {
    const instance = await start((socket) => socket.send(JSON.stringify({ type: "gone" })));
    await expect(waitReady(ID, instance.origin, SUBSCRIBE, { timeoutMs: 1_000 })).rejects.toThrow("handoff slot gone");
    expect(instance.polls()).toBe(0);
  });

  it("ignores malformed frames without losing a later ready frame", async () => {
    const instance = await start((socket) => {
      socket.send("not JSON");
      socket.send("null");
      socket.send(JSON.stringify({ type: "ready" }));
    });
    await waitReady(ID, instance.origin, SUBSCRIBE, { timeoutMs: 1_000 });
    expect(instance.polls()).toBe(0);
  });

  it("polls only after the socket closes", async () => {
    const instance = await start((socket) => socket.close());
    await waitReady(ID, instance.origin, SUBSCRIBE, { timeoutMs: 1_000 });
    expect(instance.polls()).toBe(1);
    expect(instance.authorizations).toEqual([`Bearer ${SUBSCRIBE}`, `Bearer ${SUBSCRIBE}`]);
  });

  it("stops on a terminal polling response", async () => {
    const instance = await start((socket) => socket.close(), "gone");
    await expect(waitReady(ID, instance.origin, SUBSCRIBE, { timeoutMs: 1_000 })).rejects.toThrow("handoff slot gone");
  });

  it("does not poll while the socket remains open", async () => {
    const instance = await start((socket) => socket.send(JSON.stringify({ type: "subscribed", status: "pending" })));
    await expect(waitReady(ID, instance.origin, SUBSCRIBE, { timeoutMs: 100 })).rejects.toThrow("timed out waiting for ready");
    expect(instance.polls()).toBe(0);
  });

  it("aborts a hung fallback request at the same deadline", async () => {
    const instance = await start((socket) => socket.close(), "hang");
    await expect(waitReady(ID, instance.origin, SUBSCRIBE, { timeoutMs: 100 })).rejects.toThrow("timed out waiting for ready");
    expect(instance.polls()).toBe(1);
  });
});
