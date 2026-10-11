// Standing, crouching and lying down: which of the three a player is in, the
// eye's way between them, what each costs in speed, and where a body may lie
// and turn — "prone blocked".
//
// The rules and numbers are Modern Warfare 3's, in its units:
// reverse/iw5-stance/ has each, and docs/engine/player.md how they sit in a
// step. The state they advance is `MovementState.stance` and `.eyeShift`.
//
// The games test a lying body with box traces. Here a trace is a ball carried
// along its line (`CapsuleWorld.overlapsSweep`) and the ground under a point is
// a ray (`groundBelow`).

import type { CapsuleResolution, CapsuleWorld, Vec3 } from "./capsule.js";
import type { PlayerInput } from "./input.js";
import type { MovementEnv } from "./movementEnv.js";
import {
  CROUCHING,
  GROUND_REACH,
  LAND_WINDOW,
  STAND_EYE_HEIGHT,
  STANCES,
  STANDING,
  type EyePath,
  type Lying,
  type MovementParams,
  type MovementState,
  type StanceKind,
} from "./movementState.js";
import { UNIT } from "./units.js";

const DEGREE = Math.PI / 180;

// -- The hulls and the eye ---------------------------------------------------------

/** How tall the capsule is crouched and prone. Standing it is the body's own height. */
export const CROUCH_HEIGHT = 50 * UNIT;
export const PRONE_HEIGHT = 30 * UNIT;
/** Where the eye rests crouched and prone. Standing it is STAND_EYE_HEIGHT. */
export const CROUCH_EYE_HEIGHT = 40 * UNIT;
export const PRONE_EYE_HEIGHT = 11 * UNIT;

const EYE_AT: Record<StanceKind, number> = { stand: STAND_EYE_HEIGHT, crouch: CROUCH_EYE_HEIGHT, prone: PRONE_EYE_HEIGHT };

/**
 * One way the eye travels: how long it takes, and its height in units at each
 * percent of the way. A table and not a formula — going prone dips, bounces
 * and settles, and getting up dips first.
 */
interface EyeCurve {
  readonly from: StanceKind;
  readonly to: StanceKind;
  readonly seconds: number;
  readonly reversed: EyePath;
  readonly points: readonly (readonly [percent: number, units: number])[];
}

