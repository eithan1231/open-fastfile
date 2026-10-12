// Standing, crouching and prone (sim/stance.ts) against real collision: how
// long each change takes and where the eye is on the way, what forces a stance,
// what each costs in speed, and where a body may lie, turn and crawl — "prone
// blocked". The rules and every number are reverse/iw5-stance/'s.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import type { ResolvedLadder, ResolvedMantle } from "../src/dsl/resolved.js";
import { BitReader, BitWriter } from "../src/net/codec/bits.js";
import type { Codec } from "../src/net/codec/schema.js";
import { roundInput } from "../src/net/messages/input.js";
import { movementSchema } from "../src/net/messages/player.js";
import { idleInput } from "../src/sim/input.js";
import { copyMovement, lerpMovement } from "../src/sim/interpolate.js";
import { LadderVolumes, NO_LADDERS } from "../src/sim/moves/ladder.js";
import { MantleVolumes, NO_MANTLES } from "../src/sim/moves/mantle.js";
import {
  createMovement,
  CROUCHING,
  EYE_PATHS,
  horizontalSpeed,
  LAND_WINDOW,
  movementEnv,
  NO_CLIMBS,
  PLAYER_MOVEMENT,
  RADIUS,
  RUN_SPEED,
  STAND_EYE_HEIGHT,
  STAND_HEIGHT,
  STANDING,
  stepMovement,
  WALK_SPEED,
  wantsSprint,
  type EyePath,
  type MovementRules,
  type MovementState,
  type Stance,
  type StanceKind,
} from "../src/sim/movement.js";
import {
  CROUCH_EYE_HEIGHT,
  CROUCH_HEIGHT,
  eyeHeight,
  eyePathSeconds,
  hullHeight,
  PRONE_EYE_HEIGHT,
  PRONE_HEIGHT,
  PRONE_PITCH_CAP,
  PRONE_YAW_CAP,
  proneFits,
  reversedEyePath,
  speedScale,
} from "../src/sim/stance.js";
import { UNIT } from "../src/sim/units.js";
import { capPitch, capYaw } from "../src/sim/view.js";

const DT = 1 / 60;
const DEGREE = Math.PI / 180;

function collider(size: [number, number, number], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  return mesh;
}

const FLOOR = (): THREE.Mesh => collider([40, 1, 40], [0, -0.5, 0]);

/** A player at the origin facing -Z over `meshes`, settled. Change `input` to press keys; `step` says what a step forced. */
function setup(meshes: THREE.Mesh[] = [FLOOR()], rules: MovementRules = NO_CLIMBS) {
  const root = new THREE.Group();
  root.add(...meshes);
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  const input = idleInput(0, 0);
  const env = movementEnv(collision, rules, PLAYER_MOVEMENT);
  const carry = { sprint: true, braced: false };
  const step = (dt = DT): StanceKind | null => stepMovement(state, input, dt, env, carry);
  const run = (seconds: number, each?: (forced: StanceKind | null) => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      const forced = step();
      each?.(forced);
    }
  };
  /** Ask for `kind` and wait until the eye has stopped there. */
  const settle = (kind: StanceKind) => {
    input.crouch = kind === "crouch";
    input.prone = kind === "prone";
    run(1.5);
    expect(state.stance.kind).toBe(kind);
    expect(state.eyeShift).toBeNull();
  };
  run(0.5);
  const kind = (): StanceKind => state.stance.kind;
  return { state, input, env, collision, carry, step, run, settle, kind };
}

/** Seconds from now until the eye is at rest. */
function untilRest(ctx: ReturnType<typeof setup>): number {
  let seconds = 0;
  while (ctx.state.eyeShift !== null && seconds < 5) {
    ctx.step();
    seconds += DT;
  }
  return seconds;
}

/** The games' four waypoint tables, percent to units, as reverse/iw5-stance/ lists them. */
const TABLES: Record<EyePath, [number, number][]> = {
  standToCrouch: [
    [0, 60],
    [1, 59.5],
    [4, 58.5],
    [30, 56],
    [80, 44],
    [90, 41.5],
    [95, 40.5],
    [100, 40],
  ],
  crouchToStand: [
    [0, 40],
    [5, 40.5],
    [10, 41.5],
    [20, 44],
    [70, 56],
    [96, 58.5],
    [99, 59.5],
    [100, 60],
  ],
  crouchToProne: [
    [0, 40],
    [11, 38],
    [22, 33],
    [34, 25],
    [45, 16],
    [50, 15],
    [55, 16],
    [70, 18],
    [90, 17],
    [100, 11],
  ],
  proneToCrouch: [
    [0, 11],
    [5, 10],
    [30, 21],
    [50, 25],
    [67, 31],
    [83, 34],
    [100, 40],
  ],
};

