import { describe, expect, it } from "vitest";

import { looksLikeEnvPaste, parseEnvText } from "../src/client/parse-env.js";

describe("parseEnvText", () => {
  it("parses typical .env lines", () => {
    expect(
      parseEnvText(`# comment
OPENAI_API_KEY=sk-test
export DATABASE_URL="postgres://host/db"
EMPTY_OK=
`),
    ).toEqual([
      { key: "OPENAI_API_KEY", value: "sk-test" },
      { key: "DATABASE_URL", value: "postgres://host/db" },
      { key: "EMPTY_OK", value: "" },
    ]);
  });

  it("unquotes double-quoted escapes", () => {
    expect(parseEnvText('MSG="line\\n two"')).toEqual([
      { key: "MSG", value: "line\n two" },
    ]);
  });
});

describe("looksLikeEnvPaste", () => {
  it("detects multiline and KEY=value", () => {
    expect(looksLikeEnvPaste("a\nb")).toBe(true);
    expect(looksLikeEnvPaste("FOO=bar")).toBe(true);
    expect(looksLikeEnvPaste("just-a-token")).toBe(false);
  });
});
