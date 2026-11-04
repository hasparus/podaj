import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} home
 */
export const workerStageDir = (home) =>
  join(home, ".local", "share", "podaj", "worker");

/**
 * @param {string} packageRoot
 */
export const clientBuilt = (packageRoot) =>
  existsSync(join(packageRoot, "dist", "client", "index.html"));

/**
 * @param {{
 *   packageRoot: string,
 *   stage: string,
 *   publicPem: string,
 *   kvId: string,
 * }} input
 */
export const stageWorker = ({ packageRoot, stage, publicPem, kvId }) => {
  const client = join(packageRoot, "dist", "client");
  if (!existsSync(client)) {
    throw new Error(`missing client build at ${client}`);
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const assets = join(stage, "assets");
  cpSync(client, assets, { recursive: true });
  writeFileSync(join(assets, "recipient.pem"), publicPem, { mode: 0o644 });
  const worker = join(packageRoot, "src", "worker.ts");
  writeFileSync(
    join(stage, "entry.js"),
    `export { default, HandoffParty } from ${JSON.stringify(worker)};\n`,
  );
  const config = {
    assets: {
      binding: "ASSETS",
      directory: "assets",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    },
    compatibility_date: "2026-11-04",
    durable_objects: {
      bindings: [{ class_name: "HandoffParty", name: "HANDOFF_PARTY" }],
    },
    kv_namespaces: [{ binding: "HANDOFFS", id: kvId }],
    main: "entry.js",
    migrations: [
      { new_sqlite_classes: ["HandoffParty"], tag: "v1-handoff-party" },
    ],
    name: "podaj",
    vars: { MAX_HANDOFF_BYTES: "32768" },
  };
  const configPath = join(stage, "wrangler.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
};
