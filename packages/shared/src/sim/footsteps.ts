// The noise a body makes by moving: footsteps and landings, derived rather than
// sent.
//
// **A footstep is the stride clock crossing a footfall.** Nothing new goes on the
// wire for it — `stride` is already `MovementState`, already in every snapshot,
// and already what the legs are drawn from — so a client works out that a step
// happened exactly the way a server would, and the sound lands on the footfall
// the legs are playing. Its rate already scales with speed, so running is faster
// than walking without a per-gait interval anywhere.
// docs/engine/audio.md#diegetic-sound-costs-no-wire.
//
// Here rather than in the client because it is a function of simulation state and
// nothing else: a server judging a sound, a replay, and the browser all have to
// reach the same answer. What the client owns is *playing* it
// (client/engine/audio/footsteps.ts) — this module names no alias table, touches
// no audio and knows nothing about distance.

import type { CapsuleWorld, Vec3 } from "./capsule.js";
import { shortestPhase, TELEPORT_DISTANCE } from "./interpolate.js";
import { horizontalSpeed, RUN_SPEED, WALK_SPEED, type MovementState } from "./movement.js";
import { DEFAULT_SURFACE, type SurfaceType } from "./surfaces.js";

/**
 * How many times a foot meets the ground in one turn of the stride clock, and
 * where the first of them is.
 *
 * **Measured off the clips, not guessed.** `stride` is a phase into the run
 * loop (`sim/pose.ts` hands it to every locomotion clip as a fraction of that
 * clip's own duration), and a CoD run loop is *three* double-steps long — so
 * one cycle is six footfalls and not two, which is what 0 and ½ would have
 * given. Taken by posing `worlds/catalog/animations/<game>/autorifle` and
 * finding where each ball joint settles:
 *
 *   iw5 combatrun forward  .129 .283 .463 .621 .796 .958
 *   iw5 combatrun left     .113 .271 .442 .600 .792 .942
 *   iw5 combatrun right    .142 .300 .471 .642 .808 .971
 *   iw5 sprint             .129 .292 .475 .617 .858 .975
 *   iw6 hold_run           .129 .300 .454 .629 .783 .963
 *
 * Six, evenly spaced, the first an eighth of a cycle in, across two games and
 * both gaits — so they are one offset and a count rather than a table. The worst
 * clip disagrees with the even spacing by 0.02 of a cycle, which is 6 ms at a
 * sprint. **This is the one number here that wants ears**: an analyser can say
 * how many steps a second there are and cannot say whether they land on the
 * beat.
 */
export const FOOTFALLS_PER_CYCLE = 6;
export const FIRST_FOOTFALL = 0.128;

/** The stride phase the `index`th footfall of a cycle lands on. */
export function footfallPhase(index: number): number {
  return (FIRST_FOOTFALL + index / FOOTFALLS_PER_CYCLE) % 1;
}

/**
 * Which footfalls the stride clock crossed going from `from` to `to`, in order.
 *
 * Half-open at `from` and closed at `to`, so a phase landing exactly on a
 * footfall sounds once and not on the next observation too. Every crossing in the
 * interval, not the first: a slow frame covers several ticks, and a step nobody
 * heard is worse than one that is a frame late. Backwards is silence — the clock
 * only runs backwards where something reset it (`advanceStride` zeroes it on a
 * climb), and a reset is not a step.
 */
export function footfallsCrossed(from: number, to: number): number[] {
  // Never more than half a cycle in one observation in practice: the clock gains
  // at most `STRIDE_RATE_RANGE[1] / STRIDE_PERIOD` a second, so a 50 ms frame —
  // the longest the viewer allows — moves it 0.044.
  const advance = shortestPhase(from, to);
  const out: number[] = [];
  if (advance <= 0) {
    return out;
  }
  for (let index = 0; index < FOOTFALLS_PER_CYCLE; index++) {
    const ahead = (footfallPhase(index) - from + 1) % 1;
    if (ahead > 0 && ahead <= advance) {
      out.push(index);
    }
  }
  // In the order they were crossed rather than by index, so a step's ordinal and
  // the sound's own order agree across a wrap past 1.
  out.sort((a, b) => ((footfallPhase(a) - from + 1) % 1) - ((footfallPhase(b) - from + 1) % 1));
  return out;
}

