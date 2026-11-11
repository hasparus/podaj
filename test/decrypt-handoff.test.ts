import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { armor, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgeIdentityPath } from "../scripts/age-output.js";

const exec = promisify(execFile);
const homes: string[] = [];
const payload = { vars: [{ key: "a label, not a shell name 🔑", value: "synthetic-explicit-decryption" }] };
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "podaj-decrypt-"));
  homes.push(home);
  const identity = await generateX25519Identity();
  const identityFile = defaultAgeIdentityPath({}, home);
  await mkdir(dirname(identityFile), { recursive: true, mode: 0o700 });
  await writeFile(identityFile, `# A standard age identity file\n${identity}\n`, { mode: 0o600 });
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(identity));
  const ciphertext = await encrypter.encrypt(JSON.stringify(payload));
  const file = join(home, "received.age");
  await writeFile(file, ciphertext, { mode: 0o600 });
  const run = (args: string[], input?: Uint8Array | string, env: NodeJS.ProcessEnv = {}) => {
    const result = exec(process.execPath, [resolve("dist/scripts/podaj.js"), "decrypt", ...args], {
      env: { HOME: home, PATH: "/nonexistent", ...env }, timeout: 10_000,
    });
    result.child.stdin?.end(input);
    return result;
  };
  return { home, file, ciphertext, identityFile, identity, run };
};
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

describe("explicit CLI age decryption", () => {
  it.each(["file", "stdin", "armor"] as const)("decrypts %s with the managed identity without external executables", async (format) => {
    const instance = await fixture();
    const result = format === "file" ? await instance.run([instance.file])
      : await instance.run([], format === "armor" ? armor.encode(instance.ciphertext) : instance.ciphertext);
    expect(JSON.parse(result.stdout)).toEqual(payload);
    expect(result.stderr).toBe("");
  });

  it("accepts an explicit identity without consulting the default home identity", async () => {
    const instance = await fixture();
    const result = await instance.run(["--identity", instance.identityFile, instance.file], undefined, { HOME: join(instance.home, "other") });
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  it("uses PODAJ_AGE_IDENTITY for decryption even when an encryption recipient is configured", async () => {
    const instance = await fixture();
    const result = await instance.run([instance.file], undefined, {
      HOME: join(instance.home, "other"), PODAJ_AGE_IDENTITY: instance.identityFile, PODAJ_AGE_RECIPIENT: "not-used-for-decryption",
    });
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  it("rejects a wrong identity without exposing values or private keys", async () => {
    const instance = await fixture();
    const wrong = join(instance.home, "wrong.agekey");
    await writeFile(wrong, `${await generateX25519Identity()}\n`, { mode: 0o600 });
    await expect(instance.run([instance.file, "--identity", wrong])).rejects.toMatchObject({
      code: 1, stdout: "", stderr: "Could not decrypt this age file with the selected identity.\n",
    });
  });

  it("rejects tampered ciphertext without partial plaintext output", async () => {
    const instance = await fixture();
    const bytes = await readFile(instance.file);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(instance.file, bytes);
    await expect(instance.run([instance.file])).rejects.toMatchObject({ code: 1, stdout: "" });
  });

  it.each([["--identity"], ["--unknown"], ["one.age", "two.age"], ["--identity", "a", "--identity", "b"]].map((args) => ({ args })))("rejects invalid decrypt arguments $args", async ({ args }) => {
    const instance = await fixture();
    await expect(instance.run(args)).rejects.toMatchObject({ code: 1, stdout: "" });
  });
});
