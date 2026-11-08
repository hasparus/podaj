import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { configPath, readConfig, writeConfig } from "../scripts/config.js";
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
  it("resolves source and compiled tools to the same package, independent of cwd", () => {
    const root = resolve(".");
    expect(packageRoot(pathToFileURL(join(root, "scripts/podaj.ts")).href)).toBe(root);
    expect(packageRoot(pathToFileURL(join(root, "dist/scripts/podaj.js")).href)).toBe(root);
    expect(packageTool("wrangler")).toBe(join(root, "node_modules/.bin/wrangler"));
  });

  it("runs compiled helpers from an installed layout and stages that package's assets and worker", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "podaj-installed-")));
    const root = join(home, "package");
    try {
      mkdirSync(join(root, "dist/client"), { recursive: true });
      writeFileSync(join(root, "package.json"), readFileSync(resolve("package.json")));
      const installedConfig = '{"name":"synthetic-installed-worker"}\n';
      writeFileSync(join(root, "wrangler.jsonc"), installedConfig);
      cpSync(resolve("dist/scripts"), join(root, "dist/scripts"), { recursive: true });
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
      for (const name of ["index.html", "authorize.html", "_headers"]) {
        writeFileSync(join(root, "dist/client", name), "synthetic asset");
      }
      const paths = pathToFileURL(join(root, "dist/scripts/package-paths.js")).href;
      const stage = pathToFileURL(join(root, "dist/scripts/stage-worker.js")).href;
      const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
        import { packageRoot, packageTool } from ${JSON.stringify(paths)};
        import { stageWorker } from ${JSON.stringify(stage)};
        const root = packageRoot(${JSON.stringify(paths)});
        console.log(JSON.stringify({ root, tool: packageTool("wrangler"), config: stageWorker({ packageRoot: root, stage: ${JSON.stringify(join(home, "stage"))} }) }));
      `], { cwd: home, env: isolatedEnv(home), encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({
        root, tool: join(root, "node_modules/.bin/wrangler"), config: join(home, "stage/wrangler.json"),
      });
      expect(readFileSync(join(home, "stage/assets/index.html"), "utf8")).toBe("synthetic asset");
      expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toBe(installedConfig);
      expect(existsSync(join(root, "public/recipient.pem"))).toBe(false);
      expect(readFileSync(join(home, "stage/entry.ts"), "utf8")).toContain(join(root, "src/worker.ts"));
      expect(existsSync(join(root, "scripts"))).toBe(false);
      const run = () => execFileSync(process.execPath, [join(root, "dist/scripts/podaj.js")], {
        cwd: home, env: isolatedEnv(home), encoding: "utf8", stdio: "pipe",
      });
      expect(run).toThrow(expect.objectContaining({ status: 2, stderr: expect.stringContaining("usage:") }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("packs the executable Node bin and compiled helpers rather than TypeScript script sources", () => {
    const home = mkdtempSync(join(tmpdir(), "podaj-pack-"));
    try {
      const output = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
        cwd: resolve("."), env: isolatedEnv(home), encoding: "utf8", stdio: "pipe", timeout: 15_000,
      });
      const packages: unknown = JSON.parse(output);
      if (!Array.isArray(packages)) throw new Error("invalid pack result");
      const first: unknown = packages[0];
      if (typeof first !== "object" || first === null || !("files" in first) || !Array.isArray(first.files)) {
        throw new Error("missing pack files");
      }
      const files: readonly unknown[] = first.files;
      const paths = files.map((file) => {
        if (typeof file !== "object" || file === null || !("path" in file) || typeof file.path !== "string") {
          throw new Error("invalid pack file");
        }
        return file.path;
      });
      expect(paths).toContain("dist/scripts/podaj.js");
      expect(paths).toContain("dist/scripts/hooks/block-git-no-verify.js");
      expect(paths).toContain("dist/scripts/decrypt-handoff.js");
      expect(paths.some((path) => path.startsWith("scripts/") || path.endsWith(".mjs"))).toBe(false);
      expect(statSync(resolve("dist/scripts/podaj.js")).mode & 0o111).not.toBe(0);
      const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
      expect(manifest.bin.podaj).toBe("dist/scripts/podaj.js");
      expect(manifest.files).not.toContain("public/recipient.pem.example");
      expect(paths).not.toContain("public/recipient.pem");
      expect(paths).not.toContain("public/recipient.pem.example");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
