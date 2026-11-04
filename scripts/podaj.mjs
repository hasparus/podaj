#!/usr/bin/env node
/** Agent CLI: keygen, reserve, wait, decrypt. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));

const usage = () => {
  console.error(`usage:
  podaj keygen
  podaj reserve [base-url]
  podaj wait <handoff-id> [base-url]
  podaj decrypt [PODAJ1.blob]

PODAJ_URL    default base url (else http://127.0.0.1:8787)
PODAJ_TOKEN  instance token (required off localhost)`);
  process.exit(2);
};

/**
 * @param {string | undefined} arg
 */
const baseUrl = (arg) =>
  (arg ?? process.env.PODAJ_URL ?? "http://127.0.0.1:8787").replace(/\/$/u, "");

const authHeaders = () => {
  const token = process.env.PODAJ_TOKEN ?? "";
  if (token.length === 0) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
};

/**
 * @param {string} script
 * @param {string[]} args
 */
const runNode = (script, args) => {
  const child = spawn(process.execPath, [join(here, script), ...args], {
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
};

/**
 * @param {string} base
 */
const reserve = async (base) => {
  const response = await fetch(new URL("/api/handoffs/reserve", base), {
    headers: authHeaders(),
    method: "POST",
  });
  if (!response.ok) {
    console.error(`reserve failed (${response.status})`);
    process.exit(1);
  }
  const body = await response.json();
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
};

/**
 * @param {string} base
 */
const httpToWsOrigin = (base) => {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
};

/**
 * @param {string | undefined} id
 * @param {string} base
 */
const waitReady = async (id, base) => {
  if (id === undefined || !/^[a-f0-9]{32}$/u.test(id)) {
    usage();
    return;
  }
  const deadline = Date.now() + 120_000;
  const receiveUrl = `${base}/h/${id}`;
  const statusUrl = new URL(`/api/handoffs/${id}/status`, base);
  const wsUrl = `${httpToWsOrigin(base)}/parties/handoff-party/${id}`;

  /**
   * @param {{ id: string, receiveUrl: string, status: "ready", via: "poll" | "websocket" }} payload
   */
  const finish = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
  };

  /**
   * @param {string} message
   */
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };

  /**
   * @param {Response} response
   */
  const explainStatus = (response) => {
    if (response.status === 401) {
      fail("unauthorized — set PODAJ_TOKEN");
    }
    if (response.status === 503) {
      fail("this podaj is locked — set PODAJ_TOKEN on the worker");
    }
  };

  /**
   * @param {Response} response
   * @returns {Promise<{ status?: string }>}
   */
  const readStatus = async (response) => {
    const body = await response.json();
    if (typeof body !== "object" || body === null || !("status" in body)) {
      return {};
    }
    const status = body.status;
    return { status: typeof status === "string" ? status : undefined };
  };

  const poll = async () => {
    while (Date.now() < deadline) {
      const response = await fetch(statusUrl, { headers: authHeaders() });
      explainStatus(response);
      const body = await readStatus(response);
      if (response.status === 200 && body.status === "ready") {
        finish({ id, receiveUrl, status: "ready", via: "poll" });
      }
      if (response.status === 410 || body.status === "gone") {
        fail("handoff slot gone");
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    fail("timed out waiting for ready");
  };

  /** @type {"poll" | "timeout"} */
  const socketResult = await new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const headers = authHeaders();
    const socket = new WebSocket(wsUrl, { headers });

    /**
     * @param {"poll" | "timeout"} mode
     */
    const settle = (mode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(deadlineTimer);
      socket.terminate();
      resolve(mode);
    };

    const connectTimer = setTimeout(() => {
      settle("poll");
    }, 8_000);
    const deadlineTimer = setTimeout(
      () => {
        settle("timeout");
      },
      Math.max(0, deadline - Date.now()),
    );

    socket.on("open", () => {
      opened = true;
      clearTimeout(connectTimer);
    });

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message.type === "ready") {
          settled = true;
          clearTimeout(connectTimer);
          clearTimeout(deadlineTimer);
          socket.close();
          finish({
            id,
            receiveUrl:
              typeof message.receiveUrl === "string"
                ? message.receiveUrl
                : receiveUrl,
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

    socket.on("error", () => {
      if (!opened) {
        settle("poll");
      }
    });

    socket.on("close", () => {
      if (!settled) {
        settle("poll");
      }
    });
  });

  if (socketResult === "poll") {
    await poll();
    return;
  }

  const response = await fetch(statusUrl, { headers: authHeaders() });
  explainStatus(response);
  const body = await readStatus(response);
  if (response.status === 200 && body.status === "ready") {
    finish({ id, receiveUrl, status: "ready", via: "poll" });
  }
  fail("timed out waiting for ready");
};

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "keygen":
    runNode("keygen.mjs", rest);
    break;
  case "decrypt":
    runNode("decrypt-handoff.mjs", rest);
    break;
  case "reserve":
    await reserve(baseUrl(rest[0]));
    break;
  case "wait":
    await waitReady(rest[0], baseUrl(rest[1]));
    break;
  default:
    usage();
}
