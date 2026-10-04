// The generic primitives a scripted mode is built from: several `mode`s and
// `tag`s on one node, `target`, `use`, `point` and `solid`. What any of it means
// is a script's; these check that a world can say it and resolve carries it.

import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";
import { indexWorld, worldObjects } from "../src/worlds/worldIndex.js";
import { presentIn, spawnPoints } from "../src/sim/worldRules.js";

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

const diagnosticsOf = (source: string) => resolve(source).diagnostics.map((d) => [d.severity, d.code]);
const codes = (source: string) => resolve(source).diagnostics.map((d) => d.code);

const COLLISION = `collision { source: "assets/collision.glb" }`;

describe("mode", () => {
  it("takes several values, on every node that has it", () => {
    const world = resolveOk(`
      ${COLLISION}
      asset a { source: "a.glb" }
      group g { model { asset: a, size: 1 1 1, mode: "gun" "hlnd" "oic" "shrp" } }
      spawn { at: 0 0 0, mode: "tdm" "dm" }
      trigger t { at: 0 0 0, radius: 1, mode: "dom" }
      point p { at: 1 2 3, mode: "sd" "dd" }
      solid { part: "*12", mode: "sd" "dd" }
    `);
    expect(worldObjects(world)[0]!.modes).toEqual(["gun", "hlnd", "oic", "shrp"]);
    expect(world.spawnPoints[0]!.modes).toEqual(["tdm", "dm"]);
    expect(world.triggers[0]!.modes).toEqual(["dom"]);
    expect(world.points[0]!.modes).toEqual(["sd", "dd"]);
    expect(world.solids[0]!.modes).toEqual(["sd", "dd"]);
  });

  it("is undefined when absent, which is every mode rather than none", () => {
    const world = resolveOk(`trigger t { at: 0 0 0, radius: 1 }\npoint { at: 0 0 0 }`);
    expect(world.triggers[0]!.modes).toBeUndefined();
    expect(world.points[0]!.modes).toBeUndefined();
  });

  it("is not a group's to set", () => {
    expect(codes(`group g { mode: "tdm" }`)).toContain("property-not-allowed");
  });
});

describe("presentIn", () => {
  it("puts an untagged node in every mode, Free Roam included", () => {
    expect(presentIn(undefined, "tdm")).toBe(true);
    expect(presentIn(undefined, undefined)).toBe(true);
  });

  it("leaves a tagged node out of Free Roam", () => {
    expect(presentIn(["sd"], undefined)).toBe(false);
  });

  it("puts a tagged node in any of its modes, and only those", () => {
    expect(presentIn(["sd", "dd"], "dd")).toBe(true);
    expect(presentIn(["sd", "dd"], "tdm")).toBe(false);
  });
});

describe("spawnPoints over several modes", () => {
  const WORLD = `
    spawn { mode: "tdm" "dm", at: 1 0 0 }
    spawn { mode: "dom", at: 2 0 0 }
    spawn { at: 3 0 0 }
  `;
  const xs = (mode: string) => spawnPoints(resolveOk(WORLD), { mode }).map((s) => s.position.x);

  it("matches a spawn if any of its modes is the one asked for", () => {
    expect(xs("dm")).toEqual([1, 3]);
    expect(xs("tdm")).toEqual([1, 3]);
    expect(xs("dom")).toEqual([2, 3]);
  });
});

describe("tag", () => {
  it("takes up to eight values, and none reads as empty", () => {
    const world = resolveOk(`
      point { at: 0 0 0, tag: "foyer_zone_spawners" "zombie_spawner" "riser" }
      point { at: 1 0 0 }
    `);
    expect(world.points[0]!.tags).toEqual(["foyer_zone_spawners", "zombie_spawner", "riser"]);
    expect(world.points[1]!.tags).toEqual([]);
    expect(codes(`point { at: 0 0 0, tag: "1" "2" "3" "4" "5" "6" "7" "8" "9" }`)).toContain("bad-arity");
  });

  it("is indexed under each of its values", () => {
    const index = indexWorld(
      resolveOk(`
        asset a { source: "a.glb" }
        group g {
          model one { asset: a, size: 1 1 1, tag: "crate" "red" }
          model two { asset: a, size: 1 1 1, tag: "crate" }
        }
      `),
    );
    expect(index.byTag.get("crate")!.map((id) => index.objects[id]!.name)).toEqual(["one", "two"]);
    expect(index.byTag.get("red")!.map((id) => index.objects[id]!.name)).toEqual(["one"]);
  });
});

