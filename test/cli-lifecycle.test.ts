import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect, Option } from "effect";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import type { ReceivedHandoff } from "../scripts/age-output.js";
import { defaultAgeIdentityPath } from "../scripts/age-output.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { admissionProofData, approveAdmission, waitForReservation } from "../src/client/admission.js";
import { init, Message, update, type Model } from "../src/client/app.js";
import { parseAppRoute } from "../src/client/parse-route.js";
import { loadRequestContext, parseContextLink } from "../src/client/request-context.js";
import { openRequestContext } from "../src/crypto/request-context.js";
import { seal } from "../src/crypto/podaj1.js";
import { recipientIdentity } from "../scripts/instance.js";
import { nativeRuntime, OWNER, type NativeRuntime } from "./helpers/native-runtime.js";
import { malformedServer, type Malformation } from "./helpers/malformed-server.js";

const exec = promisify(execFile);
const pair = () => generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const existingPair = pair();
const otherPair = pair();
let privateRuntime: NativeRuntime;
let demoRuntime: NativeRuntime;
const cleanups: (() => Promise<unknown>)[] = [];
type ExistingKeys = "none" | "valid" | "mismatch" | "invalid" | "private-only";

beforeAll(async () => {
  [privateRuntime, demoRuntime] = await Promise.all([nativeRuntime(false), nativeRuntime(true)]);
}, 30_000);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});
afterAll(async () => { await Promise.all([privateRuntime?.runtime.dispose(), demoRuntime?.runtime.dispose()]); });

