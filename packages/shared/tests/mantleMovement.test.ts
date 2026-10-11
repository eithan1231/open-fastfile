// Mantling as a movement step: a jump into a ledge climbs it, the climb runs on
// rails along a path checked clear of the geometry, and the same inputs from the
// same state land in the same place on both ends.
//
// The two that would be silent if they broke: the capsule must never sink into
// anything on the way (a straight line from the foot of a ledge to its top cuts
// through its corner), and the whole of it must survive a JSON round-trip, or a
// peer's climb would arrive as a teleport.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { idleInput, type PlayerInput } from "../src/sim/input.js";
import {
  createMovement,
  EMPTY_HANDS,
  HEIGHT,
  movementEnv,
  PLAYER_MOVEMENT,
  RADIUS,
  stepMovement,
  type MantleMove,
  type MovementState,
} from "../src/sim/movement.js";
import { NO_LADDERS } from "../src/sim/moves/ladder.js";
import { mantleDuration, MantleVolumes, MAX_CLIMB, MIN_CLIMB } from "../src/sim/moves/mantle.js";
import { movementSchema } from "../src/net/messages/player.js";
import { BitReader, BitWriter } from "../src/net/codec/bits.js";
import type { ResolvedMantle } from "../src/dsl/resolved.js";

const DT = 1 / 60;
/** The ledge every test climbs: a 1 m step at z = -2, facing the player. */
const LEDGE_TOP = 1;

function collider(size: [number, number, number], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  return mesh;
}

/** One volume over the edge of the block, its top flush with the surface. Only its near face matters here. */
function ledgeVolume(): ResolvedMantle {
  return {
    id: 1,
    tags: [],
    position: { x: 0, y: LEDGE_TOP / 2, z: -2 },
    yaw: 0,
    size: { x: 4, y: LEDGE_TOP, z: 0.5 },
  };
}

/**
 * A player on a floor at y = 0 facing -Z, with a 1 m block from z = -2 back and
 * a mantle volume on its near edge — the shape the imported maps are full of.
 */
function setup(volumes: ResolvedMantle[] = [ledgeVolume()], extra: THREE.Mesh[] = [], block = true) {
  const root = new THREE.Group();
  root.add(collider([40, 1, 40], [0, -0.5, 0]), ...extra);
  if (block) {
    root.add(collider([40, LEDGE_TOP, 8], [0, LEDGE_TOP / 2, -6]));
  }
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const mantles = new MantleVolumes(volumes);
  const state = createMovement({ x: 0, y: 0, z: -1.8 }, 0, 0);
  const input = idleInput(0, 0);
  const env = movementEnv(collision, { mantles, ladders: NO_LADDERS }, PLAYER_MOVEMENT);
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      stepMovement(state, input, DT, env, EMPTY_HANDS);
      each?.();
    }
  };
  run(0.5); // settle onto the floor
  return { state, input, run, collision, env };
}

/** The climb `state` is in. Throws, so a test that is not climbing fails where it says so. */
function climb(state: MovementState): MantleMove {
  if (state.move.kind !== "mantle") {
    throw new Error(`not climbing: ${state.move.kind}`);
  }
  return state.move;
}

/** Press and release jump within one step. */
function press(input: PlayerInput, run: (s: number) => void) {
  input.jump = true;
  run(DT);
  input.jump = false;
}

