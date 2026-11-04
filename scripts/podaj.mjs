#!/usr/bin/env node
import {
  cancel,
  intro,
  isCancel,
  log,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import {
  defaultConfigPath,
  readConfig,
  writeConfig,
} from "./config.mjs";
import { composeUrl, kvNamespaceId, workersUrl } from "./deploy-text.mjs";
import { initArgs } from "./init-args.mjs";
import { runInit } from "./init-flow.mjs";
import { probeInstance } from "./instance.mjs";
import { keyDir } from "./keygen.mjs";
import { generateKeypair, joinPrivate, joinPublic } from "./keypair.mjs";
import { openPodaj1 } from "./open-podaj1.mjs";
import { selectVars } from "./select-vars.mjs";
import { clientBuilt, stageWorker, workerStageDir } from "./stage-worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const usage = () => {
  console.error(`usage:
  podaj init
  podaj init --url https://<name>.workers.dev --token <token>
  podaj init --deploy
  podaj wait [KEY ...]
  podaj keygen
  podaj decrypt [PODAJ1.blob]

init   connect to a worker you already deployed, or deploy one after Cloudflare login
wait   reserve a fill link, block until those keys are pasted, print them as JSON`);
  process.exit(2);
};

/**
 * @param {unknown} value
 * @returns {Promise<string>}
 */
const answered = async (value) => {
  if (isCancel(value) || typeof value !== "string" || value.length === 0) {
    cancel("stopped");
    process.exit(0);
  }
  return value;
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
    throw new Error(`${args.join(" ")} failed`);
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

/**
 * @param {string} dir
 */
const publishPublicKey = (dir) => {
  if (repoRoot.split(sep).includes("node_modules")) {
    return;
  }
  copyFileSync(joinPublic(dir), join(repoRoot, "public", "recipient.pem"));
};

/**
 * @param {string[]} argv
 */
const init = async (argv) => {
  const args = initArgs(argv);
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const interactive = tty && !args.deploy && args.url === undefined;
  if (interactive) {
    intro("podaj");
  }
  const wrangler = tool("wrangler");
  await runInit(args, {
    askToken: () =>
      answered(
        password({
          message: "Instance token",
          validate: (value) =>
            value === undefined || value.length === 0
              ? "token is required"
              : undefined,
        }),
      ),
    askTokenSource: async () => {
      const source = await answered(
        select({
          message: "Instance token",
          options: [
            {
              hint: "you already set PODAJ_TOKEN on that worker",
              label: "I have the token",
              value: "have",
            },
            {
              hint: "wrangler stores a new token as PODAJ_TOKEN",
              label: "Set a new token on the worker",
              value: "set",
            },
          ],
        }),
      );
      if (source !== "have" && source !== "set") {
        throw new Error(`unexpected token choice ${source}`);
      }
      return source;
    },
    askUrl: () =>
      answered(
        text({
          message: "Worker URL",
          placeholder: "https://podaj.<account>.workers.dev",
          validate: (value) => {
            if (value === undefined || value.length === 0) {
              return "enter an http(s) url";
            }
            try {
              const origin = new URL(
                value.includes("://") ? value : `https://${value}`,
              );
              return origin.protocol === "https:" || origin.protocol === "http:"
                ? undefined
                : "enter an http(s) url";
            } catch {
              return "enter an http(s) url";
            }
          },
        }),
      ),
    askWorkerName: () =>
      answered(
        text({
          defaultValue: "podaj",
          initialValue: "podaj",
          message: "Worker name",
        }),
      ),
    chooseMode: async () => {
      const mode = await answered(
        select({
          message: "Where is your podaj?",
          options: [
            {
              hint: "Deploy to Cloudflare button in the README",
              label: "I already deployed one",
              value: "connect",
            },
            { label: "Deploy a new worker", value: "deploy" },
          ],
        }),
      );
      if (mode !== "connect" && mode !== "deploy") {
        throw new Error(`unexpected choice ${mode}`);
      }
      return mode;
    },
    createKv: () =>
      kvNamespaceId(
        capture(wrangler, ["kv", "namespace", "create", "podaj-handoffs"]),
      ),
    deploy: (configPath) =>
      capture(wrangler, ["deploy", "--config", configPath]),
    ensureClient: () => {
      if (clientBuilt(repoRoot)) {
        return;
      }
      const vite = tool("vite");
      if (!existsSync(vite)) {
        throw new Error(
          "client build is missing. Reinstall podaj so dist/client ships with the package.",
        );
      }
      capture(vite, ["build"]);
    },
    existingKvId: () => readConfig(defaultConfigPath())?.kvId,
    hasPrivateKey: () => existsSync(joinPrivate(keyDir())),
    isTTY: tty,
    keyDir,
    keygen: async () => {
      const dir = await generateKeypair(keyDir());
      publishPublicKey(dir);
      return dir;
    },
    login: () => {
      const child = spawnSync(wrangler, ["login"], { stdio: "inherit" });
      if (child.error !== undefined) {
        throw child.error;
      }
      if (child.status !== 0) {
        throw new Error("Cloudflare login failed");
      }
    },
    mintToken: () => randomBytes(32).toString("hex"),
    note: (message) => {
      log.info(message);
    },
    probe: probeInstance,
    publicPem: (dir) => readFileSync(joinPublic(dir), "utf8"),
    putSecret: (target, token) => {
      const secretArgs = ["secret", "put", "PODAJ_TOKEN"];
      if (target.configPath !== undefined) {
        secretArgs.push("--config", target.configPath);
      }
      if (target.name !== undefined) {
        secretArgs.push("--name", target.name);
      }
      capture(wrangler, secretArgs, { input: `${token}\n` });
    },
    save: (config) => {
      const file = defaultConfigPath();
      writeConfig(file, {
        token: config.token,
        url: config.url,
        ...(config.kvId === undefined ? {} : { kvId: config.kvId }),
      });
      if (interactive) {
        outro(config.url);
      }
      process.stdout.write(
        `${JSON.stringify({ ...config, config: file }, null, 2)}\n`,
      );
    },
    stage: (kvId, publicPem) =>
      stageWorker({
        kvId,
        packageRoot: repoRoot,
        publicPem,
        stage: workerStageDir(homedir()),
      }),
    whoami: () =>
      spawnSync(wrangler, ["whoami"], { encoding: "utf8" }).status === 0,
    workersUrl,
  });
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

try {
  switch (command) {
    case "init":
      await init(rest);
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
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./decrypt-handoff.mjs", import.meta.url)),
          ...rest,
        ],
        { stdio: "inherit" },
      );
      process.exit(child.status ?? 1);
      break;
    }
    default:
      usage();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