describe("the eye", () => {
  it("rests at 60, 40 and 11 units, and the hull is 70, 50 and 30 tall", () => {
    const s = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    expect(eyeHeight(s)).toBe(STAND_EYE_HEIGHT);
    expect(hullHeight(s, PLAYER_MOVEMENT)).toBe(STAND_HEIGHT);
    s.stance = CROUCHING;
    expect(eyeHeight(s)).toBeCloseTo(40 * UNIT, 12);
    expect(hullHeight(s, PLAYER_MOVEMENT)).toBeCloseTo(50 * UNIT, 12);
    s.stance = { kind: "prone", heading: 0, torso: 0 };
    expect(eyeHeight(s)).toBeCloseTo(11 * UNIT, 12);
    expect(hullHeight(s, PLAYER_MOVEMENT)).toBeCloseTo(30 * UNIT, 12);
    expect([CROUCH_EYE_HEIGHT, PRONE_EYE_HEIGHT, CROUCH_HEIGHT, PRONE_HEIGHT].map((m) => Math.round(m / UNIT))).toEqual([40, 11, 50, 30]);
  });

  it("passes through every waypoint of each table, and straight between them", () => {
    const s = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    for (const path of EYE_PATHS) {
      const seconds = eyePathSeconds(path);
      const table = TABLES[path];
      for (const [percent, units] of table) {
        s.eyeShift = { path, elapsed: (seconds * percent) / 100 };
        expect(eyeHeight(s), `${path} at ${percent}%`).toBeCloseTo(units * UNIT, 9);
      }
      for (let i = 1; i < table.length; i++) {
        const [p0, h0] = table[i - 1]!;
        const [p1, h1] = table[i]!;
        s.eyeShift = { path, elapsed: (seconds * (p0 + p1)) / 200 };
        expect(eyeHeight(s), `${path} between ${p0}% and ${p1}%`).toBeCloseTo(((h0 + h1) / 2) * UNIT, 9);
      }
    }
  });

  it("takes 200 ms between standing and a crouch and 400 ms to and from prone", () => {
    expect(EYE_PATHS.map(eyePathSeconds)).toEqual([0.2, 0.2, 0.4, 0.4]);
    expect(EYE_PATHS.map(reversedEyePath)).toEqual(["crouchToStand", "standToCrouch", "proneToCrouch", "crouchToProne"]);
  });

  it("dips and bounces going prone, and dips before it comes up", () => {
    const ctx = setup();
    ctx.settle("crouch");
    ctx.input.crouch = false;
    ctx.input.prone = true;
    const heights: number[] = [];
    ctx.run(0.45, () => heights.push(eyeHeight(ctx.state) / UNIT));
    // Down to 15, back up to 18, and settled at 11.
    const lowest = heights.findIndex((h, i) => i > 0 && h > heights[i - 1]!);
    expect(heights[lowest - 1]!).toBeLessThan(16);
    expect(Math.max(...heights.slice(lowest))).toBeGreaterThan(17.5);
    expect(heights.at(-1)).toBeCloseTo(11, 9);
    ctx.input.prone = false;
    ctx.input.crouch = true;
    ctx.step();
    ctx.step();
    expect(eyeHeight(ctx.state) / UNIT).toBeLessThan(11);
  });
});

describe("changing stance", () => {
  it("switches the hull and the speed on the first step, and the eye follows for 200 ms", () => {
    const ctx = setup();
    ctx.input.crouch = true;
    expect(ctx.step()).toBeNull();
    expect(ctx.state.stance.kind).toBe("crouch");
    expect(hullHeight(ctx.state, PLAYER_MOVEMENT)).toBeCloseTo(50 * UNIT, 12);
    expect(speedScale(ctx.state)).toBe(0.65);
    // The eye has not moved on the step the change is made.
    expect(eyeHeight(ctx.state)).toBe(STAND_EYE_HEIGHT);
    const took = untilRest(ctx);
    expect(took).toBeGreaterThan(0.2 - 1e-9);
    expect(took).toBeLessThan(0.2 + DT + 1e-9);
    expect(eyeHeight(ctx.state)).toBeCloseTo(40 * UNIT, 12);

    ctx.input.crouch = false;
    ctx.step();
    expect(ctx.state.stance.kind).toBe("stand");
    expect(hullHeight(ctx.state, PLAYER_MOVEMENT)).toBe(STAND_HEIGHT);
    const back = untilRest(ctx);
    expect(back).toBeGreaterThan(0.2 - 1e-9);
    expect(back).toBeLessThan(0.2 + DT + 1e-9);
    expect(eyeHeight(ctx.state)).toBe(STAND_EYE_HEIGHT);
  });

  it("goes prone from standing through a crouch: 200 ms ducked, then 400 ms down", () => {
    const ctx = setup();
    ctx.input.prone = true;
    ctx.step();
    expect(ctx.state.stance.kind).toBe("crouch");
    expect(ctx.state.eyeShift?.path).toBe("standToCrouch");
    let ducked = 0;
    while (ctx.kind() === "crouch") {
      ctx.step();
      ducked += DT;
    }
    expect(ducked).toBeGreaterThan(0.2 - 1e-9);
    expect(ducked).toBeLessThan(0.2 + 2 * DT + 1e-9);
    expect(ctx.state.stance.kind).toBe("prone");
    expect(ctx.state.eyeShift?.path).toBe("crouchToProne");
    const down = untilRest(ctx);
    expect(down).toBeGreaterThan(0.4 - 1e-9);
    expect(down).toBeLessThan(0.4 + DT + 1e-9);
    expect(eyeHeight(ctx.state)).toBeCloseTo(11 * UNIT, 12);

    // And back: 400 ms as a crouch, then 200 ms to standing.
    ctx.input.prone = false;
    ctx.step();
    expect(ctx.state.stance.kind).toBe("crouch");
    expect(ctx.state.eyeShift?.path).toBe("proneToCrouch");
    let rising = 0;
    while (ctx.kind() === "crouch") {
      ctx.step();
      rising += DT;
    }
    expect(rising).toBeGreaterThan(0.4 - 1e-9);
    expect(rising).toBeLessThan(0.4 + 2 * DT + 1e-9);
    expect(ctx.state.stance.kind).toBe("stand");
    expect(untilRest(ctx)).toBeLessThan(0.2 + DT + 1e-9);
  });

  it("moves one step at a time, and never while the eye is moving", () => {
    const ctx = setup();
    ctx.input.crouch = true;
    ctx.step();
    // Let go at once: the crouch is finished before the stand begins.
    ctx.input.crouch = false;
    ctx.run(0.1, () => expect(ctx.state.stance.kind).toBe("crouch"));
    ctx.run(0.2);
    expect(ctx.state.stance.kind).toBe("stand");
  });

  it("starts a landing's grip on going prone, which is what stops a body sliding as it drops", () => {
    const ctx = setup();
    ctx.settle("crouch");
    expect(ctx.state.landing).toBe(0);
    ctx.input.crouch = false;
    ctx.input.prone = true;
    ctx.step();
    expect(ctx.state.stance.kind).toBe("prone");
    expect(ctx.state.landing).toBeCloseTo(LAND_WINDOW - DT, 9);
  });
});

