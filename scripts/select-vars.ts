
export const selectVars = (plain: string, keys: readonly string[]): Record<string, string> => {
  const parsed: unknown = JSON.parse(plain);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("vars" in parsed) ||
    !Array.isArray(parsed.vars)
  ) {
    throw new Error("handoff payload is not env vars");
  }
  const values = new Map<string, string>();
  const rows: readonly unknown[] = parsed.vars;
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("key" in row) || typeof row.key !== "string" ||
      !("value" in row) || typeof row.value !== "string"
    ) {
      throw new Error("handoff payload is not env vars");
    }
    values.set(row.key, row.value);
  }
  const wanted = keys.length === 0 ? [...values.keys()] : keys;
  const missing = wanted.filter((key) => !values.has(key));
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(", ")}`);
  }
  return Object.fromEntries(
    wanted.map((key) => {
      const value = values.get(key);
      if (value === undefined) {
        throw new Error(`missing ${key}`);
      }
      return [key, value];
    }),
  );
};
