// The one definition of a peer between two ticks (sim/interpolate.ts). These
// properties are what lag compensation rests on: a server rewinding to reproduce
// what a shooter saw calls the same function the shooter's client drew with, so a
// bug here is a shot landing where nobody was.

import { describe, expect, it } from "vitest";
import { createMovement, WALKING, type MantleMove, type Move, type MovementState } from "../src/sim/movement.js";
import { copyMovement, lerpMovement, shortestPhase, shortestTurn, teleported, TELEPORT_DISTANCE } from "../src/sim/interpolate.js";

function at(x: number, z: number): MovementState {
  return createMovement({ x, y: 0, z }, 0, 0);
}

describe("shortestTurn", () => {
  it("crosses ±π the short way rather than spinning the body", () => {
    // 170° to -170° is 20° on, not 340° back.
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    expect(shortestTurn(a, b)).toBeCloseTo((20 * Math.PI) / 180, 10);
    expect(shortestTurn(b, a)).toBeCloseTo((-20 * Math.PI) / 180, 10);
  });

  it("is zero for no turn at all, at any winding", () => {
    expect(shortestTurn(1, 1)).toBe(0);
    expect(shortestTurn(1, 1 + Math.PI * 2)).toBeCloseTo(0, 10);
  });
});

describe("shortestPhase", () => {
  it("advances a wrapping stride forwards, not backwards through the middle", () => {
    // The bug this exists to stop: 0.98 -> 0.02 is 4% of a cycle on, and lerping
    // the raw numbers walks the legs back through 0.5.
    expect(shortestPhase(0.98, 0.02)).toBeCloseTo(0.04, 10);
    expect(shortestPhase(0.02, 0.98)).toBeCloseTo(-0.04, 10);
  });

  it("is an ordinary difference away from the wrap", () => {
    expect(shortestPhase(0.2, 0.3)).toBeCloseTo(0.1, 10);
  });
});

describe("lerpMovement", () => {
  it("is exactly its endpoints at t = 0 and t = 1", () => {
    const from = at(0, 0);
    const to = at(4, 8);
    const out = at(0, 0);
    expect(lerpMovement(from, to, 0, out).feet).toEqual({ x: 0, y: 0, z: 0 });
    expect(lerpMovement(from, to, 1, out).feet).toEqual({ x: 4, y: 0, z: 8 });
  });

  it("clamps outside [0, 1] rather than extrapolating a player off the map", () => {
    const out = at(0, 0);
    expect(lerpMovement(at(0, 0), at(4, 0), 2, out).feet.x).toBe(4);
    expect(lerpMovement(at(0, 0), at(4, 0), -1, out).feet.x).toBe(0);
  });

  it("keeps a wrapped stride in [0, 1)", () => {
    const from = at(0, 0);
    const to = at(0, 0);
    from.stride = 0.98;
    to.stride = 0.02;
    const out = at(0, 0);
    // Half way across the wrap is 0.0 exactly, and must not come back as 0.5.
    expect(lerpMovement(from, to, 0.5, out).stride).toBeCloseTo(0, 10);
    expect(lerpMovement(from, to, 0.25, out).stride).toBeCloseTo(0.99, 10);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const s = lerpMovement(from, to, t, out).stride;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });

  it("takes discrete state from `from`, because there is no half a ladder", () => {
    const from = at(0, 0);
    const to = at(1, 0);
    from.move = { kind: "ladder", facing: 1 };
    from.grounded = false;
    to.grounded = true;
    const out = lerpMovement(from, to, 0.5, at(0, 0));
    expect(out.move).toEqual({ kind: "ladder", facing: 1 });
    expect(out.grounded).toBe(false);
  });

  it("is safe to write into one of its own endpoints", () => {
    // The server rewinds into a scratch buffer that may alias; every read must
    // happen before the matching write.
    const from = at(0, 0);
    const to = at(4, 0);
    const result = lerpMovement(from, to, 0.5, from);
    expect(result.feet.x).toBe(2);
    expect(result).toBe(from);
  });
});

