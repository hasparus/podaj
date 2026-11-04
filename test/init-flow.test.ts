import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { initArgs } from "../scripts/init-args.mjs";
import { runInit, type InitIo, type SavedInit } from "../scripts/init-flow.mjs";
import { originOf, tokenVerdict } from "../scripts/instance.mjs";
import { stageWorker } from "../scripts/stage-worker.mjs";

const fake = (over: Partial<InitIo> = {}) => {
  let saved: SavedInit | undefined;
  const value: InitIo = {
    askToken: async () => "pasted-token",
    askTokenSource: async () => "have",
    askUrl: async () => "https://podaj.example.workers.dev",
    askWorkerName: async () => "podaj",
    chooseMode: async () => "connect",
    createKv: () => "abcdef0123456789abcdef0123456789",
    deploy: () => "https://podaj.example.workers.dev",
    ensureClient: () => undefined,
    existingKvId: () => undefined,
    hasPrivateKey: () => true,
    isTTY: false,
    keyDir: () => "/keys",
    keygen: async () => "/keys",
    login: () => undefined,
    mintToken: () => "minted-token",
    note: () => undefined,
    probe: async () => "ok",
    publicPem: () => "PUBLIC",
    putSecret: () => undefined,
    save: (config) => {
      saved = config;
    },
    stage: () => "/stage/wrangler.json",
    whoami: () => true,
    workersUrl: (output) => output,
    ...over,
  };
  return { saved: () => saved, value };
};

describe("init args", () => {
  it("accepts a connect pair or a deploy flag", () => {
    expect(
      initArgs(["--url", "https://podaj.example.workers.dev", "--token", "abc"]),
    ).toEqual({
      deploy: false,
      token: "abc",
      url: "https://podaj.example.workers.dev",
    });
    expect(initArgs(["--deploy"])).toEqual({ deploy: true });
  });

  it("rejects a half pair and unknown flags", () => {
    expect(() => initArgs(["--url", "https://podaj.example.workers.dev"])).toThrow(
      /both/u,
    );
    expect(() => initArgs(["--weird"])).toThrow(/unknown/u);
    expect(() =>
      initArgs(["--deploy", "--url", "https://x", "--token", "t"]),
    ).toThrow(/either/u);
  });
});

describe("instance url", () => {
  it("normalizes a workers.dev host and reads the status code", () => {
    expect(originOf("podaj.example.workers.dev/s/ignored")).toBe(
      "https://podaj.example.workers.dev",
    );
    expect(tokenVerdict(200)).toBe("ok");
    expect(tokenVerdict(410)).toBe("ok");
    expect(tokenVerdict(401)).toBe("unauthorized");
    expect(tokenVerdict(503)).toBe("locked");
    expect(tokenVerdict(404)).toBe("unreachable");
  });
});

describe("runInit", () => {
  it("connects without prompting when url and token are passed", async () => {
    const harness = fake();
    await runInit(
      { deploy: false, token: "abc", url: "podaj.example.workers.dev" },
      harness.value,
    );
    expect(harness.saved()).toEqual({
      keys: "/keys",
      mode: "connect",
      token: "abc",
      url: "https://podaj.example.workers.dev",
    });
  });

  it("refuses a rejected token and does not save config", async () => {
    const harness = fake({ probe: async () => "unauthorized" });
    await expect(
      runInit(
        { deploy: false, token: "nope", url: "https://podaj.example.workers.dev" },
        harness.value,
      ),
    ).rejects.toThrow(/rejected/u);
    expect(harness.saved()).toBeUndefined();
  });

  it("refuses a non-interactive deploy when Cloudflare is logged out", async () => {
    const harness = fake({ whoami: () => false });
    await expect(runInit({ deploy: true }, harness.value)).rejects.toThrow(
      /logged in/u,
    );
  });

  it("deploys with a new key and reuses a stored namespace", async () => {
    const notes: string[] = [];
    let staged = "";
    const harness = fake({
      existingKvId: () => "abcdef0123456789abcdef0123456789",
      note: (message) => {
        notes.push(message);
      },
      stage: (kvId, publicPem) => {
        staged = `${kvId}:${publicPem}`;
        return "/stage/wrangler.json";
      },
    });
    await runInit({ deploy: true }, harness.value);
    expect(staged).toBe("abcdef0123456789abcdef0123456789:PUBLIC");
    expect(notes).toContain(
      "reusing KV namespace abcdef0123456789abcdef0123456789",
    );
    expect(harness.saved()).toMatchObject({
      kvId: "abcdef0123456789abcdef0123456789",
      mode: "deploy",
      token: "minted-token",
      url: "https://podaj.example.workers.dev",
    });
  });

  it("asks before deploying when a terminal is attached", async () => {
    let loggedIn = false;
    const harness = fake({
      chooseMode: async () => "deploy",
      isTTY: true,
      login: () => {
        loggedIn = true;
      },
      whoami: () => loggedIn,
    });
    await runInit({ deploy: false }, harness.value);
    expect(loggedIn).toBe(true);
    expect(harness.saved()?.mode).toBe("deploy");
  });
});

describe("stageWorker", () => {
  it("writes a user-level wrangler config and the recipient key", () => {
    const root = mkdtempSync(join(tmpdir(), "podaj-stage-"));
    mkdirSync(join(root, "dist", "client"), { recursive: true });
    writeFileSync(join(root, "dist", "client", "index.html"), "<p>podaj</p>");
    const stage = join(root, "stage");
    const configPath = stageWorker({
      kvId: "abcdef0123456789abcdef0123456789",
      packageRoot: root,
      publicPem: "PUBLIC KEY",
      stage,
    });
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      kv_namespaces: { id: string }[];
      main: string;
    };
    expect(config.kv_namespaces[0]?.id).toBe(
      "abcdef0123456789abcdef0123456789",
    );
    expect(config.main).toBe("entry.js");
    expect(readFileSync(join(stage, "assets", "recipient.pem"), "utf8")).toBe(
      "PUBLIC KEY",
    );
    expect(readFileSync(join(stage, "entry.js"), "utf8")).toContain(
      join(root, "src", "worker.ts"),
    );
  });
});