/**
 * The gaits the sound bank has, which are the game's own and not this engine's:
 * `walk`, `run`, `sprint`, `prone` and `scrape`. **There is no `crouch` family.**
 *
 * `prone` and `scrape` are unreachable today — the simulation has no stance below
 * standing and no slide — and are named because the bank names them, so the first
 * one to be built has somewhere to go rather than inventing an alias.
 */
export type Gait = "walk" | "run" | "sprint" | "prone" | "scrape";

/**
 * Where the sim's two target speeds sit on the bank's five gaits.
 *
 * The simulation has exactly two: `WALK_SPEED` (3.2 m/s) with nothing held, which
 * is the *combat run* the legs play, and `RUN_SPEED` (5.8) with the run key, which
 * is the sprint clip. So 3.2 is the bank's `run` and 5.8 is its `sprint`, and
 * `walk` is what is left underneath — a landing's slowdown, a strafe into a wall,
 * the first ticks off a standstill.
 *
 * The thresholds are between the plateaus rather than on them, which is the whole
 * reason they are not `WALK_SPEED` and `RUN_SPEED` themselves: `accelerate` stops
 * exactly *at* the target, so a threshold there is decided by the last bit of a
 * float and a player at a steady jog would flicker between two families of alias.
 */
const RUN_GAIT_SPEED = 0.75 * WALK_SPEED;
const SPRINT_GAIT_SPEED = (WALK_SPEED + RUN_SPEED) / 2;

export function gaitFor(speed: number): Gait {
  if (speed >= SPRINT_GAIT_SPEED) {
    return "sprint";
  }
  return speed >= RUN_GAIT_SPEED ? "run" : "walk";
}

/**
 * How fast the feet must have been falling for meeting the ground to be a
 * landing, m/s.
 *
 * `MovementState.landing` is **not** the test, though it is the obvious one: it
 * is only set by `integrate` when `jumped` is true, so it misses every fall that
 * began by walking off something. The transition is `grounded`, and this is what
 * keeps a flicker of it — which happens over imported triangle soup, and is what
 * `coyote` exists for — from being a thud. A jump lands at 5.5 m/s and a kerb
 * `stepDown` catches never leaves the ground at all.
 */
const LANDING_FALL_SPEED = 2;

/**
 * Where the surface probe starts relative to the feet, and how far down it looks.
 *
 * Started *above* the feet because the resolver leaves them a millimetre clear of
 * what they stand on and an interpolated peer's can be a centimetre inside it — a
 * ray cast from inside a triangle finds nothing, and the surface would come back
 * `null` on exactly the frames it is asked for.
 */
const PROBE_UP = 0.05;
const PROBE_DOWN = 0.5;

/** One thing a body did that is worth hearing. */
export interface Footfall {
  kind: "step" | "land";
  /** Which footfall of the cycle this was, 0..FOOTFALLS_PER_CYCLE-1; -1 for a landing. */
  index: number;
  /** Which family of alias it is spelled from. A landing has no gait of its own and reports the one it landed in. */
  gait: Gait;
  /** What was under the foot at the instant it landed — `default` where the world says nothing. */
  surface: SurfaceType;
  /** The feet, world metres: where a body's noise comes from. */
  at: Vec3;
}

/** `step_run_plr_metal`, or `step_run_metal` for somebody else's boots. */
export function stepAlias(gait: Gait, surface: SurfaceType, own: boolean): string {
  return own ? `step_${gait}_plr_${surface}` : `step_${gait}_${surface}`;
}

/** `land_plr_dirt`, or `land_dirt`. Positional either way — a landing is the loudest thing a body does. */
export function landAlias(surface: SurfaceType, own: boolean): string {
  return own ? `land_plr_${surface}` : `land_${surface}`;
}

/** The alias one footfall is spelled with: concatenation, because the surface names are the game's own. */
export function footfallAlias(footfall: Footfall, own: boolean): string {
  return footfall.kind === "land" ? landAlias(footfall.surface, own) : stepAlias(footfall.gait, footfall.surface, own);
}

/** Mixed into the seed so one step's draws are not the next one's. Arbitrary odd constants, as `shotStream`'s are. */
const STEP_STREAM = 0x27d4eb2f;
const FOOTFALL_STREAM = 0x165667b1;

/**
 * The stream one footfall's clip, volume and pitch are drawn from: the body's own
 * seed, mixed with which step it is and where in the cycle it fell.
 *
 * The shape `shotStream` already has, and for the same reason — `sim/` is handed a
 * number rather than a player id, because it knows nothing about ids and may not
 * reach `game/random.ts` to hash one. `+ 1` and `+ 2` so neither term can be zero
 * and leave the bare seed.
 */
