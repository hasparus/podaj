#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { armor, Decrypter } from "age-encryption";
import { defaultAgeIdentityPath, readAgeIdentities } from "./age-output.js";
import { openPodaj1 } from "./open-podaj1.js";
import { isDirect } from "./package-paths.js";

const decryptArgs = (args: readonly string[]) => {
  let file: string | undefined;
  let identity: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--identity") {
      if (identity !== undefined || args[index + 1] === undefined) { throw new Error("Pass --identity once with an identity file."); }
      identity = args[index + 1];
      index += 1;
    } else {
      if (arg.startsWith("--")) { throw new Error("Unknown decrypt option."); }
      if (file !== undefined) { throw new Error("Pass one encrypted file, or use stdin."); }
      file = arg;
    }
  }
  return { file, identity };
};

export const decryptHandoff = async (args: readonly string[]): Promise<void> => {
  const { file, identity } = decryptArgs(args);
  const bytes = file === undefined ? readFileSync(0)
    : file.startsWith("PODAJ1.") ? Buffer.from(file) : readFileSync(file);
  const text = bytes.toString("utf8").trim();
  if (text.startsWith("PODAJ1.")) {
    if (identity !== undefined) { throw new Error("--identity is for age files."); }
    const privatePem = readFileSync(join(process.env.PODAJ_KEY_DIR || join(homedir(), ".local/share/podaj"), "private.pem"), "utf8");
    process.stdout.write(`${openPodaj1(text, privatePem)}\n`);
    return;
  }
  const identityFile = identity ?? process.env.PODAJ_AGE_IDENTITY ?? defaultAgeIdentityPath(process.env, homedir());
  const decrypter = new Decrypter();
  for (const key of readAgeIdentities(identityFile)) { decrypter.addIdentity(key); }
  let plain: string;
  try {
    const encrypted = text.startsWith("-----BEGIN AGE ENCRYPTED FILE-----") ? armor.decode(text) : bytes;
    plain = await decrypter.decrypt(encrypted, "text");
  } catch {
    throw new Error("Could not decrypt this age file with the selected identity.");
  }
  process.stdout.write(`${plain}\n`);
};

if (isDirect(import.meta.url)) await decryptHandoff(process.argv.slice(2));
