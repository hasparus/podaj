/**
 * @param {string} plain
 * @param {readonly string[]} keys
 * @returns {Record<string, string>}
 */
export const selectVars = (plain, keys) => {
  const parsed = JSON.parse(plain);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("vars" in parsed) ||
    !Array.isArray(parsed.vars)
  ) {
    throw new Error("handoff payload is not env vars");
  }
  const values = new Map();
  for (const row of parsed.vars) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.key !== "string" ||
      typeof row.value !== "string"
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
