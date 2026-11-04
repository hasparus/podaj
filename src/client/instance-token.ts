const STORAGE_KEY = "podaj.token";

export const readInstanceToken = (): string => {
  try {
    return globalThis.sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

export const writeInstanceToken = (token: string): void => {
  try {
    if (token.length === 0) {
      globalThis.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    globalThis.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // sessionStorage can throw in private browsing; the field still works in memory.
  }
};

export const authHeaders = (
  headers: Record<string, string> = {},
): Record<string, string> => {
  const token = readInstanceToken();
  if (token.length === 0) {
    return headers;
  }
  return { ...headers, Authorization: `Bearer ${token}` };
};
