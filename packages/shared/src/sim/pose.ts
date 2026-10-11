// Which clips a body is playing, and how much of each — decided once, for both
// ends.
//
// This used to live inside `client/src/engine/characterAnimator.ts`, mixed in with
// the three.js `AnimationMixer` that draws the result. That was fine while a pose
// was only ever looked at. It stopped being fine when a bullet had to be traced
// against one: the server has to know where a peer's head actually was, and a
// decision made separately on each end is a hit box somewhere other than the body
// on screen.
//
// So the *decision* is here and the *drawing* stays there. `poseLayers` is a pure
// function of a `PlayerState` — no clock, no previous frame, nothing of its own —
// and the animator became a presenter of what it returns.
//
// **Everything it needs is already on the wire.** That is not luck; it is what the
// three fields added for it are for. The animator kept four things this could not
// have derived, and each has an equivalent in the state now:
//
//   its own `grounded`     -> `state.grounded`, and `sinceJump` for the jump's phase
//   its own `landing`      -> `state.landing`, the simulation's own recovery timer
//   a free-running cycle   -> `state.stride`, stepped in `stepMovement`
//   blend weights          -> dropped; see `poseLayers`
//
// Phases are fractions of a clip's own duration, never seconds, because `sim/` does
// not know how long anything is. The caller multiplies by the duration it holds —
// which is the same number on both ends, since both read it from the catalogue.

import { AIM_LIMIT, RUN_DIRECTIONS, type CharacterRole } from "./characterDef.js";
import { mantleDuration } from "./moves/mantle.js";
import { LAND_WINDOW, type MovementState } from "./movement.js";
import { UNIT } from "./units.js";
import type { WeaponData } from "./weapon.js";

/**
 * Seconds of a landing the body dips for, from the start of LAND_WINDOW. A
 * landing that starts further into its window than this shows none.
 */
export const LAND_DIP = 0.5;

/** How far the feet climb in one loop of the ladder clips (IW5's own rise and drop). */
const CLIMB_UP_RISE = 37.1 * UNIT;
const CLIMB_DOWN_DROP = 39.9 * UNIT;

/** One clip, how much of it, and where in it. */
export interface PoseLayer {
  role: CharacterRole;
  /** 0 to 1. Layers in `legs` sum to 1. */
  weight: number;
  /** Where in the clip, as a fraction of its own duration. Always in [0, 1). */
  phase: number;
}

/**
 * What a body is doing, as clips and angles rather than as bones.
 *
 * Turning this into bone transforms needs the clips themselves, which is the
 * caller's half: `characterAnimator.ts` hands it to a mixer, and a server samples
 * the same curves directly.
 */
export interface PoseLayers {
  /**
   * The leg clips, in no particular order, **one entry per clip**: they sum to 1, and
   * a presenter can hold one weight per role. See `fold`.
   */
  legs: PoseLayer[];
  /**
   * The overlay on the arms and chest — firing, reloading. Empty for neither.
   *
   * A list rather than one layer, because hip-fire and aimed fire are two clips
   * blended by how far into the sights the weapon is.
   */
  torso: PoseLayer[];
  /** Which way the body faces, radians. Not the view: a ladder turns the body to face it. */
  yaw: number;
  /** How far the aim joint turns, radians, already clamped to what a spine can do. */
  aim: number;
}

/** Which way a body faces: the view, except on a ladder, where it faces the ladder (IW5's `PM_LadderMove`). */
export function bodyYaw(state: Pick<MovementState, "yaw" | "move">): number {
  return state.move.kind === "ladder" ? state.move.facing + Math.PI : state.yaw;
}

