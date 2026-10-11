// What stops a client firing faster than its weapon allows — and the point is
// that **nothing here is validation code**.
//
// There is no "I shot" message to check, so there is nothing to refuse. A shot
// exists because this server replayed the client's own input through the same
// `WeaponController` the client runs and the shot counter advanced
// (`WeaponData.fired`), so rate of fire, the magazine, the reload and being
// empty-handed are enforced by a state machine the client does not run rather
// than by a rule somebody remembered to write. These tests pin that down by
// asking for shots that a validator would have had to refuse, and finding that
// the simulation never produced them in the first place.
//
// Every negative here carries its own positive control in the same test: a
// counter that is never incremented would make all four pass while proving
// nothing.

import { describe, expect, it } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import { STAND_EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { WeaponData, WeaponState } from "@3d/shared/sim/weapon.js";
import type { WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import { Match } from "../src/match/match.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
/** The test weapon's `fireTime`, which is the whole of its rate of fire: it has no rechamber. */
const FIRE_TIME = 0.1;
/** Inputs one tick spends, as `MAX_INPUTS_PER_TICK` fixes it. Four is what a flooding client gets. */
const DRAINED = 4;
const ARMED = "iw5/test_mp";

/** A floor at y=0 and nothing to shoot at: these count shots, not hits. */
const ground = {
  ready: true,
  resolveCapsule(
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean; normal: { x: number; y: number; z: number } },
  ) {
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };
    result.position.x = position.x;
    result.position.y = Math.max(position.y, 0);
    result.position.z = position.z;
    result.grounded = position.y <= 0;
    result.normal.x = 0;
    result.normal.y = result.grounded ? 1 : 0;
    result.normal.z = 0;
    return result;
  },
  overlapsCapsule: (position: { y: number }) => position.y < 0,
  overlapsSweep: (from: { y: number }, to: { y: number }, radius: number) => Math.min(from.y, to.y) < radius,
  groundBelow: (from: { y: number }, distance: number, normal?: { x: number; y: number; z: number }) => {
    if (from.y < 0 || from.y - distance > 0) {
      return null;
    }
    if (normal) {
      normal.x = 0;
      normal.y = 1;
      normal.z = 0;
    }
    return 0;
  },
  // Nothing here has a surface; a flat test floor is `default` either way.
  surfaceAt: () => null,
  traceRay: () => null,
};

