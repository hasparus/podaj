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
 * @param {string} file
 * @returns {{ url: string, token: string } | null}
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
  return { url: parsed.url, token: parsed.token };
};

/**
 * @param {string} file
 * @param {{ url: string, token: string }} config
 */
export const writeConfig = (file, config) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
};

export const defaultConfigPath = () => configPath(process.env, homedir());
