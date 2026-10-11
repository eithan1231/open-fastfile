// Spread and recoil as simulation (src/sim/recoil.ts): that a shot's randomness
// is the same number on both ends, that the cone grows and decays where the
// weapon file says, and — the one that matters most — that the kick is added at
// *read* time and never accumulated into the player's own yaw.
//
// The fixtures are the MW3 M4's and L96's own numbers rather than round ones, for
// a reason worth stating: several of the mistakes this file exists to catch are
// invisible against a symmetric weapon. `hipGunKickPitchMin: 5` sits *above*
// `hipGunKickPitchMax: -15`, so the pitch pair catches a min/max confusion; the
// gun kick's yaw pair (5 / -5) is symmetric and would not. `fireAdd` is 0.6
// against a `decayRate` of 4, so neither can stand in for the other, and
// `moveAdd` is 5 rather than 1, so dropping the multiplier is not a no-op.
//
// The L96 is here for the view kick and is chosen the same way. Its
// `adsGunKickPitch` is 0/0 — a scoped sniper's whole recoil is view kick, which
// is why the two families cannot be treated as one — its `adsViewKickPitch` is
// 30/85, both ends the same side of zero so a sign flip cannot hide, and its
// `adsViewKickYaw` is 70/-75, which spans zero *and* is written high to low, so
// a swapped min and max draws a different number rather than a mirrored range.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { roundTrip } from "../src/net/codec/schema.js";
import { weaponSchema } from "../src/net/messages/player.js";
import { hashString } from "../src/game/random.js";
import { idleInput, type PlayerInput } from "../src/sim/input.js";
import { clampPitch, RUN_SPEED, STAND_EYE_HEIGHT } from "../src/sim/movement.js";
import { CROUCH_EYE_HEIGHT, PRONE_EYE_HEIGHT } from "../src/sim/stance.js";
import { Player } from "../src/sim/player.js";
import {
  addViewKick,
  aimAngles,
  draw,
  coneSample,
  shotSpread,
  restingViewKick,
  shotStream,
  spreadDirection,
  stepSpread,
  VIEW_KICK_SCALE,
  VIEW_KICK_SUBSTEP,
  VIEW_KICK_LIMIT,
  type KickState,
  type ViewKick,
} from "../src/sim/recoil.js";
import { WeaponController, type WeaponData } from "../src/sim/weapon.js";
import type { WeaponDef, WeaponSpread } from "../src/sim/weaponDef.js";
import { weaponDef } from "../testing/weaponDef.js";

const DT = 1 / 60;
const DEG = Math.PI / 180;

/** The MW3 M4's gun kick, copied out of `worlds/catalog/weapons/iw5/iw5_m4_mp`. */
const M4_MOTION: Record<string, number> = {
  hipGunKickPitchMin: 5,
  hipGunKickPitchMax: -15,
  hipGunKickYawMin: 5,
  hipGunKickYawMax: -5,
  hipGunKickAccel: 800,
  hipGunKickSpeedMax: 2000,
  hipGunKickSpeedDecay: 16,
  hipGunKickStaticDecay: 20,
  adsGunKickPitchMin: -40,
  adsGunKickPitchMax: 0,
  adsGunKickSpeedDecay: 32,
  adsGunKickStaticDecay: 40,
  hipViewKickPitchMin: -30,
  hipViewKickPitchMax: 50,
  hipViewKickYawMin: 40,
  hipViewKickYawMax: -40,
  hipViewKickCenterSpeed: 1500,
  adsViewKickPitchMin: -20,
  adsViewKickPitchMax: 50,
  adsViewKickYawMin: 40,
  adsViewKickYawMax: -40,
  adsViewKickCenterSpeed: 1350,
};

/**
 * The MW3 L96's, from the same dump. Every gun-kick pitch key is 0 while both
 * view-kick pitch keys are large and positive: this weapon is the proof that the
 * two families are different quantities, and it is what a build reading only the
 * gun kick gives no recoil at all.
 */
const L96_MOTION: Record<string, number> = {
  hipGunKickPitchMin: 80,
  hipGunKickPitchMax: 85,
  adsGunKickPitchMin: 0,
  adsGunKickPitchMax: 0,
  adsGunKickYawMin: 0,
  adsGunKickYawMax: 0,
  hipViewKickPitchMin: 80,
  hipViewKickPitchMax: 100,
  hipViewKickYawMin: -50,
  hipViewKickYawMax: -55,
  hipViewKickCenterSpeed: 500,
  adsViewKickPitchMin: 30,
  adsViewKickPitchMax: 85,
  adsViewKickYawMin: 70,
  adsViewKickYawMax: -75,
  adsViewKickCenterSpeed: 500,
};

/**
 * The MW3 ACR's, and the one weapon that separates the two axes cleanly. Its
 * aimed pitch is 32/34 — a dead-steady climb with almost no randomness in it,
 * which is what "the ACR has no recoil" actually means — against an aimed yaw of
 * +-50, the widest lateral of any assault rifle. A build that narrows a draw
 * toward its midpoint costs this weapon nearly all of its character and almost
 * none of the M4's, so it is the fixture that catches one.
 *
 * Its hip pitch is the other half: -20/40, a mean of 10 against an aimed 33.
 * That gap is why hip fire does not raise the screen and a full aim does.
 */
const ACR_MOTION: Record<string, number> = {
  hipViewKickPitchMin: -20,
  hipViewKickPitchMax: 40,
  hipViewKickYawMin: 30,
  hipViewKickYawMax: -30,
  hipViewKickCenterSpeed: 1500,
  adsViewKickPitchMin: 32,
  adsViewKickPitchMax: 34,
  adsViewKickYawMin: 50,
  adsViewKickYawMax: -50,
  adsViewKickCenterSpeed: 1350,
};

/** The same weapon's hip spread. */
const M4_SPREAD: WeaponSpread = {
  ads: 0,
  hipStandMin: 3.5,
  hipStandMax: 7,
  fireAdd: 0.6,
  turnAdd: 0,
  moveAdd: 5,
  decayRate: 4,
};

