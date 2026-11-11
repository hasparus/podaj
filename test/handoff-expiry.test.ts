import { describe, expect, it } from "vitest";
import { HandoffStore } from "../src/handoffs/store.js";
import { handoffTtlSeconds } from "../src/security.js";
import { sqliteStorage } from "./helpers/sqlite.js";

const ttlCases = [
  [undefined, 7200], ["", 7200], ["7200seconds", 7200], ["3600seconds", 7200],
  ["NaN", 7200], ["Infinity", 7200], ["59", 7200], ["-60", 7200],
  ["86401", 7200], ["3600.5", 7200], ["3.6e3", 7200], ["+3600", 7200],
  [" 3600", 7200], ["3600\n", 7200], ["60", 60], ["3600", 3600], ["7200", 7200], ["86400", 86400],
] as const;
const input = {
  source: "generated" as const,
  id: "1".repeat(32), recipientFingerprint: "a".repeat(64), writeHash: "b".repeat(64),
  readHash: "c".repeat(64), subscribeHash: "d".repeat(64), creatorHash: null,
};

describe("handoff expiry", () => {
  it.each(ttlCases)("parses %s as %i seconds", (raw, expected) => {
    expect(handoffTtlSeconds(raw)).toBe(expected);
  });

  it.each(ttlCases)("uses %s (%i seconds) for SQLite reservations and explicit fills", (raw, expected) => {
    const { storage, database } = sqliteStorage();
    let now = Date.UTC(2026, 10, 1);
    try {
      const store = new HandoffStore(storage, { HANDOFF_TTL_SECONDS: raw }, () => now);
      expect(store.reserve(input)).toMatchObject({ status: 201, body: { expiresAt: now + expected * 1000 } });
      now += 5000;
      expect(store.fill(input.id, input.writeHash, "PODAJ1.synthetic")).toMatchObject({ status: 200, body: { expiresAt: now + expected * 1000 } });
      const changedConfig = new HandoffStore(storage, { HANDOFF_TTL_SECONDS: "60" }, () => now);
      expect(changedConfig.status(input.id, input.subscribeHash)).toMatchObject({ status: 200, body: { expiresAt: now + expected * 1000 } });
      now += expected * 1000;
      expect(store.consume(input.id, input.readHash).status).toBe(410);
      store.cleanup();
      expect(database.prepare("SELECT COUNT(*) AS count FROM handoffs").get()?.count).toBe(0);
    } finally { database.close(); }
  });
});