const EYE_CURVES: Record<EyePath, EyeCurve> = {
  standToCrouch: {
    from: "stand",
    to: "crouch",
    seconds: 0.2,
    reversed: "crouchToStand",
    points: [
      [0, 60],
      [1, 59.5],
      [4, 58.5],
      [30, 56],
      [80, 44],
      [90, 41.5],
      [95, 40.5],
      [100, 40],
    ],
  },
  crouchToStand: {
    from: "crouch",
    to: "stand",
    seconds: 0.2,
    reversed: "standToCrouch",
    points: [
      [0, 40],
      [5, 40.5],
      [10, 41.5],
      [20, 44],
      [70, 56],
      [96, 58.5],
      [99, 59.5],
      [100, 60],
    ],
  },
  crouchToProne: {
    from: "crouch",
    to: "prone",
    seconds: 0.4,
    reversed: "proneToCrouch",
    points: [
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
  },
  proneToCrouch: {
    from: "prone",
    to: "crouch",
    seconds: 0.4,
    reversed: "crouchToProne",
    points: [
      [0, 11],
      [5, 10],
      [30, 21],
      [50, 25],
      [67, 31],
      [83, 34],
      [100, 40],
    ],
  },
};

/** The longest any path takes, seconds: the bound `EyeShift.elapsed` is sent in. */
export const EYE_SHIFT_MAX = Math.max(...Object.values(EYE_CURVES).map((curve) => curve.seconds));

/** Seconds the eye takes along `path`, and the path that runs it backwards. */
export function eyePathSeconds(path: EyePath): number {
  return EYE_CURVES[path].seconds;
}

export function reversedEyePath(path: EyePath): EyePath {
  return EYE_CURVES[path].reversed;
}

/** How tall the capsule of `body` is in a stance. */
export function stanceHeight(kind: StanceKind, body: MovementParams): number {
  return kind === "stand" ? body.height : kind === "crouch" ? CROUCH_HEIGHT : PRONE_HEIGHT;
}

/** How tall the capsule of `body` is in state `s`: every collision query about where they are now is made with this. */
export function hullHeight(s: Readonly<MovementState>, body: MovementParams): number {
  return stanceHeight(s.stance.kind, body);
}

/** The eye above the feet in state `s`, m: where a player sees from, and where a round leaves from. */
export function eyeHeight(s: Readonly<Pick<MovementState, "stance" | "eyeShift">>): number {
  const shift = s.eyeShift;
  if (shift === null) {
    return EYE_AT[s.stance.kind];
  }
  const { points, seconds } = EYE_CURVES[shift.path];
  const percent = Math.min(100, (100 * shift.elapsed) / seconds);
  let i = 1;
  while (i < points.length - 1 && points[i]![0] < percent) {
    i++;
  }
  const [p0, h0] = points[i - 1]!;
  const [p1, h1] = points[i]!;
  return (h0 + ((h1 - h0) * (percent - p0)) / (p1 - p0)) * UNIT;
}

// -- Speed -------------------------------------------------------------------------

/** What a stance leaves of the speed asked for on the ground. */
const CROUCH_SPEED = 0.65;
const PRONE_SPEED = 0.15;
/** Per second, how many times the speed asked for is added on the ground (`accelerate`, sim/moves/walk.ts). */
const ACCEL: Record<StanceKind, number> = { stand: 9, crouch: 12, prone: 19 };

/**
 * The share of the speed the keys ask for that the stance allows on the
 * ground. Going down to prone and coming up from it, it follows the eye across
 * rather than switching with the hull.
 */
export function speedScale(s: Readonly<MovementState>): number {
  const shift = s.eyeShift;
  if (shift !== null && (shift.path === "crouchToProne" || shift.path === "proneToCrouch")) {
    const t = Math.min(1, shift.elapsed / EYE_CURVES[shift.path].seconds);
    return shift.path === "crouchToProne" ? CROUCH_SPEED + (PRONE_SPEED - CROUCH_SPEED) * t : PRONE_SPEED + (CROUCH_SPEED - PRONE_SPEED) * t;
  }
  return s.stance.kind === "prone" ? PRONE_SPEED : s.stance.kind === "crouch" ? CROUCH_SPEED : 1;
}

export function groundAccel(s: Readonly<MovementState>): number {
  return ACCEL[s.stance.kind];
}

// -- Where a body may lie ----------------------------------------------------------

/** How far behind the view the far side of the feet is: lying down or crawling, and inside a turn. */
const FEET_BACK = 50 * UNIT;
const FEET_BACK_TURNING = 45 * UNIT;
/** The legs are a ball of this radius swept back this far above the ground, standing for the games' 12-unit cube. */
const LEGS = 6 * UNIT;
const LEGS_UP = 24 * UNIT;
/** Legs that meet a wall closer than this never fit; closer than LEGS_SHORT, only if they fit raised by LEGS_RAISE. */
const LEGS_MIN = 17 * UNIT;
const LEGS_SHORT = 34.8 * UNIT;
const LEGS_RAISE = 22 * UNIT;
/** The waist is this far back, and needs ground within WAIST_DROP below the legs' height. */
const WAIST_BACK = 18 * UNIT;
const WAIST_DROP = 55.5 * UNIT;
/** The feet need ground within twice their height over the waist's ground, and this. */
const FEET_DROP = 15 * UNIT;
/** Legs against a wall are laid along the slope from the waist; if that is blocked, once more this much higher. */
const LEGS_LIFT = 18 * UNIT;
/** The torso may slope this much, and the legs bend down and up from it this much. */
const TORSO_SLOPE = 45 * DEGREE;
const LEGS_BEND_DOWN = 50 * DEGREE;
const LEGS_BEND_UP = 70 * DEGREE;
/** Nothing may stand this far above the line from the chest to the waist, or the waist to the feet: a kerb under the body. */
const KERB = 5 * UNIT;
/** The ball a kerb is looked for with, resting on that line. */
const KERB_PROBE = 2 * UNIT;
/** How finely a swept ball's stop is found, as halvings of the run it is known to lie in. */
const SWEEP_SEARCH = 5;
/** A body twisted this far from the view would be tested lying wholly along itself; less, nearer the view. */
const TWIST_SPAN = 240 * DEGREE;

// Scratch, so a tick allocates nothing. None of it survives a call.
const probe: Vec3 = { x: 0, y: 0, z: 0 };
const tip: Vec3 = { x: 0, y: 0, z: 0 };
const legs: Vec3 = { x: 0, y: 0, z: 0 };
const hip: Vec3 = { x: 0, y: 0, z: 0 };
const toes: Vec3 = { x: 0, y: 0, z: 0 };
const chest: Vec3 = { x: 0, y: 0, z: 0 };
const normal: Vec3 = { x: 0, y: 0, z: 0 };
const under: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };

