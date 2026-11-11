import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { securityHeaders } from "../src/security.js";
import { workerConfig } from "../scripts/stage-worker.js";
import {
  assertUnpublished, DEMO_ACCOUNT, demoConfig, demoEnvironment, packageVersion,
  publicationAuth, sourceRef, redactDiagnostics, releaseMain, required, requireUpstream, smokeDemo,
} from "../scripts/release.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "hasparus/podaj", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push" };
const credentials = { ...upstream, CLOUDFLARE_API_TOKEN: "synthetic-management", TURNSTILE_SECRET_KEY: "synthetic-runtime", TURNSTILE_SITE_KEY: "synthetic-site" };
const temporary: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "podaj-release-"));
  temporary.push(directory);
  writeFileSync(join(directory, "wrangler.jsonc"), readFileSync(join(root, "wrangler.jsonc")));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "podaj", version: "0.1.0" }));
  return directory;
};
const success = (stdout = "") => ({ status: 0, stdout, stderr: "", pid: 1, output: [null, stdout, ""], signal: null });
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("canonical demo configuration", () => {
  it("preserves Worker bindings, migrations, assets and limits without editing the self-hosting template", () => {
    const directory = fixture();
    const source = readFileSync(join(directory, "wrangler.jsonc"), "utf8");
    const canonical = workerConfig(directory);
    const path = join(directory, ".cloudflare", "demo-wrangler.json");
    const config = demoConfig(directory, path, "site");
    expect(config).toMatchObject({
      account_id: DEMO_ACCOUNT, name: "podaj", workers_dev: false, preview_urls: false,
      routes: [{ pattern: "podaj.fyi", custom_domain: true }],
      vars: { ...canonical.vars as object, PODAJ_ACCESS: "public", TURNSTILE_SITE_KEY: "site" },
      durable_objects: canonical.durable_objects, migrations: canonical.migrations,
      ratelimits: canonical.ratelimits, compatibility_date: canonical.compatibility_date,
      observability: canonical.observability,
    });
    expect(resolve(dirname(path), config.main)).toBe(resolve(directory, canonical.main));
    expect(resolve(dirname(path), config.assets.directory)).toBe(resolve(directory, canonical.assets.directory));
    expect(config.assets).toMatchObject({ run_worker_first: canonical.assets.run_worker_first });
    expect(config.main).toBe("../src/worker.ts");
    expect(config.assets.directory).toBe("../dist/client");
    expect(readFileSync(join(directory, "wrangler.jsonc"), "utf8")).toBe(source);
    expect(JSON.stringify(config)).not.toContain("TURNSTILE_SECRET_KEY");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".cloudflare/*");
  });

  it("uses the shared JSONC parser and refuses malformed canonical configuration", () => {
    const directory = fixture();
    writeFileSync(join(directory, "wrangler.jsonc"), '{ // valid JSONC\n "main":"src/worker.ts", "assets":{"directory":"dist/client"}, "vars":{}, }');
    expect(demoConfig(directory, join(directory, ".cloudflare/demo.json"), "site").main).toBe("../src/worker.ts");
    writeFileSync(join(directory, "wrangler.jsonc"), '{"main":false}');
    expect(() => demoConfig(directory, join(directory, ".cloudflare/demo.json"), "site")).toThrow(/worker main/);
  });

  it.each(["TURNSTILE_SECRET_KEY", "PODAJ_API_AUTH_SECRET"])("refuses plaintext %s in canonical vars", (key) => {
    const directory = fixture();
    const config = workerConfig(directory);
    writeFileSync(join(directory, "wrangler.jsonc"), JSON.stringify({ ...config, vars: { [key]: "synthetic-private" } }));
    expect(() => demoConfig(directory, join(directory, ".cloudflare/demo.json"), "site")).toThrow("canonical config must not contain runtime secrets");
  });
});

