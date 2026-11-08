import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSync } from "esbuild";

import { configArgs } from "../scripts/config-args.js";
import { runConfig, runDeploy, type SetupIo } from "../scripts/setup-flow.js";
import { clientBuilt, stageWorker } from "../scripts/stage-worker.js";
import { tokenFromText } from "../scripts/stdin-token.js";

const fake = (over: Partial<SetupIo> = {}) => {
  let saved: Parameters<SetupIo["save"]>[0] | undefined;
  const value: SetupIo = {
    askToken: async () => "synthetic-token",
    askTokenSource: async () => "have",
    askUrl: async () => "http://localhost:8787",
    askWorkerName: async () => "podaj",
    config: async () => ({ access: "private", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 }),
    deploy: () => "https://podaj.example.workers.dev",
    ensureClient: () => undefined,
    isTTY: false,
    login: () => undefined,
    mintToken: () => "minted-token",
    note: () => undefined,
    probe: async () => "ok",
    putSecret: () => undefined,
    save: (config) => { saved = config; },
    stage: () => "/stage/wrangler.json",
    whoami: () => true,
    workersUrl: (output) => output,
    ...over,
  };
  return { saved: () => saved, value };
};
const connectArgs = { tokenStdin: false, url: "http://localhost:8787" };

it("parses config URL and token flags without a deployment mode", () => {
  expect(configArgs([])).toEqual({ tokenStdin: false });
  expect(configArgs(["--url", "http://localhost:8787"])).toEqual(connectArgs);
  expect(configArgs(["--url", connectArgs.url, "--token", "synthetic"])).toEqual({ ...connectArgs, token: "synthetic" });
  expect(configArgs(["--url", connectArgs.url, "--token", "-"])).toEqual({ ...connectArgs, tokenStdin: true });
  expect(() => configArgs(["--token", "synthetic"])).toThrow(/url/u);
  expect(() => configArgs(["--token", "-"])).toThrow(/url/u);
  expect(() => configArgs(["--url", connectArgs.url, "--token", "-", "--token", "synthetic"])).toThrow(/once/u);
  for (const flag of ["--deploy", "--unknown"]) expect(() => configArgs([flag])).toThrow(/unknown/u);
  for (const flag of ["--url", "--token"]) expect(() => configArgs([flag])).toThrow(/value/u);
});
it("reads a single stdin token without interpreting empty input as a token", () => {
  expect(tokenFromText("  synthetic\n")).toBe("synthetic");
  expect(tokenFromText("\n")).toBeUndefined();
  expect(() => tokenFromText("one\ntwo\n")).toThrow(/single line/u);
});

describe("runConfig", () => {
  it("only fetches config and probes access before saving, without creating or authorizing a request", async () => {
    const events: string[] = [];
    const harness = fake({
      config: async () => { events.push("config"); return { access: "public", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 }; },
      probe: async (_origin, token) => { expect(token).toBe(""); events.push("access"); return "ok"; },
      askToken: async () => { throw new Error("must not prompt"); },
    });
    await runConfig(connectArgs, harness.value);
    expect(events).toEqual(["config", "access"]);
    expect(harness.saved()).toEqual({ token: "", url: connectArgs.url });
  });

  it("keeps private instances auth-gated and does not save rejected configuration", async () => {
    const harness = fake({ probe: async () => "unauthorized" });
    await expect(runConfig(connectArgs, harness.value)).rejects.toThrow(/rejected/u);
    expect(harness.saved()).toBeUndefined();
  });

  it("skips all token prompts for an interactive public connection", async () => {
    const harness = fake({
      isTTY: true,
      config: async () => ({ access: "public", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 }),
      askTokenSource: async () => { throw new Error("must not prompt"); },
      askToken: async () => { throw new Error("must not prompt"); },
    });
    await runConfig({ tokenStdin: false }, harness.value);
    expect(harness.saved()).toEqual({ token: "", url: connectArgs.url });
  });

  it.each(["flags", "prompt", "new-token"] as const)("config does not deploy or stage a Worker via %s", async (variant) => {
    const forbidden = vi.fn(() => { throw new Error("config must not deploy"); });
    const putSecret = vi.fn();
    const harness = fake({
      isTTY: true, deploy: forbidden, stage: forbidden, ensureClient: forbidden, putSecret,
      askTokenSource: async () => variant === "new-token" ? "set" : "have",
    });
    await runConfig(variant === "flags" ? { ...connectArgs, token: "synthetic-token" } : { tokenStdin: false }, harness.value);
    expect(forbidden).not.toHaveBeenCalled();
    expect(harness.saved()).toEqual({ token: variant === "new-token" ? "minted-token" : "synthetic-token", url: connectArgs.url });
    if (variant === "new-token") expect(putSecret).toHaveBeenCalledWith({ name: "podaj" }, "minted-token");
    else expect(putSecret).not.toHaveBeenCalled();
  });

  it("requires a URL in a noninteractive config invocation", async () => {
    const harness = fake();
    await expect(runConfig({ tokenStdin: false }, harness.value)).rejects.toThrow(/terminal|url/u);
    expect(harness.saved()).toBeUndefined();
  });

  it.each(["config", "probe", "save"] as const)("redacts supplied tokens from %s errors", async (step) => {
    const harness = fake();
    harness.value[step] = () => { throw new Error("failed synthetic-token"); };
    await expect(runConfig({ ...connectArgs, token: "synthetic-token" }, harness.value)).rejects.toThrow("failed [redacted]");
  });
});

