// `navigation`: the world's path-node graph, named as one file.
//
// The node only names a `nav.bin`; what is in it is navFormat.test.ts. A world
// without one resolves with no navigation at all, which is what a map whose game
// ships no path nodes is.

import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";

function resolve(source: string) {
  const { ast, diagnostics } = parseWorldFile(source);
  expect(diagnostics).toHaveLength(0);
  return resolveWorld(ast.statements);
}

function resolveOk(source: string) {
  const result = resolve(source);
  if (hasErrors(result.diagnostics)) {
    throw new Error("unexpected errors: " + result.diagnostics.map((d) => d.message).join("; "));
  }
  return result.world!;
}

const codes = (source: string) => resolve(source).diagnostics.map((d) => d.code);

const NAV = `navigation { source: "assets/nav.bin" }`;

describe("the navigation graph", () => {
  it("is read off the world, like collision", () => {
    expect(resolveOk(NAV).navigation).toEqual({ source: "assets/nav.bin" });
  });

  it("is absent when the world declares none", () => {
    expect(resolveOk(`world { name: "w" }`).navigation).toBeUndefined();
  });

  it("needs a source", () => {
    expect(codes(`navigation { }`)).toContain("missing-property");
  });

  it("takes nothing but a source", () => {
    expect(codes(`navigation { source: "assets/nav.bin", at: 0 0 0 }`)).toContain("property-not-allowed");
    expect(codes(`navigation { source: "assets/nav.bin", nodes: 3 }`)).toContain("unknown-property");
  });

  it("is one per world, and the first is the one read", () => {
    const result = resolve(`${NAV}\nnavigation { source: "assets/other.bin" }`);
    expect(result.diagnostics.map((d) => d.code)).toContain("duplicate-navigation");
    expect(result.world?.navigation).toEqual({ source: "assets/nav.bin" });
  });

  it("belongs at the top level, not in a group", () => {
    expect(hasErrors(resolve(`group g { ${NAV} }`).diagnostics)).toBe(true);
  });
});