/** `angle` as the same turn between -π and π. */
function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function sinksWithin(world: CapsuleWorld, from: Readonly<Vec3>, x: number, y: number, z: number, length: number, radius: number): boolean {
  tip.x = from.x + x * length;
  tip.y = from.y + y * length;
  tip.z = from.z + z * length;
  return world.overlapsSweep(from, tip, radius);
}

/**
 * How far a ball of `radius` gets from `from` along the unit (x, y, z) before
 * it sinks into something: `length` if nothing is in the way, which is one query.
 */
function sweep(world: CapsuleWorld, from: Readonly<Vec3>, x: number, y: number, z: number, length: number, radius: number): number {
  return sinksWithin(world, from, x, y, z, length, radius) ? stop(world, from, x, y, z, 0, length, radius) : length;
}

/** Where that ball stops, known to get as far as `clear` and not as far as `blocked`: found by halving. */
function stop(world: CapsuleWorld, from: Readonly<Vec3>, x: number, y: number, z: number, clear: number, blocked: number, radius: number): number {
  for (let k = 0; k < SWEEP_SEARCH; k++) {
    const middle = (clear + blocked) / 2;
    if (sinksWithin(world, from, x, y, z, middle, radius)) {
      blocked = middle;
    } else {
      clear = middle;
    }
  }
  return clear;
}

/** Whether anything stands KERB above the straight line between two points of the ground under a body. */
function kerbBetween(world: CapsuleWorld, a: Readonly<Vec3>, b: Readonly<Vec3>): boolean {
  const x = b.x - a.x;
  const y = b.y - a.y;
  const z = b.z - a.z;
  chest.x = a.x;
  chest.y = a.y + KERB + KERB_PROBE;
  chest.z = a.z;
  return sinksWithin(world, chest, x, y, z, 1, KERB_PROBE);
}

/**
 * Whether a body can lie at `feet` with its head along `yaw`: the games'
 * `BG_CheckProneValid`. The legs need a clear run `back` long behind the view —
 * shorter against a wall, if they fit raised or laid along the slope — the
 * waist and the feet need ground under them, and the body may neither slope
 * nor fold too far, nor lie across a kerb.
 *
 * In the air (`onGround` false) only the legs' run is asked: no ground is fine.
 */
