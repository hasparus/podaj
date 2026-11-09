import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const input = args[0] === "secret" && args[1] === "put" ? readFileSync(0, "utf8") : "";
const log = process.env.PODAJ_TEST_WRANGLER_LOG;
if (log === undefined) throw new Error("missing isolated Wrangler invocation log");
const configIndex = args.indexOf("--config");
const config = configIndex === -1 ? {} : JSON.parse(readFileSync(args[configIndex + 1], "utf8"));
const output = process.env.WRANGLER_OUTPUT_FILE_PATH;
appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), stdinBytes: Buffer.byteLength(input),
  tty: [process.stdin.isTTY === true, process.stdout.isTTY === true, process.stderr.isTTY === true],
  account: config.account_id ?? null, outputMode: output === undefined ? null : statSync(output).mode & 0o777,
})}\n`);
const cacheAccount = () => {
  if (!existsSync(join(process.cwd(), "node_modules"))) throw new Error("missing local cache scope");
  const cache = process.env.PODAJ_TEST_ACCOUNT_CACHE ?? JSON.stringify({ account: { id: "a".repeat(32), name: "synthetic account" } });
  if (cache.length > 0) {
    const directory = join(process.cwd(), "node_modules", ".cache", "wrangler");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "wrangler-account.json"), cache);
  }
};
if (args[0] === "whoami") {
  process.stdout.write(process.env.PODAJ_TEST_LOGIN_REQUIRED === "1" && !existsSync(`${log}.authenticated`)
    ? "You are not authenticated. Please run `wrangler login`.\n"
    : "You are logged in with an OAuth Token, associated with the email synthetic@example.test.\n");
} else if (args[0] === "login") {
  writeFileSync(`${log}.authenticated`, "authenticated");
} else if (args[0] === "deploy") {
  cacheAccount();
  if (output === undefined) throw new Error("missing structured output path");
  const metadata = process.env.PODAJ_TEST_DEPLOY_METADATA ?? JSON.stringify({ type: "deploy", version: 1, worker_name: config.name, targets: ["https://installed-fixture.example.workers.dev"] });
  if (metadata.length > 0) appendFileSync(output, `${metadata}\n`);
  process.stdout.write("human output is not machine metadata: https://decoy.example.workers.dev\n");
} else if (args[0] === "secret" && args[1] === "list") {
  cacheAccount();
  process.stdout.write("[]\n");
} else if (args[0] === "secret" && args[1] === "put" && args[2] === "PODAJ_API_AUTH_SECRET") {
  if (typeof config.account_id !== "string") throw new Error("secret write has no explicit account");
  if (process.env.PODAJ_TEST_ECHO_SECRET === "1") {
    process.stdout.write(input);
    process.stderr.write(input);
    const debug = process.env.WRANGLER_LOG_PATH;
    if (debug !== undefined) writeFileSync(debug, input);
    process.exitCode = 1;
  }
} else {
  throw new Error(`unexpected fake Wrangler operation: ${args.join(" ")}`);
}
