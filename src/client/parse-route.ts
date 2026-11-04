const HANDOFF_PATH = /^\/h\/(?<id>[a-f0-9]{32})$/u;
const COMPOSE_PATH = /^\/s\/(?<id>[a-f0-9]{32})$/u;

export type AppRoute =
  | {
      page: "compose";
      handoffId: string;
      writeToken: string | null;
      instanceToken: string | null;
    }
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
    if (raw.includes("=")) {
      const params = new URLSearchParams(raw);
      const write = params.get("write");
      const token = params.get("token");
      return {
        handoffId: compose.groups.id,
        instanceToken: token !== null && token.length > 0 ? token : null,
        page: "compose",
        writeToken: write !== null && write.length > 0 ? write : null,
      };
    }
    const writeToken = raw.trim().length > 0 ? raw.trim() : null;
    return {
      handoffId: compose.groups.id,
      instanceToken: null,
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