export function proneFits(world: CapsuleWorld, feet: Readonly<Vec3>, yaw: number, back: number, onGround: boolean): boolean {
  if (!world.ready) {
    return true;
  }
  // Yaw 0 faces -Z, so the feet point along (sin, cos).
  const bx = Math.sin(yaw);
  const bz = Math.cos(yaw);
  const reach = back - LEGS;
  legs.x = feet.x;
  legs.y = feet.y + LEGS_UP;
  legs.z = feet.z;

  // The legs' line, how far along it they get, and whether a wall stopped them.
  // Each threshold is asked outright before a stop is searched for: most
  // refusals are a wall close by, and that is two queries.
  let x = bx;
  let y = 0;
  let z = bz;
  let run = reach;
  let wall = false;
  if (sinksWithin(world, legs, x, y, z, reach, LEGS)) {
    if (!onGround || sinksWithin(world, legs, x, y, z, LEGS_MIN - LEGS, LEGS)) {
      return false;
    }
    wall = true;
    if (!sinksWithin(world, legs, x, y, z, LEGS_SHORT - LEGS, LEGS)) {
      run = stop(world, legs, x, y, z, LEGS_SHORT - LEGS, reach, LEGS);
    } else {
      // Too close for legs lying flat: they fit with the feet up it, or not at all.
      const far = Math.hypot(reach, LEGS_RAISE);
      x = (bx * reach) / far;
      y = LEGS_RAISE / far;
      z = (bz * reach) / far;
      run = far;
      wall = sinksWithin(world, legs, x, y, z, far, LEGS);
      if (wall) {
        if (sinksWithin(world, legs, x, y, z, LEGS_SHORT - LEGS, LEGS)) {
          return false;
        }
        run = stop(world, legs, x, y, z, LEGS_SHORT - LEGS, far, LEGS);
      }
    }
  }
  const length = wall ? run + LEGS : back;
  toes.x = legs.x + x * run;
  toes.y = legs.y + y * run;
  toes.z = legs.z + z * run;
  if (!onGround) {
    return true;
  }

  hip.x = feet.x + bx * WAIST_BACK;
  hip.y = legs.y;
  hip.z = feet.z + bz * WAIST_BACK;
  const waist = world.groundBelow(hip, WAIST_DROP + LEGS);
  if (waist === null) {
    return false;
  }
  const waistDrop = hip.y - waist;
  if (wall) {
    if (length < 0.25 * waistDrop) {
      return false;
    }
    // Lay the legs along the slope from the waist to where they met the wall.
    let x = toes.x - hip.x - bx * LEGS;
    let y = toes.y - waist + LEGS;
    let z = toes.z - hip.z - bz * LEGS;
    const slope = Math.hypot(x, y, z);
    const laid = reach - WAIST_BACK;
    toes.x = (hip.x + (x / slope) * laid + feet.x + bx * reach) / 2;
    toes.y = hip.y + (y / slope) * laid;
    toes.z = (hip.z + (z / slope) * laid + feet.z + bz * reach) / 2;
    x = toes.x - hip.x;
    y = toes.y - hip.y;
    z = toes.z - hip.z;
    const span = Math.hypot(x, y, z);
    const got = span > 0 ? sweep(world, hip, x / span, y / span, z / span, span, LEGS) : 0;
    if (got < span) {
      // Once more from where that stopped, both ends lifted.
      chest.x = hip.x + (x / span) * got;
      chest.y = hip.y + (y / span) * got + LEGS_LIFT;
      chest.z = hip.z + (z / span) * got;
      toes.y += LEGS_LIFT;
      x = toes.x - chest.x;
      y = toes.y - chest.y;
      z = toes.z - chest.z;
      const rest = Math.hypot(x, y, z);
      if (rest > 0 && sweep(world, chest, x / rest, y / rest, z / rest, rest, LEGS) < rest) {
        return false;
      }
    }
  }

  const ground = world.groundBelow(toes, 2 * (toes.y - waist) + FEET_DROP + LEGS);
  if (ground === null) {
    return false;
  }
  // Pitches are down positive here, as the games measure them.
  const torso = Math.atan2(feet.y - waist, WAIST_BACK);
  const lower = Math.atan2(waist - ground, Math.hypot(toes.x - hip.x, toes.z - hip.z));
  const bend = torso - lower;
  if (Math.abs(torso) > TORSO_SLOPE || bend < -LEGS_BEND_DOWN || bend > LEGS_BEND_UP) {
    return false;
  }
  hip.y = waist;
  toes.y = ground;
  return !kerbBetween(world, feet, hip) && !kerbBetween(world, hip, toes);
}

/**
 * Whether a body lying along `body` fits while the view is turned to `view`:
 * the games' `BG_CheckProneTurned`. A twisted body is tested lying between
 * the two, nearer the view the smaller the twist, with shorter legs.
 */