function m4(over: Partial<WeaponDef> = {}): WeaponDef {
  return weaponDef({ clipSize: 30, motion: M4_MOTION, spread: M4_SPREAD, ...over });
}

/** The ACR, held at a full aim or from the hip, with a round every 0.085 s. */
function acr(): WeaponController {
  const weapon = new WeaponController(weaponDef({ clipSize: 30, motion: ACR_MOTION, times: { fire: 0.085, adsIn: 0.3, adsOut: 0.3 } }));
  weapon.ready();
  return weapon;
}

/** Hold the trigger for a magazine and report the kick as each round left. */
function magazine(weapon: WeaponController, seed: number, ads: boolean, rounds = 30): ViewKick[] {
  weapon.setInput({ ads });
  for (let i = 0; i < 60; i++) {
    weapon.update(DT, { seed, speed: 0 });
  }
  weapon.setInput({ trigger: true, ads });
  const at: ViewKick[] = [];
  let last = weapon.data.fired;
  for (let i = 0; i < 2000 && at.length < rounds; i++) {
    weapon.update(DT, { seed, speed: 0 });
    if (weapon.data.fired !== last) {
      last = weapon.data.fired;
      at.push({ ...weapon.data.viewKick });
    }
  }
  expect(at).toHaveLength(rounds);
  weapon.setInput({ trigger: false, ads });
  return at;
}

/**
 * The sniper, with the rifle's own cycle: 0.266 s of shot and 0.93 s of bolt, so
 * `L96_CYCLE` below is the weapon's arithmetic and not a number written twice.
 * A fixture on the test weapon's default 0.1 s `fireTime` could not say whether
 * the kick settles *in time*, which is half of what the recentre rate is for.
 */
const L96_TIMES = { fire: 0.266, rechamber: 0.93, adsIn: 0.4, adsOut: 0.4 };
const L96_CYCLE = L96_TIMES.fire + L96_TIMES.rechamber;

function l96(over: Record<string, number> = {}): WeaponController {
  const weapon = new WeaponController(
    weaponDef({ clipSize: 5, fireType: "Single Shot", boltAction: true, times: L96_TIMES, motion: { ...L96_MOTION, ...over } }),
  );
  weapon.ready();
  return weapon;
}

/** One aimed shot from `weapon`, with the sights already all the way up. */
function aimedShot(weapon: WeaponController, seed: number): void {
  weapon.setInput({ ads: true });
  for (let i = 0; i < 60; i++) {
    weapon.update(DT, { seed, speed: 0 });
  }
  expect(weapon.data.ads).toBe(1);
  expect(weapon.data.fired).toBe(0);
  weapon.setInput({ trigger: true });
  weapon.update(DT, { seed, speed: 0 });
  weapon.setInput({ trigger: false });
  expect(weapon.data.fired).toBe(1);
}

/** A floor, so a player has something to stand on while they empty a magazine. */
function ground(): CollisionWorld {
  const root = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40));
  floor.position.set(0, -0.5, 0);
  floor.userData.collide = true;
  root.add(floor);
  const world = new CollisionWorld();
  world.rebuild(root);
  return world;
}

function armed(seed: number, over: Partial<WeaponDef> = {}): Player {
  const player = new Player(ground());
  player.setSeed(seed);
  const weapon = new WeaponController(m4(over));
  weapon.ready();
  player.equip(weapon);
  return player;
}

const kickOf = (player: Player): KickState => structuredClone(player.snapshot().weapon!.kick);
const viewKickOf = (player: Player): ViewKick => structuredClone(player.snapshot().weapon!.viewKick);
const firedBy = (player: Player): number => player.snapshot().weapon!.fired;

describe("the kick is never accumulated into the player's own yaw", () => {
  /**
   * The headline. This reproduces the loop that makes a kick dangerous, which is
   * real and lives in engine/controls/firstPerson.ts: the view is read back off
   * `movement.yaw`, that becomes `PlayerInput.yaw`, and `stepMovement` assigns it
   * straight back. Anything that writes the kick into the state on the way round
   * compounds it every single tick.
   */
  it("leaves yaw and pitch exactly where the mouse left them, over a whole magazine", () => {
    const player = armed(hashString("shooter"));
    const YAW = 0.7;
    const PITCH = -0.2;
    player.place({ x: 0, y: 0, z: 0 }, YAW, PITCH);
    const command: PlayerInput = { ...idleInput(YAW, PITCH), fire: true };

    // How far the aim was ever thrown off the intent while the magazine emptied.
    // Read inside the loop rather than after it, because the view kick recentres:
    // a weapon whose kick is gone by the last tick would still have been kicking
    // all the way through, and that is what has to not have leaked into the state.
    let thrownPitch = 0;
    let thrownYaw = 0;
    for (let i = 0; i < 400 && firedBy(player) < 30; i++) {
      // Exactly what the client does each tick: the command's angles come off the
      // player's own state, plus whatever the mouse has done — which here is
      // nothing at all, so anything that moves them came from the gun.
      command.yaw = player.movement.yaw;
      command.pitch = player.movement.pitch;
      player.step(command, DT);
      const aim = aimAngles(player.movement, viewKickOf(player));
      thrownPitch = Math.max(thrownPitch, Math.abs(aim.pitch - player.movement.pitch));
      thrownYaw = Math.max(thrownYaw, Math.abs(aim.yaw - player.movement.yaw));
    }

    expect(firedBy(player)).toBe(30);
    expect(player.movement.yaw).toBe(YAW);
    expect(player.movement.pitch).toBe(clampPitch(PITCH));

    // And the test is not vacuous: the aim really was thrown off, both ways, and
    // the gun really did rock. Without these a recoil that did nothing at all
    // would pass above.
    expect(thrownPitch).toBeGreaterThan(0.005);
    expect(thrownYaw).toBeGreaterThan(0.005);
    expect(Math.abs(kickOf(player).pitch)).toBeGreaterThan(0.05);
  });

  it("settles back to the player's own angles once they stop firing", () => {
    const player = armed(hashString("shooter"));
    const firing: PlayerInput = { ...idleInput(0, 0), fire: true };
    for (let i = 0; i < 60; i++) {
      player.step(firing, DT);
    }
    expect(Math.abs(kickOf(player).pitch)).toBeGreaterThan(0.05);

    for (let i = 0; i < 300; i++) {
      player.step(idleInput(0, 0), DT);
    }
    // Exactly zero, not merely small: a rate that walks to zero and stops is what
    // `centreViewKick` is, and an exponential would leave a residue for ever.
    expect(viewKickOf(player)).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
    const settled = aimAngles(player.movement, viewKickOf(player));
    expect(settled.yaw).toBe(0);
    expect(settled.pitch).toBe(0);
  });

  it("does not touch what it is handed", () => {
    const intent = { yaw: 0.5, pitch: 0.1 };
    const kick: ViewKick = { pitch: 3, yaw: 2, pitchVel: 40, yawVel: -10 };
    aimAngles(intent, kick);
    expect(intent).toEqual({ yaw: 0.5, pitch: 0.1 });
    expect(kick).toEqual({ pitch: 3, yaw: 2, pitchVel: 40, yawVel: -10 });
  });
});

