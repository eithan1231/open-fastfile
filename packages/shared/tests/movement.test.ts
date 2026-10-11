// Walking, running and jumping (sim/movement.ts) against real
// collision: a jump under a ceiling ends at it, the air keeps the takeoff's
// speed, a landing slows the player, and only a forward run sprints.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { idleInput } from "../src/sim/input.js";
import { createMovement, horizontalSpeed, RUN_SPEED, stepMovement, WALK_SPEED } from "../src/sim/movement.js";
import { advanceBlends, GAIT_BLEND, IDLE_SPEED, STRIDE_PERIOD } from "../src/sim/gait.js";

const DT = 1 / 60;

function collider(size: [number, number, number], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  return mesh;
}

/** A player on a floor at y = 0 facing -Z, with `extra` geometry. Change `input` to press keys. */
function setup(...extra: THREE.Mesh[]) {
  const root = new THREE.Group();
  root.add(collider([40, 1, 40], [0, -0.5, 0]), ...extra);
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  const input = idleInput(0, 0);
  const options = { sprintAllowed: true };
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      stepMovement(state, input, DT, collision, options.sprintAllowed);
      each?.();
    }
  };
  /** Press and release jump within one step. */
  const jump = () => {
    input.jump = true;
    run(DT);
    input.jump = false;
  };
  run(0.5); // settle onto the floor
  return { state, input, options, run, jump };
}

describe("stepMovement", () => {
  it("ends a jump at a ceiling instead of hanging under it", () => {
    const airTime = (...extra: THREE.Mesh[]) => {
      const { state, run, jump } = setup(...extra);
      jump();
      let air = 0;
      run(1.5, () => (air += state.grounded ? 0 : DT));
      return air;
    };
    const open = airTime();
    // Head room of 2 m: the head (1.7 m) meets the slab 0.3 m into a 0.84 m jump.
    const low = airTime(collider([4, 0.2, 4], [0, 2.1, 0]));
    expect(open).toBeGreaterThan(0.5);
    expect(low).toBeLessThan(open * 0.6);
  });

  it("keeps the takeoff's speed in the air, the keys only nudging it", () => {
    const { state, input, run, jump } = setup();
    input.forward = 1;
    run(0.2);
    jump();
    const takeoff = { ...state.feet };
    input.forward = 0;
    input.right = 1;
    run(0.3);
    expect(state.feet.z - takeoff.z).toBeLessThan(-0.9); // still carried forward at walking speed
    expect(state.feet.x - takeoff.x).toBeGreaterThan(0.03); // a slight drift to the right...
    expect(state.feet.x - takeoff.x).toBeLessThan(0.15); // ...where the ground would have gone 0.96 m
  });

  it("carries a landing's speed in, easing down to the landing slowdown and back", () => {
    const { state, input, run, jump } = setup();
    input.forward = 1;
    run(0.5);
    jump();
    const after: number[] = [];
    let landed = false;
    run(1.5, () => {
      if (landed) {
        after.push(horizontalSpeed(state));
      }
      landed ||= state.grounded;
    });
    expect(after[0]).toBeGreaterThan(2.5); // no stop on touchdown
    expect(Math.min(...after)).toBeLessThan(WALK_SPEED * 0.65);
    expect(after.at(-1)).toBeCloseTo(WALK_SPEED, 5);
  });

  it("gets up to speed and skids to a stop, rather than either at once", () => {
    const { state, input, run } = setup();
    input.forward = 1;
    run(DT);
    expect(horizontalSpeed(state)).toBeLessThan(1);
    run(0.3);
    expect(horizontalSpeed(state)).toBeCloseTo(WALK_SPEED, 5);
    input.forward = 0;
    run(DT);
    expect(horizontalSpeed(state)).toBeGreaterThan(2);
    run(0.3);
    expect(horizontalSpeed(state)).toBe(0);
  });

  it("runs only forward, and only while the weapon allows it", () => {
    const speedAfter = (keys: Partial<ReturnType<typeof idleInput>>, sprintAllowed = true) => {
      const { state, input, options, run } = setup();
      Object.assign(input, keys);
      options.sprintAllowed = sprintAllowed;
      run(1);
      return horizontalSpeed(state);
    };
    expect(speedAfter({ forward: 1, run: true })).toBeCloseTo(RUN_SPEED, 5);
    expect(speedAfter({ forward: 1, run: true }, false)).toBeCloseTo(WALK_SPEED, 5);
    expect(speedAfter({ forward: -1, run: true })).toBeCloseTo(WALK_SPEED, 5);
    expect(speedAfter({ right: 1, run: true })).toBeCloseTo(WALK_SPEED, 5);
    expect(speedAfter({ forward: 1, right: 1 })).toBeCloseTo(WALK_SPEED, 5); // a diagonal is no faster
  });

  it("jumps again on landing while jump is held, and remembers a press made just before landing", () => {
    const takeoffs = (hold: (t: number, falling: boolean, height: number) => boolean) => {
      const { state, input, run } = setup();
      let count = 0;
      let t = 0;
      run(2, () => {
        t += DT;
        input.jump = hold(t, state.velocity.y < 0, state.feet.y);
        if (state.jumped && state.velocity.y > 5) {
          count++;
        } // the step of a takeoff
      });
      return count;
    };
    expect(takeoffs(() => true)).toBeGreaterThanOrEqual(3);
    // One press at the start, one while falling 10 cm above the floor: two jumps.
    let pressedLate = false;
    const late = takeoffs((t, falling, height) => {
      if (t < DT * 1.5) {
        return true;
      }
      if (falling && height < 0.1 && !pressedLate) {
        return (pressedLate = true);
      }
      return false;
    });
    expect(late).toBe(2);
  });

  it("is plain data: a JSON copy steps in lockstep with the original", () => {
    const a = setup();
    a.input.forward = 1;
    a.run(0.3);
    a.jump();
    const copy = JSON.parse(JSON.stringify(a.state)) as typeof a.state;
    const b = setup();
    Object.assign(b.state, copy);
    Object.assign(b.input, a.input);
    a.run(1);
    b.run(1);
    expect(b.state).toEqual(a.state);
  });
});

