// Which clips a body is playing (sim/pose.ts), and the one property that matters:
// it is a pure function of the state.
//
// That is not a style preference. A bullet is traced against a posed skeleton, so
// the server has to decide where a peer's head was; if the decision depended on the
// frames before it — as it did while this lived inside a mixer-driven animator —
// then no snapshot could reproduce it, and the hit box would sit somewhere other
// than the body on screen.

import { describe, expect, it } from "vitest";
import { createMovement, LAND_WINDOW, RUN_SPEED, type MovementState } from "../src/sim/movement.js";
import { IDLE_SPEED } from "../src/sim/gait.js";
import { mantleSeconds } from "../src/sim/moves/mantle.js";
import { LAND_DIP, poseLayers, bodyPitch, bodyYaw, type PoseLayers, type RoleSet } from "../src/sim/pose.js";
import { AIM_LIMIT, CHARACTER_ROLES, type CharacterRole } from "../src/sim/characterDef.js";
import { eyePathSeconds } from "../src/sim/stance.js";
import type { WeaponData } from "../src/sim/weapon.js";
import { restingKick, restingViewKick } from "../src/sim/recoil.js";

/** A set with a clip for every role, and the sixteen a set held before it had a stance to pose. */
const EVERY: RoleSet = new Set(CHARACTER_ROLES);
const STANDING_ONLY: RoleSet = new Set(CHARACTER_ROLES.slice(0, CHARACTER_ROLES.indexOf("crouchIdle")));

function pose(m: MovementState, w: WeaponData | null, roles: RoleSet = EVERY): PoseLayers {
  return poseLayers(m, w, roles);
}

/** The `landing` that has share `t` of the landing's dip still to go: 1 the step it lands, 0 once the dip is over. */
function dip(t: number): number {
  return LAND_WINDOW - LAND_DIP * (1 - t);
}

function movement(over: Partial<MovementState> = {}): MovementState {
  return settled({ ...createMovement({ x: 0, y: 0, z: 0 }, 0, 0), grounded: true, ...over });
}

/**
 * The heading `advanceBlends` would have settled on for this state's velocity.
 *
 * A fixture that says "running north-east" has to say it twice now: the velocity the
 * player has, and the heading the *pose* has blended to. Two facts for the same
 * reason `velocity` and `gait` are two — a reversal walks the heading through the
 * middle over TRAVEL_BLEND, so a test of the settled pose has to ask for the settled
 * heading. Standing still has no heading and is left at zero.
 */
function settled(s: MovementState): MovementState {
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  if (speed <= IDLE_SPEED) {
    return s;
  }
  const sin = Math.sin(s.yaw);
  const cos = Math.cos(s.yaw);
  s.travelForward = (-s.velocity.x * sin - s.velocity.z * cos) / speed;
  s.travelRight = (s.velocity.x * cos - s.velocity.z * sin) / speed;
  return s;
}

/**
 * Moving, with the gait blend already all the way up.
 *
 * Two separate facts now, and a test has to say which it means: `velocity` is how
 * fast the player is going, and `gait` is how much of the run clip is showing. They
 * differ for 0.18 s after starting or stopping, which is the whole point of the
 * blend — so a fixture that wants the settled pose says so.
 */
function running(over: Partial<MovementState> = {}): MovementState {
  return movement({ velocity: { x: 0, y: 0, z: -RUN_SPEED }, gait: 1, ...over });
}

function weapon(over: Partial<WeaponData> = {}): WeaponData {
  return {
    state: "idle",
    input: { trigger: false, ads: false, sprint: false },
    timer: 0,
    span: 0,
    ammo: 30,
    cooldown: 0,
    pressed: false,
    burstLeft: 0,
    ads: 0,
    reloadQueued: false,
    refillAt: null,
    fired: 0,
    spread: 0,
    kick: restingKick(),
    viewKick: restingViewKick(),
    clip: null,
    ...over,
  };
}

/** Weights by role, so a test can name what it expects without indexing an array. */
function legs(m: MovementState, w: WeaponData | null = weapon(), roles: RoleSet = EVERY): Record<string, number> {
  const out: Record<string, number> = {};
  for (const layer of pose(m, w, roles).legs) {
    out[layer.role] = (out[layer.role] ?? 0) + layer.weight;
  }
  return out;
}

