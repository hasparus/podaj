import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export const configPath = (env, home) => {
  const base = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(base, "podaj", "config.json");
};

/**
 * @typedef {{ url: string, token: string, kvId?: string }} PodajConfig
 */

/**
 * @param {string} file
 * @returns {PodajConfig | null}
 */
export const readConfig = (file) => {
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
  const parsed = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.url !== "string" ||
    typeof parsed.token !== "string"
  ) {
    throw new Error(`invalid podaj config: ${file}`);
  }
  const kvId = parsed.kvId;
  return {
    token: parsed.token,
    url: parsed.url,
    ...(typeof kvId === "string" ? { kvId } : {}),
  };
};

/**
 * @param {string} file
 * @param {PodajConfig} config
 */
export const writeConfig = (file, config) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
};

export const defaultConfigPath = () => configPath(process.env, homedir());