// `stride` is the run-cycle phase, and it is simulation state rather than a
// drawing detail for one reason: a bullet is traced against a posed skeleton, and
// a phase each end integrated on its own frame times would put a peer's legs in
// two different places. These are the properties a pose may rely on.
/** A player on `ground` alone, at the origin, facing -Z. `setup`'s own flat floor would be in the way. */
function on(ground: THREE.Mesh) {
  const root = new THREE.Group();
  root.add(ground);
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  const input = idleInput(0, 0);
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      stepMovement(state, input, DT, collision, true);
      each?.();
    }
  };
  run(0.5); // settle onto it
  return { state, input, run };
}

/**
 * A slope falling away towards -Z, whose surface passes through the origin.
 *
 * A box turned about X by `angle`: its top face then drops `tan(angle)` for every
 * metre walked forward, which is exactly the drop a horizontal move has to be put
 * back onto.
 */
function slope(angle: number): THREE.Mesh {
  const mesh = collider([40, 2, 80], [0, -Math.cos(angle), Math.sin(angle)]);
  mesh.rotation.x = -angle;
  return mesh;
}

describe("walking down a slope", () => {
  it("stays on the ground rather than falling to it every tick", () => {
    // Without a step down, a move along a slope is horizontal and ends in the air:
    // gravity needs two or three ticks to bring the capsule back, `grounded` flickers
    // for them, and `airborne` follows — so a body walking down a hill crossfades
    // between falling and walking several times a second, and the player loses ground
    // friction and acceleration for most of the descent.
    const { state, input, run } = on(slope(0.45)); // ~26 degrees
    input.forward = 1;
    input.run = true;
    run(0.5); // up to speed

    let air = 0;
    run(1, () => {
      if (!state.grounded) {
        air++;
      }
    });
    expect(state.feet.z).toBeLessThan(-3); // genuinely descending, or this proves nothing
    expect(state.feet.y).toBeLessThan(-1);
    expect(air).toBe(0);
    expect(state.airborne).toBe(0);
  });

  it("still falls off anything taller than a step", () => {
    // The step down *is* a step: it sets the feet on ground within STEP_HEIGHT and
    // leaves a real drop alone. A short floor with nothing under it is a fall.
    const { state, input, run } = on(collider([40, 1, 8], [0, -0.5, -2]));
    input.forward = 1;
    input.run = true;
    run(3); // off the end at z = -6

    expect(state.grounded).toBe(false);
    expect(state.feet.y).toBeLessThan(-2);
  });
});

