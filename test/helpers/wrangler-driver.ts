export {};

const { createWrangler } = await import(process.env.PODAJ_TEST_ADAPTER!) as typeof import("../../scripts/wrangler.js");
const [bin, workspace, action, target] = process.argv.slice(2);
const wrangler = createWrangler({ bin, workspace });
try {
  if (action === "deploy") {
    const url = wrangler.deploy(target);
    wrangler.putSecret({ configPath: target }, "synthetic-adapter-secret");
    process.stdout.write(`${JSON.stringify({ url })}\n`);
  } else if (action === "secret") {
    wrangler.putSecret({ name: target }, "synthetic-adapter-secret");
    process.stdout.write('{"stored":true}\n');
  } else if (action === "whoami") {
    process.stdout.write(`${JSON.stringify({ authenticated: wrangler.whoami() })}\n`);
  } else {
    throw new Error("unknown adapter test action");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "adapter failed"}\n`);
  process.exitCode = 1;
}
