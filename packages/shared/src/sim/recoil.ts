// Spread and recoil: the cone a shot leaves in, and the two kicks it leaves behind.
//
// Call of Duty carries **two** recoil families and they are not the same
// quantity. `*GunKick*` rocks the weapon *model* in the hands and draws nothing
// else; `*ViewKick*` punches the player's aim off target and walks it back at
// `ViewKickCenterSpeed`. Only the second decides where a bullet goes, which is
// why only the second is in `aimAngles` — a build that put the gun kick there
// gave every scoped sniper in Modern Warfare 3 no recoil at all, because their
// `adsGunKickPitch` is identically zero and all of it is `adsViewKick`.
//
// Both were a drawing effect — engine/weaponMotion.ts integrated a kick per
// rendered frame so the viewmodel had something to do. They are simulation now,
// for the reason the weapon's state machine is: a server judging a shot has to
// know where the gun was actually pointing, and a client predicting has to reach
// the same answer or its own crosshair would argue with the hit it gets. So the
// integrator lives here, stepped on a fixed `dt` rather than on a frame, and its
// state rides on `WeaponData` and over the wire.
//
// The numbers are the games' own (`WeaponDef.motion` and `.spread`). Exactly one
// thing is tuned: `VIEW_KICK_SCALE`, the degrees a second a weapon file's view-kick
// numbers are read at. Everything else — how long a round's bounce takes, how far
// it falls back before the next one, whether a weapon climbs from the hip at all —
// is a ratio of two of the games' own numbers and holds at any scale. What Modern
// Warfare 3 itself does with them is `reverse/iw5-view-kick/README.md`.

import { clampPitch, RUN_SPEED } from "./movement.js";
import type { WeaponDef, WeaponSpread } from "./weaponDef.js";

const DEG = Math.PI / 180;

/** Where the gun has been pushed, and how fast it is still moving: degrees, and degrees a second. */
export interface KickState {
  pitch: number;
  yaw: number;
  pitchSpeed: number;
  yawSpeed: number;
}

/**
 * Where the aim has been thrown, degrees, and how fast it is still travelling.
 *
 * **A shot sets the speed, not the angle.** Modern Warfare 3's own name for the
 * three numbers a round produces is `kickAVel` — kick angular *velocity* — and
 * `ViewKickCenterSpeed` is the acceleration that brings it back, which is why
 * those weapon-file values are in the hundreds and thousands rather than the
 * ones and twos an angle would need. The view is thrown and falls back, and that
 * is the "bounce" the games have and an angle added outright cannot: adding the
 * angle puts the whole of a round's kick on one frame, which reads as a jolt
 * however small it is made. See `reverse/iw5-view-kick/README.md` and
 * `stepViewKick`.
 */
export interface ViewKick {
  pitch: number;
  yaw: number;
  /** Degrees a second. Set outright by a shot, and accelerated back toward the aim. */
  pitchVel: number;
  yawVel: number;
}

/** A kick as read, which is all `aimAngles` needs — so a `DeepReadonly<WeaponData>` fits. */
export type ReadKick = { readonly pitch: number; readonly yaw: number };

/**
 * What the holder is doing this step: the two things spread and recoil need and
 * the state machine does not. `Player.step` fills it in.
 */
export interface Holder {
  /**
   * The stream this player's shots draw from. `hashString(playerId)` at the call
   * sites (`Match.join`, the client's own join), because a player id is a
   * net-layer thing and `sim/` neither knows one nor may reach `game/random.ts`
   * to hash it — but both ends hash the same id, so both ends draw the same
   * numbers.
   */
  seed: number;
  /** Horizontal speed, m/s: how much of the hip spread's `moveAdd` is in play. */
  speed: number;
}

/** A holder standing still with no seed: what a test or a browser with no match has. */
export const HOLDER_AT_REST: Holder = { seed: 0, speed: 0 };

/**
 * Degrees the kick may reach, and degrees a second it may build.
 *
 * Both are the wire's range as well as the simulation's, so the two cannot
 * disagree — `quant` clamps rather than throwing, and a weapon file whose
 * `GunKickStaticDecay` is 0 (several in the catalogue) integrates without bound.
 */
export const KICK_LIMIT = 64;
export const KICK_SPEED_LIMIT = 2048;

