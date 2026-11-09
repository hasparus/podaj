import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const accountId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) {
    throw new Error("Wrangler did not provide a valid account id; no secret was written");
  }
  return value;
};
const readWorkerConfig = (path: string) => {
  const errors: ParseError[] = [];
  const config: unknown = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0 || !record(config)) throw new Error("invalid staged Wrangler configuration");
  return config;
};
const accountCache = (cwd: string) => join(cwd, "node_modules", ".cache", "wrangler", "wrangler-account.json");

const selectedAccount = (cwd: string, config: Record<string, unknown>) => {
  if (config.account_id !== undefined) return accountId(config.account_id);
  let value: unknown;
  try { value = JSON.parse(readFileSync(accountCache(cwd), "utf8")); } catch {
    throw new Error("Wrangler did not cache the selected account; no secret was written");
  }
  if (!record(value) || !record(value.account) || typeof value.account.name !== "string") {
    throw new Error("Wrangler returned an invalid account cache; no secret was written");
  }
  return accountId(value.account.id);
};
const deploymentUrl = (path: string, config: Record<string, unknown>): string => {
  let entries: unknown[];
  try { entries = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)); } catch {
    throw new Error("Wrangler did not provide deployment metadata");
  }
  const deployments = entries.filter((entry) => record(entry) && entry.type === "deploy");
  const entry = deployments[0];
  if (deployments.length !== 1 || !record(entry) || entry.version !== 1 ||
    typeof entry.worker_name !== "string" || entry.worker_name !== config.name || !Array.isArray(entry.targets) ||
    entry.targets.some((target) => typeof target !== "string")) {
    throw new Error("Wrangler returned invalid deployment metadata");
  }
  const urls = entry.targets.filter((target): target is string => typeof target === "string" &&
    /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\/?$/u.test(target));
  if (urls.length !== 1) throw new Error("Wrangler deployment metadata must contain one workers.dev url");
  return new URL(urls[0]).origin;
};

/** Keep terminal selection, cache placement and pinned Wrangler wire formats at one boundary. */
export const createWrangler = ({ bin, workspace }: { bin: string; workspace: string }) => {
  const prepare = (cwd: string) => {
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(join(cwd, "node_modules"), { recursive: true, mode: 0o700 });
  };
  const temporary = <T>(action: (directory: string) => T): T => {
    prepare(workspace);
    const directory = mkdtempSync(join(workspace, "run-"));
    try { return action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
  };
  const invoke = (cwd: string, args: string[], directory: string, input?: string, capture = false) => {
    prepare(cwd);
    const output = join(directory, "output.jsonl");
    writeFileSync(output, "", { mode: 0o600, flag: "wx" });
    const result = spawnSync(process.execPath, [bin, ...args], {
      cwd,
      env: {
        ...process.env,
        WRANGLER_OUTPUT_FILE_PATH: output,
        WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
        WRANGLER_LOG: "log",
        WRANGLER_LOG_SANITIZE: "true",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_SEND_ERROR_REPORTS: "false",
      },
      encoding: "utf8",
      input,
      stdio: input !== undefined || capture ? ["pipe", "pipe", "pipe"] : ["inherit", 2, 2],
    });
    if (input !== undefined) {
      const secret = input.trimEnd();
      const message = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      process.stderr.write(secret.length > 0 ? message.replaceAll(secret, "[redacted]") : message);
    }
    if (result.error !== undefined) throw new Error(`Wrangler ${args[0]} could not run`);
    return { result, output };
  };
  const checked = (cwd: string, args: string[], directory: string, input?: string) => {
    const run = invoke(cwd, args, directory, input);
    if (run.result.status !== 0) throw new Error(`Wrangler ${args[0]} failed`);
    return run.output;
  };
  const pinAccount = (configPath: string, config: Record<string, unknown>) => {
    config.account_id = selectedAccount(dirname(configPath), config);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  };
  return {
    whoami: () => temporary((directory) => {
      const { result } = invoke(workspace, ["whoami"], directory, undefined, true);
      return result.status === 0 && result.stdout.includes("You are logged in with");
    }),
    login: () => temporary((directory) => { checked(workspace, ["login"], directory); }),
    deploy: (configPath: string) => temporary((directory) => {
      const config = readWorkerConfig(configPath);
      if (config.account_id !== undefined) accountId(config.account_id);
      const cwd = dirname(configPath);
      rmSync(accountCache(cwd), { force: true });
      const output = checked(cwd, ["deploy", "--config", configPath], directory);
      const url = deploymentUrl(output, config);
      pinAccount(configPath, config);
      return url;
    }),
    putSecret: (target: { configPath?: string; name?: string }, token: string) => {
      if (target.configPath !== undefined) {
        const configPath = target.configPath;
        accountId(readWorkerConfig(configPath).account_id);
        temporary((directory) => { checked(dirname(configPath), ["secret", "put", "PODAJ_API_AUTH_SECRET", "--config", configPath], directory, `${token}\n`); });
      } else {
        if (target.name === undefined || !/^[a-zA-Z0-9_-]+$/u.test(target.name)) throw new Error("invalid worker name");
        temporary((directory) => {
          const configPath = join(directory, "wrangler.json");
          const config: Record<string, unknown> = { name: target.name };
          writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
          temporary((logs) => { checked(directory, ["secret", "list", "--config", configPath], logs); });
          pinAccount(configPath, config);
          temporary((logs) => { checked(directory, ["secret", "put", "PODAJ_API_AUTH_SECRET", "--config", configPath], logs, `${token}\n`); });
        });
      }
    },
  };
};