describe("teleported", () => {
  it("is true past the threshold on either axis, and false within it", () => {
    expect(teleported(at(0, 0), at(TELEPORT_DISTANCE + 0.1, 0))).toBe(true);
    expect(teleported(at(0, 0), at(0, TELEPORT_DISTANCE + 0.1))).toBe(true);
    expect(teleported(at(0, 0), at(TELEPORT_DISTANCE - 0.1, 0))).toBe(false);
  });

  it("ignores height, so a fall is a move and not a placement", () => {
    const to = at(0, 0);
    to.feet.y = -20;
    expect(teleported(at(0, 0), to)).toBe(false);
  });
});

// -- The exhaustiveness these two cannot get from the type system ----------------
//
// `copyMovement` and `lerpMovement` assign onto an object the caller already holds,
// so a field left out of either keeps whatever that object had and nothing fails to
// compile. It has happened: `gait` and `airborne` were added to `MovementState` and
// forgotten here, and every peer stood still — a body is drawn from an interpolated
// state, and theirs came back a permanent zero.
//
// So these compare the *whole object*, which is what makes a new field covered the
// moment it exists rather than the moment somebody remembers it.

/** A state with every field set to something distinctive, so a missed one shows. */
function distinctive(): MovementState {
  return {
    feet: { x: 1.5, y: 2.5, z: -3.5 },
    velocity: { x: 0.25, y: -1.25, z: 4.75 },
    yaw: 0.7,
    pitch: -0.3,
    grounded: true,
    jumpFrom: 2.25,
    landing: 0.33,
    move: { kind: "mantle", ledge: { x: 9, y: 8, z: 7 }, yaw: 1.9, row: 5, over: true, left: 0.44 },
    stance: { kind: "prone", heading: 1.1, torso: -0.2 },
    eyeShift: { path: "crouchToProne", elapsed: 0.21 },
    ladderLock: true,
    sinceJump: 0.55,
    jumpHeld: true,
    gait: 0.66,
    airborne: 0.77,
    travelForward: -0.42,
    travelRight: 0.63,
    stride: 0.88,
  };
}

describe("every field survives", () => {
  it("copyMovement copies all of them", () => {
    const src = distinctive();
    const dst = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    copyMovement(src, dst);
    // The whole object, not field by field: that is the point.
    expect(dst).toEqual(src);
  });

  it("copyMovement deep-copies, so the past does not follow the present", () => {
    const src = distinctive();
    const dst = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    copyMovement(src, dst);
    src.feet.x = 999;
    (src.move as MantleMove).ledge.y = 999;
    expect(dst.feet.x).toBe(1.5);
    expect((dst.move as MantleMove).ledge.y).toBe(8);
  });

  it("copyMovement copies every kind of move, over every kind", () => {
    const moves: Move[] = [WALKING, { kind: "mantle", ledge: { x: 9, y: 8, z: 7 }, yaw: 1.9, row: 5, over: true, left: 0.44 }, { kind: "ladder", facing: 2.1 }];
    for (const from of moves) {
      for (const over of moves) {
        const src = { ...distinctive(), move: structuredClone(from) };
        const dst = { ...distinctive(), move: structuredClone(over) };
        copyMovement(src, dst);
        expect(dst.move, `${from.kind} over ${over.kind}`).toEqual(from);
        if (from.kind !== "walk") {
          expect(dst.move).not.toBe(src.move);
        }
      }
    }
  });

  it("lerpMovement at t = 0 is its start, all of it", () => {
    const from = distinctive();
    const to = createMovement({ x: -9, y: -9, z: -9 }, 3, 1);
    const out = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    expect(lerpMovement(from, to, 0, out)).toEqual(from);
  });

  it("interpolates the pose blends, which is what a peer is drawn from", () => {
    const from = distinctive();
    const to = { ...distinctive(), gait: 0.66 + 0.2, airborne: 0.77 - 0.4 };
    const out = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    const half = lerpMovement(from, to, 0.5, out);
    expect(half.gait).toBeCloseTo(0.76, 10);
    expect(half.airborne).toBeCloseTo(0.57, 10);
  });
});
