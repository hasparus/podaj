#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeypair } from "./keypair.mjs";

export const keyDir = () =>
  process.env.PODAJ_KEY_DIR ?? join(homedir(), ".local", "share", "podaj");

const entry = process.argv[1];
const direct =
  entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);

if (direct) {
  const dir = await generateKeypair(keyDir());
  process.stdout.write(`${dir}\n`);
}