describe("the seeded stream", () => {
  it("brings two ends that hash the same id to the same kick after thirty shots", () => {
    const a = armed(hashString("abc12345"));
    const b = armed(hashString("abc12345"));
    const firing: PlayerInput = { ...idleInput(0.3, -0.1), fire: true };
    for (let i = 0; i < 400 && firedBy(a) < 30; i++) {
      a.step(firing, DT);
      b.step(firing, DT);
    }
    expect(firedBy(a)).toBe(30);
    expect(kickOf(b)).toEqual(kickOf(a));
    expect(viewKickOf(b)).toEqual(viewKickOf(a));
    expect(Math.abs(kickOf(a).pitch)).toBeGreaterThan(0.05);
  });

  it("gives two different players different patterns, so the stream is really keyed on them", () => {
    const a = armed(hashString("abc12345"));
    const b = armed(hashString("zyx54321"));
    const firing: PlayerInput = { ...idleInput(0, 0), fire: true };
    for (let i = 0; i < 400 && firedBy(a) < 30; i++) {
      a.step(firing, DT);
      b.step(firing, DT);
    }
    // Same weapon, same inputs, same number of rounds: only the seed differs.
    expect(firedBy(b)).toBe(firedBy(a));
    expect(kickOf(b).pitch).not.toBeCloseTo(kickOf(a).pitch, 4);
  });

  it("draws the same numbers for a shot however the step that fired it was cut up", () => {
    // A stream is a pure function of (seed, ordinal), with no counter carried
    // along: a tick that drains four of a client's inputs must draw what four
    // ticks of one input each drew.
    const seed = hashString("abc12345");
    for (const ordinal of [1, 2, 30, 65535]) {
      expect(draw(shotStream(seed, ordinal), 0)).toBe(draw(shotStream(seed, ordinal), 0));
    }
    expect(shotStream(seed, 1)).not.toBe(shotStream(seed, 2));
    // And a pellet index moves it, which is the shape a shotgun will want.
    expect(shotStream(seed, 1, 1)).not.toBe(shotStream(seed, 1, 0));
    expect(draw(shotStream(seed, 1), 0)).not.toBe(draw(shotStream(seed, 1), 1));
  });
});

