import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAgeIdentityPath, prepareAgeOutput, readAgeIdentities } from "../scripts/age-output.js";

const roots: string[] = [];
const outputs: { close(): void }[] = [];
const scratch = (): string => {
  const root = fs.mkdtempSync(join(tmpdir(), "podaj-age-"));
  roots.push(root);
  return root;
};
const prepare = async (env: NodeJS.ProcessEnv, home: string) => {
  const output = await prepareAgeOutput(env, home);
  outputs.push(output);
  return output;
};
const decrypt = async (file: string, identity: string): Promise<string> => {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(fs.readFileSync(file), "text");
};
const writeIdentity = (file: string, content: string): void => {
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
};
const files = (path: string): string[] => fs.existsSync(path) ? fs.readdirSync(path).sort() : [];
const inboxAt = (root: string): string => join(root, ".local", "share", "podaj", "inbox");
const mode = (path: string): number => fs.statSync(path).mode & 0o777;
const fault = (): Error => new Error("DO_NOT_EXPOSE_crypto_or_plaintext_details");
const dummy = '{"vars":[{"key":"DUMMY","value":"never-store-this-plaintext-秘密"}]}';

const recipientFixture = async () => {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const output of outputs.splice(0)) output.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("local age handoff output", () => {
  it("generates and reuses a managed identity, reserves output, and sets private modes", async () => {
    const home = scratch();
    const identityPath = defaultAgeIdentityPath({}, home);
    expect(identityPath).toBe(join(home, ".local", "share", "podaj", "age-identity.txt"));
    const first = await prepare({}, home);
    const identity = fs.readFileSync(identityPath, "utf8");
    expect(identity).toMatch(/^AGE-SECRET-KEY-1/u);
    const original = fs.statSync(identityPath);
    expect(mode(dirname(identityPath))).toBe(0o700);
    expect(mode(identityPath)).toBe(0o600);
    expect(mode(inboxAt(home))).toBe(0o700);
    const [reserved] = files(inboxAt(home));
    expect(reserved).toMatch(/^\.[\da-f-]+\.age\.tmp$/u);
    expect(mode(join(inboxAt(home), reserved))).toBe(0o600);
    expect(fs.statSync(join(inboxAt(home), reserved)).size).toBe(0);
    const received = await first.save(dummy);
    expect(received).toEqual({ names: ["DUMMY"], file: expect.stringMatching(/[\da-f-]+\.age$/u), identity: identityPath });
    expect(mode(received.file)).toBe(0o600);
    expect(fs.readFileSync(received.file).toString().startsWith("age-encryption.org/v1\n")).toBe(true);
    expect(await decrypt(received.file, identity.trim())).toBe(dummy);
    expect(files(inboxAt(home))).toEqual([received.file.split("/").at(-1)]);
    const second = await prepare({}, home);
    second.close();
    expect(fs.readFileSync(identityPath, "utf8")).toBe(identity);
    expect(fs.statSync(identityPath).ino).toBe(original.ino);
    expect(fs.statSync(identityPath).mtimeMs).toBe(original.mtimeMs);
    expect(files(dirname(identityPath))).toEqual(["age-identity.txt", "inbox"]);
  });

  it.each(["", "relative-data"])("uses the default data directory for empty or relative XDG_DATA_HOME (%j)", async (xdg) => {
    const home = scratch();
    const expected = defaultAgeIdentityPath({}, home);
    expect(defaultAgeIdentityPath({ XDG_DATA_HOME: xdg }, home)).toBe(expected);
    const result = await (await prepare({ XDG_DATA_HOME: xdg }, home)).save(dummy);
    expect(result.identity).toBe(expected);
    expect(result.file.startsWith(inboxAt(home))).toBe(true);
    expect(await decrypt(result.file, readAgeIdentities(expected)[0])).toBe(dummy);
  });

  it("honors XDG_DATA_HOME and ignores legacy RSA/SSH keys", async () => {
    const home = scratch();
    const xdg = join(home, "custom-data");
    writeIdentity(join(home, ".ssh", "id_ed25519"), "not an age key");
    writeIdentity(join(xdg, "podaj", "private.pem"), "legacy RSA key");
    const received = await (await prepare({ XDG_DATA_HOME: xdg, PODAJ_KEY_DIR: join(home, ".ssh") }, home)).save(dummy);
    expect(received.identity).toBe(join(xdg, "podaj", "age-identity.txt"));
    expect(received.file.startsWith(join(xdg, "podaj", "inbox"))).toBe(true);
    expect(fs.readFileSync(join(xdg, "podaj", "private.pem"), "utf8")).toBe("legacy RSA key");
    expect(fs.existsSync(join(home, ".local"))).toBe(false);
  });

  it("uses an explicit existing native identity file, validates every key, and encrypts to the first", async () => {
    const home = scratch();
    const one = await generateX25519Identity();
    const two = await generateX25519Identity();
    const file = join(home, "external", "identity");
    writeIdentity(file, `# native identity file\r\n\r\n${one}\r\n# another identity\r\n${two}\r\n`);
    fs.chmodSync(file, 0o400);
    const before = fs.statSync(file);
    expect(readAgeIdentities(file)).toEqual([one, two]);
    const result = await (await prepare({ PODAJ_AGE_IDENTITY: file }, home)).save(dummy);
    expect(result.identity).toBe(file);
    expect(await decrypt(result.file, one)).toBe(dummy);
    await expect(decrypt(result.file, two)).rejects.toThrow();
    expect(mode(file)).toBe(0o400);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.existsSync(defaultAgeIdentityPath({}, home))).toBe(false);
  });

  it("recipient override takes priority, creates no private identity, and never reads identity files", async () => {
    const home = scratch();
    const { recipient, identity } = await recipientFixture();
    const invalid = join(home, "invalid-identity");
    writeIdentity(invalid, "must not be opened");
    const read = vi.spyOn(fs, "readFileSync");
    const output = await prepare({ PODAJ_AGE_RECIPIENT: recipient, PODAJ_AGE_IDENTITY: invalid }, home);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    const result = await output.save(dummy);
    expect(result).not.toHaveProperty("identity");
    expect(await decrypt(result.file, identity)).toBe(dummy);
    expect(files(dirname(defaultAgeIdentityPath({}, home)))).toEqual(["inbox"]);
  });

  it("treats an empty recipient override as unset", async () => {
    const home = scratch();
    const output = await prepare({ PODAJ_AGE_RECIPIENT: "" }, home);
    output.close();
    expect(readAgeIdentities(defaultAgeIdentityPath({}, home))).toHaveLength(1);
  });

  it("preserves all arbitrary names, duplicates, order and the complete UTF-8 payload", async () => {
    const home = scratch();
    const keys = ["OUTSIDE_REQUEST", "duplicate", "duplicate", "", "  spaced  ", "x\ny", "秘密", "__proto__"];
    const plaintext = JSON.stringify({ vars: keys.map((key) => ({ key, value: "µ-secret", extra: true })), unexpected: { retained: 1 } });
    const result = await (await prepare({}, home)).save(plaintext);
    expect(result.names).toEqual(keys);
    expect(await decrypt(result.file, readAgeIdentities(result.identity!)[0])).toBe(plaintext);
  });

  it.each(["not json 秘密", "", "null", "[]", '{"other":1}', '{"vars":null}', '{"vars":[{"key":"ok"},{"key":42}]}'])(
    "retains malformed or unrecognized data encrypted: %s", async (plaintext) => {
      const home = scratch();
      const result = await (await prepare({}, home)).save(plaintext);
      expect(result.names).toEqual([]);
      expect(await decrypt(result.file, readAgeIdentities(result.identity!)[0])).toBe(plaintext);
    },
  );

  it.each(["missing", "invalid", "blank", "invalid-second", "directory", "symlink", "dangling", "broad"])(
    "refuses %s explicit identity before save without replacing or repairing it", async (kind) => {
      const home = scratch();
      const file = join(home, "selected");
      const key = await generateX25519Identity();
      if (kind === "invalid") writeIdentity(file, "secret invalid identity sentinel");
      if (kind === "blank") writeIdentity(file, "\n# only comments\n");
      if (kind === "invalid-second") writeIdentity(file, `${key}\ninvalid-secret-key\n`);
      if (kind === "directory") fs.mkdirSync(file);
      if (kind === "symlink" || kind === "dangling") {
        const target = join(home, "target");
        if (kind === "symlink") writeIdentity(target, key);
        fs.symlinkSync(target, file);
      }
      if (kind === "broad") { writeIdentity(file, key); fs.chmodSync(file, 0o644); }
      await expect(prepare({ PODAJ_AGE_IDENTITY: file }, home)).rejects.toMatchObject({ message: `cannot prepare age output with identity file: ${file}` });
      expect(files(inboxAt(home))).toEqual([]);
      expect(fs.existsSync(defaultAgeIdentityPath({}, home))).toBe(false);
      if (kind === "broad") expect(mode(file)).toBe(0o644);
      if (kind === "invalid") expect(fs.readFileSync(file, "utf8")).toBe("secret invalid identity sentinel");
    },
  );

  it("does not replace invalid managed identities or accept a FIFO", async () => {
    const home = scratch();
    const file = defaultAgeIdentityPath({}, home);
    writeIdentity(file, "invalid existing identity");
    await expect(prepare({}, home)).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("invalid existing identity");
    const fifo = join(home, "identity-fifo");
    if (spawnSync("mkfifo", [fifo]).status === 0) expect(() => readAgeIdentities(fifo)).toThrow("cannot read a valid private age identity file");
  });

  it.each(["invalid-recipient-sentinel", "ssh-ed25519 public-key-sentinel", "   "])(
    "rejects malformed/non-native recipient without echoing it or loading an identity", async (recipient) => {
      const home = scratch();
      await expect(prepare({ PODAJ_AGE_RECIPIENT: recipient }, home)).rejects.toMatchObject({ message: "cannot prepare age output: invalid recipient or unsafe data directory" });
      expect(fs.existsSync(defaultAgeIdentityPath({}, home))).toBe(false);
      expect(files(inboxAt(home))).toEqual([]);
    },
  );

  it.each([".local", ".local/share", ".local/share/podaj", ".local/share/podaj/inbox"])(
    "rejects managed directory symlinks at %s", async (component) => {
      const home = scratch();
      const target = join(home, "target");
      fs.mkdirSync(target, { mode: 0o700 });
      const link = join(home, component);
      fs.mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
      fs.symlinkSync(target, link);
      const { recipient } = await recipientFixture();
      await expect(prepare({ PODAJ_AGE_RECIPIENT: recipient }, home)).rejects.toThrow();
      expect(files(target)).toEqual([]);
    },
  );

  it("rejects a symlink XDG data directory", async () => {
    const home = scratch();
    const target = join(home, "target");
    fs.mkdirSync(target);
    const link = join(home, "xdg");
    fs.symlinkSync(target, link);
    await expect(prepare({ XDG_DATA_HOME: link }, home)).rejects.toThrow();
    expect(files(target)).toEqual([]);
  });

  it("checks the opened identity's ownership and uses O_NOFOLLOW", async () => {
    const home = scratch();
    const file = join(home, "identity");
    writeIdentity(file, await generateX25519Identity());
    const actual = fs.fstatSync;
    const open = vi.spyOn(fs, "openSync");
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const metadata = actual(fd);
      return Object.assign(metadata, { uid: metadata.uid + 1 });
    }) as typeof fs.fstatSync);
    expect(() => readAgeIdentities(file)).toThrow();
    expect(open.mock.calls[0][1]).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  });

  it("rejects wrong-owner private directories", async () => {
    const home = scratch();
    const { recipient } = await recipientFixture();
    const actual = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => Object.assign(actual(fd), { uid: 987_654 })) as typeof fs.fstatSync);
    await expect(prepare({ PODAJ_AGE_RECIPIENT: recipient }, home)).rejects.toThrow();
  });

  it("accepts the temporary hard-link count during atomic identity publication", async () => {
    const home = scratch();
    const file = defaultAgeIdentityPath({}, home);
    writeIdentity(file, await generateX25519Identity());
    fs.linkSync(file, join(dirname(file), "still-publishing.tmp"));
    expect(fs.statSync(file).nlink).toBe(2);
    const result = await (await prepare({}, home)).save(dummy);
    expect(await decrypt(result.file, readAgeIdentities(file)[0])).toBe(dummy);
  });

  it("concurrent first-use processes reuse the same fully published identity", async () => {
    const home = scratch();
    const source = resolve("scripts/age-output.ts");
    const script = `import { prepareAgeOutput, readAgeIdentities } from ${JSON.stringify(source)};
      import { createHash } from 'node:crypto';
      const output = await prepareAgeOutput({}, process.argv[1]);
      const saved = await output.save('dummy concurrent data');
      output.close();
      console.log(JSON.stringify({ file: saved.file, hash: createHash('sha256').update(readAgeIdentities(saved.identity)[0]).digest('hex') }));`;
    const run = () => new Promise<{ file: string; hash: string }>((resolveResult, reject) => {
      const child = spawn("bun", ["--eval", script, home], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data.toString(); });
      child.stderr.on("data", (data) => { stderr += data.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0 || stderr !== "") reject(new Error(`initializer failed (${code})`));
        else { try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error("invalid initializer result")); } }
      });
    });
    const results = await Promise.all(Array.from({ length: 5 }, run));
    expect(new Set(results.map((result) => result.hash)).size).toBe(1);
    const identity = readAgeIdentities(defaultAgeIdentityPath({}, home))[0];
    for (const result of results) expect(await decrypt(result.file, identity)).toBe("dummy concurrent data");
    expect(files(dirname(defaultAgeIdentityPath({}, home)))).toEqual(["age-identity.txt", "inbox"]);
  }, 20_000);

  it.each(["write", "fsync", "link"])("cleans unpublished identity temps after %s failure", async (stage) => {
    const home = scratch();
    if (stage === "write") vi.spyOn(fs, "writeSync").mockImplementationOnce(() => { throw fault(); });
    if (stage === "fsync") vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw fault(); });
    if (stage === "link") vi.spyOn(fs, "linkSync").mockImplementationOnce(() => { throw fault(); });
    const file = defaultAgeIdentityPath({}, home);
    await expect(prepare({}, home)).rejects.toMatchObject({ message: `cannot prepare age output with identity file: ${file}` });
    expect(files(dirname(file))).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never replaces a concurrently published winner", async () => {
    const home = scratch();
    const winner = await generateX25519Identity();
    const actual = fs.linkSync;
    const file = defaultAgeIdentityPath({}, home);
    vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
      if (target === file) writeIdentity(file, `${winner}\n`);
      actual(source, target);
    });
    const result = await (await prepare({}, home)).save(dummy);
    expect(readAgeIdentities(file)).toEqual([winner]);
    expect(await decrypt(result.file, winner)).toBe(dummy);
    expect(files(dirname(file))).toEqual(["age-identity.txt", "inbox"]);
  });

  it("reserves an exclusive output before returning; temp collisions never overwrite", async () => {
    const home = scratch();
    const { recipient } = await recipientFixture();
    const output = await prepare({ PODAJ_AGE_RECIPIENT: recipient }, home);
    const temporary = join(inboxAt(home), files(inboxAt(home))[0]);
    fs.writeFileSync(temporary, "existing ciphertext sentinel");
    const actual = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((path, flags, permissions) =>
      actual(String(path).endsWith(".age.tmp") ? temporary : path, flags, permissions));
    await expect(prepare({ PODAJ_AGE_RECIPIENT: recipient }, home)).rejects.toThrow("cannot reserve");
    expect(fs.readFileSync(temporary, "utf8")).toBe("existing ciphertext sentinel");
    output.close();
  });

  it("final collisions never overwrite and retain a decryptable recovery artifact", async () => {
    const home = scratch();
    const { recipient, identity } = await recipientFixture();
    const output = await prepare({ PODAJ_AGE_RECIPIENT: recipient }, home);
    const [temporaryName] = files(inboxAt(home));
    const temporary = join(inboxAt(home), temporaryName);
    const final = join(inboxAt(home), temporaryName.slice(1, -4));
    fs.writeFileSync(final, "existing ciphertext", { mode: 0o600 });
    await expect(output.save(dummy)).rejects.toThrow(`encrypted recovery file: ${temporary}`);
    output.close();
    expect(fs.readFileSync(final, "utf8")).toBe("existing ciphertext");
    expect(await decrypt(temporary, identity)).toBe(dummy);
  });

  it("cleans abandoned output and rejects saves after close or after first use", async () => {
    const home = scratch();
    const output = await prepare({}, home);
    output.close(); output.close();
    expect(files(inboxAt(home))).toEqual([]);
    await expect(output.save(dummy)).rejects.toThrow("closed or has already been used");
    const used = await prepare({}, home);
    const result = await used.save(dummy);
    await expect(used.save("second plaintext")).rejects.toThrow("closed or has already been used");
    used.close();
    expect(fs.existsSync(result.file)).toBe(true);
  });

  it("does not write after close interrupts asynchronous encryption", async () => {
    const home = scratch();
    const output = await prepare({}, home);
    const saving = output.save(dummy);
    output.close();
    await expect(saving).rejects.toThrow("could not save encrypted handoff");
    expect(files(inboxAt(home))).toEqual([]);
  });

  it("handles short writes without losing any ciphertext", async () => {
    const home = scratch();
    const output = await prepare({}, home);
    const actual = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Uint8Array, offset: number, length: number) =>
      actual(fd, bytes, offset, Math.min(length, 7))) as typeof fs.writeSync);
    const result = await output.save(dummy);
    expect(await decrypt(result.file, readAgeIdentities(result.identity!)[0])).toBe(dummy);
  });

  it.each(["throw", "zero"])("cleans incomplete output on %s write failure and sanitizes diagnostics", async (kind) => {
    const home = scratch();
    const output = await prepare({}, home);
    const actual = fs.writeSync;
    let first = true;
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Uint8Array, offset: number, length: number) => {
      if (first) { first = false; return actual(fd, bytes, offset, Math.min(length, 10)); }
      if (kind === "zero") return 0;
      throw fault();
    }) as typeof fs.writeSync);
    await expect(output.save(dummy)).rejects.toThrow(/^could not save encrypted handoff$/u);
    output.close();
    expect(files(inboxAt(home))).toEqual([]);
  });

  it.each(["fsync", "close", "link", "directory-fsync", "unlink"])(
    "preserves complete ciphertext after %s finalization failure, even after close", async (stage) => {
      const home = scratch();
      const { recipient, identity } = await recipientFixture();
      const output = await prepare({ PODAJ_AGE_RECIPIENT: recipient }, home);
      const [name] = files(inboxAt(home));
      const temporary = join(inboxAt(home), name);
      const final = join(inboxAt(home), name.slice(1, -4));
      if (stage === "fsync") vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw fault(); });
      if (stage === "close") vi.spyOn(fs, "closeSync").mockImplementationOnce(() => { throw fault(); });
      if (stage === "link") vi.spyOn(fs, "linkSync").mockImplementationOnce(() => { throw fault(); });
      if (stage === "directory-fsync") {
        const actual = fs.fsyncSync;
        vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { if (fs.fstatSync(fd).isDirectory()) throw fault(); actual(fd); });
      }
      if (stage === "unlink") vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw fault(); });
      const recovery = stage === "directory-fsync" || stage === "unlink" ? final : temporary;
      await expect(output.save(dummy)).rejects.toThrow(`could not finalize encrypted handoff; encrypted recovery file: ${recovery}`);
      output.close();
      expect(await decrypt(recovery, identity)).toBe(dummy);
      expect(mode(recovery)).toBe(0o600);
    },
  );

  it("writes only ciphertext and emits nothing on successful save", async () => {
    const home = scratch();
    const output = await prepare({}, home);
    const key = readAgeIdentities(defaultAgeIdentityPath({}, home))[0];
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const writes = vi.spyOn(fs, "writeSync");
    const result = await output.save(dummy);
    const stdoutCalls = stdout.mock.calls.slice();
    const stderrCalls = stderr.mock.calls.slice();
    const chunks = writes.mock.calls.map((call) => call[1]);
    stdout.mockRestore(); stderr.mockRestore(); writes.mockRestore();
    expect(stdoutCalls).toEqual([]);
    expect(stderrCalls).toEqual([]);
    expect(chunks).toHaveLength(1);
    const ciphertext = fs.readFileSync(result.file);
    expect(chunks[0]).toEqual(new Uint8Array(ciphertext));
    expect(ciphertext.includes(Buffer.from("never-store-this-plaintext"))).toBe(false);
    expect(ciphertext.includes(Buffer.from(key))).toBe(false);
    expect(await decrypt(result.file, key)).toBe(dummy);
  });

  it("sanitizes arbitrary encryption errors and emits no plaintext, key, or recipient diagnostics", async () => {
    const home = scratch();
    const output = await prepare({}, home);
    const identity = readAgeIdentities(defaultAgeIdentityPath({}, home))[0];
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    vi.spyOn(Encrypter.prototype, "encrypt").mockRejectedValueOnce(new Error(`${dummy} ${identity}`));
    let message = "";
    try { await output.save(dummy); } catch (error) { message = String(error); }
    const outCalls = stdout.mock.calls.slice();
    const errCalls = stderr.mock.calls.slice();
    stdout.mockRestore(); stderr.mockRestore();
    expect(message).toBe("Error: could not save encrypted handoff");
    expect(outCalls).toEqual([]);
    expect(errCalls).toEqual([]);
    expect(files(inboxAt(home))).toEqual([]);
    expect(fs.readFileSync(defaultAgeIdentityPath({}, home), "utf8")).not.toContain("never-store-this-plaintext");
  });

  it("sanitizes prepare-time crypto errors before handing back an output", async () => {
    const home = scratch();
    const { recipient } = await recipientFixture();
    vi.spyOn(Encrypter.prototype, "encrypt").mockRejectedValueOnce(fault());
    await expect(prepare({ PODAJ_AGE_RECIPIENT: recipient }, home)).rejects.toThrow(/^cannot prepare age output: invalid recipient or unsafe data directory$/u);
    expect(files(inboxAt(home))).toEqual([]);
  });

  const nativeAvailable = spawnSync("age", ["--version"]).status === 0 && spawnSync("age-keygen", ["--version"]).status === 0;
  it.skipIf(!nativeAvailable)("interoperates with native age CLI using dummy keys and stdin/files only", async () => {
    const home = scratch();
    const nativeIdentity = join(home, "native-identity.txt");
    const keygen = spawnSync("age-keygen", ["-o", nativeIdentity], { encoding: "utf8" });
    expect(keygen.status).toBe(0);
    fs.chmodSync(nativeIdentity, 0o600);
    const output = await prepare({ PODAJ_AGE_IDENTITY: nativeIdentity }, home);
    const result = await output.save(dummy);
    const decrypted = spawnSync("age", ["--decrypt", "-i", nativeIdentity], { input: fs.readFileSync(result.file), encoding: "utf8" });
    expect(decrypted.status).toBe(0);
    expect(decrypted.stdout).toBe(dummy);
    const recipientFile = join(home, "recipients.txt");
    fs.writeFileSync(recipientFile, `${await identityToRecipient(readAgeIdentities(nativeIdentity)[0])}\n`);
    const encrypted = spawnSync("age", ["-R", recipientFile], { input: dummy });
    expect(encrypted.status).toBe(0);
    const decrypter = new Decrypter();
    decrypter.addIdentity(readAgeIdentities(nativeIdentity)[0]);
    expect(await decrypter.decrypt(encrypted.stdout, "text")).toBe(dummy);
  });
});
