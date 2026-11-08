import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { packageTool } from "../scripts/package-paths.js";
import { runTerminal } from "./helpers/terminal.js";

const exec = promisify(execFile);
const fixture = (loginRequired = false) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "podaj-tools-")));
  const root = join(home, "node_modules", "podaj");
  const wrangler = join(home, "node_modules", "wrangler");
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(wrangler, "bin"), { recursive: true });
  cpSync(resolve("dist/scripts"), join(root, "dist/scripts"), { recursive: true });
  if (existsSync(resolve("dist/src"))) cpSync(resolve("dist/src"), join(root, "dist/src"), { recursive: true });
  cpSync(resolve("dist/client"), join(root, "dist/client"), { recursive: true });
  cpSync(resolve("src"), join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), readFileSync(resolve("package.json")));
  writeFileSync(join(root, "wrangler.jsonc"), readFileSync(resolve("wrangler.jsonc")));
  for (const name of ["@clack", "ws", "jsonc-parser"]) {
    symlinkSync(resolve("node_modules", name), join(home, "node_modules", name), "dir");
  }
  writeFileSync(join(wrangler, "package.json"), JSON.stringify({ name: "wrangler", version: "0.0.0", bin: { wrangler: "bin/wrangler.js" } }));
  const calls = join(home, "calls.jsonl");
  buildSync({ entryPoints: [resolve("test/helpers/fake-wrangler.ts")], outfile: join(wrangler, "bin/wrangler.js"), platform: "node", format: "cjs", target: "node22" });
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: "/nonexistent", TERM: "xterm-256color", NO_COLOR: "1", PODAJ_TEST_WRANGLER_LOG: calls, PODAJ_TEST_LOGIN_REQUIRED: loginRequired ? "1" : "0" };
  const configFile = join(home, "config", "podaj", "config.json");
  const run = (steps: [string, string][], timeoutMs?: number, command = "config") => runTerminal({
    command: [process.execPath, join(root, "dist/scripts/podaj.js"), command], cwd: home, env, steps, timeoutMs,
  });
  return { home, root, calls, configFile, run };
};