/**
 * Degrees the view kick may reach on an axis: **the engine's own hard limit**,
 * not a guard.
 *
 * `UpdateKickAngles` compares the new angle against ±10 every sub-step and, past
 * it, pins the angle to that bound *and sets the speed to zero* — the constants
 * are at `0x7e927c` and `0x7e3b20` (reverse/iw5-view-kick/README.md). So a
 * weapon whose rounds outrun its own recovery does not walk the view off the top
 * of the screen: it saturates at ten degrees and stays there until the trigger
 * comes off. That is what keeps a Desert Eagle — 70 units of throw against only
 * 600 of pull, the worst ratio in the catalogue — bounded.
 *
 * Zeroing the speed matters as much as the angle. Left travelling, a saturated
 * weapon keeps pushing into the stop and the moment it is released the view
 * lurches; zeroed, it is simply held there.
 *
 * It is also the wire's range (net/messages/player.ts), and 10 rather than the 64
 * this used to guess makes that field six times finer for free.
 */
export const VIEW_KICK_LIMIT = 10;

/**
 * Degrees a second the throw may travel at: the wire's range, and a guard against
 * a weapon file with no recovery at all. Ours, not the engine's. It has to clear
 * four times the largest impulse in the catalogue, because the fall keeps
 * accelerating the whole way home.
 */
export const VIEW_KICK_SPEED_LIMIT = 16384;

/**
 * **The one number tuned here**, and the only one: degrees a second of thrown
 * view per unit of a weapon file's `ViewKick` numbers. It scales the impulse and
 * `ViewKickCenterSpeed` alike, because in the engine they are a velocity and its
 * acceleration in the same unit.
 *
 * **Estimated, not established.** A weapon file's view-kick numbers are plainly
 * not degrees a second as written (no rifle throws the view 85°/s per round on
 * the evidence of its own `Min`), and the factor the engine reads them at sits
 * inside `UpdateKickAngles`' integrator where it is indistinguishable from the
 * step size (`reverse/iw5-view-kick/README.md`). So this is fitted to how the
 * games play, and it is the only thing here that is.
 *
 * **Nothing about the shape depends on it.** Both the rise time (`v/a`) and the
 * fall (`4.08 v/a`, below) are ratios of two weapon-file numbers, so they are the
 * games' own at any scale — this moves how far the view travels and never how
 * long it takes, and never which weapons climb.
 *
 * **Turn this one line to make every weapon kick more or less, in proportion.**
 * It is deliberately on the quiet side: the kick is quadratic in a weapon's own
 * number (a bounce reaches `v^2 / 2a`), so the loudest weapon in the catalogue
 * grows far faster than the ACR does, and it is the loudest one that decides
 * whether the screen is being thrown about. At 1.5 no automatic moves the view
 * more than 3.6° in a frame and most move 1.2-2.0°; an aimed ACR walks 4.1° up a
 * magazine and 0.6° from the hip, and is home 0.27 s after the trigger.
 */
export const VIEW_KICK_SCALE = 1.5;

/**
 * The fixed sub-step the throw is integrated on, seconds, and what is left of a
 * step that moves the view back toward the aim rather than away from it.
 *
 * Both are the engine's own (`UpdateKickAngles`, the 5 ms loop and the 0.06 at
 * `0x7f14c0`). The damping is what makes recoil *accumulate*: the view snaps up
 * in `v/a` seconds and oozes back over `4.08 v/a`, so a weapon firing faster than
 * that cycle starts its next round part way up and the magazine walks. A weapon
 * firing slower settles first and never climbs at all — which is why hip fire
 * does not raise the screen while a full aim does, on the same gun, out of the
 * weapon file rather than out of a rule.
 *
 * The sub-step is fixed so a server replaying a client's own step lengths gets
 * the same answer: a 16.7 ms tick is three 5 ms steps and a remainder, always.
 */
export const VIEW_KICK_SUBSTEP = 0.005;
export const VIEW_KICK_RETURN = 0.06;

/** Degrees the hip spread may reach. The widest `hipStandMax` in the catalogue is 18. */
export const SPREAD_LIMIT = 32;

/** What the weapon file leaves out, as engine/weaponMotion.ts had them. */
const DEFAULT_SPEED_MAX = 2000;
const DEFAULT_SPEED_DECAY = 16;
const DEFAULT_STATIC_DECAY = 20;

