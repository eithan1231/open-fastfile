// `ladder` nodes and the probe that finds them.
//
// The node is a box that is the ladder itself; the probe is IW5's trace ahead
// of the player. The quiet failures here are a turned box resolving mirrored
// and a side name meaning the opposite side, so both are pinned down.

import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";
import type { ResolvedLadder } from "../src/dsl/resolved.js";
import { LadderVolumes, NO_LADDERS } from "../src/sim/ladder.js";
import { UNIT } from "../src/sim/units.js";
import { HEIGHT, RADIUS } from "../src/sim/movement.js";

const BODY = { radius: RADIUS, height: HEIGHT };

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

/** A 0.8 m wide, 3 m tall, 0.2 m thick ladder standing on y = 0 with its centre at z = -2. */
function ladder(overrides: Partial<ResolvedLadder> = {}): ResolvedLadder {
  return { id: 0, tags: [], position: { x: 0, y: 1.5, z: -2 }, yaw: 0, size: { x: 0.8, y: 3, z: 0.2 }, ...overrides };
}

/** Where a body pressed against the +Z side of `ladder()` stands. */
const PRESSED_Z = -2 + 0.1 + RADIUS;

describe("ladder node", () => {
  it("carries the box, its yaw and its side", () => {
    const world = resolveOk(`
      ladder fire_escape { at: 4 1.5 -2, size: 0.8 3 0.2, rotate: 90, face: back, tag: "roof" }
    `);
    const [l] = world.ladders;
    expect(l!.name).toBe("fire_escape");
    expect(l!.tags).toEqual(["roof"]);
    expect(l!.position).toEqual({ x: 4, y: 1.5, z: -2 });
    expect(l!.size).toEqual({ x: 0.8, y: 3, z: 0.2 });
    expect(l!.yaw).toBeCloseTo(Math.PI / 2, 10);
    expect(l!.face).toBe("back");
  });

  it("leaves the side undefined, meaning every side, when none is named", () => {
    expect(resolveOk(`ladder { at: 0 0 0, size: 1 1 1 }`).ladders[0]!.face).toBeUndefined();
  });

  it("takes a group's origin and turn", () => {
    const world = resolveOk(`
      group tower {
        at: 10 0 0
        rotate: 90
        ladder { at: 0 1 -2, size: 1 2 0.2, rotate: 10 }
      }
    `);
    const [l] = world.ladders;
    // -2 along the group's Z, turned a quarter about +Y, lands on -X.
    expect(l!.position.x).toBeCloseTo(8, 6);
    expect(l!.position.z).toBeCloseTo(0, 6);
    expect(l!.yaw).toBeCloseTo((100 * Math.PI) / 180, 6);
  });

  it("numbers ladders after everything else, so adding them moves no id", () => {
    const world = resolveOk(`
      ladder { at: 0 0 0, size: 1 1 1 }
      mantle { at: 0 0 0, size: 1 1 1 }
      trigger { at: 0 0 0, size: 1 1 1 }
    `);
    expect(world.ladders[0]!.id).toBeGreaterThan(world.mantles[0]!.id);
    expect(world.ladders[0]!.id).toBeGreaterThan(world.triggers[0]!.id);
  });

  it("refuses a box without all three extents, a side it does not know, and a missing size", () => {
    expect(codes(`ladder { at: 0 0 0, size: 1 2 0 }`)).toContain("ladder-size");
    expect(codes(`ladder { at: 0 0 0, size: 1 2 1, face: top }`)).toContain("bad-enum-value");
    expect(codes(`ladder { at: 0 0 0 }`)).not.toHaveLength(0);
  });
});

describe("LadderVolumes.trace", () => {
  const ladders = new LadderVolumes([ladder()]);
  const feet = { x: 0, y: 0, z: PRESSED_Z };

  it("meets the side the probe goes in through, with its normal pointing back out", () => {
    const hit = ladders.trace(feet, 0, -1, 8 * UNIT, BODY);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(0, 9);
    expect(hit!.z).toBeCloseTo(1, 9);
  });

  it("reaches a pressed body's ladder standing, and a further one only in the air", () => {
    // Pressed, the probe's inset leaves 6 units to cover: 8 reaches, 5 does not.
    expect(ladders.trace(feet, 0, -1, 5 * UNIT, BODY)).toBeNull();
    const away = { x: 0, y: 0, z: PRESSED_Z + 20 * UNIT };
    expect(ladders.trace(away, 0, -1, 8 * UNIT, BODY)).toBeNull();
    expect(ladders.trace(away, 0, -1, 30 * UNIT, BODY)).not.toBeNull();
  });

  it("misses looking away, past the top and beside it", () => {
    expect(ladders.trace(feet, 0, 1, 1, BODY)).toBeNull();
    // The probe starts 8 units above the feet, so feet a hair below the top minus that still touch.
    expect(ladders.trace({ ...feet, y: 3 - 8 * UNIT - 0.01 }, 0, -1, 1, BODY)).not.toBeNull();
    expect(ladders.trace({ ...feet, y: 3 - 8 * UNIT + 0.01 }, 0, -1, 1, BODY)).toBeNull();
    expect(ladders.trace({ ...feet, x: 1 }, 0, -1, 1, BODY)).toBeNull();
    expect(NO_LADDERS.trace(feet, 0, -1, 1, BODY)).toBeNull();
  });

  it("reports the side of a turned box in world space", () => {
    // Turned a quarter: the box's +Z side now faces +X.
    const turned = new LadderVolumes([ladder({ position: { x: 0, y: 1.5, z: 0 }, yaw: Math.PI / 2 })]);
    const hit = turned.trace({ x: 0.1 + RADIUS, y: 0, z: 0 }, -1, 0, 8 * UNIT, BODY);
    expect(hit!.x).toBeCloseTo(1, 9);
    expect(hit!.z).toBeCloseTo(0, 9);
  });

  it("names the sides in the box's own frame, and a named side is the only one that counts", () => {
    // `back` is the side whose normal is local +Z: the one the player above faces.
    expect(new LadderVolumes([ladder({ face: "back" })]).trace(feet, 0, -1, 1, BODY)).not.toBeNull();
    expect(new LadderVolumes([ladder({ face: "front" })]).trace(feet, 0, -1, 1, BODY)).toBeNull();
    const behind = { x: 0, y: 0, z: -2 - 0.1 - RADIUS };
    expect(new LadderVolumes([ladder({ face: "front" })]).trace(behind, 0, 1, 1, BODY)).not.toBeNull();
    const side = { x: 0.4 + RADIUS, y: 0, z: -2 };
    expect(new LadderVolumes([ladder({ face: "right" })]).trace(side, -1, 0, 1, BODY)).not.toBeNull();
    expect(new LadderVolumes([ladder({ face: "left" })]).trace(side, -1, 0, 1, BODY)).toBeNull();
  });

  it("stops at the first ladder side it meets, even one that cannot be climbed", () => {
    // A trace ends at the first surface: a blocked side in front hides a ladder behind.
    const near = ladder({ id: 1, position: { x: 0, y: 1.5, z: -1 }, face: "front" });
    const both = new LadderVolumes([ladder(), near]);
    expect(both.trace({ x: 0, y: 0, z: -1 + 0.1 + RADIUS }, 0, -1, 2, BODY)).toBeNull();
  });

  it("touches nothing of a box it starts inside", () => {
    expect(ladders.trace({ x: 0, y: 0, z: -2 }, 0, -1, 1, BODY)).toBeNull();
  });
});