/** A slab whose underside is 55 units up, from z = -2 to z = -6: room to crouch under and not to stand. */
const LOW_CEILING = (): THREE.Mesh => collider([4, 0.2, 4], [0, 55 * UNIT + 0.1, -4]);

describe("head room", () => {
  it("stops a standing player at a 55-unit ceiling and lets a crouched one under it", () => {
    const standing = setup([FLOOR(), LOW_CEILING()]);
    standing.input.forward = 1;
    standing.run(3);
    expect(standing.state.feet.z).toBeGreaterThan(-2);

    const crouched = setup([FLOOR(), LOW_CEILING()]);
    crouched.settle("crouch");
    crouched.input.forward = 1;
    crouched.run(1);
    expect(crouched.state.feet.z).toBeLessThan(-2.5);
    expect(crouched.state.feet.z).toBeGreaterThan(-5.5);
  });

  it("keeps a crouched player crouched under it, whatever the keys say, until there is room", () => {
    const ctx = setup([FLOOR(), LOW_CEILING()]);
    ctx.settle("crouch");
    ctx.input.forward = 1;
    ctx.run(1);
    ctx.input.forward = 0;
    ctx.input.crouch = false;
    ctx.run(0.5, (forced) => {
      expect(forced).toBe("crouch");
      expect(ctx.state.stance.kind).toBe("crouch");
    });
    // The jump key asks for the same thing and gets the same answer: no stand, no jump.
    ctx.input.crouch = true;
    ctx.input.jump = true;
    expect(ctx.step()).toBe("crouch");
    ctx.input.jump = false;
    ctx.run(0.3, () => expect(ctx.state.grounded).toBe(true));
    expect(ctx.state.stance.kind).toBe("crouch");
    // Out the far side, standing is allowed again.
    ctx.input.forward = 1;
    ctx.run(4);
    expect(ctx.state.feet.z).toBeLessThan(-6.5);
    ctx.input.crouch = false;
    ctx.run(0.5);
    expect(ctx.state.stance.kind).toBe("stand");
  });

  it("does not start a sprint where there is no room to stand", () => {
    const ctx = setup([FLOOR(), LOW_CEILING()]);
    ctx.settle("crouch");
    ctx.input.forward = 1;
    ctx.run(1);
    ctx.input.run = true;
    expect(wantsSprint(ctx.state, ctx.input, ctx.env)).toBe(false);
    ctx.run(0.5, () => expect(ctx.state.stance.kind).toBe("crouch"));
    expect(horizontalSpeed(ctx.state)).toBeLessThanOrEqual(0.65 * WALK_SPEED + 1e-9);
  });

  it("gets up from prone only as far as a crouch under it", () => {
    const ctx = setup([FLOOR(), LOW_CEILING()]);
    ctx.state.feet.z = -4;
    ctx.settle("prone");
    ctx.input.prone = false;
    ctx.run(1.5);
    expect(ctx.state.stance.kind).toBe("crouch");
  });
});

