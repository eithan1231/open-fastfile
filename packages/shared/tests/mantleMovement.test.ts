// Mantling as a movement step: when a held jump starts one, the path it runs on
// rails, how long it takes, how it ends, and what it holds of the view and the
// stance (reverse/iw5-mantle/).
//
// The two that would be silent if they broke: the capsule must never sink into
// anything on the way (every mantle here is checked at every step), and the
// whole of it must survive a JSON round-trip, or a peer's mantle would arrive
// as a teleport.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { idleInput } from "../src/sim/input.js";
import {
  createMovement,
  EMPTY_HANDS,
  JUMP_HEIGHT,
  movementEnv,
  PLAYER_MOVEMENT,
  RADIUS,
  stepMovement,
  type MantleMove,
  type MovementState,
  type StanceKind,
} from "../src/sim/movement.js";
import { LadderVolumes, NO_LADDERS } from "../src/sim/moves/ladder.js";
import { MANTLE_ROWS, MANTLE_TIME_MAX, MantleVolumes } from "../src/sim/moves/mantle.js";
import { hullHeight } from "../src/sim/stance.js";
import { UNIT } from "../src/sim/units.js";
import { capYaw } from "../src/sim/view.js";
import { movementSchema } from "../src/net/messages/player.js";
import { BitReader, BitWriter } from "../src/net/codec/bits.js";
import type { ResolvedLadder, ResolvedMantle } from "../src/dsl/resolved.js";

const DT = 1 / 60;
const DEGREE = Math.PI / 180;
/** The face of everything a test climbs, which a player faces along -Z. */
const FACE = -2;
/** Standing against it. */
const AGAINST = FACE + RADIUS + 0.005;

function collider(size: [number, number, number], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  return mesh;
}

interface Course {
  /** How tall the obstacle is, in the games' units. */
  units?: number;
  /** How far back from its face it goes, m: a block by default, a rail at 0.2. */
  depth?: number;
  kind?: "onto" | "over";
  /** No volume: the same geometry with no permission to climb it. */
  bare?: boolean;
  extra?: THREE.Mesh[];
  ladders?: ResolvedLadder[];
  /** Where the player starts, on the floor. */
  z?: number;
  /** Jump is down from the first step, so no later step is a press of it. */
  held?: boolean;
}

/**
 * A floor at y = 0, an obstacle whose face is at z = -2, the volume a map would
 * put round it, and a player settled on the floor in front of it facing -Z.
 */
function setup(course: Course = {}) {
  const top = (course.units ?? 39) * UNIT;
  const depth = course.depth ?? 8;
  const root = new THREE.Group();
  root.add(collider([40, 1, 40], [0, -0.5, 0]), collider([40, top, depth], [0, top / 2, FACE - depth / 2]), ...(course.extra ?? []));
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const volume: ResolvedMantle = {
    id: 1,
    tags: [],
    position: { x: 0, y: top / 2, z: FACE - depth / 2 },
    yaw: 0,
    size: { x: 4, y: top, z: depth + 0.8 },
    kind: course.kind,
  };
  const rules = { mantles: new MantleVolumes(course.bare ? [] : [volume]), ladders: course.ladders ? new LadderVolumes(course.ladders) : NO_LADDERS };
  const env = movementEnv(collision, rules, PLAYER_MOVEMENT);
  const state = createMovement({ x: 0, y: 0, z: course.z ?? AGAINST }, 0, 0);
  const input = idleInput(0, 0);
  input.jump = state.jumpHeld = course.held ?? false;
  /** One step, asserting what every step of every mantle must hold: the capsule is in nothing. */
  const step = (): StanceKind | null => {
    const forced = stepMovement(state, input, DT, env, EMPTY_HANDS);
    if (state.move.kind === "mantle") {
      expect(collision.overlapsCapsule(state.feet, RADIUS, hullHeight(state, PLAYER_MOVEMENT)), `in the world at ${JSON.stringify(state.feet)}`).toBe(false);
    }
    return forced;
  };
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      step();
      each?.();
    }
  };
  run(0.5); // settle onto the floor
  /** Put jump down and step until the mantle that starts is over: how many steps it took, and what each held the stance to. */
  const mantle = () => {
    input.jump = true;
    const forced = [step()];
    expect(state.move.kind).toBe("mantle");
    const begun = structuredClone(climb(state));
    while (state.move.kind === "mantle") {
      forced.push(step());
    }
    expect(collision.overlapsCapsule(state.feet, RADIUS, hullHeight(state, PLAYER_MOVEMENT))).toBe(false);
    return { steps: forced.length, forced, begun };
  };
  return { state, input, step, run, mantle, collision, env, top };
}

