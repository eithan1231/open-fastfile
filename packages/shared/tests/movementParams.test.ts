// `stepMovement`'s body and speeds as parameters (`MovementParams`).
//
// The default has to be the player exactly — a client predicting and a server
// replaying step through it, so a default that differed in the last bit would be
// a desync nothing reported. The golden digest below was taken from the step
// before its capsule and speeds became parameters, over a course that walks,
// runs, jumps, steps up, steps down, slides along a wall and mantles.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { idleInput } from "../src/sim/input.js";
import {
  createMovement,
  EMPTY_HANDS,
  horizontalSpeed,
  movementEnv,
  NO_CLIMBS,
  PLAYER_MOVEMENT,
  stepMovement,
  type MovementParams,
  type MovementState,
} from "../src/sim/movement.js";
import { NO_LADDERS } from "../src/sim/moves/ladder.js";
import { MantleVolumes } from "../src/sim/moves/mantle.js";
import { hashString, seeded } from "../src/game/random.js";

const DT = 1 / 60;

function collider(size: [number, number, number], at: [number, number, number], rotateX = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.rotation.x = rotateX;
  mesh.userData.collide = true;
  return mesh;
}

/** A floor, a kerb, a wall, a slope and a ledge with a mantle volume on it. */
function course(): { world: CollisionWorld; mantles: MantleVolumes } {
  const root = new THREE.Group();
  root.add(
    collider([60, 1, 60], [0, -0.5, 0]),
    collider([4, 0.4, 2], [0, 0.2, -2]),
    collider([0.3, 3, 20], [1.2, 1.5, 0]),
    collider([3, 0.5, 10], [-2.5, 0.6, 2], 0.25),
    collider([8, 1, 4], [0, 0.5, 5]),
  );
  const world = new CollisionWorld();
  world.rebuild(root);
  const mantles = new MantleVolumes([{ id: 1, tags: [], position: { x: 0, y: 0.5, z: 3 }, yaw: Math.PI, size: { x: 8, y: 1, z: 0.5 } }]);
  return { world, mantles };
}

/** 900 steps of seeded, held-for-a-while input over the course; every state folded into one hash. */
function drive(params: MovementParams): { digest: number; state: MovementState } {
  const { world, mantles } = course();
  const env = movementEnv(world, { mantles, ladders: NO_LADDERS }, params);
  const state = createMovement({ x: 0, y: 0.2, z: 0 }, 0, 0);
  const input = idleInput(0, 0);
  const rng = seeded(12345);
  let digest = 0;
  for (let i = 0; i < 900; i++) {
    if (i % 20 === 0) {
      input.forward = rng() < 0.75 ? 1 : rng() < 0.5 ? -1 : 0;
      input.right = rng() < 0.3 ? (rng() < 0.5 ? 1 : -1) : 0;
      input.run = rng() < 0.5;
      input.yaw = (rng() - 0.5) * Math.PI * 4;
      input.pitch = (rng() - 0.5) * 0.4;
    }
    input.jump = i % 97 < 3;
    stepMovement(state, input, DT, env, EMPTY_HANDS);
    digest = hashString(`${digest}:${JSON.stringify(state)}`);
  }
  return { digest, state };
}

