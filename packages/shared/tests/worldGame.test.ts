// `world { game: }`: which Call of Duty a world was imported from.
//
// It is the engine's channel for a fact that used to exist only in
// `export_metadata.json`, which the engine may never read, and in the prose of
// `category:`. What reads it is the cast a gametype picks, so the value has to be
// the catalogue's own zone key and nothing looser.

import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";

function resolve(source: string) {
  const { ast, diagnostics } = parseWorldFile(source);
  expect(diagnostics).toHaveLength(0);
  return resolveWorld(ast.statements);
}

const codes = (source: string) => resolve(source).diagnostics.map((d) => d.code);

describe("world game", () => {
  it("carries every zone key the catalogue has a folder for", () => {
    for (const key of ["iw4", "iw5", "iw6", "t5", "t6", "s1"] as const) {
      const result = resolve(`world { name: "W", game: ${key} }`);
      expect(hasErrors(result.diagnostics)).toBe(false);
      expect(result.world?.game).toBe(key);
    }
  });

  it("is optional: a hand-written world declares none", () => {
    const result = resolve(`world { name: "W" }`);
    expect(hasErrors(result.diagnostics)).toBe(false);
    expect(result.world?.game).toBeUndefined();
  });

  // The friendly name is what `category:` carries; this property is the zone key,
  // so that a world's `game:` and `catalog/<kind>/<game>/` compare without a table.
  it("refuses a game it has no catalogue folder for", () => {
    expect(codes(`world { name: "W", game: mw3 }`)).toContain("bad-enum-value");
  });

  // Bare word, as every other enum in the DSL is written (`kind: onto`,
  // `type: directional`) — the exporter got this wrong once.
  it("refuses a quoted string", () => {
    expect(codes(`world { name: "W", game: "iw5" }`)).toContain("bad-value-kind");
  });
});