describe("runDeploy", () => {
  it("preflights the client build before deployment or Cloudflare work", async () => {
    const whoami = vi.fn(() => true);
    const deploy = vi.fn(() => "unused");
    const harness = fake({ whoami, deploy, ensureClient: () => { throw new Error("missing client build"); } });
    await expect(runDeploy(harness.value)).rejects.toThrow("missing client build");
    expect(whoami).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });

  it("automatically configures the deployed Worker only after installing its minted secret, without setup prompts", async () => {
    const events: string[] = [];
    const forbidden = vi.fn(() => { throw new Error("deploy must not prompt or contact the Worker"); });
    const harness = fake({
      askUrl: forbidden, askTokenSource: forbidden, askToken: forbidden, askWorkerName: forbidden,
      config: forbidden, probe: forbidden,
      ensureClient: () => { events.push("client"); },
      whoami: () => { events.push("whoami"); return true; },
      stage: () => { events.push("stage"); return "/stage/wrangler.json"; },
      deploy: (path) => { expect(path).toBe("/stage/wrangler.json"); events.push("deploy"); return "deployment output"; },
      workersUrl: (output) => { expect(output).toBe("deployment output"); return "https://podaj.example.workers.dev"; },
      mintToken: () => { events.push("mint"); return "minted-token"; },
      putSecret: (target, token) => {
        expect(target).toEqual({ configPath: "/stage/wrangler.json" });
        expect(token).toBe("minted-token");
        expect(harness.saved()).toBeUndefined();
        events.push("secret");
      },
    });
    const save = harness.value.save;
    harness.value.save = (config) => { events.push("save"); save(config); };
    await runDeploy(harness.value);
    expect(events).toEqual(["client", "whoami", "stage", "deploy", "mint", "secret", "save"]);
    expect(forbidden).not.toHaveBeenCalled();
    expect(harness.saved()).toEqual({ token: "minted-token", url: "https://podaj.example.workers.dev" });
  });

  it("requires a login for noninteractive deployment", async () => {
    const harness = fake({ whoami: () => false });
    await expect(runDeploy(harness.value)).rejects.toThrow(/logged in/u);
  });

  it.each(["putSecret", "save"] as const)("redacts minted tokens from %s errors", async (step) => {
    const harness = fake();
    harness.value[step] = () => { throw new Error("failed minted-token"); };
    await expect(runDeploy(harness.value)).rejects.toThrow("failed [redacted]");
  });

  it.each(["stage", "deploy", "putSecret"] as const)("does not save after %s fails, and can retry without recipient files", async (step) => {
    const harness = fake();
    harness.value[step] = () => { throw new Error(`${step} failed`); };
    await expect(runDeploy(harness.value)).rejects.toThrow(`${step} failed`);
    expect(harness.saved()).toBeUndefined();
    const retry = fake();
    await runDeploy(retry.value);
    expect(retry.saved()).toEqual({ token: "minted-token", url: "https://podaj.example.workers.dev" });
  });
});

