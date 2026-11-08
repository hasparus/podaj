export interface ConfigArgs { url?: string; token?: string; tokenStdin: boolean }

export const configArgs = (argv: string[]): ConfigArgs => {
  const args: ConfigArgs = { tokenStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--url" && arg !== "--token") {
      throw new Error(`unknown config flag: ${arg ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} needs a value`);
    }
    if (arg === "--url") args.url = value;
    else if (value === "-") args.tokenStdin = true;
    else args.token = value;
    index += 1;
  }
  if (args.url === undefined && (args.token !== undefined || args.tokenStdin)) {
    throw new Error("pass --url with the token");
  }
  if (args.token !== undefined && args.tokenStdin) {
    throw new Error("pass the token once");
  }
  return args;
};
