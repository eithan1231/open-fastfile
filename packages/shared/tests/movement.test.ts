// Walking, running and jumping (sim/movement.ts) against real
// collision: a jump under a ceiling ends at it, the air keeps the takeoff's
// speed, a landing slows the player, and only a forward run sprints.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { idleInput } from "../src/sim/input.js";
import {
  createMovement,
  EMPTY_HANDS,
  horizontalSpeed,
  JUMP_HEIGHT,
  JUMP_REPEAT,
  LAND_WINDOW,
  LAND_WINDOW_HIGH,
  movementEnv,
  NO_CLIMBS,
  PLAYER_MOVEMENT,
  RUN_SPEED,
  stepMovement,
  WALK_SPEED,
  WALKING,
  wantsSprint,
  type MovementState,
} from "../src/sim/movement.js";
import { advanceBlends, GAIT_BLEND, IDLE_SPEED, STRIDE_PERIOD } from "../src/sim/gait.js";
import { UNIT } from "../src/sim/units.js";

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
  const env = movementEnv(collision, NO_CLIMBS, PLAYER_MOVEMENT);
  const options = { sprintAllowed: true, braced: false };
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      stepMovement(state, input, DT, env, { sprint: options.sprintAllowed, braced: options.braced });
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
  return { state, input, env, options, run, jump };
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
    // Head room of 2 m: the head (1.78 m) meets the slab 0.22 m into a 0.99 m jump.
    const low = airTime(collider([4, 0.2, 4], [0, 2.1, 0]));
    expect(open).toBeGreaterThan(0.5);
    expect(low).toBeLessThan(open * 0.6);
  });

  it("jumps as high as JUMP_HEIGHT, at any tick rate", () => {
    for (const rate of [30, 60, 125]) {
      const { state, input, env } = setup();
      let top = 0;
      for (let i = 0; i < rate; i++) {
        input.jump = i === 0;
        stepMovement(state, input, 1 / rate, env, EMPTY_HANDS);
        top = Math.max(top, state.feet.y);
      }
      expect(top, `${rate} Hz`).toBeGreaterThan(JUMP_HEIGHT - 0.03);
      expect(top, `${rate} Hz`).toBeLessThan(JUMP_HEIGHT + 0.005);
    }
  });

  it("keeps the takeoff's speed in the air, the keys only nudging it", () => {
    const { state, input, run, jump } = setup();
    input.forward = 1;
    run(0.3);
    jump();
    const takeoff = { ...state.feet };
    input.forward = 0;
    input.right = 1;
    run(0.3);
    expect(state.feet.z - takeoff.z).toBeLessThan(-1.3); // still carried forward at walking speed
    expect(state.feet.x - takeoff.x).toBeGreaterThan(0.1); // a drift to the right...
    expect(state.feet.x - takeoff.x).toBeLessThan(0.3); // ...where the ground would have gone over a metre
    expect(horizontalSpeed(state)).toBeLessThanOrEqual(WALK_SPEED * 1.05); // and no speed to be had from it
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
    run(0.5);
    expect(horizontalSpeed(state)).toBe(0);
  });

  it("walks slower sideways and backward, and no faster on a diagonal", () => {
    const speedAfter = (keys: Partial<ReturnType<typeof idleInput>>) => {
      const { state, input, run } = setup();
      Object.assign(input, keys);
      run(1);
      return horizontalSpeed(state);
    };
    expect(speedAfter({ forward: 1 })).toBeCloseTo(WALK_SPEED, 5);
    expect(speedAfter({ right: 1 })).toBeCloseTo(WALK_SPEED * 0.8, 5);
    expect(speedAfter({ right: -1 })).toBeCloseTo(WALK_SPEED * 0.8, 5);
    expect(speedAfter({ forward: -1 })).toBeCloseTo(WALK_SPEED * 0.7, 5);
    expect(speedAfter({ forward: 1, right: 1 })).toBeCloseTo(WALK_SPEED, 5);
    expect(speedAfter({ forward: -1, right: 1 })).toBeCloseTo(WALK_SPEED * 0.8, 5);
  });

  it("sprints only forward, and only while the weapon allows it", () => {
    const after = (keys: Partial<ReturnType<typeof idleInput>>, sprintAllowed = true) => {
      const { state, input, options, run } = setup();
      Object.assign(input, keys);
      options.sprintAllowed = sprintAllowed;
      run(1);
      return state;
    };
    expect(horizontalSpeed(after({ forward: 1, run: true }))).toBeCloseTo(RUN_SPEED, 5);
    expect(RUN_SPEED).toBeCloseTo(WALK_SPEED * 1.5, 10);
    expect(horizontalSpeed(after({ forward: 1, run: true }, false))).toBeCloseTo(WALK_SPEED, 5);
    expect(horizontalSpeed(after({ forward: -1, run: true }))).toBeCloseTo(WALK_SPEED * 0.7, 5);
    expect(horizontalSpeed(after({ right: 1, run: true }))).toBeCloseTo(WALK_SPEED * 0.8, 5);
    // In a sprint the strafe keys count for two thirds: the sprint curves rather than strafes.
    const curved = after({ forward: 1, right: 1, run: true });
    expect(horizontalSpeed(curved)).toBeCloseTo(RUN_SPEED, 5);
    expect(curved.velocity.x / -curved.velocity.z).toBeCloseTo(0.667, 3);
  });
});

