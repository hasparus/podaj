#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import {
  defaultConfigPath,
  readConfig,
  writeConfig,
} from "./config.mjs";
import {
  bindNamespace,
  composeUrl,
  KV_PLACEHOLDER,
  kvNamespaceId,
  workersUrl,
} from "./deploy-text.mjs";
import { keyDir } from "./keygen.mjs";
import { generateKeypair, joinPrivate, joinPublic } from "./keypair.mjs";
import { openPodaj1 } from "./open-podaj1.mjs";
import { selectVars } from "./select-vars.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const usage = () => {
  console.error(`usage:
  podaj init
  podaj wait [KEY ...]
  podaj keygen
  podaj decrypt [PODAJ1.blob]

init   new recipient key, deploy this checkout, write ~/.config/podaj/config.json
wait   reserve a fill link, block until those keys are pasted, print them as JSON`);
  process.exit(2);
};

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{ input?: string }} [opts]
 */
const capture = (bin, args, opts = {}) => {
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: opts.input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stderr.write(output);
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return output;
};

/**
 * @param {string} name
 */
const tool = (name) => join(repoRoot, "node_modules", ".bin", name);

const runtimeConfig = () => {
  const file = readConfig(defaultConfigPath());
  const url = (process.env.PODAJ_URL ?? file?.url ?? "").replace(/\/$/u, "");
  const token = process.env.PODAJ_TOKEN ?? file?.token ?? "";
  if (url.length === 0) {
    throw new Error("no podaj url — run podaj init");
  }
  return { token, url };
};

/**
 * @param {string} token
 */
const authHeaders = (token) => {
  if (token.length === 0) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
};

/**
 * @param {string} message
 * @returns {never}
 */
const fail = (message) => {
  throw new Error(message);
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
 * @param {string} id
 * @param {string} base
 * @param {string} token
 */
const waitReady = async (id, base, token) => {
  const deadline = Date.now() + 120_000;
  const statusUrl = new URL(`/api/handoffs/${id}/status`, base);
  const wsUrl = `${httpToWsOrigin(base)}/parties/handoff-party/${id}`;
  const headers = authHeaders(token);

  /**
   * @param {Response} response
   */
  const explainStatus = (response) => {
    if (response.status === 401) {
      fail("unauthorized — run podaj init");
    }
    if (response.status === 503) {
      fail("this podaj is locked — run podaj init");
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
      const response = await fetch(statusUrl, { headers });
      explainStatus(response);
      const body = await readStatus(response);
      if (response.status === 200 && body.status === "ready") {
        return;
      }
      if (response.status === 410 || body.status === "gone") {
        fail("handoff slot gone");
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    fail("timed out waiting for ready");
  };

  /** @type {"poll" | "timeout" | "ready"} */
  const socketResult = await new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const socket = new WebSocket(wsUrl, { headers });

    /**
     * @param {"poll" | "timeout" | "ready"} mode
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
          settle("ready");
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

  if (socketResult === "ready") {
    return;
  }
  if (socketResult === "poll") {
    await poll();
    return;
  }
  const response = await fetch(statusUrl, { headers });
  explainStatus(response);
  const body = await readStatus(response);
  if (response.status === 200 && body.status === "ready") {
    return;
  }
  fail("timed out waiting for ready");
};

const init = async () => {
  process.stderr.write("generating recipient key\n");
  const dir = await generateKeypair(keyDir());
  copyFileSync(
    joinPublic(dir),
    join(repoRoot, "public", "recipient.pem"),
  );

  const wrangler = tool("wrangler");
  capture(wrangler, ["whoami"]);

  const configFile = join(repoRoot, "wrangler.jsonc");
  const source = readFileSync(configFile, "utf8");
  if (source.includes(KV_PLACEHOLDER)) {
    process.stderr.write("creating KV namespace\n");
    const created = capture(wrangler, [
      "kv",
      "namespace",
      "create",
      "podaj-handoffs",
    ]);
    writeFileSync(configFile, bindNamespace(source, kvNamespaceId(created)));
  }

  process.stderr.write("building\n");
  capture(tool("vite"), ["build"]);
  process.stderr.write("deploying\n");
  const deployed = capture(wrangler, ["deploy"]);
  const url = workersUrl(deployed);
  const token = randomBytes(32).toString("hex");
  capture(wrangler, ["secret", "put", "PODAJ_TOKEN"], { input: `${token}\n` });

  const file = defaultConfigPath();
  writeConfig(file, { token, url });
  process.stdout.write(
    `${JSON.stringify({ url, config: file, keys: dir }, null, 2)}\n`,
  );
};

/**
 * @param {string[]} keys
 */
const wait = async (keys) => {
  for (const key of keys) {
    if (!KEY_NAME.test(key)) {
      fail(`not an env key: ${key}`);
    }
  }
  const { token, url } = runtimeConfig();
  const response = await fetch(new URL("/api/handoffs/reserve", url), {
    headers: authHeaders(token),
    method: "POST",
  });
  if (!response.ok) {
    fail(`reserve failed (${response.status})`);
  }
  const reserved = reservedBody(await response.json());
  const link = composeUrl(url, reserved.id, reserved.writeToken, token);
  process.stderr.write(
    keys.length === 0
      ? `paste env vars, then leave this page open:\n${link}\n`
      : `paste these keys:\n${keys.join("\n")}\n${link}\n`,
  );
  await waitReady(reserved.id, url, token);
  const fetched = await fetch(new URL(`/api/handoffs/${reserved.id}`, url), {
    headers: authHeaders(token),
  });
  if (!fetched.ok) {
    fail(`read failed (${fetched.status})`);
  }
  const sealed = sealedBody(await fetched.json());
  const privatePem = readFileSync(joinPrivate(keyDir()), "utf8");
  const picked = selectVars(openPodaj1(sealed, privatePem), keys);
  process.stdout.write(`${JSON.stringify(picked, null, 2)}\n`);
};

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
const record = (value) => {
  if (typeof value !== "object" || value === null) {
    fail("unexpected json");
  }
  return /** @type {Record<string, unknown>} */ (value);
};

/**
 * @param {unknown} value
 * @returns {{ id: string, writeToken: string }}
 */
const reservedBody = (value) => {
  const body = record(value);
  const id = body.id;
  const writeToken = body.writeToken;
  if (typeof id !== "string" || typeof writeToken !== "string") {
    fail("reserve returned an unexpected body");
  }
  return {
    id: /** @type {string} */ (id),
    writeToken: /** @type {string} */ (writeToken),
  };
};

/**
 * @param {unknown} value
 * @returns {string}
 */
const sealedBody = (value) => {
  const sealed = record(value).sealed;
  if (typeof sealed !== "string") {
    fail("read returned an unexpected body");
  }
  return /** @type {string} */ (sealed);
};

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "init":
    await init();
    break;
  case "wait":
    await wait(rest);
    break;
  case "keygen": {
    const dir = await generateKeypair(keyDir());
    process.stdout.write(`${dir}\n`);
    break;
  }
  case "decrypt": {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL("./decrypt-handoff.mjs", import.meta.url)),
      ...rest,
    ], { stdio: "inherit" });
    process.exit(child.status ?? 1);
    break;
  }
  default:
    usage();
}
