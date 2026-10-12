// `MantleVolumes.find`: from here, looking this way, is there a mantle to start?
//
// The volumes here are shaped the way the imported maps' are: a box enclosing
// its obstacle with a margin on every side. What is worth pinning down is each
// part of the question (reverse/iw5-mantle/): which face the probe meets and
// when it meets none, where the ledge is and how high it may be, when a mantle
// is a vault, and that one the capsule cannot make is refused rather than
// started — plus that a turned volume behaves exactly like the same volume
// turned back, since a sign error there works on axis-aligned volumes and sends
// a player the wrong way on the half that carry a yaw.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { MANTLE_ROWS, mantleRow, MantleVolumes } from "../src/sim/moves/mantle.js";
import { RADIUS, STAND_HEIGHT as HEIGHT } from "../src/sim/movement.js";
import { UNIT } from "../src/sim/units.js";
import type { ResolvedMantle } from "../src/dsl/resolved.js";

const BODY = { radius: RADIUS, height: HEIGHT };
/** How far a volume reaches past the obstacle it encloses, as dome-mw3's crates do. */
const MARGIN = 0.4;
/** The ledge is this far ahead of the feet, whatever is there. */
const AHEAD = 16 * UNIT;
const DEGREE = Math.PI / 180;

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

/** A crate `units` tall with its volume, and where a body stands against its -Z face. */
function ledgeOf(units: number) {
  const top = units * UNIT;
  const crate: Box = { size: [2, top, 1.6], at: [0, top / 2, 0] };
  const volume = crateVolume({ position: { x: 0, y: top / 2, z: 0 }, size: { x: 2.8, y: top, z: 2.4 } });
  return { collision: world(crate), volumes: new MantleVolumes([volume]), feet: { x: 0, y: 0, z: AT.minusZ } };
}

