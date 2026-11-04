import { originOf } from "./instance.mjs";

/**
 * @typedef {"connect" | "deploy"} InitMode
 * @typedef {import("./instance.mjs").Probe} Probe
 * @typedef {import("./init-args.mjs").InitArgs} InitArgs
 * @typedef {{
 *   url: string,
 *   token: string,
 *   keys: string,
 *   mode: InitMode,
 *   kvId?: string,
 * }} SavedInit
 * @typedef {{
 *   isTTY: boolean,
 *   chooseMode: () => Promise<InitMode>,
 *   askUrl: () => Promise<string>,
 *   askTokenSource: () => Promise<"have" | "set">,
 *   askToken: () => Promise<string>,
 *   askWorkerName: () => Promise<string>,
 *   note: (message: string) => void,
 *   login: () => void,
 *   whoami: () => boolean,
 *   createKv: () => string,
 *   deploy: (configPath: string) => string,
 *   putSecret: (target: { configPath?: string, name?: string }, token: string) => void,
 *   probe: (origin: string, token: string) => Promise<Probe>,
 *   keygen: () => Promise<string>,
 *   publicPem: (dir: string) => string,
 *   hasPrivateKey: () => boolean,
 *   keyDir: () => string,
 *   existingKvId: () => string | undefined,
 *   stage: (kvId: string, publicPem: string) => string,
 *   ensureClient: () => void,
 *   mintToken: () => string,
 *   workersUrl: (output: string) => string,
 *   save: (config: SavedInit) => void,
 * }} InitIo
 */

/**
 * @param {Probe} verdict
 * @returns {never}
 */
const rejectProbe = (verdict) => {
  switch (verdict) {
    case "ok":
      throw new Error("token accepted");
    case "unauthorized":
      throw new Error("that instance token was rejected");
    case "locked":
      throw new Error(
        "this worker has no instance token yet. Run podaj init in a terminal and choose to set one.",
      );
    case "unreachable":
      throw new Error("could not reach a podaj status endpoint at that url");
    default: {
      /** @type {never} */
      const unexpected = verdict;
      throw new Error(String(unexpected));
    }
  }
};

/**
 * @param {InitIo} io
 */
const ensureCloudflare = (io) => {
  if (io.whoami()) {
    return;
  }
  if (!io.isTTY) {
    throw new Error(
      "Cloudflare is not logged in. Run wrangler login, then podaj init --deploy",
    );
  }
  io.note("Cloudflare needs a browser login. Waiting until that finishes.");
  io.login();
  if (!io.whoami()) {
    throw new Error("Cloudflare login did not stick");
  }
};

/**
 * @param {InitIo} io
 */
const keysForConnect = async (io) => {
  if (io.hasPrivateKey()) {
    return io.keyDir();
  }
  const dir = await io.keygen();
  io.note(
    `recipient key written to ${dir}. The worker must serve that public.pem as /recipient.pem or pasted secrets will not decrypt.`,
  );
  return dir;
};

/**
 * @param {string} url
 * @param {string} token
 * @param {InitIo} io
 */
const connect = async (url, token, io) => {
  const origin = originOf(url);
  const verdict = await io.probe(origin, token);
  if (verdict !== "ok") {
    rejectProbe(verdict);
  }
  const keys = await keysForConnect(io);
  io.save({ keys, mode: "connect", token, url: origin });
};

/**
 * @param {string} url
 * @param {InitIo} io
 */
const connectNewToken = async (url, io) => {
  ensureCloudflare(io);
  const name = await io.askWorkerName();
  const token = io.mintToken();
  io.putSecret({ name }, token);
  const origin = originOf(url);
  const verdict = await io.probe(origin, token);
  if (verdict !== "ok") {
    throw new Error(
      `secret was stored on ${name} but the status check returned ${verdict}. instance token: ${token}`,
    );
  }
  const keys = await keysForConnect(io);
  io.save({ keys, mode: "connect", token, url: origin });
};

/**
 * @param {InitIo} io
 */
const deploy = async (io) => {
  io.ensureClient();
  ensureCloudflare(io);
  const keys = await io.keygen();
  const existingKvId = io.existingKvId();
  const kvId = existingKvId ?? io.createKv();
  if (existingKvId !== undefined) {
    io.note(`reusing KV namespace ${kvId}`);
  }
  const configPath = io.stage(kvId, io.publicPem(keys));
  const output = io.deploy(configPath);
  const url = io.workersUrl(output);
  const token = io.mintToken();
  io.putSecret({ configPath }, token);
  io.save({ keys, kvId, mode: "deploy", token, url });
};

/**
 * @param {InitArgs} args
 * @param {InitIo} io
 */
export const runInit = async (args, io) => {
  if (args.url !== undefined && args.token !== undefined) {
    await connect(args.url, args.token, io);
    return;
  }
  if (args.deploy) {
    await deploy(io);
    return;
  }
  if (!io.isTTY) {
    throw new Error(
      "podaj init needs a terminal, or pass --url with the token on stdin, or --deploy",
    );
  }
  const mode = await io.chooseMode();
  switch (mode) {
    case "connect": {
      const url = await io.askUrl();
      const source = await io.askTokenSource();
      switch (source) {
        case "have": {
          await connect(url, await io.askToken(), io);
          return;
        }
        case "set": {
          await connectNewToken(url, io);
          return;
        }
        default: {
          /** @type {never} */
          const unexpected = source;
          throw new Error(String(unexpected));
        }
      }
    }
    case "deploy": {
      await deploy(io);
      return;
    }
    default: {
      /** @type {never} */
      const unexpected = mode;
      throw new Error(String(unexpected));
    }
  }
};
