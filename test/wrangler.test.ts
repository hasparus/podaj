import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { packageTool } from "../scripts/package-paths.js";
import { localCloudflare, syntheticAccounts } from "./helpers/cloudflare-api.js";
import { runTerminal } from "./helpers/terminal.js";

const metadata = { type: "deploy", version: 1, worker_name: "synthetic-worker", targets: ["https://installed-fixture.example.workers.dev"] };
const fixture = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "podaj-wrangler-")));
  const workspace = join(home, "workspace");
  const stage = join(home, "stage");
  mkdirSync(stage);
  const configPath = join(stage, "wrangler.json");
  writeFileSync(configPath, JSON.stringify({ name: "synthetic-worker", main: "entry.js", compatibility_date: "2025-10-11" }));
  writeFileSync(join(stage, "entry.js"), "export default { fetch() { return new Response('synthetic'); } };\n");
  const fake = join(home, "fake-wrangler.cjs");
  const driver = join(home, "driver.mjs");
  const networkGuard = join(home, "local-network-only.cjs");
  buildSync({ entryPoints: [resolve("test/helpers/local-network-only.ts")], outfile: networkGuard, platform: "node", format: "cjs", target: "node22" });
  buildSync({ entryPoints: [resolve("test/helpers/fake-wrangler.ts")], outfile: fake, platform: "node", format: "cjs", target: "node22" });
  buildSync({ entryPoints: [resolve("test/helpers/wrangler-driver.ts")], outfile: driver, platform: "node", format: "esm", target: "node22" });
  const calls = join(home, "calls.jsonl");
  const env = {
    HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: "/nonexistent", TERM: "xterm-256color", NO_COLOR: "1",
    PODAJ_TEST_ADAPTER: pathToFileURL(resolve("dist/scripts/wrangler.js")).href,
    PODAJ_TEST_WRANGLER_LOG: calls,
    NODE_OPTIONS: `--require=${networkGuard}`,
  };
  const command = (bin = fake, action = "deploy", target = configPath) => [driver, bin, workspace, action, target];
  const run = (extra: Record<string, string> = {}, action = "deploy") => new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, command(fake, action, action === "secret" ? "synthetic-worker" : configPath), { cwd: home, env: { ...env, ...extra }, timeout: 15_000 }, (error, stdout, stderr) => {
      done({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr });
    });
  });
  const invocations = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { home, workspace, stage, configPath, calls, env, command, run, invocations, cleanup: () => rmSync(home, { recursive: true, force: true }) };
};