describe("what forces a stance", () => {
  it("stands a crouched player up on a jump press, and does not jump", () => {
    const ctx = setup();
    ctx.settle("crouch");
    ctx.input.jump = true;
    expect(ctx.step()).toBe("stand");
    expect(ctx.state.stance.kind).toBe("stand");
    expect(ctx.state.jumpFrom).toBeNull();
    // The toggle followed the step, and the key is still down: neither jumps.
    ctx.input.crouch = false;
    ctx.run(0.6, () => {
      expect(ctx.state.grounded).toBe(true);
      expect(ctx.state.jumpFrom).toBeNull();
    });
    // A new press, standing, is a jump.
    ctx.input.jump = false;
    ctx.step();
    ctx.input.jump = true;
    ctx.step();
    expect(ctx.state.jumpFrom).not.toBeNull();
  });

  it("stands a prone player up on a jump press, through a crouch, without leaving the ground", () => {
    const ctx = setup();
    ctx.settle("prone");
    ctx.input.jump = true;
    expect(ctx.step()).toBe("stand");
    expect(ctx.state.stance.kind).toBe("crouch");
    ctx.input.jump = false;
    ctx.input.prone = false;
    ctx.run(1, () => expect(ctx.state.grounded).toBe(true));
    expect(ctx.state.stance.kind).toBe("stand");
    expect(ctx.state.eyeShift).toBeNull();
  });

  it("stands a crouched player up at once for a sprint, and runs", () => {
    const ctx = setup();
    ctx.settle("crouch");
    ctx.input.forward = 1;
    ctx.input.run = true;
    // Not while crouch is still asked for: the stance key outranks the run key.
    ctx.run(0.3);
    expect(ctx.state.stance.kind).toBe("crouch");
    ctx.input.crouch = false;
    ctx.step();
    expect(ctx.state.stance.kind).toBe("stand");
    ctx.run(1);
    expect(horizontalSpeed(ctx.state)).toBeCloseTo(RUN_SPEED, 3);
  });

  it("ends a sprint when crouch or prone is asked for, and goes down", () => {
    for (const key of ["crouch", "prone"] as const) {
      const ctx = setup();
      ctx.input.forward = 1;
      ctx.input.run = true;
      ctx.run(1);
      expect(horizontalSpeed(ctx.state)).toBeCloseTo(RUN_SPEED, 3);
      ctx.input[key] = true;
      ctx.run(1.5);
      expect(ctx.state.stance.kind).toBe(key);
      expect(horizontalSpeed(ctx.state)).toBeLessThan(WALK_SPEED);
    }
  });

  it("stands a prone player up at once for a sprint, the eye coming up through both heights", () => {
    const ctx = setup();
    ctx.settle("prone");
    ctx.input.forward = 1;
    ctx.input.run = true;
    ctx.input.prone = false;
    ctx.step();
    expect(ctx.state.stance.kind).toBe("stand");
    expect(hullHeight(ctx.state, PLAYER_MOVEMENT)).toBe(STAND_HEIGHT);
    expect(ctx.state.eyeShift?.path).toBe("proneToCrouch");
    const took = untilRest(ctx);
    expect(took).toBeGreaterThan(0.6 - 1e-9);
    expect(took).toBeLessThan(0.6 + 2 * DT + 1e-9);
    expect(eyeHeight(ctx.state)).toBe(STAND_EYE_HEIGHT);
  });

  it("turns the eye round where it is when a sprint interrupts it", () => {
    const ctx = setup();
    ctx.input.crouch = true;
    ctx.run(0.1);
    const before = eyeHeight(ctx.state);
    expect(ctx.state.eyeShift?.path).toBe("standToCrouch");
    ctx.input.crouch = false;
    ctx.input.forward = 1;
    ctx.input.run = true;
    ctx.step();
    expect(ctx.state.eyeShift?.path).toBe("crouchToStand");
    expect(eyeHeight(ctx.state)).toBeCloseTo(before, 9);
  });

  it("does not go prone in the air: the request waits for the ground", () => {
    const ctx = setup();
    ctx.input.jump = true;
    ctx.step();
    ctx.input.jump = false;
    ctx.input.prone = true;
    let air = 0;
    while (!ctx.state.grounded && air < 2) {
      expect(ctx.step()).toBeNull();
      if (!ctx.state.grounded) {
        expect(ctx.state.stance.kind).toBe("stand");
      }
      air += DT;
    }
    expect(air).toBeGreaterThan(0.5);
    ctx.run(1);
    expect(ctx.state.stance.kind).toBe("prone");
  });

  it("crouches in the air: going down needs no room and no ground", () => {
    const ctx = setup();
    ctx.input.jump = true;
    ctx.step();
    ctx.input.jump = false;
    ctx.input.crouch = true;
    ctx.step();
    expect(ctx.state.grounded).toBe(false);
    expect(ctx.state.stance.kind).toBe("crouch");
  });

  it("brings a prone body up to a crouch when it falls with its legs in something", () => {
    // A platform ending 0.3 m ahead, with nothing under what is beyond it.
    const ctx = setup([collider([10, 1, 10], [0, -0.5, 4.7]), collider([40, 1, 40], [0, -5.5, 0])]);
    ctx.settle("prone");
    ctx.input.forward = 1;
    let forced: StanceKind | null = null;
    ctx.run(4, (f) => (forced ??= f));
    // Off the edge head first, the legs meet the platform it left: it falls on, crouched.
    expect(forced).toBe("crouch");
    expect(ctx.state.feet.y).toBeCloseTo(-5, 2);
  });

  it("stands a crouched player who takes hold of a ladder, and gives a prone one none", () => {
    const ladder: ResolvedLadder = { id: 0, tags: [], position: { x: 0, y: 1.5, z: -2 }, yaw: 0, size: { x: 0.8, y: 3, z: 0.2 } };
    const world = () => [FLOOR(), collider([40, 3, 8], [0, 1.5, -6.1]), collider([0.8, 3, 0.2], [0, 1.5, -2])];
    const rules = { mantles: NO_MANTLES, ladders: new LadderVolumes([ladder]) };

    const crouched = setup(world(), rules);
    crouched.settle("crouch");
    crouched.input.forward = 1;
    let forced: StanceKind | null = null;
    let steps = 0;
    while (crouched.state.move.kind !== "ladder" && steps++ < 120) {
      forced = crouched.step();
    }
    expect(crouched.state.move.kind).toBe("ladder");
    // The step it takes hold on says nothing; the next one stands them up.
    expect(forced).toBeNull();
    expect(crouched.step()).toBe("stand");
    expect(crouched.state.stance.kind).toBe("stand");

    const prone = setup(world(), rules);
    prone.settle("prone");
    prone.input.forward = 1;
    prone.run(6, () => expect(prone.state.move.kind).toBe("walk"));
    expect(prone.state.stance.kind).toBe("prone");
  });

  it("starts no climb but standing", () => {
    const volume: ResolvedMantle = { id: 1, tags: [], position: { x: 0, y: 0.5, z: -2 }, yaw: 0, size: { x: 4, y: 1, z: 0.5 } };
    const world = () => [FLOOR(), collider([40, 1, 8], [0, 0.5, -6])];
    const rules = { mantles: new MantleVolumes([volume]), ladders: NO_LADDERS };
    const at = (ctx: ReturnType<typeof setup>) => {
      ctx.state.feet.z = -1.8 + RADIUS;
      ctx.run(0.2);
    };

    const standing = setup(world(), rules);
    at(standing);
    standing.input.jump = true;
    standing.step();
    expect(standing.state.move.kind).toBe("mantle");

    const crouched = setup(world(), rules);
    at(crouched);
    crouched.settle("crouch");
    // The press stands them up, and only a key still down once the eye is up there climbs.
    crouched.input.jump = true;
    expect(crouched.step()).toBe("stand");
    expect(crouched.state.move.kind).toBe("walk");
    crouched.input.crouch = false;
    crouched.run(0.15, () => expect(crouched.state.move.kind).toBe("walk"));
    crouched.run(0.1);
    expect(crouched.state.move.kind).toBe("mantle");

    // Lying down that is 600 ms later, and nothing at all with the key let go.
    const prone = setup(world(), rules);
    at(prone);
    prone.settle("prone");
    prone.input.jump = true;
    prone.step();
    prone.input.prone = false;
    prone.run(0.35, () => expect(prone.state.move.kind).toBe("walk"));
    prone.input.jump = false;
    prone.run(1, () => expect(prone.state.move.kind).toBe("walk"));
    expect(prone.state.stance.kind).toBe("stand");
  });
});