describe("release preflights and isolation", () => {
  it.each([undefined, "", " ", "secret\n", " secret"])("rejects missing or unsafe values without echoing them", (value) => {
    expect(() => required({ TURNSTILE_SECRET_KEY: value }, "TURNSTILE_SECRET_KEY")).toThrow("set TURNSTILE_SECRET_KEY before releasing");
  });

  it.each(["CLOUDFLARE_API_TOKEN", "TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"])("preflights missing %s before any command", async (key) => {
    await expect(releaseMain("preflight-demo", root, { ...credentials, [key]: "" })).rejects.toThrow(`set ${key}`);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects forks and local release mutations", async () => {
    expect(() => requireUpstream({ ...upstream, GITHUB_REPOSITORY: "someone/podaj" })).toThrow(/only in hasparus/);
    await expect(releaseMain("deploy-demo", root, {})).rejects.toThrow(/only in hasparus/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["refs/heads/main", "refs/tags/v0.1.0"])("preflights production source %s without requiring npm", async (ref) => {
    spawn.mockReturnValue(success());
    await expect(releaseMain("preflight-demo", fixture(), { ...credentials, GITHUB_REF: ref })).resolves.toBeUndefined();
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(["git"]);
    expect(spawn.mock.calls[0]![1]).toEqual(["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]);
  });

  it.each([
    ["refs/heads/feature", 0, /requires main/],
    ["refs/tags/v0.2.0", 0, /match package/],
    ["refs/tags/v0.1.0", 1, /reachable/],
    ["refs/heads/main", 1, /reachable/],
    ["refs/heads/main", 128, /could not verify/],
  ] as const)("blocks preflight and direct deployment for %s (git %s)", async (ref, status, error) => {
    spawn.mockReturnValue({ ...success(), status });
    for (const command of ["preflight-demo", "deploy-demo"]) {
      await expect(releaseMain(command, fixture(), { ...credentials, GITHUB_REF: ref })).rejects.toThrow(error);
    }
    expect(spawn.mock.calls.every(([command]) => command === "git")).toBe(true);
  });

  it("uses only the selected account token, not ambient management/runtime credentials", () => {
    const env = demoEnvironment("selected", {
      PATH: "/test/bin", HOME: "/test/home", CLOUDFLARE_API_TOKEN: "foreign", CLOUDFLARE_ACCOUNT_ID: "foreign",
      CLOUDFLARE_API_KEY: "global", CF_API_TOKEN: "legacy", CLOUDFLARE_API_BASE_URL: "https://foreign.test",
      TURNSTILE_SECRET_KEY: "private", NPM_TOKEN: "npm-private", WRANGLER_LOG_SANITIZE: "false", NODE_OPTIONS: "--inspect",
    });
    expect(env).toMatchObject({ PATH: "/test/bin", HOME: "/test/home", CLOUDFLARE_ACCOUNT_ID: DEMO_ACCOUNT, CLOUDFLARE_API_TOKEN: "selected", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_LOG_SANITIZE: "true" });
    for (const value of ["foreign", "global", "legacy", "private", "--inspect"]) expect(JSON.stringify(env)).not.toContain(value);
  });

  it("deploys with pinned Wrangler under Node then passes only the runtime secret on stdin", async () => {
    const directory = fixture();
    mkdirSync(join(directory, "node_modules/wrangler"), { recursive: true });
    writeFileSync(join(directory, "node_modules/wrangler/package.json"), '{"version":"4.45.0"}');
    spawn.mockReturnValue(success());
    const registry = vi.fn(async () => Response.json({ version: "0.1.0" }));
    vi.stubGlobal("fetch", registry);
    await releaseMain("deploy-demo", directory, credentials);
    expect(registry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(3);
    const [deploy, secret] = spawn.mock.calls.filter(([command]) => command === "node");
    expect(deploy![0]).toBe("node");
    expect(secret![0]).toBe("node");
    expect(deploy![1]).toEqual([expect.stringContaining("wrangler/bin/wrangler.js"), "deploy", "--config", join(directory, ".cloudflare/demo-wrangler.json"), "--env-file", join(directory, ".cloudflare/release-empty.env")]);
    expect(secret![1]).toEqual([expect.stringContaining("wrangler/bin/wrangler.js"), "secret", "put", "TURNSTILE_SECRET_KEY", "--config", join(directory, ".cloudflare/demo-wrangler.json"), "--env-file", join(directory, ".cloudflare/release-empty.env")]);
    expect(secret![2]).toMatchObject({ input: "synthetic-runtime\n", stdio: "pipe", env: { CLOUDFLARE_ACCOUNT_ID: DEMO_ACCOUNT } });
    expect(deploy![2]).not.toHaveProperty("input", "synthetic-runtime\n");
    expect(JSON.stringify(secret![1])).not.toContain("synthetic-runtime");
    expect(JSON.stringify(secret![2]?.env)).not.toContain("synthetic-runtime");
    expect(readFileSync(join(directory, ".cloudflare/demo-wrangler.json"), "utf8")).not.toContain("synthetic-runtime");
  });

  it("reports redacted permission diagnostics and does not set secrets after a failed deploy", async () => {
    const directory = fixture();
    mkdirSync(join(directory, "node_modules/wrangler"), { recursive: true });
    writeFileSync(join(directory, "node_modules/wrangler/package.json"), '{"version":"4.45.0"}');
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    spawn.mockImplementation((command) => command === "git" ? success() : {
      ...success(`account permissions: synthetic-management ${"x".repeat(8000)}`), status: 1, stderr: "Cloudflare permission denied (10000)",
    });
    await expect(releaseMain("deploy-demo", directory, credentials)).rejects.toThrow("Wrangler operation failed; no automatic retry");
    expect(spawn.mock.calls.filter(([command]) => command === "node")).toHaveLength(1);
    const diagnostics = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(diagnostics).toContain("stdout:");
    expect(diagnostics).toContain("stderr:");
    expect(diagnostics).toContain("Cloudflare permission denied (10000)");
    expect(diagnostics).toContain("[REDACTED]");
    expect(diagnostics).not.toContain("synthetic-management");
    expect(diagnostics).toContain("[diagnostics truncated]");
    expect(diagnostics.length).toBeLessThan(13_000);
  });

  it("redacts runtime stdin and ambient npm/Turnstile secrets on secret-operation failure", async () => {
    const directory = fixture();
    mkdirSync(join(directory, "node_modules/wrangler"), { recursive: true });
    writeFileSync(join(directory, "node_modules/wrangler/package.json"), '{"version":"4.45.0"}');
    vi.stubEnv("NPM_TOKEN", "synthetic-npm");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "synthetic-runtime");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    spawn.mockImplementation((command, args) => command === "node" && args?.includes("secret") ? {
      ...success("quota exceeded synthetic-runtime synthetic-npm synthetic-management"), status: 1,
      stderr: "runtime value: synthetic-runtime",
    } : success());
    await expect(releaseMain("deploy-demo", directory, credentials)).rejects.toThrow(/Wrangler operation failed/);
    const diagnostics = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(diagnostics).toContain("quota exceeded");
    for (const secret of ["synthetic-runtime", "synthetic-npm", "synthetic-management"]) expect(diagnostics).not.toContain(secret);
  });

  it("redacts before bounding diagnostics, including escaped credentials and terminal controls", () => {
    const secret = 'synthetic-token/"value';
    const safe = redactDiagnostics(`\u001b[31mpermission denied ${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret)}\u001b[0m\n${"x".repeat(5990)}${secret}`, [secret, ""]);
    expect(safe).toContain("permission denied [REDACTED]");
    expect(safe).not.toContain(secret);
    expect(safe).not.toContain(encodeURIComponent(secret));
    expect(safe).not.toContain("\u001b");
    expect(safe).toContain("[diagnostics truncated]");
    expect(safe.length).toBeLessThan(6050);
  });

  it("packs once with lifecycle scripts disabled", async () => {
    spawn.mockReturnValue(success('[{"filename":"podaj-0.1.0.tgz"}]'));
    await releaseMain("pack", fixture(), upstream);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]!.slice(0, 2)).toEqual(["npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", ".cloudflare"]]);
  });
});

describe("immutable npm release gates", () => {
  it.each([
    ["push", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/main"],
    ["workflow_dispatch", "refs/tags/v0.1.0"],
    ["pull_request", "refs/tags/v0.1.0"],
  ])("refuses npm publication from %s on %s before npm or registry access", async (event, ref) => {
    spawn.mockReturnValue(success());
    const registry = vi.fn();
    vi.stubGlobal("fetch", registry);
    for (const command of ["preflight-publish", "publish"]) {
      await expect(releaseMain(command, fixture(), { ...upstream, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, NPM_TOKEN: "synthetic" }))
        .rejects.toThrow("npm publication requires a pushed version tag matching package.json");
    }
    expect(spawn.mock.calls.every(([command]) => command === "git")).toBe(true);
    expect(registry).not.toHaveBeenCalled();
  });

  it.each(["refs/heads/main", "refs/tags/v0.1.0"])("allows reachable %s", (ref) => {
    expect(() => sourceRef(ref, "0.1.0", true)).not.toThrow();
  });
  it.each([
    ["refs/heads/feature", true, /requires main/], ["refs/tags/v0.2.0", true, /match package/],
    ["refs/tags/v0.1.0", false, /reachable/], ["refs/heads/main", false, /reachable/],
    ["refs/tags/not-a-version", true, /requires main/],
  ] as const)("rejects %s with ancestry %s", (ref, reachable, error) => {
    expect(() => sourceRef(ref, "0.1.0", reachable)).toThrow(error);
  });
  it("reads the actual package version", () => expect(packageVersion(fixture())).toBe("0.1.0"));

  it("accepts only a genuine registry JSON 404 as unpublished", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 }));
    await assertUnpublished("0.1.0", fetcher);
    expect(fetcher).toHaveBeenCalledWith("https://registry.npmjs.org/podaj/0.1.0", expect.objectContaining({ redirect: "error" }));
  });
  it("accepts npm's missing-version JSON string, not an unrelated version refusal", async () => {
    await expect(assertUnpublished("0.1.0", async () => Response.json("version not found: 0.1.0", { status: 404 }))).resolves.toBeUndefined();
    await expect(assertUnpublished("0.1.0", async () => Response.json("version not found: 0.2.0", { status: 404 }))).rejects.toThrow(/registry check failed/);
  });
  it.each([200, 401, 403, 429, 500, 503])("stops on registry HTTP %s", async (status) => {
    await expect(assertUnpublished("0.1.0", async () => Response.json({}, { status }))).rejects.toThrow(status === 200 ? /already published.*never republish/ : /registry check failed/);
  });
  it.each(["<html>proxy not found</html>", '{"error":"outage"}'])("rejects ambiguous 404 %s", async (body) => {
    await expect(assertUnpublished("0.1.0", async () => new Response(body, { status: 404 }))).rejects.toThrow(/registry check failed/);
  });
  it("stops on network failure without echoing network diagnostics", async () => {
    await expect(assertUnpublished("0.1.0", async () => { throw new Error("synthetic-private"); })).rejects.toThrow("npm registry unavailable; publication stopped");
  });
  it.each([true, false])("publishes the existing archive once with provenance (bootstrap token: %s)", async (bootstrap) => {
    const directory = fixture();
    const authContents: string[] = [];
    spawn.mockImplementation((command, args, options) => {
      if (command === "npm" && args?.[0] === "--version") return success("11.5.1");
      if (command === "npm" && args?.[0] === "publish") {
        const env = options?.env;
        authContents.push(readFileSync(env!.NPM_CONFIG_USERCONFIG!, "utf8"));
        expect(env).not.toHaveProperty("NPM_TOKEN");
        expect(env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
        expect(env?.NODE_AUTH_TOKEN).toBe(bootstrap ? "synthetic-bootstrap" : undefined);
      }
      return success();
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/0.1.0")
      ? Response.json({ error: "Not found" }, { status: 404 }) : Response.json({ name: "podaj" })));
    await releaseMain("publish", directory, {
      ...upstream, GITHUB_REF: "refs/tags/v0.1.0", NPM_TOKEN: bootstrap ? "synthetic-bootstrap" : "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
      CLOUDFLARE_API_TOKEN: "foreign",
    });
    const publishes = spawn.mock.calls.filter(([command, args]) => command === "npm" && args?.[0] === "publish");
    expect(publishes).toHaveLength(1);
    expect(publishes[0]![1]).toEqual(["publish", join(directory, ".cloudflare/podaj-0.1.0.tgz"), "--access", "public", "--provenance", "--ignore-scripts", "--registry", "https://registry.npmjs.org"]);
    expect(authContents).toEqual([bootstrap ? "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n" : ""]);
    expect(spawn.mock.calls.some(([, args]) => args?.includes("build") || args?.includes("pack"))).toBe(false);
  });

  it("rejects an already published version before npm mutation", async () => {
    spawn.mockImplementation((command) => success(command === "npm" ? "11.5.1" : ""));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: "0.1.0" })));
    await expect(releaseMain("publish", fixture(), { ...upstream, GITHUB_REF: "refs/tags/v0.1.0", NPM_TOKEN: "synthetic" })).rejects.toThrow(/already published/);
    expect(spawn.mock.calls.some(([, args]) => args?.includes("publish"))).toBe(false);
  });

  it("requires a bootstrap token for a brand-new package and supports subsequent tokenless OIDC", async () => {
    const oidc = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc" };
    await expect(publicationAuth(oidc, async () => Response.json({ error: "Not found" }, { status: 404 }))).rejects.toThrow(/NPM_TOKEN for the first publication/);
    await expect(publicationAuth(oidc, async () => Response.json({ name: "podaj" }))).resolves.toBeUndefined();
    await expect(publicationAuth({})).rejects.toThrow(/ACTIONS_ID_TOKEN_REQUEST_URL/);
    const registry = vi.fn();
    await publicationAuth({ NPM_TOKEN: "synthetic-bootstrap" }, registry);
    expect(registry).not.toHaveBeenCalled();
  });
});

