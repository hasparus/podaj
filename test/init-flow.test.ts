import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { initArgs } from "../scripts/init-args.js";
import { runInit, type InitIo, type SavedInit } from "../scripts/init-flow.js";
import { clientBuilt, stageWorker } from "../scripts/stage-worker.js";
import { tokenFromText } from "../scripts/stdin-token.js";

const fake = (over: Partial<InitIo> = {}) => {
  let saved: SavedInit | undefined;
  const value: InitIo = {
    askToken: async () => "synthetic-token",
    askTokenSource: async () => "have",
    askUrl: async () => "http://localhost:8787",
    askWorkerName: async () => "podaj",
    chooseMode: async () => "connect",
    config: async () => ({ mode: "private", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 }),
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
const connectArgs = { deploy: false, tokenStdin: false, url: "http://localhost:8787" };
const deployArgs = { deploy: true, tokenStdin: false };

it("accepts init --url without a token and explicit stdin tokens", () => {
  expect(initArgs(["--url", "http://localhost:8787"])).toEqual(connectArgs);
  expect(initArgs(["--url", "http://localhost:8787", "--token", "-"]).tokenStdin).toBe(true);
  expect(() => initArgs(["--token", "synthetic"])).toThrow(/url/u);
  expect(() => initArgs(["--deploy", "--url", "https://x"])).toThrow(/either/u);
  expect(() => initArgs(["--unknown"])).toThrow(/unknown/u);
});
it("reads a single stdin token without interpreting empty input as a token", () => {
  expect(tokenFromText("  synthetic\n")).toBe("synthetic");
  expect(tokenFromText("\n")).toBeUndefined();
  expect(() => tokenFromText("one\ntwo\n")).toThrow(/single line/u);
});

describe("runInit", () => {
  it("only fetches config and probes access before saving, without creating or authorizing a request", async () => {
    const events: string[] = [];
    const harness = fake({
      config: async () => { events.push("config"); return { mode: "demo", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 }; },
      probe: async (_origin, token) => { expect(token).toBe(""); events.push("access"); return "ok"; },
      askToken: async () => { throw new Error("must not prompt"); },
    });
    await runInit(connectArgs, harness.value);
    expect(events).toEqual(["config", "access"]);
    expect(harness.saved()).toEqual({ mode: "connect", token: "", url: connectArgs.url });
  });

  it("keeps private instances auth-gated and does not save rejected configuration", async () => {
    const harness = fake({ probe: async () => "unauthorized" });
    await expect(runInit(connectArgs, harness.value)).rejects.toThrow(/rejected/u);
    expect(harness.saved()).toBeUndefined();
  });

  it("skips token prompts for an interactive demo connect", async () => {
    const harness = fake({
      isTTY: true,
      config: async () => ({ mode: "demo", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 }),
      askTokenSource: async () => { throw new Error("must not prompt"); },
    });
    await runInit({ deploy: false, tokenStdin: false }, harness.value);
    expect(harness.saved()?.token).toBe("");
  });

  it("preflights the client build before deployment or Cloudflare work", async () => {
    const whoami = vi.fn(() => true);
    const deploy = vi.fn(() => "unused");
    const harness = fake({ whoami, deploy, ensureClient: () => { throw new Error("missing client build"); } });
    await expect(runInit(deployArgs, harness.value)).rejects.toThrow("missing client build");
    expect(whoami).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });

  it("deploys only the staged worker, with no KV or public-key provisioning", async () => {
    const stage = vi.fn(() => "/stage/wrangler.json");
    const putSecret = vi.fn();
    const harness = fake({ stage, putSecret });
    await runInit(deployArgs, harness.value);
    expect(stage).toHaveBeenCalledWith();
    expect(putSecret).toHaveBeenCalledWith({ configPath: "/stage/wrangler.json" }, "minted-token");
    expect(harness.saved()).toEqual({ mode: "deploy", token: "minted-token", url: "https://podaj.example.workers.dev" });
  });

  it("requires a login for noninteractive deployment", async () => {
    const harness = fake({ whoami: () => false });
    await expect(runInit(deployArgs, harness.value)).rejects.toThrow(/logged in/u);
  });

  it.each(["putSecret", "save"] as const)("redacts minted tokens from %s errors", async (step) => {
    const harness = fake();
    harness.value[step] = () => { throw new Error("failed minted-token"); };
    await expect(runInit(deployArgs, harness.value)).rejects.toThrow("failed [redacted]");
  });

  it.each(["stage", "deploy", "putSecret"] as const)("does not save after %s fails, and can retry without recipient files", async (step) => {
    const harness = fake();
    harness.value[step] = () => { throw new Error(`${step} failed`); };
    await expect(runInit(deployArgs, harness.value)).rejects.toThrow(`${step} failed`);
    expect(harness.saved()).toBeUndefined();
    const retry = fake();
    await runInit(deployArgs, retry.value);
    expect(retry.saved()).toEqual({ mode: "deploy", token: "minted-token", url: "https://podaj.example.workers.dev" });
  });
});

it("refuses an obsolete build before replacing the staged worker", () => {
  const root = mkdtempSync(join(tmpdir(), "podaj-stale-stage-"));
  try {
    mkdirSync(join(root, "dist", "client"), { recursive: true });
    mkdirSync(join(root, "stage"));
    writeFileSync(join(root, "dist", "client", "index.html"), "old build");
    writeFileSync(join(root, "stage", "entry.ts"), "old stage");
    expect(clientBuilt(root)).toBe(false);
    expect(() => stageWorker({ packageRoot: root, stage: join(root, "stage") })).toThrow("missing client build");
    expect(readFileSync(join(root, "stage", "entry.ts"), "utf8")).toBe("old stage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("stages only assets and the SQLite DO entry/binding/migration, discarding old global keys", () => {
  const root = mkdtempSync(join(tmpdir(), "podaj-stage-"));
  try {
    mkdirSync(join(root, "dist", "client"), { recursive: true });
    writeFileSync(join(root, "dist", "client", "index.html"), "<p>podaj</p>");
    writeFileSync(join(root, "dist", "client", "authorize.html"), "<p>authorize</p>");
    writeFileSync(join(root, "dist", "client", "recipient.pem"), "OBSOLETE PUBLIC KEY");
    writeFileSync(join(root, "dist", "client", "recipient.pem.example"), "OBSOLETE EXAMPLE");
    writeFileSync(join(root, "dist", "client", "_headers"), "/*\n  Content-Security-Policy: script-src 'self'\n");
    const stage = join(root, "stage");
    const configPath = stageWorker({ packageRoot: root, stage });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config).not.toHaveProperty("kv_namespaces");
    expect(config.assets.run_worker_first).toEqual(["/", "/s/*", "/api/*", "/parties/*", "/authorize", "/authorize/", "/authorize.html"]);
    expect(config.assets).not.toHaveProperty("not_found_handling");
    expect(config.ratelimits).toEqual([{ name: "PUBLIC_API_LIMITER", namespace_id: "1001", simple: { limit: 60, period: 60 } }]);
    expect(config.observability).toEqual({ enabled: false });
    expect(readFileSync(join(stage, "assets", "_headers"), "utf8")).toContain("script-src 'self'");
    expect(config.durable_objects.bindings).toEqual([{ class_name: "HandoffParty", name: "HANDOFF_PARTY" }]);
    expect(config.migrations).toEqual([{ new_sqlite_classes: ["HandoffParty"], tag: "v1-handoff-party" }]);
    expect(existsSync(join(stage, "assets", "recipient.pem"))).toBe(false);
    expect(existsSync(join(stage, "assets", "recipient.pem.example"))).toBe(false);
    expect(config.vars.PODAJ_MODE).toBe("private");
    expect(existsSync(join(stage, "assets", "authorize.html"))).toBe(true);
    expect(readFileSync(join(stage, "entry.ts"), "utf8")).toContain("export { default, HandoffParty }");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
