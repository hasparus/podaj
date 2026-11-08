import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { packageRoot } from "./package-paths.js";

const root = realpathSync(packageRoot(import.meta.url));
if (process.env.npm_command !== "pack" && process.env.npm_command !== "publish" &&
  existsSync(join(root, ".git")) && existsSync(join(root, "lefthook.yml"))) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (git.status === 0 && realpathSync(git.stdout.trim()) === root) {
    const manifest = createRequire(import.meta.url).resolve("lefthook/package.json");
    const installed = spawnSync(process.execPath, [join(dirname(manifest), "bin/index.js"), "install"], {
      cwd: root,
      encoding: "utf8",
    });
    if (installed.error) throw installed.error;
    if (installed.status !== 0) {
      process.stderr.write(installed.stderr || "could not install development commit hooks\n");
      process.exitCode = installed.status ?? 1;
    }
  }
}
