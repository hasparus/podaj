import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { configPath, readConfig, writeConfig } from "../scripts/config.mjs";
import {
  bindNamespace,
  composeUrl,
  KV_PLACEHOLDER,
  kvNamespaceId,
  workersUrl,
} from "../scripts/deploy-text.mjs";
import { selectVars } from "../scripts/select-vars.mjs";

describe("podaj config", () => {
  it("writes url and token under XDG_CONFIG_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "podaj-config-"));
    const file = configPath({ XDG_CONFIG_HOME: home }, "/unused");
    writeConfig(file, { token: "secret", url: "https://podaj.example.workers.dev" });
    expect(readConfig(file)).toEqual({
      token: "secret",
      url: "https://podaj.example.workers.dev",
    });
    expect(readFileSync(file, "utf8")).toContain("podaj.example.workers.dev");
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
  it("reads the workers.dev url and the new namespace id", () => {
    expect(
      workersUrl("Deployed podaj\n  https://podaj.me.workers.dev\n"),
    ).toBe("https://podaj.me.workers.dev");
    expect(
      kvNamespaceId(`id = "${KV_PLACEHOLDER}"\nid = "abcdef0123456789abcdef0123456789"`),
    ).toBe("abcdef0123456789abcdef0123456789");
    expect(bindNamespace(`"id": "${KV_PLACEHOLDER}"`, "abc")).toBe('"id": "abc"');
    expect(composeUrl("https://podaj.me.workers.dev", "aa", "write", "tok")).toBe(
      "https://podaj.me.workers.dev/s/aa#write=write&token=tok",
    );
  });
});
