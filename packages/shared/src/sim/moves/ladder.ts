// The ladders a world declares, and the one question a movement step asks of
// them: sweeping the player's probe this way, is the first thing it touches a
// side of a ladder that can be climbed?
//
// That is the games' own test (IW5 `PM_CheckLadderMove`, 0x4230d0): a box trace
// ahead of the player against surfaces flagged as ladders. In the maps every
// ladder is a thin player-clip brush of its own, so a trace against the box is
// the trace the game made, and the world's collision is not asked — which also
// keeps this free of any geometry library. What that leaves out is a wall
// between the player and the ladder, which the maps do not build.
//
// What a ladder means is in dsl/resolved.ts's `ResolvedLadder`; how the grab
// and the climb use this, under "The climb" below and in docs/engine/player.md.

import type { ResolvedLadder } from "../../dsl/resolved.js";
import type { Vec3 } from "../capsule.js";
import type { PlayerInput } from "../input.js";
import type { MovementEnv } from "../movementEnv.js";
import { JUMP_SPEED, WALKING, type LadderMove, type MovementParams, type MovementState } from "../movementState.js";
import { ladderSlide } from "../stepSlide.js";
import { UNIT } from "../units.js";

/**
 * The probe is the body with each horizontal half-width shrunk by this, and its
 * bottom raised by PROBE_FLOOR (IW5 0x41fc00). The inset leaves a body pressed
 * against a ladder 6 units short of it, which the reach then covers.
 */
const PROBE_INSET = 6 * UNIT;
const PROBE_FLOOR = 8 * UNIT;

/** The capsule a probe is cut from: the part of `MovementParams` a trace reads. */
export interface LadderBody {
  radius: number;
  height: number;
}

/** What a probe touched: the ladder, and the outward normal of the side it touched, world space. */
export interface LadderHit {
  ladder: ResolvedLadder;
  /** Unit and horizontal: a probe is swept flat, so it only ever meets a ladder's sides. */
  x: number;
  z: number;
}

/** Turn `v` about +Y by `theta`. three.js' convention, as `dsl/resolveUtil.ts`'s `rotateY`. */
function rotateY(x: number, z: number, theta: number): { x: number; z: number } {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  return { x: x * c + z * s, z: -x * s + z * c };
}

/**
 * Where a segment from `p` along `d` is between -h and h on one axis, as
 * distances along it; null if it never is. A segment parallel to the slab is in
 * it for good or not at all.
 */
function slab(p: number, d: number, h: number): { enter: number; exit: number } | null {
  if (Math.abs(d) < 1e-9) {
    return Math.abs(p) < h ? { enter: -Infinity, exit: Infinity } : null;
  }
  const t0 = (-h - p) / d;
  const t1 = (h - p) / d;
  return { enter: Math.min(t0, t1), exit: Math.max(t0, t1) };
}

/** The side of a box whose outward normal is `sign` along its local X (`alongX`) or Z. See `ResolvedLadder.face`. */
function sideName(alongX: boolean, sign: number): NonNullable<ResolvedLadder["face"]> {
  if (alongX) {
    return sign > 0 ? "right" : "left";
  }
  return sign > 0 ? "back" : "front";
}

/**
 * The ladders of one world. A map has a handful (MW2's derail has the most, 24),
 * so a query tests every one rather than keeping a broad phase.
 */
export class LadderVolumes {
  constructor(private readonly ladders: readonly ResolvedLadder[]) {}

  get count(): number {
    return this.ladders.length;
  }

