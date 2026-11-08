import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { seal } from "../src/crypto/podaj1.js";
import { recipientIdentity } from "../scripts/instance.js";

const exec = promisify(execFile);
const ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "synthetic-instance-token-for-test";
const WRITE = "1".repeat(64);
const READ = "2".repeat(64);
const SUBSCRIBE = "3".repeat(64);
const fixturePair = () => generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const pair = fixturePair();
const other = fixturePair();
let scratch: string | undefined;
let server: Server | undefined;
let sockets: WebSocketServer | undefined;

type LegacyKeys = "none" | "valid" | "mismatch" | "invalid" | "private-only";
interface SetupOptions {
  legacyKeys?: LegacyKeys;
  demo?: boolean;
  badApproval?: boolean;
  badReservation?: "overlap" | "malformed" | "fingerprint" | "id";
  badConsumedKey?: boolean;
  wrongCiphertextKey?: boolean;
  socketFails?: boolean;
}

const setup = async ({ legacyKeys = "none", demo = false, badApproval = false, badReservation, badConsumedKey = false, wrongCiphertextKey = false, socketFails = false }: SetupOptions = {}) => {
  const home = await mkdtemp(join(tmpdir(), "podaj-cli-lifecycle-"));
  scratch = home;
  const keysDir = join(home, "keys");
  const configDir = join(home, "config");
  if (legacyKeys !== "none") {
    await mkdir(keysDir);
    await writeFile(join(keysDir, "private.pem"), legacyKeys === "invalid" ? "not a key" : pair.privateKey, { mode: 0o600 });
    if (legacyKeys !== "private-only") {
      await writeFile(join(keysDir, "public.pem"), legacyKeys === "invalid" ? "not a key" : legacyKeys === "mismatch" ? other.publicKey : pair.publicKey);
    }
  }
  const requests: { method: string; path: string; auth: string | undefined; body: string }[] = [];
  const requestPublicKeys: string[] = [];
  let verifier = "";
  let approvedPublicPem = "";
  let reservedPublicPem = "";
  server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({ method: request.method!, path, auth: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (path === "/api/config") {
      send(200, { mode: demo ? "demo" : "private", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 });
    } else if (path === "/api/access") {
      send(demo || request.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401, {});
    } else if (path === "/api/demo/status" && demo) {
      verifier = (request.headers.authorization ?? "").slice(7);
      if (approvedPublicPem === "") { send(202, { status: "pending" }); return; }
      send(200, {
        status: "approved", expiresAt: Date.now() + 60_000,
        recipientFingerprint: badApproval ? "f".repeat(64) : recipientIdentity(approvedPublicPem).fingerprint,
      });
    } else if (path === "/api/handoffs/reserve" && request.method === "POST") {
      if (request.headers.authorization !== `Bearer ${demo ? verifier : TOKEN}`) { send(401, {}); return; }
      const input: unknown = JSON.parse(body);
      if (typeof input !== "object" || input === null || !("recipientPublicKey" in input) || typeof input.recipientPublicKey !== "string") {
        send(400, {}); return;
      }
      reservedPublicPem = input.recipientPublicKey;
      requestPublicKeys.push(reservedPublicPem);
      if (demo && reservedPublicPem !== approvedPublicPem) { send(403, {}); return; }
      send(201, {
        id: badReservation === "id" ? "../other" : ID, writeToken: WRITE, readToken: READ,
        subscribeToken: badReservation === "overlap" ? READ : badReservation === "malformed" ? "bad-capability" : SUBSCRIBE,
        expiresAt: Date.now() + 60_000,
        recipientFingerprint: badReservation === "fingerprint" ? "f".repeat(64) : recipientIdentity(reservedPublicPem).fingerprint,
      });
    } else if (path === `/api/handoffs/${ID}/status`) {
      send(request.headers.authorization === `Bearer ${SUBSCRIBE}` ? 200 : 401, { status: "ready", expiresAt: Date.now() + 60_000 });
    } else if (path === `/api/handoffs/${ID}/consume` && request.method === "POST") {
      if (request.headers.authorization !== `Bearer ${READ}`) { send(401, {}); return; }
      const ciphertext = await seal({ vars: [{ key: "API_KEY", value: "synthetic-env-value" }] }, wrongCiphertextKey ? pair.publicKey : reservedPublicPem, "default");
      send(200, { sealed: ciphertext, recipientFingerprint: badConsumedKey ? "f".repeat(64) : recipientIdentity(reservedPublicPem).fingerprint });
    } else {
      send(404, {});
    }
  });
  sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    requests.push({ method: "WS", path: request.url!, auth: request.headers.authorization, body: "" });
    if (socketFails || request.headers.authorization !== `Bearer ${SUBSCRIBE}`) socket.close();
    else socket.send(JSON.stringify({ type: "ready" }));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  const run = (args: string[], token = demo ? "" : TOKEN, stdin = "") => {
    let stderr = "";
    const child = exec(process.execPath, [resolve("dist/scripts/podaj.js"), ...args], {
      env: {
        PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: configDir,
        PODAJ_KEY_DIR: keysDir, PODAJ_URL: origin, PODAJ_API_AUTH_SECRET: token,
      },
      timeout: 20_000,
    });
    child.child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const link = stderr.split("\n").find((line) => line.startsWith(`${origin}/authorize#`));
      if (link === undefined) return;
      const encoded = new URLSearchParams(new URL(link).hash.slice(1)).get("recipient");
      if (encoded !== null) {
        approvedPublicPem = createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" })
          .export({ format: "pem", type: "spki" }).toString();
      }
    });
    child.child.stdin?.end(stdin);
    return child;
  };
  return {
    run, origin, requests, requestPublicKeys, keysDir, home,
    verifier: () => verifier,
    configFile: join(configDir, "podaj", "config.json"),
  };
};

