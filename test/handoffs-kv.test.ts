import { describe, expect, it } from "vitest";

import {
  hashWriteToken,
  isPendingValue,
  isSealedValue,
  pendingValue,
  verifyPendingWriteToken,
} from "../src/handoffs/kv-encoding.js";

describe("handoffs kv encoding", () => {
  it("detects pending vs sealed", () => {
    expect(isPendingValue("PENDING:abc")).toBe(true);
    expect(isSealedValue("PODAJ1.x")).toBe(true);
  });

  it("verifies write tokens", async () => {
    const token = "abc123";
    const hash = await hashWriteToken(token);
    const stored = pendingValue(hash);
    expect(await verifyPendingWriteToken(stored, token)).toBe(true);
    expect(await verifyPendingWriteToken(stored, "wrong")).toBe(false);
  });
});