describe("the kick itself", () => {
  /**
   * A min and a max are a range, not an order: the M4's `hipGunKickPitchMin` is 5
   * and its `hipGunKickPitchMax` is -15. Reading them as bounds to clamp between
   * would pin every shot at +5 and drive the gun the other way, which is why this
   * asserts on the pitch pair and not the yaw pair — the yaw pair is symmetric
   * and would look the same either way.
   */
  it("rocks the M4's model the way its own numbers say", () => {
    const player = armed(hashString("shooter"));
    const firing: PlayerInput = { ...idleInput(0, 0), fire: true };
    for (let i = 0; i < 400 && firedBy(player) < 30; i++) {
      player.step(firing, DT);
    }
    expect(kickOf(player).pitch).toBeLessThan(0);
  });

  /**
   * The gun kick is a drawing effect and must not reach the aim. A weapon that
   * carries gun kick and no view kick is exactly the scoped-sniper case turned
   * round, and it is the only fixture that can catch the old wiring: with both
   * families present, a build still feeding the gun kick to `aimAngles` would
   * only be a little wrong, which no assertion on a magnitude would notice.
   */
  it("does not let the gun kick reach the aim", () => {
    const onlyGun: Record<string, number> = {};
    for (const [key, value] of Object.entries(M4_MOTION)) {
      if (!key.includes("ViewKick")) {
        onlyGun[key] = value;
      }
    }
    const player = armed(hashString("shooter"), { motion: onlyGun });
    const firing: PlayerInput = { ...idleInput(0.3, -0.1), fire: true };
    for (let i = 0; i < 400 && firedBy(player) < 30; i++) {
      player.step(firing, DT);
    }
    expect(Math.abs(kickOf(player).pitch)).toBeGreaterThan(0.05);
    expect(viewKickOf(player)).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
    const aim = aimAngles(player.movement, viewKickOf(player));
    expect(aim.pitch).toBe(player.movement.pitch);
    expect(aim.yaw).toBe(player.movement.yaw);
  });

  it("puts the min end of the range at r = 0 and the max end at r = 1", () => {
    // The mapping itself, on the one shot whose stream can be worked out by hand.
    // A swapped pair draws from the same range and so is invisible to any test
    // that only looks at the distribution; it is visible here.
    const seed = hashString("shooter");
    const r = draw(shotStream(seed, 1), 0);
    const expected = 5 + (-15 - 5) * r;

    const weapon = new WeaponController(m4());
    weapon.ready();
    weapon.setInput({ trigger: true });
    weapon.update(DT, { seed, speed: 0 });
    expect(weapon.data.fired).toBe(1);
    // One step of decay has been applied to the impulse since it went in.
    expect(weapon.data.kick.pitchSpeed).toBeCloseTo(expected * Math.exp(-16 * DT), 9);
  });

  it("is timed on dt, not on the step: a second taken in one step lands where sixty do", () => {
    // The property a fixed tick buys, and the one the old per-frame integrator
    // did not have. Both fire one round and then settle for a second.
    const coarse = new WeaponController(m4());
    const fine = new WeaponController(m4());
    for (const w of [coarse, fine]) {
      w.ready();
      w.setInput({ trigger: true });
      w.update(1 / 600, { seed: 7, speed: 0 });
      expect(w.data.fired).toBe(1);
      w.setInput({ trigger: false });
    }
    coarse.update(1, { seed: 7, speed: 0 });
    for (let i = 0; i < 60; i++) {
      fine.update(1 / 60, { seed: 7, speed: 0 });
    }
    // Both have settled to nothing, and to the same nothing.
    expect(coarse.data.kick.pitch).toBeCloseTo(fine.data.kick.pitch, 6);
    expect(coarse.data.kick.pitchSpeed).toBeCloseTo(fine.data.kick.pitchSpeed, 6);
    expect(Math.abs(coarse.data.kick.pitch)).toBeLessThan(1e-4);
  });

  it("survives the wire: a controller restored from a snapshot stays within a quantum", () => {
    const a = armed(hashString("abc12345"));
    const firing: PlayerInput = { ...idleInput(0, 0), fire: true };
    for (let i = 0; i < 90; i++) {
      a.step(firing, DT);
    }

    const sent = a.snapshot().weapon!;
    const wire = roundTrip(weaponSchema, structuredClone(sent) as WeaponData);
    const b = armed(hashString("abc12345"));
    b.restore({ ...a.snapshot(), weapon: wire });

    // Whatever the wire lost, it lost once: stepping both on from here does not
    // let the difference grow. 12 bits over ±64° is a thirty-second of a degree,
    // and the view kick's own ±32 in the same width is a sixty-fourth.
    const quantum = 64 / (2 ** 11 - 1);
    const viewQuantum = VIEW_KICK_LIMIT / (2 ** 11 - 1);
    expect(Math.abs(wire.kick.pitch - sent.kick.pitch)).toBeLessThanOrEqual(quantum);
    expect(Math.abs(wire.viewKick.pitch - sent.viewKick.pitch)).toBeLessThanOrEqual(viewQuantum);
    for (let i = 0; i < 60; i++) {
      a.step(firing, DT);
      b.step(firing, DT);
    }
    expect(firedBy(b)).toBe(firedBy(a));
    expect(Math.abs(kickOf(b).pitch - kickOf(a).pitch)).toBeLessThanOrEqual(quantum);
    expect(Math.abs(kickOf(b).yaw - kickOf(a).yaw)).toBeLessThanOrEqual(quantum);
    // The view kick's own tolerance is a quantum **plus one tick of falling**,
    // and the extra tick is not slack: `cooldown` rounds to 1/256 of a second on
    // the wire, which can bring a corrected client's next shot a tick early, and
    // a view still travelling is then a whole step out of phase. Measured — the
    // two really do run a tick apart here — not a margin chosen to pass.
    const phase = 1500 * VIEW_KICK_SCALE * DT * DT;
    expect(Math.abs(viewKickOf(b).pitch - viewKickOf(a).pitch)).toBeLessThanOrEqual(viewQuantum + phase);
    expect(Math.abs(viewKickOf(b).yaw - viewKickOf(a).yaw)).toBeLessThanOrEqual(viewQuantum + phase);
    // And the wire's exact zero is exact: a gun at rest must carry no bias at all.
    const rested = roundTrip(weaponSchema, structuredClone(new WeaponController(m4()).data) as WeaponData);
    expect(rested.kick).toEqual({ pitch: 0, yaw: 0, pitchSpeed: 0, yawSpeed: 0 });
    expect(rested.viewKick).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
  });

  it("holds a weapon file that never settles to the wire's own range", () => {
    // Several catalogue weapons carry a `GunKickStaticDecay` of 0, which
    // integrates without bound. The simulation clamps rather than the codec,
    // so the two cannot disagree about what a kick may be.
    const wild = new WeaponController(m4({ motion: { ...M4_MOTION, hipGunKickStaticDecay: 0, hipGunKickSpeedDecay: 0 } }));
    wild.ready();
    wild.setInput({ trigger: true });
    for (let i = 0; i < 600; i++) {
      wild.update(DT, { seed: 3, speed: 0 });
    }
    expect(Math.abs(wild.data.kick.pitch)).toBeLessThanOrEqual(64);
    expect(Math.abs(wild.data.kick.pitchSpeed)).toBeLessThanOrEqual(2048);
  });
});

