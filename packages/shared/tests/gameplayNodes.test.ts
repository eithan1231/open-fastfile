// The gameplay nodes: `behaviours` on a placement, qualified `spawn` points,
// and `trigger` volumes. What each one *means* is the server's business; these
// only check that a world file can say it and that resolve carries it through.

import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";
import { worldObjects } from "../src/worlds/worldIndex.js";
import { spawnPoints } from "../src/sim/worldRules.js";

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

describe("behaviours", () => {
  it("carries health and destructible onto the placement", () => {
    const world = resolveOk(`
      asset crate { source: "crate.glb" }
      group g { model { asset: crate, size: 1 1 1
        behaviours {
          health { amount: 100 }
          destructible { preset: "toy_electricbox4" }
        }
      } }
    `);
    const [object] = worldObjects(world);
    expect(object!.behaviours?.health?.amount).toBe(100);
    expect(object!.behaviours?.destructible?.preset).toBe("toy_electricbox4");
  });

  it("is absent when the placement declares none", () => {
    const world = resolveOk(`asset a { source: "a.glb" }\ngroup g { model { asset: a, size: 1 1 1 } }`);
    expect(worldObjects(world)[0]!.behaviours).toBeUndefined();
  });

  it("works on any placement", () => {
    const world = resolveOk(`asset a { source: "a.glb" }\ngroup g { model { asset: a, size: 1 1 1, behaviours { health { amount: 5 } } } }`);
    expect(worldObjects(world)[0]!.behaviours?.health?.amount).toBe(5);
  });

  it("rejects health that is not a positive amount", () => {
    expect(codes(`asset a { source: "a.glb" }\ngroup g { model { asset: a, size: 1 1 1, behaviours { health { amount: 0 } } } }`)).toContain("bad-health");
  });

  it("warns about a block that would do nothing", () => {
    expect(codes(`asset a { source: "a.glb" }\ngroup g { model { asset: a, size: 1 1 1, behaviours { } } }`)).toContain("empty-behaviours");
  });

  /** The reason behaviours are a block: `type` already belongs to `light`. */
  it("keeps behaviour properties out of the placement's namespace", () => {
    expect(codes(`asset a { source: "a.glb" }\ngroup g { model { asset: a, size: 1 1 1, amount: 5 } }`)).toContain("property-not-allowed");
  });

  it("rejects a behaviour the registry does not know", () => {
    expect(codes(`asset a { source: "a.glb" }\ngroup g { model { asset: a, size: 1 1 1, behaviours { flammable { amount: 1 } } } }`)).not.toHaveLength(0);
  });
});

