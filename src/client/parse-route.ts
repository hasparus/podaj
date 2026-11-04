const HANDOFF_PATH = /^\/h\/(?<id>[a-f0-9]{32})$/u;
const COMPOSE_PATH = /^\/s\/(?<id>[a-f0-9]{32})$/u;

export type AppRoute =
  | { page: "compose"; handoffId: string; writeToken: string | null }
  | { page: "receive"; handoffId: string }
  | { page: "send" };

export const parseHandoffId = (pathname: string): string | null => {
  const match = HANDOFF_PATH.exec(pathname);
  return match?.groups?.id ?? null;
};

export const parseAppRoute = (pathname: string, hash: string): AppRoute => {
  const compose = COMPOSE_PATH.exec(pathname);
  if (compose?.groups?.id !== undefined) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    const writeToken = raw.trim().length > 0 ? raw.trim() : null;
    return {
      handoffId: compose.groups.id,
      page: "compose",
      writeToken,
    };
  }
  const handoffId = parseHandoffId(pathname);
  if (handoffId !== null) {
    return { handoffId, page: "receive" };
  }
  return { page: "send" };
};