describe("speed", () => {
  it("walks at 0.65 of the speed crouched and 0.15 prone", () => {
    const crouched = setup();
    crouched.settle("crouch");
    crouched.input.forward = 1;
    crouched.run(2);
    expect(horizontalSpeed(crouched.state)).toBeCloseTo(0.65 * WALK_SPEED, 6);

    const prone = setup();
    prone.settle("prone");
    prone.input.forward = 1;
    prone.run(3);
    expect(horizontalSpeed(prone.state)).toBeCloseTo(0.15 * WALK_SPEED, 6);
    // Backward and sideways are the same shares of it that they are standing.
    prone.input.forward = -1;
    prone.run(3);
    expect(horizontalSpeed(prone.state)).toBeCloseTo(0.15 * 0.7 * WALK_SPEED, 6);
  });

  it("accelerates at 9, 12 and 19 times the speed asked for, by stance", () => {
    const dt = 1 / 250;
    const first = (kind: StanceKind): number => {
      const ctx = setup();
      ctx.settle(kind);
      ctx.run(2); // a landing's grip, which going prone starts, has worn off
      ctx.input.forward = 1;
      ctx.step(dt);
      return horizontalSpeed(ctx.state);
    };
    // Acceleration works on at least 100 units a second, which is more than a crawl asks for.
    expect(first("stand")).toBeCloseTo(9 * dt * WALK_SPEED, 9);
    expect(first("crouch")).toBeCloseTo(12 * dt * 0.65 * WALK_SPEED, 9);
    expect(first("prone")).toBeCloseTo(19 * dt * 100 * UNIT, 9);
  });

  it("blends the crouch's speed into the crawl's across the eye's way down, and back", () => {
    const s = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    s.stance = { kind: "prone", heading: 0, torso: 0 };
    s.eyeShift = { path: "crouchToProne", elapsed: 0.1 };
    expect(speedScale(s)).toBeCloseTo(0.65 + (0.15 - 0.65) * 0.25, 12);
    s.stance = CROUCHING;
    s.eyeShift = { path: "proneToCrouch", elapsed: 0.3 };
    expect(speedScale(s)).toBeCloseTo(0.15 + (0.65 - 0.15) * 0.75, 12);
    s.eyeShift = { path: "standToCrouch", elapsed: 0.1 };
    expect(speedScale(s)).toBe(0.65);
  });

  it("does not crawl under a weapon that is aimed or firing", () => {
    const ctx = setup();
    ctx.settle("prone");
    ctx.carry.braced = true;
    ctx.input.forward = 1;
    ctx.input.right = 1;
    const from = { ...ctx.state.feet };
    ctx.run(1);
    expect(ctx.state.feet).toEqual(from);
    ctx.carry.braced = false;
    ctx.run(1);
    expect(ctx.state.feet.z).toBeLessThan(from.z - 0.3);

    // Standing or crouched it holds nobody.
    const crouched = setup();
    crouched.settle("crouch");
    crouched.carry.braced = true;
    crouched.input.forward = 1;
    crouched.run(1);
    expect(crouched.state.feet.z).toBeLessThan(-1);
  });
});