describe("spawn points", () => {
  it("keeps a lone unqualified spawn as the fallback, exactly as before", () => {
    const world = resolveOk(`spawn { at: 1 2 3 }`);
    expect(world.spawn.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(world.spawnPoints).toHaveLength(1);
    expect(world.spawnPoints[0]!.modes).toBeUndefined();
    expect(world.spawnPoints[0]!.start).toBe(false);
  });

  it("collects every spawn, with its mode, team and start flag", () => {
    const world = resolveOk(`
      spawn { mode: "tdm", team: "allies", start: on, at: 1 0 0 }
      spawn { mode: "tdm", team: "axis", at: 2 0 0 }
      spawn { mode: "dom", at: 3 0 0 }
    `);
    expect(world.spawnPoints.map((s) => [s.modes, s.team, s.start])).toEqual([
      [["tdm"], "allies", true],
      [["tdm"], "axis", false],
      [["dom"], undefined, false],
    ]);
  });

  /** A world of only qualified spawns still has to put a player somewhere. */
  it("falls back to the first spawn when every one is qualified", () => {
    const world = resolveOk(`
      spawn { mode: "tdm", team: "allies", at: 7 0 0 }
      spawn { mode: "tdm", team: "axis", at: 9 0 0 }
    `);
    expect(world.spawn.position.x).toBe(7);
  });

  it("prefers an unqualified spawn over an earlier qualified one", () => {
    const world = resolveOk(`
      spawn { mode: "tdm", at: 7 0 0 }
      spawn { at: 4 0 0 }
    `);
    expect(world.spawn.position.x).toBe(4);
  });

  it("still derives a spawn for a world that declares none", () => {
    const world = resolveOk(`world { name: "W" }`);
    expect(world.spawnPoints).toHaveLength(0);
    expect(world.spawn.position.y).toBeCloseTo(1.7);
  });
});

describe("triggers", () => {
  it("resolves a box trigger to world space, with its name and tag", () => {
    const world = resolveOk(`trigger gate { at: 2 0 -3, size: 4 3 2, tag: "bombzone" }`);
    expect(world.triggers).toHaveLength(1);
    const [trigger] = world.triggers;
    expect(trigger!.name).toBe("gate");
    expect(trigger!.tags).toEqual(["bombzone"]);
    expect(trigger!.position).toEqual({ x: 2, y: 0, z: -3 });
    expect(trigger!.size).toEqual({ x: 4, y: 3, z: 2 });
    expect(trigger!.radius).toBeUndefined();
  });

  it("resolves a sphere trigger, and a cylinder when given a height", () => {
    const world = resolveOk(`
      trigger ball { at: 0 0 0, radius: 5 }
      trigger post { at: 1 0 0, radius: 2, height: 8 }
    `);
    expect(world.triggers[0]!.radius).toBe(5);
    expect(world.triggers[0]!.height).toBeUndefined();
    expect(world.triggers[1]!.height).toBe(8);
  });

  it("takes a group's origin and yaw, like anything else placed in one", () => {
    const world = resolveOk(`group g { at: 10 0 0, rotate: 90, trigger inner { at: 1 0 0, size: 1 1 1 } }`);
    const [trigger] = world.triggers;
    expect(trigger!.position.x).toBeCloseTo(10);
    expect(trigger!.position.z).toBeCloseTo(-1);
    expect(trigger!.yaw).toBeCloseTo(Math.PI / 2);
  });

  it("refuses a trigger that is both a box and a sphere, or neither", () => {
    expect(codes(`trigger both { at: 0 0 0, size: 1 1 1, radius: 2 }`)).toContain("trigger-shape");
    expect(codes(`trigger neither { at: 0 0 0 }`)).toContain("trigger-shape");
  });

  it("warns that a box trigger's height does nothing", () => {
    expect(codes(`trigger box1 { at: 0 0 0, size: 1 1 1, height: 3 }`)).toContain("unused-height");
  });

  /** Objects keep [0, n); a trigger's id sits past the end of them. */
  it("is numbered after every object", () => {
    const world = resolveOk(`
      asset x { source: "x.glb" }
      group g { model a { asset: x, size: 1 1 1 }  model b { asset: x, size: 1 1 1 } }
      trigger t { at: 0 0 0, radius: 1 }
    `);
    expect(worldObjects(world).map((o) => o.id)).toEqual([0, 1]);
    expect(world.triggers[0]!.id).toBe(2);
  });
});

describe("spawnPoints", () => {
  const WORLD = `
    spawn { mode: "tdm", team: "allies", start: on, at: 1 0 0 }
    spawn { mode: "tdm", team: "allies", at: 2 0 0 }
    spawn { mode: "tdm", team: "axis", start: on, at: 3 0 0 }
    spawn { mode: "dom", at: 4 0 0 }
  `;
  const xs = (world: ReturnType<typeof resolveOk>, query: Parameters<typeof spawnPoints>[1]) => spawnPoints(world, query).map((s) => s.position.x);

  it("narrows to mode, team and start together", () => {
    expect(xs(resolveOk(WORLD), { mode: "tdm", team: "allies", start: true })).toEqual([1]);
  });

  it("drops the start constraint before giving up", () => {
    expect(xs(resolveOk(WORLD), { mode: "tdm", team: "axis", start: false })).toEqual([3]);
  });

  /** A mode the map never anticipated must still put a player somewhere. */
  it("widens rather than returning nothing for an unknown mode", () => {
    expect(xs(resolveOk(WORLD), { mode: "koth" })).toHaveLength(4);
  });

  it("treats an unqualified spawn as belonging to every mode", () => {
    expect(xs(resolveOk(`spawn { at: 5 0 0 }`), { mode: "tdm", team: "allies" })).toEqual([5]);
  });

  it("is empty only when the world declared no spawns at all", () => {
    expect(spawnPoints(resolveOk(`world { name: "W" }`), { mode: "tdm" })).toHaveLength(0);
  });
});
