// The weapon's procedural motion, layered over its clip: idle sway, lag when the
// view turns, walk bob, a jolt on jumps and landings, and the gun kick. The game
// computes these in code, not clips (no weapon has a walk clip); only their
// parameters are in the weapon file (docs/cod/reference.md#viewmodels). The
// formulas here are approximations driven by those parameters, and the *_GAIN
// constants were set by eye. Pure: no three.js and no randomness, so a held pose
// renders the same.
//
// The **gun** kick is here because it rocks the model in the hands and decides
// nothing else. It is integrated in the simulation (@3d/shared/sim/recoil.ts) on
// the fixed tick, so that a corrected client rocks the gun the way the tick it
// was given did, and only read here. The kick that decides where a bullet goes
// is the *view* kick, and that one is applied to the camera this rig hangs off
// (`aimAngles`) and must never be added again here.

import { WALK_SPEED } from "@3d/shared/sim/movement.js";

/** One frame of what the motion responds to. */
export interface MotionFrame {
  dt: number;
  /** Radians the view turned this frame: yaw to the left and pitch up are positive. */
  turn: { yaw: number; pitch: number };
  /** Horizontal speed, m/s. */
  speed: number;
  grounded: boolean;
  /** Vertical speed, m/s, up positive. */
  climb: number;
  /** 0 at the hip, 1 aiming down the sights. */
  ads: number;
  /**
   * The gun kick as the simulation holds it, degrees. **Negative pitch is the
   * muzzle up** here, which is how the weapon files that have a consistent sign
   * spell it (the M4's `hipGunKickPitchMax` is -15) — but only some of them do:
   * 613 of the games' 1503 files put the positive end upward instead. The kick
   * is drawing, so a weapon spelled the other way rocks the other way and nothing
   * is judged by it; the *view* kick is where the sign is fixed and tested.
   */
  kick: { readonly pitch: number; readonly yaw: number };
}

/** An offset of the whole rig about the eye, in view space: metres (x right, y up, z back) and radians. */
export interface MotionPose {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
}

const DEG = Math.PI / 180;
const INCH = 0.0254;

/** `hipIdleAmount` 15 becomes 0.15° of sway; `hipIdleSpeed` 5 a 1 rad/s cycle. */
const IDLE_DEGREES_PER_UNIT = 0.01;
const IDLE_RADIANS_PER_SECOND_PER_UNIT = 0.2;
/** The share of the lag angle (bounded by `swayMaxAngle`) the gun actually turns through. */
const SWAY_GAIN = 0.14;
/**
 * Per second, how fast the gun catches up with the lag. A flick fills the lag in
 * one frame; without this the gun jumps to the side with it instead of swinging.
 */
const SWAY_FOLLOW = 10;
/** One bob cycle (two steps) per this many metres walked. */
const BOB_METRES_PER_CYCLE = 1.6;
/** At walking speed: sideways and vertical travel (m) and roll (degrees). */
const BOB_SIDE = 0.006;
const BOB_DIP = 0.004;
const BOB_ROLL = 0.6;
/** How fast the bob fades in and out as the player starts and stops, per second. */
const BOB_EASE = 8;
/**
 * The gun's weight: a change in the body's vertical speed (a takeoff, a landing)
 * knocks it down, nose dipping, and a spring brings it back. The change is
 * capped, so a long fall knocks it no harder than JOLT_MAX_CHANGE does.
 */
const JOLT_GAIN = 0.05; // m/s of gun per m/s of change
const JOLT_MAX_CHANGE = 8; // m/s
const JOLT_PITCH = 1.2; // radians of dip per metre of drop
const JOLT_FREQUENCY = 12; // rad/s
const JOLT_DAMPING = 0.6; // of critical

export class WeaponMotion {
  private time = 0;
  private lagYaw = 0;
  private lagPitch = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private lastClimb = 0;
  private jolt = 0;
  private joltSpeed = 0;

  constructor(private readonly params: Readonly<Record<string, number>>) {}

  /** Back to rest: a newly held weapon, or a held pose. */
  reset(): void {
    this.time = this.lagYaw = this.lagPitch = this.swayYaw = this.swayPitch = this.bobPhase = this.bobAmount = 0;
    this.lastClimb = this.jolt = this.joltSpeed = 0;
  }

