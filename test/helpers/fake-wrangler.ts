import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const input = args[0] === "secret" ? readFileSync(0, "utf8") : "";
const log = process.env.PODAJ_TEST_WRANGLER_LOG;
if (log === undefined) throw new Error("missing isolated Wrangler invocation log");
appendFileSync(log, `${JSON.stringify({ args, stdinBytes: Buffer.byteLength(input) })}\n`);
if (args[0] === "whoami") {
  process.stdout.write(process.env.PODAJ_TEST_LOGIN_REQUIRED === "1" && !existsSync(`${log}.authenticated`)
    ? "You are not authenticated. Please run `wrangler login`.\n"
    : "You are logged in with an OAuth Token, associated with the email synthetic@example.test.\n");
} else if (args[0] === "login") {
  writeFileSync(`${log}.authenticated`, "authenticated");
} else if (args[0] === "deploy") {
  process.stdout.write("https://installed-fixture.example.workers.dev\n");
} else if (args[0] !== "secret" || args[1] !== "put" || args[2] !== "PODAJ_API_AUTH_SECRET") {
  throw new Error(`unexpected fake Wrangler operation: ${args.join(" ")}`);
}