/** The mantle `state` is in. Throws, so a test that is not mantling fails where it says so. */
function climb(state: MovementState): MantleMove {
  if (state.move.kind !== "mantle") {
    throw new Error(`not mantling: ${state.move.kind}`);
  }
  return state.move;
}

/** A thin wall with an opening over it: a sill 0.8 m up, and a lintel `opening` above that. */
function windowed(opening: number, kind?: "onto" | "over") {
  const sill = 0.8;
  return setup({ units: sill / UNIT, depth: 0.4, kind, extra: [collider([40, 1, 0.4], [0, sill + opening + 0.5, FACE - 0.2])] });
}

describe("starting a mantle", () => {
  it("climbs a ledge instead of jumping at it", () => {
    const { state, input, step } = setup();
    input.jump = true;
    step();
    expect(state.move.kind).toBe("mantle");
    expect(state.jumpFrom).toBeNull();
    expect(climb(state).ledge.y).toBeCloseTo(39 * UNIT, 3);
    expect(Math.cos(climb(state).yaw)).toBeCloseTo(1, 9);
  });

  it("jumps normally where there is no volume, however climbable the geometry", () => {
    const { state, input, step } = setup({ bare: true });
    input.jump = true;
    step();
    expect(state.move.kind).toBe("walk");
    expect(state.velocity.y).toBeGreaterThan(0);
  });

  it("starts on a later step of a held jump, when the player walks into range", () => {
    // Jump is down from before they landed, so nothing after is a press of it.
    const { state, input, step } = setup({ z: -0.6, held: true });
    expect(state.grounded).toBe(true);
    expect(state.jumpHeld).toBe(true);
    step();
    expect(state.move.kind).toBe("walk");
    input.forward = 1;
    let steps = 0;
    while (state.move.kind === "walk" && steps < 120) {
      expect(state.jumpFrom).toBeNull();
      step();
      steps++;
    }
    expect(state.move.kind).toBe("mantle");
    expect(steps).toBeGreaterThan(5);
    // Before they reached the face: the ledge was in reach of the probe's ball.
    expect(state.feet.z).toBeGreaterThan(AGAINST + 0.05);
  });

  it("starts nothing with the key let go", () => {
    const { state, input, run } = setup({ z: -0.6 });
    input.forward = 1;
    run(1.5);
    expect(state.move.kind).toBe("walk");
    expect(state.feet.z).toBeLessThan(AGAINST + 0.01);
  });

  it("starts none crouched, prone or on the way between stances", () => {
    for (const stance of ["crouch", "prone"] as const) {
      const { state, input, run, step } = setup();
      input[stance] = true;
      run(1);
      expect(state.stance.kind).toBe(stance);
      // Down as a key already held: a press would stand them up.
      input.jump = state.jumpHeld = true;
      run(0.5);
      expect(state.stance.kind).toBe(stance);
      expect(state.move.kind).toBe("walk");
      // Let go, they get up, and the key still down climbs once the eye has arrived.
      input[stance] = false;
      let steps = 0;
      while (state.move.kind === "walk" && steps < 120) {
        expect(state.stance.kind !== "stand" || state.eyeShift !== null || steps === 0, `${stance}, step ${steps}`).toBe(true);
        step();
        steps++;
      }
      expect(state.move.kind).toBe("mantle");
    }
  });

  it("jumps instead when the view is more than 60 degrees off the face", () => {
    const off = setup();
    off.input.yaw = 65 * DEGREE;
    off.run(DT);
    off.input.jump = true;
    off.step();
    expect(off.state.move.kind).toBe("walk");
    expect(off.state.velocity.y).toBeGreaterThan(0);

    const within = setup();
    within.input.yaw = 55 * DEGREE;
    within.run(DT);
    within.input.jump = true;
    within.step();
    // Straight in through the face, not along the view.
    expect(Math.cos(climb(within.state).yaw)).toBeCloseTo(1, 9);
  });

  it("starts from the air: a wall out of reach from the ground is climbed from the jump the press began", () => {
    const { state, input, step, top } = setup({ units: 80 });
    input.jump = true;
    step();
    expect(state.move.kind).toBe("walk");
    expect(state.jumpFrom).not.toBeNull();
    let steps = 0;
    while (state.move.kind === "walk" && steps < 60) {
      step();
      steps++;
    }
    // Once the feet were within 60 units of the top, and before the jump's own.
    expect(state.move.kind).toBe("mantle");
    expect(state.feet.y).toBeGreaterThan(20 * UNIT);
    expect(state.feet.y).toBeLessThan(JUMP_HEIGHT + 0.05);
    while (state.move.kind === "mantle") {
      step();
    }
    expect(state.feet.y).toBeCloseTo(top, 2);
    expect(state.grounded).toBe(true);
  });

  it("starts from a ladder, which is not grabbed again before the ground", () => {
    // A 2 m wall with a ladder up its face: jump held on the way up climbs the wall's top.
    const top = 2;
    const ladder: ResolvedLadder = { id: 2, tags: [], position: { x: 0, y: top / 2, z: FACE + 0.1 }, yaw: 0, size: { x: 0.8, y: top, z: 0.2 } };
    const { state, input, step } = setup({
      units: top / UNIT,
      ladders: [ladder],
      extra: [collider([0.8, top, 0.2], [0, top / 2, FACE + 0.1])],
      z: -1,
      held: true,
    });
    input.forward = 1;
    input.pitch = 0.6;
    let steps = 0;
    while (state.move.kind === "walk" && steps < 120) {
      step();
      steps++;
    }
    expect(state.move.kind).toBe("ladder");
    steps = 0;
    while (state.move.kind === "ladder" && steps < 240) {
      step();
      steps++;
    }
    expect(state.move.kind).toBe("mantle");
    expect(state.ladderLock).toBe(true);
    while (state.move.kind === "mantle") {
      step();
      expect(state.ladderLock).toBe(true);
    }
    expect(state.move.kind).toBe("walk");
    expect(state.feet.y).toBeCloseTo(top, 2);
    // Standing on the top: the next step is on the ground, and the lock is off.
    step();
    expect(state.ladderLock).toBe(false);
  });

  it("does not start a second while one is running", () => {
    const { state, input, step } = setup();
    input.jump = true;
    step();
    const first = { ...climb(state).ledge };
    step();
    step();
    expect(climb(state).ledge).toEqual(first);
  });

  it("starts none it cannot finish: a ledge with no room for even a crouch is jumped at", () => {
    const { state, input, step } = windowed(1);
    input.jump = true;
    step();
    expect(state.move.kind).toBe("walk");
    expect(state.velocity.y).toBeGreaterThan(0);
  });
});

