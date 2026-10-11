// A footstep is the stride clock crossing a footfall (sim/footsteps.ts).
//
// Everything here fails as a *plausible* wrong result rather than as an error: a
// step on the wrong surface, a step nobody heard because a slow frame crossed two
// footfalls at once, a player treading the air because the clock keeps running
// while they are off the ground, or a landing that fires on every tick of the
// recovery instead of on the one the feet touch. None of those throw, and none of
// them can be seen in a screenshot.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { seeded } from "../src/game/random.js";
import type { CapsuleWorld } from "../src/sim/capsule.js";
import {
  FIRST_FOOTFALL,
  FOOTFALLS_PER_CYCLE,
  footfallAlias,
  footfallPhase,
  footfallsCrossed,
  FootstepWatcher,
  gaitFor,
  landAlias,
  stepAlias,
  stepStream,
} from "../src/sim/footsteps.js";
import { idleInput, type PlayerInput } from "../src/sim/input.js";
import {
  createMovement,
  EMPTY_HANDS,
  movementEnv,
  NO_CLIMBS,
  PLAYER_MOVEMENT,
  RUN_SPEED,
  stepMovement,
  WALK_SPEED,
  type MovementState,
} from "../src/sim/movement.js";
import { SURFACE_ATTRIBUTE, SURFACE_TYPES } from "../src/sim/surfaces.js";

const DT = 1 / 60;

/** A floor slab at y = 0 spanning `x0..x1`, every vertex on `surface`. 128 triangles, as tests/surfaces.ts explains. */
function slab(surface: string | undefined, x0: number, x1: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(x1 - x0, 60, 8, 8).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, 0);
  if (surface !== undefined) {
    const index = SURFACE_TYPES.indexOf(surface as (typeof SURFACE_TYPES)[number]);
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute(SURFACE_ATTRIBUTE, new THREE.BufferAttribute(new Uint8Array(count).fill(index), 1));
  }
  const mesh = new THREE.Mesh(geometry);
  mesh.userData.collide = true;
  return mesh;
}

function worldOf(...meshes: THREE.Mesh[]): CollisionWorld {
  const root = new THREE.Group();
  for (const mesh of meshes) {
    root.add(mesh);
  }
  const collision = new CollisionWorld();
  collision.rebuild(root);
  return collision;
}

/** Ground that answers one surface everywhere, with no BVH at all: for the cases that are about the clock. */
function flatWorld(surface: string): CapsuleWorld {
  return {
    ready: true,
    resolveCapsule: (position, _r, _h, out) => {
      const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };
      result.position.x = position.x;
      result.position.y = position.y;
      result.position.z = position.z;
      result.grounded = true;
      result.normal.x = 0;
      result.normal.y = 1;
      result.normal.z = 0;
      return result;
    },
    overlapsCapsule: () => false,
    overlapsSweep: () => false,
    groundBelow: (_from, _distance, normal) => {
      if (normal) {
        normal.x = 0;
        normal.y = 1;
        normal.z = 0;
      }
      return 0;
    },
    traceRay: () => null,
    surfaceAt: () => surface as never,
  };
}

/** A grounded player at rest, which is what a watcher's first observation has to be given. */
/** One step of a player in `world`, with nothing to climb and nothing in hand. */
function step(state: MovementState, input: PlayerInput, world: CapsuleWorld): void {
  stepMovement(state, input, DT, movementEnv(world, NO_CLIMBS, PLAYER_MOVEMENT), EMPTY_HANDS);
}

function standing(): MovementState {
  const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  state.grounded = true;
  return state;
}

describe("where a footfall is", () => {
  it("is six a cycle, because a run loop is three double-steps long", () => {
    // Measured off worlds/catalog/animations/*/autorifle by posing the clip and
    // finding where each ball joint settles; see the constant's own note. Two,
    // at 0 and ½, is the guess this replaces.
    expect(FOOTFALLS_PER_CYCLE).toBe(6);
    expect(footfallPhase(0)).toBeCloseTo(FIRST_FOOTFALL, 6);
    expect(footfallPhase(5)).toBeCloseTo(FIRST_FOOTFALL + 5 / 6, 6);
    // iw5's forward combat run plants at .129 .283 .463 .621 .796 .958.
    const measured = [0.129, 0.283, 0.463, 0.621, 0.796, 0.958];
    for (const [index, phase] of measured.entries()) {
      expect(Math.abs(footfallPhase(index) - phase)).toBeLessThan(0.025);
    }
  });
});

