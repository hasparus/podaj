#!/usr/bin/env node
import type { InitArgs } from "./init-args.js";
import type { Reservation } from "../src/handoffs/protocol.js";
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
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { packageRoot, packageTool } from "./package-paths.js";
import { decryptHandoff } from "./decrypt-handoff.js";

import {
  defaultConfigPath,
  readConfig,
  writeConfig,
} from "./config.js";
import { composeUrl, workersUrl } from "./deploy-text.js";
import { initArgs } from "./init-args.js";
import { runInit } from "./init-flow.js";
import { authHeaders, authorizeDemo, instanceConfig, originOf, probeInstance, recipientIdentity } from "./instance.js";
import { keyDir } from "./keygen.js";
import { generateKeypair } from "./keypair.js";
import { openPodaj1 } from "./open-podaj1.js";
import { selectVars } from "./select-vars.js";
import { readStdinToken } from "./stdin-token.js";
import { clientBuilt, stageWorker, workerStageDir } from "./stage-worker.js";
import { waitReady } from "./wait-ready.js";

const repoRoot = packageRoot(import.meta.url);
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const usage = () => {
  console.error(`usage:
  podaj init
  podaj init --url https://<name>.workers.dev   # private: PODAJ_API_AUTH_SECRET on stdin
  podaj init --deploy
  podaj wait [KEY ...]
  podaj keygen
  podaj decrypt [PODAJ1.blob]

init   connect to a worker you already deployed, or deploy one after Cloudflare login
wait   reserve a fill link, block until those keys are pasted, print them as JSON`);
  process.exit(2);
};

const answered = async (value: unknown): Promise<string> => {
  if (isCancel(value) || typeof value !== "string" || value.length === 0) {
    cancel("stopped");
    process.exit(0);
  }
  return value;
};

const capture = (bin: string, args: string[], opts: { input?: string; redact?: string } = {}) => {
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: opts.input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const output = opts.redact ? raw.replaceAll(opts.redact, "[redacted]") : raw;
  process.stderr.write(output);
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed`);
  }
  return output;
};

const tool = packageTool;

const runtimeConfig = () => {
  const file = readConfig(defaultConfigPath());
  const url = (process.env.PODAJ_URL ?? file?.url ?? "").replace(/\/$/u, "");
  const savedToken = file !== null && originOf(file.url) === originOf(url) ? file.token : "";
  const token = readStdinToken() ?? process.env.PODAJ_API_AUTH_SECRET ?? savedToken;
  if (url.length === 0) {
    throw new Error("no podaj url — run podaj init");
  }
  return { token, url: originOf(url) };
};

const fail: (message: string) => never = (message) => {
  throw new Error(message);
};

const tokenOnStdin = (args: InitArgs) => {
  if (!args.tokenStdin && (args.url === undefined || args.token !== undefined)) {
    return args;
  }
  const token = readStdinToken(args.tokenStdin);
  if (token === undefined && args.tokenStdin) {
    throw new Error("pass PODAJ_API_AUTH_SECRET on stdin");
  }
  return { ...args, ...(token === undefined ? {} : { token }), tokenStdin: false };
};

const init = async (argv: string[]) => {
  const args = tokenOnStdin(initArgs(argv));
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
              hint: "you already set PODAJ_API_AUTH_SECRET on that worker",
              label: "I have the token",
              value: "have",
            },
            {
              hint: "wrangler stores a new token as PODAJ_API_AUTH_SECRET",
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
              originOf(value);
              return undefined;
            } catch {
              return "enter an HTTPS URL, or HTTP for localhost";
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
    isTTY: tty,
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
    config: instanceConfig,
    probe: probeInstance,
    putSecret: (target, token) => {
      const secretArgs = ["secret", "put", "PODAJ_API_AUTH_SECRET"];
      if (target.configPath !== undefined) {
        secretArgs.push("--config", target.configPath);
      }
      if (target.name !== undefined) {
        secretArgs.push("--name", target.name);
      }
      capture(wrangler, secretArgs, { input: `${token}\n`, redact: token });
    },
    save: (config) => {
      const file = defaultConfigPath();
      writeConfig(file, {
        token: config.token,
        url: config.url,
      });
      if (interactive) {
        outro(config.url);
      }
      process.stdout.write(
        `${JSON.stringify({ config: file, mode: config.mode, url: config.url }, null, 2)}\n`,
      );
    },
    stage: () =>
      stageWorker({
        packageRoot: repoRoot,
        stage: workerStageDir(homedir()),
      }),
    whoami: () =>
      spawnSync(wrangler, ["whoami"], { encoding: "utf8" }).status === 0,
    workersUrl,
  });
};

const wait = async (keys: string[]) => {
  for (const key of keys) {
    if (!KEY_NAME.test(key)) {
      fail(`not an env key: ${key}`);
    }
  }
  const { token, url } = runtimeConfig();
  const { privateKey: privatePem, publicKey: publicPem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const { fingerprint } = recipientIdentity(publicPem);
  const config = await instanceConfig(url);
  const creationToken = config.mode === "demo"
    ? await authorizeDemo(url, publicPem, (message) => process.stderr.write(`${message}\n`))
    : token;
  const response = await fetch(new URL("/api/handoffs/reserve", url), {
    body: JSON.stringify({ recipientPublicKey: publicPem }),
    headers: { ...authHeaders(creationToken), "Content-Type": "application/json" },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    fail(`reserve failed (${response.status})`);
  }
  const reserved = reservedBody(await response.json(), fingerprint);
  const link = composeUrl(url, reserved.id, reserved.writeToken, publicPem);
  process.stderr.write(
    keys.length === 0
      ? `paste env vars and click send:\n${link}\n`
      : `paste these keys and click send:\n${keys.join("\n")}\n${link}\n`,
  );
  await waitReady(reserved.id, url, reserved.subscribeToken, {
    timeoutMs: Math.max(1, reserved.expiresAt - Date.now()),
  });
  const fetched = await fetch(new URL(`/api/handoffs/${reserved.id}/consume`, url), {
    method: "POST",
    headers: authHeaders(reserved.readToken),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!fetched.ok) {
    fail(`read failed (${fetched.status})`);
  }
  const sealed = sealedBody(await fetched.json(), fingerprint);
  const picked = selectVars(openPodaj1(sealed, privatePem), keys);
  process.stdout.write(`${JSON.stringify(picked, null, 2)}\n`);
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("unexpected json");
  }
  return value as Record<string, unknown>;
};

const reservedBody = (value: unknown, fingerprint: string): Reservation => {
  const body = record(value);
  const { id, writeToken, readToken, subscribeToken, expiresAt, recipientFingerprint } = body;
  const validCapability = (cap: unknown): cap is string =>
    typeof cap === "string" && /^[a-f0-9]{64}$/u.test(cap);
  const capabilities = [writeToken, readToken, subscribeToken];
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/u.test(id) ||
      !validCapability(writeToken) || !validCapability(readToken) || !validCapability(subscribeToken) ||
      new Set(capabilities).size !== 3 ||
      typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0 ||
      typeof recipientFingerprint !== "string" || recipientFingerprint !== fingerprint) {
    fail("reserve returned an unexpected body or recipient fingerprint");
  }
  return { id, writeToken, readToken, subscribeToken, expiresAt, recipientFingerprint };
};

const sealedBody = (value: unknown, fingerprint: string): string => {
  const body = record(value);
  const sealed = body.sealed;
  if (typeof sealed !== "string" || body.recipientFingerprint !== fingerprint) {
    fail("read returned an unexpected body");
  }
  return sealed;
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
      decryptHandoff(rest);
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
