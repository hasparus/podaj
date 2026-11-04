import { describe, expect, it } from "vitest";

import { parseAppRoute } from "../src/client/parse-route.js";

describe("parseAppRoute", () => {
  it("parses compose URLs with write token in the hash", () => {
    expect(
      parseAppRoute("/s/0123456789abcdef0123456789abcdef", "#deadbeef"),
    ).toEqual({
      handoffId: "0123456789abcdef0123456789abcdef",
      page: "compose",
      writeToken: "deadbeef",
    });
  });

  it("parses receive and send", () => {
    expect(parseAppRoute("/h/0123456789abcdef0123456789abcdef", "")).toEqual({
      handoffId: "0123456789abcdef0123456789abcdef",
      page: "receive",
    });
    expect(parseAppRoute("/", "")).toEqual({ page: "send" });
  });
});
