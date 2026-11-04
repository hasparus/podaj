/**
 * @typedef {{ deploy: boolean, url?: string, token?: string }} InitArgs
 */

/**
 * @param {string[]} argv
 * @returns {InitArgs}
 */
export const initArgs = (argv) => {
  /** @type {InitArgs} */
  const args = { deploy: false };
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
      } else {
        args.token = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown init flag: ${arg ?? ""}`);
  }
  const hasUrl = args.url !== undefined;
  const hasToken = args.token !== undefined;
  if (hasUrl !== hasToken) {
    throw new Error("pass both --url and --token");
  }
  if (args.deploy && hasUrl) {
    throw new Error("pass either --deploy or --url and --token");
  }
  return args;
};
