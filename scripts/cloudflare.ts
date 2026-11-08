#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDirect, packageRoot, packageTool } from "./package-paths.js";
import { parseEnv } from "node:util";

const ACCOUNTS = { test: "hasparus", demo: "podaj" };

export const cloudflareTarget = (target: string, source: string, ambient: NodeJS.ProcessEnv = process.env) => {
  if (target !== "test" && target !== "demo") {
    throw new Error("choose the test or demo Cloudflare target");
  }
  const credentials = parseEnv(source);
  const allowed = new Set(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  if (Object.keys(credentials).some((key) => !allowed.has(key))) {
    throw new Error("Cloudflare profiles accept only CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  }
  const accountId = credentials.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!/^[a-f0-9]{32}$/u.test(accountId)) {
    throw new Error(`set the ${ACCOUNTS[target]} account ID in .cloudflare/${target}.env first`);
  }
  const env = { ...ambient };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLOUDFLARE_") || key.startsWith("CF_")) delete env[key];
  }
  env.CLOUDFLARE_ACCOUNT_ID = accountId;
  if (credentials.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = credentials.CLOUDFLARE_API_TOKEN;
  env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "false";
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  env.WRANGLER_SEND_METRICS = "false";
  return { accountId, accountName: ACCOUNTS[target], env, workerName: "podaj" };
};

export const cloudflareCommand = (args: string[]) => {
  if (args.length === 1 && (args[0] === "whoami" || args[0] === "login")) return args;
  if (args.length === 2 && args[0] === "secret" && args[1] === "list") return args;
  if (args.length === 3 && args[0] === "secret" && args[1] === "put" && /^[A-Z_][A-Z0-9_]*$/u.test(args[2] ?? "")) return args;
  throw new Error("allowed: whoami, login, secret list, or secret put NAME (enter the value at the prompt)");
};

const main = (argv: string[]) => {
  const [target, ...input] = argv;
  if (target !== "test" && target !== "demo") {
    throw new Error("choose the test or demo Cloudflare target");
  }
  const args = cloudflareCommand(input[0] === "--" ? input.slice(1) : input);
  const root = packageRoot(import.meta.url);
  const profile = join(root, ".cloudflare", `${target}.env`);
  let source;
  try {
    source = readFileSync(profile, "utf8");
  } catch {
    throw new Error("copy the matching .cloudflare/*.env.example to an ignored .env profile and set its account ID");
  }
  const selected = cloudflareTarget(target ?? "", source);
  const scratch = mkdtempSync(join(root, ".cloudflare", "wrangler-"));
  try {
    const config = join(scratch, "wrangler.json");
    writeFileSync(config, JSON.stringify({ account_id: selected.accountId, name: selected.workerName }), { mode: 0o600 });
    const command = [
      packageTool("wrangler"),
      ...args, "--config", config, "--env-file", profile,
      ...(args[0] === "secret" ? ["--name", selected.workerName] : []),
    ];
    process.stderr.write(`Cloudflare target: ${selected.accountName} / ${selected.workerName} (${target}).\n`);
    const result = spawnSync(process.execPath, command, { cwd: root, env: selected.env, stdio: "inherit" });
    if (result.error) throw new Error("could not start the installed Wrangler");
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

if (isDirect(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cloudflare setup failed");
    process.exitCode = 1;
  }
}
