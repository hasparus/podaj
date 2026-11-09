#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { workerConfig } from "./stage-worker.js";
import { securityHeaders } from "../src/security.js";
import { isDirect, packageRoot, packageTool } from "./package-paths.js";

export const DEMO_ACCOUNT = "afc3b7953504bb4cc5603e8ecec2da93";
export const DEMO_ORIGIN = "https://podaj.fyi";
const REGISTRY = "https://registry.npmjs.org";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key];
  if (!value || value.trim() !== value || /[\r\n]/u.test(value)) throw new Error(`set ${key} before releasing`);
  return value;
};

export const requireUpstream = (env: NodeJS.ProcessEnv): void => {
  if (env.GITHUB_REPOSITORY !== "hasparus/podaj" || env.GITHUB_ACTIONS !== "true") {
    throw new Error("releases run only in hasparus/podaj GitHub Actions");
  }
};

export const demoConfig = (root: string, destination: string, siteKey: string) => {
  required({ TURNSTILE_SITE_KEY: siteKey }, "TURNSTILE_SITE_KEY");
  const config = workerConfig(root);
  if (!record(config.vars)) throw new Error("invalid canonical wrangler.jsonc vars");
  if ("TURNSTILE_SECRET_KEY" in config.vars || "PODAJ_API_AUTH_SECRET" in config.vars) {
    throw new Error("canonical config must not contain runtime secrets");
  }
  return {
    ...config,
    $schema: relative(dirname(destination), join(root, "node_modules/wrangler/config-schema.json")),
    main: relative(dirname(destination), resolve(root, config.main)),
    assets: { ...config.assets, directory: relative(dirname(destination), resolve(root, config.assets.directory)) },
    account_id: DEMO_ACCOUNT,
    name: "podaj",
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: "podaj.fyi", custom_domain: true }],
    vars: { ...config.vars, PODAJ_ACCESS: "public", TURNSTILE_SITE_KEY: siteKey },
  };
};

/** The selected CI token is the only management credential inherited by Wrangler. */
export const demoEnvironment = (token: string, ambient: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  required({ CLOUDFLARE_API_TOKEN: token }, "CLOUDFLARE_API_TOKEN");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG"]) {
    if (ambient[key] !== undefined) env[key] = ambient[key];
  }
  return {
    ...env,
    CI: "true",
    CLOUDFLARE_ACCOUNT_ID: DEMO_ACCOUNT,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG: "error",
    WRANGLER_LOG_SANITIZE: "true",
  };
};

export const sourceRef = (ref: string, version: string, reachableFromMain: boolean): void => {
  if (ref !== "refs/heads/main" && !ref.startsWith("refs/tags/v")) {
    throw new Error("production release requires main or a v* tag");
  }
  if (!reachableFromMain) throw new Error("release commit must be reachable from origin/main");
  if (ref.startsWith("refs/tags/") && ref !== `refs/tags/v${version}`) {
    throw new Error("release tag must match package.json version");
  }
};

export const packageVersion = (root: string): string => {
  const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!record(manifest) || manifest.name !== "podaj" || typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error("expected podaj package with a valid version");
  }
  return manifest.version;
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Only a registry JSON 404 permits a new immutable version; outages fail closed. */
const registryMissing = async (path: string, fetcher: Fetcher): Promise<boolean> => {
  let response: Response;
  try {
    response = await fetcher(`${REGISTRY}/podaj${path}`, {
      redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" },
    });
  } catch {
    throw new Error("npm registry unavailable; publication stopped");
  }
  if (response.status === 200) return false;
  if (response.status === 404) {
    let body: unknown;
    try { body = await response.json(); } catch { }
    if ((record(body) && body.error === "Not found") ||
        (path && body === `version not found: ${decodeURIComponent(path.slice(1))}`)) return true;
  }
  throw new Error(`npm registry check failed (HTTP ${response.status}); publication stopped`);
};

export const assertUnpublished = async (version: string, fetcher: Fetcher = fetch): Promise<void> => {
  if (!await registryMissing(`/${encodeURIComponent(version)}`, fetcher)) {
    throw new Error(`podaj@${version} is already published; use a new version (never republish)`);
  }
};

