/**
 * @typedef {{ deploy: boolean, url?: string, token?: string, tokenStdin: boolean }} InitArgs
 */

/**
 * @param {string[]} argv
 * @returns {InitArgs}
 */
export const initArgs = (argv) => {
  /** @type {InitArgs} */
  const args = { deploy: false, tokenStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--deploy") {
      args.deploy = true;
      continue;
    }
    if (arg === "--url" || arg === "--token") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      if (arg === "--url") {
        args.url = value;
      } else if (value === "-") {
        args.tokenStdin = true;
      } else {
        args.token = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown init flag: ${arg ?? ""}`);
  }
  const hasUrl = args.url !== undefined;
  const hasToken = args.token !== undefined || args.tokenStdin;
  if (!hasUrl && hasToken) {
    throw new Error("pass --url with the token");
  }
  if (args.token !== undefined && args.tokenStdin) {
    throw new Error("pass the token once");
  }
  if (args.deploy && (hasUrl || hasToken)) {
    throw new Error("pass either --deploy or --url with the token on stdin");
  }
  return args;
};