/**
 * The clips a body is posed from.
 *
 * Takes the movement and the weapon rather than a whole `PlayerState`, because
 * those are exactly what a pose depends on — and because a client draws a peer
 * from an *interpolated* movement beside the newest weapon, which is not any one
 * `PlayerState` that ever existed.
 *
 * **Transitions are blended, and every weight is still a pure function.**
 *
 * The animator used to walk its weights towards a target over 0.18 s, which made a
 * pose depend on every frame before it; dropping that made the pose reproducible and
 * the game visibly snappy. Both are now had at once, because the snap turned out to
 * come from six *discrete switches* rather than from blending in general — the rest
 * of this function was already continuous, turning and striding included.
 *
 * Five of the six needed nothing new. Each was a threshold throwing away a
 * continuous value already on the wire:
 *
 *   hip <-> sights      `weapon.ads` is a 0..1 ramp over the weapon's own adsInTime,
 *                       and `ads > 0.5` discarded it to pick one of two clips
 *   run <-> sprint      `sprintIn`/`sprintOut` are timed states, so `statePhase` ramps
 *   torso on/off        the same, over the first and last of the state
 *
 * The sixth, standing <-> moving, could not be derived: a player crosses
 * `IDLE_SPEED` in a single tick, so a speed-keyed crossfade lasts 17 ms. That one is
 * `MovementState.gait`, a smoothed boolean stepped in `stepMovement`, with
 * `airborne` beside it for the same reason. Two bytes, and the pose stays exact on
 * both ends.
 */
export function poseLayers(movement: MovementState, weapon: WeaponData | null): PoseLayers {
  return {
    legs: fold(legLayers(movement, weapon)),
    torso: torsoLayers(weapon),
    yaw: bodyYaw(movement),
    aim: Math.max(-AIM_LIMIT, Math.min(AIM_LIMIT, movement.pitch)),
  };
}

/**
 * Eased, so a transition has no visible corner at either end.
 *
 * The ramps themselves are stepped linearly (`advanceBlends`) and shaped here, so the
 * shaping is one decision in one place rather than baked into what travels.
 */
/**
 * The share of a torso overlay's own state spent fading it in and out, each end.
 *
 * A fraction rather than a duration, so a 0.1 s shot and a 2 s reload each get a
 * transition in proportion to themselves — a fixed 0.08 s would be most of the shot.
 */
const TORSO_FADE = 0.08;

function ease(t: number): number {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
}

/**
 * Fold layers naming the same clip into one.
 *
 * Two reasons to play a clip are still one clip on one action, and a presenter holds
 * one weight per role (`rig/poser.ts`), so a list naming one twice loses whichever
 * entry is written first. That is not hypothetical — it happened on **every stop**:
 * friction takes a player's speed to nothing in a single tick while `gait` still has
 * `GAIT_BLEND` to run, and in that window `runBlend` has no direction left to blend
 * and falls back to `idle`, which is the very clip `standing` is playing. The pose
 * asked for `idle` at `1 - moving` and again at `moving`, the legs kept one of the
 * two, and three made the missing weight up out of the rig's *bind* pose — so a body
 * flashed its T-pose for a tenth of a second every time it stopped walking. At the
 * worst frame the legs held 0.02 of a bone and the bind pose held 0.98.
 *
 * The phase comes from the heaviest contributor, since one action can only be in one
 * place. Here both entries are an idle at phase 0, so it does not arise — but a pose
 * that cannot say which phase it wants has a bug in it, and taking the heaviest
 * degrades rather than jumps.
 */
function fold(layers: PoseLayer[]): PoseLayer[] {
  const out: PoseLayer[] = [];
  for (const layer of layers) {
    const found = out.find((l) => l.role === layer.role);
    if (!found) {
      out.push({ ...layer });
    } else {
      if (layer.weight > found.weight) {
        found.phase = layer.phase;
      }
      found.weight += layer.weight;
    }
  }
  return out;
}

/** Scale a set of layers, dropping the ones that would contribute nothing. */
function weigh(layers: readonly PoseLayer[], by: number): PoseLayer[] {
  return by <= 0 ? [] : layers.map((l) => ({ ...l, weight: l.weight * by })).filter((l) => l.weight > 0);
}