describe("the phase-crossing detector", () => {
  it("catches one crossing, once", () => {
    expect(footfallsCrossed(0.1, 0.15)).toEqual([0]);
    // Standing exactly on it does not cross it again on the next observation.
    expect(footfallsCrossed(footfallPhase(0), 0.15)).toEqual([]);
  });

  it("stays silent where the clock did not move", () => {
    expect(footfallsCrossed(0.4, 0.4)).toEqual([]);
    // Backwards is a reset — a mantle or a ladder zeroes the clock — and a reset
    // is not a step.
    expect(footfallsCrossed(0.5, 0.45)).toEqual([]);
  });

  it("catches both when one observation crosses two", () => {
    // A frame that ran several ticks, or a stride rate at its ceiling. A step
    // nobody heard is worse than a step a frame late.
    expect(footfallsCrossed(0.1, 0.35)).toEqual([0, 1]);
    expect(footfallsCrossed(0.0, 0.47)).toEqual([0, 1, 2]);
  });

  it("wraps past 1 rather than losing the step that straddles it", () => {
    // 0.96 -> 0.02 has advanced 6% of a cycle and crosses the last footfall.
    expect(footfallsCrossed(0.95, 0.02)).toEqual([5]);
    // And in the order they were crossed: the last of one cycle before the first
    // of the next, not sorted by index.
    expect(footfallsCrossed(0.95, 0.2)).toEqual([5, 0]);
  });
});

describe("the gait mapping", () => {
  it("puts the simulation's two speeds on the bank's `run` and `sprint`", () => {
    // WALK_SPEED is what the legs play the *combat run* at, and RUN_SPEED is the
    // sprint. `walk` is what is left underneath.
    expect(gaitFor(WALK_SPEED)).toBe("run");
    expect(gaitFor(RUN_SPEED)).toBe("sprint");
    expect(gaitFor(0.5)).toBe("walk");
  });

  it("does not flicker at either plateau", () => {
    // The thresholds are *between* the two target speeds, not on them: a player
    // holding forward settles exactly at WALK_SPEED, and a threshold there would
    // be decided by the last bit of a float, twice a second, for ever.
    for (const nudge of [-1e-9, 0, 1e-9, 0.05, -0.05]) {
      expect(gaitFor(WALK_SPEED + nudge)).toBe("run");
      expect(gaitFor(RUN_SPEED + nudge)).toBe("sprint");
    }
  });

  it("has no `crouch`, because the bank has none", () => {
    // Every gait this can answer is one the bank spells. `prone` and `scrape`
    // are unreachable rather than invented.
    expect(["walk", "run", "sprint"]).toContain(gaitFor(1));
  });
});

describe("the alias a footfall is spelled with", () => {
  it("concatenates the surface, because the surface names are the game's own", () => {
    expect(stepAlias("run", "metal", true)).toBe("step_run_plr_metal");
    expect(stepAlias("run", "metal", false)).toBe("step_run_metal");
    expect(stepAlias("sprint", "default", false)).toBe("step_sprint_default");
    expect(landAlias("dirt", true)).toBe("land_plr_dirt");
    expect(landAlias("dirt", false)).toBe("land_dirt");
  });
});