describe("the mantle", () => {
  it("takes the row's own time onto a ledge, for every row", () => {
    for (const row of MANTLE_ROWS) {
      const { mantle, state } = setup({ units: row.height / UNIT });
      const { steps, begun } = mantle();
      expect(MANTLE_ROWS[begun.row], `${row.height / UNIT} units`).toBe(row);
      expect(steps, `${row.height / UNIT} units`).toBe(Math.round(row.up / DT));
      expect(state.feet.y).toBeCloseTo(row.height, 2);
    }
    expect(MANTLE_ROWS.map((row) => Math.round(row.up * 1000))).toEqual([833, 800, 600, 600, 500, 433, 333]);
  });

  it("takes the row's vault on top of that going over, for every row", () => {
    for (const row of MANTLE_ROWS) {
      const { mantle } = setup({ units: row.height / UNIT, depth: 0.2, kind: "over" });
      const { steps, begun } = mantle();
      expect(begun.over).toBe(true);
      expect(steps, `${row.height / UNIT} units`).toBe(Math.round((row.up + row.over.seconds) / DT));
    }
    expect(MANTLE_ROWS.map((row) => Math.round(row.over.seconds * 1000))).toEqual([233, 233, 400, 400, 400, 467, 467]);
    // Every one fits the field it is sent in.
    expect(MANTLE_TIME_MAX).toBeCloseTo(0.8333 + 0.2333, 3);
  });

  it("takes the nearest row for a ledge between two, up to 60 units", () => {
    expect(setup({ units: 20 }).mantle().begun.row).toBe(6);
    expect(setup({ units: 60 }).mantle().begun.row).toBe(0);
    const tall = setup({ units: 61 });
    tall.input.jump = true;
    tall.step();
    expect(tall.state.move.kind).toBe("walk");
    const low = setup({ units: 17 });
    low.input.jump = true;
    low.step();
    expect(low.state.move.kind).toBe("walk");
  });

  it("runs on rails: no gravity and no keys for its duration", () => {
    const { state, input, step } = setup({ units: 57 });
    input.jump = true;
    step();
    // Hold every key that would otherwise move them, and walk into the wall.
    input.forward = 1;
    input.right = 1;
    input.run = true;
    const path: MovementState[] = [];
    while (state.move.kind === "mantle") {
      path.push(structuredClone(state));
      step();
    }
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.feet.y).toBeGreaterThanOrEqual(path[i - 1]!.feet.y);
    }
    expect(path.at(-1)!.feet.x).toBeCloseTo(0, 6);
  });

  it("rises clear of the ledge before it moves over it", () => {
    const { state, input, step } = setup();
    const start = { ...state.feet };
    input.jump = true;
    step();
    const top = climb(state).ledge.y;
    while (state.move.kind === "mantle") {
      if (state.feet.y < top) {
        expect(state.feet.z).toBeCloseTo(start.z, 9);
      }
      step();
    }
    expect(state.feet.z).toBeLessThan(FACE);
  });

  it("moves slowly enough that no camera treats it as a teleport", () => {
    for (const course of [{ units: 57 }, { units: 57, depth: 0.2, kind: "over" as const }]) {
      const { state, input, step } = setup(course);
      input.jump = true;
      let last = { ...state.feet };
      do {
        step();
        expect(Math.hypot(state.feet.x - last.x, state.feet.y - last.y, state.feet.z - last.z)).toBeLessThan(0.1);
        last = { ...state.feet };
      } while (state.move.kind === "mantle");
    }
  });

  it("ends on the ledge, on the ground, with the row's speed along the mantle", () => {
    for (const [units, speed] of [
      [57, 19.6],
      [39, 34.1],
      [21, 44.2],
    ] as const) {
      const { state, mantle } = setup({ units });
      const { begun } = mantle();
      expect(state.feet).toEqual(begun.ledge);
      expect(state.grounded).toBe(true);
      expect(state.velocity.z).toBeCloseTo(-speed * UNIT, 6);
      expect(state.velocity.y).toBe(0);
      expect(state.velocity.x).toBeCloseTo(0, 9);
    }
  });

  it("ends a vault in the air past the ledge, with the vault's speed forward and down", () => {
    for (const [units, forward, down] of [
      [57, 138, 131],
      [39, 78, 79],
      [21, 67, 80],
    ] as const) {
      const { state, mantle, run } = setup({ units, depth: 0.2, kind: "over" });
      const { begun } = mantle();
      expect(state.feet.z).toBeCloseTo(begun.ledge.z - 31 * UNIT, 6);
      expect(state.feet.y).toBeCloseTo(begun.ledge.y - 18 * UNIT, 6);
      expect(state.grounded).toBe(false);
      expect(state.velocity.z).toBeCloseTo(-forward * UNIT, 6);
      expect(state.velocity.y).toBeCloseTo(-down * UNIT, 6);
      // And down the far side from there.
      run(1);
      expect(state.grounded).toBe(true);
      expect(state.feet.y).toBeCloseTo(0, 2);
      expect(state.feet.z).toBeLessThan(FACE - 0.2 - RADIUS);
    }
  });

  it("goes onto a ledge a vault was asked of, with a floor behind it", () => {
    const { state, mantle } = setup({ kind: "over" });
    const { begun } = mantle();
    expect(begun.over).toBe(false);
    expect(state.grounded).toBe(true);
  });

  it("does not jump at the top on a jump still held, nor after", () => {
    const { state, input, step, mantle } = setup();
    mantle();
    expect(input.jump).toBe(true);
    for (let i = 0; i < 30; i++) {
      step();
      expect(state.jumpFrom).toBeNull();
      expect(state.velocity.y).toBeLessThanOrEqual(0);
      expect(state.move.kind).toBe("walk");
    }
  });

  it("holds the view's yaw within 60 degrees of the way it goes", () => {
    const { state, input, step, env } = setup({ units: 57 });
    input.jump = true;
    step();
    const along = climb(state).yaw;
    for (const [asked, held] of [
      [40, 40],
      [100, 60],
      [-170, -60],
      [-20, -20],
    ] as const) {
      input.yaw = along + asked * DEGREE;
      // What the camera is told of mouse movement no step has spent is the same answer.
      expect(capYaw(state, input.yaw, env)).toBeCloseTo(along + held * DEGREE, 9);
      step();
      expect(state.yaw).toBeCloseTo(along + held * DEGREE, 9);
    }
    // The pitch is free.
    input.pitch = 1.2;
    step();
    expect(state.pitch).toBeCloseTo(1.2, 9);
    while (state.move.kind === "mantle") {
      step();
    }
    input.yaw = along + 100 * DEGREE;
    step();
    expect(state.yaw).toBeCloseTo(along + 100 * DEGREE, 9);
  });

  it("reaches the same place stepped at 60 Hz and at 144 Hz", () => {
    // A server replays a client's own steps, so the way must be a function of
    // the feet and the move and not of how it was sliced up.
    const at = (dt: number, course: Course) => {
      const { state, input, env } = setup(course);
      input.jump = true;
      let steps = 0;
      do {
        stepMovement(state, input, dt, env, EMPTY_HANDS);
        steps++;
      } while (state.move.kind === "mantle");
      return { feet: state.feet, seconds: steps * dt };
    };
    for (const course of [{ units: 45 }, { units: 45, depth: 0.2, kind: "over" as const }]) {
      const slow = at(1 / 60, course);
      const fast = at(1 / 144, course);
      expect(fast.feet).toEqual(slow.feet);
      expect(Math.abs(fast.seconds - slow.seconds)).toBeLessThan(1 / 60);
    }
  });
});