/** The step of a takeoff. */
function tookOff(state: MovementState): boolean {
  return state.jumpFrom !== null && state.sinceJump === 0;
}

describe("a jump", () => {
  /** How many times `hold` — asked each step whether the key is down — jumps in `seconds`, and when. */
  const takeoffs = (seconds: number, hold: (state: MovementState, t: number) => boolean, ...extra: THREE.Mesh[]) => {
    const { state, input, run } = setup(...extra);
    const times: number[] = [];
    let t = 0;
    input.jump = hold(state, t);
    run(seconds, () => {
      if (tookOff(state)) {
        times.push(t);
      }
      t += DT;
      input.jump = hold(state, t);
    });
    return times;
  };

  it("is one jump for a held key, however long it is held", () => {
    expect(takeoffs(3, () => true)).toHaveLength(1);
  });

  it("is not kept for the landing when pressed in the air", () => {
    // A tap at the start, and another while falling 10 cm above the floor.
    const tapped = takeoffs(3, (state, t) => t === 0 || (state.velocity.y < 0 && state.feet.y < 0.1 && !state.grounded));
    expect(tapped).toHaveLength(1);
    // The same, but held from there through the landing: a held key is not a press.
    let late = false;
    const held = takeoffs(3, (state, t) => t === 0 || (late ||= state.velocity.y < 0 && state.feet.y < 0.1));
    expect(held).toHaveLength(1);
  });

  it("is taken from ground a unit under the feet, which broken ground leaves there for a tick, and from no further", () => {
    const pressedAbove = (gap: number) => {
      const { state, jump } = setup();
      state.feet.y = gap;
      state.grounded = false;
      jump();
      return tookOff(state);
    };
    expect(pressedAbove(1 * UNIT)).toBe(true);
    expect(pressedAbove(4 * UNIT)).toBe(false);
  });

  it("is pressed again on the ground to jump again", () => {
    // Every other step is a new press: each landing is jumped from.
    let down = false;
    expect(takeoffs(3, () => (down = !down)).length).toBeGreaterThanOrEqual(3);
  });

  it("does not follow another within JUMP_REPEAT, however soon the ground comes back", () => {
    // Under a slab the head meets 0.22 m up, a jump is back down in a fifth of a second.
    let down = false;
    const times = takeoffs(1.2, () => (down = !down), collider([4, 0.2, 4], [0, 2.1, 0]));
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]! - times[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(JUMP_REPEAT - 1e-9);
      expect(gap).toBeLessThan(JUMP_REPEAT + 3 * DT);
    }
  });

  it("ends a sprint: the flight coasts at the takeoff's speed and adds nothing to it", () => {
    const { state, input, env, run, jump } = setup();
    input.forward = 1;
    input.run = true;
    run(1);
    expect(wantsSprint(state, input, env)).toBe(true);
    jump();
    const takeoff = horizontalSpeed(state);
    expect(takeoff).toBeCloseTo(RUN_SPEED, 1);
    let fastest = 0;
    run(0.5, () => {
      expect(state.grounded).toBe(false);
      // Run is still held, and the one sprint rule says no all the same.
      expect(wantsSprint(state, input, env)).toBe(false);
      fastest = Math.max(fastest, horizontalSpeed(state));
    });
    expect(fastest).toBeLessThanOrEqual(takeoff + 1e-9);
  });

  it("never reaches the run speed from a walk by holding run in the air", () => {
    const { state, input, env, run, jump } = setup();
    input.forward = 1;
    run(1);
    jump();
    input.run = true;
    let fastest = 0;
    run(0.55, () => {
      expect(wantsSprint(state, input, env)).toBe(false);
      fastest = Math.max(fastest, horizontalSpeed(state));
    });
    expect(fastest).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
    // And the ground under a held run key sprints again.
    run(2.5);
    expect(wantsSprint(state, input, env)).toBe(true);
    expect(horizontalSpeed(state)).toBeCloseTo(RUN_SPEED, 5);
  });
});