describe("the spread", () => {
  it("accumulates a fraction of the weapon's range, not an angle", () => {
    const at = { seed: 0, speed: 0 };
    // One shot from cold: `fireAdd` of the whole min-to-max range, less the decay
    // that same step pays for. Both are fractions -- read as degrees this line
    // would be 3.5 + 0.6 and the gun would take six rounds to do its two.
    expect(stepSpread(0, M4_SPREAD, 1, at, DT, 0)).toBeCloseTo(0.6 - 4 * DT, 9);
    // Two shots in one step are two rounds' worth, not one.
    const gentle = { ...M4_SPREAD, fireAdd: 0.2 };
    expect(stepSpread(0, gentle, 2, at, DT, 0)).toBeCloseTo(0.4 - 4 * DT, 9);
    // An M4's own 0.6 means two rounds saturate it outright, which is the point
    // of the units: read as degrees it would need six to do the same.
    expect(stepSpread(0, M4_SPREAD, 2, at, DT, 0)).toBe(1);
    // A tenth of a second of no shots is exactly a second's decay tenthed.
    expect(stepSpread(0.8, M4_SPREAD, 0, at, 0.1, 0)).toBeCloseTo(0.4, 9);
    // Cold is 0 and saturated is 1; neither end runs past itself.
    expect(stepSpread(0.05, M4_SPREAD, 0, at, 1, 0)).toBe(0);
    expect(stepSpread(0.9, M4_SPREAD, 30, at, DT, 0)).toBe(1);
  });

  it("opens while moving, but only above the speed where it outruns the decay", () => {
    // `moveAdd` is a rate set against `decayRate`, not a floor the cone is held
    // at, so the two compete. An M4 adds 5 a second at a full run against 4 of
    // decay: at half speed it is 2.5 against 4 and the weapon still settles.
    // A fixture at full speed only would multiply `moveAdd` by one and hide it.
    const jogging = { seed: 0, speed: RUN_SPEED / 2 };
    expect(stepSpread(0.5, M4_SPREAD, 0, jogging, 0.1, 0)).toBeCloseTo(0.5 + (2.5 - 4) * 0.1, 9);
    const running = { seed: 0, speed: RUN_SPEED };
    expect(stepSpread(0.5, M4_SPREAD, 0, running, 0.1, 0)).toBeCloseTo(0.5 + (5 - 4) * 0.1, 9);
  });

  it("stops opening at a full aim, and still settles", () => {
    // The game gates both adds on the aim being short of complete
    // (reverse/iw5-bullet-spread), so a weapon fired down the sights only decays.
    const running = { seed: 0, speed: RUN_SPEED };
    expect(stepSpread(0.5, M4_SPREAD, 1, running, DT, 1)).toBeCloseTo(0.5 - 4 * DT, 9);
    // A hair short of fully aimed is not fully aimed.
    expect(stepSpread(0.5, M4_SPREAD, 1, running, DT, 0.99)).toBeGreaterThan(0.5);
  });

  it("grows while a magazine is emptied and comes back down afterwards", () => {
    const player = armed(hashString("shooter"));
    const firing: PlayerInput = { ...idleInput(0, 0), fire: true };
    expect(player.snapshot().weapon!.spread).toBe(0);

    for (let i = 0; i < 400 && firedBy(player) < 30; i++) {
      player.step(firing, DT);
    }
    const hot = player.snapshot().weapon!.spread;
    expect(hot).toBeGreaterThan(0);
    expect(hot).toBeLessThanOrEqual(1);

    for (let i = 0; i < 120; i++) {
      player.step(idleInput(0, 0), DT);
    }
    expect(player.snapshot().weapon!.spread).toBe(0);
  });

  it("reads the accumulator against the weapon's own min and max", () => {
    const def = m4();
    // Cold is the minimum, saturated the maximum, and halfway is halfway.
    expect(shotSpread(def, 0, 0, STAND_EYE_HEIGHT)).toBe(3.5);
    expect(shotSpread(def, 1, 0, STAND_EYE_HEIGHT)).toBe(7);
    expect(shotSpread(def, 0.5, 0, STAND_EYE_HEIGHT)).toBe(5.25);
  });

  it("blends the stance's own min and max by the height of the eye", () => {
    const def = m4({ spread: { ...M4_SPREAD, hipDuckedMin: 2.5, hipDuckedMax: 6, hipProneMin: 2, hipProneMax: 5 } });
    expect(shotSpread(def, 0, 0, CROUCH_EYE_HEIGHT)).toBe(2.5);
    expect(shotSpread(def, 1, 0, CROUCH_EYE_HEIGHT)).toBe(6);
    expect(shotSpread(def, 0, 0, PRONE_EYE_HEIGHT)).toBe(2);
    expect(shotSpread(def, 1, 0, PRONE_EYE_HEIGHT)).toBe(5);
    // Half way down to a crouch is half way between the two pairs, and likewise below it.
    expect(shotSpread(def, 0, 0, (STAND_EYE_HEIGHT + CROUCH_EYE_HEIGHT) / 2)).toBeCloseTo(3, 10);
    expect(shotSpread(def, 1, 0, (CROUCH_EYE_HEIGHT + PRONE_EYE_HEIGHT) / 2)).toBeCloseTo(5.5, 10);
    // A weapon file with no pair for a stance shoots as it does one stance up.
    expect(shotSpread(m4(), 0, 0, PRONE_EYE_HEIGHT)).toBe(3.5);
    expect(shotSpread(m4({ spread: { ...M4_SPREAD, hipDuckedMin: 2.5 } }), 0, 0, PRONE_EYE_HEIGHT)).toBe(2.5);
  });

  it("closes to the sights' own cone as the player aims", () => {
    const def = m4();
    // `spread.ads` is 0 on everything but a shotgun: aiming a settled M4 is exact.
    expect(shotSpread(def, 0, 1, STAND_EYE_HEIGHT)).toBe(0);
    expect(shotSpread(def, 0, 0.5, STAND_EYE_HEIGHT)).toBe(1.75);
    expect(shotSpread(m4({ spread: { ...M4_SPREAD, ads: 2 } }), 0, 1, STAND_EYE_HEIGHT)).toBe(2);
  });

  it("is no more accurate aimed than from the hip once the weapon is saturated", () => {
    // The game's own arithmetic, and the surprising half of it: the aimed cone
    // runs from `spread.ads` up to the *hip* maximum, so aiming stops the weapon
    // opening further without undoing what a held magazine already did.
    const def = m4();
    expect(shotSpread(def, 1, 1, STAND_EYE_HEIGHT)).toBe(7);
    expect(shotSpread(def, 1, 0, STAND_EYE_HEIGHT)).toBe(7);
  });

  it("is nothing at all for a weapon whose definition carries no spread block", () => {
    // A format-3 GLB, or a definition written by hand in a test. Absent is not
    // "perfectly accurate by accident": nothing grows and nothing decays.
    const bare = new WeaponController(weaponDef({ clipSize: 30, motion: M4_MOTION }));
    bare.ready();
    bare.setInput({ trigger: true });
    for (let i = 0; i < 60; i++) {
      bare.update(DT, { seed: 1, speed: RUN_SPEED });
    }
    expect(bare.data.spread).toBe(0);
    expect(bare.data.fired).toBeGreaterThan(0);
    expect(shotSpread(bare.def, 1, 0, STAND_EYE_HEIGHT)).toBe(0);
  });
});