const setup = async (runtime = privateRuntime, existingKeys: ExistingKeys = "none") => {
  await runtime.reset();
  const home = await mkdtemp(join(tmpdir(), "podaj-cli-lifecycle-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const keysDir = join(home, "keys");
  const configDir = join(home, "config");
  if (existingKeys !== "none") {
    await mkdir(keysDir);
    await writeFile(join(keysDir, "private.pem"), existingKeys === "invalid" ? "not a key" : existingPair.privateKey, { mode: 0o600 });
    if (existingKeys !== "private-only") {
      await writeFile(join(keysDir, "public.pem"), existingKeys === "invalid" ? "not a key" : existingKeys === "mismatch" ? otherPair.publicKey : existingPair.publicKey);
    }
  }
  vi.stubGlobal("fetch", (input: string | URL | Request, options?: RequestInit) =>
    runtime.request(input instanceof Request ? input.url : String(input), options));
  const run = (args: string[], token = runtime === demoRuntime ? "" : OWNER, stdin = "", env: NodeJS.ProcessEnv = {}) => {
    let stdout = "";
    let stderr = "";
    const result = exec(process.execPath, [resolve("dist/scripts/podaj.js"), ...args], {
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: configDir, PODAJ_KEY_DIR: keysDir, PODAJ_URL: runtime.origin, PODAJ_API_AUTH_SECRET: token, ...env },
      timeout: 20_000,
    });
    void result.catch(() => undefined);
    result.child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    result.child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    result.child.stdin?.end(stdin);
    cleanups.push(async () => { result.child.kill(); await result.catch(() => undefined); });
    return {
      result, child: result.child, stdout: () => stdout, stderr: () => stderr,
      link: async (path: "/s/") => {
        let line: string | undefined;
        await vi.waitFor(() => {
          line = stderr.split("\n").find((value) => value.startsWith(`${runtime.origin}${path}`));
          expect(line, stderr).toBeDefined();
        }, { timeout: 5000 });
        return new URL(line!);
      },
    };
  };
  return { runtime, run, home, keysDir, configDir, configFile: join(configDir, "podaj", "config.json") };
};
type CliRun = ReturnType<Awaited<ReturnType<typeof setup>>["run"]>;

const fill = async (runtime: NativeRuntime, cli: CliRun, pasted = "API_KEY=synthetic-env-value\nOTHER=not-requested\n", browserUrl?: URL) => {
  const link = browserUrl ?? await cli.link("/s/");
  const parsed = parseContextLink(link.pathname, link.hash);
  if (parsed === null) throw new Error("missing short request context link");
  const context = await loadRequestContext(parsed);
  const initial = init(parseAppRoute(link.pathname, link.hash));
  const requestedKeys = context.requestedKeys;
  for (const request of await runtime.requests()) {
    for (const key of requestedKeys) expect(request.body).not.toContain(key);
  }
  let model: Model = initial.model;
  for (const command of initial.commands ?? []) model = update(model, await Effect.runPromise(command.effect)).model;
  expect(Option.isSome(model.sender)).toBe(true);
  if (requestedKeys.length > 0) {
    expect(model.rows.map((row) => row.key)).toEqual(requestedKeys);
    expect(model.rows.every((row) => row.value === "")).toBe(true);
  }
  const edited = update(model, Message.PastedEnv({ text: pasted }));
  expect(edited.commands ?? []).toHaveLength(0);
  let filled = edited.model;
  for (const row of filled.rows.filter((candidate) => candidate.key.length > 0 && candidate.value.length === 0)) {
    filled = update(filled, Message.ClickedRemoveRow({ rowId: row.id })).model;
  }
  await vi.waitFor(async () => { expect((await runtime.snapshot()).sockets).toHaveLength(1); });
  expect((await runtime.snapshot()).handoffs).toMatchObject([{ state: "pending", sealed: null }]);
  expect((await runtime.requests()).filter((request) => request.method === "PUT" || request.path.endsWith("/consume"))).toEqual([]);
  expect(cli.stdout()).toBe("");
  expect(cli.child.exitCode).toBeNull();
  const submitted = update(filled, Message.ClickedSend());
  expect(submitted.commands).toHaveLength(1);
  const command = submitted.commands?.[0];
  if (!command) throw new Error("send command missing");
  const sent = await Effect.runPromise(command.effect);
  expect(sent._tag).toBe("SucceededSend");
  expect(update(submitted.model, sent).model.sent).toBe(true);
  return link;
};
const openReceipt = async (receipt: ReceivedHandoff, identity = receipt.identity) => {
  if (identity === undefined) throw new Error("test requires a decryption identity");
  const decrypted = await exec(process.execPath, [resolve("dist/scripts/podaj.js"), "decrypt", "--identity", identity, receipt.file], {
    env: { PATH: process.env.PATH }, timeout: 10_000,
  });
  expect(decrypted.stderr).toBe("");
  return JSON.parse(decrypted.stdout) as { vars: { key: string; value: string }[] };
};
const complete = async (runtime: NativeRuntime, cli: CliRun, expected: Record<string, string> = { API_KEY: "synthetic-env-value", OTHER: "not-requested" }, pasted?: string, browserUrl?: URL) => {
  const link = await fill(runtime, cli, pasted, browserUrl);
  const output = await cli.result;
  const received = JSON.parse(output.stdout) as ReceivedHandoff;
  expect(received.names).toEqual(Object.keys(expected));
  expect(received.file.endsWith(".age")).toBe(true);
  expect((await stat(received.file)).mode & 0o777).toBe(0o600);
  const ciphertext = await readFile(received.file);
  expect(ciphertext.toString().startsWith("age-encryption.org/v1\n")).toBe(true);
  for (const value of Object.values(expected)) {
    expect(`${output.stdout}${output.stderr}`).not.toContain(value);
    expect(ciphertext.includes(Buffer.from(value))).toBe(false);
  }
  expect(await openReceipt(received)).toEqual({ vars: Object.entries(expected).map(([key, value]) => ({ key, value })) });
  expect((await runtime.snapshot()).handoffs).toMatchObject([{ state: "consumed", sealed: null }]);
  const requests = await runtime.requests();
  const parsed = parseContextLink(link.pathname, link.hash)!;
  expect(link.search).toBe("");
  expect(link.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/u);
  expect(link.href.length).toBe(runtime.origin.length + 79);
  expect(output.stderr.split("\n").filter((line) => /^https?:\/\//u.test(line))).toEqual([link.href]);
  const staged = requests.filter((request) => request.path === "/api/contexts");
  expect(staged).toHaveLength(1);
  const stageBody = JSON.parse(staged[0].body) as { id: string; writeHash: string; encryptedContext: string };
  expect(Object.keys(stageBody)).toEqual(["id", "writeHash", "encryptedContext"]);
  const context = await openRequestContext(parsed.id, parsed.key, stageBody.encryptedContext);
  expect(stageBody.id).toBe(parsed.id);
  expect(stageBody.writeHash).toBe(createHash("sha256").update(context.writeToken).digest("hex"));
  expect(stageBody.encryptedContext).toMatch(/^[A-Za-z0-9_-]+$/u);
  expect(staged[0].body).not.toContain(context.recipientPublicKey);
  expect(staged[0].body).not.toContain(recipientIdentity(context.recipientPublicKey).encoded);
  expect(staged[0].body).not.toContain(context.writeToken);
  for (const request of requests) {
    expect(JSON.stringify(request)).not.toContain(parsed.key);
    expect(JSON.stringify(request)).not.toContain("PRIVATE KEY");
  }
  expect(JSON.stringify((await runtime.snapshot()).contexts)).not.toContain(parsed.key);
  const uploads = requests.filter((request) => request.method === "PUT");
  expect(uploads).toHaveLength(1);
  expect(Object.keys(JSON.parse(uploads[0].body))).toEqual(["sealed"]);
  expect(uploads[0].body).not.toContain("API_KEY");
  expect(uploads[0].body).not.toContain("synthetic-env-value");
  expect(requests.filter((request) => request.path.endsWith("/consume"))).toHaveLength(1);
  for (const request of requests) {
    for (const key of received.names) expect(request.body).not.toContain(key);
  }
  return { ...output, received, link, requests, context };
};

describe("compiled CLI → production human gates → Worker/SQLite/native WS → CLI", () => {
  it("connects without recipient files, token output, recipient fetch or request creation", async () => {
    const instance = await setup();
    const { stdout, stderr } = await instance.run(["config", "--url", instance.runtime.origin, "--token", OWNER]).result;
    expect(`${stdout}${stderr}`).not.toContain(OWNER);
    expect(JSON.parse(stdout)).toEqual({ url: instance.runtime.origin, config: instance.configFile });
    expect(JSON.parse(await readFile(instance.configFile, "utf8"))).toEqual({ token: OWNER, url: instance.runtime.origin });
    expect((await instance.runtime.requests()).map((request) => request.path)).toEqual(["/api/config", "/api/access"]);
    expect(existsSync(instance.keysDir)).toBe(false);
  });

  it("does not send a saved owner credential to a different PODAJ_URL origin", async () => {
    const instance = await setup();
    await mkdir(join(instance.configDir, "podaj"), { recursive: true });
    await writeFile(instance.configFile, JSON.stringify({ url: "https://original-instance.test", token: OWNER }), { mode: 0o600 });
    await expect(instance.run(["wait", "API_KEY"], "").result).rejects.toMatchObject({ code: 1, stdout: "" });
    expect((await instance.runtime.requests()).every((request) => request.authorization === null)).toBe(true);
    expect((await instance.runtime.snapshot()).handoffs).toHaveLength(0);
  });

  it("config connects to a public instance without generating keys or requesting browser approval", async () => {
    const instance = await setup(demoRuntime);
    const { stdout, stderr } = await instance.run(["config", "--url", instance.runtime.origin]).result;
    expect(JSON.parse(stdout)).toEqual({ url: instance.runtime.origin, config: instance.configFile });
    expect(stderr).toBe("");
    expect(existsSync(instance.keysDir)).toBe(false);
    expect((await instance.runtime.requests()).map((request) => request.path)).toEqual(["/api/config", "/api/access"]);
    expect(JSON.parse(await readFile(instance.configFile, "utf8"))).toEqual({ token: "", url: instance.runtime.origin });
  });

  it("refuses private config without owner auth", async () => {
    const instance = await setup();
    await expect(instance.run(["config", "--url", instance.runtime.origin], "").result).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(existsSync(instance.configFile)).toBe(false);
    expect(existsSync(instance.keysDir)).toBe(false);
  });

  it.each(["valid", "mismatch", "invalid", "private-only"] as const)("preserves existing %s key files during config and explicitly sent handoff", async (existingKeys) => {
    const instance = await setup(privateRuntime, existingKeys);
    const snapshot = async () => Promise.all((await readdir(instance.keysDir)).sort().map(async (name) => {
      const path = join(instance.keysDir, name);
      const metadata = await stat(path);
      return { name, content: await readFile(path, "utf8"), mode: metadata.mode, inode: metadata.ino, modified: metadata.mtimeMs };
    }));
    const before = await snapshot();
    await instance.run(["config", "--url", instance.runtime.origin, "--token", OWNER]).result;
    const { requests } = await complete(privateRuntime, instance.run(["wait", "API_KEY"]));
    expect(await snapshot()).toEqual(before);
    const publicPem = JSON.parse(requests.find((request) => request.path === "/api/handoffs/reserve")!.body).recipientPublicKey;
    expect(publicPem).not.toBe(existingPair.publicKey);
    expect(publicPem).not.toBe(otherPair.publicKey);
  });

  it("rejects blank key names before any network work or local writes", async () => {
    const instance = await setup();
    await expect(instance.run(["wait", "   "]).result).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await instance.runtime.requests()).toEqual([]);
    expect(await readdir(instance.home)).toEqual([]);
  });

  it("accepts punctuation and sentence labels as requested keys", async () => {
    const instance = await setup();
    const labels = { "service-token": "synthetic-one", "the key I use for this service": "synthetic-two" };
    const pasted = Object.entries(labels).map(([key, value]) => `${key}=${value}`).join("\n");
    const { received } = await complete(privateRuntime, instance.run(["wait", ...Object.keys(labels)]), labels, pasted);
    expect(received.names).toEqual(Object.keys(labels));
  });

  it("preserves differently named values even when none of the requested labels match", async () => {
    const instance = await setup();
    const labels = { "the key I use for this service": "synthetic-mismatched-name", "żółw 🔑": "synthetic-extra-value" };
    await complete(privateRuntime, instance.run(["wait", "API_KEY"]), labels,
      Object.entries(labels).map(([key, value]) => `${key}=${value}`).join("\n"));
  });

  it("validates a configured age identity before network work or a fill link", async () => {
    const instance = await setup();
    await expect(instance.run(["wait", "API_KEY"], OWNER, "", { PODAJ_AGE_IDENTITY: join(instance.home, "missing.agekey") }).result)
      .rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await instance.runtime.requests()).toEqual([]);
    expect((await instance.runtime.snapshot()).handoffs).toEqual([]);
  });

  it("encrypts to an explicitly configured recipient without creating a managed identity", async () => {
    const instance = await setup();
    const identity = await generateX25519Identity();
    const identityFile = join(instance.home, "existing.agekey");
    await writeFile(identityFile, `${identity}\n`, { mode: 0o600 });
    const cli = instance.run(["wait", "API_KEY"], OWNER, "", { PODAJ_AGE_RECIPIENT: await identityToRecipient(identity) });
    await fill(privateRuntime, cli, "a different label=synthetic-custom-recipient");
    const { stdout, stderr } = await cli.result;
    const received = JSON.parse(stdout) as ReceivedHandoff;
    expect(received.names).toEqual(["a different label"]);
    expect(received.identity).toBeUndefined();
    expect(`${stdout}${stderr}`).not.toContain(identity);
    expect(`${stdout}${stderr}`).not.toContain("synthetic-custom-recipient");
    expect(existsSync(defaultAgeIdentityPath({}, instance.home))).toBe(false);
    expect(await openReceipt(received, identityFile)).toEqual({ vars: [{ key: "a different label", value: "synthetic-custom-recipient" }] });
  });

  it("uses fresh memory-only transport keys, scoped capabilities and native readiness only after explicit send", async () => {
    const instance = await setup();
    const publicKeys: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await privateRuntime.reset();
      const { stdout, stderr, link, requests, context } = await complete(privateRuntime, instance.run(["wait", " API_KEY ", "API_KEY"]));
      expect(`${stdout}${stderr}`).not.toContain(OWNER);
      expect(stderr).not.toContain("PRIVATE KEY");
      expect(existsSync(instance.keysDir)).toBe(false);
      expect(requests.find((request) => request.path === "/api/contexts")?.authorization).toBe(`Bearer ${OWNER}`);
      const publicPem: string = JSON.parse(requests.find((request) => request.path === "/api/handoffs/reserve")!.body).recipientPublicKey;
      publicKeys.push(publicPem);
      expect(createPublicKey(publicPem).asymmetricKeyDetails?.modulusLength).toBe(2048);
      expect(context.requestedKeys).toEqual(["API_KEY"]);
      expect(context.recipientPublicKey).toBe(publicPem);
      expect(context.challenge).toBeUndefined();
      const writeAuth = requests.find((request) => request.method === "PUT")!.authorization;
      const subscribeAuth = requests.find((request) => request.path.startsWith("/parties/"))!.authorization;
      const readAuth = requests.find((request) => request.path.endsWith("/consume"))!.authorization;
      expect(new Set([writeAuth, subscribeAuth, readAuth]).size).toBe(3);
      expect(writeAuth).toBe(`Bearer ${context.writeToken}`);
      for (const capability of [subscribeAuth, readAuth]) expect(stderr).not.toContain(capability!.slice(7));
      expect(requests.some((request) => request.path.endsWith("/status"))).toBe(false);
      expect(stderr.split("\n").slice(0, 2)).toEqual(["fill in the values and click send:", link.href]);
      expect(stderr).not.toContain("API_KEY");
      const identity = defaultAgeIdentityPath({}, instance.home);
      expect((await stat(identity)).mode & 0o777).toBe(0o600);
      expect((await readdir(join(instance.home, ".local/share/podaj/inbox"))).every((file) => file.endsWith(".age"))).toBe(true);
    }
    expect(new Set(publicKeys).size).toBe(2);
  });

  it("returns every explicitly sent variable when no key filter was requested", async () => {
    const instance = await setup();
    await complete(privateRuntime, instance.run(["wait"]), { API_KEY: "synthetic-env-value", OTHER: "not-requested" });
  });

  it("accepts owner auth on stdin without exposing it in output or fill link", async () => {
    const instance = await setup();
    const { stdout, stderr, requests } = await complete(privateRuntime, instance.run(["wait", "API_KEY"], "", `${OWNER}\n`));
    expect(`${stdout}${stderr}`).not.toContain(OWNER);
    expect(requests.find((request) => request.path === "/api/handoffs/reserve")?.authorization).toBe(`Bearer ${OWNER}`);
  });

  it("uses one short public link through production loading, approval, and explicit send with sender authority only", async () => {
    const instance = await setup(demoRuntime);
    const cli = instance.run(["wait", " API_KEY ", "API_KEY"], OWNER);
    const link = await cli.link("/s/");
    const parsed = parseContextLink(link.pathname, link.hash)!;
    const context = await loadRequestContext(parsed);
    if (context.challenge === undefined) throw new Error("missing admission challenge");
    const approval = {
      challenge: context.challenge, recipientPublicKey: context.recipientPublicKey,
      id: parsed.id, writeToken: context.writeToken, requestedKeys: [...context.requestedKeys],
    };
    expect(approval.requestedKeys).toEqual(["API_KEY"]);
    expect(Object.keys(context).sort()).toEqual(["challenge", "recipientPublicKey", "requestedKeys", "version", "writeToken"]);
    const navigate = vi.fn();
    vi.stubGlobal("location", { replace: navigate });
    const loading = init(parseAppRoute(link.pathname, link.hash));
    expect(loading.commands).toHaveLength(1);
    expect(await Effect.runPromise(loading.commands![0].effect)).toEqual(Message.OpenedVerification());
    expect(navigate).toHaveBeenCalledExactlyOnceWith(`/authorize/${parsed.id}#${parsed.key}`);
    const verificationLink = new URL(navigate.mock.calls[0]![0], link.origin);
    expect(await loadRequestContext(parseContextLink(verificationLink.pathname, verificationLink.hash)!)).toEqual(context);
    await vi.waitFor(async () => {
      expect((await demoRuntime.requests()).filter((request) => request.path === "/api/demo/status").length).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });
    const pendingAuth = (await demoRuntime.requests()).find((request) => request.path === "/api/demo/status")!.authorization!;
    const pending = await demoRuntime.request("/api/demo/status", { headers: { Authorization: pendingAuth } });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending" });
    const beforeApproval = await demoRuntime.snapshot();
    expect(beforeApproval.handoffs).toEqual([]);
    expect(beforeApproval.credentials).toEqual([]);
    expect(beforeApproval.contexts).toHaveLength(1);
    expect(cli.child.exitCode).toBeNull();
    expect(cli.stdout()).toBe("");
    expect(demoRuntime.verifications).toEqual([]);
    demoRuntime.proof({ success: true, hostname: new URL(demoRuntime.origin).hostname, action: "podaj-admission", cdata: await admissionProofData(approval) });
    await approveAdmission(approval, "controlled-test-proof");
    expect(demoRuntime.verifications).toHaveLength(1);
    expect(new URLSearchParams(demoRuntime.verifications[0]).get("response")).toBe("controlled-test-proof");
    await waitForReservation(approval, { timeoutMs: 5000, intervalMs: 250 });
    const browserUrl = new URL(`/s/${parsed.id}#${parsed.key}`, link.origin);
    expect(browserUrl.href).toBe(link.href);
    const { stdout, stderr, requests } = await complete(demoRuntime, cli, undefined, undefined, browserUrl);
    expect(stderr.split("\n").filter((line) => /^https?:\/\//u.test(line))).toEqual([link.href]);
    expect(stderr).not.toContain("API_KEY");
    expect(stderr).not.toContain("return to CLI");
    const credential = requests.find((request) => request.path === "/api/demo/status")!.authorization!.slice(7);
    expect(approval.challenge).toBe(createHash("sha256").update(credential).digest("hex"));
    expect(stderr).not.toContain(credential);
    const stage = requests.find((request) => request.path === "/api/contexts")!;
    expect(stage.authorization).toBeNull();
    expect(stage.body).not.toContain(credential);
    expect(requests.every((request) => request.authorization !== `Bearer ${OWNER}`)).toBe(true);
    const reservation = requests.find((request) => request.path === "/api/handoffs/reserve")!;
    expect(reservation.authorization).toBe(`Bearer ${credential}`);
    const reservationBody = JSON.parse(reservation.body) as { recipientPublicKey: string; id: string; writeToken: string };
    expect(reservationBody).toEqual({ recipientPublicKey: expect.any(String), id: approval.id, writeToken: approval.writeToken });
    expect(recipientIdentity(reservationBody.recipientPublicKey)).toEqual(recipientIdentity(approval.recipientPublicKey));
    expect(JSON.parse(requests.find((request) => request.path === "/api/demo/approve")!.body)).toEqual({
      challenge: approval.challenge, recipientPublicKey: approval.recipientPublicKey, turnstileToken: "controlled-test-proof",
    });
    const writable = requests.filter((request) => request.path.endsWith("/writable"));
    expect(writable.length).toBeGreaterThan(0);
    expect(writable.every((request) => request.method === "GET" && request.authorization === `Bearer ${approval.writeToken}`)).toBe(true);
    expect(requests.find((request) => request.method === "PUT")?.authorization).toBe(`Bearer ${approval.writeToken}`);
    const subscribeAuth = requests.find((request) => request.path.startsWith("/parties/"))!.authorization!;
    const readAuth = requests.find((request) => request.path.endsWith("/consume"))!.authorization!;
    expect(new Set([`Bearer ${approval.writeToken}`, subscribeAuth, readAuth, `Bearer ${credential}`]).size).toBe(4);
    for (const secret of [credential, subscribeAuth.slice(7), readAuth.slice(7)]) {
      expect(`${link.href}${browserUrl.href}${JSON.stringify(approval)}${stdout}${stderr}`).not.toContain(secret);
    }
    expect(`${stdout}${stderr}`).not.toContain("PRIVATE KEY");
    expect((await demoRuntime.request(`/api/handoffs/${approval.id}/consume`, {
      method: "POST", headers: { Authorization: `Bearer ${approval.writeToken}` },
    })).status).toBe(401);
    expect((await stat(defaultAgeIdentityPath({}, instance.home))).mode & 0o777).toBe(0o600);
  }, 15_000);

  it.each(["compiled", "source"] as const)("keeps standalone decryption working through the %s CLI", async (variant) => {
    const instance = await setup(privateRuntime, "valid");
    const plain = { vars: [{ key: "API_KEY", value: "synthetic-decrypt-value" }] };
    const blob = await seal(plain, existingPair.publicKey);
    const env = { PATH: process.env.PATH, HOME: instance.home, XDG_CONFIG_HOME: instance.configDir, PODAJ_KEY_DIR: instance.keysDir };
    const bin = variant === "compiled" ? process.execPath : "bun";
    const entry = resolve(variant === "compiled" ? "dist/scripts/podaj.js" : "scripts/podaj.ts");
    expect(JSON.parse((await exec(bin, [entry, "decrypt", blob], { env, timeout: 10_000 })).stdout)).toMatchObject(plain);
    const fromStdin = exec(bin, [entry, "decrypt"], { env, timeout: 10_000 });
    fromStdin.child.stdin?.end(blob);
    expect(JSON.parse((await fromStdin).stdout)).toMatchObject(plain);
  });
});

describe("isolated malformed-server responses", () => {
  it.each<Malformation>(["stage-id", "stage-expiry", "approval-fingerprint", "public-id", "public-write", "private-id", "private-write", "overlap", "malformed-capability", "reservation-fingerprint", "id", "consumed-fingerprint", "ciphertext-key"])("rejects %s without plaintext or a completed receipt", async (malformation) => {
    const server = await malformedServer(malformation);
    cleanups.push(server.close);
    const home = await mkdtemp(join(tmpdir(), "podaj-malformed-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const child = exec(process.execPath, [resolve("dist/scripts/podaj.js"), "wait"], {
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), PODAJ_URL: server.origin, PODAJ_API_AUTH_SECRET: OWNER },
      timeout: 10_000,
    });
    child.child.stdin?.end();
    void child.catch(() => undefined);
    if (malformation === "public-id" || malformation === "public-write") {
      let stderr = "";
      child.child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      let link: string | undefined;
      await vi.waitFor(() => {
        link = stderr.split("\n").find((line) => line.startsWith(`${server.origin}/s/`));
        expect(link).toBeDefined();
      });
      const url = new URL(link!);
      const parsed = parseContextLink(url.pathname, url.hash)!;
      const staged = await (await fetch(`${server.origin}/api/contexts/${parsed.id}`)).json() as { encryptedContext: string };
      const context = await openRequestContext(parsed.id, parsed.key, staged.encryptedContext);
      server.approve(recipientIdentity(context.recipientPublicKey).fingerprint);
      await expect(child).rejects.toMatchObject({ stderr: expect.stringContaining("different handoff id or write capability") });
      expect(server.paths.some((path) => path.startsWith("/parties/"))).toBe(false);
    }
    await expect(child).rejects.toMatchObject({ code: 1, stdout: "" });
    if (malformation === "stage-id" || malformation === "stage-expiry") {
      await expect(child).rejects.toMatchObject({ stderr: expect.stringContaining("request context staging returned an invalid id or expiry") });
    }
    if (malformation === "private-id" || malformation === "private-write") {
      await expect(child).rejects.toMatchObject({ stderr: expect.stringContaining("different handoff id or write capability") });
    }
    if (!["approval-fingerprint", "public-id", "public-write", "consumed-fingerprint", "ciphertext-key"].includes(malformation)) {
      await expect(child).rejects.toMatchObject({ stderr: expect.not.stringContaining(`${server.origin}/s/`) });
      expect(server.paths.some((path) => path.startsWith("/parties/"))).toBe(false);
    }
    expect(await readdir(join(home, ".local/share/podaj/inbox"))).toEqual([]);
    expect((await stat(defaultAgeIdentityPath({}, home))).mode & 0o777).toBe(0o600);
    if (["stage-id", "stage-expiry", "approval-fingerprint"].includes(malformation)) expect(server.paths).not.toContain("/api/handoffs/reserve");
    if (!["consumed-fingerprint", "ciphertext-key"].includes(malformation)) expect(server.paths.some((path) => path.endsWith("/consume"))).toBe(false);
  });
});
