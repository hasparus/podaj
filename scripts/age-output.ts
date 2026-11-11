import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";

export interface ReceivedHandoff { names: string[]; file: string; identity?: string }
export interface PreparedAgeOutput {
  save(plaintext: string): Promise<ReceivedHandoff>;
  close(): void;
}

const dataDirectory = (env: NodeJS.ProcessEnv, home: string): string =>
  join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share"), "podaj");

export function defaultAgeIdentityPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(dataDirectory(env, home), "age-identity.txt");
}

const hasCode = (error: unknown, code: string): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === code;

const owned = (metadata: fs.Stats): boolean =>
  process.getuid === undefined || metadata.uid === process.getuid();

/** Check the final component without following links, including dangling links. */
function directory(path: string, privateDirectory: boolean): void {
  let descriptor: number | undefined;
  try {
    let metadata = fs.lstatSync(path, { throwIfNoEntry: false });
    if (!metadata) {
      directory(dirname(path), false);
      try {
        fs.mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      metadata = fs.lstatSync(path);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory() || (privateDirectory && !owned(opened))) throw new Error();
    if (privateDirectory) fs.fchmodSync(descriptor, 0o700);
  } catch {
    throw new Error(`cannot use age output directory: ${path}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Secure synchronous reader; async recipient derivation is also checked during prepare. */
export function readAgeIdentities(file: string): string[] {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || !owned(metadata) || (metadata.mode & 0o7077) !== 0) throw new Error();
    const identities = fs.readFileSync(descriptor, "utf8").split(/\r?\n/u)
      .map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
    if (identities.length === 0) throw new Error();
    const validator = new Decrypter();
    for (const identity of identities) validator.addIdentity(identity);
    return identities;
  } catch {
    throw new Error(`cannot read a valid private age identity file: ${file}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function discard(path: string): void {
  try { fs.unlinkSync(path); } catch { }
}

function privateTemp(path: string): number {
  const descriptor = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    discard(path);
    throw error;
  }
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("incomplete write");
    offset += written;
  }
}

async function managedIdentities(file: string): Promise<string[]> {
  if (fs.lstatSync(file, { throwIfNoEntry: false })) return readAgeIdentities(file);
  const temporary = join(dirname(file), `.age-identity-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let created = false;
  try {
    const identity = await generateX25519Identity();
    descriptor = privateTemp(temporary);
    created = true;
    writeAll(descriptor, new TextEncoder().encode(`${identity}\n`));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, file);
      syncDirectory(dirname(file));
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) discard(temporary);
  }
  return readAgeIdentities(file);
}

function namesIn(plaintext: string): string[] {
  try {
    const payload: unknown = JSON.parse(plaintext);
    if (!payload || typeof payload !== "object" || !("vars" in payload) || !Array.isArray(payload.vars)) return [];
    const names: string[] = [];
    for (const entry of payload.vars) {
      if (!entry || typeof entry !== "object" || typeof entry.key !== "string") return [];
      names.push(entry.key);
    }
    return names;
  } catch {
    return [];
  }
}

export async function prepareAgeOutput(env: NodeJS.ProcessEnv, home: string): Promise<PreparedAgeOutput> {
  const data = dataDirectory(env, home);
  const inbox = join(data, "inbox");
  const encrypter = new Encrypter();
  let identity: string | undefined;
  try {
    const base = dirname(data);
    if (base === join(home, ".local", "share")) directory(dirname(base), false);
    directory(base, false);
    directory(data, true);
    if (env.PODAJ_AGE_RECIPIENT) {
      encrypter.addRecipient(env.PODAJ_AGE_RECIPIENT);
    } else {
      identity = resolve(env.PODAJ_AGE_IDENTITY ?? defaultAgeIdentityPath(env, home));
      const identities = env.PODAJ_AGE_IDENTITY !== undefined
        ? readAgeIdentities(identity) : await managedIdentities(identity);
      const recipients: string[] = [];
      for (const key of identities) recipients.push(await identityToRecipient(key));
      encrypter.addRecipient(recipients[0]);
    }
    await encrypter.encrypt(new Uint8Array());
  } catch {
    throw new Error(identity === undefined
      ? "cannot prepare age output: invalid recipient or unsafe data directory"
      : `cannot prepare age output with identity file: ${identity}`);
  }

  let descriptor: number | undefined;
  let temporary: string;
  let file: string;
  try {
    directory(inbox, true);
    const id = randomUUID();
    file = join(inbox, `${id}.age`);
    temporary = join(inbox, `.${id}.age.tmp`);
    descriptor = privateTemp(temporary);
  } catch {
    throw new Error(`cannot reserve encrypted handoff output in: ${inbox}`);
  }
  let state: "ready" | "saving" | "closed" = "ready";
  let complete = false;
  let published = false;

  const close = (): void => {
    state = "closed";
    if (descriptor !== undefined) {
      const handle = descriptor;
      descriptor = undefined;
      try { fs.closeSync(handle); } catch { }
    }
    if (!complete) discard(temporary);
  };

  return {
    close,
    async save(plaintext: string): Promise<ReceivedHandoff> {
      if (state !== "ready") throw new Error("age output is closed or has already been used");
      state = "saving";
      try {
        const ciphertext = await encrypter.encrypt(plaintext);
        if (descriptor === undefined) throw new Error();
        writeAll(descriptor, ciphertext);
        complete = true;
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporary, file);
        published = true;
        syncDirectory(inbox);
        fs.unlinkSync(temporary);
        state = "closed";
        return { names: namesIn(plaintext), file, ...(identity === undefined ? {} : { identity }) };
      } catch {
        close();
        if (complete) {
          throw new Error(`could not finalize encrypted handoff; encrypted recovery file: ${published ? file : temporary}`);
        }
        throw new Error("could not save encrypted handoff");
      }
    },
  };
}