describe("pinned Wrangler boundary", { timeout: 30_000 }, () => {
  it("uses structured deployment metadata, pins the selected account and keeps stdout JSON-only", async () => {
    const f = fixture();
    try {
      const result = await f.run();
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ url: metadata.targets[0] });
      expect(result.stderr).toContain("https://decoy.example.workers.dev");
      const calls = f.invocations();
      expect(calls.map((call) => call.cwd)).toEqual([f.stage, f.stage]);
      expect(calls.map((call) => call.account)).toEqual([null, syntheticAccounts[0]]);
      expect(calls.map((call) => call.outputMode)).toEqual([0o600, 0o600]);
      expect(JSON.parse(readFileSync(f.configPath, "utf8")).account_id).toBe(syntheticAccounts[0]);
      expect(readdirSync(f.workspace)).toEqual(["node_modules"]);
      expect(readFileSync(f.calls, "utf8")).not.toContain("synthetic-adapter-secret");
    } finally { f.cleanup(); }
  });

  it.each([
    "", "not json", JSON.stringify({ ...metadata, version: 2 }), JSON.stringify({ ...metadata, worker_name: "another-worker" }),
    JSON.stringify({ ...metadata, targets: ["http://insecure.workers.dev"] }),
    JSON.stringify({ ...metadata, targets: [metadata.targets[0], 42] }),
    `${JSON.stringify(metadata)}\n${JSON.stringify(metadata)}`,
  ])("does not write a secret for missing, malformed or ambiguous deployment metadata (%s)", async (value) => {
    const f = fixture();
    try {
      const result = await f.run({ PODAJ_TEST_DEPLOY_METADATA: value });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(f.invocations().map((call) => call.args[0])).toEqual(["deploy"]);
      expect(readdirSync(f.workspace)).toEqual(["node_modules"]);
    } finally { f.cleanup(); }
  });

  it.each(["", "not json", "{}", JSON.stringify({ account: { id: "B".repeat(32), name: "bad id" } }), JSON.stringify({ account: { id: syntheticAccounts[1] } })])("rejects missing or invalid account evidence, even with a stale cache (%s)", async (value) => {
    const f = fixture();
    try {
      const directory = join(f.stage, "node_modules/.cache/wrangler");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "wrangler-account.json"), JSON.stringify({ account: { id: syntheticAccounts[1], name: "stale" } }));
      const result = await f.run({ PODAJ_TEST_ACCOUNT_CACHE: value });
      expect(result.code).toBe(1);
      expect(f.invocations().map((call) => call.args[0])).toEqual(["deploy"]);
      expect(JSON.parse(readFileSync(f.configPath, "utf8")).account_id).toBeUndefined();
    } finally { f.cleanup(); }
  });

  it("accepts a valid explicit configured account without a selector cache", async () => {
    const f = fixture();
    try {
      const config = JSON.parse(readFileSync(f.configPath, "utf8"));
      writeFileSync(f.configPath, JSON.stringify({ ...config, account_id: syntheticAccounts[1] }));
      const result = await f.run({ PODAJ_TEST_ACCOUNT_CACHE: "" });
      expect(result.code, result.stderr).toBe(0);
      expect(f.invocations().map((call) => call.account)).toEqual([syntheticAccounts[1], syntheticAccounts[1]]);
    } finally { f.cleanup(); }
  });

  it("rejects an invalid explicit account before invoking Wrangler", async () => {
    const f = fixture();
    try {
      writeFileSync(f.configPath, JSON.stringify({ name: "synthetic-worker", account_id: "invalid" }));
      expect((await f.run()).code).toBe(1);
      expect(f.invocations()).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("selects via a read-only operation before a name-only secret write, then removes the private workspace", async () => {
    const f = fixture();
    try {
      const result = await f.run({}, "secret");
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ stored: true });
      const calls = f.invocations();
      expect(calls.map((call) => call.args.slice(0, 2))).toEqual([["secret", "list"], ["secret", "put"]]);
      expect(calls.map((call) => call.account)).toEqual([null, syntheticAccounts[0]]);
      expect(calls[0].cwd).toBe(calls[1].cwd);
      expect(existsSync(calls[0].cwd)).toBe(false);
      expect(readdirSync(f.workspace)).toEqual(["node_modules"]);
    } finally { f.cleanup(); }
  });

  it.each(["", "not json", "{}"])("name-only setup fails closed without valid fresh account evidence (%s)", async (value) => {
    const f = fixture();
    try {
      const result = await f.run({ PODAJ_TEST_ACCOUNT_CACHE: value }, "secret");
      expect(result.code).toBe(1);
      expect(f.invocations().map((call) => call.args.slice(0, 2))).toEqual([["secret", "list"]]);
      expect(readdirSync(f.workspace)).toEqual(["node_modules"]);
    } finally { f.cleanup(); }
  });

  it("redacts echoed secret failures and deletes raw Wrangler debug logs", async () => {
    const f = fixture();
    try {
      const unsafeLog = join(f.home, "inherited-unsafe.log");
      const unsafeOutput = join(f.home, "inherited-output.jsonl");
      const result = await f.run({
        PODAJ_TEST_ECHO_SECRET: "1", WRANGLER_LOG_PATH: unsafeLog,
        WRANGLER_OUTPUT_FILE_PATH: unsafeOutput, WRANGLER_LOG_SANITIZE: "false", WRANGLER_LOG: "debug",
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[redacted]");
      expect(result.stderr).not.toContain("synthetic-adapter-secret");
      expect(existsSync(unsafeLog)).toBe(false);
      expect(existsSync(unsafeOutput)).toBe(false);
      expect(readdirSync(f.workspace)).toEqual(["node_modules"]);
    } finally { f.cleanup(); }
  });

  it("real Wrangler 4.45 reaches its account selector during deploy with inherited terminal stdio", async () => {
    const f = fixture();
    const api = await localCloudflare();
    try {
      const result = await runTerminal({
        command: [process.execPath, ...f.command(packageTool("wrangler"))], cwd: f.home,
        env: { ...f.env, CLOUDFLARE_API_BASE_URL: api.url, CLOUDFLARE_API_TOKEN: "synthetic-local-api-token" },
        steps: [["Select an account", "\u001b[B\r"]], timeoutMs: 20_000,
      });
      expect(result.code).not.toBe(0);
      expect(result.output).not.toContain("unable to select one in non-interactive mode");
      expect(JSON.parse(readFileSync(join(f.stage, "node_modules/.cache/wrangler/wrangler-account.json"), "utf8"))).toEqual({ account: { id: syntheticAccounts[1], name: "Synthetic account 2" } });
      expect(api.requests.some((request) => request.path.startsWith(`/accounts/${syntheticAccounts[1]}/`))).toBe(true);
      expect(api.requests.every((request) => request.method === "GET")).toBe(true);
      expect(readdirSync(f.workspace)).toEqual(["node_modules"]);
    } finally { await api.close(); f.cleanup(); }
  });

  it("real Wrangler ignores stale instance accounts, selects afresh, then pins its stdin-only secret write", async () => {
    const f = fixture();
    const pinnedAtWrite: unknown[] = [];
    const api = await localCloudflare(() => {
      for (const name of readdirSync(f.workspace).filter((entry) => entry.startsWith("run-"))) {
        const path = join(f.workspace, name, "wrangler.json");
        if (existsSync(path)) pinnedAtWrite.push(JSON.parse(readFileSync(path, "utf8")));
      }
    });
    try {
      const staleCacheDirectory = join(f.workspace, "node_modules/.cache/wrangler");
      mkdirSync(staleCacheDirectory, { recursive: true });
      const staleCachePath = join(staleCacheDirectory, "wrangler-account.json");
      const staleCache = JSON.stringify({ account: { id: syntheticAccounts[0], name: "Synthetic account 1" } });
      writeFileSync(staleCachePath, staleCache);
      const staleConfigPath = join(f.workspace, "wrangler.json");
      const staleConfig = JSON.stringify({ name: "synthetic-worker", account_id: syntheticAccounts[0] });
      writeFileSync(staleConfigPath, staleConfig);
      writeFileSync(f.configPath, staleConfig);
      const result = await runTerminal({
        command: [process.execPath, ...f.command(packageTool("wrangler"), "secret", "synthetic-worker")], cwd: f.home,
        env: { ...f.env, CLOUDFLARE_API_BASE_URL: api.url, CLOUDFLARE_API_TOKEN: "synthetic-local-api-token" },
        steps: [["Select an account", "\u001b[B\r"]], timeoutMs: 20_000,
      });
      expect(result.code, result.output).toBe(0);
      expect(api.requests.filter((request) => request.path.startsWith("/memberships"))).toHaveLength(1);
      expect(result.output).not.toContain("synthetic-adapter-secret");
      const secrets = api.requests.filter((request) => request.path.endsWith("/secrets"));
      expect(secrets).toEqual([
        { method: "GET", path: `/accounts/${syntheticAccounts[1]}/workers/scripts/synthetic-worker/secrets` },
        { method: "PUT", path: `/accounts/${syntheticAccounts[1]}/workers/scripts/synthetic-worker/secrets`, secretMatched: true },
      ]);
      expect(pinnedAtWrite).toEqual([{ name: "synthetic-worker", account_id: syntheticAccounts[1] }]);
      expect(readFileSync(staleCachePath, "utf8")).toBe(staleCache);
      expect(readFileSync(staleConfigPath, "utf8")).toBe(staleConfig);
      expect(readFileSync(f.configPath, "utf8")).toBe(staleConfig);
      expect(readdirSync(f.workspace)).toEqual(["node_modules", "wrangler.json"]);
    } finally { await api.close(); f.cleanup(); }
  });
});
