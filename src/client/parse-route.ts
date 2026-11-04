const HANDOFF_PATH = /^\/h\/(?<id>[a-f0-9]{32})$/u;

export const parseHandoffId = (pathname: string): string | null => {
  const match = HANDOFF_PATH.exec(pathname);
  return match?.groups?.id ?? null;
};