describe("MantleVolumes.find", () => {
  it("finds the ledge a fixed way ahead, at the obstacle's own height", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const feet = { x: 0, y: 0, z: AT.minusZ };
    const found = volumes.find(feet, LOOK.plusZ, BODY, world(CRATE));
    expect(found).not.toBeNull();
    expect(found!.height).toBeCloseTo(1, 3);
    expect(found!.ledge.y).toBeCloseTo(1, 3);
    expect(found!.ledge.z).toBeCloseTo(feet.z + AHEAD, 6);
    expect(found!.ledge.x).toBeCloseTo(0, 6);
    expect(found!.over).toBe(false);
    expect(found!.crouched).toBe(false);
    expect(found!.end).toEqual(found!.ledge);
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
      expect(sign * (found!.ledge[axis] - feet[axis])).toBeCloseTo(AHEAD, 6);
      expect(found!.ledge[other]).toBeCloseTo(feet[other], 6);
      expect(Math.cos(found!.yaw - yaw)).toBeCloseTo(1, 9);
    }
  });

  it("goes straight in through the face, wherever within 60 degrees of it the player looks", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const collision = world(CRATE);
    const feet = { x: 0, y: 0, z: AT.minusZ };
    for (const off of [-55, -30, 30, 55]) {
      const found = volumes.find(feet, LOOK.plusZ + off * DEGREE, BODY, collision);
      expect(found, `${off} degrees`).not.toBeNull();
      expect(found!.ledge.x).toBeCloseTo(0, 6);
      expect(Math.cos(found!.yaw - LOOK.plusZ)).toBeCloseTo(1, 9);
    }
  });

  it("refuses a face the view is more than 60 degrees off", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const collision = world(CRATE);
    const feet = { x: 0, y: 0, z: AT.minusZ };
    expect(volumes.find(feet, LOOK.plusZ + 65 * DEGREE, BODY, collision)).toBeNull();
    expect(volumes.find(feet, LOOK.plusZ - 65 * DEGREE, BODY, collision)).toBeNull();
    // Back to the crate: the probe meets nothing.
    expect(volumes.find(feet, LOOK.minusZ, BODY, collision)).toBeNull();
  });

  it("takes the face the probe enters, which a view across a corner need not lean to", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const collision = world(CRATE);
    // The same view, 45 degrees between +X and -Z, from against two different faces.
    const view = Math.atan2(-1, 1);
    const fromX = volumes.find({ x: AT.minusX, y: 0, z: 0.5 }, view, BODY, collision);
    expect(fromX!.ledge.x).toBeCloseTo(AT.minusX + AHEAD, 6);
    expect(fromX!.ledge.z).toBeCloseTo(0.5, 6);
    const fromZ = volumes.find({ x: 0.5, y: 0, z: AT.plusZ }, view, BODY, collision);
    expect(fromZ!.ledge.z).toBeCloseTo(AT.plusZ - AHEAD, 6);
    expect(fromZ!.ledge.x).toBeCloseTo(0.5, 6);
  });

  it("finds nothing when the probe starts inside a volume", () => {
    // The probe starts as far behind the feet as the body's front is ahead of
    // them: in a volume that reaches that far back, nothing is found at all.
    const feet = { x: 0, y: 0, z: AT.minusZ };
    const wide = new MantleVolumes([crateVolume({ size: { x: 4, y: 1, z: 4 } })]);
    expect(wide.find(feet, LOOK.plusZ, BODY, world(CRATE))).toBeNull();
    // And another volume the probe starts in hides one it would have met.
    const behind = crateVolume({ id: 2, position: { x: 0, y: 0.5, z: feet.z - 0.5 }, size: { x: 1, y: 1, z: 1 } });
    expect(new MantleVolumes([crateVolume(), behind]).find(feet, LOOK.plusZ, BODY, world(CRATE))).toBeNull();
  });

  it("reaches a ledge the body is not touching, as far as the ball still lands on it", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const collision = world(CRATE);
    // A third of a metre back, the ball comes down on the crate's corner well
    // round its side: the ledge is the crate's top, and the feet rest under it.
    const near = volumes.find({ x: 0, y: 0, z: AT.minusZ - 0.33 }, LOOK.plusZ, BODY, collision);
    expect(near).not.toBeNull();
    expect(near!.height).toBeCloseTo(1, 1);
    expect(near!.ledge.y).toBeLessThan(0.9);
    expect(near!.ledge.y).toBeGreaterThan(0.75);
    expect(collision.overlapsCapsule(near!.ledge, RADIUS, HEIGHT)).toBe(false);
    // Half a metre back the face is still in reach of the probe, and the ledge is not.
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ - 0.5 }, LOOK.plusZ, BODY, collision)).toBeNull();
  });

  it("takes a stepped top by the step the ball meets, though it meets it on a corner", () => {
    // A 38-unit lip twelve units deep in front of a 46-unit top: the ball is
    // stopped by the higher corner before it reaches the lip under it.
    const lip: Box = { size: [2, 38 * UNIT, 12 * UNIT], at: [0, 19 * UNIT, 6 * UNIT] };
    const top: Box = { size: [2, 46 * UNIT, 1], at: [0, 23 * UNIT, 12 * UNIT + 0.5] };
    const volume = crateVolume({ position: { x: 0, y: 23 * UNIT, z: 0.5 }, size: { x: 2.8, y: 46 * UNIT, z: 1.6 } });
    const collision = world(lip, top);
    const found = new MantleVolumes([volume]).find({ x: 0, y: 0, z: -RADIUS - 0.005 }, LOOK.plusZ, BODY, collision);
    expect(found).not.toBeNull();
    expect(found!.height / UNIT).toBeCloseTo(46, 0);
    expect(found!.ledge.y / UNIT).toBeGreaterThan(38);
    expect(found!.ledge.y / UNIT).toBeLessThan(46);
    expect(collision.overlapsCapsule(found!.ledge, RADIUS, HEIGHT)).toBe(false);
  });

  it("is not inside a volume it stands on top of", () => {
    // On the crate, against a wall a metre taller behind it. The crate's own
    // volume is under the feet, which rest a hair below its top.
    const wall: Box = { size: [2, 2, 0.6], at: [0, 1, 1.1] };
    const above = crateVolume({ id: 2, position: { x: 0, y: 1.5, z: 1.1 }, size: { x: 2.8, y: 1, z: 1.4 } });
    const volumes = new MantleVolumes([crateVolume(), above]);
    const collision = world(CRATE, wall);
    const z = 0.8 - RADIUS - 0.005;
    const found = volumes.find({ x: 0, y: 0.997, z }, LOOK.plusZ, BODY, collision);
    expect(found).not.toBeNull();
    expect(found!.volume.id).toBe(2);
    expect(found!.ledge.y).toBeCloseTo(2, 2);
    // Sunk into it by more than a resting body is, they are in it.
    expect(volumes.find({ x: 0, y: 0.95, z }, LOOK.plusZ, BODY, collision)).toBeNull();
  });

  it("refuses where there is no ledge at all, whatever the volume says", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world())).toBeNull();
  });

  it("refuses a volume that does not meet the body's height, whatever is behind it", () => {
    const feet = { x: 0, y: 0, z: AT.minusZ };
    const above = new MantleVolumes([crateVolume({ position: { x: 0, y: 2.5, z: 0 } })]);
    expect(above.find(feet, LOOK.plusZ, BODY, world(CRATE))).toBeNull();
    const below = new MantleVolumes([crateVolume({ position: { x: 0, y: -0.6, z: 0 } })]);
    expect(below.find(feet, LOOK.plusZ, BODY, world(CRATE))).toBeNull();
  });

  it("climbs a ledge above a step and no higher than 60 units", () => {
    for (const units of [20, 27, 40, 51, 60]) {
      const { volumes, feet, collision } = ledgeOf(units);
      const found = volumes.find(feet, LOOK.plusZ, BODY, collision);
      expect(found, `${units} units`).not.toBeNull();
      expect(found!.height).toBeCloseTo(units * UNIT, 3);
    }
    for (const units of [12, 17, 61, 64, 90]) {
      const { volumes, feet, collision } = ledgeOf(units);
      expect(volumes.find(feet, LOOK.plusZ, BODY, collision), `${units} units`).toBeNull();
    }
  });

  it("reads nothing off the volume's own height", () => {
    // A crate under a volume twice as tall, and one over a volume half as tall.
    const feet = { x: 0, y: 0, z: AT.minusZ };
    const tall = new MantleVolumes([crateVolume({ position: { x: 0, y: 1, z: 0 }, size: { x: 2.8, y: 2, z: 2.4 } })]);
    expect(tall.find(feet, LOOK.plusZ, BODY, world(CRATE))!.height).toBeCloseTo(1, 3);
    const short = new MantleVolumes([crateVolume({ position: { x: 0, y: 0.25, z: 0 }, size: { x: 2.8, y: 0.5, z: 2.4 } })]);
    expect(short.find(feet, LOOK.plusZ, BODY, world(CRATE))!.height).toBeCloseTo(1, 3);
  });

  it("measures the ledge from the feet, so a jump brings a taller wall in reach", () => {
    const volumes = new MantleVolumes([crateVolume()]);
    const collision = world(CRATE);
    expect(volumes.find({ x: 0, y: 0.3, z: AT.minusZ }, LOOK.plusZ, BODY, collision)!.height).toBeCloseTo(0.7, 3);
    // Nearly up already: what is left is a step.
    expect(volumes.find({ x: 0, y: 0.8, z: AT.minusZ }, LOOK.plusZ, BODY, collision)).toBeNull();

    const wall: Box = { size: [2, 2, 1.6], at: [0, 1, 0] };
    const tall = new MantleVolumes([crateVolume({ position: { x: 0, y: 1, z: 0 }, size: { x: 2.8, y: 2, z: 2.4 } })]);
    expect(tall.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(wall))).toBeNull();
    expect(tall.find({ x: 0, y: 0.6, z: AT.minusZ }, LOOK.plusZ, BODY, world(wall))!.height).toBeCloseTo(1.4, 3);
  });

  it("names the games' row by the nearest height", () => {
    const rows = [18.5, 23.9, 24.1, 29.9, 36.1, 41.9, 48.1, 53.9, 60].map((units) => MANTLE_ROWS[mantleRow(units * UNIT)]!.height / UNIT);
    expect(rows.map(Math.round)).toEqual([21, 21, 27, 27, 39, 39, 51, 51, 57]);
  });

  describe("under a lintel", () => {
    /** A wall with an opening from `sill` up for `opening` metres, and where a body stands against it. */
    function windowed(sill: number, opening: number) {
      const lintel = sill + opening;
      const boxes: Box[] = [
        { size: [3, sill, 0.4], at: [0, sill / 2, 0] },
        { size: [3, 1, 0.4], at: [0, lintel + 0.5, 0] },
      ];
      const volume = crateVolume({ position: { x: 0, y: sill / 2, z: 0 }, size: { x: 3.8, y: sill, z: 1.2 } });
      return { collision: world(...boxes), volumes: new MantleVolumes([volume]), feet: { x: 0, y: 0, z: -0.2 - RADIUS } };
    }

    it("finds the sill with a lower probe, and makes the mantle crouched where only a crouch fits", () => {
      // 1.3 m of opening: the highest probe meets the lintel, and a standing body does not fit.
      const { volumes, feet, collision } = windowed(0.8, 1.3);
      const found = volumes.find(feet, LOOK.plusZ, BODY, collision);
      expect(found).not.toBeNull();
      expect(found!.height).toBeCloseTo(0.8, 3);
      expect(found!.crouched).toBe(true);
    });

    it("stands through an opening tall enough", () => {
      const { volumes, feet, collision } = windowed(0.8, 1.9);
      expect(volumes.find(feet, LOOK.plusZ, BODY, collision)!.crouched).toBe(false);
    });

    it("refuses an opening not even a crouch fits", () => {
      const { volumes, feet, collision } = windowed(0.8, 1);
      expect(volumes.find(feet, LOOK.plusZ, BODY, collision)).toBeNull();
    });
  });

  it("refuses a ledge a post stands on", () => {
    // A window's mullion, exactly where the player would come up.
    const post: Box = { size: [0.1, 1.5, 0.1], at: [0, 1.75, -0.6] };
    const volumes = new MantleVolumes([crateVolume()]);
    expect(volumes.find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE, post))).toBeNull();
    // A step to the side of it, the same window climbs.
    expect(volumes.find({ x: 0.6, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE, post))).not.toBeNull();
  });

  it("crouches under a beam over the way up, and refuses one too low for that", () => {
    // Over where the body starts and not over the ledge: only the path meets it.
    const beam = (bottom: number): Box => ({ size: [4, 0.2, 0.7], at: [0, bottom + 0.1, -1.55] });
    const volumes = new MantleVolumes([crateVolume()]);
    const feet = { x: 0, y: 0, z: AT.minusZ };
    expect(volumes.find(feet, LOOK.plusZ, BODY, world(CRATE, beam(3)))!.crouched).toBe(false);
    expect(volumes.find(feet, LOOK.plusZ, BODY, world(CRATE, beam(2.4)))!.crouched).toBe(true);
    expect(volumes.find(feet, LOOK.plusZ, BODY, world(CRATE, beam(2)))).toBeNull();
  });

  describe("a vault", () => {
    const rail: Box = { size: [3, 0.9, 0.2], at: [0, 0.45, 0] };
    const railVolume = (kind?: "onto" | "over") => crateVolume({ kind, position: { x: 0, y: 0.45, z: 0 }, size: { x: 3.8, y: 0.9, z: 1 } });
    const feet = { x: 0, y: 0, z: -0.1 - RADIUS };

    it("ends a fixed run past the ledge and a fixed drop below it", () => {
      const found = new MantleVolumes([railVolume("over")]).find(feet, LOOK.plusZ, BODY, world(rail));
      expect(found!.over).toBe(true);
      expect(found!.ledge.y).toBeCloseTo(0.9, 3);
      expect(found!.end.z).toBeCloseTo(found!.ledge.z + 31 * UNIT, 6);
      expect(found!.end.y).toBeCloseTo(found!.ledge.y - 18 * UNIT, 6);
      expect(found!.end.x).toBeCloseTo(0, 6);
    });

    it("is only where the map asked for one", () => {
      expect(new MantleVolumes([railVolume("onto")]).find(feet, LOOK.plusZ, BODY, world(rail))!.over).toBe(false);
      expect(new MantleVolumes([railVolume()]).find(feet, LOOK.plusZ, BODY, world(rail))!.over).toBe(false);
    });

    it("climbs onto the ledge instead with a floor under the far side", () => {
      // The crate goes on for 1.6 m: the run past the ledge is clear, the drop is not.
      const found = new MantleVolumes([crateVolume({ kind: "over" })]).find({ x: 0, y: 0, z: AT.minusZ }, LOOK.plusZ, BODY, world(CRATE));
      expect(found!.over).toBe(false);
      expect(found!.end).toEqual(found!.ledge);
    });

    it("climbs onto the ledge instead with a wall in the run, and not at all with one on the ledge", () => {
      const volumes = new MantleVolumes([railVolume("over")]);
      const wall: Box = { size: [3, 3, 0.2], at: [0, 1.5, 0.45] };
      const onto = volumes.find(feet, LOOK.plusZ, BODY, world(rail, wall));
      expect(onto!.over).toBe(false);
      expect(volumes.find(feet, LOOK.plusZ, BODY, world(rail, { ...wall, at: [0, 1.5, 0.2] }))).toBeNull();
    });

    it("goes over crouched under a lintel too low to stand under", () => {
      const lintel: Box = { size: [3, 1, 0.2], at: [0, 0.9 + 1.4 + 0.5, 0] };
      const found = new MantleVolumes([railVolume("over")]).find(feet, LOOK.plusZ, BODY, world(rail, lintel));
      expect(found!.over).toBe(true);
      expect(found!.crouched).toBe(true);
    });
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
    expect(turned!.height).toBeCloseTo(flat!.height, 4);
    expect(Math.cos(turned!.yaw - (flat!.yaw + turn))).toBeCloseTo(1, 9);
    const expected = turnPoint(flat!.ledge.x, flat!.ledge.z);
    expect(turned!.ledge.x).toBeCloseTo(expected.x, 6);
    expect(turned!.ledge.z).toBeCloseTo(expected.z, 6);
  });

  it("takes the first face along the sweep where volumes overlap", () => {
    const collision = world(CRATE);
    const feet = { x: 0, y: 0, z: AT.minusZ };
    const inner = crateVolume({ id: 1 });
    const outer = crateVolume({ id: 2, size: { x: 3, y: 1, z: 2.6 } });
    expect(new MantleVolumes([inner, outer]).find(feet, LOOK.plusZ, BODY, collision)!.volume.id).toBe(2);
    expect(new MantleVolumes([outer, inner]).find(feet, LOOK.plusZ, BODY, collision)!.volume.id).toBe(2);
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
});
