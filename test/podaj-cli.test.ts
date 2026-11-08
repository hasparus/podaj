import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";

import { configPath, DEFAULT_URL, readConfig, resolveConnection, writeConfig } from "../scripts/config.js";
import { composeUrl, workersUrl } from "../scripts/deploy-text.js";
import { recipientIdentity } from "../scripts/instance.js";
import { selectVars } from "../scripts/select-vars.js";
import { packageRoot, packageTool } from "../scripts/package-paths.js";
import { applyCommandPolicy } from "../scripts/vcs-command-policy.js";

describe("podaj config", () => {
  it("writes url and token under XDG_CONFIG_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "podaj-config-"));
    const file = configPath({ XDG_CONFIG_HOME: home }, "/unused");
    try {
      writeConfig(file, { token: "synthetic-secret", url: "http://localhost:8787" });
      expect(readConfig(file)).toEqual({ token: "synthetic-secret", url: "http://localhost:8787" });
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["url", "token"]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("connection selection", () => {
  const saved = { url: "https://private.example.test", token: "synthetic-private-secret" };

  it("defaults to the hosted demo without a saved connection", () => {
    expect(DEFAULT_URL).toBe("https://podaj.fyi");
    expect(resolveConnection({}, null)).toEqual({ url: DEFAULT_URL, token: "" });
  });

  it("prefers saved self-hosted configuration over the demo", () => {
    expect(resolveConnection({}, saved)).toEqual(saved);
  });

  it("prefers an explicit URL without forwarding another origin's saved token", () => {
    expect(resolveConnection({ PODAJ_URL: DEFAULT_URL }, saved)).toEqual({ url: DEFAULT_URL, token: "" });
    expect(resolveConnection({ PODAJ_URL: `${saved.url}/` }, saved)).toEqual(saved);
    expect(resolveConnection({ PODAJ_URL: DEFAULT_URL, PODAJ_API_AUTH_SECRET: "explicit-token" }, saved))
      .toEqual({ url: DEFAULT_URL, token: "explicit-token" });
  });

  it("does not silently fall back to the demo for an invalid explicit URL", () => {
    expect(() => resolveConnection({ PODAJ_URL: "" }, saved)).toThrow();
    expect(() => resolveConnection({ PODAJ_URL: "http://remote.example.test" }, saved)).toThrow(/HTTPS/u);
  });
});

describe("private config replacement", () => {
  it("repairs existing permissions and replaces destination symlinks without following them", () => {
    const home = mkdtempSync(join(tmpdir(), "podaj-config-permissions-"));
    const directory = join(home, "podaj");
    const file = join(directory, "config.json");
    const outside = join(home, "outside.json");
    try {
      mkdirSync(directory);
      writeFileSync(file, "old", { mode: 0o644 });
      chmodSync(directory, 0o755);
      writeConfig(file, { url: "https://podaj.test", token: "synthetic-secret" });
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      writeFileSync(outside, "outside sentinel");
      rmSync(file);
      symlinkSync(outside, file);
      writeConfig(file, { url: "https://podaj.test", token: "replacement-secret" });
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(outside, "utf8")).toBe("outside sentinel");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("refuses an application-directory symlink before writing a token", () => {
    const home = mkdtempSync(join(tmpdir(), "podaj-config-symlink-"));
    const outside = join(home, "outside");
    try {
      mkdirSync(outside);
      symlinkSync(outside, join(home, "podaj"), "dir");
      expect(() => writeConfig(join(home, "podaj/config.json"), { url: "https://podaj.test", token: "secret" })).toThrow("must not be a symlink");
      expect(existsSync(join(outside, "config.json"))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("selectVars", () => {
  const plain = JSON.stringify({
    vars: [
      { key: "OPENAI_API_KEY", value: "sk-1" },
      { key: "OTHER", value: "nope" },
    ],
  });

  it("returns only the requested keys", () => {
    expect(selectVars(plain, ["OPENAI_API_KEY"])).toEqual({
      OPENAI_API_KEY: "sk-1",
    });
  });

  it("fails when a requested key was not pasted", () => {
    expect(() => selectVars(plain, ["MISSING"])).toThrow(/missing MISSING/u);
  });
});

describe("deploy text", () => {
  it("reads the workers.dev url", () => {
    expect(
      workersUrl("Deployed podaj\n  https://podaj.me.workers.dev\n"),
    ).toBe("https://podaj.me.workers.dev");
  });
  it("puts only the write capability and own SPKI in the fill fragment", () => {
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    const link = new URL(composeUrl("http://localhost:8787", "aa", "synthetic-write", publicKey));
    expect(link.pathname).toBe("/s/aa");
    expect(link.search).toBe("");
    const fragment = new URLSearchParams(link.hash.slice(1));
    expect([...fragment.keys()]).toEqual(["write", "recipient"]);
    expect(fragment.get("write")).toBe("synthetic-write");
    expect(fragment.get("recipient")).toBe(recipientIdentity(publicKey).encoded);
  });
});

const isolatedEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  npm_config_cache: join(home, "npm-cache"),
  npm_config_userconfig: "/dev/null",
});

describe("compiled CLI distribution", () => {
  it("waits on the public demo without setup, Bun, or a configured URL", () => {
    const home = mkdtempSync(join(tmpdir(), "podaj-default-demo-"));
    const calls = join(home, "requests.jsonl");
    const preload = join(home, "default-host.mjs");
    try {
      buildSync({ entryPoints: [resolve("test/helpers/default-host.ts")], outfile: preload, platform: "node", format: "esm", target: "node22" });
      let result: { status: number | null; stdout: string; stderr: string } | undefined;
      try {
        execFileSync(process.execPath, ["--import", preload, resolve("dist/scripts/podaj.js"), "wait", "API_KEY"], {
          cwd: home, env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: "/nonexistent", PODAJ_TEST_DEFAULT_HOST_LOG: calls },
          input: "", encoding: "utf8", stdio: "pipe", timeout: 10_000,
        });
      } catch (error) {
        result = error as typeof result;
      }
      expect(result?.status).toBe(1);
      expect(result?.stdout).toBe("");
      expect(result?.stderr).toContain("authorize this request in your browser:\nhttps://podaj.fyi/authorize#");
      expect(result?.stderr).toContain("authorization failed (503)");
      expect(readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { url: "https://podaj.fyi/api/config", authenticated: false },
        { url: "https://podaj.fyi/api/demo/status", authenticated: true },
      ]);
      expect(existsSync(join(home, "config/podaj/config.json"))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("resolves source and compiled tools to the same package, independent of cwd", () => {
    const root = resolve(".");
    expect(packageRoot(pathToFileURL(join(root, "scripts/podaj.ts")).href)).toBe(root);
    expect(packageRoot(pathToFileURL(join(root, "dist/scripts/podaj.js")).href)).toBe(root);
    expect(packageTool("wrangler")).toBe(join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin/wrangler.js"));
  });
});

describe("typed command hook", () => {
  it("still rejects git hook bypass and keeps noninteractive VCS policy", () => {
    expect(applyCommandPolicy("git commit --no-verify").action).toBe("block");
    expect(applyCommandPolicy("git status")).toMatchObject({ action: "allow", command: expect.stringContaining("GIT_EDITOR=:") });
  });

  it.each([
    { command: "git commit --no-verify" },
    { input: { command: "/usr/bin/git commit --no-verify" } },
    { tool_input: { command: "git commit --no-verify" }, hook_event_name: "PreToolUse" },
  ])("blocks supported payload shapes in the compiled hook: %j", (payload) => {
    const home = mkdtempSync(join(tmpdir(), "podaj-hook-"));
    try {
      const output = execFileSync(process.execPath, [resolve("dist/scripts/hooks/block-git-no-verify.js")], {
        env: isolatedEnv(home), input: JSON.stringify(payload), encoding: "utf8",
      });
      const decision: unknown = JSON.parse(output);
      expect(decision).toMatchObject("tool_input" in payload
        ? { hookSpecificOutput: { permissionDecision: "deny" } }
        : { permission: "deny" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["null", "[]", "17", '{"tool_input":null}', '{"input":{"command":123}}', "not JSON"])("parses unknown input without crashing: %s", (input) => {
    const home = mkdtempSync(join(tmpdir(), "podaj-hook-"));
    try {
      expect(() => execFileSync(process.execPath, [resolve("dist/scripts/hooks/block-git-no-verify.js")], {
        env: isolatedEnv(home), input, encoding: "utf8",
      })).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
