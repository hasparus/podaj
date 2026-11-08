import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { parse } from "jsonc-parser";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seal } from "../src/crypto/podaj1.js";

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
  const deployed = await exec(process.execPath, [bin(), "init", "--deploy"], { cwd: home, env: env(), timeout: 15_000 });
  expect(JSON.parse(deployed.stdout)).toMatchObject({ mode: "deploy", url: "https://installed-fixture.example.workers.dev" });
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
    for (const path of ["dist/scripts/podaj.js", "dist/scripts/hooks/block-git-no-verify.js", "dist/scripts/decrypt-handoff.js", "src/worker.ts", "dist/client/index.html", "dist/client/authorize.html", "dist/client/_headers"]) {
      expect(packedPaths).toContain(path);
    }
    expect(packedPaths.some((path) => path.startsWith("scripts/") || path.endsWith(".mjs"))).toBe(false);
    expect(packedPaths.some((path) => /recipient\.pem/u.test(path))).toBe(false);
    expect((await stat(bin())).mode & 0o111).not.toBe(0);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(existsSync(join(root, "scripts"))).toBe(false);
  });

  it("actually resolves the hoisted Node Wrangler entry and stages canonical configuration without rewriting it", async () => {
    expect(staged).toEqual({ ...canonical, main: "entry.ts", assets: { ...canonical.assets, directory: "assets" } });
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
    expect(calls.at(-1)!.stdinBytes).toBeGreaterThan(1);
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
      expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(stage, "assets", asset)));
    }
    const fill = await runtime.dispatchFetch(`http://localhost/s/${"1".repeat(32)}`);
    expect(fill.status).toBe(200);
    expect(await fill.text()).toBe(await readFile(join(stage, "assets/index.html"), "utf8"));
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