/**
 * Two odd multipliers, so each `Math.imul` is a bijection on 32 bits and no two
 * ordinals — or two pellets of one shot — can land on the same stream.
 */
const SHOT_STREAM = 0x9e3779b1;
const PELLET_STREAM = 0x85ebca6b;

export function restingKick(): KickState {
  return { pitch: 0, yaw: 0, pitchSpeed: 0, yawSpeed: 0 };
}

export function restingViewKick(): ViewKick {
  return { pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 };
}

/**
 * The stream one shot draws from: the shooter's own seed, mixed with which shot
 * it is. `fired + 1` so the first shot is not the bare seed, and `pellet` is
 * there because a shotgun casts eight rounds that must differ from each other and
 * agree across the two ends — nothing casts pellets yet, but the stream they will
 * want is not a shape to change later.
 */
export function shotStream(seed: number, fired: number, pellet = 0): number {
  return (seed ^ Math.imul(fired + 1, SHOT_STREAM) ^ Math.imul(pellet + 1, PELLET_STREAM)) | 0;
}

/**
 * The `index`th number a stream draws, in [0, 1). mulberry32's finalizer, with
 * the index mixed in rather than a counter carried: a draw is then a pure
 * function of (stream, index), so a server replaying a shot out of order — or
 * only replaying some of them — still gets the number the client did.
 */
