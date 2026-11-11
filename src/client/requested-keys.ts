/** Compatibility decoder for requested labels in expanded fill-link fragments. */
export const parseRequestedKeys = (params: URLSearchParams): string[] => {
  const values = params.getAll("keys");
  if (values.length === 0) { return []; }
  if (values.length !== 1) { throw new Error("Duplicate requested keys."); }
  const parsed: unknown = JSON.parse(values[0]);
  if (!Array.isArray(parsed)) { throw new Error("Requested keys must be an array."); }
  const keys = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("Requested keys must be non-empty labels.");
    }
    keys.add(value.trim());
  }
  return [...keys];
};