describe("prone blocked", () => {
  it("lies down in the open, facing any way", () => {
    for (const yaw of [0, 1, 2.5, -2]) {
      const ctx = setup();
      ctx.input.yaw = yaw;
      ctx.settle("prone");
      expect((ctx.state.stance as Extract<Stance, { kind: "prone" }>).heading).toBe(yaw);
    }
  });

  it("refuses to lie down with a wall where the legs would be, and stays as it was", () => {
    // Facing -Z, the feet go to +Z: a wall 24 units behind is in them, one 60 behind is not.
    const near = setup([FLOOR(), collider([6, 3, 0.2], [0, 1.5, 24 * UNIT + 0.1])]);
    near.input.prone = true;
    near.run(1, (forced) => {
      expect(forced).toBe("stand");
      expect(near.state.stance.kind).toBe("stand");
    });
    // Crouched, the answer is the same and the stance asked back is the crouch.
    near.input.prone = false;
    near.settle("crouch");
    near.input.crouch = false;
    near.input.prone = true;
    near.run(0.5, (forced) => {
      expect(forced).toBe("crouch");
      expect(near.state.stance.kind).toBe("crouch");
    });
    // Turned round, the legs have the whole floor.
    near.input.yaw = Math.PI;
    near.run(1);
    expect(near.state.stance.kind).toBe("prone");

    const far = setup([FLOOR(), collider([6, 3, 0.2], [0, 1.5, 60 * UNIT + 0.1])]);
    far.settle("prone");
  });

  it("refuses to lie down with the legs over a drop", () => {
    // A platform ending half a metre behind the player, the next floor five metres down.
    const world = () => [collider([10, 1, 10], [0, -0.5, -4.5]), collider([40, 1, 40], [0, -5.5, 0])];
    const over = setup(world());
    over.input.prone = true;
    over.run(1, (forced) => expect(forced).toBe("stand"));
    expect(over.state.stance.kind).toBe("stand");

    const along = setup(world());
    along.input.yaw = Math.PI;
    along.settle("prone");
  });

  it("lies with the feet up a low kerb, and not across a tall one", () => {
    const { collision } = setup([FLOOR(), collider([6, 4 * UNIT, 2], [0, 2 * UNIT, 1.4])]);
    expect(proneFits(collision, { x: 0, y: 0, z: 0 }, 0, 50 * UNIT, true)).toBe(true);
    const { collision: kerbed } = setup([FLOOR(), collider([6, 12 * UNIT, 2], [0, 6 * UNIT, 1.6])]);
    expect(proneFits(kerbed, { x: 0, y: 0, z: 0 }, 0, 50 * UNIT, true)).toBe(false);
  });

  it("asks only the legs' run of a body in the air", () => {
    const { collision } = setup([FLOOR(), collider([6, 3, 0.2], [0, 6.5, 24 * UNIT + 0.1])]);
    expect(proneFits(collision, { x: 0, y: 5, z: 0 }, 0, 50 * UNIT, false)).toBe(false);
    expect(proneFits(collision, { x: 0, y: 5, z: 0 }, Math.PI, 50 * UNIT, false)).toBe(true);
    // The same place on the ground has none under it.
    expect(proneFits(collision, { x: 0, y: 5, z: 0 }, Math.PI, 50 * UNIT, true)).toBe(false);
  });

  it("turns the body after the view at 55 degrees a second", () => {
    const ctx = setup();
    ctx.settle("prone");
    const lying = ctx.state.stance as Extract<Stance, { kind: "prone" }>;
    ctx.input.yaw = 60 * DEGREE;
    ctx.run(0.5);
    expect(lying.heading).toBeCloseTo(0.5 * 55 * DEGREE, 6);
    expect(ctx.state.yaw).toBe(60 * DEGREE);
    ctx.run(1);
    expect(lying.heading).toBe(60 * DEGREE);
  });

  it("leaves a body where it lies when prone is not asked for, until the view is 80 degrees off it or it crawls", () => {
    // Under a ceiling too low to crouch under, a body stays prone with no key held.
    const low = setup([FLOOR(), collider([4, 0.2, 4], [0, 40 * UNIT + 0.1, -4])]);
    low.state.feet.z = -4;
    low.settle("prone");
    low.input.prone = false;
    low.run(0.5, (forced) => expect(forced).toBe("prone"));
    const lying = low.state.stance as Extract<Stance, { kind: "prone" }>;
    low.input.yaw = 40 * DEGREE;
    low.run(1);
    expect(lying.heading).toBe(0);
    low.input.yaw = 82 * DEGREE;
    low.run(0.2);
    // Only until it is within 80 again.
    expect(lying.heading).toBeGreaterThanOrEqual(2 * DEGREE - 1e-9);
    expect(lying.heading).toBeLessThan(3 * DEGREE);
    const held = lying.heading;
    low.input.yaw = held + 30 * DEGREE;
    low.run(0.2);
    expect(lying.heading).toBe(held);
    low.input.forward = 1;
    low.run(0.2);
    expect(lying.heading).toBeGreaterThan(held);
  });

  it("holds the view within 85 degrees of the body, and its pitch within 45 of the torso", () => {
    const ctx = setup();
    ctx.settle("prone");
    ctx.input.yaw = 170 * DEGREE;
    ctx.input.pitch = 80 * DEGREE;
    ctx.step();
    const lying = ctx.state.stance as Extract<Stance, { kind: "prone" }>;
    expect(ctx.state.yaw - lying.heading).toBeCloseTo(PRONE_YAW_CAP, 9);
    expect(ctx.state.pitch).toBeCloseTo(PRONE_PITCH_CAP, 9);
    ctx.input.pitch = -80 * DEGREE;
    ctx.step();
    expect(ctx.state.pitch).toBeCloseTo(-PRONE_PITCH_CAP, 9);
    // Standing, neither is held.
    const standing = setup();
    standing.input.yaw = 170 * DEGREE;
    standing.input.pitch = 80 * DEGREE;
    standing.step();
    expect(standing.state.yaw).toBe(170 * DEGREE);
    expect(standing.state.pitch).toBeCloseTo(80 * DEGREE, 12);
  });

  /** A wall along the body's right side, half a metre off: room to lie beside, none to swing the legs into. */
  const BESIDE = (): THREE.Mesh => collider([0.2, 3, 12], [0.6, 1.5, 0]);

  it("does not turn the body into a wall, and pushes the view back to what the body allows", () => {
    const open = setup();
    open.settle("prone");
    open.input.yaw = 80 * DEGREE;
    open.run(3);
    expect((open.state.stance as Extract<Stance, { kind: "prone" }>).heading).toBe(80 * DEGREE);

    // Turning left swings the feet right, into the wall.
    const ctx = setup([FLOOR(), BESIDE()]);
    ctx.settle("prone");
    const lying = ctx.state.stance as Extract<Stance, { kind: "prone" }>;
    ctx.input.yaw = 80 * DEGREE;
    ctx.run(3, () => {
      // Wherever the body has got to, it fits there.
      expect(proneFits(ctx.collision, ctx.state.feet, lying.heading, 45 * UNIT, true)).toBe(true);
    });
    // The legs reach the wall some twenty degrees round, and a body twisted toward
    // a view further round than that is tested nearer the view: it does not start.
    expect(lying.heading).toBeLessThan(20 * DEGREE);
    // The view asked for 80 and was turned back to what the legs allow.
    expect(ctx.state.yaw).toBeGreaterThan(5 * DEGREE);
    expect(ctx.state.yaw).toBeLessThan(30 * DEGREE);
    expect(ctx.state.yaw).toBeGreaterThanOrEqual(lying.heading);
    expect(ctx.state.yaw - lying.heading).toBeLessThanOrEqual(PRONE_YAW_CAP + 1e-9);
    // Held there, it does not creep.
    const held = ctx.state.yaw;
    const body = lying.heading;
    ctx.run(1);
    expect(Math.abs(ctx.state.yaw - held)).toBeLessThan(0.1 * DEGREE);
    expect(lying.heading).toBe(body);
    // Away from the wall there is nothing to stop either.
    ctx.input.yaw = -80 * DEGREE;
    ctx.run(4);
    expect(lying.heading).toBe(-80 * DEGREE);
    expect(ctx.state.yaw).toBe(-80 * DEGREE);
  });

  it("gives the camera the same answer the step will, for a turn no step has spent", () => {
    const ctx = setup([FLOOR(), BESIDE()]);
    ctx.settle("prone");
    ctx.input.yaw = 80 * DEGREE;
    ctx.run(3);
    for (const ask of [80, 60, 30, -20, 170].map((d) => d * DEGREE)) {
      const seen = capYaw(ctx.state, ask, ctx.env);
      const copy = structuredClone(ctx.state);
      const input = { ...ctx.input, yaw: ask, prone: false };
      stepMovement(copy, input, DT, ctx.env, ctx.carry);
      expect(copy.yaw, `asked ${ask / DEGREE}`).toBeCloseTo(seen, 9);
    }
    expect(capPitch(ctx.state, 1.5)).toBeCloseTo(PRONE_PITCH_CAP, 9);
  });

  it("undoes a crawl that would put the legs in a wall", () => {
    // Crawling backward at a wall two metres behind: the capsule would reach it, the legs must not.
    const ctx = setup([FLOOR(), collider([6, 3, 0.2], [0, 1.5, 2.1])]);
    ctx.settle("prone");
    ctx.input.forward = -1;
    const lying = ctx.state.stance as Extract<Stance, { kind: "prone" }>;
    ctx.run(8, () => expect(proneFits(ctx.collision, ctx.state.feet, lying.heading, 50 * UNIT, true)).toBe(true));
    expect(ctx.state.feet.z).toBeGreaterThan(0.4);
    expect(ctx.state.feet.z).toBeLessThan(2 - 34 * UNIT);
    // Standing, the same walk ends against the wall itself.
    const standing = setup([FLOOR(), collider([6, 3, 0.2], [0, 1.5, 2.1])]);
    standing.input.forward = -1;
    standing.run(4);
    expect(standing.state.feet.z).toBeGreaterThan(2 - RADIUS - 0.02);
  });

  it("crawls onto a kerb of 9 units and not one of 12, which a standing player steps onto", () => {
    const kerb = (units: number) => [FLOOR(), collider([6, units * UNIT, 6], [0, (units * UNIT) / 2, -4])];
    const climbs = (units: number, kind: StanceKind): number => {
      const ctx = setup(kerb(units));
      ctx.settle(kind);
      ctx.input.forward = 1;
      let top = 0;
      ctx.run(kind === "prone" ? 8 : 3, () => (top = Math.max(top, ctx.state.feet.y)));
      return top / UNIT;
    };
    expect(climbs(12, "stand")).toBeCloseTo(12, 0);
    expect(climbs(9, "prone")).toBeCloseTo(9, 0);
    expect(climbs(12, "prone")).toBeLessThan(2);
  });
});

