// `fx` and `effect`: the effect library a world draws from, and where it plays.
//
// The two things a reader depends on: that a world file can say it, and that a
// placement inside a turned group lands where the exporter meant. The second is
// the one that fails quietly — an effect in the wrong place is still an effect.

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

describe("the fx library", () => {
  it("is read off the world, like the collision mesh", () => {
    const world = resolveOk(`fx { source: "assets/fx/effects.json" }`);
    expect(world.fx).toEqual({ source: "assets/fx/effects.json" });
  });

  it("is absent when the world declares none", () => {
    expect(resolveOk(`world { name: "w" }`).fx).toBeUndefined();
    expect(resolveOk(`world { name: "w" }`).effects).toEqual([]);
  });

  it("needs a source", () => {
    expect(codes(`fx { }`)).toContain("missing-property");
  });
});

describe("an effect placement", () => {
  it("carries its effect name, position and delay", () => {
    const world = resolveOk(`effect storm { fx: "weather/sand_storm", at: 1 2 3, delay: -15 }`);
    expect(world.effects).toHaveLength(1);
    const e = world.effects[0]!;
    expect(e.name).toBe("storm");
    expect(e.fx).toBe("weather/sand_storm");
    expect(e.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(e.delay).toBe(-15);
  });

  it("defaults to no delay", () => {
    expect(resolveOk(`effect e { fx: "a/b", at: 0 0 0 }`).effects[0]!.delay).toBe(0);
  });

  it("repeats only when asked, and never at a negative interval", () => {
    expect(resolveOk(`effect e { fx: "a/b", at: 0 0 0 }`).effects[0]!.repeat).toBe(0);
    expect(resolveOk(`effect e { fx: "a/b", at: 0 0 0, delay: 1.5, repeat: 1.5 }`).effects[0]!.repeat).toBe(1.5);
    expect(resolveOk(`effect e { fx: "a/b", at: 0 0 0, repeat: -2 }`).effects[0]!.repeat).toBe(0);
  });

  it("needs an effect to play", () => {
    expect(codes(`effect e { at: 0 0 0 }`)).toContain("missing-property");
  });

  it("keeps all three rotation axes: a sand spray is aimed, not just turned", () => {
    const e = resolveOk(`effect e { fx: "a/b", at: 0 0 0, rotate: 90 180 270 }`).effects[0]!;
    expect(e.rotation.x).toBeCloseTo(Math.PI / 2);
    expect(e.rotation.y).toBeCloseTo(Math.PI);
    expect(e.rotation.z).toBeCloseTo((3 * Math.PI) / 2);
  });

  it("is placed through its group's origin and yaw", () => {
    const world = resolveOk(`
      group g {
        at: 10 0 0
        rotate: 0 90 0
        effect e { fx: "a/b", at: 2 0 0 }
      }
    `);
    const e = world.effects[0]!;
    // A quarter turn about +Y takes local +X to -Z, then the group's origin.
    expect(e.position.x).toBeCloseTo(10);
    expect(e.position.y).toBeCloseTo(0);
    expect(e.position.z).toBeCloseTo(-2);
    expect(e.rotation.y).toBeCloseTo(Math.PI / 2);
  });

  it("resolves in declaration order", () => {
    const world = resolveOk(`
      effect a { fx: "x/a", at: 0 0 0 }
      effect b { fx: "x/b", at: 1 0 0 }
      effect c { fx: "x/c", at: 2 0 0 }
    `);
    expect(world.effects.map((e) => e.fx)).toEqual(["x/a", "x/b", "x/c"]);
  });

  it("does not disturb the ids of anything that existed before it", () => {
    // Entity ids cross the wire (net/messages/session.ts), so effects are
    // numbered last. Renumbering an object or a trigger is a protocol break.
    const source = `
      asset a { source: "a.glb" }
      group g { model m { asset: a, at: 0 0 0, size: 1 1 1 } }
      trigger t { at: 0 0 0, size: 1 1 1 }
      mantle k { at: 0 0 0, size: 1 1 1 }
    `;
    const without = resolveOk(source);
    const with_ = resolveOk(source + `\n effect e { fx: "x/a", at: 0 0 0 }`);

    expect(with_.topLevelObjects.map((o) => o.id)).toEqual(without.topLevelObjects.map((o) => o.id));
    expect(without.topLevelObjects.length).toBeGreaterThan(0);
    expect(with_.triggers.map((t) => t.id)).toEqual(without.triggers.map((t) => t.id));
    expect(with_.mantles.map((m) => m.id)).toEqual(without.mantles.map((m) => m.id));
    // and the effect is numbered past all of them
    const highest = Math.max(...without.triggers.map((t) => t.id), ...without.mantles.map((m) => m.id));
    expect(with_.effects[0]!.id).toBeGreaterThan(highest);
  });

  it("rejects a property that belongs to another node", () => {
    expect(codes(`effect e { fx: "a/b", at: 0 0 0, radius: 3 }`)).toContain("property-not-allowed");
  });
});

describe("the shared volume walker", () => {
  it("does not spend an id on a node it rejects", () => {
    // The walker mints ids inside each node's own builder, so a rejected node
    // must return before the literal that increments the counter. Get that wrong
    // and every id after a single bad volume shifts by one — which, since ids
    // cross the wire, is a protocol break that no test of a valid world sees.
    const good = `mantle k { at: 0 0 0, size: 1 1 1 }`;
    const bad = `mantle bad { at: 0 0 0, size: 1 0 1 }`;

    const alone = resolveOk(good);
    const after = resolve(bad + "\n" + good);

    expect(after.world!.mantles).toHaveLength(1);
    expect(after.world!.mantles[0]!.id).toBe(alone.mantles[0]!.id);
  });

  it("places triggers, mantles and effects alike through a nested group", () => {
    // One walker serves all three; this is what would break if it regressed.
    const world = resolveOk(`
      group outer {
        at: 10 0 0
        group inner {
          at: 0 0 5
          trigger t { at: 1 0 0, size: 1 1 1 }
          mantle k { at: 1 0 0, size: 1 1 1 }
          effect e { fx: "x/a", at: 1 0 0 }
        }
      }
    `);
    const at = { x: 11, y: 0, z: 5 };
    expect(world.triggers[0]!.position).toEqual(at);
    expect(world.mantles[0]!.position).toEqual(at);
    expect(world.effects[0]!.position).toEqual(at);
  });
});