it("refuses an obsolete build before replacing the staged worker", () => {
  const root = mkdtempSync(join(tmpdir(), "podaj-stale-stage-"));
  try {
    mkdirSync(join(root, "dist", "client"), { recursive: true });
    mkdirSync(join(root, "stage"));
    writeFileSync(join(root, "wrangler.jsonc"), readFileSync(new URL("../wrangler.jsonc", import.meta.url)));
    writeFileSync(join(root, "dist", "client", "index.html"), "old build");
    writeFileSync(join(root, "stage", "entry.ts"), "old stage");
    expect(clientBuilt(root)).toBe(false);
    expect(() => stageWorker({ packageRoot: root, stage: join(root, "stage") })).toThrow("missing client build");
    expect(readFileSync(join(root, "stage", "entry.ts"), "utf8")).toBe("old stage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("stages the canonical JSONC configuration and real worker entry, discarding old global keys", () => {
  const root = mkdtempSync(join(tmpdir(), "podaj-stage-"));
  try {
    mkdirSync(join(root, "dist", "client"), { recursive: true });
    writeFileSync(join(root, "dist", "client", "index.html"), "<p>podaj</p>");
    writeFileSync(join(root, "dist", "client", "authorize.html"), "<p>authorize</p>");
    writeFileSync(join(root, "dist", "client", "recipient.pem"), "OBSOLETE PUBLIC KEY");
    writeFileSync(join(root, "dist", "client", "recipient.pem.example"), "OBSOLETE EXAMPLE");
    writeFileSync(join(root, "dist", "client", "_headers"), "/*\n  Content-Security-Policy: script-src 'self'\n");
    const original = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    writeFileSync(join(root, "wrangler.jsonc"), original);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "worker.ts"), "export default { fetch() { return new Response('fixture'); } }; export class HandoffParty {}\n");
    const stage = join(root, "stage");
    const configPath = stageWorker({ packageRoot: root, stage });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(readFileSync(join(stage, "assets", "_headers"), "utf8")).toContain("script-src 'self'");
    expect(existsSync(join(stage, "assets", "recipient.pem"))).toBe(false);
    expect(existsSync(join(stage, "assets", "recipient.pem.example"))).toBe(false);
    expect(existsSync(join(stage, "assets", "authorize.html"))).toBe(true);
    expect(readFileSync(join(stage, "entry.ts"), "utf8")).toContain(JSON.stringify(join(root, "src", "worker.ts")));
    const canonical = JSON.parse(original);
    expect(config).toEqual({ ...canonical, main: "entry.ts", assets: { ...canonical.assets, directory: "assets" } });
    expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves customized JSONC fields and resolves main/assets relative to the package", () => {
  const root = mkdtempSync(join(tmpdir(), "podaj-custom-stage-"));
  try {
    const canonical = {
      ...JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")),
      name: "private-custom-worker",
      main: "worker/entry.ts",
      vars: { PODAJ_ACCESS: "private", HANDOFF_TTL_SECONDS: "3600", MAX_HANDOFF_BYTES: "65536" },
      assets: { directory: "ui", binding: "CUSTOM_ASSETS", run_worker_first: ["/custom/*"] },
      observability: { enabled: true },
    };
    const document = JSON.stringify(canonical, null, 2);
    const original = `// private instance configuration\n${document.slice(0, -1)},\n}\n`;
    writeFileSync(join(root, "wrangler.jsonc"), original);
    mkdirSync(join(root, "ui"));
    for (const file of ["index.html", "authorize.html", "_headers"]) writeFileSync(join(root, "ui", file), "fixture asset");
    mkdirSync(join(root, "worker"));
    writeFileSync(join(root, "worker", "entry.ts"), "export { default } from './implementation.js';\n");
    writeFileSync(join(root, "worker", "implementation.ts"), "export default { fetch() { return new Response('real worker'); } };\n");
    expect(clientBuilt(root)).toBe(true);
    const staged = JSON.parse(readFileSync(stageWorker({ packageRoot: root, stage: join(root, "stage") }), "utf8"));
    expect(staged).toEqual({ ...canonical, main: "entry.ts", assets: { ...canonical.assets, directory: "assets" } });
    expect(readFileSync(join(root, "stage", "entry.ts"), "utf8")).toContain(JSON.stringify(join(root, "worker", "entry.ts")));
    const bundled = buildSync({ entryPoints: [join(root, "stage", staged.main)], bundle: true, format: "esm", write: false });
    expect(bundled.outputFiles[0].text).toContain("real worker");
    expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "stage", "assets", "index.html"), "utf8")).toBe("fixture asset");
    rmSync(join(root, "worker", "entry.ts"));
    expect(() => stageWorker({ packageRoot: root, stage: join(root, "stage") })).toThrow("missing worker entry");
    expect(existsSync(join(root, "stage", "entry.ts"))).toBe(true);
    writeFileSync(join(root, "wrangler.jsonc"), '{ "main": "unterminated');
    expect(() => stageWorker({ packageRoot: root, stage: join(root, "stage") })).toThrow("wrangler.jsonc must configure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
