import { describe, expect, it } from "vitest";
import { loadWorld, joinPath } from "../src/dsl/loader.js";
import { validateStatements } from "../src/dsl/schema.js";

describe("joinPath", () => {
  it("joins and normalizes relative paths", () => {
    expect(joinPath("worlds/office", "./meeting-rooms.world")).toBe("worlds/office/meeting-rooms.world");
    expect(joinPath("worlds/office", "../shared/materials.world")).toBe("worlds/shared/materials.world");
  });
});

describe("loadWorld", () => {
  it("expands a single include into the merged statement list", () => {
    const sources = {
      "world.world": 'world { name: "Office" }\ninclude "props.world"\nspawn { at: 0 1.7 0 }',
      "props.world": 'asset lobby { source: "lobby.glb" }',
    };
    const { statements, diagnostics } = loadWorld("world.world", sources);
    expect(diagnostics).toHaveLength(0);
    expect(statements.map((s) => (s.kind === "node" ? s.type : s.kind))).toEqual(["world", "asset", "spawn"]);
    expect(validateStatements(statements).filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("detects a circular include", () => {
    const sources = {
      "a.world": 'include "b.world"',
      "b.world": 'include "a.world"',
    };
    const { diagnostics } = loadWorld("a.world", sources);
    expect(diagnostics.some((d) => d.code === "circular-include")).toBe(true);
  });

  it("reports a missing include target", () => {
    const { diagnostics } = loadWorld("a.world", { "a.world": 'include "missing.world"' });
    expect(diagnostics.some((d) => d.code === "include-not-found")).toBe(true);
  });

  it("includes a file only once even if included from two places", () => {
    const sources = {
      "a.world": 'include "shared.world"\ninclude "shared.world"',
      "shared.world": "material oak { color: #8a5a2b }",
    };
    const { statements } = loadWorld("a.world", sources);
    expect(statements).toHaveLength(1);
  });
});