describe("a swept ball", () => {
  // What a lying body's legs are asked with (`CapsuleWorld.overlapsSweep`).
  const root = new THREE.Group();
  root.add(FLOOR(), collider([6, 3, 0.2], [0, 1.5, 1]));
  const world = new CollisionWorld();
  world.rebuild(root);
  const from = { x: 0, y: 0.6, z: 0 };

  it("is stopped by what comes within its radius, and not by what it passes beside", () => {
    expect(world.overlapsSweep(from, { x: 0, y: 0.6, z: 0.7 }, 0.15)).toBe(false);
    expect(world.overlapsSweep(from, { x: 0, y: 0.6, z: 0.8 }, 0.15)).toBe(true);
    expect(world.overlapsSweep(from, { x: 2, y: 0.6, z: 0.7 }, 0.15)).toBe(false);
    expect(world.overlapsSweep({ x: 0, y: 0.1, z: 0 }, { x: 2, y: 0.1, z: 0 }, 0.15)).toBe(true);
  });

  it("is stopped by a surface it passes clean through, far from any of its edges", () => {
    // Through the wall and out the other side, both ends in the open.
    expect(world.overlapsSweep(from, { x: 0, y: 0.6, z: 2 }, 0.15)).toBe(true);
    // And through the middle of a floor forty metres across.
    expect(world.overlapsSweep({ x: 5, y: 0.5, z: 5 }, { x: 5.1, y: -1.5, z: 5 }, 0.05)).toBe(true);
  });
});

/** How many bits `codec` writes for `value`. */
function bitsOf<T>(codec: Codec<T>, value: T): number {
  const w = new BitWriter();
  codec.write(w, value);
  const bytes = w.byteLength;
  let spare = 0;
  while (w.byteLength === bytes) {
    w.bits(0, 1);
    spare++;
  }
  return bytes * 8 - (spare - 1);
}

describe("stance on the wire", () => {
  const through = (state: MovementState): MovementState => {
    const w = new BitWriter();
    movementSchema.write(w, state);
    return movementSchema.read(new BitReader(w.finish()));
  };

  it("costs a standing player three bits, and a lying one their heading and torso", () => {
    const state = createMovement({ x: 1, y: 2, z: 3 }, 0.5, 0.1);
    const standing = bitsOf(movementSchema, state);
    expect(standing).toBe(289);
    state.stance = CROUCHING;
    expect(bitsOf(movementSchema, state)).toBe(standing);
    state.eyeShift = { path: "standToCrouch", elapsed: 0.1 };
    expect(bitsOf(movementSchema, state)).toBe(standing + 14);
    state.eyeShift = null;
    state.stance = { kind: "prone", heading: 1, torso: 0.2 };
    expect(bitsOf(movementSchema, state)).toBe(standing + 32);
  });

  it("round-trips every stance and every path of the eye", () => {
    const state = createMovement({ x: 1, y: 2, z: 3 }, 0.5, 0.1);
    for (const stance of [STANDING, CROUCHING, { kind: "prone", heading: -2.5, torso: 0.3 }] as Stance[]) {
      for (const path of [null, ...EYE_PATHS]) {
        state.stance = stance;
        state.eyeShift = path === null ? null : { path, elapsed: 0.123 };
        const back = through(state);
        expect(back.stance.kind).toBe(stance.kind);
        if (back.stance.kind === "prone" && stance.kind === "prone") {
          expect(back.stance.heading).toBeCloseTo(stance.heading, 3);
          expect(back.stance.torso).toBeCloseTo(stance.torso, 3);
        }
        expect(back.eyeShift?.path ?? null).toBe(path);
        if (back.eyeShift) {
          expect(back.eyeShift.elapsed).toBeCloseTo(0.123, 4);
        }
        // What arrived is what the codec says it rounds to, and stays put from there.
        expect(back).toEqual(movementSchema.round!(state));
        expect(through(back)).toEqual(back);
      }
    }
  });

  it("carries the two stance levels of an input", () => {
    for (const [crouch, prone] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const rounded = roundInput({ ...idleInput(0.3, -0.1), crouch, prone });
      expect([rounded.crouch, rounded.prone]).toEqual([crouch, prone]);
    }
  });
});

