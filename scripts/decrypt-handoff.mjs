#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openPodaj1 } from "./open-podaj1.mjs";

const BLOB_PREFIX = "PODAJ1.";
const keyDir = () =>
  process.env.PODAJ_KEY_DIR || join(homedir(), ".local/share/podaj");

const entry = process.argv[1];
const direct =
  entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);

if (direct) {
  const arg = process.argv[2];
  const blob =
    arg !== undefined && arg.startsWith(BLOB_PREFIX)
      ? arg
      : readFileSync(0, "utf8").trim();
  const privatePem = readFileSync(join(keyDir(), "private.pem"), "utf8");
  process.stdout.write(`${openPodaj1(blob, privatePem)}\n`);
}