describe("poseLayers is a pure function of the state", () => {
  it("gives the same answer for the same state, however many times it is asked", () => {
    const m = movement({ velocity: { x: 1, y: 0, z: -3 }, stride: 0.42, gait: 0.6, airborne: 0.2 });
    const w = weapon({ state: "reloading", span: 2, timer: 0.5 });
    const first = pose(m, w);
    for (let i = 0; i < 5; i++) {
      expect(pose(m, w)).toEqual(first);
    }
  });

  it("gives the same answer for an equal state it has never seen", () => {
    // The real claim: two ends holding equal states agree, having shared no history.
    const a = movement({ velocity: { x: 2, y: 0, z: -2 }, stride: 0.7, landing: dip(0.4), gait: 0.8 });
    const b = structuredClone(a) as MovementState;
    expect(pose(b, weapon())).toEqual(pose(a, weapon()));
  });

  it("does not depend on the order states are asked about", () => {
    // What a mixer could not promise. Walking, then sprinting, then walking again
    // must give the walk's pose both times — no blend left over from the sprint.
    const walk = running({ velocity: { x: 0, y: 0, z: -2 }, stride: 0.3 });
    const sprint = running({ stride: 0.3 });
    const before = pose(walk, weapon());
    pose(sprint, weapon({ state: "sprinting" }));
    expect(pose(walk, weapon())).toEqual(before);
  });

  it("weights sum to one, so a body is never half-drawn", () => {
    const cases: MovementState[] = [
      movement(),
      running(),
      running({ velocity: { x: 3, y: 0, z: -3 } }),
      movement({ grounded: false, airborne: 1, sinceJump: 0.1 }),
      running({ landing: dip(0.6) }),
      // Mid-transition in each direction, which is where a blend has to still sum to 1.
      movement({ velocity: { x: 0, y: 0, z: -RUN_SPEED }, gait: 0.5 }),
      movement({ grounded: false, airborne: 0.5, sinceJump: 0.1 }),
      running({ landing: dip(0.6), gait: 0.5, airborne: 0.4 }),
      movement({ move: { kind: "ladder", facing: 1 } }),
      movement({ move: { kind: "mantle", ledge: { x: 0, y: 1, z: 0 }, yaw: 0, row: 3, over: false, left: 0.2 } }),
    ];
    for (const m of cases) {
      const total = pose(m, weapon()).legs.reduce((sum, l) => sum + l.weight, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("keeps every phase inside the clip", () => {
    for (const stride of [0, 0.5, 0.999]) {
      for (const m of [running({ stride }), movement({ move: { kind: "ladder", facing: 0 }, feet: { x: 0, y: 3.7, z: 0 } })]) {
        for (const layer of pose(m, weapon()).legs) {
          expect(layer.phase).toBeGreaterThanOrEqual(0);
          expect(layer.phase).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("what a body is doing", () => {
  it("stands still with the gait blend down, and aims when the weapon does", () => {
    expect(legs(movement())).toEqual({ idle: 1 });
    expect(legs(movement(), weapon({ ads: 1 }))).toEqual({ idleAds: 1 });
  });

  it("blends the two run clips that bracket the direction of travel", () => {
    // Yaw 0 faces -Z; forward-and-right at 45° is half of each, and the two behind
    // hold none of it.
    const speed = RUN_SPEED / Math.SQRT2;
    const w = legs(running({ velocity: { x: speed, y: 0, z: -speed } }));
    expect(w.runForward).toBeCloseTo(0.5, 6);
    expect(w.runRight).toBeCloseTo(0.5, 6);
    expect(w.runBack).toBeUndefined();
    expect(w.runLeft).toBeUndefined();
  });

  it("runs backwards rather than turning round", () => {
    expect(legs(running({ velocity: { x: 0, y: 0, z: RUN_SPEED } }))).toEqual({ runBack: 1 });
  });

  it("keeps all four run clips at one point in the stride, so the blend cannot slide", () => {
    // They are 1.1 to 1.9 s long. Played at their own rates, a strafe's feet would
    // walk away from a run's over a few seconds of holding a diagonal.
    const speed = RUN_SPEED / Math.SQRT2;
    const diagonal = pose(running({ velocity: { x: speed, y: 0, z: -speed }, stride: 0.31 }), weapon());
    expect(diagonal.legs).toHaveLength(2);
    for (const layer of diagonal.legs) {
      expect(layer.phase).toBe(0.31);
    }
  });

  it("scrubs a mantle by how much of it is left, not by a clock", () => {
    // So the body arrives at the top exactly when the capsule does, whatever the
    // row's time — and a peer whose first snapshot lands mid-mantle starts there.
    const row = 2;
    const up = mantleSeconds(row, false);
    const total = mantleSeconds(row, true);
    const at = (left: number, over: boolean) =>
      pose(movement({ move: { kind: "mantle", ledge: { x: 0, y: 0, z: 0 }, yaw: 0, row, over, left } }), weapon()).legs[0]!;
    expect(at(up, false).phase).toBeCloseTo(0, 6);
    expect(at(up / 2, false).phase).toBeCloseTo(0.5, 6);
    expect(at(0, false).phase).toBeCloseTo(1, 6);
    expect(at(up, false).role).toBe("mantle");
    // A vault is the same clip onto the ledge, and then its own from there over.
    const vault = total - up;
    expect(at(total, true)).toMatchObject({ role: "mantle", phase: expect.closeTo(0, 6) });
    expect(at(vault + up / 2, true)).toMatchObject({ role: "mantle", phase: expect.closeTo(0.5, 6) });
    expect(at(vault / 2, true)).toMatchObject({ role: "mantleOver", phase: expect.closeTo(0.5, 6) });
    expect(at(0, true)).toMatchObject({ role: "mantleOver", phase: expect.closeTo(1, 6) });
  });

  it("poses a ladder from the feet's height, so a still climber holds a pose", () => {
    const at = (y: number, vy: number) =>
      pose(movement({ move: { kind: "ladder", facing: 0 }, feet: { x: 0, y, z: 0 }, velocity: { x: 0, y: vy, z: 0 } }), weapon()).legs[0]!;
    expect(at(0, 1).role).toBe("climbUp");
    expect(at(0, -1).role).toBe("climbDown");
    // The same height twice is the same pose: nothing is integrating.
    expect(at(2.5, 1).phase).toBe(at(2.5, 1).phase);
    expect(at(0, 1).phase).toBeCloseTo(0, 6);
  });

  it("fades a landing's dip out over the start of the simulation's own landing, on top of the gait", () => {
    const fresh = legs(running({ landing: dip(1) }));
    const nearly = legs(running({ landing: dip(0.1) }));
    // Past the dip the landing still grips the feet, and shows nothing.
    expect(legs(running({ landing: dip(0) })).land).toBeUndefined();
    expect(fresh.land).toBeGreaterThan(nearly.land!);
    // And the run keeps what the landing does not: a player who lands mid-sprint
    // keeps running, with a dip in it. Summed over every role, because the run is a
    // blend of clips now rather than one of them.
    const total = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);
    expect(total(fresh)).toBeCloseTo(1, 6);
    expect(total(nearly)).toBeCloseTo(1, 6);
    // The landing's share is the difference: what it takes, the gait does not have.
    expect(fresh.land!).toBeGreaterThan(0.5);
    expect(nearly.land!).toBeLessThan(0.2);
  });

  it("holds the jump while airborne and does not land in mid-air", () => {
    expect(legs(movement({ grounded: false, airborne: 1, sinceJump: 0.05 }))).toEqual({ jump: 1 });
    // `sinceJump` stops counting at half a second, so a long fall holds the clip's
    // last frame — which is what a one-shot does anyway.
    expect(pose(movement({ grounded: false, airborne: 1, sinceJump: 0.5 }), weapon()).legs[0]!.phase).toBe(0.5);
  });
});

describe("the torso overlay", () => {
  /** The overlay's total weight, and which roles carry it. */
  function torso(w: WeaponData | null) {
    const layers = pose(movement(), w).torso;
    const total = layers.reduce((sum, l) => sum + l.weight, 0);
    return { total, roles: layers.map((l) => l.role), layers };
  }

  it("is nothing at all when the weapon is idle", () => {
    expect(torso(weapon()).total).toBe(0);
    expect(torso(null).total).toBe(0);
  });

  it("fades in at the start of a state and out at the end, rather than appearing", () => {
    // The transition that used to be a switch. In proportion to the state, so a shot
    // and a reload each get one rather than a fixed slice that is most of the shot.
    const at = (timer: number) => torso(weapon({ state: "reloading", span: 2, timer }));
    expect(at(2).total).toBeCloseTo(0, 6); // just entered
    expect(at(1).total).toBeCloseTo(1, 6); // halfway, full weight
    expect(at(0).total).toBeCloseTo(0, 6); // just finished
    // And monotonic on the way in.
    expect(at(1.99).total).toBeLessThan(at(1.9).total);
  });

  it("places a reload by how far through the reload the weapon is", () => {
    const at = (timer: number) => torso(weapon({ state: "reloading", span: 2, timer })).layers[0]!;
    expect(at(1).phase).toBeCloseTo(0.5, 6);
    expect(at(1).role).toBe("reload");
  });

  it("blends hip fire into aimed fire rather than switching at half", () => {
    // `ads` is a real ramp over the weapon's own adsInTime; `> 0.5` threw it away.
    const firing = (ads: number) => torso(weapon({ state: "firing", span: 0.1, timer: 0.05, ads }));
    expect(firing(0).roles).toEqual(["fire"]);
    expect(firing(1).roles).toEqual(["fireAds"]);
    const half = firing(0.5);
    expect(half.roles).toEqual(["fire", "fireAds"]);
    expect(half.layers[0]!.weight).toBeCloseTo(half.layers[1]!.weight, 6);
    expect(half.total).toBeCloseTo(firing(0).total, 6);
  });

  it("is placed at the start when the state has no span to measure against", () => {
    // A weapon with no timed state cannot be part way through one — and so cannot
    // have faded in either.
    expect(torso(weapon({ state: "reloading", span: 0, timer: 0 })).total).toBe(0);
  });
});

describe("where a body looks", () => {
  it("faces the view, except on a ladder where it faces the ladder", () => {
    expect(bodyYaw(movement({ yaw: 1.2 }))).toBe(1.2);
    // IW5's `PM_LadderMove` turns the body to the ladder whatever the view does.
    expect(bodyYaw(movement({ yaw: 1.2, move: { kind: "ladder", facing: 0 } }))).toBeCloseTo(Math.PI, 6);
  });

  it("turns the aim joint no further than a spine bends", () => {
    expect(pose(movement({ pitch: 0.3 }), weapon()).aim).toBeCloseTo(0.3, 6);
    expect(pose(movement({ pitch: 1.5 }), weapon()).aim).toBeCloseTo(AIM_LIMIT, 6);
    expect(pose(movement({ pitch: -1.5 }), weapon()).aim).toBeCloseTo(-AIM_LIMIT, 6);
  });
});

// -- Blending -------------------------------------------------------------------
//
// The pose was made reproducible by dropping the animator's weight smoothing, and
// the result was visibly snappy in game. Both are had at once now, and these tests
// are why it was possible: the snap came from six *discrete switches*, not from
// blending in general — everything else in `poseLayers` was already continuous.
//
// So the fix was to make those six continuous, five of them from values already on
// the wire that a threshold was throwing away. The last test is the one that matters:
// it sweeps every axis and refuses a step, so a threshold cannot come back.

describe("a change of pose is blended, not switched", () => {
  const RUN = { x: 0, y: 0, z: -RUN_SPEED };

  it("crossfades out of the idle clip and into the gait", () => {
    const at = (gait: number) => legs(movement({ velocity: RUN, gait }));
    expect(at(0)).toEqual({ idle: 1 });
    expect(at(1)).toEqual({ runForward: 1 });
    const half = at(0.5);
    expect(half.idle).toBeCloseTo(0.5, 6);
    expect(half.runForward).toBeCloseTo(0.5, 6);
  });

  it("eases rather than ramping straight, so a transition has no corner", () => {
    const at = (gait: number) => legs(movement({ velocity: RUN, gait })).runForward ?? 0;
    // Smoothstep: a quarter of the way through is 0.156, not 0.25.
    expect(at(0.25)).toBeCloseTo(0.15625, 6);
    expect(at(0.75)).toBeCloseTo(0.84375, 6);
    expect(at(0.5)).toBeCloseTo(0.5, 6);
  });

  it("crossfades between the ground and the air", () => {
    const at = (airborne: number) => legs(movement({ velocity: RUN, gait: 1, airborne, sinceJump: 0.1 }));
    expect(at(0).jump).toBeUndefined();
    expect(at(1)).toEqual({ jump: 1 });
    expect(at(0.5).jump).toBeCloseTo(0.5, 6);
    expect(at(0.5).runForward).toBeCloseTo(0.5, 6);
  });

  it("crossfades into the sprint over the weapon's own sprint-in, and out over its sprint-out", () => {
    // Free: those are timed states, so their own phase is the ramp. Nothing about
    // sprinting needed a field of its own.
    const sprinting = (w: Partial<WeaponData>) => legs(movement({ velocity: RUN, gait: 1 }), weapon(w));
    expect(sprinting({ state: "sprintIn", span: 0.2, timer: 0.2 }).sprint).toBeUndefined();
    expect(sprinting({ state: "sprintIn", span: 0.2, timer: 0.1 }).sprint).toBeCloseTo(0.5, 6);
    expect(sprinting({ state: "sprinting" })).toEqual({ sprint: 1 });
    expect(sprinting({ state: "sprintOut", span: 0.2, timer: 0.1 }).sprint).toBeCloseTo(0.5, 6);
    expect(sprinting({ state: "sprintOut", span: 0.2, timer: 0 }).sprint).toBeUndefined();
  });

  it("crossfades into the sights by how far into them the weapon is", () => {
    // `ads` is a 0..1 ramp over the weapon's own adsInTime. `ads > 0.5` discarded a
    // real quarter-second of transition to pick one clip or the other.
    const at = (ads: number) => legs(movement(), weapon({ ads }));
    expect(at(0)).toEqual({ idle: 1 });
    expect(at(1)).toEqual({ idleAds: 1 });
    expect(at(0.5).idle).toBeCloseTo(0.5, 6);
    expect(at(0.5).idleAds).toBeCloseTo(0.5, 6);
  });

  it("keeps the weights summing to one all the way through every blend", () => {
    const total = (m: MovementState, w: WeaponData | null) => pose(m, w).legs.reduce((sum, l) => sum + l.weight, 0);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      expect(total(movement({ velocity: RUN, gait: t }), weapon())).toBeCloseTo(1, 6);
      expect(total(movement({ velocity: RUN, gait: 1, airborne: t, sinceJump: 0.1 }), weapon())).toBeCloseTo(1, 6);
      expect(total(movement({ velocity: RUN, gait: 1, landing: dip(t) }), weapon())).toBeCloseTo(1, 6);
      expect(total(movement(), weapon({ ads: t }))).toBeCloseTo(1, 6);
      expect(total(movement({ velocity: RUN, gait: 1 }), weapon({ state: "sprintIn", span: 0.2, timer: t * 0.2 }))).toBeCloseTo(1, 6);
    }
  });

  it("takes the heading a body is running at from the state, not from the velocity", () => {
    // The velocity's *direction* is discontinuous where the velocity passes through
    // zero — every stop and every change of heading — so the legs used to swap a
    // whole clip between two frames: `runForward` for `runBack` on a reversal, and
    // `runForward` for `idle` on a stop, both a full 2.0 of weight in one tick.
    // Changing speed never crosses zero, which is why walking to running was the one
    // transition that already looked right.
    //
    // So the heading is smoothed in the simulation and read from there. A state whose
    // velocity says one thing and whose `travel` pair says another is a body mid-blend,
    // and the pose follows the pair.
    // Spread *after* `movement`, whose `settled` would otherwise derive the pair from
    // the velocity — which is exactly the derivation under test.
    const mid = { ...movement({ velocity: { x: 0, y: 0, z: RUN_SPEED }, gait: 1 }), travelForward: 1, travelRight: 0 };
    expect(legs(mid, weapon())).toEqual({ runForward: 1 });

    // And its *length* is what the run clips are weighted by, so the middle of a
    // reversal — where the heading means least — is where they carry least.
    const crossing = { ...movement({ velocity: RUN, gait: 1 }), travelForward: 0, travelRight: 0 };
    expect(legs(crossing, weapon())).toEqual({ idle: 1 });
    const quarter = legs({ ...movement({ velocity: RUN, gait: 1 }), travelForward: 0.25, travelRight: 0 }, weapon());
    expect(quarter.runForward).toBeCloseTo(0.25, 6);
    expect(quarter.idle).toBeCloseTo(0.75, 6);
  });

  it("names every clip once, so a presenter holding one weight per role loses none of it", () => {
    // The T-pose flash, and the reason neither test above caught it: both add the
    // weights up, and a pose asking for one clip *twice* still adds to 1. What it
    // cannot do is reach a mixer, which has one action per clip — the second entry
    // overwrites the first (`rig/poser.ts`), and three makes the missing weight up
    // out of the rig's bind pose.
    //
    // It happened on every stop. Friction takes a player's speed to nothing in one
    // tick while `gait` has GAIT_BLEND left, so `runBlend` has no direction to blend
    // and falls back to `idle` — the clip `standing` is already playing.
    const distinct = (m: MovementState, w: WeaponData | null) => {
      const roles = pose(m, w).legs.map((l) => l.role);
      expect(new Set(roles).size, `${roles.join(", ")}`).toBe(roles.length);
    };
    const STOPPED = { x: 0, y: 0, z: 0 };
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      // Stopped dead with the gait blend still running: the case that broke.
      distinct(movement({ velocity: STOPPED, gait: t }), weapon());
      distinct(movement({ velocity: STOPPED, gait: t }), weapon({ ads: 1 }));
      // And in the air over it, and landing out of it, where the same fallback sits
      // underneath another blend.
      distinct(movement({ velocity: STOPPED, gait: t, airborne: t, sinceJump: 0.1 }), weapon());
      distinct(movement({ velocity: STOPPED, gait: t, landing: dip(t) }), weapon());
      distinct(movement({ velocity: STOPPED, gait: t }), weapon({ state: "sprintOut", span: 0.2, timer: t * 0.2 }));
    }
  });

  it("has no step anywhere along any axis, which is what stops a threshold coming back", () => {
    // The test that encodes the discovery. Before this work, six switches moved 1.0 to
    // 4.0 of weight for an infinitesimal change of state — a whole clip swapped in one
    // tick. Sweeping each axis finely and bounding the step per sample refuses that
    // shape outright, whatever it is keyed on.
    const sweep = (name: string, build: (t: number) => { m: MovementState; w: WeaponData }) => {
      const weights = (t: number) => {
        const { m, w } = build(t);
        const out = new Map<string, number>();
        const layers = pose(m, w);
        for (const l of layers.legs) {
          out.set(`legs:${l.role}`, (out.get(`legs:${l.role}`) ?? 0) + l.weight);
        }
        for (const l of layers.torso) {
          out.set(`torso:${l.role}`, (out.get(`torso:${l.role}`) ?? 0) + l.weight);
        }
        return out;
      };
      const steps = 400;
      let worst = 0;
      for (let i = 0; i < steps; i++) {
        const a = weights(i / steps);
        const b = weights((i + 1) / steps);
        let moved = 0;
        for (const k of new Set([...a.keys(), ...b.keys()])) {
          moved += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
        }
        worst = Math.max(worst, moved);
      }
      // A smooth traverse over 400 samples moves ~2/400 of weight per step. A switch
      // moves 1 or more. An order of magnitude between them is plenty of room.
      expect(worst, `${name} moved ${worst.toFixed(3)} of weight in one step`).toBeLessThan(0.05);
    };

    sweep("gait", (t) => ({ m: movement({ velocity: RUN, gait: t }), w: weapon() }));
    // The two that crossed zero, and so were a whole clip swapped in one frame until
    // `travelForward`/`travelRight` were smoothed in the state. Swept over the pair
    // itself rather than over the velocity, because the pair is what the pose reads
    // and the simulation is what walks it: stopping takes it one unit to the origin,
    // reversing takes it two, straight through.
    sweep("stopping", (t) => ({ m: { ...movement({ velocity: RUN, gait: 1 }), travelForward: 1 - t, travelRight: 0 }, w: weapon() }));
    sweep("reversing", (t) => ({ m: { ...movement({ velocity: RUN, gait: 1 }), travelForward: 1 - 2 * t, travelRight: 0 }, w: weapon() }));
    sweep("turning at speed", (t) => ({
      m: { ...movement({ velocity: RUN, gait: 1 }), travelForward: Math.cos(t * 2 * Math.PI), travelRight: Math.sin(t * 2 * Math.PI) },
      w: weapon(),
    }));
    sweep("airborne", (t) => ({ m: movement({ velocity: RUN, gait: 1, airborne: t, sinceJump: 0.1 }), w: weapon() }));
    sweep("landing", (t) => ({ m: movement({ velocity: RUN, gait: 1, landing: dip(t) }), w: weapon() }));
    sweep("ads", (t) => ({ m: movement(), w: weapon({ ads: t }) }));
    sweep("ads while firing", (t) => ({ m: movement(), w: weapon({ state: "firing", span: 0.1, timer: 0.05, ads: t }) }));
    sweep("sprint in", (t) => ({ m: movement({ velocity: RUN, gait: 1 }), w: weapon({ state: "sprintIn", span: 0.2, timer: (1 - t) * 0.2 }) }));
    sweep("a reload, start to finish", (t) => ({ m: movement(), w: weapon({ state: "reloading", span: 2, timer: (1 - t) * 2 }) }));
    sweep("turning while running", (t) => {
      const yaw = t * Math.PI * 2;
      return { m: movement({ yaw, velocity: { x: -Math.sin(yaw) * RUN_SPEED, y: 0, z: -Math.cos(yaw) * RUN_SPEED }, gait: 1 }), w: weapon() };
    });
    // Every way between two stances, at rest and on the move, with a clip of its own and without.
    for (const path of ["standToCrouch", "crouchToStand", "crouchToProne", "proneToCrouch"] as const) {
      const shift = (t: number) => ({ path, elapsed: t * eyePathSeconds(path) });
      sweep(path, (t) => ({ m: movement({ eyeShift: shift(t) }), w: weapon() }));
      sweep(`${path}, moving and firing`, (t) => ({
        m: movement({ velocity: RUN, gait: 1, stride: 0.3, eyeShift: shift(t) }),
        w: weapon({ state: "firing", span: 0.1, timer: 0.05, ads: 0.5 }),
      }));
    }
  });
});

describe("a stance is posed from its own clips", () => {
  const lying = { kind: "prone", heading: 0.4, torso: 0.2 } as const;
  const crouched = { kind: "crouch" } as const;
  const roles = (m: MovementState, w: WeaponData | null = weapon(), set: RoleSet = EVERY): string[] => pose(m, w, set).legs.map((l) => l.role);
  const without = (...missing: CharacterRole[]): RoleSet => new Set(CHARACTER_ROLES.filter((r) => !missing.includes(r)));

  it("rests in the stance's idle, and its aiming one by how far into the sights the weapon is", () => {
    expect(legs(movement({ stance: crouched }))).toEqual({ crouchIdle: 1 });
    expect(legs(movement({ stance: lying }))).toEqual({ proneIdle: 1 });
    expect(legs(movement({ stance: crouched }), weapon({ ads: 1 }))).toEqual({ crouchIdleAds: 1 });
    expect(legs(movement({ stance: lying }), weapon({ ads: 1 }))).toEqual({ proneIdleAds: 1 });
  });

  it("walks crouched and crawls by the direction of travel, on the stride clock", () => {
    const forward = pose(movement({ stance: crouched, velocity: { x: 0, y: 0, z: -3 }, gait: 1, stride: 0.6 }), weapon());
    expect(forward.legs).toEqual([{ role: "crouchForward", weight: 1, phase: 0.6 }]);
    const left = pose(movement({ stance: lying, velocity: { x: -0.7, y: 0, z: 0 }, gait: 1, stride: 0.25 }), weapon());
    expect(left.legs).toEqual([{ role: "proneLeft", weight: 1, phase: 0.25 }]);
    // A crouch does not sprint, whatever the weapon is doing.
    expect(roles(running({ stance: crouched }), weapon({ state: "sprinting" }))).toEqual(["crouchForward"]);
  });

  it("crossfades the two stances along the eye's path, under the path's own clip", () => {
    const half = movement({ stance: crouched, eyeShift: { path: "standToCrouch", elapsed: eyePathSeconds("standToCrouch") / 2 } });
    // Mid-way the clip has all of it; without one the two stances share it.
    expect(legs(half)).toEqual({ standToCrouch: 1 });
    expect(legs(half, weapon(), without("standToCrouch"))).toEqual({ idle: 0.5, crouchIdle: 0.5 });
    const early = movement({ stance: crouched, eyeShift: { path: "standToCrouch", elapsed: eyePathSeconds("standToCrouch") / 16 } });
    const shares = legs(early);
    expect(shares.standToCrouch).toBeGreaterThan(0);
    expect(shares.idle).toBeGreaterThan(shares.crouchIdle!);
    expect(pose(half, weapon()).legs[0]!.phase).toBeCloseTo(0.5, 6);
  });

  it("names only roles the set has, so nothing is made up out of the bind pose", () => {
    const states = [
      movement({ stance: crouched }),
      movement({ stance: lying, velocity: { x: 0.5, y: 0, z: 0.5 }, gait: 0.7, stride: 0.2 }),
      movement({ stance: lying, eyeShift: { path: "crouchToProne", elapsed: 0.15 } }),
      movement({ stance: crouched, airborne: 0.6, eyeShift: { path: "proneToCrouch", elapsed: 0.3 } }),
    ];
    const firing = weapon({ state: "firing", span: 0.1, timer: 0.05, ads: 0.4 });
    const sets = [
      EVERY,
      STANDING_ONLY,
      without("proneIdleAds", "proneFireAds", "standToCrouch", "crouchToStand"),
      without("proneIdle"),
      without("crouchLeft", "idleAds"),
    ];
    for (const set of sets) {
      for (const m of states) {
        for (const w of [weapon({ ads: 0.5 }), firing, weapon({ state: "reloading", span: 2, timer: 1 })]) {
          const layers = pose(m, w, set);
          for (const layer of [...layers.legs, ...layers.torso]) {
            expect(set.has(layer.role), `${layer.role} is not in the set`).toBe(true);
          }
          expect(layers.legs.reduce((sum, l) => sum + l.weight, 0)).toBeCloseTo(1, 9);
        }
      }
    }
  });

  it("stands a set that has no stance clips, exactly as it stood before it had a stance", () => {
    const m = movement({ velocity: { x: 1, y: 0, z: -2 }, gait: 0.8, stride: 0.4 });
    const firing = weapon({ state: "firing", span: 0.1, timer: 0.05, ads: 0.4 });
    const standing = pose(m, firing, STANDING_ONLY);
    for (const stance of [crouched, lying]) {
      const low = pose({ ...m, stance }, firing, STANDING_ONLY);
      expect(low.legs).toEqual(standing.legs);
      expect(low.torso).toEqual(standing.torso);
    }
  });

  it("falls back from an aiming clip to its hip one, and from a crouched overlay to the standing one", () => {
    const aimed = weapon({ state: "firing", span: 0.1, timer: 0.05, ads: 1 });
    const torso = (m: MovementState, set: RoleSet): string[] => pose(m, aimed, set).torso.map((l) => l.role);
    expect(torso(movement({ stance: lying }), EVERY)).toEqual(["proneFireAds"]);
    expect(torso(movement({ stance: lying }), without("proneFireAds"))).toEqual(["proneFire"]);
    expect(torso(movement({ stance: crouched }), without("crouchFireAds", "crouchFire"))).toEqual(["fireAds"]);
    // A lying body wears no other stance's overlay.
    expect(torso(movement({ stance: lying }), without("proneFireAds", "proneFire"))).toEqual([]);
    expect(legs(movement({ stance: lying }), weapon({ ads: 1 }), without("proneIdleAds"))).toEqual({ proneIdle: 1 });
  });

  it("lies along the body's heading and tips with its torso, and aims from there", () => {
    const m = movement({ stance: lying, yaw: 1.1, pitch: 0.5 });
    expect(bodyYaw(m)).toBe(0.4);
    expect(bodyPitch(m)).toBe(0.2);
    expect(pose(m, weapon()).aim).toBeCloseTo(0.3, 9);
    // The tip is taken up as the body goes down, and a standing body has none.
    expect(bodyPitch({ ...m, eyeShift: { path: "crouchToProne", elapsed: 0 } })).toBe(0);
    expect(bodyPitch(movement({ pitch: 0.5 }))).toBe(0);
  });
});