function world(): ResolvedWorld {
  return {
    spawn: { position: { x: 0, y: STAND_EYE_HEIGHT, z: 0 }, look: { x: 0, y: STAND_EYE_HEIGHT, z: -1 } },
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

const SECOND = "iw5/test2_mp";

function registry(overrides: Partial<WeaponDef> = {}): WeaponRegistry {
  const entries: WeaponEntry[] = [
    { id: "test_mp", game: "iw5", slot: "primary", class: "rifle", def: weaponDef(overrides), attachments: [] },
    { id: "test2_mp", game: "iw5", slot: "secondary", class: "pistol", def: weaponDef({ ...overrides, weapon: "test2_mp" }), attachments: [] },
  ];
  return new WeaponRegistry(entries);
}

function carrying(weapon: string | null, second: string | null = null): Loadout {
  return { name: "Test", game: "iw5", primary: { weapon, attachments: [] }, secondary: { weapon: second, attachments: [] } };
}

const holdingFire: PlayerInput = { ...idleInput(0, 0), fire: true };

function message(seq: number, input: PlayerInput): InputMessage {
  return { seq, dt: DT, input, claim: { x: 0, y: 0, z: 0 }, drawn: { tick: 0, frac: 0 } };
}

/** A match with one or more players, driven a tick at a time with the shots each tick fired counted. */
function played(overrides: Partial<WeaponDef> = {}, loadouts: Record<PlayerId, Loadout> = { shooter: carrying(ARMED) }) {
  const match = new Match(ground, world(), TICK_RATE, 4, registry(overrides));
  for (const [id, loadout] of Object.entries(loadouts)) {
    match.join(id, loadout);
  }
  let seq = 0;
  let latest: PlayerSnapshot[] = [];

  /** Queue `count` copies of `input` for `id`, as a client sending faster than the tick would. */
  const send = (id: PlayerId, input: PlayerInput, count = 1) => {
    for (let i = 0; i < count; i++) {
      match.receive(id, message(++seq, input));
    }
  };

  /** One tick, with every snapshot delivered. Returns the shots it fired. */
  const tick = () => {
    const snapshot = match.step();
    latest = snapshot.players;
    for (const player of snapshot.players) {
      match.snapshotFor(player.id, snapshot.players);
    }
    return match.shotsThisTick.length;
  };

  /** Drive `ticks` ticks, sending `input` once per tick, and return the shots fired over them. */
  const run = (ticks: number, input: PlayerInput = idleInput(0, 0), id: PlayerId = "shooter") => {
    let shots = 0;
    for (let i = 0; i < ticks; i++) {
      send(id, input);
      shots += tick();
    }
    return shots;
  };

  const weapon = (id: PlayerId = "shooter"): WeaponData | null => latest.find((p) => p.id === id)?.state.weapon ?? null;
  const state = (id: PlayerId = "shooter"): WeaponState | undefined => weapon(id)?.state;
  /** Which weapon is in hand, as the wire names it: the one thing that says a swap has landed. */
  const held = (id: PlayerId = "shooter"): number | null => latest.find((p) => p.id === id)?.state.weaponIndex ?? null;

  /** Step until `done`, or give up after `limit` ticks; returns the shots fired on the way. */
  const until = (done: () => boolean, input: PlayerInput, limit = 600, id: PlayerId = "shooter") => {
    let shots = 0;
    for (let i = 0; i < limit && !done(); i++) {
      send(id, input);
      shots += tick();
    }
    return shots;
  };

  /** A weapon is raised for `firstRaise` after a spawn, and a raising weapon fires nothing. */
  const ready = () => {
    const shots = until(() => state() === "idle", idleInput(0, 0), 200);
    expect(state()).toBe("idle");
    expect(shots).toBe(0);
  };

  return { match, send, tick, run, until, ready, weapon, state, held };
}

describe("what a client cannot buy by sending more inputs", () => {
  it("fires once for a whole tick of queued fire inputs, because the weapon's fireTime says so", () => {
    const p = played({ clipSize: 30 });
    p.ready();

    // Sixteen, which is the deepest queue `receive` will hold. Four of them are
    // spent this tick, and four steps of 1/60 s is 67 ms against a 100 ms fireTime.
    p.send("shooter", holdingFire, 16);
    expect(p.tick()).toBe(1);

    // And the twelve still queued do not catch up: three more ticks spend them
    // all, and sixteen inputs are 267 ms of simulation — three shots at 100 ms
    // apiece, not sixteen.
    let shots = 1;
    for (let i = 0; i < 3; i++) {
      shots += p.tick();
    }
    const simulated = 16 * DT;
    expect(simulated / DRAINED).toBeCloseTo(4 * DT);
    expect(shots).toBe(Math.ceil(simulated / FIRE_TIME));
    expect(shots).toBe(3);
  });

  /**
   * Sprint to fire, which no amount of input buys past.
   *
   * The weapon's `fireTime` is zero here — every riotshield in the three
   * catalogues and Ghosts' `knifeonly_mp` carry it — so the rate of fire stands
   * in the way of nothing and the only thing between the trigger and the round is
   * the weapon's own `sprintOut`. A client flooding the queue spends it four
   * inputs a tick like anybody else: the delay is simulated seconds, not frames.
   */
  it("makes a sprinting player pay their weapon's sprintOutTime before a round leaves", () => {
    const base = weaponDef();
    const p = played({ clipSize: 30, times: { ...base.times, fire: 0 } });
    p.ready();

    const sprinting: PlayerInput = { ...idleInput(0, 0), forward: 1, run: true };
    p.until(() => p.state() === "sprinting", sprinting, 120);
    expect(p.state()).toBe("sprinting");

    const before = p.weapon()!.fired;
    const breaking = { ...sprinting, fire: true };
    // Four inputs a tick, which is the deepest a tick drains: 0.2 s of sprintOut
    // is three ticks of them and not one.
    p.send("shooter", breaking, DRAINED);
    expect(p.tick()).toBe(0);
    expect(p.state()).toBe("sprintOut");

    let shots = 0;
    for (let i = 0; i < 3 && shots === 0; i++) {
      p.send("shooter", breaking, DRAINED);
      shots += p.tick();
    }
    expect(shots).toBeGreaterThan(0);
    expect(p.weapon()!.fired).toBe(before + shots);
    // Each round of the tick is told apart by the only thing that differs: which
    // shot of that weapon's life it was, counted on without a gap.
    const ordinals = p.match.shotsThisTick.map((shot) => shot.ordinal);
    const first = before + shots - ordinals.length + 1;
    expect(ordinals).toEqual(ordinals.map((_, i) => first + i));
  });

  /**
   * And why the difference is masked rather than subtracted.
   *
   * `fired` is a uint16 on the wire and in the simulation, so once in every 65536
   * rounds `before` is 65535 and `after` is 0. A plain subtraction there is
   * negative and the shot is silently lost — once an hour of sustained fire, which
   * is exactly the kind of thing nobody ever reproduces. Cheaper to prove than to
   * argue about: seventy thousand rounds take a quarter of a second here.
   */
  it("counts the shot that takes the counter round", () => {
    const base = weaponDef();
    // A magazine that fits the wire's ten bits, and no fire time, so the limit is
    // the tick's four inputs and nothing else.
    const p = played({ clipSize: 1000, times: { ...base.times, fire: 0 } });
    p.ready();

    let total = 0;
    for (let i = 0; i < 40000 && total <= 0x10000; i++) {
      p.send("shooter", holdingFire, DRAINED);
      total += p.tick();
    }
    expect(total).toBeGreaterThan(0xffff);
    // Every round is accounted for: the counter is the running total modulo its own
    // width, which it cannot be if the step that wrapped counted anything but one.
    expect(total % 0x10000).toBe(p.weapon()!.fired);
  });

  it("fires nothing from an empty magazine, and fires again once the reload has put rounds in it", () => {
    const p = played({ clipSize: 3 });
    p.ready();

    // Held down: three rounds in three hundred milliseconds, and then nothing.
    const emptied = p.until(() => p.weapon()!.ammo === 0, holdingFire, 120);
    expect(emptied).toBe(3);
    expect(p.weapon()!.ammo).toBe(0);

    // A whole second of held trigger on an empty magazine. The weapon reloads
    // itself, so this is also a second of a reload in progress.
    expect(p.run(60, holdingFire)).toBe(0);
    expect(p.weapon()!.ammo).toBe(0);

    // The control: the same held trigger fires again as soon as the reload is
    // out of the way, so the zero above is the magazine and not a counter that
    // never moves. The rounds go in at `reloadAddTime` and the reload runs on
    // past that, so the state and not the ammunition is what says it is over.
    expect(p.until(() => p.state() === "idle", holdingFire, 400)).toBe(0);
    expect(p.weapon()!.ammo).toBe(3);
    expect(p.run(2, holdingFire)).toBeGreaterThan(0);
  });

  it("fires nothing while a reload is running, however hard the trigger is held", () => {
    const p = played({ clipSize: 30 });
    p.ready();

    expect(p.run(2, holdingFire)).toBe(1);
    // Asked for with the trigger still down, so the only thing stopping a shot is
    // the reload itself.
    const reloading: PlayerInput = { ...holdingFire, reload: true };
    p.until(() => p.state() === "reloading", reloading, 60);
    expect(p.state()).toBe("reloading");

    const during = p.until(() => p.state() !== "reloading", holdingFire, 300);
    expect(during).toBe(0);
    expect(p.state()).not.toBe("reloading");
    // The control again: the trigger was down the whole time and is still down.
    expect(p.run(2, holdingFire)).toBeGreaterThan(0);
  });

  it("fires nothing for a player carrying a weapon this instance does not hold", () => {
    const p = played({ clipSize: 30 }, { shooter: carrying(ARMED), "empty-handed": carrying("iw5/not_in_this_catalogue") });
    p.ready();
    expect(p.weapon("empty-handed")).toBeNull();

    // Two seconds of held trigger with nothing in their hands.
    let unarmed = 0;
    for (let i = 0; i < 120; i++) {
      p.send("empty-handed", holdingFire);
      p.tick();
      unarmed += p.match.shotsThisTick.filter((shot) => shot.shooter === "empty-handed").length;
    }
    expect(unarmed).toBe(0);
    // The control: the armed player in the same match, over the same ticks, fired.
    expect(p.run(2, holdingFire)).toBeGreaterThan(0);
  });
});

/**
 * Swapping weapons, which is the one thing that can make the counter lie.
 *
 * `Player.step` can hand back a *different* `WeaponController` than it was given:
 * a swap whose putaway finished inside the step ends holding the other weapon,
 * and that weapon has been counting its own rounds all along. Subtracting one
 * weapon's total from the other's invents shots that nobody fired — three of
 * them going one way, and 65533 going the other, which is the same bug wearing a
 * different number.
 */
describe("a weapon change inside a tick", () => {
  const both = { shooter: carrying(ARMED, SECOND) };

  it("reports no shot for the tick the other weapon arrives, in either direction", () => {
    const p = played({ clipSize: 30 }, both);
    p.ready();
    const primary = p.held();

    // Rounds down the primary, so the two weapons' counters are far apart. This
    // is what makes the subtraction below a real trap rather than 0 minus 0.
    const fired = p.run(20, holdingFire);
    expect(fired).toBeGreaterThan(2);
    expect(p.weapon()!.fired).toBe(fired);

    // Away, and the other one up. The weapon arriving has fired nothing, so a
    // difference taken across the change reads as 65533 shots.
    const swapping: PlayerInput = { ...idleInput(0, 0), swap: true };
    p.send("shooter", swapping);
    expect(p.tick()).toBe(0);
    expect(p.until(() => p.held() !== primary, idleInput(0, 0), 120)).toBe(0);
    expect(p.held()).not.toBe(primary);
    expect(p.weapon()!.fired).toBe(0);

    // And back the other way, which is the plausible one: the primary returns
    // with its own total, so a difference taken across the change reads as the
    // three or four rounds it fired a second ago — phantom shots at a believable
    // rate, fired by a weapon that was on the player's back at the time.
    expect(p.until(() => p.state() === "idle", idleInput(0, 0), 200)).toBe(0);
    p.send("shooter", swapping);
    expect(p.tick()).toBe(0);
    expect(p.until(() => p.held() === primary, idleInput(0, 0), 120)).toBe(0);
    expect(p.held()).toBe(primary);

    // The counter is the weapon's own state and came back with it, which is what
    // makes the difference across a change meaningless rather than merely awkward.
    expect(p.weapon()!.fired).toBe(fired);
  });

  it("still fires from the weapon that arrived, once it is up", () => {
    const p = played({ clipSize: 30 }, both);
    p.ready();
    const primary = p.held();
    p.send("shooter", { ...idleInput(0, 0), swap: true });
    p.until(() => p.held() !== primary, idleInput(0, 0), 120);
    p.until(() => p.state() === "idle", idleInput(0, 0), 200);

    // The control for the two zeroes above: a swap that silently stopped the
    // counter working would pass every one of them.
    expect(p.run(20, holdingFire)).toBeGreaterThan(2);
    expect(p.weapon()!.fired).toBeGreaterThan(2);
  });
});
