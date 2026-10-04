import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import type { ObjectNode, PropertyNode } from "../src/dsl/ast.js";

describe("parser", () => {
  it("parses a node with a name and properties", () => {
    const { ast, diagnostics } = parseWorldFile("room living {\n  size: 6 4.5\n  floor: oak\n}");
    expect(diagnostics).toHaveLength(0);
    expect(ast.statements).toHaveLength(1);
    const room = ast.statements[0] as ObjectNode;
    expect(room.type).toBe("room");
    expect(room.name).toBe("living");
    expect(room.body).toHaveLength(2);
    const size = room.body[0] as PropertyNode;
    expect(size.key).toBe("size");
    expect(size.values.map((v) => (v.kind === "number" ? v.value : undefined))).toEqual([6, 4.5]);
  });

  it("stops a value list at a comma, keeping same-line properties distinct", () => {
    const { ast, diagnostics } = parseWorldFile("door north { at: 1.5, width: 0.9, height: 2.1 }");
    expect(diagnostics).toHaveLength(0);
    const door = ast.statements[0] as ObjectNode;
    expect(door.body).toHaveLength(3);
    for (const stmt of door.body) {
      const p = stmt as PropertyNode;
      expect(p.values).toHaveLength(1);
    }
  });

  it("stops a value list at a newline, not swallowing the next property", () => {
    const { ast, diagnostics } = parseWorldFile("room living {\n  size: 6 4.5\n  height: 2.7\n}");
    expect(diagnostics).toHaveLength(0);
    const room = ast.statements[0] as ObjectNode;
    const size = room.body[0] as PropertyNode;
    const height = room.body[1] as PropertyNode;
    expect(size.values).toHaveLength(2);
    expect(height.key).toBe("height");
    expect(height.values).toHaveLength(1);
  });

  it("parses dotted references", () => {
    const { ast, diagnostics } = parseWorldFile("box sofa { against: living.south }");
    expect(diagnostics).toHaveLength(0);
    const box = ast.statements[0] as ObjectNode;
    const against = box.body[0] as PropertyNode;
    expect(against.values[0]).toMatchObject({ kind: "ref", path: ["living", "south"] });
  });

  it("parses bool keywords true/false/on/off", () => {
    const { ast } = parseWorldFile("light sun { shadows: on }\nbox b { visible: false }");
    const light = ast.statements[0] as ObjectNode;
    const box = ast.statements[1] as ObjectNode;
    expect((light.body[0] as PropertyNode).values[0]).toMatchObject({ kind: "bool", value: true });
    expect((box.body[0] as PropertyNode).values[0]).toMatchObject({ kind: "bool", value: false });
  });

  it("parses include statements", () => {
    const { ast, diagnostics } = parseWorldFile('include "rooms/kitchen.world"');
    expect(diagnostics).toHaveLength(0);
    expect(ast.statements[0]).toMatchObject({ kind: "include", path: "rooms/kitchen.world" });
  });

  it("recovers from a syntax error and keeps parsing", () => {
    const { ast, diagnostics } = parseWorldFile("box a { size 1 2 3 }\nbox b { size: 1 1 1 }");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(ast.statements).toHaveLength(2);
    expect((ast.statements[1] as ObjectNode).name).toBe("b");
  });

  it("reports an unclosed brace", () => {
    const { diagnostics } = parseWorldFile("room living {\n  size: 6 4.5\n");
    expect(diagnostics.some((d) => d.code === "expected-rbrace")).toBe(true);
  });

  it("parses a node with no body and no name", () => {
    const { ast, diagnostics } = parseWorldFile("spawn\nlight sun { type: directional }");
    expect(diagnostics).toHaveLength(0);
    expect(ast.statements).toHaveLength(2);
    expect((ast.statements[0] as ObjectNode).body).toHaveLength(0);
  });
});