function turnedFits(s: Readonly<MovementState>, world: CapsuleWorld, body: number, view: number): boolean {
  const twist = wrap(body - view);
  const share = Math.abs(twist) / TWIST_SPAN;
  return proneFits(world, s.feet, body - twist * (1 - share), FEET_BACK * (1 - share) + FEET_BACK_TURNING * share, s.grounded);
}

/** Whether a body in state `s`, already prone, still fits where it lies: what a prone move must end in. */
export function lyingFits(s: Readonly<MovementState>, lying: Readonly<Lying>, world: CapsuleWorld): boolean {
  return proneFits(world, s.feet, lying.heading, FEET_BACK, s.grounded);
}

// -- The view while prone ----------------------------------------------------------

/** The body turns after the view this fast, and whatever is held once the view is BODY_TURN_ALWAYS off it. */
const BODY_TURN_RATE = 55 * DEGREE;
const BODY_TURN_ALWAYS = 80 * DEGREE;
/** How far the view may lead the body, and how far it may pitch from the torso. */
export const PRONE_YAW_CAP = 85 * DEGREE;
export const PRONE_PITCH_CAP = 45 * DEGREE;
/** The torso follows the slope under it this fast. */
const TORSO_RATE = 70 * DEGREE;
/** A view pushed back less than a degree goes this share of the way back to where it was, so it does not creep. */
const NO_CREEP = 0.98;

/** The pitch of the ground under `s` along `yaw`, up positive, or null with none there. */
function slopeAlong(s: Readonly<MovementState>, env: MovementEnv, yaw: number): number | null {
  const { radius } = env.body;
  probe.x = s.feet.x;
  probe.y = s.feet.y + radius;
  probe.z = s.feet.z;
  if (!env.world.ready || env.world.groundBelow(probe, 2 * radius, normal) === null) {
    return null;
  }
  const rise = (normal.x * Math.sin(yaw) + normal.z * Math.cos(yaw)) / normal.y;
  return rise === 0 ? 0 : Math.atan(rise);
}

/**
 * Turn a lying body after the view, asked for `yaw`: toward it at
 * BODY_TURN_RATE while `crawling`, while prone is `held`, or once the view is
 * BODY_TURN_ALWAYS off it — and no further than the turned body fits, backing
 * off a degree at a time. The games' `PM_UpdateViewAngles_Prone`, first half.
 */
export function turnBody(s: Readonly<MovementState>, lying: Lying, yaw: number, crawling: boolean, held: boolean, dt: number, env: MovementEnv): void {
  const { world } = env;
  const off = wrap(lying.heading - yaw);
  if (off === 0 || !world.ready || !(Math.abs(off) > BODY_TURN_ALWAYS || crawling || held)) {
    return;
  }
  const step = BODY_TURN_RATE * dt;
  let next = Math.abs(off) <= step ? yaw : lying.heading - Math.sign(off) * step;
  while (!turnedFits(s, world, next, yaw)) {
    const left = wrap(lying.heading - next);
    if (Math.abs(left) <= DEGREE) {
      return;
    }
    next += Math.sign(left) * DEGREE;
  }
  if (proneFits(world, s.feet, yaw, FEET_BACK_TURNING, s.grounded) && (next === yaw || proneFits(world, s.feet, next, FEET_BACK_TURNING, s.grounded))) {
    lying.heading = next;
  }
}

/**
 * The yaw a lying player may look along, asked for `yaw`: turned back toward
 * the body a degree at a time until the twisted body fits, and no further from
 * it than PRONE_YAW_CAP. A function of the state, so the camera can ask it of
 * mouse movement no step has spent (sim/view.ts).
 */
