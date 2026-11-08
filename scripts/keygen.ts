#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { isDirect } from "./package-paths.js";

import { generateKeypair } from "./keypair.js";

export const keyDir = () =>
  process.env.PODAJ_KEY_DIR ?? join(homedir(), ".local", "share", "podaj");

if (isDirect(import.meta.url)) {
  const dir = await generateKeypair(keyDir());
  process.stdout.write(`${dir}\n`);
}