describe("the cone a round leaves in", () => {
  /** A unit vector's length, to check the sample never denormalizes one. */
  const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

  /** The angle between a deviated round and the line it was aimed along, degrees. */
  function offBy(direction: { x: number; y: number; z: number }, aim: { x: number; y: number; z: number }): number {
    const dot = Math.min(1, Math.max(-1, direction.x * aim.x + direction.y * aim.y + direction.z * aim.z));
    return (Math.acos(dot) * 180) / Math.PI;
  }

  it("leaves a round exactly on the aim when the cone is nothing", () => {
    const aim = { x: 0, y: 0, z: -1 };
    expect(spreadDirection({ ...aim }, 0, { angle: 1, radius: 1 })).toEqual(aim);
  });

  it("never sends a round outside the cone, at any pitch", () => {
    // Straight up and straight down are where a yaw/pitch offset would open out,
    // which is why the basis is built from the direction itself.
    const aims = [
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0.6, y: 0.8, z: 0 },
    ];
    for (const aim of aims) {
      for (let i = 0; i < 64; i++) {
        const direction = spreadDirection({ ...aim }, 5, coneSample(shotStream(7, i), { angle: 0, radius: 0 }));
        expect(len(direction)).toBeCloseTo(1, 9);
        expect(offBy(direction, aim)).toBeLessThanOrEqual(5 + 1e-9);
      }
    }
  });

  it("puts a round at the rim at radius 1 and on the aim at radius 0", () => {
    const aim = { x: 0, y: 0, z: -1 };
    expect(offBy(spreadDirection({ ...aim }, 5, { angle: 0, radius: 1 }), aim)).toBeCloseTo(5, 9);
    expect(offBy(spreadDirection({ ...aim }, 5, { angle: 2, radius: 0 }), aim)).toBeCloseTo(0, 9);
  });

  it("draws the radius linearly, so the cone is centre-weighted", () => {
    // **The finding the whole feature turns on** (reverse/iw5-bullet-spread).
    // Modern Warfare 3 takes no square root, so the mean radius is 1/2 of the
    // cone and the mean *miss* a third of it. Sampled uniformly by area -- the
    // textbook correction -- both would be 2/3, and every weapon would be twice
    // as inaccurate as its own numbers say.
    let total = 0;
    const draws = 20000;
    for (let i = 0; i < draws; i++) {
      total += coneSample(shotStream(11, i), { angle: 0, radius: 0 }).radius;
    }
    expect(total / draws).toBeCloseTo(0.5, 2);
  });

  it("spreads its angle right around the crosshair", () => {
    // Four quadrants, so a sample stuck on one axis or one sign cannot pass.
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const { angle } = coneSample(shotStream(3, i), { angle: 0, radius: 0 });
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(2 * Math.PI);
      seen.add(Math.floor((angle / (2 * Math.PI)) * 4));
    }
    expect(seen.size).toBe(4);
  });

  it("gives a shot's cone its own numbers, and the same ones on both ends", () => {
    // Draws 4 and 5, after the gun kick's 0 and 1 and the view kick's 2 and 3: a
    // round's three quantities must not share a number.
    const stream = shotStream(hashString("shooter"), 4);
    const once = coneSample(stream, { angle: 0, radius: 0 });
    const again = coneSample(stream, { angle: 0, radius: 0 });
    expect(again).toEqual(once);
    expect(coneSample(shotStream(hashString("shooter"), 5), { angle: 0, radius: 0 })).not.toEqual(once);
    expect(once.angle / (2 * Math.PI)).not.toBe(draw(stream, 2));
    expect(once.radius).not.toBe(draw(stream, 3));
  });
});

describe("aim", () => {
  it("is the intent plus the view kick, in the camera's own directions", () => {
    const intent = { yaw: 0, pitch: 0 };
    // View-kick pitch is *positive* upward — the opposite of the gun kick's — and
    // kick yaw is positive to the left, the same sense the simulation's yaw has.
    expect(aimAngles(intent, { pitch: 10, yaw: 0 }).pitch).toBeCloseTo(10 * DEG, 9);
    expect(aimAngles(intent, { pitch: -10, yaw: 0 }).pitch).toBeCloseTo(-10 * DEG, 9);
    expect(aimAngles(intent, { pitch: 0, yaw: 3 }).yaw).toBeCloseTo(3 * DEG, 9);
    expect(aimAngles(intent, null)).toEqual(intent);
  });

  it("cannot be kicked past straight up, however hard the gun climbs", () => {
    const looking = { yaw: 0, pitch: 1.5 };
    expect(aimAngles(looking, { pitch: VIEW_KICK_LIMIT, yaw: 0 }).pitch).toBe(clampPitch(Infinity));
  });
});
/**
 * The view kick: the recoil a player actually fights.
 *
 * It is **ballistic**. A round sets an angular velocity and `ViewKickCenterSpeed`
 * is the acceleration that brings it home, so the view is thrown and falls back
 * — the games' "bounce" — rather than being stepped to an angle outright. The
 * whole model is Modern Warfare 3's `UpdateKickAngles`, read out of `iw5mp.exe`
 * with the Xbox 360 build's symbols (`reverse/iw5-view-kick/README.md`).
 */
