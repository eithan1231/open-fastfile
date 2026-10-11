// Trace, then kick: the line a round leaves along, against the view it moves next.
//
// A bullet is away before the weapon has recoiled, so a round fired on a step is
// traced along the aim as it stood *before* that step's own view-kick impulse —
// which is also the aim the player last saw drawn. `Player.step` adds the impulse
// inside the very step that fires the round (`stepRecoil`, sim/weapon.ts), so
// `Match.step` captures the kick before stepping and hands that to `Shots.fire`.
//
// The weapon is Modern Warfare 3's L96A1, its own numbers copied in rather than
// read out of `worlds/catalog` — the catalogue is gitignored, and this claim is
// arithmetic that needs no assets. It is that weapon because a scoped L96's first
// round kicks the view over four degrees, which at fifty metres is nearly four
// metres of miss: a failure you can see rather than one inside a tolerance.
//
// The kick each round is checked against is the one the **previous snapshot**
// carried, not one read out of `Match`: that is what the client had drawn when
// the trigger went, so the two ends are being held to the same number.

import { describe, expect, it } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import { EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { aimAngles, aimDirection, type ViewKick } from "@3d/shared/sim/recoil.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import { Match } from "../src/match/match.js";
import type { FiredShot } from "../src/match/shots.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const GAME = "iw5";
const ARMED = "iw5/l96a1_mp";
const SHOOTER = "shooter";

const DEG = Math.PI / 180;

/**
 * Where the shooter looks and keeps looking: their crosshair, on the thing they
 * mean to hit.
 *
 * Neither angle is zero, round, or the other's negative, so a trace built from
 * the wrong angle — or from a yaw and a pitch swapped, or from either one's sign
 * flipped — is a different vector rather than the same one.
 */
const LOOK = { yaw: 0.37, pitch: -0.21 };

/**
 * The L96A1's own kick numbers (`worlds/catalog/weapons/iw5/iw5_l96a1_mp`).
 *
 * Both families, because the gun kick is the trap: `adsGunKick*` is identically
 * zero on a scoped sniper and all of its recoil is `adsViewKick*`, so a build
 * that traced along the wrong family would leave this weapon with no recoil in
 * the aim at all.
 */
const L96_MOTION: Record<string, number> = {
  hipGunKickPitchMin: 80,
  hipGunKickPitchMax: 85,
  hipGunKickYawMin: -35,
  hipGunKickYawMax: 35,
  hipGunKickSpeedMax: 1200,
  hipGunKickSpeedDecay: 100,
  hipGunKickStaticDecay: 100,
  adsGunKickPitchMin: 0,
  adsGunKickPitchMax: 0,
  adsGunKickYawMin: 0,
  adsGunKickYawMax: 0,
  adsGunKickSpeedMax: 600,
  adsGunKickSpeedDecay: 100,
  adsGunKickStaticDecay: 100,
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

/** A floor at y=0 and nothing else: a round meets neither a wall nor a body, so only its line is under test. */
const ground = {
  ready: true,
  resolveCapsule(
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean },
  ) {
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false };
    result.position.x = position.x;
    result.position.y = Math.max(position.y, 0);
    result.position.z = position.z;
    result.grounded = position.y <= 0;
    return result;
  },
  overlapsCapsule: (position: { y: number }) => position.y < 0,
  groundBelow: (from: { y: number }, distance: number) => (from.y >= 0 && from.y - distance <= 0 ? 0 : null),
  // Nothing here has a surface; a flat test floor is `default` either way.
  surfaceAt: () => null,
  traceRay: () => null,
};

function world(): ResolvedWorld {
  return {
    game: GAME,
    spawn: { position: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: -1 } },
    spawnPoints: [],
    triggers: [],
    mantles: [],
    ladders: [],
    points: [],
    solids: [],
    rooms: [],
    topLevelObjects: [],
  } as unknown as ResolvedWorld;
}

/**
 * A weapon whose `fireTime` is 0, which is every riot shield in the three
 * catalogues and Ghosts' `knifeonly_mp`: nothing but the sprint stands between
 * the trigger and the round, so the wait measured below is the sprint-out and
 * cannot be a rate of fire. It carries the L96's kick so that the impulse is
 * degrees rather than a rounding error.
 */
function instant(): WeaponEntry["def"] {
  const base = weaponDef();
  return weaponDef({ clipSize: 30, motion: L96_MOTION, times: { ...base.times, fire: 0 } });
}