export function draw(stream: number, index: number): number {
  let t = (stream + Math.imul(index + 1, 0x6d2b79f5)) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A motion parameter blended from its hip value to its ADS value. */
function mix(motion: Record<string, number>, hip: string, aimed: string, ads: number, fallback: number): number {
  const h = motion[hip] ?? fallback;
  const a = motion[aimed] ?? h;
  return h + (a - h) * ads;
}

/**
 * A value from a hip/ADS pair of bounds, at `r`.
 *
 * **A min and a max are a range, not an order**: the M4's `hipGunKickPitchMin`
 * is 5 and its `hipGunKickPitchMax` is -15, and the L96's `adsViewKickYawMin` is
 * 70 against a `Max` of -75. So the min end is `r = 0` and the max end is `r = 1`,
 * and nothing here sorts them — clamping to [min, max] as written would pin every
 * M4 shot at +5 and swing the L96 one way only.
 */
function between(motion: Record<string, number>, name: string, ads: number, r: number): number {
  const lo = mix(motion, `hip${name}Min`, `ads${name}Min`, ads, 0);
  const hi = mix(motion, `hip${name}Max`, `ads${name}Max`, ads, 0);
  return lo + (hi - lo) * r;
}

function hold(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}

/** One shot's impulse into the gun's kick, drawn from that shot's own stream. */
export function addKick(kick: KickState, motion: Record<string, number>, ads: number, stream: number): void {
  const max = Math.min(KICK_SPEED_LIMIT, mix(motion, "hipGunKickSpeedMax", "adsGunKickSpeedMax", ads, DEFAULT_SPEED_MAX));
  kick.pitchSpeed = hold(kick.pitchSpeed + between(motion, "GunKickPitch", ads, draw(stream, 0)), max);
  kick.yawSpeed = hold(kick.yawSpeed + between(motion, "GunKickYaw", ads, draw(stream, 1)), max);
}

/**
 * One shot's punch into the **aim**, drawn from that shot's own stream.
 *
 * Draws 2 and 3, because 0 and 1 are the gun kick's: the two families come off
 * one shot and must not share a number, or a weapon whose two pitch ranges are
 * alike would kick its model and its aim in lockstep.
 *
 * **Positive pitch is upward.** Measured, not assumed: `hipViewKickPitchMax` and
 * `adsViewKickPitchMax` are >= 0 in every one of the 1503 weapon files of Modern
 * Warfare 2, 3 and Ghosts, while the matching `GunKickPitchMax` is negative in
 * 613 of them. A gun kicks up, so this is the family whose positive is up — and
 * the gun kick has no single convention to read at all, which is consistent with
 * its being the model's own rocking (docs/cod/reference.md#the-two-recoils).
 */
export function addViewKick(kick: ViewKick, motion: Record<string, number>, ads: number, stream: number): void {
  // **Assigned, not accumulated** — the engine's own `fstp`, not `fadd`. A round
  // replaces whatever the view was doing with its own throw; what carries over
  // from the round before is the angle it left behind.
  kick.pitchVel = hold(between(motion, "ViewKickPitch", ads, draw(stream, 2)) * VIEW_KICK_SCALE, VIEW_KICK_SPEED_LIMIT);
  kick.yawVel = hold(between(motion, "ViewKickYaw", ads, draw(stream, 3)) * VIEW_KICK_SCALE, VIEW_KICK_SPEED_LIMIT);
}

/**
 * `dt` seconds of settling: the angle moves at its speed and is pulled back by
 * `GunKickStaticDecay`, while the speed bleeds off at `GunKickSpeedDecay`. Both
 * decays are exponential in `dt`, so the result is the same whether a second is
 * taken in one step or sixty — which is what a server replaying a client's own
 * step lengths depends on.
 */
export function decayKick(kick: KickState, motion: Record<string, number>, ads: number, dt: number): void {
  const speedDecay = Math.exp(-mix(motion, "hipGunKickSpeedDecay", "adsGunKickSpeedDecay", ads, DEFAULT_SPEED_DECAY) * dt);
  const staticDecay = Math.exp(-mix(motion, "hipGunKickStaticDecay", "adsGunKickStaticDecay", ads, DEFAULT_STATIC_DECAY) * dt);
  kick.pitch = hold((kick.pitch + kick.pitchSpeed * dt) * staticDecay, KICK_LIMIT);
  kick.yaw = hold((kick.yaw + kick.yawSpeed * dt) * staticDecay, KICK_LIMIT);
  kick.pitchSpeed *= speedDecay;
  kick.yawSpeed *= speedDecay;
}

/** Degrees a second squared the view is pulled back at: the weapon's own `ViewKickCenterSpeed`. */
function centreAccel(motion: Record<string, number>, ads: number): number {
  return mix(motion, "hipViewKickCenterSpeed", "adsViewKickCenterSpeed", ads, 0) * VIEW_KICK_SCALE;
}

/**
 * `dt` seconds of the thrown view falling back toward the aim, in fixed
 * `VIEW_KICK_SUBSTEP` steps. Modern Warfare 3's `UpdateKickAngles`, which is
 * where `ViewKickCenterSpeed` is actually consumed
 * (reverse/iw5-view-kick/README.md).
 *
 * Per axis, per sub-step: the acceleration always opposes **where the view is**,
 * not where it is going, so a round thrown upward decelerates, stops, and is
 * pulled back down. A step that travels back toward the aim keeps only
 * `VIEW_KICK_RETURN` of itself, which is what makes the fall four times longer
 * than the rise and lets a fast weapon's next round start part way up.
 *
 * **Reaching the aim point stops it dead**: crossing zero sets both the angle and
 * the speed to zero rather than letting it swing through, so a settled weapon is
 * exactly at rest and a rested axis is skipped entirely. That exactness is what
 * a `toEqual` and the wire's zero both depend on, and it is the engine's own
 * behaviour rather than a tidy-up.
 */
export function stepViewKick(kick: ViewKick, motion: Record<string, number>, ads: number, dt: number): void {
  const accel = centreAccel(motion, ads);
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(VIEW_KICK_SUBSTEP, left);
    left -= h;
    const pitch = fall(kick.pitch, kick.pitchVel, accel, h);
    kick.pitch = pitch.angle;
    kick.pitchVel = pitch.speed;
    const yaw = fall(kick.yaw, kick.yawVel, accel, h);
    kick.yaw = yaw.angle;
    kick.yawVel = yaw.speed;
  }
}

/** One axis, one sub-step. Shared out rather than duplicated, since pitch and yaw differ in nothing. */
const FALLEN = { angle: 0, speed: 0 };