describe("the view kick", () => {
  const SEED = hashString("shooter");

  it("sets a speed rather than an angle, which is what makes it a bounce", () => {
    // The distinction the whole model turns on. On the tick a round leaves, the
    // view has barely moved but is travelling fast; the angle is what the fall
    // builds over the ticks after. A build that added the angle outright would
    // have the whole of the kick on this one tick and none after it.
    const rifle = l96();
    aimedShot(rifle, SEED);
    const atShot = rifle.data.viewKick.pitch;
    expect(rifle.data.viewKick.pitchVel).toBeGreaterThan(0);

    // It rises, turns over, and comes back: a bounce and not a step.
    let peak = 0;
    let turned = false;
    for (let i = 0; i < 120; i++) {
      rifle.update(DT, { seed: SEED, speed: 0 });
      if (rifle.data.viewKick.pitch > peak) {
        peak = rifle.data.viewKick.pitch;
      } else if (peak > 0) {
        turned = true;
      }
    }
    expect(peak).toBeGreaterThan(0.1);
    expect(turned).toBe(true);
    // And the tick that fired has only a small part of it: the angle is built by
    // the fall over the ticks after, where a build that added the angle outright
    // would have all of it here and nothing after.
    expect(atShot).toBeLessThan(peak * 0.75);
  });

  it("throws a scoped sniper's aim clearly upward, which is the whole complaint", () => {
    // The sign, on the one weapon that cannot be read two ways: the L96's
    // `adsViewKickPitch` is 30 to 85, both ends above zero, so every draw throws
    // the view the same way and a flipped sign points the rifle at the floor.
    const rifle = l96();
    aimedShot(rifle, SEED);
    for (let i = 0; i < 6; i++) {
      rifle.update(DT, { seed: SEED, speed: 0 });
    }
    const kick = rifle.data.viewKick;
    expect(kick.pitch).toBeGreaterThan(0);
    const aim = aimAngles({ yaw: 0, pitch: 0 }, kick);
    expect(aim.pitch).toBeGreaterThan(0);
    // And it is a kick worth calling one: through a 15° scope, degrees.
    expect(aim.pitch / DEG).toBeGreaterThan(0.1);
    expect(aim.pitch / DEG).toBeLessThan(8);
  });

  it("arms a weapon whose gun kick is identically zero", () => {
    // Every scoped sniper in Modern Warfare 3 has `adsGunKickPitchMin`/`Max` of
    // 0, so a build reading only the gun kick gives it no recoil at all. Both
    // halves are asserted, or a fixture with a gun kick of its own would let a
    // build that still read the wrong one pass.
    const rifle = l96();
    aimedShot(rifle, SEED);
    expect(rifle.data.kick).toEqual({ pitch: 0, yaw: 0, pitchSpeed: 0, yawSpeed: 0 });
    expect(Math.abs(rifle.data.viewKick.pitchVel)).toBeGreaterThan(0);
  });

  it("puts the min end of the range at r = 0 and the max end at r = 1", () => {
    // The L96's aimed yaw is 70 / -75: it spans zero *and* is written high to low,
    // so a swapped pair draws a different number rather than a mirrored range —
    // which is what makes this visible at all. Read off the speed, because that is
    // what a shot sets; the angle is an integral and would hide the ends.
    const stream = shotStream(SEED, 1);
    const pitch = 30 + (85 - 30) * draw(stream, 2);
    const yaw = 70 + (-75 - 70) * draw(stream, 3);
    // Read off `addViewKick` itself rather than out of a stepped weapon: the fall
    // begins on the same tick, and this is about the ends of the range and not
    // about the integrator.
    const kick = restingViewKick();
    addViewKick(kick, L96_MOTION, 1, stream);
    expect(kick.pitchVel).toBeCloseTo(pitch * VIEW_KICK_SCALE, 6);
    expect(kick.yawVel).toBeCloseTo(yaw * VIEW_KICK_SCALE, 6);
    // Drawn from its own pair of numbers, not the gun kick's: sharing draw 0 and
    // 1 would tie the two families together on every weapon whose ranges are alike.
    expect(draw(stream, 2)).not.toBe(draw(stream, 0));
    expect(draw(stream, 3)).not.toBe(draw(stream, 1));
  });

  it("walks a held magazine up the screen, and keeps walking for all of it", () => {
    // The climb is not a rule: it is that the ACR's aimed bounce takes longer
    // than the 0.085 s between its rounds, so each one starts part way up. There
    // is no ceiling — the second half climbs as much as the first, which a model
    // that levels off fails.
    for (const seed of [hashString("shooter"), hashString("second")]) {
      const at = magazine(acr(), seed, true).map((k) => k.pitch);
      const mean = (of: number[]): number => of.reduce((a, b) => a + b, 0) / of.length;
      const opening = mean(at.slice(0, 5));
      const middle = mean(at.slice(12, 18));
      const closing = mean(at.slice(-5));
      expect(closing - opening).toBeGreaterThan(2);
      expect(closing - middle).toBeGreaterThan((middle - opening) * 0.6);
    }
  });

  it("leaves hip fire on the aim point, because the bounce ends before the next round", () => {
    // Out of the weapon file and not out of a rule. A bounce lasts about
    // `5 v / a`: the ACR's hip pitch of 10 against 1500 is 0.034 s, inside the
    // 0.085 s between rounds, so the view is home before the next one leaves. Its
    // aimed 33 against 1350 is 0.124 s, which is not.
    for (const seed of [hashString("shooter"), hashString("second")]) {
      const hip = magazine(acr(), seed, false).map((k) => k.pitch);
      const aimed = magazine(acr(), seed, true).map((k) => k.pitch);
      const mean = (of: number[]): number => of.reduce((a, b) => a + b, 0) / of.length;
      expect(Math.abs(mean(hip.slice(-5)) - mean(hip.slice(0, 5)))).toBeLessThan(1.5);
      expect(aimed[aimed.length - 1]!).toBeGreaterThan(3);
    }
  });

  it("keeps a weapon's lateral kick, which is most of what an ACR does", () => {
    // The ACR's aimed yaw is +-50 against a pitch pinned at 32/34: side to side is
    // the larger part of this weapon, and it wanders rather than walking, because
    // the mean of that range is zero.
    const at = magazine(acr(), hashString("shooter"), true);
    expect(Math.max(...at.map((k) => Math.abs(k.yaw)))).toBeGreaterThan(0.5);
    const last = at[at.length - 1]!;
    expect(Math.abs(last.yaw)).toBeLessThan(last.pitch);
  });

  it("saturates at the engine's own ten degrees, and holds there with no speed left", () => {
    // The Desert Eagle is the case: 70 units of throw against only 600 of pull is
    // the worst ratio in the catalogue, so its rounds outrun its own recovery and
    // without a stop the view walks off the top of the screen. `UpdateKickAngles`
    // pins the angle at ±10 and **zeroes the speed** (reverse/iw5-view-kick/), so
    // a saturated weapon is held there rather than still pushing into the stop —
    // which is what stops the view lurching when the trigger comes off.
    const deagle = m4({
      clipSize: 30,
      times: { fire: 0.079, adsIn: 0.3, adsOut: 0.3 },
      motion: { adsViewKickPitchMin: 60, adsViewKickPitchMax: 80, adsViewKickCenterSpeed: 600 },
    });
    const gun = new WeaponController(deagle);
    gun.ready();
    const seed = hashString("shooter");
    gun.setInput({ ads: true });
    for (let i = 0; i < 60; i++) {
      gun.update(DT, { seed, speed: 0 });
    }
    // Sampled every tick rather than per round: the stop is reached *inside* a
    // tick's fall, so a per-round sample lands just below it.
    gun.setInput({ trigger: true, ads: true });
    let highest = 0;
    for (let i = 0; i < 400; i++) {
      gun.update(DT, { seed, speed: 0 });
      highest = Math.max(highest, gun.data.viewKick.pitch);
      // Never past the stop, on any tick of a long burst. Without it this weapon
      // climbs without bound — that is what "the Desert Eagle has huge recoil"
      // was, and what the engine's limit answers.
      expect(gun.data.viewKick.pitch).toBeLessThanOrEqual(VIEW_KICK_LIMIT);
    }
    gun.setInput({ trigger: false, ads: true });
    // And it really does reach it, or the line above would hold for a weapon the
    // limit never touched. Within a hair rather than exactly: the stop is reached
    // *inside* a tick's sub-stepped fall, and the rest of that tick falls back.
    expect(highest).toBeGreaterThan(VIEW_KICK_LIMIT * 0.99);

    // And released, it comes home from the stop rather than hanging there.
    for (let i = 0; i < 60 * 5; i++) {
      gun.update(DT, { seed, speed: 0 });
      if (gun.data.viewKick.pitch === 0) {
        break;
      }
    }
    expect(gun.data.viewKick).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
  });

  it("comes home quickly, and in a time that does not grow with the burst", () => {
    // The fall is the weapon's own acceleration over the height it reached, so a
    // long burst is not a long recovery. This is the "camera sliding downward for
    // seconds" complaint, and it is answered by the shape rather than a constant.
    const seed = hashString("shooter");
    const short = acr();
    magazine(short, seed, true, 5);
    const full = acr();
    magazine(full, seed, true, 30);
    expect(full.data.viewKick.pitch).toBeGreaterThan(short.data.viewKick.pitch);

    const settle = (gun: WeaponController): number => {
      let ticks = 0;
      for (; ticks < 60 * 10; ticks++) {
        gun.update(DT, { seed, speed: 0 });
        if (gun.data.viewKick.pitch === 0 && gun.data.viewKick.yaw === 0) {
          break;
        }
      }
      return ticks * DT;
    };
    const quick = settle(short);
    const long = settle(full);
    expect(long).toBeLessThan(0.6);
    expect(long).toBeLessThan(quick * 3);
    expect(full.data.viewKick).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
  });

  it("stops dead at the aim point rather than swinging through it", () => {
    // Crossing zero zeroes the angle *and* the speed, which is the engine's own
    // behaviour and is what makes a settled weapon exactly at rest — a `toEqual`
    // and the wire's zero both depend on it, and without it the acceleration
    // pushes a rested view off centre and it chatters for ever.
    const rifle = l96();
    aimedShot(rifle, SEED);
    for (let i = 0; i < 600; i++) {
      rifle.update(DT, { seed: SEED, speed: 0 });
    }
    expect(rifle.data.viewKick).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
  });

  it("is timed on dt, so a second taken in one step lands where sixty do", () => {
    // The fall is integrated on a fixed `VIEW_KICK_SUBSTEP` inside `stepViewKick`,
    // so a client running at 144 Hz and a server replaying its steps reach the
    // same angle. Both ends take the same rounded `dt` (net/messages/input.ts),
    // which is what actually has to agree; this is the arithmetic below it.
    const coarse = l96();
    const fine = l96();
    aimedShot(coarse, SEED);
    aimedShot(fine, SEED);
    coarse.update(VIEW_KICK_SUBSTEP * 6, { seed: SEED, speed: 0 });
    for (let i = 0; i < 6; i++) {
      fine.update(VIEW_KICK_SUBSTEP, { seed: SEED, speed: 0 });
    }
    expect(coarse.data.viewKick.pitch).toBeCloseTo(fine.data.viewKick.pitch, 9);
    expect(coarse.data.viewKick.pitch).toBeGreaterThan(0);
  });

  it("still brings a bolt-action home well inside its own cycle", () => {
    // An L96 works its bolt for `L96_CYCLE` between rounds and its kick has to be
    // gone by then, or a sniper never gets a second aimed shot.
    const rifle = l96();
    aimedShot(rifle, SEED);
    for (let i = 0; i < Math.floor(L96_CYCLE / DT); i++) {
      rifle.update(DT, { seed: SEED, speed: 0 });
    }
    expect(rifle.data.viewKick).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
  });

  it("is the same on both ends, and survives the wire", () => {
    // The speed rides on the wire beside the angle now: a client corrected to a
    // server's snapshot has to resume the same fall, and a correction that
    // dropped the speed would leave the view hanging where it was.
    const rifle = l96();
    aimedShot(rifle, SEED);
    const sent = structuredClone(rifle.data) as WeaponData;
    const wire = roundTrip(weaponSchema, sent);
    expect(wire.viewKick.pitchVel).toBeCloseTo(sent.viewKick.pitchVel, 0);
    expect(wire.viewKick.yawVel).toBeCloseTo(sent.viewKick.yawVel, 0);
  });
});