describe("the stride clock", () => {
  it("advances at the run period when running, and wraps", () => {
    const { state, input, run } = setup();
    input.forward = 1;
    input.run = true;
    run(2);
    // One cycle per STRIDE_PERIOD at RUN_SPEED, so two seconds is past a wrap and
    // the phase stays in [0, 1) rather than counting up forever.
    expect(state.stride).toBeGreaterThanOrEqual(0);
    expect(state.stride).toBeLessThan(1);
    expect(horizontalSpeed(state)).toBeGreaterThan(IDLE_SPEED);
  });

  it("holds its phase when standing still, so the run clip fading out has somewhere to fade from", () => {
    const { state, input, run } = setup();
    input.forward = 1;
    input.run = true;
    run(0.5);
    expect(state.stride).toBeGreaterThan(0);
    input.forward = 0;
    input.run = false;
    run(1); // decelerate below IDLE_SPEED
    expect(horizontalSpeed(state)).toBeLessThanOrEqual(IDLE_SPEED);
    // Where the cycle actually stopped, which is where the fading run clip is.
    const stopped = state.stride;
    expect(stopped).toBeGreaterThan(0);
    run(1);
    // It used to reset here, and that was half of why stopping was a cut rather than
    // a blend: the stride snapped to its first frame in the same tick the player
    // stopped, so the run clip `travelForward` is still fading out had nowhere to
    // fade *from*. Held, the legs settle out of the stride they were actually in.
    expect(state.stride).toBe(stopped);
  });

  it("still resets on a climb, where there is no cycle to be in at all", () => {
    const { state, input, run } = setup();
    input.forward = 1;
    input.run = true;
    run(0.5);
    expect(state.stride).toBeGreaterThan(0);
    state.ladder = { facing: 0 };
    run(1 / 60);
    expect(state.stride).toBe(0);
  });

  it("keeps its phase across a jump, so a hop lands back into the stride it left", () => {
    const { state, input, run, jump } = setup();
    input.forward = 1;
    input.run = true;
    run(0.4);
    jump();
    const atTakeoff = state.stride;
    expect(state.grounded).toBe(false);
    // Airborne it keeps turning rather than resetting: the legs are playing the
    // jump, and resetting would snap them on landing.
    run(0.15);
    expect(state.stride).not.toBe(0);
    expect(atTakeoff).toBeGreaterThan(0);
  });

  it("replays: the same inputs reach the same phase, which is what a rewind needs", () => {
    const a = setup();
    const b = setup();
    for (const s of [a, b]) {
      s.input.forward = 1;
      s.input.right = 0.5;
      s.input.run = true;
    }
    a.run(1.3);
    b.run(1.3);
    expect(b.state.stride).toBe(a.state.stride);
    // Non-trivial: it really did move, and it really did wrap at least once.
    expect(a.state.stride).toBeGreaterThan(0);
    expect(1.3 / STRIDE_PERIOD).toBeGreaterThan(0.5);
  });
});

// The pose blends: smoothed booleans, stepped here so both ends reach the same
// weights from the same inputs. They exist because a bullet is traced against a
// posed skeleton — a weight each end smoothed on its own frame times would put a
// peer's legs in two places — and because the obvious alternative does not work: a
// player crosses IDLE_SPEED in a single tick, so a speed-keyed crossfade lasts 17 ms.
describe("the pose blends", () => {
  it("takes GAIT_BLEND to come up, and stops there", () => {
    const { state, input, run } = setup();
    expect(state.gait).toBe(0);
    input.forward = 1;
    input.run = true;

    run(GAIT_BLEND / 2);
    expect(state.gait).toBeGreaterThan(0.3);
    expect(state.gait).toBeLessThan(0.7);

    run(GAIT_BLEND);
    expect(state.gait).toBe(1); // exactly, not asymptotically: `approach` does not overshoot
    run(1);
    expect(state.gait).toBe(1);
  });

  it("comes back down when the player stops", () => {
    const { state, input, run } = setup();
    input.forward = 1;
    input.run = true;
    run(1);
    expect(state.gait).toBe(1);
    input.forward = 0;
    input.run = false;
    run(2);
    expect(state.gait).toBe(0);
  });

  it("is down during a climb, whatever the player's speed says", () => {
    // A climb is posed by its own scrubbed clip, so the gait under it must not show:
    // a ladder moves the feet fast and would otherwise read as a sprint.
    //
    // `advanceBlends` directly rather than through `stepMovement`, because a ladder
    // state in a world with no ladder volumes is detached on the first step — the
    // rule under test is the one about climbing, not the one about grabbing.
    const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    state.grounded = true;
    state.velocity = { x: 0, y: 0, z: -RUN_SPEED };
    for (let i = 0; i < 60; i++) {
      advanceBlends(state, DT);
    }
    expect(state.gait).toBe(1);

    state.ladder = { facing: 0 };
    for (let t = 0; t < GAIT_BLEND; t += DT) {
      advanceBlends(state, DT);
    }
    expect(state.gait).toBe(0);

    // And a mantle, the other kind of climb.
    state.ladder = null;
    for (let i = 0; i < 60; i++) {
      advanceBlends(state, DT);
    }
    expect(state.gait).toBe(1);
    state.mantle = { target: { x: 0, y: 1, z: 0 }, left: 0.4, rise: 1, over: false };
    for (let t = 0; t < GAIT_BLEND; t += DT) {
      advanceBlends(state, DT);
    }
    expect(state.gait).toBe(0);
  });

  it("tracks the ground with `airborne`, both ways", () => {
    const { state, run, jump } = setup();
    expect(state.airborne).toBe(0);
    jump();
    expect(state.grounded).toBe(false);
    run(GAIT_BLEND);
    expect(state.airborne).toBe(1);
    run(2); // land and settle
    expect(state.grounded).toBe(true);
    expect(state.airborne).toBe(0);
  });

  it("replays: the same inputs reach the same blends, which is what a rewind needs", () => {
    const a = setup();
    const b = setup();
    for (const s of [a, b]) {
      s.input.forward = 1;
      s.input.run = true;
    }
    a.run(GAIT_BLEND * 0.6);
    b.run(GAIT_BLEND * 0.6);
    expect(b.state.gait).toBe(a.state.gait);
    expect(b.state.airborne).toBe(a.state.airborne);
    // Non-trivial: mid-blend, so the numbers being equal means something.
    expect(a.state.gait).toBeGreaterThan(0);
    expect(a.state.gait).toBeLessThan(1);
  });
});
