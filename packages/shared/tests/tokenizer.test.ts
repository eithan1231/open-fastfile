import { describe, expect, it } from "vitest";
import { tokenize } from "../src/dsl/tokenizer.js";

function types(source: string): string[] {
  return tokenize(source).tokens.map((t) => t.type);
}

describe("tokenizer", () => {
  it("tokenizes punctuation and identifiers", () => {
    expect(types("box sofa { size: 1 2 3 }")).toEqual(["ident", "ident", "lbrace", "ident", "colon", "number", "number", "number", "rbrace", "eof"]);
  });

  it("parses numbers with unit suffixes", () => {
    const { tokens } = tokenize("12cm 0.9m -3 4.5deg");
    expect(tokens.slice(0, 4).map((t) => [t.numValue, t.unit])).toEqual([
      [12, "cm"],
      [0.9, "m"],
      [-3, undefined],
      [4.5, "deg"],
    ]);
  });

  it("does not swallow identifiers that start with a unit word", () => {
    const { tokens } = tokenize("4min");
    // "4min" isn't a valid number+unit ("min" isn't a unit) nor pure digits,
    // so it should NOT be parsed as a clean number token consuming "min".
    expect(tokens[0]!.type).toBe("number");
    expect(tokens[0]!.text).toBe("4");
  });

  it("parses strings with escapes", () => {
    const { tokens } = tokenize('"hello \\"world\\""');
    expect(tokens[0]!.strValue).toBe('hello "world"');
  });

  it("flags unterminated strings", () => {
    const { diagnostics } = tokenize('"unterminated');
    expect(diagnostics.some((d) => d.code === "unterminated-string")).toBe(true);
  });

  it("parses colors of valid lengths", () => {
    const { tokens } = tokenize("#fff #8a5a2b #12345678");
    expect(tokens.filter((t) => t.type === "color").map((t) => t.colorValue)).toEqual(["#fff", "#8a5a2b", "#12345678"]);
  });

  it("treats an invalid hex run as a line comment", () => {
    const { tokens } = tokenize("# this is a comment\nident");
    expect(tokens.map((t) => t.type)).toEqual(["ident", "eof"]);
  });

  it("supports // line comments", () => {
    const { tokens } = tokenize("box // a comment\nsphere");
    expect(tokens.map((t) => t.type)).toEqual(["ident", "ident", "eof"]);
  });

  it("tracks line and column numbers", () => {
    const { tokens } = tokenize("a\n  b");
    const b = tokens[1]!;
    expect(b.start.line).toBe(2);
    expect(b.start.col).toBe(3);
  });

  it("reports unexpected characters without stopping", () => {
    const { tokens, diagnostics } = tokenize("a $ b");
    expect(diagnostics).toHaveLength(1);
    expect(tokens.map((t) => t.type)).toEqual(["ident", "ident", "eof"]);
  });
});
