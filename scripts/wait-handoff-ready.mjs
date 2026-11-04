#!/usr/bin/env node
/** Wait until a reserved handoff slot is sealed (WebSocket + poll fallback). */
import WebSocket from "ws";

const id = process.argv[2];
const base = process.argv[3] ?? process.env.PODAJ_URL ?? "http://127.0.0.1:8787";
if (!id || !/^[a-f0-9]{32}$/u.test(id)) {
  console.error("usage: wait-handoff-ready.mjs <handoff-id> [base-url]");
  process.exit(2);
}

const deadline = Date.now() + 120_000;
let finished = false;

const finish = (payload) => {
  if (finished) {
    return;
  }
  finished = true;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
};

const fail = (message) => {
  if (finished) {
    return;
  }
  finished = true;
  console.error(message);
  process.exit(1);
};

const httpToWsOrigin = (origin) => {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
};

const statusUrl = new URL(`/api/handoffs/${id}/status`, base);
const wsUrl = `${httpToWsOrigin(base)}/parties/handoff-party/${id}`;

const poll = async () => {
  while (!finished && Date.now() < deadline) {
    const response = await fetch(statusUrl);
    const body = await response.json();
    if (response.status === 200 && body.status === "ready") {
      finish({
        id,
        receiveUrl: `${base.replace(/\/$/u, "")}/h/${id}`,
        status: "ready",
        via: "poll",
      });
      return;
    }
    if (response.status === 410 || body.status === "gone") {
      fail("handoff slot gone");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!finished) {
    fail("timed out waiting for ready");
  }
};

const ws = new WebSocket(wsUrl);

ws.on("message", (data) => {
  try {
    const message = JSON.parse(String(data));
    if (message.type === "ready") {
      finish({
        id,
        receiveUrl: message.receiveUrl ?? `${base.replace(/\/$/u, "")}/h/${id}`,
        status: "ready",
        via: "websocket",
      });
    }
    if (message.type === "subscribed" && message.status === "gone") {
      fail("handoff slot gone");
    }
  } catch {
    // ignore malformed frames
  }
});

ws.on("error", () => {
  // polling continues
});

void poll();