describe("a landing", () => {
  it("costs a jump its speed twice, grips for LAND_WINDOW, and wears off", () => {
    const { state, input, run, jump } = setup();
    input.forward = 1;
    run(0.5);
    jump();
    const after: number[] = [];
    run(3, () => {
      if (state.grounded) {
        after.push(horizontalSpeed(state));
      }
    });
    // The fall's cut on touching down, then the landing's on the first step along the ground.
    expect(after[0]).toBeLessThan(WALK_SPEED * 0.67 + 1e-6);
    expect(after[0]).toBeGreaterThan(WALK_SPEED * 0.6);
    expect(after[1]).toBeLessThan(WALK_SPEED * 0.67 * 0.65 + 0.2);
    expect(after[1]).toBeGreaterThan(1.5); // and no stop
    // Still held back half a second later, where an ordinary start would be at full speed.
    expect(after[30]).toBeLessThan(WALK_SPEED * 0.9);
    expect(after.at(-1)).toBeCloseTo(WALK_SPEED, 5);
    expect(state.landing).toBe(0);
    expect(after.length * DT).toBeGreaterThan(LAND_WINDOW);
  });

  it("is a jump's alone: a fall takes its cut on touching down, and nothing after", () => {
    // Off a ledge a metre up: one cut, no window.
    const high = on(collider([40, 1, 8], [0, -0.5, -2]), collider([40, 1, 40], [0, -1.5, -20]));
    high.input.forward = 1;
    let before = 0;
    let touched = 0;
    high.run(2.5, () => {
      if (!high.state.grounded) {
        before = horizontalSpeed(high.state);
      } else if (before > 0 && touched === 0) {
        touched = horizontalSpeed(high.state);
      }
      expect(high.state.landing).toBe(0);
    });
    expect(high.state.feet.y).toBeCloseTo(-1, 2);
    expect(touched).toBeCloseTo(before * 0.67, 5);
    expect(horizontalSpeed(high.state)).toBeCloseTo(WALK_SPEED, 5);
  });

  it("makes chained jumps slow: timing every landing never beats a walk", () => {
    const { state, input, run } = setup();
    input.forward = 1;
    run(1);
    let down = false;
    let fastest = 0;
    let count = 0;
    const landings: number[] = [];
    let airborne = false;
    run(6, () => {
      input.jump = down = !down;
      fastest = Math.max(fastest, horizontalSpeed(state));
      if (tookOff(state)) {
        count++;
      }
      if (airborne && state.grounded) {
        landings.push(horizontalSpeed(state));
      }
      airborne = !state.grounded;
    });
    expect(count).toBeGreaterThanOrEqual(6);
    expect(fastest).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
    // Every landing takes the fall's cut from whatever the air gave back.
    expect(landings.length).toBeGreaterThanOrEqual(6);
    for (const speed of landings) {
      expect(speed).toBeLessThanOrEqual(WALK_SPEED * 0.67 + 1e-9);
    }
  });

  it("lowers a jump taken inside it, by what is left of it", () => {
    const apexes = (wait: number) => {
      const { state, input, run, jump } = setup();
      const tops: number[] = [];
      jump();
      let top = 0;
      run(1, () => (top = Math.max(top, state.feet.y)));
      tops.push(top);
      expect(state.grounded).toBe(true);
      run(wait);
      input.jump = false;
      jump();
      top = 0;
      run(1, () => (top = Math.max(top, state.feet.y)));
      tops.push(top);
      return tops;
    };
    const [first, soon] = apexes(0);
    expect(first).toBeCloseTo(JUMP_HEIGHT, 1);
    expect(soon!).toBeLessThan(first! * 0.75);
    expect(soon!).toBeGreaterThan(first! / 2.5 - 0.02);
    const [, later] = apexes(1);
    expect(later!).toBeGreaterThan(soon!);
    expect(later!).toBeLessThan(first! - 0.02);
    const [, rested] = apexes(LAND_WINDOW);
    expect(rested!).toBeCloseTo(first!, 3);
  });

  it("is shorter, and costs more, well above where the jump took off", () => {
    // A box 20 units high, jumped onto from beside it.
    const { state, input, run, jump } = setup(collider([4, 20 * UNIT, 4], [0, 10 * UNIT, -3]));
    input.forward = 1;
    run(0.05);
    jump();
    let landing = 0;
    run(1, () => (landing = Math.max(landing, state.landing)));
    expect(state.feet.y).toBeCloseTo(20 * UNIT, 2);
    expect(landing).toBeCloseTo(LAND_WINDOW_HIGH, 5);
  });
});

