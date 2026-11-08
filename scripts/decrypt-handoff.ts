#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { openPodaj1 } from "./open-podaj1.js";
import { isDirect } from "./package-paths.js";

const BLOB_PREFIX = "PODAJ1.";

export const decryptHandoff = (args: readonly string[]): void => {
  const arg = args[0];
  const blob =
    arg !== undefined && arg.startsWith(BLOB_PREFIX)
      ? arg
      : readFileSync(0, "utf8").trim();
  const privatePem = readFileSync(join(process.env.PODAJ_KEY_DIR || join(homedir(), ".local/share/podaj"), "private.pem"), "utf8");
  process.stdout.write(`${openPodaj1(blob, privatePem)}\n`);
};

if (isDirect(import.meta.url)) decryptHandoff(process.argv.slice(2));
