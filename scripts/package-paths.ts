import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Locate the package from either source scripts or their dist/scripts output. */
export const packageRoot = (moduleUrl: string): string => {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("could not locate the podaj package root");
    directory = parent;
  }
  return directory;
};

/** Resolve dependency-owned Node entry points, including npm's hoisted layout. */
export const packageTool = (name: "wrangler" | "vite", moduleUrl = import.meta.url): string => {
  const manifest = createRequire(moduleUrl).resolve(`${name}/package.json`);
  return join(dirname(manifest), "bin", `${name}.js`);
};

export const isDirect = (moduleUrl: string): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(moduleUrl);
};
