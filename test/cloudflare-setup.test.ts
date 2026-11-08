import { describe, expect, it } from "vitest";

import { cloudflareCommand, cloudflareTarget } from "../scripts/cloudflare.js";

const ACCOUNT = "a".repeat(32);
const profile = `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=synthetic-profile-token\n`;

describe("Cloudflare target isolation", () => {
  it.each([["test", "hasparus"], ["demo", "podaj"]])("pins %s to its explicit account ID", (target, name) => {
    const selected = cloudflareTarget(target, profile, { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) });
    expect(selected.accountName).toBe(name);
    expect(selected.accountId).toBe(ACCOUNT);
    expect(selected.workerName).toBe("podaj");
    expect(selected.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
  });

  it.each(["", "invalid", "a".repeat(31), "a".repeat(33)])("refuses missing/invalid account IDs rather than cached defaults", (id) => {
    expect(() => cloudflareTarget("test", `CLOUDFLARE_ACCOUNT_ID=${id}`, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toThrow(/account ID/);
  });

  it("does not fall back to another account token or endpoint", () => {
    const selected = cloudflareTarget("demo", `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`, {
      PATH: "/synthetic-bin",
      CLOUDFLARE_API_TOKEN: "wrong-account-token",
      CLOUDFLARE_API_KEY: "wrong-global-key",
      CLOUDFLARE_API_BASE_URL: "https://wrong.example",
      CF_API_TOKEN: "legacy-token",
    });
    expect(selected.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(selected.env.CLOUDFLARE_API_KEY).toBeUndefined();
    expect(selected.env.CLOUDFLARE_API_BASE_URL).toBeUndefined();
    expect(selected.env.CF_API_TOKEN).toBeUndefined();
    expect(selected.env.PATH).toBe("/synthetic-bin");
    expect(selected.env.CLOUDFLARE_INCLUDE_PROCESS_ENV).toBe("false");
    expect(selected.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe("false");
  });

  it("uses only the selected profile token", () => {
    expect(cloudflareTarget("test", profile, { CLOUDFLARE_API_TOKEN: "wrong-account-token" }).env.CLOUDFLARE_API_TOKEN).toBe("synthetic-profile-token");
  });

  it("rejects runtime secrets in management profiles without echoing values", () => {
    expect(() => cloudflareTarget("test", `${profile}PODAJ_API_AUTH_SECRET=synthetic-worker-secret`)).toThrow("Cloudflare profiles accept only CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  });

  it("rejects unknown targets", () => {
    expect(() => cloudflareTarget("../other", profile)).toThrow(/test or demo/);
  });
});

describe("Cloudflare preparation commands", () => {
  it.each([["whoami"], ["login"], ["secret", "list"], ["secret", "put", "PODAJ_API_AUTH_SECRET"]])("allows explicit preparation: %j", (...args) => {
    expect(cloudflareCommand(args)).toEqual(args);
  });

  it.each([
    ["deploy"], ["delete"], ["secret", "bulk", "secrets.json"],
    ["secret", "put", "PODAJ_API_AUTH_SECRET", "plaintext-value"],
    ["secret", "put", "--name"], ["secret", "list", "--env", "production"],
    ["secret", "list", "--config", "other.json"], ["whoami", "--env-file", "other.env"],
  ])("rejects deployments, values in argv, and target overrides: %j", (...args) => {
    expect(() => cloudflareCommand(args)).toThrow(/allowed:/);
  });
});