describe("target", () => {
  it("names a tag, and resolves with no diagnostic when something carries it", () => {
    const result = resolve(`
      trigger foyer { at: 0 0 0, size: 4 3 4, tag: "foyer_zone", target: "foyer_zone_spawners" }
      point { at: 9 0 0, tag: "foyer_zone_spawners" "riser" }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.world!.triggers[0]!.target).toBe("foyer_zone_spawners");
  });

  it("finds the tag on any kind of node, not only another trigger or point", () => {
    expect(resolve(`${COLLISION}\ntrigger d { at: 0 0 0, radius: 1, target: "door" }\nsolid { part: "*3", tag: "door" }`).diagnostics).toEqual([]);
  });

  /** Nothing breaks, so not an error — but a link to nothing is nearly always a typo. */
  it("warns when no node carries the tag", () => {
    expect(diagnosticsOf(`point { at: 0 0 0, tag: "spawners", target: "spawner" }`)).toEqual([["warning", "unknown-target"]]);
    expect(resolve(`point { at: 0 0 0, tag: "spawners", target: "spawner" }`).diagnostics[0]!.message).toContain('did you mean "spawners"');
  });

  it("takes exactly one tag", () => {
    expect(codes(`point { at: 0 0 0, target: "a" "b" }`)).toContain("bad-arity");
  });

  it("is not on a node that points at nothing", () => {
    expect(codes(`${COLLISION}\nsolid { part: "*1", target: "x" }`)).toContain("property-not-allowed");
  });
});

describe("use", () => {
  it("is look or touch, on a trigger or a solid", () => {
    const world = resolveOk(`
      ${COLLISION}
      trigger buy { at: 0 0 0, size: 1 2 1, use: near }
      trigger step { at: 0 0 0, size: 1 2 1, use: touch }
      trigger zone { at: 0 0 0, size: 1 2 1 }
      solid { part: "*4", use: near }
    `);
    expect(world.triggers.map((t) => t.use)).toEqual(["near", "touch", undefined]);
    expect(world.solids[0]!.use).toBe("near");
  });

  it("refuses anything else", () => {
    expect(codes(`trigger t { at: 0 0 0, radius: 1, use: press }`)).toContain("bad-enum-value");
    expect(codes(`point { at: 0 0 0, use: near }`)).toContain("property-not-allowed");
  });
});

describe("point", () => {
  it("resolves its position, facing, name and tags", () => {
    const world = resolveOk(`point riser_1 { at: 1 2 3, look: 1 2 0, tag: "riser" }`);
    const [point] = world.points;
    expect(point!.name).toBe("riser_1");
    expect(point!.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(point!.look).toEqual({ x: 1, y: 2, z: 0 });
    expect(point!.tags).toEqual(["riser"]);
  });

  it("faces north when it declares no look, as a spawn does", () => {
    expect(resolveOk(`point { at: 1 2 3 }`).points[0]!.look).toEqual({ x: 1, y: 2, z: 2 });
  });

  it("needs a position, and lives at the top level", () => {
    expect(codes(`point { tag: "x" }`)).toContain("missing-property");
    expect(codes(`group g { point { at: 0 0 0 } }`)).toContain("type-not-allowed-here");
  });
});

describe("solid", () => {
  it("resolves the part it names, its tags, modes and use", () => {
    const world = resolveOk(`${COLLISION}\nsolid barrier { part: "*12", tag: "backstage_door" }`);
    expect(world.solids).toEqual([{ id: 0, name: "barrier", part: "*12", tags: ["backstage_door"], modes: undefined, use: undefined }]);
  });

  /** A door a script opens is present in every mode until it is opened. */
  it("needs no mode", () => {
    expect(resolve(`${COLLISION}\nsolid { part: "*12" }`).diagnostics).toEqual([]);
  });

  it("needs a part", () => {
    expect(codes(`${COLLISION}\nsolid { tag: "door" }`)).toContain("missing-property");
  });

  it("is an error in a world with no collision to find the part in, once", () => {
    expect(codes(`solid { part: "*1" }\nsolid { part: "*2" }`)).toEqual(["solid-without-collision"]);
  });

  it("is an error when two name the same part", () => {
    const result = resolve(`${COLLISION}\nsolid { part: "*7", mode: "sd" }\nsolid { part: "*7", mode: "dd" }`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["duplicate-solid-part"]);
  });
});

describe("ids", () => {
  const WITHOUT = `
    asset x { source: "x.glb" }
    group g { model a { asset: x, size: 1 1 1 } }
    trigger t { at: 0 0 0, radius: 1 }
    ladder l { at: 0 1 0, size: 1 2 0.1 }
  `;
  const WITH = `${WITHOUT}\n${COLLISION}\npoint p { at: 0 0 0 }\nsolid s { part: "*1" }\npoint q { at: 1 0 0 }`;

  /** Ids cross the wire, so a new kind is numbered after every older one. */
  it("moves no existing id", () => {
    const without = resolveOk(WITHOUT);
    const with_ = resolveOk(WITH);
    expect(worldObjects(with_).map((o) => o.id)).toEqual(worldObjects(without).map((o) => o.id));
    expect(with_.triggers.map((t) => t.id)).toEqual(without.triggers.map((t) => t.id));
    expect(with_.ladders.map((l) => l.id)).toEqual(without.ladders.map((l) => l.id));
  });

  it("numbers points, then solids, after every older kind", () => {
    const world = resolveOk(WITH);
    expect(world.points.map((p) => p.id)).toEqual([3, 4]);
    expect(world.solids.map((s) => s.id)).toEqual([5]);
  });
});

describe("WorldIndex", () => {
  const index = indexWorld(
    resolveOk(`
      ${COLLISION}
      trigger west_a { at: 0 0 0, size: 1 1 1, tag: "west_zone" "player_volume" }
      trigger west_b { at: 2 0 0, size: 1 1 1, tag: "west_zone" }
      point sp1 { at: 0 0 0, tag: "west_spawners" "riser" }
      point sp2 { at: 0 0 0, tag: "west_spawners" }
      solid door { part: "*37", tag: "backstage_door" }
    `),
  );

  it("finds triggers, points and solids by name", () => {
    expect(index.triggers.byName.get("west_b")!.position.x).toBe(2);
    expect(index.points.byName.get("sp2")!.name).toBe("sp2");
    expect(index.solids.byName.get("door")!.part).toBe("*37");
  });

  it("finds every one carrying a tag, a zone of several volumes included", () => {
    expect(index.triggers.byTag.get("west_zone")!.map((t) => t.name)).toEqual(["west_a", "west_b"]);
    expect(index.triggers.byTag.get("player_volume")!.map((t) => t.name)).toEqual(["west_a"]);
    expect(index.points.byTag.get("west_spawners")!.map((p) => p.name)).toEqual(["sp1", "sp2"]);
    expect(index.points.byTag.get("riser")!.map((p) => p.name)).toEqual(["sp1"]);
    expect(index.solids.byTag.get("backstage_door")!.map((s) => s.part)).toEqual(["*37"]);
  });

  it("keeps each kind apart from objects", () => {
    expect(index.byTag.get("west_zone")).toBeUndefined();
    expect(index.triggers.all).toHaveLength(2);
  });
});
