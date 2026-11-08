import type { ConfigArgs } from "./config-args.js";
import type { PodajConfig } from "./config.js";
import type { Probe } from "./instance.js";
import type { ClientConfig } from "../src/handoffs/protocol.js";
import { originOf } from "./instance.js";

export interface SetupIo {
  isTTY: boolean;
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
  save: (config: PodajConfig) => void;
}

const rejectProbe = (verdict: Probe) => {
  if (verdict === "unauthorized") throw new Error("that instance token was rejected");
  if (verdict === "locked") {
    throw new Error("this worker has no instance token yet. Run podaj config in a terminal and choose to set one.");
  }
  throw new Error("could not reach a podaj access endpoint at that url");
};

const ensureCloudflare = (io: SetupIo) => {
  if (io.whoami()) return;
  if (!io.isTTY) {
    throw new Error("Cloudflare is not logged in. Run podaj deploy in a terminal to log in first.");
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

const connect = async (url: string, token: string, io: SetupIo) => redacted(token, async () => {
  const origin = originOf(url);
  await io.config(origin);
  const verdict = await io.probe(origin, token);
  if (verdict !== "ok") rejectProbe(verdict);
  io.save({ token, url: origin });
});

const connectNewToken = async (url: string, io: SetupIo) => {
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
    io.save({ token, url: origin });
  });
};

/** A successful deployment also configures subsequent wait commands. */
export const runDeploy = async (io: SetupIo) => {
  io.ensureClient();
  ensureCloudflare(io);
  const configPath = io.stage();
  const output = io.deploy(configPath);
  const url = originOf(io.workersUrl(output));
  const token = io.mintToken();
  await redacted(token, async () => {
    io.putSecret({ configPath }, token);
    io.save({ token, url });
  });
};

export const runConfig = async (args: ConfigArgs, io: SetupIo) => {
  if (args.url !== undefined) {
    await connect(args.url, args.token ?? "", io);
    return;
  }
  if (!io.isTTY) {
    throw new Error("podaj config needs a terminal, or pass --url (private instances need a token on stdin)");
  }
  const url = originOf(await io.askUrl());
  const config = await io.config(url);
  if (config.access === "public") {
    await connect(url, "", io);
    return;
  }
  const source = await io.askTokenSource();
  if (source === "set") await connectNewToken(url, io);
  else await connect(url, await io.askToken(), io);
};
