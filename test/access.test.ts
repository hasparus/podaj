import { describe, expect, it } from "vitest";

import { accessFor } from "../src/access.js";

const token = "local-secret";

describe("accessFor", () => {
  it("leaves localhost open when no token is configured", () => {
    expect(
      accessFor(new Request("http://127.0.0.1:8787/api/handoffs"), undefined),
    ).toBe("ok");
  });

  it("locks a public host until PODAJ_TOKEN is set", () => {
    expect(
      accessFor(new Request("https://podaj.example.workers.dev/"), undefined),
    ).toBe("locked");
  });

  it("requires the bearer token when one is configured", () => {
    const url = "https://podaj.example.workers.dev/api/handoffs";
    expect(accessFor(new Request(url), token)).toBe("unauthorized");
    expect(
      accessFor(
        new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
        token,
      ),
    ).toBe("ok");
  });

  it("closes the upstream deployment", () => {
    expect(
      accessFor(
        new Request("https://podaj.hasparus.workers.dev/api/handoffs", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        token,
      ),
    ).toBe("closed");
  });
});
