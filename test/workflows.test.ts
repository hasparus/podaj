import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflows = new URL("../.github/workflows/", import.meta.url);
const ci = readFileSync(new URL("ci.yml", workflows), "utf8");
const deploy = readFileSync(new URL("deploy.yml", workflows), "utf8");
const tagPush = "github.repository == 'hasparus/podaj' && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
const demoRef = "github.repository == 'hasparus/podaj' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))";
const artifact = "name: podaj-tested-${{ github.sha }}";

const job = (workflow: string, name: string): string => {
  const sections = workflow.split(`\n  ${name}:\n`);
  expect(sections).toHaveLength(2);
  return sections[1]!.split(/\n  [a-z][a-z-]*:\n/u)[0]!;
};
const steps = (section: string): string[] => section.split(/^      - /mu).slice(1);
const ordered = (section: string, commands: string[]): void => {
  let previous = -1;
  for (const command of commands) {
    const index = section.indexOf(command);
    expect(index, `missing or out of order: ${command}`).toBeGreaterThan(previous);
    expect(section.lastIndexOf(command), `duplicate: ${command}`).toBe(index);
    previous = index;
  }
};
const check = job(ci, "check");
const publish = job(ci, "publish");
const clone = job(deploy, "deploy");
const demo = job(deploy, "demo");

const expectToolchain = (section: string): void => {
  ordered(section, [
    "uses: actions/checkout@v4", "uses: actions/setup-node@v4", "node-version: 24",
    "uses: oven-sh/setup-bun@v2", "bun-version: 1.4.4", "bun install --frozen-lockfile",
  ]);
  expect(section).toContain("ref: ${{ github.sha }}\n");
  expect(section).toContain("persist-credentials: false\n");
};

describe("tag-driven CI publication", () => {
  it("checks main, v* tags and PRs, with read-only workflow permissions and no manual publication", () => {
    expect(ci.split("jobs:\n")[0]).toBe(
      "name: ci\non:\n  push:\n    branches: [main]\n    tags: ['v*']\n  pull_request:\n\npermissions:\n  contents: read\n\n",
    );
    expect(ci.split("jobs:\n")[1]!.match(/^  [a-z][a-z-]*:\n/gmu)).toEqual(["  check:\n", "  publish:\n"]);
    expect(ci).not.toMatch(/workflow_dispatch|workflow_call|workflow_run|inputs[.:]|PUBLISH|continue-on-error|always\(\)|cancel-in-progress: true/u);
    expect(existsSync(fileURLToPath(new URL("release.yml", workflows)))).toBe(false);
    expect(ci).not.toMatch(/CLOUDFLARE|TURNSTILE|deploy-demo|smoke-demo|preflight-demo|wrangler/u);
  });

  it("tests and builds before packing and uploading, without privileged check-job permissions", () => {
    expectToolchain(check);
    expect(check).not.toMatch(/\n    (?:if|permissions|env):|id-token|secrets\./u);
    ordered(check, [
      "bun install --frozen-lockfile", "run: bun run check", "run: bun run test",
      "run: bun scripts/release.ts pack", "uses: actions/upload-artifact@v4",
    ]);
    expect(steps(check)).toHaveLength(8);
    expect(check).not.toContain("bun run build");
    expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.test).toMatch(/^bun run build && /u);
  });

  it("packs only upstream pushed tags and keeps the tested archive available for publisher retries", () => {
    const gated = steps(check).filter((step) => /release\.ts pack|actions\/upload-artifact/u.test(step));
    expect(gated).toHaveLength(2);
    for (const step of gated) expect(step).toContain(`        if: ${tagPush}\n`);
    const upload = gated[1]!;
    for (const setting of [artifact, "overwrite: true", "path: .cloudflare/podaj-*.tgz", "include-hidden-files: true", "if-no-files-found: error", "retention-days: 7"]) {
      expect(upload).toContain(`${setting}\n`);
    }
    expect(upload).not.toMatch(/github\.run_attempt|include-hidden-files: false/u);
  });

  it("serializes only publication and requires successful checks plus the upstream pushed-tag guard", () => {
    expect(publish).toContain(`    needs: check\n    if: ${tagPush}\n`);
    expect(publish).toContain("    permissions:\n      contents: read\n      id-token: write\n");
    expect(publish).toContain("    concurrency:\n      group: podaj-npm-publication\n      cancel-in-progress: false\n");
    expect(ci).not.toMatch(/^concurrency:/mu);
    expect(publish.match(/\bif:/gu)).toHaveLength(1);
  });

  it("preflights then consumes this run's tested artifact without rebuilding or repacking", () => {
    expectToolchain(publish);
    expect(publish).toContain("fetch-depth: 0\n");
    ordered(publish, [
      "bun install --frozen-lockfile", "npm install --global npm@11.5.1 --ignore-scripts",
      "run: bun scripts/release.ts preflight-publish", "uses: actions/download-artifact@v4",
      "run: bun scripts/release.ts publish",
    ]);
    expect(steps(publish)).toHaveLength(7);
    const download = steps(publish).find((step) => step.includes("actions/download-artifact@v4"))!;
    expect(download).toContain(`${artifact}\n          path: .cloudflare\n`);
    expect(download).not.toMatch(/repository:|run-id:|github-token:|pattern:|merge-multiple:|github\.run_attempt/u);
    expect(publish).not.toMatch(/bun run (?:check|test|build)|release\.ts pack|npm (?:pack|publish)|prepack|upload-artifact|CLOUDFLARE|TURNSTILE/u);
  });

  it("exposes the optional npm credential only to preflight and publication", () => {
    const authenticated = steps(publish).filter((step) => step.includes("secrets.NPM_TOKEN"));
    expect(authenticated).toHaveLength(2);
    expect(authenticated[0]).toContain("run: bun scripts/release.ts preflight-publish\n");
    expect(authenticated[1]).toContain("run: bun scripts/release.ts publish\n");
    for (const step of authenticated) expect(step).toContain("        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n");
    expect(publish).not.toMatch(/NODE_AUTH_TOKEN|registry-url|\n    env:/u);
  });
});