describe("a mantle and the stance", () => {
  it("is made crouched onto a ledge with only a crouch's room, and stays crouched there", () => {
    const { state, step, mantle } = windowed(1.3);
    const { forced } = mantle();
    // Held to a crouch on every step of it, the last included: there is no standing here.
    expect(new Set(forced)).toEqual(new Set(["crouch"]));
    expect(state.stance.kind).toBe("crouch");
    expect(step()).toBe("crouch");
    expect(state.stance.kind).toBe("crouch");
  });

  it("is made crouched through an opening and stood up past it", () => {
    const { state, run, mantle } = windowed(1.3, "over");
    const { forced, begun } = mantle();
    expect(begun.over).toBe(true);
    expect(forced.slice(0, -1).every((kind) => kind === "crouch")).toBe(true);
    // Where it ends there is the room: the last step asks for standing, and the keys' own stance follows.
    expect(forced.at(-1)).toBe("stand");
    run(0.5);
    expect(state.stance.kind).toBe("stand");
    expect(state.eyeShift).toBeNull();
  });

  it("holds no stance of a mantle made standing", () => {
    const { mantle, state } = setup();
    expect(new Set(mantle().forced)).toEqual(new Set([null]));
    expect(state.stance.kind).toBe("stand");
  });
});

describe("a mantle on the wire", () => {
  it("survives a JSON round-trip in lockstep, so a peer's mantle is not a teleport", () => {
    const { state, input, env } = windowed(1.3, "over");
    input.jump = true;
    let copy: MovementState = JSON.parse(JSON.stringify(state));
    let mantled = false;
    for (let i = 0; i < 90; i++) {
      stepMovement(state, input, DT, env, EMPTY_HANDS);
      stepMovement(copy, input, DT, env, EMPTY_HANDS);
      copy = JSON.parse(JSON.stringify(copy));
      // Both through JSON: the walk it ends in leaves a negative zero in a velocity, which no copy keeps.
      expect(copy).toEqual(JSON.parse(JSON.stringify(state)));
      mantled ||= state.move.kind === "mantle";
    }
    expect(mantled).toBe(true);
    expect(state.move.kind).toBe("walk");
  });

  it("round-trips through the wire codec", () => {
    const { state, input, step } = setup({ units: 57, depth: 0.2, kind: "over" });
    input.jump = true;
    step();
    step();
    const writer = new BitWriter();
    movementSchema.write(writer, state);
    const decoded = movementSchema.read(new BitReader(writer.finish()));
    const sent = climb(state);
    const got = climb(decoded);
    expect(got.row).toBe(sent.row);
    expect(got.over).toBe(true);
    expect(got.left).toBeCloseTo(sent.left, 2);
    expect(got.yaw).toBeCloseTo(sent.yaw, 3);
    expect(got.ledge.x).toBeCloseTo(sent.ledge.x, 5);
    expect(got.ledge.y).toBeCloseTo(sent.ledge.y, 5);
    expect(got.ledge.z).toBeCloseTo(sent.ledge.z, 5);
  });

  it("carries the longest mantle's clock whole", () => {
    const { state } = setup();
    state.move = { kind: "mantle", ledge: { x: 1, y: 2, z: 3 }, yaw: 0.5, row: 0, over: true, left: MANTLE_TIME_MAX };
    const writer = new BitWriter();
    movementSchema.write(writer, state);
    expect(climb(movementSchema.read(new BitReader(writer.finish()))).left).toBeCloseTo(MANTLE_TIME_MAX, 6);
  });

  it("costs its fields only while somebody mantles", () => {
    const { state } = setup();
    const bits = (s: MovementState) => {
      const writer = new BitWriter();
      movementSchema.write(writer, s);
      return writer.finish().byteLength * 8;
    };
    const idle = bits(state);
    state.move = { kind: "mantle", ledge: { x: 1, y: 2, z: 3 }, yaw: 0.5, row: 3, over: false, left: 0.5 };
    // A ledge, a yaw, a row, a bit and a clock: 125 bits, to the byte.
    expect(bits(state) - idle).toBeGreaterThanOrEqual(120);
    expect(bits(state) - idle).toBeLessThanOrEqual(128);
  });
});
