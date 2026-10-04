import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { NODE_TYPES, validateStatements } from "../src/dsl/schema.js";

function diagsFor(source: string) {
  const { ast, diagnostics } = parseWorldFile(source);
  expect(diagnostics).toHaveLength(0); // these fixtures should all be syntactically valid
  return validateStatements(ast.statements);
}

describe("schema validation", () => {
  it("accepts a well-formed world", () => {
    const diags = diagsFor('world { name: "W" }\nasset a { source: "a.glb" }\ngroup g { model m { asset: a, size: 1 1 1 } }');
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("flags an unknown node type with a suggestion", () => {
    const diags = diagsFor("gruop g { at: 0 0 0 }");
    expect(diags[0]?.code).toBe("unknown-type");
    expect(diags[0]?.message).toContain('did you mean "group"?');
  });

  it("flags an unknown property with a suggestion", () => {
    const diags = diagsFor("trigger t { radius: 2, heigth: 3 }");
    expect(diags.some((d) => d.code === "unknown-property" && d.message.includes('"height"'))).toBe(true);
  });

  it("flags a property not valid on this node type", () => {
    const diags = diagsFor('asset a { source: "a.glb", at: 0 0 0 }');
    expect(diags.some((d) => d.code === "property-not-allowed")).toBe(true);
  });

  it("enforces size arity per node type", () => {
    const diags = diagsFor('minimap { source: "m.png", at: 0 0, size: 1 2 3 }');
    expect(diags.some((d) => d.code === "bad-arity")).toBe(true);
  });

  it("enforces at-arity", () => {
    const diags = diagsFor("spawn { at: 1 2 }");
    expect(diags.some((d) => d.code === "bad-arity")).toBe(true);
  });

  it("requires a name where one addresses the node", () => {
    const diags = diagsFor('asset { source: "a.glb" }');
    expect(diags.some((d) => d.code === "missing-name")).toBe(true);
  });

  it("rejects nested nodes inside a leaf type", () => {
    const diags = diagsFor('asset a { source: "a.glb"\n group g { } }');
    expect(diags.some((d) => d.code === "children-not-allowed")).toBe(true);
  });

  it("rejects a child type not allowed in this parent", () => {
    const diags = diagsFor('group g { asset a { source: "a.glb" } }');
    expect(diags.some((d) => d.code === "type-not-allowed-here")).toBe(true);
  });

  it("flags duplicate names in the same scope", () => {
    const diags = diagsFor('asset a { source: "a.glb" }\nasset a { source: "b.glb" }');
    expect(diags.some((d) => d.code === "duplicate-name")).toBe(true);
  });

  it("flags a wrong unit category", () => {
    const diags = diagsFor("trigger t { radius: 2, rotate: 90cm }");
    expect(diags.some((d) => d.code === "wrong-unit-category")).toBe(true);
  });

  it("flags a unit on a unitless property", () => {
    const diags = diagsFor("light sun { type: point, intensity: 0.5m }");
    expect(diags.some((d) => d.code === "unexpected-unit")).toBe(true);
  });

  it("flags an invalid enum value with a suggestion", () => {
    const diags = diagsFor("light sun { type: directonal }");
    expect(diags.some((d) => d.code === "bad-enum-value" && d.message.includes("directional"))).toBe(true);
  });

  it("warns (not errors) on duplicate properties", () => {
    const diags = diagsFor("trigger t { radius: 1, radius: 2 }");
    const dup = diags.find((d) => d.code === "duplicate-property");
    expect(dup?.severity).toBe("warning");
  });

  it("accepts a whole imported-map header", () => {
    const diags = diagsFor(`
      world { name: "Dome", category: "MW3 Multiplayer", sky: #b9c6d4, visibility: 600, exposure: 0.35 }
      grade { light-tint: 1.6 1.6 1.4, desaturation: 0.19 }
      asset world_shell { source: "assets/world.glb" }
      group map {
        at: 0 0 0
        model shell { asset: world_shell, at: 0 0 0, size: 2781 68 2423, collide: false, lightmap: "assets/lightmap.png" }
      }
      collision { source: "assets/collision.glb" }
      light sun { type: directional, at: 6 9 4, intensity: 1.3, shadows: on }
      spawn { mode: "tdm", team: "axis", start: on, at: 21.3 -9.6 12.7, look: 21.0 -9.6 11.7 }
      trigger hill { at: 0 0 0, radius: 4, height: 3, tag: "dom_a" }
    `);
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
  });
});

describe("colour schema", () => {
  // They lex as colours, but three.js reads neither and renders white.
  it.each(["#f008", "#ff000080"])("rejects the alpha colour %s", (hex) => {
    const diags = diagsFor(`light l { type: point, color: ${hex} }`);
    expect(diags.some((d) => d.code === "color-alpha-unsupported")).toBe(true);
  });

  it.each(["#f00", "#ff0000"])("accepts the opaque colour %s", (hex) => {
    const diags = diagsFor(`light l { type: point, color: ${hex} }`);
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  // A bare lookup in the registries answers for Object.prototype's members, which
  // handed validation `Object` as a node spec and threw.
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])("reports %s as an unknown node type instead of throwing", (name) => {
    const diags = diagsFor(`${name} { at: 0 0 0 }`);
    expect(diags.some((d) => d.code === "unknown-type")).toBe(true);
  });

  it.each(["__proto__", "constructor", "toString"])("reports %s as an unknown property instead of throwing", (name) => {
    const diags = diagsFor(`trigger t { radius: 1, ${name}: 2 }`);
    expect(diags.some((d) => d.code === "unknown-property")).toBe(true);
  });
});

describe("blocks a world holds one of", () => {
  const sources: Record<string, string> = {
    world: 'world { name: "W" }',
    grade: "grade { desaturation: 0.1 }",
    collision: 'collision { source: "c.glb" }',
    navigation: 'navigation { source: "nav.bin" }',
    fx: 'fx { source: "fx.json" }',
    sounds: 'sounds { source: "sounds.json" }',
    minimap: 'minimap { source: "m.png", at: 0 0, size: 1 1 }',
  };

  it.each(Object.keys(sources))("warns on a second %s block", (type) => {
    const diags = diagsFor(`${sources[type]}\n${sources[type]}`);
    expect(diags.map((d) => d.code)).toContain(`duplicate-${type}`);
  });

  it("warns on a second behaviours block in one model", () => {
    const diags = diagsFor("model { asset: a, behaviours { health { amount: 1 } }\n behaviours { health { amount: 2 } } }");
    expect(diags.map((d) => d.code)).toContain("duplicate-behaviours");
  });

  // The resolver reads these with `find()`, so a second one is dropped without a
  // word unless its spec says `singleton`.
  it("marks every block the resolver reads only the first of", () => {
    const dir = path.resolve(import.meta.dirname, "../src/dsl");
    const read = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((f) => /^resolve.*\.ts$/.test(f))) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      for (const m of text.matchAll(/\.find\(\(s\): s is ObjectNode => isObjectNode\(s\) && s\.type === "(\w+)"\)/g)) {
        read.add(m[1]!);
      }
    }
    expect(read.size).toBeGreaterThan(0);
    const singletons = Object.values(NODE_TYPES)
      .filter((spec) => spec.singleton)
      .map((spec) => spec.type);
    expect(singletons.sort()).toEqual([...read].sort());
    for (const type of Object.keys(sources)) {
      expect(read).toContain(type);
    }
  });
});
