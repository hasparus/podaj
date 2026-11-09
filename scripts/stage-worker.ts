import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

export const workerStageDir = (home: string) =>
  join(home, ".local", "share", "podaj", "worker");

type WorkerConfig = Record<string, unknown> & {
  main: string;
  assets: Record<string, unknown> & { directory: string };
};

export const workerConfig = (root: string): WorkerConfig => {
  const errors: ParseError[] = [];
  const value: unknown = parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value) ||
    !("main" in value) || typeof value.main !== "string" || value.main.length === 0 ||
    !("assets" in value) || typeof value.assets !== "object" || value.assets === null || Array.isArray(value.assets) ||
    !("directory" in value.assets) || typeof value.assets.directory !== "string" || value.assets.directory.length === 0) {
    throw new Error("wrangler.jsonc must configure a worker main and assets.directory");
  }
  return value as WorkerConfig;
};

const built = (client: string) => ["index.html", "authorize.html", "_headers"]
  .every((file) => existsSync(join(client, file)));

export const clientBuilt = (packageRoot: string) =>
  built(resolve(packageRoot, workerConfig(packageRoot).assets.directory));

export const stageWorker = ({ packageRoot, stage }: { packageRoot: string; stage: string }) => {
  const config = workerConfig(packageRoot);
  const client = resolve(packageRoot, config.assets.directory);
  if (!built(client)) throw new Error(`missing client build at ${client}`);
  const worker = resolve(packageRoot, config.main);
  if (!existsSync(worker) || !statSync(worker).isFile()) {
    throw new Error(`missing worker entry at ${worker}`);
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  cpSync(client, join(stage, "assets"), {
    recursive: true,
    filter: (source) => source !== join(client, "recipient.pem") && source !== join(client, "recipient.pem.example"),
  });
  writeFileSync(join(stage, "entry.ts"),
    `export { default } from ${JSON.stringify(worker)};\nexport * from ${JSON.stringify(worker)};\n`);
  const configPath = join(stage, "wrangler.json");
  writeFileSync(configPath, `${JSON.stringify({
    ...config,
    main: "entry.ts",
    assets: { ...config.assets, directory: "assets" },
  }, null, 2)}\n`);
  return configPath;
};
