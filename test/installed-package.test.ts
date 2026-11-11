import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parse } from "jsonc-parser";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seal } from "../src/crypto/podaj1.js";
import { packageTool } from "../scripts/package-paths.js";
import { prepareAgeOutput } from "../scripts/age-output.js";
import { localCloudflare, syntheticAccounts } from "./helpers/cloudflare-api.js";
import { runTerminal } from "./helpers/terminal.js";

const exec = promisify(execFile);
interface WorkerConfig {
  main: string;
  name: string;
  compatibility_date: string;
  assets: { directory: string; binding: string; run_worker_first: string[] };
  vars: Record<string, string>;
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: unknown[];
}
let home: string;
let root: string;
let stage: string;
let runtime: Miniflare;
let canonical: WorkerConfig;
let staged: WorkerConfig;
let sourceConfig: string;
let originalConfig: string;
let packedPaths: string[];
let deployment: { stdout: string; stderr: string };
const env = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"),
  PODAJ_KEY_DIR: join(home, "keys"),
  npm_config_cache: join(home, "npm-cache"), npm_config_userconfig: "/dev/null",
  PODAJ_TEST_WRANGLER_LOG: join(home, "wrangler-invocations.jsonl"),
});
const bin = () => join(root, "dist/scripts/podaj.js");

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "podaj-package-artifact-"));
  originalConfig = await readFile(resolve("wrangler.jsonc"), "utf8");
  const packed = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", home], {
    cwd: resolve("."), env: env(), timeout: 30_000,
  });
  const artifacts = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
  expect(artifacts).toHaveLength(1);
  packedPaths = artifacts[0].files.map((file) => file.path);
  const modules = join(home, "install", "node_modules");
  root = join(modules, "podaj");
  await mkdir(root, { recursive: true });
  await exec("tar", ["-xzf", join(home, artifacts[0].filename), "--strip-components=1", "-C", root]);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  for (const dependency of Object.keys(manifest.dependencies).filter((name) => name !== "wrangler")) {
    const target = await realpath(resolve("node_modules", dependency));
    const link = join(modules, dependency);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "dir");
  }
  const fakeWrangler = join(modules, "wrangler");
  await mkdir(join(fakeWrangler, "bin"), { recursive: true });
  await writeFile(join(fakeWrangler, "package.json"), JSON.stringify({ name: "wrangler", type: "module", bin: { wrangler: "bin/wrangler.js" } }));
  await build({ entryPoints: [resolve("test/helpers/fake-wrangler.ts")], outfile: join(fakeWrangler, "bin/wrangler.js"), platform: "node", format: "esm", target: "node22" });
  canonical = parse(originalConfig) as WorkerConfig;
  canonical.name = "installed-nondefault-worker";
  canonical.vars = { ...canonical.vars, HANDOFF_TTL_SECONDS: "3600", MAX_HANDOFF_BYTES: "40000" };
  sourceConfig = `// Installed instance customizations must survive staging.\n${JSON.stringify(canonical, null, 2)}\n`;
  await writeFile(join(root, "wrangler.jsonc"), sourceConfig);
  deployment = await exec(process.execPath, [bin(), "deploy"], { cwd: home, env: { ...env(), PATH: "/nonexistent" }, timeout: 15_000 });
  stage = join(home, ".local/share/podaj/worker");
  staged = JSON.parse(await readFile(join(stage, "wrangler.json"), "utf8")) as WorkerConfig;
  const bundled = await build({ entryPoints: [join(stage, staged.main)], bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", external: ["cloudflare:workers"] });
  runtime = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: staged.compatibility_date,
    durableObjects: Object.fromEntries(staged.durable_objects.bindings.map((binding) => [binding.name, { className: binding.class_name, useSQLite: true }])),
    bindings: { ...staged.vars, PODAJ_API_AUTH_SECRET: "synthetic-runtime-owner" },
    assets: { directory: join(stage, staged.assets.directory), binding: staged.assets.binding, routerConfig: { has_user_worker: true, static_routing: { user_worker: staged.assets.run_worker_first } } },
    outboundService: () => { throw new Error("installed-package test forbids outbound traffic"); },
  });
  await runtime.ready;
}, 60_000);
afterAll(async () => {
  await runtime?.dispose();
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

describe("extracted real npm package in a hoisted installation", () => {
  it("ships its executable, shared compiled modules, real UI and Worker sources", async () => {
    for (const path of ["dist/scripts/podaj.js", "dist/scripts/hooks/block-git-no-verify.js", "dist/scripts/decrypt-handoff.js", "dist/scripts/age-output.js", "src/worker.ts", "dist/client/index.html", "dist/client/authorize.html", "dist/client/_headers"]) {
      expect(packedPaths).toContain(path);
    }
    expect(packedPaths.some((path) => path.startsWith("scripts/") || path.endsWith(".mjs"))).toBe(false);
    expect(packedPaths.some((path) => path.startsWith("dist/scripts/init-") || path.endsWith("select-vars.js"))).toBe(false);
    expect(packedPaths.some((path) => path.startsWith("dev/"))).toBe(false);
    expect(packedPaths.some((path) => /recipient\.pem/u.test(path))).toBe(false);
    expect((await stat(bin())).mode & 0o111).not.toBe(0);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(existsSync(join(root, "scripts"))).toBe(false);
  });

  it("deploy automatically saves a private connection through the packed Node binary without Bun", async () => {
    const config = join(home, "config", "podaj", "config.json");
    const saved = JSON.parse(await readFile(config, "utf8"));
    expect(saved).toEqual({ url: "https://installed-fixture.example.workers.dev", token: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.parse(deployment.stdout)).toEqual({ config, url: saved.url });
    expect(`${deployment.stdout}${deployment.stderr}`).not.toContain(saved.token);
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(config))).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, "keys"))).toBe(false);
  });

  it("actually resolves the hoisted Node Wrangler entry and stages canonical configuration without rewriting it", async () => {
    expect(staged).toEqual({ ...canonical, account_id: "a".repeat(32), main: "entry.ts", assets: { ...canonical.assets, directory: "assets" } });
    expect(staged.name).toBe("installed-nondefault-worker");
    expect(staged.vars.HANDOFF_TTL_SECONDS).toBe("3600");
    expect(await readFile(join(root, "wrangler.jsonc"), "utf8")).toBe(sourceConfig);
    expect(await readFile(resolve("wrangler.jsonc"), "utf8")).toBe(originalConfig);
    expect(await readFile(join(stage, "entry.ts"), "utf8")).toContain(join(root, canonical.main));
    const calls = (await readFile(join(home, "wrangler-invocations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; stdinBytes: number });
    expect(calls.map((call) => call.args)).toEqual([
      ["whoami"], ["deploy", "--config", join(stage, "wrangler.json")],
      ["secret", "put", "PODAJ_API_AUTH_SECRET", "--config", join(stage, "wrangler.json")],
    ]);
    expect(calls.map((call) => call.stdinBytes)).toEqual([0, 0, 65]);
    expect(existsSync(join(home, "install/node_modules/.cache/wrangler"))).toBe(false);
    expect((await runtime.dispatchFetch("http://localhost/api/config")).status).toBe(200);
    expect(await (await runtime.dispatchFetch("http://localhost/api/config")).json()).toMatchObject({ handoffTtlSeconds: 3600, maxHandoffBytes: 40000 });
  });

  it("serves actual documents and every referenced asset through the local asset binding", async () => {
    const documents = (await readdir(join(stage, "assets"))).filter((name) => name.endsWith(".html"));
    expect(documents.sort()).toEqual(["authorize.html", "index.html"]);
    const assets = new Set<string>();
    for (const document of documents) {
      const html = await readFile(join(stage, "assets", document), "utf8");
      const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)].map((match) => match[1]);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        const url = new URL(reference, `http://localhost/${document}`);
        expect(url.origin).toBe("http://localhost");
        expect((await stat(join(stage, "assets", url.pathname))).isFile()).toBe(true);
        assets.add(url.pathname);
      }
      const response = await runtime.dispatchFetch(`http://localhost/${document === "index.html" ? "" : "authorize"}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
      const csp = response.headers.get("Content-Security-Policy");
      if (document === "authorize.html") expect(csp).toContain("challenges.cloudflare.com");
      else expect(csp).not.toContain("challenges.cloudflare.com");
    }
    for (const asset of assets) {
      const response = await runtime.dispatchFetch(`http://localhost${asset}`);
      expect(response.status, asset).toBe(200);
      const actual = Buffer.from(await response.arrayBuffer());
      const expected = await readFile(join(stage, "assets", asset));
      expect(actual.byteLength, asset).toBe(expected.byteLength);
      expect(actual.equals(expected), asset).toBe(true);
    }
    const fill = await runtime.dispatchFetch(`http://localhost/s/${"1".repeat(32)}`);
    expect(fill.status).toBe(200);
    expect(await fill.text()).toBe(await readFile(join(stage, "assets/index.html"), "utf8"));
  });

  it("uses real Wrangler from a read-only packed adapter without writing any installed cache", async () => {
    const api = await localCloudflare();
    const modes: [string, number][] = [];
    const protect = async (path: string) => {
      const info = await stat(path);
      modes.push([path, info.mode & 0o777]);
      if (info.isDirectory()) {
        for (const child of await readdir(path)) await protect(join(path, child));
      }
      await chmod(path, info.isDirectory() ? 0o555 : 0o444);
    };
    const readonlyStage = join(home, "readonly-stage");
    const workspace = join(home, "readonly-workspace");
    const driver = join(home, "readonly-driver.mjs");
    const guard = join(home, "readonly-network-guard.cjs");
    const configPath = join(readonlyStage, "wrangler.json");
    try {
      await mkdir(readonlyStage);
      await writeFile(configPath, JSON.stringify({ name: "synthetic-worker", main: "entry.js", compatibility_date: "2025-10-11" }));
      await writeFile(join(readonlyStage, "entry.js"), "export default { fetch() { return new Response('synthetic'); } };\n");
      await build({ entryPoints: [resolve("test/helpers/wrangler-driver.ts")], outfile: driver, platform: "node", format: "esm", target: "node22" });
      await build({ entryPoints: [resolve("test/helpers/local-network-only.ts")], outfile: guard, platform: "node", format: "cjs", target: "node22" });
      await protect(root);
      const modules = dirname(root);
      modes.push([modules, (await stat(modules)).mode & 0o777]);
      await chmod(modules, 0o555);
      if (process.geteuid?.() !== 0) {
        await expect(writeFile(join(root, "readonly-sentinel"), "blocked")).rejects.toMatchObject({ code: "EACCES" });
        await expect(mkdir(join(modules, ".cache"))).rejects.toMatchObject({ code: "EACCES" });
      }
      const result = await runTerminal({
        command: [process.execPath, driver, packageTool("wrangler"), workspace, "deploy", configPath],
        cwd: root,
        env: {
          HOME: home, XDG_CONFIG_HOME: join(home, "readonly-config"), PATH: "/nonexistent", TERM: "xterm-256color", NO_COLOR: "1",
          PODAJ_TEST_ADAPTER: pathToFileURL(join(root, "dist/scripts/wrangler.js")).href,
          NODE_OPTIONS: `--require=${guard}`,
          CLOUDFLARE_API_BASE_URL: api.url, CLOUDFLARE_API_TOKEN: "synthetic-local-api-token",
        },
        steps: [["Select an account", "\u001b[B\r"]], timeoutMs: 20_000,
      });
      expect(result.code).not.toBe(0);
      expect(result.output).not.toContain("EACCES");
      expect(result.output).not.toContain("unable to select one in non-interactive mode");
      const cache = JSON.parse(await readFile(join(readonlyStage, "node_modules/.cache/wrangler/wrangler-account.json"), "utf8"));
      expect(cache.account.id).toBe(syntheticAccounts[1]);
      expect(api.requests.some((request) => request.path.startsWith(`/accounts/${syntheticAccounts[1]}/`))).toBe(true);
      expect(api.requests.every((request) => request.method === "GET")).toBe(true);
      expect(existsSync(join(modules, ".cache"))).toBe(false);
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      expect(await readFile(join(root, "wrangler.jsonc"), "utf8")).toBe(sourceConfig);
      expect(await readdir(workspace)).toEqual(["node_modules"]);
    } finally {
      for (const [path, mode] of modes.reverse()) await chmod(path, mode);
      await api.close();
    }
  }, 30_000);

  it("decrypts a standard age receipt through the packed Node bin without Bun or an age executable", async () => {
    const output = await prepareAgeOutput({}, home);
    const payload = { vars: [{ key: "a freely chosen label", value: "synthetic-packed-age-value" }] };
    try {
      const receipt = await output.save(JSON.stringify(payload));
      expect(receipt.identity).toBeDefined();
      const result = await exec(process.execPath, [bin(), "decrypt", "--identity", receipt.identity!, receipt.file], {
        cwd: home, env: { ...env(), PATH: "/nonexistent" }, timeout: 10_000,
      });
      expect(JSON.parse(result.stdout)).toEqual(payload);
      expect(result.stderr).toBe("");
    } finally { output.close(); }
  });

  it("decrypts a browser-sealed payload through the packed Node bin and its shared compiled envelope parser", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    await mkdir(join(home, "keys"));
    await writeFile(join(home, "keys/private.pem"), pair.privateKey, { mode: 0o600 });
    const payload = { vars: [{ key: "PACKED_KEY", value: "synthetic-packed-roundtrip" }] };
    const sealed = await seal(payload, pair.publicKey);
    const result = await exec(process.execPath, [bin(), "decrypt", sealed], { cwd: home, env: env(), timeout: 10_000 });
    expect(JSON.parse(result.stdout)).toEqual(payload);
    expect(result.stderr).toBe("");
  });
});