function fall(angle: number, speed: number, accel: number, h: number): { angle: number; speed: number } {
  if (angle === 0 && speed === 0) {
    // At rest, and the engine skips a rested axis outright. Without this the
    // acceleration would push a settled view off centre and it would chatter
    // about zero for ever.
    FALLEN.angle = 0;
    FALLEN.speed = 0;
    return FALLEN;
  }
  // Positive zero counts as positive, as the engine's own `< 0` test does.
  const next = hold(speed - (angle < 0 ? -1 : 1) * accel * h, VIEW_KICK_SPEED_LIMIT);
  let step = next * h;
  if (step * angle < 0) {
    step *= VIEW_KICK_RETURN;
  }
  const moved = angle + step;
  if (angle * moved < 0) {
    FALLEN.angle = 0;
    FALLEN.speed = 0;
    return FALLEN;
  }
  if (moved > VIEW_KICK_LIMIT || moved < -VIEW_KICK_LIMIT) {
    // Pinned at the stop with no speed left, which is the engine's own pair of
    // writes: a saturated weapon is *held* at ten degrees rather than still
    // pushing into it.
    FALLEN.angle = moved < 0 ? -VIEW_KICK_LIMIT : VIEW_KICK_LIMIT;
    FALLEN.speed = 0;
    return FALLEN;
  }
  FALLEN.angle = moved;
  FALLEN.speed = next;
  return FALLEN;
}

/**
 * How hot the weapon is after `dt` and `shots`: **a fraction in [0, 1]**, not an
 * angle. `shotSpread` is what turns it into degrees.
 *
 * A fraction because that is the quantity the weapon files are written in, which
 * is not what the names suggest: `fireAdd`, `moveAdd` and `decayRate` are
 * fractions of the weapon's own `hipStandMin`→`hipStandMax` range, and the game
 * keeps this accumulator on the player as a 0..255 scalar
 * (reverse/iw5-bullet-spread/README.md). Read as degrees instead, an M4's
 * `fireAdd` of 0.6 takes six rounds to open the cone the two it should, and its
 * `decayRate` of 4 closes it fifteen times too slowly.
 *
 * `turnAdd` is not read: it is 0 on all 135 catalogue weapons, so wiring it would
 * be a rate constant nothing in either game could check.
 */
export function stepSpread(spread: number, s: WeaponSpread | undefined, shots: number, holder: Holder, dt: number, ads: number): number {
  if (!s) {
    return 0;
  }
  // Fully aimed, only the decay runs: the game gates both adds on `adsFrac != 1`
  // (FUN_0042abc0 for the shot, FUN_004283c0 for the movement).
  const aimed = ads >= 1;
  const moving = Math.min(1, Math.max(0, holder.speed) / RUN_SPEED);
  const grown = spread + (aimed ? 0 : (s.fireAdd ?? 0) * shots + (s.moveAdd ?? 0) * moving * dt) - (s.decayRate ?? 0) * dt;
  return Math.min(1, Math.max(0, grown));
}

/**
 * The cone this shot leaves in, degrees, at `heat` and `ads`.
 *
 * Two interpolations and not one, which is the game's own arithmetic
 * (FUN_00530920). The second is the surprising one: the aimed cone runs from
 * `spread.ads` up to the **hip** maximum, so a weapon whose accumulator is
 * saturated shoots exactly as wide aimed as it does from the hip. Aiming does
 * not cool the gun down; it only stops it heating up. What makes aiming accurate
 * is that `spread.ads` is 0 on all but a shotgun and a few pistols, and that
 * somebody lining a shot up has usually let the weapon settle.
 *
 * `hipStandMin`/`Max` and not a stance triple because this engine has no stance:
 * the game blends its three pairs on view height, and only the standing pair is
 * ever reachable here (reverse/iw5-bullet-spread/README.md).
 */
export function shotSpread(def: WeaponDef, heat: number, ads: number): number {
  const s = def.spread;
  if (!s) {
    return 0;
  }
  const max = Math.min(SPREAD_LIMIT, s.hipStandMax ?? 0);
  const min = Math.min(max, s.hipStandMin ?? 0);
  const hip = min + (max - min) * heat;
  const sights = Math.min(max, s.ads ?? 0);
  return hip + (sights + (max - sights) * heat - hip) * ads;
}

/**
 * The two numbers one round's cone is sampled with, both in [0, 1): an angle
 * around the crosshair, and **how far out as a fraction of the cone's radius**.
 *
 * Draws 4 and 5, after the gun kick's two and the view kick's two, so no two of
 * the three quantities a shot produces can share a number.
 */
export function coneSample(stream: number, out: { angle: number; radius: number }): { angle: number; radius: number } {
  out.angle = draw(stream, 4) * 2 * Math.PI;
  out.radius = draw(stream, 5);
  return out;
}

