// `MantleVolumes.find`: from here, facing this way, is there something to climb?
//
// The volumes here are shaped the way the imported maps' are: a box enclosing
// its obstacle with a margin on every side, its top flush with the obstacle's.
// What is worth pinning down is which face a player is at, where the ledge
// really is, and that a climb the capsule cannot make is refused rather than
// started — plus that a turned volume behaves exactly like the same volume
// turned back, since a sign error there works on axis-aligned volumes and sends
// a player the wrong way on the half that carry a yaw.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { MantleVolumes, MAX_CLIMB, MIN_CLIMB } from "../src/sim/moves/mantle.js";
import { HEIGHT, RADIUS } from "../src/sim/movement.js";
import type { ResolvedMantle } from "../src/dsl/resolved.js";

const BODY = { radius: RADIUS, height: HEIGHT };
/** How far a volume reaches past the obstacle it encloses, as dome-mw3's crates do. */
const MARGIN = 0.4;

/** Yaws that look along each axis. Yaw 0 faces -Z (sim/movement.ts). */
const LOOK = { minusZ: 0, plusZ: Math.PI, minusX: Math.PI / 2, plusX: -Math.PI / 2 };

type Box = { size: [number, number, number]; at: [number, number, number]; yaw?: number };

/** A world of solid boxes on a floor at y = 0. */
function world(...boxes: Box[]): CollisionWorld {
  const root = new THREE.Group();
  for (const box of [{ size: [40, 1, 40], at: [0, -0.5, 0] } as Box, ...boxes]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...box.size));
    mesh.position.set(...box.at);
    mesh.rotation.y = box.yaw ?? 0;
    mesh.userData.collide = true;
    root.add(mesh);
  }
  const collision = new CollisionWorld();
  collision.rebuild(root);
  return collision;
}

/** A 2 × 1 × 1.6 m crate at the origin, and the volume the maps would put round it. */
const CRATE: Box = { size: [2, 1, 1.6], at: [0, 0.5, 0] };
function crateVolume(over: Partial<ResolvedMantle> = {}): ResolvedMantle {
  return {
    id: 1,
    tags: [],
    position: { x: 0, y: 0.5, z: 0 },
    yaw: 0,
    size: { x: 2 + 2 * MARGIN, y: 1, z: 1.6 + 2 * MARGIN },
    ...over,
  };
}

/** Standing against the crate's face: their radius out from it. */
const AT = { minusZ: -0.8 - RADIUS, plusZ: 0.8 + RADIUS, minusX: -1 - RADIUS, plusX: 1 + RADIUS };

