export interface PodajConfig { url: string; token: string }

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { originOf } from "./instance.js";

export const DEFAULT_URL = "https://podaj.fyi";

export const resolveConnection = (env: NodeJS.ProcessEnv, saved: PodajConfig | null): PodajConfig => {
  const url = originOf(env.PODAJ_URL ?? saved?.url ?? DEFAULT_URL);
  const savedToken = saved !== null && originOf(saved.url) === url ? saved.token : "";
  return { url, token: env.PODAJ_API_AUTH_SECRET ?? savedToken };
};

export const configPath = (env: NodeJS.ProcessEnv, home: string) => {
  const base = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(base, "podaj", "config.json");
};

export const readConfig = (file: string): PodajConfig | null => {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid podaj config: ${file}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("url" in parsed) || typeof parsed.url !== "string" ||
    !("token" in parsed) || typeof parsed.token !== "string"
  ) {
    throw new Error(`invalid podaj config: ${file}`);
  }
  return { token: parsed.token, url: parsed.url };
};

export const writeConfig = (file: string, config: PodajConfig) => {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("podaj config directory must not be a symlink");
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ url: config.url, token: config.token }, null, 2)}\n`, {
      mode: 0o600, flag: "wx",
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
};

export const defaultConfigPath = () => configPath(process.env, homedir());