afterEach(async () => {
  for (const socket of sockets?.clients ?? []) socket.terminate();
  if (sockets !== undefined) await new Promise<void>((done) => sockets!.close(() => done()));
  server?.closeAllConnections();
  if (server !== undefined) await new Promise<void>((done) => server!.close(() => done()));
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  server = undefined;
  sockets = undefined;
  scratch = undefined;
});

describe("actual CLI with isolated HOME and localhost only", () => {
  it("connects without any recipient files, token output, recipient fetch or request creation", async () => {
    const instance = await setup();
    const { stdout, stderr } = await instance.run(["init", "--url", instance.origin, "--token", TOKEN]);
    expect(`${stdout}${stderr}`).not.toContain(TOKEN);
    expect(JSON.parse(stdout)).toEqual({ mode: "connect", url: instance.origin, config: instance.configFile });
    expect(JSON.parse(await readFile(instance.configFile, "utf8"))).toEqual({ token: TOKEN, url: instance.origin });
    expect(instance.requests.map((r) => r.path)).toEqual(["/api/config", "/api/access"]);
    expect(existsSync(instance.keysDir)).toBe(false);
  });

  it("does not send a saved owner credential to a different PODAJ_URL origin", async () => {
    const instance = await setup();
    await mkdir(join(instance.home, "config", "podaj"), { recursive: true });
    await writeFile(instance.configFile, JSON.stringify({ url: "https://original-instance.test", token: TOKEN }), { mode: 0o600 });
    const child = exec(process.execPath, [resolve("dist/scripts/podaj.js"), "wait", "API_KEY"], {
      env: { PATH: process.env.PATH, HOME: instance.home, XDG_CONFIG_HOME: join(instance.home, "config"), PODAJ_URL: instance.origin },
      timeout: 20_000,
    });
    child.child.stdin?.end();
    await expect(child).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(instance.requests.every((request) => request.auth === undefined)).toBe(true);
    expect(instance.requests.map((request) => request.path)).toEqual(["/api/config", "/api/handoffs/reserve"]);
  });

  it("connects to a demo without generating keys or requesting browser approval", async () => {
    const instance = await setup({ demo: true });
    const { stdout, stderr } = await instance.run(["init", "--url", instance.origin]);
    expect(JSON.parse(stdout)).toEqual({ mode: "connect", url: instance.origin, config: instance.configFile });
    expect(stderr).toBe("");
    expect(existsSync(instance.keysDir)).toBe(false);
    expect(instance.requests.map((r) => r.path)).toEqual(["/api/config", "/api/access"]);
    expect(JSON.parse(await readFile(instance.configFile, "utf8"))).toEqual({ token: "", url: instance.origin });
  });

  it("refuses private init without owner auth", async () => {
    const instance = await setup();
    await expect(instance.run(["init", "--url", instance.origin], "")).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(existsSync(instance.configFile)).toBe(false);
    expect(existsSync(instance.keysDir)).toBe(false);
  });

  it.each(["valid", "mismatch", "invalid", "private-only"] as const)("ignores and preserves legacy %s key files during init and wait", async (legacyKeys) => {
    const instance = await setup({ legacyKeys });
    const snapshot = async () => Promise.all((await readdir(instance.keysDir)).sort().map(async (name) => {
      const path = join(instance.keysDir, name);
      const metadata = await stat(path);
      return { name, content: await readFile(path, "utf8"), mode: metadata.mode, inode: metadata.ino, modified: metadata.mtimeMs };
    }));
    const before = await snapshot();
    await instance.run(["init", "--url", instance.origin, "--token", TOKEN]);
    const { stdout } = await instance.run(["wait", "API_KEY"]);
    expect(JSON.parse(stdout)).toEqual({ API_KEY: "synthetic-env-value" });
    expect(await snapshot()).toEqual(before);
    expect(instance.requestPublicKeys[0]).not.toBe(pair.publicKey);
    expect(instance.requestPublicKeys[0]).not.toBe(other.publicKey);
  });

  it("rejects invalid env keys before any network work or local writes", async () => {
    const instance = await setup();
    await expect(instance.run(["wait", "not-a-key"])).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(instance.requests).toEqual([]);
    expect(await readdir(instance.home)).toEqual([]);
  });

  it.each([false, true])("uses a fresh memory-only 2048-bit key and independent capabilities (socket fails=%s)", async (socketFails) => {
    const instance = await setup({ socketFails });
    const { stdout, stderr } = await instance.run(["wait", "API_KEY"]);
    expect(JSON.parse(stdout)).toEqual({ API_KEY: "synthetic-env-value" });
    expect(`${stdout}${stderr}`).not.toContain(TOKEN);
    expect(stderr).not.toContain(READ);
    expect(stderr).not.toContain(SUBSCRIBE);
    expect(stderr).not.toContain("PRIVATE KEY");
    const publicPem = instance.requestPublicKeys[0]!;
    expect(createPublicKey(publicPem).asymmetricKeyDetails?.modulusLength).toBe(2048);
    const link = new URL(stderr.trim().split("\n").at(-1)!);
    const fragment = new URLSearchParams(link.hash.slice(1));
    expect([...fragment.keys()]).toEqual(["write", "recipient"]);
    expect(fragment.get("write")).toBe(WRITE);
    expect(fragment.get("recipient")).toBe(recipientIdentity(publicPem).encoded);
    expect(stderr.split("\n").slice(0, 2)).toEqual(["paste these keys and click send:", "API_KEY"]);
    expect(instance.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/config", "POST /api/handoffs/reserve", `WS /parties/handoff-party/${ID}`,
      ...(socketFails ? [`GET /api/handoffs/${ID}/status`] : []), `POST /api/handoffs/${ID}/consume`,
    ]);
    const reserveBody: unknown = JSON.parse(instance.requests.find((r) => r.path === "/api/handoffs/reserve")!.body);
    expect(reserveBody).toEqual({ recipientPublicKey: publicPem });
    expect(instance.requests.find((r) => r.method === "WS")?.auth).toBe(`Bearer ${SUBSCRIBE}`);
    expect(instance.requests.at(-1)).toMatchObject({ auth: `Bearer ${READ}`, body: "" });
    expect(await readdir(instance.home, { recursive: true })).toEqual([]);
  });

  it("uses a different request key for every invocation, without persisting either pair", async () => {
    const instance = await setup();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { stdout } = await instance.run(["wait"]);
      expect(JSON.parse(stdout)).toEqual({ API_KEY: "synthetic-env-value" });
    }
    expect(instance.requestPublicKeys).toHaveLength(2);
    expect(new Set(instance.requestPublicKeys).size).toBe(2);
    expect(await readdir(instance.home, { recursive: true })).toEqual([]);
  });

  it("accepts owner auth on stdin without exposing it in output or the fill link", async () => {
    const instance = await setup();
    const { stdout, stderr } = await instance.run(["wait", "API_KEY"], "", `${TOKEN}\n`);
    expect(JSON.parse(stdout)).toEqual({ API_KEY: "synthetic-env-value" });
    expect(`${stdout}${stderr}`).not.toContain(TOKEN);
    expect(instance.requests.find((r) => r.path === "/api/handoffs/reserve")?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("authorizes demo noninteractively for this request key without disclosing verifier to the browser", async () => {
    const instance = await setup({ demo: true });
    const { stdout, stderr } = await instance.run(["wait", "API_KEY"]);
    expect(JSON.parse(stdout)).toEqual({ API_KEY: "synthetic-env-value" });
    const authorizationLink = stderr.split("\n").find((line) => line.includes("/authorize#"))!;
    const fragment = new URLSearchParams(new URL(authorizationLink).hash.slice(1));
    expect([...fragment.keys()]).toEqual(["challenge", "recipient"]);
    expect(fragment.get("challenge")).toBe(createHash("sha256").update(instance.verifier()).digest("hex"));
    expect(fragment.get("recipient")).toBe(recipientIdentity(instance.requestPublicKeys[0]!).encoded);
    expect(stderr).not.toContain(instance.verifier());
    expect(instance.requests[1]?.path).toBe("/api/demo/status");
    expect(instance.requests.find((r) => r.path === "/api/handoffs/reserve")).toMatchObject({ auth: `Bearer ${instance.verifier()}` });
    expect(await readdir(instance.home, { recursive: true })).toEqual([]);
  });

  it("does not reserve after approval for a different recipient key", async () => {
    const instance = await setup({ demo: true, badApproval: true });
    await expect(instance.run(["wait"])).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(instance.requests.map((r) => r.path)).toEqual(["/api/config", "/api/demo/status"]);
    expect(await readdir(instance.home, { recursive: true })).toEqual([]);
  });

  it.each(["overlap", "malformed", "fingerprint", "id"] as const)("rejects invalid reservation %s before sharing or consuming", async (badReservation) => {
    const instance = await setup({ badReservation });
    await expect(instance.run(["wait"])).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.not.stringContaining(`/s/${ID}`) });
    expect(instance.requests.map((r) => r.path)).toEqual(["/api/config", "/api/handoffs/reserve"]);
    expect(await readdir(instance.home, { recursive: true })).toEqual([]);
  });

  it.each(["compiled", "source"] as const)("keeps standalone decryption working through the %s CLI", async (variant) => {
    const instance = await setup({ legacyKeys: "valid" });
    const plain = { vars: [{ key: "API_KEY", value: "synthetic-decrypt-value" }] };
    const blob = await seal(plain, pair.publicKey, "default");
    const env = {
      PATH: process.env.PATH, HOME: instance.home,
      XDG_CONFIG_HOME: join(instance.home, "config"), PODAJ_KEY_DIR: instance.keysDir,
    };
    const bin = variant === "compiled" ? process.execPath : "bun";
    const entry = resolve(variant === "compiled" ? "dist/scripts/podaj.js" : "scripts/podaj.ts");
    const fromArgument = await exec(bin, [entry, "decrypt", blob], { env, timeout: 10_000 });
    expect(JSON.parse(fromArgument.stdout)).toMatchObject(plain);
    expect(fromArgument.stderr).toBe("");
    const fromStdin = exec(bin, [entry, "decrypt"], { env, timeout: 10_000 });
    fromStdin.child.stdin?.end(blob);
    expect(JSON.parse((await fromStdin).stdout)).toMatchObject(plain);
  });

  it.each([{ badConsumedKey: true }, { wrongCiphertextKey: true, legacyKeys: "valid" }] as const)("does not output plaintext for a mismatched consumed fingerprint or encryption key: %j", async (options) => {
    const instance = await setup(options);
    const beforeFiles = await readdir(instance.home, { recursive: true });
    await expect(instance.run(["wait"])).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await readdir(instance.home, { recursive: true })).toEqual(beforeFiles);
  });
});