export const publicationAuth = async (env: NodeJS.ProcessEnv, fetcher: Fetcher = fetch): Promise<void> => {
  if (env.NPM_TOKEN) { required(env, "NPM_TOKEN"); return; }
  required(env, "ACTIONS_ID_TOKEN_REQUEST_URL");
  required(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  if (await registryMissing("", fetcher)) throw new Error("set NPM_TOKEN for the first publication; configure a trusted publisher for subsequent tokenless OIDC releases");
};

const checkedResponse = async (origin: string, path: string, fetcher: Fetcher, init?: RequestInit) => {
  const response = await fetcher(new URL(path, origin).href, {
    ...init, redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  return response;
};

const secureDocument = (response: Response, authorize: boolean): void => {
  for (const [key, value] of Object.entries(securityHeaders(authorize))) {
    if (response.headers.get(key) !== value) throw new Error(`demo security header mismatch: ${key}`);
  }
  if (response.headers.get("Cache-Control") !== "no-store") throw new Error("demo documents must not be cached");
};

const smokeAssets = async (origin: string, html: string, fetcher: Fetcher): Promise<void> => {
  const urls = new Map<string, string>();
  for (const match of html.matchAll(/<(script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["'][^>]*>/giu)) {
    const url = new URL(match[2]!, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/assets/")) throw new Error("unexpected demo asset URL");
    if (match[1]!.toLowerCase() === "script") urls.set(url.href, "javascript");
    else if (url.pathname.endsWith(".css")) urls.set(url.href, "text/css");
  }
  if (![...urls.values()].includes("javascript") || ![...urls.values()].includes("text/css")) {
    throw new Error("demo document missing built script or stylesheet");
  }
  for (const [url, type] of urls) {
    const response = await checkedResponse(origin, url, fetcher);
    if (response.status !== 200 || !response.headers.get("Content-Type")?.includes(type) || !(await response.text()).trim()) {
      throw new Error("demo built asset unavailable");
    }
  }
};

/** Read-only admission probe: no captcha bypass, approval, reservation or human fill. */
export const smokeDemo = async (origin: string, siteKey: string, fetcher: Fetcher = fetch): Promise<void> => {
  required({ TURNSTILE_SITE_KEY: siteKey }, "TURNSTILE_SITE_KEY");
  const config = await checkedResponse(origin, "/api/config", fetcher);
  if (config.status !== 200) throw new Error("demo public config unavailable");
  const body: unknown = await config.json();
  if (!record(body) || body.access !== "public" || body.turnstileSiteKey !== siteKey ||
      typeof body.handoffTtlSeconds !== "number" || body.handoffTtlSeconds < 60 || body.handoffTtlSeconds > 7200 ||
      typeof body.maxHandoffBytes !== "number" || body.maxHandoffBytes <= 0 || body.maxHandoffBytes > 32768) {
    throw new Error("demo public config mismatch");
  }
  for (const path of ["/", "/authorize"]) {
    const response = await checkedResponse(origin, path, fetcher);
    if (response.status !== 200 || !response.headers.get("Content-Type")?.includes("text/html")) {
      throw new Error("demo document unavailable");
    }
    secureDocument(response, path === "/authorize");
    const html = await response.text();
    if (!html.includes(path === "/" ? 'id="app"' : 'id="authorize-status"')) throw new Error("wrong demo document");
    await smokeAssets(origin, html, fetcher);
  }
  const refused = await checkedResponse(origin, "/api/handoffs/reserve", fetcher, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (refused.status !== 401) throw new Error("demo must refuse unapproved creation with 401");
  const refusal: unknown = await refused.json();
  if (!record(refusal) || refusal.error !== "unauthorized") throw new Error("unexpected demo admission refusal");
};

export const redactDiagnostics = (output: string, secrets: readonly string[]): string => {
  let safe = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const values = new Set(secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]));
  for (const value of [...values].sort((left, right) => right.length - left.length)) safe = safe.replaceAll(value, "[REDACTED]");
  safe = safe.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
  return safe.length > 6000 ? `${safe.slice(0, 6000)}\n[diagnostics truncated]` : safe;
};

const diagnosticSecrets = (env: NodeJS.ProcessEnv): string[] => Object.entries(env)
  .filter(([key, value]) => value && /^(?:(?:CLOUDFLARE_|CF_).*(?:TOKEN|KEY|SECRET)|NPM_TOKEN|NODE_AUTH_TOKEN|TURNSTILE_SECRET_KEY|PODAJ_API_AUTH_SECRET|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/u.test(key))
  .map(([, value]) => value!);

const run = (command: string, args: string[], root: string, env: NodeJS.ProcessEnv, input?: string): string => {
  const result = spawnSync(command, args, { cwd: root, env, input, encoding: "utf8", stdio: "pipe", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const secrets = [...diagnosticSecrets(process.env), ...diagnosticSecrets(env), input?.trimEnd() ?? ""];
    const diagnostics = `exit: ${result.status ?? "unavailable"}\nstdout:\n${redactDiagnostics(result.stdout ?? "", secrets)}\nstderr:\n${redactDiagnostics(result.stderr ?? "", secrets)}\n${redactDiagnostics(result.error?.message ?? "", secrets)}`;
    process.stderr.write(`${diagnostics.split("\n").map((line) => `  | ${line}`).join("\n")}\n`);
    throw new Error(`${command === "npm" ? "npm" : "Wrangler"} ${args[0] === "publish" ? "publication" : "operation"} failed; no automatic retry`);
  }
  return result.stdout;
};

const validateSourceRef = (root: string, env: NodeJS.ProcessEnv): string => {
  requireUpstream(env);
  const reachable = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], { cwd: root, stdio: "pipe" });
  if (reachable.error || (reachable.status !== 0 && reachable.status !== 1)) throw new Error("could not verify origin/main ancestry");
  const version = packageVersion(root);
  sourceRef(required(env, "GITHUB_REF"), version, reachable.status === 0);
  return version;
};

const validatePublish = (root: string, env: NodeJS.ProcessEnv): string => {
  const version = validateSourceRef(root, env);
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== `refs/tags/v${version}`) {
    throw new Error("npm publication requires a pushed version tag matching package.json");
  }
  const npmVersion = run("npm", ["--version"], root, env).trim().split(".").map(Number);
  if (!npmVersion[0] || npmVersion[0] < 11 || (npmVersion[0] === 11 && (npmVersion[1]! < 5 || (npmVersion[1] === 5 && npmVersion[2]! < 1)))) {
    throw new Error("npm >=11.5.1 is required for trusted publishing");
  }
  return version;
};

const preflightDemo = (root: string, env: NodeJS.ProcessEnv): void => {
  requireUpstream(env);
  for (const key of ["CLOUDFLARE_API_TOKEN", "TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"]) required(env, key);
  validateSourceRef(root, env);
};

const configPath = (root: string) => join(root, ".cloudflare", "demo-wrangler.json");
const archivePath = (root: string) => join(root, ".cloudflare", `podaj-${packageVersion(root)}.tgz`);

const writeDemoConfig = (root: string, siteKey: string): string => {
  const destination = configPath(root);
  const config = demoConfig(root, destination, siteKey);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return destination;
};

const deployDemo = (root: string, env: NodeJS.ProcessEnv): void => {
  preflightDemo(root, env);
  const wranglerManifest: unknown = JSON.parse(readFileSync(join(root, "node_modules/wrangler/package.json"), "utf8"));
  if (!record(wranglerManifest) || wranglerManifest.version !== "4.45.0") throw new Error("review secret deployment support before changing Wrangler 4.45.0");
  const config = writeDemoConfig(root, required(env, "TURNSTILE_SITE_KEY"));
  const isolated = demoEnvironment(required(env, "CLOUDFLARE_API_TOKEN"), env);
  const emptyEnv = join(root, ".cloudflare", "release-empty.env");
  writeFileSync(emptyEnv, "", { mode: 0o600 });
  const flags = ["--config", config, "--env-file", emptyEnv];
  const wrangler = packageTool("wrangler");
  run("node", [wrangler, "deploy", ...flags], root, isolated);
  run("node", [wrangler, "secret", "put", "TURNSTILE_SECRET_KEY", ...flags], root, isolated,
    `${required(env, "TURNSTILE_SECRET_KEY")}\n`);
};

const pack = (root: string): void => {
  mkdirSync(join(root, ".cloudflare"), { recursive: true });
  const output: unknown = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", ".cloudflare"], root, process.env));
  if (!Array.isArray(output) || output.length !== 1 || !record(output[0]) ||
      output[0].filename !== relative(join(root, ".cloudflare"), archivePath(root))) throw new Error("unexpected packed archive");
};

const publish = async (root: string, env: NodeJS.ProcessEnv): Promise<void> => {
  const version = validatePublish(root, env);
  await assertUnpublished(version);
  await publicationAuth(env);
  const scratch = mkdtempSync(join(tmpdir(), "podaj-npm-"));
  try {
    const userConfig = join(scratch, "user.npmrc");
    const globalConfig = join(scratch, "global.npmrc");
    writeFileSync(globalConfig, "", { mode: 0o600 });
    writeFileSync(userConfig, env.NPM_TOKEN ? "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n" : "", { mode: 0o600 });
    const isolated = { ...env };
    for (const key of Object.keys(isolated)) {
      if (/^(?:npm_config_|npm_token$|node_auth_token$|cloudflare_|cf_|turnstile_)/iu.test(key)) delete isolated[key];
    }
    if (env.NPM_TOKEN) isolated.NODE_AUTH_TOKEN = required(env, "NPM_TOKEN");
    isolated.NPM_CONFIG_USERCONFIG = userConfig;
    isolated.NPM_CONFIG_GLOBALCONFIG = globalConfig;
    run("npm", ["publish", archivePath(root), "--access", "public", "--provenance", "--ignore-scripts", "--registry", REGISTRY], root, isolated);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export const releaseMain = async (command: string | undefined, root: string, env: NodeJS.ProcessEnv): Promise<void> => {
  switch (command) {
    case "preflight-demo":
      preflightDemo(root, env);
      demoConfig(root, configPath(root), required(env, "TURNSTILE_SITE_KEY"));
      return;
    case "preflight-publish":
      await assertUnpublished(validatePublish(root, env));
      await publicationAuth(env);
      return;
    case "pack": requireUpstream(env); pack(root); return;
    case "deploy-demo": deployDemo(root, env); return;
    case "smoke-demo": await smokeDemo(DEMO_ORIGIN, required(env, "TURNSTILE_SITE_KEY")); return;
    case "publish": await publish(root, env); return;
    default: throw new Error("choose preflight-demo, preflight-publish, pack, deploy-demo, smoke-demo, or publish");
  }
};

if (isDirect(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("expected one release subcommand");
    await releaseMain(process.argv[2], packageRoot(import.meta.url), process.env);
    console.log(`release ${process.argv[2]} completed`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "release failed");
    process.exitCode = 1;
  }
}