/**
 * The MW3 ACR's view kick, for the one claim a bolt-action cannot carry any
 * more: that a round follows a view already off target. A sniper's kick is home
 * well before its bolt is worked — deliberately, `sim/recoil.ts` — so the second
 * round of one leaves along the bare crosshair and proves nothing. A held
 * automatic is where a live kick and a fresh round meet.
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

function registry(): WeaponRegistry {
  const entries: WeaponEntry[] = [
    {
      id: "l96a1_mp",
      game: GAME,
      slot: "primary",
      class: "sniper",
      def: weaponDef({ clipSize: 5, boltAction: true, fireType: "Single Shot", adsZoomFov: 15, motion: L96_MOTION }),
      attachments: [],
    },
    {
      id: "acr_mp",
      game: GAME,
      slot: "primary",
      class: "rifle",
      def: weaponDef({ clipSize: 30, fireType: "Full Auto", times: { fire: 0.085, adsIn: 0.3, adsOut: 0.3 }, motion: ACR_MOTION }),
      attachments: [],
    },
    { id: "shield_mp", game: GAME, slot: "primary", class: "rifle", def: instant(), attachments: [] },
  ];
  return new WeaponRegistry(entries);
}

function carrying(weapon = ARMED): Loadout {
  return { name: "Sniper", game: GAME, primary: { weapon, attachments: [] }, secondary: { weapon: null, attachments: [] } };
}

/** Scoped in, looking where `LOOK` says and turning not at all — with the trigger down, and with it released. */
const AIMED_FIRE: PlayerInput = { ...idleInput(LOOK.yaw, LOOK.pitch), fire: true, ads: true };
const AIMED: PlayerInput = { ...idleInput(LOOK.yaw, LOOK.pitch), ads: true };

/** Sprinting down the same line, and sprinting with the trigger pulled — which is what takes the weapon out of a sprint. */
const SPRINTING: PlayerInput = { ...idleInput(LOOK.yaw, LOOK.pitch), forward: 1, run: true };
const BREAKING: PlayerInput = { ...SPRINTING, fire: true };

interface Tick {
  shots: FiredShot[];
  /** The kick the previous snapshot carried: what this client had drawn when the trigger went. */
  drawn: ViewKick;
  /** The kick this tick's snapshot carries: where the view has been moved to. */
  moved: ViewKick;
}

/** One player on an empty floor, with every tick's snapshot kept. */
function sniper(weapon = ARMED) {
  const match = new Match(ground, world(), TICK_RATE, 4, registry());
  match.join(SHOOTER, carrying(weapon));
  let seq = 0;
  // Cloned, every tick: `Player.snapshot` hands back the live `WeaponData`, whose
  // `viewKick` is mutated in place — held by reference, every tick would report
  // the newest kick and every comparison below would be with itself.
  let latest: ViewKick = { pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 };

  const tick = (input: PlayerInput): Tick => {
    const drawn = latest;
    const message: InputMessage = { seq: ++seq, dt: DT, input, claim: { x: 0, y: 0, z: 0 }, drawn: { tick: 0, frac: 0 } };
    match.receive(SHOOTER, message);
    const snapshot = match.step();
    const state = snapshot.players.find((p) => p.id === SHOOTER)!.state;
    latest = { ...state.weapon!.viewKick };
    return { shots: [...match.shotsThisTick], drawn, moved: latest };
  };

  /**
   * Press the trigger until a round leaves. The first call spends the weapon's
   * raise and its scope getting there.
   *
   * Released and pressed again each time round, which is what a player does with
   * a bolt gun. A `Single Shot` weapon fires on the press and not on the hold
   * (`wantsFire`), and a press the weapon cannot spend — while it is coming up,
   * or working its bolt — is dropped rather than banked (sim/weapon.ts's
   * FIRE_STATES), so only a fresh edge ever looses a round.
   */
  const fire = (limit = 400): Tick & { shot: FiredShot } => {
    for (let i = 0; i < limit; i++) {
      tick(AIMED);
      const t = tick(AIMED_FIRE);
      if (t.shots.length > 0) {
        return { ...t, shot: t.shots[0]! };
      }
    }
    throw new Error(`the sniper fired nothing in ${limit} ticks`);
  };

  /**
   * Hold the trigger down and take the next round. Unlike `fire`, which releases
   * between attempts, this never lets the weapon out of `firing` — which is what
   * an automatic in a player's hands is doing, and the only way the kick of one
   * round is still standing when the next leaves.
   */
  const held = (limit = 400): Tick & { shot: FiredShot } => {
    for (let i = 0; i < limit; i++) {
      const t = tick(AIMED_FIRE);
      if (t.shots.length > 0) {
        return { ...t, shot: t.shots[0]! };
      }
    }
    throw new Error(`nothing fired in ${limit} ticks`);
  };

  return { match, tick, fire, held };
}