  /**
   * Sweep the probe from `feet` along the unit horizontal `(dirX, dirZ)` for
   * `reach` metres, and return the ladder side it meets first — or null if it
   * meets nothing, or first meets a side of a ladder that cannot be climbed
   * there (`face`): the game's trace stops at the first surface either way.
   *
   * A probe that starts inside a box touches nothing of it, as a start-solid
   * trace reports nothing to climb. The body cannot be there anyway: the box
   * is a wall in the world's collision, and the probe is narrower than the body.
   *
   * Deterministic: a server runs this for every player every tick, and has to
   * reach the answer the client did from the same state.
   */
  trace(feet: Vec3, dirX: number, dirZ: number, reach: number, body: LadderBody): LadderHit | null {
    const half = body.radius - PROBE_INSET;
    const bottom = feet.y + PROBE_FLOOR;
    const top = feet.y + body.height;

    let nearest = Infinity;
    let hit: { ladder: ResolvedLadder; alongX: boolean; sign: number } | null = null;
    for (const ladder of this.ladders) {
      const floor = ladder.position.y - ladder.size.y / 2;
      if (top <= floor || bottom >= floor + ladder.size.y) {
        continue;
      }
      // Into the box's frame (see ResolvedLadder), where the swept probe is a
      // segment against the box grown by the probe's half-width.
      const s = Math.sin(-ladder.yaw);
      const c = Math.cos(-ladder.yaw);
      const ox = feet.x - ladder.position.x;
      const oz = feet.z - ladder.position.z;
      const px = ox * c + oz * s;
      const pz = -ox * s + oz * c;
      const dx = dirX * c + dirZ * s;
      const dz = -dirX * s + dirZ * c;
      const hx = ladder.size.x / 2 + half;
      const hz = ladder.size.z / 2 + half;
      if (Math.abs(px) < hx && Math.abs(pz) < hz) {
        continue;
      }

      // Slabs: the segment enters the box at the later of its two entries, and
      // through the side of that axis facing back along the sweep.
      const x = slab(px, dx, hx);
      const z = slab(pz, dz, hz);
      if (!x || !z) {
        continue;
      }
      const alongX = x.enter >= z.enter;
      const enter = Math.max(x.enter, z.enter);
      if (enter < 0 || enter > Math.min(x.exit, z.exit) || enter > reach || enter >= nearest) {
        continue;
      }
      const sign = (alongX ? dx : dz) > 0 ? -1 : 1;
      nearest = enter;
      hit = { ladder, alongX, sign };
    }

    if (!hit || (hit.ladder.face !== undefined && hit.ladder.face !== sideName(hit.alongX, hit.sign))) {
      return null;
    }
    const normal = rotateY(hit.alongX ? hit.sign : 0, hit.alongX ? 0 : hit.sign, hit.ladder.yaw);
    return { ladder: hit.ladder, x: normal.x, z: normal.z };
  }
}

/** A world with no ladders, so a caller always has one to hold. */
export const NO_LADDERS = new LadderVolumes([]);

// -- The climb ---------------------------------------------------------------------
//
// Every number here is IW5's own, read from `PM_CheckLadderMove` (0x4230d0),
// `PM_LadderMove` (0x423380) and the jump-off (0x416780), in game units where the
// game has them. BO1 runs the same code with the same numbers. The derivation is
// in docs/engine/player.md#ladders.

/** The speed a climb is a share of, whatever the body's own walk is. */
const LADDER_SPEED = 190 * UNIT;
/** Of LADDER_SPEED: straight up or down at full pitch, and sideways. */
const LADDER_CLIMB_SHARE = 0.5;
const LADDER_STRAFE_SHARE = 0.2;
/** Per second, this many times the wanted speed is added toward the wanted velocity. */
const LADDER_ACCEL = 9;
/** Off the ground, a mostly-vertical climb is held against the ladder at this speed: what carries a player over the top. */
const LADDER_PUSH = 50 * UNIT;
/** How far ahead a probe looks for a ladder, standing and in the air. */
const LADDER_REACH_GROUND = 8 * UNIT;
const LADDER_REACH_AIR = 30 * UNIT;
/** No ladder is grabbed this soon after a jump. One is jumped off no sooner than any jump follows another (JUMP_REPEAT). */
const LADDER_GRAB_DELAY = 0.3; // s
/** A jump off a ladder keeps this share of the jump's rise, and leaves at this speed along the ground. */
const JUMP_OFF_RISE = 0.75;
const JUMP_OFF_SPEED = 128 * UNIT;
/** In the air on a ladder, the view may turn this far from facing it (`bg_ladder_yawcap`). */
const LADDER_YAW_CAP = (100 * Math.PI) / 180;

