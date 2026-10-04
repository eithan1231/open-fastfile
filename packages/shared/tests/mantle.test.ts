// `mantle` volumes: where a world says a player may climb.
//
// A volume is a box, and its top is the surface the player ends on, so these
// check the two things a reader depends on: that a world file can say it, and
// that a turned volume resolves to the same box the exporter fitted. The second
// is the one that would fail quietly — a mirrored box is still a box.

import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";
import { rotateY } from "../src/dsl/resolveUtil.js";
import type { ResolvedMantle } from "../src/dsl/resolved.js";
import type { Vec3 } from "../src/sim/movement.js";

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

/** True when `point` is inside `volume` — the containment every reader of one must use. */
function contains(volume: ResolvedMantle, point: Vec3): boolean {
  const local = rotateY({ x: point.x - volume.position.x, y: point.y - volume.position.y, z: point.z - volume.position.z }, -volume.yaw);
  return Math.abs(local.x) <= volume.size.x / 2 && Math.abs(local.y) <= volume.size.y / 2 && Math.abs(local.z) <= volume.size.z / 2;
}

describe("mantle", () => {
  it("carries the box, its yaw and its kind", () => {
    const world = resolveOk(`
      mantle ledge { at: 4 1 -2, size: 1.5 1.1 0.5, rotate: 30, kind: over, tag: "balcony" }
    `);
    const [volume] = world.mantles;
    expect(volume!.name).toBe("ledge");
    expect(volume!.tags).toEqual(["balcony"]);
    expect(volume!.position).toEqual({ x: 4, y: 1, z: -2 });
    expect(volume!.size).toEqual({ x: 1.5, y: 1.1, z: 0.5 });
    expect(volume!.yaw).toBeCloseTo(Math.PI / 6, 10);
    expect(volume!.kind).toBe("over");
  });

  it("leaves the kind undefined when the map never named one", () => {
    // The common case, not the exception: no Black Ops volume names a kind, and
    // neither does an axial brush on any game.
    const world = resolveOk(`mantle { at: 0 0 0, size: 1 1 1 }`);
    expect(world.mantles[0]!.kind).toBeUndefined();
  });

  it("keeps every volume, in declaration order", () => {
    const world = resolveOk(`
      mantle a { at: 0 0 0, size: 1 1 1 }
      mantle b { at: 5 0 0, size: 1 1 1 }
      mantle c { at: 9 0 0, size: 1 1 1 }
    `);
    expect(world.mantles.map((m) => m.name)).toEqual(["a", "b", "c"]);
  });

  it("is empty for a world that declares none", () => {
    expect(resolveOk(`world { name: "bare" }`).mantles).toEqual([]);
  });

  it("numbers volumes past every object, so object ids stay dense", () => {
    const world = resolveOk(`
      asset crate { source: "crate.glb" }
      group g { model { asset: crate, size: 1 1 1 } }
      mantle { at: 0 0 0, size: 1 1 1 }
    `);
    expect(world.topLevelObjects[0]!.id).toBe(0);
    expect(world.mantles[0]!.id).toBeGreaterThan(0);
  });

  it("takes a group's origin and yaw, as a trigger does", () => {
    const world = resolveOk(`
      group frame { at: 10 0 0, rotate: 90
        mantle { at: 2 0 0, size: 1 1 1 }
      }
    `);
    const [volume] = world.mantles;
    expect(volume!.yaw).toBeCloseTo(Math.PI / 2, 10);
    // rotateY((2,0,0), 90 degrees) is (0, 0, -2), offset from the group.
    expect(volume!.position.x).toBeCloseTo(10, 6);
    expect(volume!.position.z).toBeCloseTo(-2, 6);
  });

  it("resolves a turned volume to the box the exporter fitted, not its mirror", () => {
    // scripts/cod/mantle.py maps world -> box frame with rotateY(-yaw), and
    // asserts the same agreement from its own side. If the two disagreed on the
    // sign, every volume with a yaw would be reflected about its own centre and
    // still look like a plausible box.
    const world = resolveOk(`mantle { at: 0 0 0, size: 4 1 0.4, rotate: 45 }`);
    const [volume] = world.mantles;
    // A point 1.8 m along the box's own long axis: inside, at 45 degrees that is
    // (+1.27, -1.27) in world x/z.
    const along = rotateY({ x: 1.8, y: 0, z: 0 }, volume!.yaw);
    expect(along.x).toBeCloseTo(1.2728, 3);
    expect(along.z).toBeCloseTo(-1.2728, 3);
    expect(contains(volume!, along)).toBe(true);
    // The same distance the other way across the short axis is outside it.
    expect(contains(volume!, rotateY({ x: 0, y: 0, z: 1.8 }, volume!.yaw))).toBe(false);
  });

  it("rejects a volume with no height, since its top is the climb target", () => {
    expect(codes(`mantle { at: 0 0 0, size: 1 0 1 }`)).toContain("mantle-size");
  });

  it("needs a position and a size", () => {
    expect(codes(`mantle { at: 0 0 0 }`)).toContain("missing-property");
    expect(codes(`mantle { size: 1 1 1 }`)).toContain("missing-property");
  });

  it("rejects a kind the games do not have", () => {
    // `mount_mantle_on` is in Black Ops' material table but never resolves to a
    // brush, so it is not a value the exporter can emit or this DSL accepts.
    expect(codes(`mantle { at: 0 0 0, size: 1 1 1, kind: mount_mantle_on }`)).toContain("bad-enum-value");
  });
});
