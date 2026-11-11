import { Schema } from "effect";
import { publicKeyFromFragment } from "../crypto/podaj1.js";
import { CAPABILITY } from "../handoffs/protocol.js";
import { parseRequestedKeys } from "./requested-keys.js";
import { parseContextLink } from "./request-context.js";

const COMPOSE_PATH = /^\/s\/(?<id>[a-f0-9]{32})$/u;

export const ComposeSource = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Encrypted"), id: Schema.String, key: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("Expanded"), id: Schema.String, writeToken: Schema.String,
    recipientPublicKey: Schema.String, requestedKeys: Schema.Array(Schema.String),
  }),
]);
export type ComposeSource = typeof ComposeSource.Type;

export type AppRoute =
  | { page: "compose"; source: ComposeSource | { _tag: "Invalid"; id: string } }
  | { page: "landing" };

export const parseAppRoute = (pathname: string, hash: string): AppRoute => {
  const id = COMPOSE_PATH.exec(pathname)?.groups?.id;
  if (id === undefined) { return { page: "landing" }; }
  const contextLink = parseContextLink(pathname, hash);
  if (contextLink !== null) {
    return { page: "compose", source: { _tag: "Encrypted", ...contextLink } };
  }
  const invalid: AppRoute = { page: "compose", source: { _tag: "Invalid", id } };
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const writeToken = params.get("write");
  const recipient = params.get("recipient");
  if (![...params.keys()].every((key) => key === "write" || key === "recipient" || key === "keys")
    || params.getAll("write").length !== 1 || params.getAll("recipient").length !== 1
    || writeToken === null || !CAPABILITY.test(writeToken) || recipient === null) { return invalid; }
  try {
    return {
      page: "compose",
      source: {
        _tag: "Expanded", id, writeToken, recipientPublicKey: publicKeyFromFragment(recipient),
        requestedKeys: parseRequestedKeys(params),
      },
    };
  } catch { return invalid; }
};