describe("independent Cloudflare deployment", () => {
  it("runs on main pushes, v* tags and manual reruns, but never deploys upstream feature branches", () => {
    expect(deploy.split("jobs:\n")[0]).toBe(
      "name: deploy\n\non:\n  push:\n    branches: [main]\n    tags: ['v*']\n  workflow_dispatch:\n\n",
    );
    expect(deploy.split("jobs:\n")[1]!.match(/^  [a-z][a-z-]*:\n/gmu)).toEqual(["  deploy:\n", "  demo:\n"]);
    expect(demo).toContain(`    if: ${demoRef}\n`);
    expect(demo.match(/\bif:/gu)).toHaveLength(1);
    expect(demo).toContain("    concurrency:\n      group: podaj-demo-deployment\n      cancel-in-progress: false\n");
    expect(demo).toContain("    permissions:\n      contents: read\n");
    expect(deploy).not.toMatch(/^concurrency:/mu);
  });

  it("retains clone deployment with private account secrets, mutually exclusive with the upstream demo", () => {
    expect(clone).toContain("    if: github.repository != 'hasparus/podaj'\n");
    expect(clone).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n");
    expect(clone).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n");
    expect(clone).toContain('if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then');
    expect(clone).toContain("exit 0\n");
    expect(clone).toContain("bun run deploy\n");
    expect(clone).not.toMatch(/release\.ts|podaj\.fyi|demo-wrangler|afc3b7953504bb4cc5603e8ecec2da93|PODAJ_ACCESS/u);
    expect(demo).not.toMatch(/secrets\.CLOUDFLARE_ACCOUNT_ID|bun run deploy|exit 0/u);
  });

  it("preflights credentials and trusted source before checks, tests, rollout and live smoke", () => {
    expectToolchain(demo);
    expect(demo).toContain("fetch-depth: 0\n");
    ordered(demo, [
      "bun install --frozen-lockfile", "run: bun scripts/release.ts preflight-demo",
      "run: bun run check", "run: bun run test", "run: bun scripts/release.ts deploy-demo",
      "run: bun scripts/release.ts smoke-demo", "$GITHUB_STEP_SUMMARY",
    ]);
    expect(steps(demo)).toHaveLength(10);
    const operations = steps(demo).filter((step) => /release\.ts (?:preflight-demo|deploy-demo)/u.test(step));
    expect(operations).toHaveLength(2);
    for (const step of operations) {
      for (const setting of [
        "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
        "TURNSTILE_SECRET_KEY: ${{ secrets.TURNSTILE_SECRET_KEY }}",
        "TURNSTILE_SITE_KEY: ${{ vars.TURNSTILE_SITE_KEY }}",
      ]) expect(step).toContain(`${setting}\n`);
    }
    expect(demo).not.toMatch(/continue-on-error|always\(\)|\|\| true|bunx|--no-verify|secrets-file|bun run build/u);
    expect(demo).toContain("Live HTTP smoke checks do not verify real Turnstile or a human fill. No captcha bypass is enabled.");
  });

  it("can deploy an already-published version without npm credentials or any publication/registry gate", () => {
    expect(deploy).not.toMatch(/npm|NPM|registry|preflight-publish|release\.ts (?:pack|publish)|artifact|\bneeds:|id-token|inputs[.:]/u);
    expect(demo).not.toMatch(/v0\.1\.0|package\.json|unpublished/u);
    expect(ci.match(/run: bun scripts\/release\.ts publish\n/gu)).toHaveLength(1);
  });
});