describe("the movement state", () => {
  it("is plain data: a JSON copy steps in lockstep with the original", () => {
    const a = setup();
    a.input.forward = 1;
    a.run(0.3);
    a.jump();
    expect(a.state.jumpFrom).not.toBeNull();
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
function on(...ground: THREE.Mesh[]) {
  const root = new THREE.Group();
  root.add(...ground);
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  const input = idleInput(0, 0);
  const env = movementEnv(collision, NO_CLIMBS, PLAYER_MOVEMENT);
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      stepMovement(state, input, DT, env, EMPTY_HANDS);
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

/** A face rising towards -Z at `angle`, its foot on the floor at z = -2. */
function bank(angle: number): THREE.Mesh {
  const mesh = collider([40, 2, 12], [0, -Math.cos(angle) + 6 * Math.sin(angle), -2 - Math.sin(angle) - 6 * Math.cos(angle)]);
  mesh.rotation.x = angle;
  return mesh;
}

describe("ground", () => {
  it("is no steeper than 45 degrees: a steeper face is slid down, not stood on", () => {
    for (const [angle, stood] of [
      [0.7, true], // 40 degrees
      [0.9, false], // 52 degrees
    ] as const) {
      const { state, run } = on(slope(angle));
      const before = state.feet.y;
      let grounded = 0;
      run(0.5, () => {
        grounded += state.grounded ? 1 : 0;
      });
      expect(grounded > 0, `${angle} rad`).toBe(stood);
      expect(before - state.feet.y > 0.3, `${angle} rad`).toBe(!stood);
    }
  });

  it("is kept to when it is within 9 units below, and fallen to when it is further", () => {
    const airOver = (drop: number) => {
      const { state, input, run } = on(collider([40, 1, 8], [0, -0.5, 0]), collider([40, 1, 40], [0, -0.5 - drop, -24]));
      input.forward = 1;
      let air = 0;
      run(2, () => {
        air += state.grounded ? 0 : 1;
      });
      expect(state.feet.y).toBeCloseTo(-drop, 3);
      return air;
    };
    expect(airOver(8 * UNIT)).toBe(0);
    expect(airOver(12 * UNIT)).toBeGreaterThan(0);
  });
});

describe("a step", () => {
  /** Walk at a ledge `height` tall, two metres ahead, and say where the feet end up. */
  const walkAt = (height: number, ...extra: THREE.Mesh[]) => {
    const ctx = setup(collider([40, height, 10], [0, height / 2, -7]), ...extra);
    ctx.input.forward = 1;
    ctx.run(1.5);
    return ctx.state;
  };

  it("is taken onto a ledge 18 units tall and no taller", () => {
    const low = walkAt(17.5 * UNIT);
    expect(low.grounded).toBe(true);
    expect(low.feet.y).toBeCloseTo(17.5 * UNIT, 3);
    const high = walkAt(19 * UNIT);
    expect(high.feet.y).toBeCloseTo(0, 3);
    expect(high.feet.z).toBeGreaterThan(-2 - 1e-3 + PLAYER_MOVEMENT.radius);
  });

  it("is as tall as the head room under a low ceiling allows, rather than refused", () => {
    // Twelve units over the head: room for a ten-unit ledge, not for the whole step.
    const roof = PLAYER_MOVEMENT.height + 12 * UNIT;
    const state = walkAt(10 * UNIT, collider([40, 1, 4], [0, roof + 0.5, 0]));
    expect(state.feet.y).toBeCloseTo(10 * UNIT, 3);
  });

  it("is not taken onto a face too steep to stand on", () => {
    // 60 degrees: a walk gets no further up it than its foot.
    const ctx = setup(bank(Math.PI / 3));
    ctx.input.forward = 1;
    let highest = 0;
    ctx.run(2, () => {
      highest = Math.max(highest, ctx.state.feet.y);
    });
    expect(highest).toBeLessThan(18 * UNIT);
    expect(ctx.state.feet.z).toBeGreaterThan(-2.5);
  });

  it("costs speed, by how much of a whole step it is", () => {
    const slowest = (height: number) => {
      const ctx = setup(collider([40, height, 10], [0, height / 2, -7]));
      ctx.input.forward = 1;
      let least = Infinity;
      ctx.run(1.2, () => {
        if (ctx.state.feet.z < -1) {
          least = Math.min(least, horizontalSpeed(ctx.state));
        }
      });
      expect(ctx.state.feet.y).toBeCloseTo(height, 3);
      return least / WALK_SPEED;
    };
    const stair = slowest(8 * UNIT);
    const tall = slowest(16 * UNIT);
    expect(stair).toBeLessThan(0.99);
    expect(tall).toBeLessThan(stair);
    expect(tall).toBeGreaterThan(0.15);
  });

  it("is taken in a jump onto what is under the jump's own height, and nothing above it", () => {
    const jumpAt = (height: number) => {
      const ctx = setup(collider([40, height, 10], [0, height / 2, -7]));
      ctx.input.forward = 1;
      ctx.run(0.25);
      ctx.jump();
      ctx.run(1);
      return ctx.state;
    };
    const under = jumpAt(36 * UNIT);
    expect(under.grounded).toBe(true);
    expect(under.feet.y).toBeCloseTo(36 * UNIT, 3);
    // A step's reach above the jump would clear this one; a jump's own height does not.
    expect(jumpAt(44 * UNIT).feet.y).toBeCloseTo(0, 3);
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
    state.move = { kind: "ladder", facing: 0 };
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

    state.move = { kind: "ladder", facing: 0 };
    for (let t = 0; t < GAIT_BLEND; t += DT) {
      advanceBlends(state, DT);
    }
    expect(state.gait).toBe(0);

    // And a mantle, the other kind of climb.
    state.move = WALKING;
    for (let i = 0; i < 60; i++) {
      advanceBlends(state, DT);
    }
    expect(state.gait).toBe(1);
    state.move = { kind: "mantle", ledge: { x: 0, y: 1, z: 0 }, yaw: 0, row: 3, over: false, left: 0.4 };
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