describe("mantling", () => {
  it("climbs a ledge instead of jumping at it", () => {
    const { state, input, run } = setup();
    press(input, run);
    expect(state.move.kind).toBe("mantle");
    // A jump would have put velocity on the clock; a mantle takes it away.
    expect(state.velocity.y).toBe(0);
    expect(climb(state).rise).toBeCloseTo(LEDGE_TOP, 6);
  });

  it("jumps normally where there is no volume, however climbable the geometry", () => {
    const { state, input, run } = setup([]);
    press(input, run);
    expect(state.move.kind).toBe("walk");
    expect(state.velocity.y).toBeGreaterThan(0);
  });

  it("ends standing on the surface, at the height the volume's top named", () => {
    const { state, input, run } = setup();
    press(input, run);
    const target = { ...climb(state).target };
    run(mantleDuration(LEDGE_TOP) + 4 * DT);
    expect(state.move.kind).toBe("walk");
    expect(state.feet.y).toBeCloseTo(target.y, 2);
    expect(state.feet.z).toBeLessThan(-2); // over the edge, onto the block
    expect(state.grounded).toBe(true);
  });

  it("takes the time the animation set says, not a fixed one", () => {
    // 0.33 s at the lowest climb, 0.83 s at the highest: the games' own clips.
    expect(mantleDuration(MIN_CLIMB)).toBeCloseTo(0.33, 6);
    expect(mantleDuration(MAX_CLIMB)).toBeCloseTo(0.83, 6);
    expect(mantleDuration(MIN_CLIMB - 1)).toBeCloseTo(0.33, 6);
    expect(mantleDuration(MAX_CLIMB + 1)).toBeCloseTo(0.83, 6);
    // Every value one can take must fit `shortTimer`, which tops out at 1 s.
    expect(mantleDuration(MAX_CLIMB)).toBeLessThan(1);
  });

  it("runs on rails: no gravity, no keys and no collision for its duration", () => {
    const { state, input, run } = setup();
    press(input, run);
    // Hold every key that would otherwise move them, and walk into the wall.
    input.forward = 1;
    input.right = 1;
    input.run = true;
    const path: MovementState[] = [];
    run(mantleDuration(LEDGE_TOP) - 2 * DT, () => path.push(structuredClone(state)));
    // Never falling: gravity never gets a turn.
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.feet.y).toBeGreaterThanOrEqual(path[i - 1]!.feet.y);
    }
    expect(path.at(-1)!.feet.y).toBeGreaterThan(path[0]!.feet.y);
    // And the keys bought no sideways motion at all.
    expect(path.at(-1)!.feet.x).toBeCloseTo(0, 6);
  });

  it("never sinks into anything on the way up", () => {
    // Collision is not resolved mid-climb, so this is the whole guarantee: the
    // path was checked before it began, and the capsule stays on it.
    const { state, input, run, collision } = setup();
    press(input, run);
    let steps = 0;
    run(mantleDuration(LEDGE_TOP) + 2 * DT, () => {
      steps++;
      expect(collision.overlapsCapsule(state.feet, RADIUS, HEIGHT)).toBe(false);
    });
    expect(steps).toBeGreaterThan(10);
  });

  it("rises clear of the ledge before it moves over it", () => {
    // Up, then across: until the feet reach the top, the capsule stays where
    // it started, in front of the ledge's face.
    const { state, input, run } = setup();
    press(input, run);
    const start = { ...state.feet };
    const top = climb(state).target.y;
    run(mantleDuration(LEDGE_TOP), () => {
      if (state.move.kind === "mantle" && state.feet.y < top) {
        expect(state.feet.z).toBeCloseTo(start.z, 9);
      }
    });
    expect(state.feet.z).toBeLessThan(-2);
  });

  it("jumps instead when there is no room to make the climb", () => {
    // A slab 2 m over the ledge: the player fits under it on the floor, not on the block.
    const { state, input, run } = setup([ledgeVolume()], [collider([40, 0.2, 2], [0, 2.1, -2.5])]);
    press(input, run);
    expect(state.move.kind).toBe("walk");
    expect(state.velocity.y).toBeGreaterThan(0);
  });

  it("does not start a second climb while one is running", () => {
    const { state, input, run } = setup();
    press(input, run);
    const first = climb(state).target;
    input.jump = true;
    run(2 * DT);
    expect(climb(state).target).toEqual(first);
  });

  it("lets the player look around mid-climb", () => {
    // The view is absolute in the input, so refusing it would only make the
    // client's camera fight the mouse for the length of the climb.
    const { state, input, run } = setup();
    press(input, run);
    input.yaw = 1.2;
    run(DT);
    expect(state.yaw).toBeCloseTo(1.2, 6);
  });

  it("reaches the same place stepped at 60 Hz and at 144 Hz", () => {
    // A server replays a client's own steps, so the trajectory must be a
    // function of (feet, target, left) and not of how it was sliced up.
    const at = (dt: number) => {
      const { state, input, run, env } = setup();
      press(input, run);
      const total = mantleDuration(LEDGE_TOP) + 0.05;
      for (let t = 0; t < total; t += dt) {
        stepMovement(state, input, dt, env, EMPTY_HANDS);
      }
      return state.feet;
    };
    const slow = at(1 / 60);
    const fast = at(1 / 144);
    expect(fast.x).toBeCloseTo(slow.x, 6);
    expect(fast.y).toBeCloseTo(slow.y, 6);
    expect(fast.z).toBeCloseTo(slow.z, 6);
  });

  it("moves at a steady speed, slowly enough that no camera treats it as a teleport", () => {
    // Covering dt/left of what is left, with left falling by dt, is exactly
    // constant speed — which is why the climb needs no easing to look smooth and
    // why `FirstPersonControls` interpolates it like any walk. Its
    // TELEPORT_DISTANCE is 1 m per tick and a sprint is ~0.1 m; a climb is less.
    const { state, input, run } = setup();
    press(input, run);
    const steps: number[] = [];
    let last = { ...state.feet };
    run(mantleDuration(LEDGE_TOP) - 2 * DT, () => {
      // Along the path, which turns a corner: up, plus across.
      steps.push(Math.abs(state.feet.y - last.y) + Math.hypot(state.feet.x - last.x, state.feet.z - last.z));
      last = { ...state.feet };
    });
    expect(Math.max(...steps)).toBeLessThan(0.1);
    // Steady: every step the same length as the first, bar the settling one.
    for (const step of steps.slice(1)) {
      expect(step).toBeCloseTo(steps[1]!, 6);
    }
  });

  it("survives a JSON round-trip in lockstep, so a peer's climb is not a teleport", () => {
    const { state, input, run, env } = setup();
    press(input, run);
    let copy: MovementState = JSON.parse(JSON.stringify(state));
    for (let i = 0; i < 40; i++) {
      stepMovement(state, input, DT, env, EMPTY_HANDS);
      stepMovement(copy, input, DT, env, EMPTY_HANDS);
      copy = JSON.parse(JSON.stringify(copy));
      expect(copy).toEqual(state);
    }
  });

  it("round-trips through the wire codec", () => {
    const { state, input, run } = setup();
    press(input, run);
    const writer = new BitWriter();
    movementSchema.write(writer, state);
    const decoded = movementSchema.read(new BitReader(writer.finish()));
    expect(decoded.move.kind).toBe("mantle");
    expect(climb(decoded).rise).toBeCloseTo(climb(state).rise, 2);
    expect(climb(decoded).left).toBeCloseTo(climb(state).left, 2);
    expect(climb(decoded).target.y).toBeCloseTo(climb(state).target.y, 5);
    expect(climb(decoded).over).toBe(climb(state).over);
  });

  it("carries whether the climb is a vault, rather than leaving a peer to guess", () => {
    // The two kinds' heights overlap, so `rise` cannot stand in for `over`.
    const over = { ...ledgeVolume(), kind: "over" as const };
    const rail = collider([40, LEDGE_TOP, 0.3], [0, LEDGE_TOP / 2, -2.15]);
    const vault = setup([over], [rail], false);
    press(vault.input, vault.run);
    expect(climb(vault.state).over).toBe(true);
    // Down the far side once it is over.
    vault.run(mantleDuration(LEDGE_TOP) + 1);
    expect(vault.state.feet.z).toBeLessThan(-2.3);
    expect(vault.state.feet.y).toBeCloseTo(0, 2);

    // Asked for, but the block goes on for metres: nowhere to vault to.
    const deep = setup([over]);
    press(deep.input, deep.run);
    expect(climb(deep.state).over).toBe(false);

    const plain = setup([ledgeVolume()], [rail], false);
    press(plain.input, plain.run);
    expect(climb(plain.state).over).toBe(false);
  });

  it("costs one bit when nobody is climbing", () => {
    const { state } = setup();
    const size = (s: MovementState) => {
      const writer = new BitWriter();
      movementSchema.write(writer, s);
      return writer.finish().byteLength;
    };
    const idle = size(state);
    state.move = { kind: "mantle", target: { x: 1, y: 2, z: 3 }, left: 0.5, rise: 1, over: false };
    expect(size(state)).toBeGreaterThan(idle);
  });
});