describe("stance between two ticks", () => {
  it("copies every stance over every stance, and an eye shift or none over either", () => {
    const stances: Stance[] = [STANDING, CROUCHING, { kind: "prone", heading: 1.5, torso: -0.25 }];
    for (const from of stances) {
      for (const over of stances) {
        for (const shift of [null, { path: "proneToCrouch" as const, elapsed: 0.3 }]) {
          const src = { ...createMovement({ x: 0, y: 0, z: 0 }, 0, 0), stance: structuredClone(from), eyeShift: structuredClone(shift) };
          const dst = {
            ...createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
            stance: structuredClone(over),
            eyeShift: shift ? null : { path: "standToCrouch" as const, elapsed: 0.1 },
          };
          copyMovement(src, dst);
          expect(dst).toEqual(src);
          if (from.kind === "prone") {
            expect(dst.stance).not.toBe(src.stance);
          }
          if (shift) {
            expect(dst.eyeShift).not.toBe(src.eyeShift);
          }
        }
      }
    }
  });

  it("moves the eye between two ticks: along a path, to its end, and on from rest only at the next tick", () => {
    const at = (stance: Stance, path: EyePath | null, elapsed = 0): MovementState => ({
      ...createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
      stance,
      eyeShift: path === null ? null : { path, elapsed },
    });
    const out = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    const eye = (from: MovementState, to: MovementState, t: number): number => eyeHeight(lerpMovement(from, to, t, out)) / UNIT;

    // Along one path: the clock is interpolated, so the eye is on the curve.
    const a = at(CROUCHING, "standToCrouch", 0.06);
    const b = at(CROUCHING, "standToCrouch", 0.1);
    expect(eye(a, b, 0.5)).toBeCloseTo(eyeHeight(at(CROUCHING, "standToCrouch", 0.08)) / UNIT, 9);
    // The tick it arrives on: it runs to the path's end.
    const last = at(CROUCHING, "standToCrouch", 0.19);
    expect(eye(last, at(CROUCHING, null), 1)).toBeCloseTo(40, 9);
    expect(eye(last, at(CROUCHING, null), 0.5)).toBeCloseTo(eyeHeight(at(CROUCHING, "standToCrouch", 0.195)) / UNIT, 9);
    // ...and likewise where the next path begins on that tick.
    expect(eye(last, at({ kind: "prone", heading: 0, torso: 0 }, "crouchToProne", 0), 1)).toBeCloseTo(40, 9);
    // The tick it leaves on, the eye has not moved yet.
    expect(eye(at(STANDING, null), at(CROUCHING, "standToCrouch", 0), 0.7)).toBe(60);
    // Turned round, it stays where the earlier tick had it.
    expect(eye(a, at(STANDING, "crouchToStand", 0.14), 0.9)).toBeCloseTo(eyeHeight(a) / UNIT, 9);
    // And the output's shift is its own object, whatever it was handed.
    expect(lerpMovement(a, b, 0.5, out).eyeShift).not.toBe(a.eyeShift);
    expect(lerpMovement(a, b, 0.5, a).eyeShift).toEqual({ path: "standToCrouch", elapsed: 0.08 });
  });
});

describe("stance as state", () => {
  it("is plain data: a JSON copy steps in lockstep through every stance, a turn and a crawl", () => {
    const ctx = setup([FLOOR(), collider([0.2, 3, 12], [0.6, 1.5, 0]), LOW_CEILING()]);
    let copy = JSON.parse(JSON.stringify(ctx.state)) as MovementState;
    const script: [seconds: number, set: () => void][] = [
      [0.1, () => (ctx.input.crouch = true)],
      [0.4, () => (ctx.input.forward = 1)],
      [0.3, () => ((ctx.input.crouch = false), (ctx.input.prone = true))],
      [1.2, () => (ctx.input.yaw = 70 * DEGREE)],
      [0.5, () => ((ctx.input.forward = -1), (ctx.input.pitch = 1.2))],
      [0.2, () => (ctx.input.jump = true)],
      [0.9, () => ((ctx.input.jump = false), (ctx.input.prone = false), (ctx.input.forward = 1))],
      [0.4, () => ((ctx.input.run = true), (ctx.input.crouch = true))],
      [0.5, () => ((ctx.input.run = false), (ctx.input.yaw = 0))],
      [0.5, () => (ctx.input.jump = true)],
    ];
    const seen = new Set<string>();
    for (const [seconds, set] of script) {
      set();
      for (let t = 0; t < seconds - 1e-9; t += DT) {
        const forced = stepMovement(ctx.state, ctx.input, DT, ctx.env, ctx.carry);
        expect(stepMovement(copy, ctx.input, DT, ctx.env, ctx.carry)).toBe(forced);
        expect(copy).toEqual(ctx.state);
        // And once more through JSON, so nothing lives outside it.
        copy = JSON.parse(JSON.stringify(copy)) as MovementState;
        seen.add(`${ctx.state.stance.kind}/${ctx.state.eyeShift?.path ?? "rest"}`);
      }
    }
    expect([...seen].sort()).toEqual(
      ["crouch/proneToCrouch", "crouch/rest", "crouch/standToCrouch", "prone/crouchToProne", "prone/rest", "stand/crouchToStand", "stand/rest"].sort(),
    );
  });
});
