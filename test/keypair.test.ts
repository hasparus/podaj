import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureKeypair,
  generateKeypair,
  joinPrivate,
  joinPublic,
  validateKeypair,
} from "../scripts/keypair.js";

const fixture = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

const pair = fixture();
const otherPair = fixture();
const scratchDirs: string[] = [];

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "podaj-keypair-"));
  scratchDirs.push(dir);
  return dir;
};

const writePair = async (dir: string) => {
  await writeFile(joinPrivate(dir), pair.privateKey, { mode: 0o600 });
  await writeFile(joinPublic(dir), pair.publicKey);
};

const snapshot = async (path: string) => {
  const contents = await readFile(path, "utf8");
  const metadata = await stat(path);
  return {
    contents,
    inode: metadata.ino,
    mode: metadata.mode,
    modified: metadata.mtimeMs,
  };
};

const snapshotPair = (dir: string) =>
  Promise.all([snapshot(joinPrivate(dir)), snapshot(joinPublic(dir))]);

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("local recipient keypairs", () => {
  it("validates without creating missing keys or directories", async () => {
    const dir = join(await scratch(), "missing");
    await expect(validateKeypair(dir)).rejects.toThrow(/both public.pem and private.pem/u);
    await expect(lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a new pair only when neither key exists", async () => {
    const dir = join(await scratch(), "keys");
    await expect(ensureKeypair(dir)).resolves.toBe(dir);
    await expect(validateKeypair(dir)).resolves.toBe(dir);
    expect((await stat(joinPrivate(dir))).mode & 0o777).toBe(0o600);
    expect((await readFile(joinPublic(dir), "utf8")).startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
  }, 30_000);

  it("reuses a valid pair without rewriting either file or its permissions", async () => {
    const dir = await scratch();
    await writePair(dir);
    const before = await snapshotPair(dir);
    await expect(validateKeypair(dir)).resolves.toBe(dir);
    await expect(ensureKeypair(dir)).resolves.toBe(dir);
    await expect(ensureKeypair(dir)).resolves.toBe(dir);
    expect(await snapshotPair(dir)).toEqual(before);
  });

  it.each(["private", "public"] as const)(
    "refuses a %s-only pair without modifying it or creating its counterpart",
    async (present) => {
      const dir = await scratch();
      const existing = present === "private" ? joinPrivate(dir) : joinPublic(dir);
      const missing = present === "private" ? joinPublic(dir) : joinPrivate(dir);
      await writeFile(existing, present === "private" ? pair.privateKey : pair.publicKey);
      const before = await snapshot(existing);
      await expect(validateKeypair(dir)).rejects.toThrow(/both public.pem and private.pem/u);
      await expect(ensureKeypair(dir)).rejects.toThrow(/both public.pem and private.pem/u);
      await expect(generateKeypair(dir)).rejects.toThrow(/refusing to replace/u);
      expect(await snapshot(existing)).toEqual(before);
      await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["private", "public", "both"] as const)(
    "preserves invalid %s key files and refuses to generate replacements",
    async (invalid) => {
      const dir = await scratch();
      await writePair(dir);
      if (invalid !== "public") {
        await writeFile(joinPrivate(dir), "not a private key");
      }
      if (invalid !== "private") {
        await writeFile(joinPublic(dir), "not a public key");
      }
      const before = await snapshotPair(dir);
      await expect(validateKeypair(dir)).rejects.toThrow(/invalid or mismatched/u);
      await expect(ensureKeypair(dir)).rejects.toThrow(/invalid or mismatched/u);
      await expect(generateKeypair(dir)).rejects.toThrow(/refusing to replace/u);
      expect(await snapshotPair(dir)).toEqual(before);
    },
  );

  it("rejects mismatched keys without replacing either one", async () => {
    const dir = await scratch();
    await writePair(dir);
    await writeFile(joinPublic(dir), otherPair.publicKey);
    const before = await snapshotPair(dir);
    await expect(validateKeypair(dir)).rejects.toThrow(/invalid or mismatched/u);
    await expect(ensureKeypair(dir)).rejects.toThrow(/invalid or mismatched/u);
    expect(await snapshotPair(dir)).toEqual(before);
  });

  it("rejects a matching non-RSA pair without replacing it", async () => {
    const dir = await scratch();
    const ec = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    await writeFile(joinPrivate(dir), ec.privateKey);
    await writeFile(joinPublic(dir), ec.publicKey);
    const before = await snapshotPair(dir);
    await expect(ensureKeypair(dir)).rejects.toThrow(/invalid or mismatched/u);
    expect(await snapshotPair(dir)).toEqual(before);
  });

  it("refuses existing dangling key symlinks instead of following them to create keys", async () => {
    const dir = await scratch();
    const target = join(dir, "missing-target.pem");
    await symlink(target, joinPrivate(dir));
    await expect(ensureKeypair(dir)).rejects.toThrow(/both public.pem and private.pem/u);
    await expect(generateKeypair(dir)).rejects.toThrow(/refusing to replace/u);
    expect((await lstat(joinPrivate(dir))).isSymbolicLink()).toBe(true);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(joinPublic(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("direct generation never overwrites a pair on repeated calls", async () => {
    const dir = await scratch();
    await expect(generateKeypair(dir)).resolves.toBe(dir);
    const before = await snapshotPair(dir);
    await expect(generateKeypair(dir)).rejects.toThrow(/refusing to replace/u);
    await expect(generateKeypair(dir)).rejects.toThrow(/refusing to replace/u);
    expect(await snapshotPair(dir)).toEqual(before);
    await expect(validateKeypair(dir)).resolves.toBe(dir);
  }, 30_000);

  it("allows only one concurrent generator to claim the private key", async () => {
    const dir = await scratch();
    const results = await Promise.allSettled([
      generateKeypair(dir),
      generateKeypair(dir),
      generateKeypair(dir),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    await expect(validateKeypair(dir)).resolves.toBe(dir);
    const before = await snapshotPair(dir);
    await expect(generateKeypair(dir)).rejects.toThrow();
    await expect(ensureKeypair(dir)).resolves.toBe(dir);
    expect(await snapshotPair(dir)).toEqual(before);
  }, 30_000);
});
