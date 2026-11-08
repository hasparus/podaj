import { publicKeyFromFragment } from "../crypto/podaj1.js";
import { CAPABILITY } from "../handoffs/protocol.js";

const COMPOSE_PATH = /^\/s\/(?<id>[a-f0-9]{32})$/u;

export type AppRoute =
  | { page: "compose"; handoffId: string; writeToken: string | null; publicKeyPem: string | null }
  | { page: "landing" };

export const parseAppRoute = (pathname: string, hash: string): AppRoute => {
  const handoffId = COMPOSE_PATH.exec(pathname)?.groups?.id;
  if (handoffId === undefined) { return { page: "landing" }; }
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const write = params.get("write");
  const recipient = params.get("recipient");
  const valid = [...params.keys()].every((key) => key === "write" || key === "recipient")
    && params.getAll("write").length === 1 && params.getAll("recipient").length === 1;
  let publicKeyPem: string | null = null;
  try {
    if (valid && recipient !== null) { publicKeyPem = publicKeyFromFragment(recipient); }
  } catch {
    publicKeyPem = null;
  }
  return {
    page: "compose", handoffId,
    writeToken: valid && write !== null && CAPABILITY.test(write) ? write : null,
    publicKeyPem,
  };
};