/** The outward normal a ladder's `facing` names, horizontal and unit. */
export function ladderNormal(ladder: Readonly<LadderMove>): { x: number; z: number } {
  return { x: -Math.sin(ladder.facing), z: -Math.cos(ladder.facing) };
}

/**
 * The yaw a player in state `s` may look along, asked for `yaw`: off the ground
 * on a ladder, no further than LADDER_YAW_CAP from facing it. A step applies it
 * to the input; the camera applies it to the mouse movement no step has spent
 * yet (engine/controls/firstPerson.ts), as the game writes the overshoot into
 * the view's delta angles.
 */
export function ladderYaw(s: Readonly<MovementState>, yaw: number): number {
  if (s.move.kind !== "ladder" || s.grounded) {
    return yaw;
  }
  const toward = s.move.facing + Math.PI;
  const delta = Math.atan2(Math.sin(yaw - toward), Math.cos(yaw - toward));
  if (Math.abs(delta) <= LADDER_YAW_CAP) {
    return yaw;
  }
  return toward + Math.sign(delta) * LADDER_YAW_CAP;
}

/** Leave the ladder, if on one, without a jump: no other ladder until the ground. */
function letGo(s: MovementState): void {
  if (s.move.kind === "ladder") {
    s.move = WALKING;
    s.ladderLock = true;
  }
}

function ladderReach(s: Readonly<MovementState>): number {
  return s.grounded ? LADDER_REACH_GROUND : LADDER_REACH_AIR;
}

/**
 * The ladder side the grab check's probe meets from `s`, or null: along the
 * view, or straight back into the ladder when climbing one in the air. What the
 * next step tests, before its other conditions (the lock, a jump's delay, the
 * forward key), which is what the climb view (`M`) wants to show.
 */
export function ladderAhead(s: Readonly<MovementState>, ladders: LadderVolumes, body: MovementParams): LadderHit | null {
  let dirX = -Math.sin(s.yaw);
  let dirZ = -Math.cos(s.yaw);
  if (s.move.kind === "ladder" && !s.grounded) {
    const normal = ladderNormal(s.move);
    dirX = -normal.x;
    dirZ = -normal.z;
  }
  return ladders.trace(s.feet, dirX, dirZ, ladderReach(s), body);
}

/**
 * Grab a ladder, keep hold of one, or let go: IW5's `PM_CheckLadderMove`.
 *
 * A probe goes ahead of the player — along the view on the ground or on the way
 * to a ladder, but straight back into the ladder once climbing it in the air, so
 * looking away does not let go. Standing, only a player pushing forward holds
 * on, which is how stepping off at the bottom works. A first grab checks a
 * second probe straight in along the side's normal, as the game does.
 */
export function checkLadder(s: MovementState, input: PlayerInput, env: MovementEnv): void {
  const { ladders, body } = env;
  if (s.ladderLock) {
    return;
  }
  if (s.sinceJump < LADDER_GRAB_DELAY) {
    letGo(s);
    return;
  }
  const hit = ladderAhead(s, ladders, body);
  if (hit && (!s.grounded || input.forward > 0)) {
    if (s.move.kind === "ladder") {
      return;
    }
    if (ladders.trace(s.feet, -hit.x, -hit.z, ladderReach(s), body)) {
      s.move = { kind: "ladder", facing: Math.atan2(-hit.x, -hit.z) };
      // Whatever jump brought them here is over; the next ground is not its landing.
      s.jumpFrom = null;
      s.landing = 0;
      return;
    }
  }
  letGo(s);
}

/**
 * One step on a ladder: IW5's `PM_LadderMove`.
 *
 * The keys ask for a velocity and it is approached at LADDER_ACCEL. Forward
 * climbs, and the pitch says which way and how fast: level is 0.625 of full
 * speed up, about 14.5 degrees down is still, and past 40 degrees down forward
 * climbs down at full speed. Strafing moves along the ladder. With a key let go,
 * that half of the velocity stops. No gravity; collision still runs, because a
 * ladder is steered, not a rail.
 */