  /** This frame's pose, into `out` when given — the viewmodel keeps one, since this runs every frame. */
  update(f: MotionFrame, out?: MotionPose): MotionPose {
    const ads = Math.min(1, Math.max(0, f.ads));
    this.time += f.dt;
    const pose = out ?? { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
    pose.x = pose.y = pose.z = pose.pitch = pose.yaw = pose.roll = 0;

    // Idle: a slow figure of eight.
    const amount = this.mix("hipIdleAmount", "adsIdleAmount", ads, 0) * IDLE_DEGREES_PER_UNIT * DEG;
    const rate = this.mix("hipIdleSpeed", "adsIdleSpeed", ads, 0) * IDLE_RADIANS_PER_SECOND_PER_UNIT;
    pose.pitch += amount * Math.sin(rate * this.time);
    pose.yaw += amount * 0.5 * Math.sin(0.5 * rate * this.time);

    // Look sway: the gun trails a view that eases after the real one, the gap
    // softly capped at swayMaxAngle (a hard cap pins every quick turn at the edge).
    const maxLag = this.mix("swayMaxAngle", "adsSwayMaxAngle", ads, 0) * DEG;
    const ease = Math.min(1, this.mix("swayLerpSpeed", "adsSwayLerpSpeed", ads, 4) * f.dt);
    this.lagYaw = softLimit((this.lagYaw + f.turn.yaw) * (1 - ease), maxLag);
    this.lagPitch = softLimit((this.lagPitch + f.turn.pitch) * (1 - ease), maxLag);
    const follow = Math.min(1, SWAY_FOLLOW * f.dt);
    this.swayYaw += (this.lagYaw - this.swayYaw) * follow;
    this.swayPitch += (this.lagPitch - this.swayPitch) * follow;
    pose.yaw += this.swayYaw * this.mix("swayYawScale", "adsSwayYawScale", ads, 0) * SWAY_GAIN;
    pose.pitch += this.swayPitch * this.mix("swayPitchScale", "adsSwayPitchScale", ads, 0) * SWAY_GAIN;
    // The weapon file's scales are inches per degree of lag. Trailing a turn to the left puts the gun to the right.
    pose.x += (this.swayYaw / DEG) * this.mix("swayHorizScale", "adsSwayHorizScale", ads, 0) * INCH * SWAY_GAIN;
    pose.y -= (this.swayPitch / DEG) * this.mix("swayVertScale", "adsSwayVertScale", ads, 0) * INCH * SWAY_GAIN;

    // Walk bob, eased in and out with speed, and damped in the sights.
    const target = f.grounded ? Math.min(f.speed / WALK_SPEED, 2) : 0;
    this.bobAmount += (target - this.bobAmount) * Math.min(1, BOB_EASE * f.dt);
    this.bobPhase = (this.bobPhase + (f.dt * f.speed) / BOB_METRES_PER_CYCLE) % 1;
    const bob = this.bobAmount * (1 + ((this.params.adsViewBobMult ?? 1) - 1) * ads);
    const step = Math.sin(2 * Math.PI * this.bobPhase);
    pose.x += BOB_SIDE * bob * step;
    pose.y -= BOB_DIP * bob * step * step;
    pose.roll += BOB_ROLL * DEG * bob * step;

    // Jolt, damped in the sights like the bob.
    if (f.dt > 0) {
      const change = Math.max(-JOLT_MAX_CHANGE, Math.min(JOLT_MAX_CHANGE, f.climb - this.lastClimb));
      this.joltSpeed -= change * JOLT_GAIN;
      this.joltSpeed -= (JOLT_FREQUENCY * JOLT_FREQUENCY * this.jolt + 2 * JOLT_DAMPING * JOLT_FREQUENCY * this.joltSpeed) * f.dt;
      this.jolt += this.joltSpeed * f.dt;
    }
    this.lastClimb = f.climb;
    const jolt = this.jolt * (1 + ((this.params.adsViewBobMult ?? 1) - 1) * ads);
    pose.y += jolt;
    pose.pitch += jolt * JOLT_PITCH;

    // The gun kick, read and not integrated: 1:1 in the weapon file's own
    // degrees, so this adds no constant of its own to tune.
    pose.pitch -= f.kick.pitch * DEG;
    pose.yaw += f.kick.yaw * DEG;
    return pose;
  }

  /** A parameter blended from its hip value to its ADS value. */
  private mix(hip: string, aimed: string, ads: number, fallback: number): number {
    const h = this.params[hip] ?? fallback;
    const a = this.params[aimed] ?? h;
    return h + (a - h) * ads;
  }
}

/** Near `v` while small, easing towards ±`limit` and never past it. */
function softLimit(v: number, limit: number): number {
  return limit > 0 ? limit * Math.tanh(v / limit) : 0;
}
