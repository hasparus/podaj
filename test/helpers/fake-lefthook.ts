import { writeFileSync } from "node:fs";

const log = process.env.PODAJ_TEST_LEFTHOOK_LOG;
if (log === undefined) throw new Error("missing isolated Lefthook invocation log");
if (process.argv.slice(2).join(" ") !== "install") throw new Error("fake Lefthook only supports install");
writeFileSync(log, "installed");
process.stdout.write("sync hooks\n");
