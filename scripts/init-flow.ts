import type { InitArgs } from "./init-args.js";
import type { Probe } from "./instance.js";
import type { ClientConfig } from "../src/handoffs/protocol.js";

export type InitMode = "connect" | "deploy";
export interface SavedInit { url: string; token: string; mode: InitMode }
export interface InitIo {
  isTTY: boolean;
  chooseMode: () => Promise<InitMode>;
  askUrl: () => Promise<string>;
  askTokenSource: () => Promise<"have" | "set">;
  askToken: () => Promise<string>;
  askWorkerName: () => Promise<string>;
  note: (message: string) => void;
  login: () => void;
  whoami: () => boolean;
  deploy: (configPath: string) => string;
  putSecret: (target: { configPath?: string; name?: string }, token: string) => void;
  probe: (origin: string, token: string) => Promise<Probe>;
  config: (origin: string) => Promise<ClientConfig>;
  stage: () => string;
  ensureClient: () => void;
  mintToken: () => string;
  workersUrl: (output: string) => string;
  save: (config: SavedInit) => void;
}

import { originOf } from "./instance.js";

const rejectProbe = (verdict: Probe) => {
  if (verdict === "unauthorized") throw new Error("that instance token was rejected");
  if (verdict === "locked") {
    throw new Error("this worker has no instance token yet. Run podaj init in a terminal and choose to set one.");
  }
  throw new Error("could not reach a podaj access endpoint at that url");
};

const ensureCloudflare = (io: InitIo) => {
  if (io.whoami()) return;
  if (!io.isTTY) {
    throw new Error("Cloudflare is not logged in. Run wrangler login, then podaj init --deploy");
  }
  io.note("Cloudflare needs a browser login. Waiting until that finishes.");
  io.login();
  if (!io.whoami()) throw new Error("Cloudflare login did not stick");
};

const redacted = async (token: string, action: () => Promise<void>) => {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(token.length > 0 ? message.replaceAll(token, "[redacted]") : message);
  }
};

const connect = async (url: string, token: string, io: InitIo) => redacted(token, async () => {
  const origin = originOf(url);
  await io.config(origin);
  const verdict = await io.probe(origin, token);
  if (verdict !== "ok") rejectProbe(verdict);
  io.save({ mode: "connect", token, url: origin });
});

const connectNewToken = async (url: string, io: InitIo) => {
  const origin = originOf(url);
  ensureCloudflare(io);
  const name = await io.askWorkerName();
  const token = io.mintToken();
  await redacted(token, async () => {
    io.putSecret({ name }, token);
    const verdict = await io.probe(origin, token);
    if (verdict !== "ok") {
      throw new Error(`secret was stored on ${name} but the access check returned ${verdict}`);
    }
    io.save({ mode: "connect", token, url: origin });
  });
};

const deploy = async (io: InitIo) => {
  io.ensureClient();
  ensureCloudflare(io);
  const configPath = io.stage();
  const output = io.deploy(configPath);
  const url = io.workersUrl(output);
  const token = io.mintToken();
  await redacted(token, async () => {
    io.putSecret({ configPath }, token);
    io.save({ mode: "deploy", token, url });
  });
};

export const runInit = async (args: InitArgs, io: InitIo) => {
  if (args.url !== undefined) {
    await connect(args.url, args.token ?? "", io);
    return;
  }
  if (args.deploy) {
    await deploy(io);
    return;
  }
  if (!io.isTTY) {
    throw new Error("podaj init needs a terminal, or pass --url (private instances need a token), or --deploy");
  }
  const mode = await io.chooseMode();
  if (mode === "deploy") {
    await deploy(io);
    return;
  }
  const url = originOf(await io.askUrl());
  const config = await io.config(url);
  if (config.mode === "demo") {
    await connect(url, "", io);
    return;
  }
  const source = await io.askTokenSource();
  if (source === "set") await connectNewToken(url, io);
  else await connect(url, await io.askToken(), io);
};