describe("MovementParams", () => {
  it("steps the player's body the same way, bit for bit", () => {
    const { digest, state } = drive(PLAYER_MOVEMENT);
    expect([state.feet.x, state.feet.y, state.feet.z]).toEqual(GOLDEN_FEET);
    expect(digest).toBe(GOLDEN_DIGEST);
  });

  it("is the same step for an equal body that is not the player's own object", () => {
    expect(drive({ ...PLAYER_MOVEMENT }).digest).toBe(GOLDEN_DIGEST);
  });

  // Theater's foyer threshold, as a box. A step is kept for any gain along the
  // move, so a body whose walk moves a centimetre a tick climbs it as a fast one does.
  it("walks a body over a thin threshold at any speed", () => {
    const { world } = open([collider([4, 0.25, 0.04], [0, 0.125, -2])]);
    const past = (speed: number) => {
      const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
      const input = { ...idleInput(0, 0), forward: 1 };
      const env = movementEnv(world, NO_CLIMBS, { ...PLAYER_MOVEMENT, walkSpeed: speed, runSpeed: speed });
      for (let i = 0; i < 600; i++) {
        stepMovement(state, input, DT, env, EMPTY_HANDS);
      }
      return state.feet.z < -3;
    };
    for (const speed of [0.6, 1.2, PLAYER_MOVEMENT.walkSpeed]) {
      expect(past(speed), `${speed} m/s`).toBe(true);
    }
  });

  it("walks and runs at the speeds it is given", () => {
    const slow: MovementParams = { ...PLAYER_MOVEMENT, walkSpeed: 1.5, runSpeed: 2.5 };
    const fast: MovementParams = { ...PLAYER_MOVEMENT, walkSpeed: 4, runSpeed: 8 };
    const speed = (body: MovementParams, run: boolean) => {
      const { world } = open([]);
      const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
      const input = { ...idleInput(0, 0), run };
      const env = movementEnv(world, NO_CLIMBS, body);
      for (let i = 0; i < 30; i++) {
        stepMovement(state, input, DT, env, EMPTY_HANDS);
      }
      input.forward = 1;
      for (let i = 0; i < 90; i++) {
        stepMovement(state, input, DT, env, EMPTY_HANDS);
      }
      return horizontalSpeed(state);
    };
    expect(speed(slow, false)).toBeCloseTo(1.5, 3);
    expect(speed(slow, true)).toBeCloseTo(2.5, 3);
    expect(speed(fast, false)).toBeCloseTo(4, 3);
    expect(speed(fast, true)).toBeCloseTo(8, 3);
  });

  it("stops against a wall at its own radius, and passes under a beam at its own height", () => {
    const walk = (body: MovementParams, obstacles: THREE.Mesh[]) => {
      const { world } = open(obstacles);
      const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
      const input = idleInput(0, 0);
      const env = movementEnv(world, NO_CLIMBS, body);
      for (let i = 0; i < 30; i++) {
        stepMovement(state, input, DT, env, EMPTY_HANDS);
      }
      input.forward = 1;
      for (let i = 0; i < 180; i++) {
        stepMovement(state, input, DT, env, EMPTY_HANDS);
      }
      return state.feet.z;
    };
    // A wall whose face is at z = -1.75, and a beam whose underside is 1.2 m up.
    const wall = [collider([4, 3, 0.5], [0, 1.5, -2])];
    const beam = [collider([4, 0.3, 0.5], [0, 1.35, -2])];
    const small: MovementParams = { ...PLAYER_MOVEMENT, radius: 0.2, height: 1.1 };
    const large: MovementParams = { ...PLAYER_MOVEMENT, radius: 0.5, height: 2.2 };

    expect(walk(small, wall)).toBeCloseTo(-1.55, 2);
    expect(walk(PLAYER_MOVEMENT, wall)).toBeCloseTo(-1.75 + PLAYER_MOVEMENT.radius, 2);
    expect(walk(large, wall)).toBeCloseTo(-1.25, 2);
    expect(walk(small, beam)).toBeLessThan(-3);
    expect(walk(PLAYER_MOVEMENT, beam)).toBeGreaterThan(-2);
  });
});

/** A floor and whatever else, and nothing to mantle. */
function open(extra: THREE.Mesh[]): { world: CollisionWorld } {
  const root = new THREE.Group();
  root.add(collider([60, 1, 60], [0, -0.5, 0]), ...extra);
  const world = new CollisionWorld();
  world.rebuild(root);
  return { world };
}

// The player's own step, recorded. Change these only for a change to movement
// itself, never for a change to how it is parameterised.
const GOLDEN_DIGEST = 101378431;
const GOLDEN_FEET = [-6.908113784947503, 0.1977723213313607, 8.301383073673922];