describe("MantleVolumes.find", () => {
  it("climbs onto the obstacle, not past the volume's far side", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const found = volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE));
    expect(found).not.toBeNull();
    expect(found!.rise).toBeCloseTo(1, 3);
    expect(found!.feet.y).toBeCloseTo(1, 3);
    expect(found!.over).toBe(false);
    // On the crate, and far enough in to stand rather than teeter on the lip.
    expect(found!.feet.z).toBeGreaterThan(-0.8 + RADIUS - 0.06);
    expect(found!.feet.z).toBeLessThan(0.8);
    expect(found!.feet.x).toBeCloseTo(0, 6);
  });

  it("climbs from any of the four sides, each straight in", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const collision = world(CRATE);
    const cases = [
      { feet: { x: 0, y: 0, z: AT.minusZ }, yaw: LOOK.plusZ, axis: "z", sign: 1 },
      { feet: { x: 0, y: 0, z: AT.plusZ }, yaw: LOOK.minusZ, axis: "z", sign: -1 },
      { feet: { x: AT.minusX, y: 0, z: 0 }, yaw: LOOK.plusX, axis: "x", sign: 1 },
      { feet: { x: AT.plusX, y: 0, z: 0 }, yaw: LOOK.minusX, axis: "x", sign: -1 },
    ] as const;
    for (const { feet, yaw, axis, sign } of cases) {
      const found = volumes.find(feet, yaw, BODY, collision);
      expect(found, `from ${axis}${sign > 0 ? "-" : "+"}`).not.toBeNull();
      const other = axis === "x" ? "z" : "x";
      // Moved inward along the face's normal and not at all along the face.
      expect(sign * (found!.feet[axis] - feet[axis])).toBeGreaterThan(RADIUS);
      expect(found!.feet[other]).toBeCloseTo(feet[other], 6);
    }
  });

  it("goes straight in through the face, whichever way the player is looking within reason", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    // 40 degrees off: still facing the -Z side, and the climb ignores the skew.
    const found = volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ + 0.7, BODY, world(CRATE));
    expect(found).not.toBeNull();
    expect(found!.feet.x).toBeCloseTo(0, 6);
  });

  it("refuses a face the player is not facing", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const collision = world(CRATE);
    // Back to the crate.
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.minusZ, BODY, collision)).toBeNull();
    // Looking along the face rather than into it.
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusX, BODY, collision)).toBeNull();
  });

  it("picks the face the player is outside of at a corner", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    // Off the -Z face's end, just past the crate's -X side, looking diagonally
    // in: both sides are faced, but only the -Z one is being approached.
    const feet = { x: -0.9, y: 0, z: AT.minusZ };
    const found = volumes.find(feet, LOOK.plusZ - Math.PI / 4, BODY, world(CRATE));
    expect(found).not.toBeNull();
    expect(found!.feet.x).toBeCloseTo(feet.x, 6);
    expect(found!.feet.z).toBeGreaterThan(feet.z);
  });

  it("refuses a ledge out of reach, though the player is inside the volume", () => {
    const volumes = new MantleVolumes([crateVolume({ size: { x: 4, y: 1, z: 4 } })]);
    // In the volume, facing the crate, but a metre short of it.
    expect(volumes.find({ x: 0, y: 0, z: -1.9 }, LOOK.plusZ, BODY, world(CRATE))).toBeNull();
  });

  it("refuses where there is no ledge at all, whatever the volume says", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world())).toBeNull();
  });

  it("refuses a climb that would put the player's head into something", () => {
    // A slab 2.2 m up over the crate's near edge: the crate is 1 m, the player 1.7.
    const ceiling: Box = { size: [4, 0.2, 1], at: [0, 2.3, -0.8] };
    const volumes = new MantleVolumes([crateVolume()]);
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE, ceiling))).toBeNull();
  });

  it("refuses a climb onto a ledge a post stands on", () => {
    // A window's mullion, exactly where the player would come up.
    const post: Box = { size: [0.1, 1.5, 0.1], at: [0, 1.75, -0.6] };
    const volumes = new MantleVolumes([crateVolume()]);
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE, post))).toBeNull();
    // A step to the side of it, the same window climbs.
    expect(volumes.find({ x: 0.6, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE, post))).not.toBeNull();
  });

  it("measures the climb from the real surface, within tolerance of the volume's top", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    // A crate 8 cm lower than its volume says: the climb is to the crate.
    const low: Box = { size: [2, 0.92, 1.6], at: [0, 0.46, 0] };
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(low))!.rise).toBeCloseTo(0.92, 3);
    // Half a metre lower is a different surface, and not this volume's.
    const lower: Box = { size: [2, 0.5, 1.6], at: [0, 0.25, 0] };
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(lower))).toBeNull();
  });

  it("refuses a ledge too low to be worth a mantle, and one too high to reach", () => {
    const kerb: Box = { size: [2, 0.2, 1.6], at: [0, 0.1, 0] };
    const lowVolume = crateVolume({ position: { x: 0, y: 0.1, z: 0 }, size: { x: 2.8, y: 0.2, z: 2.4 } });
    expect(new MantleVolumes([lowVolume]).find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(kerb))).toBeNull();

    const wall: Box = { size: [2, 3, 1.6], at: [0, 1.5, 0] };
    const highVolume = crateVolume({ position: { x: 0, y: 1.5, z: 0 }, size: { x: 2.8, y: 3, z: 2.4 } });
    expect(new MantleVolumes([highVolume]).find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(wall))).toBeNull();
  });

  it("measures the climb from the player's feet, so a jump's height counts", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const collision = world(CRATE);
    expect(volumes.find({ x: 0, y: 0.3, z: AT.minusZ }, LOOK.plusZ, BODY, collision)!.rise).toBeCloseTo(0.7, 3);
    // Near the top already: not worth a mantle.
    expect(volumes.find({ x: 0, y: 0.8, z: AT.minusZ }, LOOK.plusZ, BODY, collision)).toBeNull();
  });

  it("is reachable from outside a thin volume, by the player's radius", () => {
    // A tenth of the imported volumes are under 20 cm thick, and this one sits
    // entirely in front of its wall: a test against the centre alone would miss it.
    const wall: Box = { size: [3, 1, 2], at: [0, 0.5, 1.1] };
    const thin = new MantleVolumes([crateVolume({ position: { x: 0, y: 0.5, z: 0.05 }, size: { x: 3, y: 1, z: 0.1 } })]);
    expect(thin.find({ x: 0, y: 0, z: 0.1 - RADIUS - 0.02 }, LOOK.plusZ, BODY, world(wall))).not.toBeNull();
    expect(thin.find({ x: 0, y: 0, z: -2 }, LOOK.plusZ, BODY, world(wall))).toBeNull();
  });

  it("is not reachable from beyond the ends of the volume", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    expect(volumes.find({ x: 3, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE))).toBeNull();
  });

  it("behaves the same when the volume, the obstacle and the approach are all turned", () => {
    // The invariant that catches a yaw sign error: turning the whole problem
    // about the origin must turn the answer with it and change nothing else.
    const turn = Math.PI / 5;
    const turnPoint = (x: number, z: number) => ({ x: x * Math.cos(turn) + z * Math.sin(turn), z: -x * Math.sin(turn) + z * Math.cos(turn) });
    const from = { x: 0.3, y: 0, z: AT.minusZ };
    const flat = new MantleVolumes([crateVolume()]).find(from, LOOK.plusZ, BODY, world(CRATE));
    const start = turnPoint(from.x, from.z);
    const turned = new MantleVolumes([crateVolume({ yaw: turn })]).find(
      { x: start.x, y: 0, z: start.z },
      LOOK.plusZ + turn,
      BODY,
      world({ ...CRATE, yaw: turn }),
    );
    expect(flat).not.toBeNull();
    expect(turned).not.toBeNull();
    expect(turned!.rise).toBeCloseTo(flat!.rise, 6);
    const expected = turnPoint(flat!.feet.x, flat!.feet.z);
    // The probes step in 5 cm along a turned line, so the landing agrees to that.
    expect(Math.hypot(turned!.feet.x - expected.x, turned!.feet.z - expected.z)).toBeLessThan(0.051);
  });

  it("takes the lowest climb where two volumes overlap", () => {
    const step: Box = { size: [2, 0.5, 0.6], at: [0, 0.25, -0.5] };
    const higher: Box = { size: [2, 1.2, 1], at: [0, 0.6, 0.3] };
    const stepVolume = crateVolume({ id: 1, position: { x: 0, y: 0.25, z: -0.5 }, size: { x: 2.8, y: 0.5, z: 1.4 } });
    const wallVolume = crateVolume({ id: 2, position: { x: 0, y: 0.6, z: 0 }, size: { x: 2.8, y: 1.2, z: 2.4 } });
    const found = new MantleVolumes([wallVolume, stepVolume]).find({ x: 0, y: 0, z: -0.8 - RADIUS }, LOOK.plusZ, BODY, world(step, higher));
    expect(found!.volume.id).toBe(1);
  });

  it("vaults an `over` volume to its far side, and climbs onto it with nowhere to vault to", () => {
    const rail: Box = { size: [3, 0.9, 0.2], at: [0, 0.45, 0] };
    const volume = crateVolume({ kind: "over", position: { x: 0, y: 0.45, z: 0 }, size: { x: 3.8, y: 0.9, z: 1 } });
    const volumes = new MantleVolumes([volume]);
    const feet = { x: 0, y: 0, z: -0.1 - RADIUS };

    const vault = volumes.find(feet, LOOK.plusZ, BODY, world(rail));
    expect(vault!.over).toBe(true);
    expect(vault!.feet.z).toBeGreaterThan(0.1 + RADIUS);
    expect(vault!.feet.y).toBeCloseTo(0.9, 3);

    // A wall a hand's width behind the rail: no room to come down, so up onto it instead.
    const wall: Box = { size: [3, 3, 0.2], at: [0, 1.5, 0.45] };
    const onto = volumes.find(feet, LOOK.plusZ, BODY, world(rail, wall));
    expect(onto!.over).toBe(false);
    expect(Math.abs(onto!.feet.z)).toBeLessThanOrEqual(0.1);
    expect(onto!.feet.z + RADIUS).toBeLessThanOrEqual(0.35 + 1e-9);

    // Flush against it, not even that.
    expect(volumes.find(feet, LOOK.plusZ, BODY, world(rail, { ...wall, at: [0, 1.5, 0.2] }))).toBeNull();
  });

  it("carries the volume through, so a caller can read its id", () => {
    const volumes = new MantleVolumes([crateVolume({ id: 7 })]);
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE))!.volume.id).toBe(7);
  });

  it("offers nothing while the collision is not loaded", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, new CollisionWorld())).toBeNull();
  });

  it("answers null for a world with none, without touching the grid", () => {
    expect(new MantleVolumes([]).find({ x: 0, y: 0, z: 0 }, 0, BODY, world())).toBeNull();
    expect(new MantleVolumes([]).count).toBe(0);
  });

  it("finds a volume across a broad-phase cell boundary", () => {
    // Cells are 8 m, so a volume centred on one boundary is the case that a
    // grid built from footprints alone would drop.
    const volumes = new MantleVolumes([crateVolume({ position: { x: 8, y: 0.5, z: 0 } })]);
    const collision = world({ ...CRATE, at: [8, 0.5, 0] });
    expect(volumes.find({ x: 7.99, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, collision)).not.toBeNull();
    expect(volumes.find({ x: 8.01, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, collision)).not.toBeNull();
  });

  it("agrees with the animation set about what a climb can be", () => {
    // MAX_CLIMB is 57 in, the tallest `mp_mantle_up_*` there is.
    expect(MAX_CLIMB).toBeCloseTo(1.4478, 4);
    expect(MIN_CLIMB).toBeLessThan(MAX_CLIMB);
  });
});