/** Where a player is pointing: their own angles, radians. */
export interface Aim {
  yaw: number;
  pitch: number;
}

/**
 * Where a shot actually goes: the player's intent, **plus the view kick**.
 *
 * The gun kick is deliberately not here. It rocks the model in the hands and
 * nothing else (engine/weaponMotion.ts); putting it here was reading the wrong
 * family, and it disarmed every scoped sniper, whose `adsGunKickPitch` is zero.
 *
 * Read only. The kick is never written back into `movement.yaw`, and this is the
 * whole reason it is a function rather than a field: `PlayerInput.yaw` is built
 * from the view, `stepMovement` assigns `s.yaw = input.yaw`, and the view is read
 * back off `movement.yaw` — so a kick stored there is fed in as intent on the
 * next step and climbs until the gun points at the ceiling.
 */
export function aimAngles(intent: { readonly yaw: number; readonly pitch: number }, kick: ReadKick | null | undefined, out: Aim = { yaw: 0, pitch: 0 }): Aim {
  out.yaw = intent.yaw + (kick ? kick.yaw * DEG : 0);
  // Positive view-kick pitch is upward, and so is the simulation's (`addViewKick`).
  out.pitch = clampPitch(intent.pitch + (kick ? kick.pitch * DEG : 0));
  return out;
}

/**
 * The unit vector `aim` points along. Yaw 0 faces -z and pitch is up positive,
 * which is the camera's own two lines (engine/controls/firstPerson.ts, YXZ).
 */
export function aimDirection(aim: Aim, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const flat = Math.cos(aim.pitch);
  out.x = -Math.sin(aim.yaw) * flat;
  out.y = Math.sin(aim.pitch);
  out.z = -Math.cos(aim.yaw) * flat;
  return out;
}

/**
 * Where one round actually leaves, given the line the player was on and the cone
 * it is allowed to wander in: `direction` is nudged in place and stays unit.
 *
 * **The radius is the raw draw and deliberately not its square root.** Sampling a
 * disc uniformly *by area* is the textbook correction and is the wrong answer
 * here: Modern Warfare 3 takes no square root (FUN_004f5190), so its cone is
 * centre-weighted and the average round lands a third of the way out rather than
 * two thirds. Uniform by area, every weapon in the catalogue is twice as
 * inaccurate as the one the numbers describe, and the weapon files look like they
 * need tuning when what needs fixing is this line.
 *
 * `tan` of the cone, because the game offsets the *endpoint* in the plane at the
 * bullet's reach and then renormalizes; the reach divides out, so it is not a
 * parameter here (reverse/iw5-bullet-spread/README.md).
 *
 * The offset is built on a basis derived from `direction` rather than from the
 * player's yaw, so it is a cone about the line actually fired along — view kick
 * included — and behaves at any pitch, where a yaw/pitch offset would open up
 * near the poles.
 */
export function spreadDirection(
  direction: { x: number; y: number; z: number },
  coneDegrees: number,
  sample: { angle: number; radius: number },
): { x: number; y: number; z: number } {
  if (!(coneDegrees > 0)) {
    return direction;
  }
  const reach = Math.tan(coneDegrees * DEG) * sample.radius;
  // Right is horizontal by construction, so this is the camera's own screen
  // plane and the cone is round on screen rather than sheared by pitch.
  const flat = Math.hypot(direction.x, direction.z);
  // Straight up or down leaves right undetermined; any perpendicular pair does,
  // and world x/z are one.
  const rx = flat > 1e-6 ? -direction.z / flat : 1;
  const rz = flat > 1e-6 ? direction.x / flat : 0;
  // Up = right × direction: unit already, since the two are unit and perpendicular.
  const ux = -rz * direction.y;
  const uy = rz * direction.x - rx * direction.z;
  const uz = rx * direction.y;
  const c = Math.cos(sample.angle) * reach;
  const s = Math.sin(sample.angle) * reach;
  // No `c` term on y: right is horizontal, so its y component is zero.
  const x = direction.x + rx * c + ux * s;
  const y = direction.y + uy * s;
  const z = direction.z + rz * c + uz * s;
  const length = Math.hypot(x, y, z) || 1;
  direction.x = x / length;
  direction.y = y / length;
  direction.z = z / length;
  return direction;
}