export function proneYaw(s: Readonly<MovementState>, lying: Readonly<Lying>, yaw: number, env: MovementEnv): number {
  const { world } = env;
  const { heading } = lying;
  let view = yaw;
  let off = wrap(heading - view);
  // The cap first, which bounds the degrees a step can be made to try below.
  if (Math.abs(off) > PRONE_YAW_CAP) {
    view = heading - Math.sign(off) * PRONE_YAW_CAP;
    off = wrap(heading - view);
  }
  if (off === 0 || !world.ready) {
    return view;
  }
  // The games walk the view back a degree at a time until the body fits. The
  // same degree is found here by doubling and then halving, taking a body that
  // fits at one twist to fit at every smaller one: a dozen tests, not 85.
  const asked = view;
  const toward = Math.sign(off);
  const whole = Math.ceil(Math.abs(off) / DEGREE);
  const step = toward * DEGREE;
  if (turnedFits(s, world, heading, asked)) {
    return view;
  }
  let short = 0;
  let far = 1;
  if (!proneFits(world, s.feet, heading, FEET_BACK_TURNING, s.grounded)) {
    // The world changed under a body that lay here: the view goes all the way back.
    far = whole;
  } else {
    while (far < whole && !turnedFits(s, world, heading, asked + far * step)) {
      short = far;
      far *= 2;
    }
    far = Math.min(far, whole);
    while (far - short > 1) {
      const middle = (short + far) >> 1;
      if (turnedFits(s, world, heading, asked + middle * step)) {
        far = middle;
      } else {
        short = middle;
      }
    }
  }
  view = far >= whole ? heading : asked + far * step;
  const back = wrap(s.yaw - view);
  if (Math.abs(back) <= DEGREE && back * wrap(yaw - view) > 0) {
    view += NO_CREEP * back;
  }
  return view;
}

/** The pitch a lying player may look along, asked for `pitch`: within PRONE_PITCH_CAP of the torso's. */
export function pronePitch(lying: Readonly<Lying>, pitch: number): number {
  return Math.max(lying.torso - PRONE_PITCH_CAP, Math.min(lying.torso + PRONE_PITCH_CAP, pitch));
}

/** Let a lying body's torso follow the slope under it along the view, at TORSO_RATE. In the air it keeps what it had. */
export function followSlope(s: Readonly<MovementState>, lying: Lying, dt: number, env: MovementEnv): void {
  const slope = s.grounded ? slopeAlong(s, env, s.yaw) : null;
  if (slope === null) {
    return;
  }
  const off = slope - lying.torso;
  const step = TORSO_RATE * dt;
  lying.torso = Math.abs(off) <= step ? slope : lying.torso + Math.sign(off) * step;
}

// -- The stance --------------------------------------------------------------------

function fits(s: Readonly<MovementState>, env: MovementEnv, height: number): boolean {
  return !env.world.ready || !env.world.overlapsCapsule(s.feet, env.body.radius, height);
}

/** Whether there is head room to stand where `s` is: what standing up, and a sprint from a crouch, both need. */
export function standFits(s: Readonly<MovementState>, env: MovementEnv): boolean {
  return fits(s, env, env.body.height);
}

/** Whether a lying body in the air rests on something too steep to stand on: it slides there, and does not slide prone. */
function onSteep(s: Readonly<MovementState>, env: MovementEnv): boolean {
  if (!env.world.ready) {
    return false;
  }
  probe.x = s.feet.x;
  probe.y = s.feet.y - GROUND_REACH;
  probe.z = s.feet.z;
  const rest = env.world.resolveCapsule(probe, env.body.radius, PRONE_HEIGHT, under);
  return rest.normal.y > 0 && !rest.grounded && rest.normal.y < env.body.footing;
}

function rank(kind: StanceKind): number {
  return STANCES.indexOf(kind);
}

/** The eye's first leg from resting at `from` toward `to`. */
function pathToward(from: StanceKind, to: StanceKind): EyePath {
  if (from === "stand") {
    return "standToCrouch";
  }
  if (from === "prone") {
    return "proneToCrouch";
  }
  return to === "stand" ? "crouchToStand" : "crouchToProne";
}

/**
 * Move the eye toward the stance by `dt`. `rest` is where it rests when it is
 * not moving, which is the stance as it was before this step changed it. A
 * leg that ends short of the stance begins the next one, and a stance that
 * turned against a leg under way turns the eye round where it is.
 */
