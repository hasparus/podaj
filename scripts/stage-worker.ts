import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const workerStageDir = (home: string) =>
  join(home, ".local", "share", "podaj", "worker");

export const clientBuilt = (packageRoot: string) =>
  ["index.html", "authorize.html", "_headers"].every((file) =>
    existsSync(join(packageRoot, "dist", "client", file)));

export const stageWorker = ({ packageRoot, stage }: { packageRoot: string; stage: string }) => {
  const client = join(packageRoot, "dist", "client");
  if (!clientBuilt(packageRoot)) {
    throw new Error(`missing client build at ${client}`);
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const assets = join(stage, "assets");
  cpSync(client, assets, {
    recursive: true,
    filter: (source) => source !== join(client, "recipient.pem") && source !== join(client, "recipient.pem.example"),
  });
  const worker = join(packageRoot, "src", "worker.ts");
  writeFileSync(
    join(stage, "entry.ts"),
    `export { default, HandoffParty } from ${JSON.stringify(worker)};\n`,
  );
  const config = {
    assets: {
      binding: "ASSETS",
      directory: "assets",
      run_worker_first: ["/", "/s/*", "/api/*", "/parties/*", "/authorize", "/authorize/", "/authorize.html"],
    },
    compatibility_date: "2025-10-11",
    durable_objects: {
      bindings: [{ class_name: "HandoffParty", name: "HANDOFF_PARTY" }],
    },
    main: "entry.ts",
    migrations: [
      { new_sqlite_classes: ["HandoffParty"], tag: "v1-handoff-party" },
    ],
    name: "podaj",
    observability: { enabled: false },
    ratelimits: [{ name: "PUBLIC_API_LIMITER", namespace_id: "1001", simple: { limit: 60, period: 60 } }],
    vars: { PODAJ_MODE: "private", MAX_HANDOFF_BYTES: "32768", HANDOFF_TTL_SECONDS: "7200" },
  };
  const configPath = join(stage, "wrangler.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
};