export function climbLadder(s: MovementState, ladder: LadderMove, input: PlayerInput, dt: number, env: MovementEnv): void {
  const v = s.velocity;
  const normal = ladderNormal(ladder);
  const upScale = Math.max(-1, Math.min(1, (Math.sin(s.pitch) + 0.25) * 2.5));
  // The view's flat right, laid onto the ladder's plane and left unnormalised:
  // strafing at a ladder side-on is slower, as it is in the game.
  const flatRightX = Math.cos(s.yaw);
  const flatRightZ = -Math.sin(s.yaw);
  const across = flatRightX * normal.x + flatRightZ * normal.z;
  const rightX = flatRightX - normal.x * across;
  const rightZ = flatRightZ - normal.z * across;

  // The game's command scale: a diagonal is no faster than a straight push.
  const held = Math.hypot(input.forward, input.right);
  const scale = held > 0 ? (LADDER_SPEED * Math.max(Math.abs(input.forward), Math.abs(input.right))) / held : 0;
  const wishX = input.right * scale * LADDER_STRAFE_SHARE * rightX;
  const wishY = input.forward * upScale * LADDER_CLIMB_SHARE * scale;
  const wishZ = input.right * scale * LADDER_STRAFE_SHARE * rightZ;
  const wishSpeed = Math.hypot(wishX, wishY, wishZ);
  if (wishSpeed > 0) {
    const dx = wishX - v.x;
    const dy = wishY - v.y;
    const dz = wishZ - v.z;
    const gap = Math.hypot(dx, dy, dz);
    if (gap > 0) {
      const add = Math.min(gap, LADDER_ACCEL * wishSpeed * dt) / gap;
      v.x += dx * add;
      v.y += dy * add;
      v.z += dz * add;
    }
  }

  // A key let go stops its half of the climb at once: no glide up the ladder
  // or along it, which is how the game plays. Its code decays the two instead
  // (vertical at gravity, 0.12 s from full speed; sideways at 16× a second);
  // stopping outright also keeps a still climber exactly still at any tick rate.
  if (input.forward === 0) {
    v.y = 0;
  }
  if (input.right === 0) {
    const length = Math.hypot(rightX, rightZ);
    if (length > 0) {
      const alongX = rightX / length;
      const alongZ = rightZ / length;
      const side = alongX * v.x + alongZ * v.z;
      v.x -= alongX * side;
      v.z -= alongZ * side;
    }
  }

  if (!s.grounded) {
    const out = v.x * normal.x + v.z * normal.z;
    v.x -= normal.x * out;
    v.z -= normal.z * out;
    // Asked of the climb itself, so what the projections above leave of a
    // sideways slide — too small to square — is not a climber moving.
    if (v.y !== 0 && v.x * v.x + v.z * v.z <= v.y * v.y) {
      v.x -= normal.x * LADDER_PUSH;
      v.z -= normal.z * LADDER_PUSH;
    }
  }

  // Standing, or climbing upward: the games step a climber onto the top.
  ladderSlide(s, dt, env, s.grounded || v.y > 0);
}

/**
 * Jump away from the ladder: the ordinary takeoff, less a quarter of its rise,
 * and JUMP_OFF_SPEED along the ground. Looking away from the ladder,
 * that is where the view points; looking at it, the view is mirrored off it, so
 * either way the jump leaves the ladder behind.
 */
export function jumpOffLadder(s: MovementState, ladder: LadderMove): void {
  const normal = ladderNormal(ladder);
  let x = -Math.sin(s.yaw);
  let z = -Math.cos(s.yaw);
  const into = x * normal.x + z * normal.z;
  if (into < 0) {
    x -= 2 * into * normal.x;
    z -= 2 * into * normal.z;
    const length = Math.hypot(x, z);
    x /= length;
    z /= length;
  }
  s.velocity.x = x * JUMP_OFF_SPEED;
  s.velocity.y = JUMP_SPEED * JUMP_OFF_RISE;
  s.velocity.z = z * JUMP_OFF_SPEED;
  s.move = WALKING;
  s.grounded = false;
  s.jumpFrom = s.feet.y;
  s.landing = 0;
  s.sinceJump = 0;
}
