export interface EnvPair {
  key: string;
  value: string;
}

const unquoteValue = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed
        .slice(1, -1)
        .replaceAll(String.raw`\n`, "\n")
        .replaceAll(String.raw`\r`, "\r")
        .replaceAll(String.raw`\t`, "\t")
        .replaceAll(String.raw `\"`, '"')
        .replaceAll(String.raw`\\`, "\\");
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

const parseLine = (line: string): EnvPair | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }
  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trimStart()
    : trimmed;
  const eq = withoutExport.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = withoutExport.slice(0, eq).trim();
  if (key.length === 0) {
    return null;
  }
  const value = unquoteValue(withoutExport.slice(eq + 1));
  return { key, value };
};

/** Parse pasted `.env` text (line-oriented KEY=value, optional `export`, # comments). */
export const parseEnvText = (text: string): EnvPair[] => {
  const lines = text.split(/\r\n?|\n/u);
  const vars: EnvPair[] = [];
  for (const line of lines) {
    const pair = parseLine(line);
    if (pair !== null) {
      vars.push(pair);
    }
  }
  return vars;
};

/** True when clipboard text looks like bulk env paste (not a single bare token). */
export const looksLikeEnvPaste = (text: string): boolean => {
  const lines = text.split(/\r\n?|\n/u).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0 || (lines.length === 1 && /^https?:\/\//iu.test(lines[0]))) { return false; }
  return lines.every((line) => parseLine(line) !== null);
};