export function stepStream(seed: number, ordinal: number, index: number): number {
  return (seed ^ Math.imul(ordinal + 1, STEP_STREAM) ^ Math.imul(index + 2, FOOTFALL_STREAM)) | 0;
}

/** Where the probe is written. Read immediately by `surfaceAt`, so one is enough for every player. */
const probe: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * One body's footsteps, watched across the states it passes through.
 *
 * Holds the last state it saw and nothing else, so it is an *observer* of the
 * simulation rather than part of it — which is why none of this is in
 * `MovementState` and nothing here is on the wire. One per player: the local
 * player's own, stepped every frame off the predicted state, and one per peer,
 * stepped every snapshot off the state the server sent.
 */
export class FootstepWatcher {
  private stride = 0;
  private grounded = true;
  private started = false;
  /** The fastest this body has been falling since it left the ground, m/s (negative). */
  private fall = 0;
  private readonly feet: Vec3 = { x: 0, y: 0, z: 0 };

  /** Forget what was seen: a respawn, a hand-over to a corpse, a world change. */
  reset(): void {
    this.started = false;
    this.fall = 0;
  }

  /**
   * What `movement` says has happened since the last state this watcher saw.
   *
   * The grounded check is mandatory and is the reason this is not simply a phase
   * comparison: `advanceStride` deliberately keeps the clock running in the air,
   * so that a player who hops mid-sprint lands back into the stride they left —
   * and without the check they would tread it.
   */
  observe(movement: Readonly<MovementState>, world: CapsuleWorld): Footfall[] {
    const out: Footfall[] = [];
    const grounded = movement.grounded;
    // On rails: the legs are playing a mantle or a ladder and `advanceStride` has
    // zeroed the clock, so any apparent advance across the reset is bookkeeping.
    const climbing = movement.mantle !== null || movement.ladder !== null;
    // A respawn or a teleport moves the feet across the map between two states.
    // The clock carries on regardless, so without this the first observation after
    // one plays a step from wherever the body used to be.
    const placed = !this.started || Math.abs(movement.feet.x - this.feet.x) > TELEPORT_DISTANCE || Math.abs(movement.feet.z - this.feet.z) > TELEPORT_DISTANCE;

    if (!grounded) {
      this.fall = Math.min(this.fall, movement.velocity.y);
    }

    if (!placed && !climbing) {
      const landed = grounded && !this.grounded && -this.fall >= LANDING_FALL_SPEED;
      const gait = gaitFor(horizontalSpeed(movement));
      if (landed) {
        out.push(this.footfall("land", -1, gait, movement.feet, world));
      } else if (grounded) {
        for (const index of footfallsCrossed(this.stride, movement.stride)) {
          out.push(this.footfall("step", index, gait, movement.feet, world));
        }
      }
    }

    this.started = true;
    // **The clock is not carried backwards.** `stride` travels as `unit` — 8 bits
    // of a cycle — and a correction restores the server's rounded phase and
    // replays from it, so a predicted one is snapped back by up to half a step on
    // every snapshot. Carried back with it, the footfall that snap crossed was
    // crossed again on the way forward and trod twice: measured at fifteen extra
    // steps a minute at a jog. `footfallsCrossed` is already silent going
    // backwards, so holding the clock is the whole of the fix — and a reset, which
    // is the only way it legitimately runs backwards, is `placed` or `climbing`
    // above and takes the new value.
    if (placed || climbing || shortestPhase(this.stride, movement.stride) > 0) {
      this.stride = movement.stride;
    }
    this.grounded = grounded;
    this.feet.x = movement.feet.x;
    this.feet.y = movement.feet.y;
    this.feet.z = movement.feet.z;
    if (grounded) {
      this.fall = 0;
    }
    return out;
  }

  private footfall(kind: "step" | "land", index: number, gait: Gait, feet: Vec3, world: CapsuleWorld): Footfall {
    probe.x = feet.x;
    probe.y = feet.y + PROBE_UP;
    probe.z = feet.z;
    // `default` and not silence for a probe that finds nothing: a hand-written
    // world and a map exported before surfaces existed both answer `default`, and
    // a body standing on something the ray missed is still making a noise.
    const surface = world.surfaceAt(probe, PROBE_UP + PROBE_DOWN) ?? DEFAULT_SURFACE;
    return { kind, index, gait, surface, at: { x: feet.x, y: feet.y, z: feet.z } };
  }
}