function legLayers(movement: MovementState, weapon: WeaponData | null): PoseLayer[] {
  // A climb first, and to the exclusion of everything else: the player is on rails
  // for its duration, so none of the ground or air states apply.
  const move = movement.move;
  if (move.kind === "mantle") {
    const duration = mantleDuration(move.rise);
    // Scrubbed by how far through the climb they are rather than played at its own
    // speed, so the body arrives at the top exactly when the capsule does however
    // long the climb takes. Also means a peer whose first snapshot lands mid-climb
    // starts in the right pose instead of at the beginning.
    const done = duration > 0 ? clamp01((duration - move.left) / duration) : 1;
    return [{ role: move.over ? "mantleOver" : "mantle", weight: 1, phase: done }];
  }

  // On a ladder, likewise. Posed from the feet's height rather than a clock, so a
  // still climber holds a pose and a fast one moves through it faster — the same
  // bargain, against the game's own CLIMBUP and CLIMBDOWN rises.
  if (move.kind === "ladder") {
    const up = movement.velocity.y >= 0;
    const loop = movement.feet.y / (up ? CLIMB_UP_RISE : CLIMB_DOWN_DROP);
    const phase = loop - Math.floor(loop);
    // Going down, the clip plays forwards as the feet fall.
    return [{ role: up ? "climbUp" : "climbDown", weight: 1, phase: up ? phase : 1 - phase }];
  }

  // Off the ground and on it, blended rather than switched: `airborne` is a smoothed
  // `grounded`, so walking off a ledge and landing both crossfade. `sinceJump` stops
  // counting at JUMP_REPEAT, which is longer than the clip, so a long fall holds the
  // jump's last frame — which is what a clip that plays once does anyway.
  const air = ease(movement.airborne);
  const layers = weigh([{ role: "jump", weight: 1, phase: clamp01(movement.sinceJump) }], air);
  return [...layers, ...weigh(groundLayers(movement, weapon), 1 - air)];
}

/** What the legs do while there is ground under them. Sums to 1. */
function groundLayers(movement: MovementState, weapon: WeaponData | null): PoseLayer[] {
  const moving = ease(movement.gait);
  const out = [...weigh(standing(weapon), 1 - moving), ...weigh(gait(movement, weapon), moving)];

  // The landing is an overlay over whatever is underneath: a player who lands
  // mid-sprint keeps running, with a dip in it. Timed by the simulation's own
  // landing rather than the clip's length, because that timer is in the state:
  // the dip is the first LAND_DIP of it.
  const share = ease(clamp01((movement.landing - (LAND_WINDOW - LAND_DIP)) / LAND_DIP));
  if (share <= 0) {
    return out;
  }
  return [...weigh(out, 1 - share), { role: "land", weight: share, phase: 1 - share }];
}

/**
 * Standing still: the idle clip, or the aiming one, blended by how far into the
 * sights the weapon is.
 *
 * `weapon.ads` is a 0..1 ramp over the weapon's own `adsInTime` — a real quarter of
 * a second of transition that a `> 0.5` threshold was throwing away to pick one clip
 * or the other.
 */
function standing(weapon: WeaponData | null): PoseLayer[] {
  const aim = ease(weapon?.ads ?? 0);
  const layers: PoseLayer[] = [
    { role: "idle", weight: 1 - aim, phase: 0 },
    { role: "idleAds", weight: aim, phase: 0 },
  ];
  return layers.filter((l) => l.weight > 0);
}

/**
 * Moving: the sprint clip and the four-way run blend, both placed by the stride
 * clock and blended into each other.
 *
 * The sprint's share comes from the weapon's own timed states — `sprintIn` ramps it
 * up and `sprintOut` ramps it down, which is exactly as long as the weapon takes to
 * come down and go back up. Nothing new on the wire for it.
 */
function gait(movement: MovementState, weapon: WeaponData | null): PoseLayer[] {
  const sprint = ease(sprintShare(weapon));
  const out = weigh([{ role: "sprint", weight: 1, phase: movement.stride }], sprint);
  return [...out, ...weigh(runBlend(movement), 1 - sprint)];
}

/** How much of the sprint clip is showing, from the weapon's own sprint states. */
function sprintShare(weapon: WeaponData | null): number {
  switch (weapon?.state) {
    case "sprinting":
      return 1;
    case "sprintIn":
      return statePhase(weapon);
    case "sprintOut":
      return 1 - statePhase(weapon);
    default:
      return 0;
  }
}