const smokeOrigin = "https://demo.test";
const smokeFixture = () => {
  const responses = new Map<string, () => Response>([
    ["/api/config", () => Response.json({ access: "public", turnstileSiteKey: "site", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 })],
    ...["/", "/authorize", `/s/${"0".repeat(32)}`, `/authorize/${"0".repeat(32)}`].map((path): [string, () => Response] => [path, () => new Response(
      `<div id="${path.startsWith("/authorize") ? "authorize-status" : "app"}"></div><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/style.css">`,
      { headers: { ...securityHeaders(path.startsWith("/authorize")), "Cache-Control": "no-store", "Content-Type": "text/html" } },
    )]),
    ["/assets/app.js", () => new Response("console.log('built')", { headers: { "Content-Type": "application/javascript" } })],
    ["/assets/style.css", () => new Response("body{}", { headers: { "Content-Type": "text/css" } })],
    ["/api/handoffs/reserve", () => Response.json({ error: "unauthorized" }, { status: 401 })],
    ["/api/contexts", () => Response.json({ error: "invalid context" }, { status: 400 })],
  ]);
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(new URL(url).origin).toBe(smokeOrigin);
    expect(init?.redirect).toBe("error");
    const handler = responses.get(new URL(url).pathname);
    if (!handler) throw new Error("unexpected smoke request");
    return handler();
  });
  return { responses, fetcher };
};