describe("Node dependency tools and actual terminal prompts", { timeout: 20_000 }, () => {
  it("resolves hoisted Wrangler from a compiled module, not cwd or a nested .bin", () => {
    const instance = fixture();
    try {
      expect(existsSync(join(instance.root, "node_modules"))).toBe(false);
      expect(packageTool("wrangler", pathToFileURL(join(instance.root, "dist/scripts/package-paths.js")).href))
        .toBe(join(instance.home, "node_modules/wrangler/bin/wrangler.js"));
    } finally { rmSync(instance.home, { recursive: true, force: true }); }
  });

  it("does not install hooks in a consumer's parent repository or require Bun for published prepare", async () => {
    const instance = fixture();
    try {
      await exec("git", ["init", "--quiet", instance.home]);
      const hook = join(instance.home, ".git/hooks/pre-commit");
      writeFileSync(hook, "parent hook sentinel\n");
      const prepared = await exec(process.execPath, [join(instance.root, "dist/scripts/prepare.js")], {
        cwd: instance.home, env: { PATH: "/nonexistent" },
      });
      expect(prepared.stdout).toBe("");
      expect(prepared.stderr).toBe("");
      const manifest = JSON.parse(readFileSync(join(instance.root, "package.json"), "utf8"));
      const lifecycle = await exec("/bin/sh", ["-c", manifest.scripts.prepare], {
        cwd: instance.root, env: { PATH: "/nonexistent" },
      });
      expect(lifecycle.stdout).toBe("");
      expect(readFileSync(hook, "utf8")).toBe("parent hook sentinel\n");
    } finally { rmSync(instance.home, { recursive: true, force: true }); }
  });

  it("installs checkout hooks quietly on install, but not during pack", async () => {
    const instance = fixture();
    try {
      await exec("git", ["init", "--quiet", instance.root]);
      writeFileSync(join(instance.root, "lefthook.yml"), "pre-commit: {}\n");
      const dependency = join(instance.home, "node_modules/lefthook");
      mkdirSync(join(dependency, "bin"), { recursive: true });
      writeFileSync(join(dependency, "package.json"), '{"name":"lefthook"}');
      const installed = join(instance.home, "hooks-installed");
      buildSync({ entryPoints: [resolve("test/helpers/fake-lefthook.ts")], outfile: join(dependency, "bin/index.js"), platform: "node", format: "cjs", target: "node22" });
      const env = { PATH: process.env.PATH, HOME: instance.home, npm_command: "install", PODAJ_TEST_LEFTHOOK_LOG: installed };
      const prepare = () => exec(process.execPath, [join(instance.root, "dist/scripts/prepare.js")], { cwd: instance.root, env });
      const result = await prepare();
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(readFileSync(installed, "utf8")).toBe("installed");
      rmSync(installed);
      env.npm_command = "pack";
      expect((await prepare()).stdout).toBe("");
      expect(existsSync(installed)).toBe(false);
    } finally { rmSync(instance.home, { recursive: true, force: true }); }
  });

  it("config waits for private connection answers in a real PTY without deploying", async () => {
    const instance = fixture();
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/config") {
        response.end(JSON.stringify({ access: "private", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 }));
      } else {
        response.writeHead(request.headers.authorization === "Bearer terminal-fixture-token" ? 200 : 401);
        response.end("{}");
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const result = await instance.run([
        ["Worker URL", `${origin}\r`],
        ["I have the token", "\r"],
        ["Paste instance token", "terminal-fixture-token\r"],
      ]);
      expect(result.code).toBe(0);
      expect(result.output).not.toContain("stopped");
      expect(JSON.parse(readFileSync(instance.configFile, "utf8"))).toEqual({ url: origin, token: "terminal-fixture-token" });
      expect(requests).toEqual(["/api/config", "/api/config", "/api/access"]);
      expect(existsSync(instance.calls)).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(instance.home, { recursive: true, force: true });
    }
  });

  it("handles cancellation after displaying a real prompt without saving or invoking Wrangler", async () => {
    const instance = fixture();
    try {
      const result = await instance.run([["Worker URL", "\u0003"]]);
      expect(result.code).toBe(0);
      expect(result.output).toContain("stopped");
      expect(existsSync(instance.configFile)).toBe(false);
      expect(existsSync(instance.calls)).toBe(false);
    } finally { rmSync(instance.home, { recursive: true, force: true }); }
  });

  it("bounds a stalled terminal and cleans up its owned process tree", async () => {
    const instance = fixture();
    try {
      await expect(instance.run([
        ["Worker URL", ""],
        ["a prompt that cannot appear", ""],
      ], 1_000)).rejects.toThrow("terminal deadline exceeded");
      expect(existsSync(instance.configFile)).toBe(false);
      expect(existsSync(instance.calls)).toBe(false);
    } finally { rmSync(instance.home, { recursive: true, force: true }); }
  });

  it("logs in before deploying when Wrangler whoami exits zero but reports no authentication", async () => {
    const instance = fixture(true);
    try {
      const result = await instance.run([["https://installed-fixture.example.workers.dev", ""]], undefined, "deploy");
      expect(result.code).toBe(0);
      expect(result.output).toContain("Cloudflare needs a browser login");
      const calls = readFileSync(instance.calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.map((call) => call.args[0])).toEqual(["whoami", "login", "whoami", "deploy", "secret"]);
      expect(JSON.parse(readFileSync(instance.configFile, "utf8")).url).toBe("https://installed-fixture.example.workers.dev");
    } finally { rmSync(instance.home, { recursive: true, force: true }); }
  });

  it("runs deploy directly in a real PTY using only hoisted fake Wrangler and Node without Bun on PATH", async () => {
    const instance = fixture();
    try {
      const result = await instance.run([["https://installed-fixture.example.workers.dev", ""]], undefined, "deploy");
      expect(result.code).toBe(0);
      for (const prompt of ["Where is your podaj?", "Worker URL", "Instance token", "Worker name"]) {
        expect(result.output).not.toContain(prompt);
      }
      const calls = readFileSync(instance.calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const staged = join(instance.home, ".local/share/podaj/worker/wrangler.json");
      expect(calls).toEqual([
        { args: ["whoami"], stdinBytes: 0 },
        { args: ["deploy", "--config", staged], stdinBytes: 0 },
        { args: ["secret", "put", "PODAJ_API_AUTH_SECRET", "--config", staged], stdinBytes: 65 },
      ]);
      const saved = JSON.parse(readFileSync(instance.configFile, "utf8"));
      expect(saved).toEqual({ url: "https://installed-fixture.example.workers.dev", token: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(result.output).toContain(instance.configFile);
      expect(result.output).not.toContain('"mode"');
      expect(result.output).not.toContain(saved.token);
    } finally { rmSync(instance.home, { recursive: true, force: true }); }
  });
});