export function advanceEye(s: MovementState, dt: number, rest: StanceKind): void {
  const target = s.stance.kind;
  const shift = s.eyeShift;
  if (shift === null) {
    if (rest !== target) {
      s.eyeShift = { path: pathToward(rest, target), elapsed: 0 };
    }
    return;
  }
  const curve = EYE_CURVES[shift.path];
  if ((rank(target) - rank(curve.from)) * (rank(curve.to) - rank(curve.from)) <= 0) {
    shift.path = curve.reversed;
    shift.elapsed = (1 - shift.elapsed / curve.seconds) * EYE_CURVES[curve.reversed].seconds;
    return;
  }
  shift.elapsed += dt;
  if (shift.elapsed < curve.seconds) {
    return;
  }
  if (curve.to === target) {
    s.eyeShift = null;
  } else {
    shift.path = pathToward(curve.to, target);
    shift.elapsed = 0;
  }
}

/** Lie down where `s` is, along the view. A landing's grip starts with it, which is what stops a body sliding as it drops. */
function lieDown(s: MovementState, env: MovementEnv): void {
  const slope = slopeAlong(s, env, s.yaw) ?? 0;
  s.stance = { kind: "prone", heading: s.yaw, torso: Math.max(s.pitch - PRONE_PITCH_CAP, Math.min(s.pitch + PRONE_PITCH_CAP, slope)) };
  if (s.landing === 0) {
    s.landing = LAND_WINDOW;
  }
}

/**
 * One step of the stance: what `input` asks for against what the world allows,
 * the games' `PM_CheckDuck`. The stance moves one step at a time and only
 * while the eye is at rest; `sprinting`, which no stance key is down for,
 * stands a player up at once, and a `jump` pressed while ducked asks to stand.
 *
 * Returns the stance the step held the player to against their keys, or null:
 * what a toggle should fall back to (the games' `EV_STANCE_FORCE_*`).
 */
export function stepStance(s: MovementState, input: PlayerInput, dt: number, env: MovementEnv, sprinting: boolean, jump: boolean): StanceKind | null {
  const was = s.stance.kind;
  if (was === "stand" && s.eyeShift === null && !input.crouch && !input.prone) {
    return null;
  }
  if (sprinting) {
    s.stance = STANDING;
    advanceEye(s, dt, was);
    return null;
  }
  if (s.stance.kind === "prone" && !s.grounded && s.move.kind === "walk" && fits(s, env, CROUCH_HEIGHT)) {
    // Falling or sliding with the legs in something: up to a crouch at once.
    if (onSteep(s, env) || !lyingFits(s, s.stance, env.world)) {
      s.stance = CROUCHING;
      advanceEye(s, dt, was);
      return "crouch";
    }
  }

  let forced: StanceKind | null = null;
  let { crouch, prone } = input;
  // A ladder is climbed standing, and the jump key stands a ducked player up.
  if ((crouch || prone) && s.move.kind === "ladder") {
    crouch = prone = false;
    forced = "stand";
  }
  if (jump && was !== "stand") {
    crouch = prone = false;
    forced = "stand";
  }

  let want = was;
  if (prone) {
    if (was === "prone" || (s.grounded && s.move.kind === "walk" && proneFits(env.world, s.feet, s.yaw, FEET_BACK, true))) {
      want = "prone";
    } else if (s.grounded) {
      forced = was;
    }
    // In the air the request waits for the ground.
  } else if (crouch) {
    // Going down needs no room; coming up from prone does.
    if (was !== "prone" || fits(s, env, CROUCH_HEIGHT)) {
      want = "crouch";
    } else {
      forced = "prone";
    }
  } else if (was !== "stand") {
    if (standFits(s, env)) {
      want = "stand";
    } else if (was === "prone" && fits(s, env, CROUCH_HEIGHT)) {
      want = "crouch";
    } else {
      forced = was;
    }
  }

  if (s.eyeShift === null && want !== was) {
    // One step, and through a crouch between standing and prone.
    if (want === "prone" && was === "crouch") {
      lieDown(s, env);
    } else {
      s.stance = want === "stand" && was === "crouch" ? STANDING : CROUCHING;
    }
  }
  advanceEye(s, dt, was);
  return forced;
}