describe("the watcher", () => {
  /** Walk `seconds` of `input` and collect everything the watcher heard, with the moment it heard it. */
  function walk(world: CapsuleWorld, seconds: number, input = idleInput(0, 0), state = standing()) {
    const watcher = new FootstepWatcher();
    const heard: { alias: string; index: number; t: number }[] = [];
    watcher.observe(state, world); // the first observation is a placement, never a step
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      step(state, input, world);
      for (const footfall of watcher.observe(state, world)) {
        heard.push({ alias: footfallAlias(footfall, false), index: footfall.index, t });
      }
    }
    return { heard, state };
  }

  it("says nothing at all while the player stands still", () => {
    const { heard } = walk(flatWorld("dirt"), 3);
    expect(heard).toEqual([]);
  });

  it("steps faster the faster the player goes, which nothing here sets", () => {
    // Measured at a steady speed: the run-up off a standstill is a real part of
    // the game and a misleading part of a rate.
    const RUN_UP = 2;
    const rate = (run: boolean) => {
      const input = idleInput(0, 0);
      input.forward = 1;
      input.run = run;
      const { heard } = walk(flatWorld("dirt"), RUN_UP + 12, input);
      return heard.filter((h) => h.t >= RUN_UP).length / 12;
    };
    const combat = rate(false);
    const sprint = rate(true);
    expect(combat).toBeGreaterThan(1);
    expect(sprint).toBeGreaterThan(combat * 1.4);
    // Nothing in this file sets either. `advanceStride`'s rate is
    // `speed / RUN_SPEED` and the cycle is six footfalls, so the ratio is
    // exactly the ratio of the two speeds.
    expect(sprint / combat).toBeCloseTo(RUN_SPEED / WALK_SPEED, 1);
  });

  it("names the gait it is actually making, not the key that was held", () => {
    const world = flatWorld("dirt");
    const input = idleInput(0, 0);
    input.forward = 1;
    const jog = walk(world, 4, input);
    expect(jog.heard.at(-1)!.alias).toBe("step_run_dirt");
    // The same keys with the run key down, from where the jog left off.
    input.run = true;
    const { heard } = walk(world, 4, input, jog.state);
    expect(heard.at(-1)!.alias).toBe("step_sprint_dirt");
  });

  it("does not tread a footfall twice when a correction snaps the clock back", () => {
    // `stride` travels as `unit`, 8 bits of a cycle, and a correction restores
    // the server's rounded phase and replays from it — so a predicted clock is
    // snapped back by up to half a step, twenty times a second. Carried back with
    // it, the footfall the snap crossed is crossed again on the way forward.
    const halfStep = 1 / 255 / 2;
    const watcher = new FootstepWatcher();
    const state = standing();
    state.grounded = true;
    state.velocity.x = WALK_SPEED;
    const at = (stride: number): MovementState => {
      state.stride = stride;
      return state;
    };
    const target = footfallPhase(0);
    watcher.observe(at(target - 0.01), flatWorld("dirt"));
    expect(watcher.observe(at(target + 0.0005), flatWorld("dirt"))).toHaveLength(1);
    // The snapshot lands and puts the clock back behind the footfall.
    expect(watcher.observe(at(target + 0.0005 - halfStep), flatWorld("dirt"))).toHaveLength(0);
    // Forward again over the same ground: it has already been trodden.
    expect(watcher.observe(at(target + 0.004), flatWorld("dirt"))).toHaveLength(0);
    // And the next one along still sounds.
    expect(watcher.observe(at(footfallPhase(1) + 0.001), flatWorld("dirt"))).toHaveLength(1);
  });

  it("does not tread the air, even though the clock keeps running there", () => {
    // `advanceStride` deliberately keeps going while airborne, so a player who
    // hops mid-sprint lands back into the stride they left. The grounded check is
    // what stops that being six footsteps in mid-air.
    const world = worldOf(slab("dirt", -30, 30));
    const state = standing();
    const input = idleInput(0, 0);
    input.forward = 1;
    input.run = true;
    const watcher = new FootstepWatcher();
    watcher.observe(state, world);
    const heard: string[] = [];
    let airborne = 0;
    for (let t = 0; t < 2; t += DT) {
      input.jump = t > 0.5 && t < 0.55;
      step(state, input, world);
      const kinds = watcher.observe(state, world).map((f) => f.kind);
      if (!state.grounded) {
        airborne++;
        expect(kinds.filter((k) => k === "step")).toEqual([]);
      }
      heard.push(...kinds);
    }
    expect(airborne).toBeGreaterThan(20); // there was a jump to be quiet during
    expect(heard).toContain("land");
  });

  it("lands once, on the tick the feet touch", () => {
    const world = worldOf(slab("dirt", -30, 30));
    const state = standing();
    const input = idleInput(0, 0);
    const watcher = new FootstepWatcher();
    watcher.observe(state, world);
    let landings = 0;
    for (let t = 0; t < 2; t += DT) {
      input.jump = t < DT / 2;
      step(state, input, world);
      landings += watcher.observe(state, world).filter((f) => f.kind === "land").length;
    }
    // Not once per tick of `MovementState.landing`, which runs for half a second
    // after a jump and would otherwise be thirty thuds.
    expect(landings).toBe(1);
  });

  it("hears a landing from a fall, which `MovementState.landing` never records", () => {
    // `integrate` only sets `landing` when `jumped` is true, so a player who
    // walked off a ledge has no landing timer at all. The transition is `grounded`.
    const world = worldOf(slab("dirt", -30, 30));
    const state = createMovement({ x: 0, y: 3, z: 0 }, 0, 0);
    const watcher = new FootstepWatcher();
    watcher.observe(state, world);
    const heard: string[] = [];
    for (let t = 0; t < 2; t += DT) {
      step(state, idleInput(0, 0), world);
      heard.push(...watcher.observe(state, world).map((f) => footfallAlias(f, true)));
    }
    expect(state.landing).toBe(0);
    expect(heard).toEqual(["land_plr_dirt"]);
  });

  it("is quiet on a ladder and through a mantle, where the clock is reset rather than turned", () => {
    const world = flatWorld("dirt");
    const state = standing();
    state.stride = 0.9;
    const watcher = new FootstepWatcher();
    watcher.observe(state, world);
    // A climb zeroes the clock. Read as an advance, 0.9 -> 0 would cross the
    // last footfall of the cycle and play a step nobody took.
    state.move = { kind: "mantle", target: { x: 0, y: 1, z: 0 }, left: 0.4, rise: 1, over: false };
    state.stride = 0;
    expect(watcher.observe(state, world)).toEqual([]);
  });

  it("asks what is under the foot at the instant it lands", () => {
    // Dirt to x = 0 and metal past it: walking across changes the alias with no
    // transition of any kind, because a footstep is a one-shot.
    const world = worldOf(slab("dirt", -30, 0), slab("metal", 0, 30));
    const state = standing();
    state.feet.x = -6;
    const input = idleInput(0, 0);
    input.right = 1; // +X, across the seam
    input.run = true;
    const watcher = new FootstepWatcher();
    watcher.observe(state, world);
    const heard: { alias: string; x: number }[] = [];
    for (let t = 0; t < 4; t += DT) {
      step(state, input, world);
      for (const footfall of watcher.observe(state, world)) {
        heard.push({ alias: footfallAlias(footfall, false), x: footfall.at.x });
      }
    }
    const surfaceOf = (alias: string) => alias.split("_").at(-1);
    expect(heard.filter((h) => h.x < -0.5).map((h) => surfaceOf(h.alias))).not.toContain("metal");
    expect(heard.filter((h) => h.x > 0.5).map((h) => surfaceOf(h.alias))).not.toContain("dirt");
    expect(heard.map((h) => surfaceOf(h.alias))).toContain("metal");
    expect(heard.map((h) => surfaceOf(h.alias))).toContain("dirt");
  });

  it("does not stride across a teleport", () => {
    const world = flatWorld("dirt");
    const state = standing();
    const watcher = new FootstepWatcher();
    watcher.observe(state, world);
    // A respawn: the feet are somewhere else entirely and the clock carried on.
    state.feet.x = 40;
    state.stride = 0.5;
    expect(watcher.observe(state, world)).toEqual([]);
  });
});

describe("the stream a footstep draws from", () => {
  it("gives the same clip and the same pitch from the same seed, every time", () => {
    const draw = () => {
      const random = seeded(stepStream(0x1234, 7, 3));
      return [random(), random(), random(), random()];
    };
    expect(draw()).toEqual(draw());
  });

  it("gives a different one for the next step, and for the next player", () => {
    const first = seeded(stepStream(0x1234, 7, 3))();
    expect(seeded(stepStream(0x1234, 8, 3))()).not.toBe(first);
    expect(seeded(stepStream(0x1234, 7, 4))()).not.toBe(first);
    expect(seeded(stepStream(0x4321, 7, 3))()).not.toBe(first);
  });

  it("never falls back to the bare seed, whichever term is zero", () => {
    // `Math.imul(0, k)` is 0, and an xor with 0 would leave one player's every
    // step drawing their recoil's own first number.
    expect(stepStream(0x1234, 0, -1)).not.toBe(0x1234);
    expect(stepStream(0, 0, -1)).not.toBe(0);
  });
});