/**
 * The four-way run blend. Sums to 1.
 *
 * **Read off `travelForward`/`travelRight`, not off the velocity.** Those are the
 * same direction, smoothed in the state — and the smoothing is the whole point: a
 * vector's direction is discontinuous where the vector passes through zero, which is
 * every stop and every change of heading. Taken from the velocity, reversing out of
 * a run swapped `runForward` for `runBack` between two frames and stopping swapped
 * it for `idle`, both a full 2.0 of weight moved in a single tick.
 *
 * The pair walks towards the origin and out the other side, so its *length* falls to
 * nothing through a reversal, and that length is what the run clips are weighted by
 * here: the direction is at its most meaningless exactly where the legs stop
 * listening to it. Whatever is left over is the standing clip, which is what a body
 * settling out of a run is on its way to anyway (`fold` merges it with the one
 * `standing` is playing).
 */
function runBlend(movement: MovementState): PoseLayer[] {
  const forward = movement.travelForward;
  const right = movement.travelRight;

  // Each clip takes the share of the direction it points along, so the two that
  // bracket it hold all the weight and the two behind it hold none. One stride
  // clock for all four: they are 1.1 to 1.9 s long, and playing each at its own
  // rate would let a strafe's feet slide against a run's.
  const shares: [CharacterRole, number][] = [];
  let total = 0;
  for (const [role, dr, df] of RUN_DIRECTIONS) {
    const share = Math.max(0, right * dr + forward * df);
    if (share > 0) {
      shares.push([role, share]);
      total += share;
    }
  }
  // A settled direction is a unit vector, whose two positive components always add
  // to at least 1 — so this is 1 for anyone actually running, and under it only
  // while the pair is crossing the middle.
  const running = Math.min(1, total);
  const layers: PoseLayer[] = shares.map(([role, share]) => ({ role, weight: (share / total) * running, phase: movement.stride }));
  if (running < 1) {
    layers.push({ role: "idle", weight: 1 - running, phase: 0 });
  }
  return layers;
}

/**
 * The arms-and-chest overlay: firing or reloading.
 *
 * Phased by the weapon's own state timer, which is on the wire — so a peer caught
 * mid-reload is drawn mid-reload rather than starting one. `rate` carries how much
 * faster or slower the weapon's own clip is running than its nominal length, which
 * is what stretched a reload to fit `reloadTime` before.
 *
 * **A torso layer replaces the bones it keys; it does not add to them.** A `pt_`
 * clip is a whole pose of the spine and above — a reload is an arm position, not
 * an offset from one — so a body reloading mid-run takes its upper half from the
 * reload clip and its legs from the run. `weight` is that replacement's share,
 * which `rig/poser.ts` turns into a mixer weight; see the note there.
 */
function torsoLayers(weapon: WeaponData | null): PoseLayer[] {
  if (!weapon) {
    return [];
  }
  const phase = statePhase(weapon);
  // In over the first of the state and out over the last, so an overlay arrives and
  // leaves rather than appearing. From the state's own phase, so it is as long as the
  // state is: a 0.1 s shot fades over 8 ms and a 2 s reload over 160.
  const share = ease(Math.min(phase / TORSO_FADE, (1 - phase) / TORSO_FADE));
  if (share <= 0) {
    return [];
  }
  if (weapon.state === "reloading" || weapon.state === "reloadStart" || weapon.state === "reloadEnd") {
    return [{ role: "reload", weight: share, phase }];
  }
  if (weapon.state === "firing") {
    // Hip and sights blended by how far into them the weapon is, for the same reason
    // the idle pair is: `ads` is a real ramp and a threshold threw it away.
    const aim = ease(weapon.ads);
    const layers: PoseLayer[] = [
      { role: "fire", weight: share * (1 - aim), phase },
      { role: "fireAds", weight: share * aim, phase },
    ];
    return layers.filter((l) => l.weight > 0);
  }
  return [];
}

/**
 * How far through its current state the weapon is, 0..1.
 *
 * From `span` and `timer` rather than from `WeaponData.clip`: the clip is the
 * *viewmodel's*, whose length has nothing to do with the body's torso clip, and it
 * is null on a weapon with no animations at all. A state's own progress is the
 * thing both clips should be placed by, which is what stretches a 0.6 s reload
 * animation and a 2.4 s one onto the same reload.
 */
function statePhase(weapon: WeaponData): number {
  return weapon.span > 0 ? clamp01((weapon.span - weapon.timer) / weapon.span) : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
