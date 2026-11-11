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

  it("accepts punctuation, spaces and Unicode in non-empty names", () => {
    expect(parseEnvText("MY.KEY=one\nservice-token=two\nthe key I use for this service=three\n🔑 access=four\n =ignored")).toEqual([
      { key: "MY.KEY", value: "one" },
      { key: "service-token", value: "two" },
      { key: "the key I use for this service", value: "three" },
      { key: "🔑 access", value: "four" },
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
    expect(looksLikeEnvPaste("a\nb")).toBe(false);
    expect(looksLikeEnvPaste("FOO=bar")).toBe(true);
    expect(looksLikeEnvPaste("just-a-token")).toBe(false);
    expect(looksLikeEnvPaste("https://example.test/path?token=value")).toBe(false);
    expect(looksLikeEnvPaste("demo-token\n")).toBe(false);
    expect(looksLikeEnvPaste("A=one\nB=two\n")).toBe(true);
    expect(looksLikeEnvPaste("# comment\nexport A=one\r\nB=two\r\n")).toBe(true);
    expect(looksLikeEnvPaste("A=one\nnot an assignment")).toBe(false);
  });
});