describe("HTTP demo smoke (stub responses only; no Turnstile bypass)", () => {
  it("checks public config, both documents/security, built assets and fail-closed admission", async () => {
    const { fetcher } = smokeFixture();
    await smokeDemo(smokeOrigin, "site", fetcher);
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toEqual([
      [`${smokeOrigin}/api/contexts`, expect.objectContaining({ body: "{}" })],
      [`${smokeOrigin}/api/handoffs/reserve`, expect.objectContaining({ body: "{}" })],
    ]);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("turnstileToken");
    expect(fetcher.mock.calls.some(([url]) => url.includes("/api/demo/approve"))).toBe(false);
  });
  it.each([
    ["/api/config", () => Response.json({ access: "private" }), /config mismatch/],
    ["/api/config", () => Response.json({ access: "public", turnstileSiteKey: "wrong" }), /config mismatch/],
    ["/api/config", () => new Response("unavailable", { status: 503 }), /config unavailable/],
    ["/authorize", () => new Response("not found", { status: 404 }), /document unavailable/],
    [`/s/${"0".repeat(32)}`, () => new Response("not found", { status: 404 }), /document unavailable/],
    [`/authorize/${"0".repeat(32)}`, () => new Response("not found", { status: 404 }), /document unavailable/],
    ["/api/contexts", () => Response.json({ error: "not found" }, { status: 404 }), /context endpoint/],
    ["/api/contexts", () => Response.json({ id: "unexpected" }, { status: 201 }), /context endpoint/],
    ["/", () => new Response('<div id="app"></div>', { headers: { "Content-Type": "text/html" } }), /security header/],
    ["/assets/app.js", () => new Response("<html>fallback</html>", { headers: { "Content-Type": "text/html" } }), /asset unavailable/],
    ["/assets/style.css", () => new Response("", { status: 404 }), /asset unavailable/],
    ["/api/handoffs/reserve", () => Response.json({ error: "verification unavailable" }, { status: 503 }), /refuse.*401/],
    ["/api/handoffs/reserve", () => Response.json({ id: "unexpected" }, { status: 201 }), /refuse.*401/],
  ] as const)("fails closed for broken %s", async (path, response, error) => {
    const { responses, fetcher } = smokeFixture();
    responses.set(path, response);
    await expect(smokeDemo(smokeOrigin, "site", fetcher)).rejects.toThrow(error);
  });
  it("rejects off-origin script assets", async () => {
    const { responses, fetcher } = smokeFixture();
    responses.set("/", () => new Response('<div id="app"></div><script src="https://evil.test/assets/x.js"></script>', {
      headers: { ...securityHeaders(), "Content-Type": "text/html", "Cache-Control": "no-store" },
    }));
    await expect(smokeDemo(smokeOrigin, "site", fetcher)).rejects.toThrow(/unexpected demo asset/);
  });
});