/** The line `kick` would put a round on, from the crosshair `LOOK` holds. */
function lineFor(kick: ViewKick | null): { x: number; y: number; z: number } {
  return aimDirection(aimAngles(LOOK, kick), { x: 0, y: 0, z: 0 });
}

/** Degrees between two unit vectors: how far a round missed by, in the only unit a kick is quoted in. */
function apart(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot) / DEG;
}

describe("where a round leaves", () => {
  it("goes exactly along the crosshair, and not along the kick that shot is about to take", () => {
    const s = sniper();
    const first = s.fire();

    // The gun was at rest when the trigger went: a first round has nothing behind
    // it, so its line is the bare line of sight and nothing else.
    expect(first.drawn).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
    expect(first.shot.from).toEqual({ x: 0, y: EYE_HEIGHT, z: 0 });
    expect(apart(first.shot.direction, lineFor(null))).toBeLessThan(1e-9);

    // And the kick it took is real and large, or the line above would be the
    // crosshair by default and this would be a test of nothing: a scoped L96
    // throws the view degrees off, which is metres at any range worth a sniper.
    expect(Math.abs(first.moved.pitchVel)).toBeGreaterThan(0);
    expect(apart(first.shot.direction, lineFor(first.moved))).toBeGreaterThan(1.5);
  });

  it("follows the view once the view has been kicked, so the second round is not on the first one's line", () => {
    // A held ACR rather than the sniper: a bolt gun's kick is home well before
    // its bolt is worked, so its second round leaves along the bare crosshair
    // and would prove nothing. An automatic is where the kick of one round is
    // still standing when the next leaves, which is the recoil a player fights.
    const s = sniper("iw5/acr_mp");
    // Scoped in before the trigger goes: this weapon's kick is an aimed one, and
    // a round loosed part way down the sights is drawn from the hip pair.
    for (let i = 0; i < 200; i++) {
      s.tick(AIMED);
    }
    const first = s.held();
    const second = s.held();

    expect(second.shot.ordinal).toBe((first.shot.ordinal + 1) & 0xffff);
    // The view genuinely moved, and this round follows it: the whole of the fix is
    // an ordering, not the removal of view kick from the aim. A twentieth of a
    // degree is plenty to tell "follows the kick" from "ignores it" — the
    // tolerance the next line holds the line to is 1e-9.
    expect(Math.abs(second.drawn.pitch)).toBeGreaterThan(0.05);
    expect(apart(second.shot.direction, lineFor(second.drawn))).toBeLessThan(1e-9);

    // Which is a different line from the crosshair by far more than that
    // tolerance, so "the aim ignores the kick" cannot pass this pair.
    expect(apart(second.shot.direction, lineFor(null))).toBeGreaterThan(0.05);
    // And it is not the first round's line either: the two rounds of a bolt gun
    // leave along two different lines, which is the recoil a player fights.
    expect(apart(second.shot.direction, first.shot.direction)).toBeGreaterThan(0.05);
  });
});

describe("a round fired out of a sprint", () => {
  it("waits out the weapon's sprintOutTime, then leaves along the aim from before the step", () => {
    const s = sniper("iw5/shield_mp");
    // Raised, and settled into the sprint loop.
    for (let i = 0; i < 120; i++) {
      s.tick(SPRINTING);
    }

    // Sprint to fire: the trigger takes the weapon out of the sprint and the
    // round waits for that to run. 0.2 s of `sprintOut` is twelve ticks here,
    // and this weapon's `fireTime` is 0 — so what is being measured is the
    // sprint and not the rate of fire.
    let quiet = 0;
    let fired: Tick | undefined;
    for (let i = 0; i < 20 && fired === undefined; i++) {
      const t = s.tick(BREAKING);
      if (t.shots.length > 0) {
        fired = t;
      } else {
        quiet++;
      }
    }
    // The tick the trigger arrives on is spent leaving the sprint; the twelve
    // after it are the 0.2 s of `sprintOut`, and the round leaves on the next.
    expect(quiet).toBe(1 + Math.round(0.2 * TICK_RATE));

    // One round, along the aim the player last saw — not along the kick it is
    // about to take.
    expect(fired?.shots).toHaveLength(1);
    expect(apart(fired!.shots[0]!.direction, lineFor(fired!.drawn))).toBeLessThan(1e-9);

    // And the impulse is real: the view ends the step degrees from where the
    // round left, which is what makes this a choice rather than a nicety.
    expect(apart(lineFor(fired!.moved), lineFor(fired!.drawn))).toBeGreaterThan(1.5);
  });
});
