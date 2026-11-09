#!/usr/bin/env node
import type { ConfigArgs } from "./config-args.js";
import type { SetupIo } from "./setup-flow.js";
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
import { join } from "node:path";
import { packageRoot, packageTool } from "./package-paths.js";
import { decryptHandoff } from "./decrypt-handoff.js";

import {
  defaultConfigPath,
  readConfig,
  resolveConnection,
  writeConfig,
} from "./config.js";
import { composeUrl } from "./deploy-text.js";
import { configArgs } from "./config-args.js";
import { runConfig, runDeploy } from "./setup-flow.js";
import { authHeaders, authorizeDemo, instanceConfig, originOf, probeInstance, recipientIdentity } from "./instance.js";
import { keyDir } from "./keygen.js";
import { generateKeypair } from "./keypair.js";
import { openPodaj1 } from "./open-podaj1.js";
import { selectVars } from "./select-vars.js";
import { readStdinToken } from "./stdin-token.js";
import { clientBuilt, stageWorker, workerStageDir } from "./stage-worker.js";
import { waitReady } from "./wait-ready.js";
import { createWrangler } from "./wrangler.js";

const repoRoot = packageRoot(import.meta.url);
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const usage = () => {
  console.error(`usage:
  podaj wait [KEY ...]
  podaj deploy
  podaj config
  podaj config --url https://<name>.workers.dev   # private: PODAJ_API_AUTH_SECRET on stdin
  podaj keygen
  podaj decrypt [PODAJ1.blob]

wait    request variables using podaj.fyi by default; print the result as JSON
deploy  deploy your own worker and save its connection automatically
config  connect to an existing worker without deploying`);
  process.exit(2);
};

const answered = async (answer: Promise<string | symbol>): Promise<string> => {
  const value = await answer;
  if (isCancel(value) || typeof value !== "string" || value.length === 0) {
    cancel("stopped");
    process.exit(0);
  }
  return value;
};

const buildClient = () => {
  const result = spawnSync(process.execPath, [packageTool("vite"), "build"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", 2, 2],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("Vite build failed");
  }
};

const runtimeConfig = () => {
  const config = resolveConnection(process.env, readConfig(defaultConfigPath()));
  return { ...config, token: readStdinToken() ?? config.token };
};

const fail: (message: string) => never = (message) => {
  throw new Error(message);
};

const tokenOnStdin = (args: ConfigArgs) => {
  if (!args.tokenStdin && (args.url === undefined || args.token !== undefined)) {
    return args;
  }
  const token = readStdinToken(args.tokenStdin);
  if (token === undefined && args.tokenStdin) {
    throw new Error("pass PODAJ_API_AUTH_SECRET on stdin");
  }
  return { ...args, ...(token === undefined ? {} : { token }), tokenStdin: false };
};

const setup = async (command: "config" | "deploy", argv: string[]) => {
  if (command === "deploy" && argv.length > 0) {
    throw new Error("podaj deploy does not accept arguments");
  }
  const args: ConfigArgs = command === "config" ? tokenOnStdin(configArgs(argv)) : { tokenStdin: false };
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const interactive = tty && args.url === undefined;
  if (interactive) {
    intro("podaj");
  }
  const wrangler = createWrangler({
    bin: packageTool("wrangler"),
    workspace: join(homedir(), ".local", "share", "podaj", "wrangler"),
  });
  const io = {
    askToken: () =>
      answered(
        password({
          message: "Paste instance token",
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
    deploy: wrangler.deploy,
    ensureClient: () => {
      if (clientBuilt(repoRoot)) {
        return;
      }
      if (!existsSync(join(repoRoot, "vite.config.ts"))) {
        throw new Error(
          "client build is missing. Reinstall podaj so dist/client ships with the package.",
        );
      }
      buildClient();
    },
    isTTY: tty,
    login: wrangler.login,
    mintToken: () => randomBytes(32).toString("hex"),
    note: (message) => {
      log.info(message);
    },
    config: instanceConfig,
    probe: probeInstance,
    putSecret: wrangler.putSecret,
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
        `${JSON.stringify({ config: file, url: config.url }, null, 2)}\n`,
      );
    },
    stage: () =>
      stageWorker({
        packageRoot: repoRoot,
        stage: workerStageDir(homedir()),
      }),
    whoami: wrangler.whoami,
  } satisfies SetupIo;
  if (command === "deploy") await runDeploy(io);
  else await runConfig(args, io);
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
  const creationToken = config.access === "public"
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
    case "config":
    case "deploy":
      await setup(command, rest);
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
