// Health, death and score: what a round that landed actually costs, and what the
// scripts get to say about it.
//
// The geometry is not what is under test here — `shot.test.ts` owns that, against
// the real catalogue's real skeletons, and repeating it would be slow and would
// prove the same thing twice. So the body a bullet meets is a stub that reports a
// hit at a location and a distance this file names, and every player stands on the
// world's one spawn so that the ray reaches them at all. What is real is
// everything after: the falloff, the multiplier, the scale, the hooks, the queue
// they drain through, the kill and the point it is worth.
//
// **Nothing here uses 1 for a multiplier.** A location multiplier of 1.0 and a
// `damageScale` of 1.0 would let a reader that dropped either agree with one that
// did not; the fixtures are 0.8, 1.5 and 0.5, so each factor is visible in the
// answer and a missing one is a different number.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ResolvedSpawn, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { CastChoice } from "@3d/shared/game/cast.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { Script, ServerHooks } from "@3d/shared/game/hooks.js";
import { DEFAULT_COMBAT_RULES, type CombatRules } from "@3d/shared/game/rules.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import { MAX_SNAPSHOT_EVENTS, type GameEvent } from "@3d/shared/net/messages/events.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import { createMovement } from "@3d/shared/sim/movement.js";
import type { HitLocation } from "@3d/shared/sim/hitLocations.js";
import { CATALOG_VERSION, WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import type { BodyView, LoadedBody } from "../src/bodies.js";
import { encodePacket, MessageType } from "@3d/shared/net/packet.js";
import { Match } from "../src/match/match.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const GAME = "iw5";
const MAP = "dome-mw3";
const ARMED = "iw5/test_mp";

/**
 * A bullet's range as match/shots.ts takes it: the games' own 8192-unit `bulletRange`.
 *
 * Repeated rather than exported, because a hit's `distance` is a fraction of it
 * and this file wants to ask for a distance in metres.
 */
const SHOT_RANGE = 8192 / 39.37;
const UNITS_PER_M = 39.37;

/** Full damage to 10 m, minimum past 30 m — the shape of every rifle in the games. */
const NEAR = 10;
const FAR = 30;
const DAMAGE = { max: 40, min: 20, maxRange: NEAR * UNITS_PER_M, minRange: FAR * UNITS_PER_M };
const LOCATIONS = { head: 1.5, torsoUpper: 0.8, gun: 0 };

/** A chest shot inside `maxRange`: 40 × 0.8 × 0.5. Every test that does not say otherwise costs this. */
const CHEST_DAMAGE = 16;

/** A floor at y=0 and no walls: a bullet meets only the bodies. */
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
    spawn: { position: { x: 0, y: 1.6, z: 0 }, look: { x: 0, y: 1.6, z: -1 } },
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

function registry(over: Partial<WeaponDef> = {}): WeaponRegistry {
  const entries: WeaponEntry[] = [
    {
      id: "test_mp",
      game: GAME,
      slot: "primary",
      class: "rifle",
      def: weaponDef({ clipSize: 30, damage: DAMAGE, locationDamage: LOCATIONS, ...over }),
      attachments: [],
    },
    // Appended, so every index above stays what it was.
    { id: "other_mp", game: GAME, slot: "primary", class: "smg", def: weaponDef({ weapon: "other_mp", clipSize: 30 }), attachments: [] },
  ];
  return new WeaponRegistry(entries);
}

function carrying(): Loadout {
  return { name: "Test", game: "iw5", primary: { weapon: ARMED, attachments: [] }, secondary: { weapon: null, attachments: [] } };
}

/** One body for everybody, reporting a hit where the test asked for one. */
function stubBodies(location: HitLocation, distance: number): BodyView {
  const body = {
    id: "dummy",
    game: GAME,
    rig: { root: new THREE.Object3D() },
    poser: { update: () => undefined },
    // A fraction of the segment, which is what a real `BoundHitboxes` answers in —
    // the caller multiplies by the range it already knows.
    boxes: { trace: () => ({ bone: "j_spine4", location, fraction: distance / SHOT_RANGE }) },
  } as unknown as LoadedBody;
  return { get: () => body };
}

/** The one body every player wears here, so `Match.bodyOf` has something to find. */
const CAST: CastChoice = {
  characters: [{ id: "dummy", body: { kind: "characters", game: GAME, id: "dummy", file: "dummy.glb" } }],
  animations: { kind: "animations", game: GAME, id: "clips", file: "clips.glb" },
  hands: { kind: "hands", game: GAME, id: "hands", file: "hands.glb" },
  defaultWeapon: null,
};

/** Everyone on one side, which is how a teammate is made. `defaultGametype` alternates sides instead. */
const oneSide: GametypeDecl = { id: "one-side", display: "One Side", teams: ["allies"] };

const holdingFire: PlayerInput = { ...idleInput(0, 0), fire: true };

interface Options {
  players?: PlayerId[];
  gametype?: GametypeDecl;
  hooks?: ServerHooks;
  /** What a bullet reports hitting. A chest inside `maxRange` unless a test wants otherwise. */
  location?: HitLocation;
  distance?: number;
  /** What the script says the rules are. Half damage by default, so a reader that ignores the scale is caught. */
  rules?: Partial<CombatRules>;
}

function combat(options: Options = {}) {
  const players = options.players ?? ["a", "b"];
  const rules = options.rules ?? { damageScale: 0.5 };
  const script: Script = {
    id: "test",
    server: { combatRules: () => rules, ...options.hooks },
    client: { cast: () => CAST },
  };
  const match = new Match(ground, world(), TICK_RATE, 8, registry(), {
    map: MAP,
    gametype: options.gametype ?? defaultGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: stubBodies(options.location ?? "torsoUpper", options.distance ?? 5),
    scripts: [script],
  });
  for (const id of players) {
    match.join(id, carrying());
  }

  let seq = 0;
  let latest: PlayerSnapshot[] = [];
  const tails = new Map<PlayerId, GameEvent[]>();

  const message = (input: PlayerInput): InputMessage => ({
    seq: ++seq,
    dt: DT,
    input,
    claim: createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
    renderTick: 0,
    renderFrac: 0,
  });

  /** One tick, with every snapshot delivered — without which every rewind would be clamped. */
  const tick = (firing?: PlayerId, command: PlayerInput = holdingFire) => {
    for (const id of players) {
      match.receive(id, message(id === firing ? command : idleInput(0, 0)));
    }
    const snapshot = match.step();
    latest = snapshot.players;
    for (const player of snapshot.players) {
      // Kept, because the tail is the only part of a snapshot that is *not* the
      // same for everyone: a hit marker is addressed to whoever fired.
      tails.set(player.id, match.snapshotFor(player.id, snapshot.players).events);
    }
  };

  const idle = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      tick();
    }
  };

  /** Hold the trigger until a round leaves. The first call spends the weapon's `firstRaise` getting there. */
  const fire = (shooter: PlayerId = players[0]!, limit = 200) => {
    for (let i = 0; i < limit; i++) {
      tick(shooter);
      if (match.shotsThisTick.length > 0) {
        return [...match.shotsThisTick];
      }
    }
    throw new Error(`${shooter} fired nothing in ${limit} ticks`);
  };

  /** What the wire says, which is the only thing a client is ever told. */
  const state = (id: PlayerId) => latest.find((p) => p.id === id)!.state;
  const health = (id: PlayerId) => state(id).health;

  /** The tail of the last snapshot sent to `id`: what that client, and only that client, was told. */
  const events = (id: PlayerId) => tails.get(id) ?? [];

  return { match, tick, idle, fire, state, health, events };
}

describe("what a round costs", () => {
  it("is the weapon's falloff, times the location, times the gametype's scale", () => {
    const chest = combat();
    chest.fire();
    expect(chest.health("b")).toBe(100 - CHEST_DAMAGE);

    // The same round on the head. 40 × 1.5 × 0.5 against 40 × 0.8 × 0.5: a reader
    // that dropped the multiplier would answer 20 to both.
    const head = combat({ location: "head" });
    head.fire();
    expect(head.health("b")).toBe(100 - 30);

    // And the scale is the gametype's. Full damage is twice the half above.
    const full = combat({ rules: { damageScale: 1 } });
    full.fire();
    expect(full.health("b")).toBe(100 - 32);
  });

  it("falls off with distance, and the weapon's ranges are in CoD units", () => {
    // Past `minRange`: 20 × 0.8 × 0.5. Read as metres rather than inches, 30 m
    // would sit inside a 394 m window and this would still cost 16.
    const far = combat({ distance: FAR });
    far.fire();
    expect(far.health("b")).toBe(100 - 8);

    // Halfway, which a step function would answer with 16 or with 8.
    const middle = combat({ distance: (NEAR + FAR) / 2 });
    middle.fire();
    expect(middle.health("b")).toBe(100 - 12);
  });

  it("costs nothing where the weapon file gave the location a zero", () => {
    // A round stopped by somebody's rifle. Still a hit, and still traced.
    const gun = combat({ location: "gun" });
    expect(gun.fire()[0]!.result).toMatchObject({ kind: "player", id: "b" });
    expect(gun.health("b")).toBe(100);
  });
});

describe("what a script says about a hit", () => {
  it("leaves health untouched when playerDamage returns { ignore: true }", () => {
    const seen: string[] = [];
    const armoured = combat({
      hooks: {
        playerDamage: (_ctx, hit) => {
          seen.push(hit.id);
          return { ignore: true };
        },
      },
    });
    armoured.fire();
    // The hit was seen — and refused. A hook that never ran would also leave
    // health alone, which is what this line rules out.
    expect(seen).toEqual(["b"]);
    expect(armoured.health("b")).toBe(100);

    // The control: the same shot with no hook costs what it costs.
    const bare = combat();
    bare.fire();
    expect(bare.health("b")).toBe(100 - CHEST_DAMAGE);
  });

  it("is handed the weapon's own number, the location and who fired", () => {
    const hits: { amount: number; by: string | null; location: string | undefined }[] = [];
    const watched = combat({
      location: "head",
      hooks: { playerDamage: (_ctx, hit) => void hits.push({ amount: hit.amount, by: hit.by, location: hit.location }) },
    });
    watched.fire();
    expect(hits).toEqual([{ amount: 30, by: "a", location: "head" }]);
  });

  it("costs what the hook says instead, when it names an amount", () => {
    const doubled = combat({ hooks: { playerDamage: () => ({ amount: 45 }) } });
    doubled.fire();
    expect(doubled.health("b")).toBe(100 - 45);
  });
});

describe("a death", () => {
  /** A hook that makes any hit fatal, so one round settles it. */
  const fatal: ServerHooks = { playerDamage: () => ({ amount: 1000 }) };

  it("fires playerDeath exactly once, naming who did it", () => {
    const deaths: { id: string; by: string | null }[] = [];
    const killed = combat({
      hooks: { ...fatal, playerDeath: (_ctx, id, by) => void deaths.push({ id, by }) },
    });
    killed.fire();
    expect(deaths).toEqual([{ id: "b", by: "a" }]);
    expect(killed.health("b")).toBe(0);
    expect(killed.state("b").dead).toBe(true);

    // A whole respawn's worth of ticks later, and it has not fired again — which
    // is what a hook fired from "is dead" rather than "has just died" would do,
    // once a tick, for three seconds.
    killed.idle(240);
    expect(deaths).toHaveLength(1);
  });

  it("takes the body out of the world until it respawns", () => {
    const killed = combat({ hooks: fatal });
    killed.fire();
    expect(killed.state("b").dead).toBe(true);

    // A corpse stops a round meant for whoever is behind it. Nothing else is in
    // the match, so the bullet now reaches its range and finds nothing.
    const next = killed.fire();
    expect(next[0]!.result).toBeNull();

    // And it is not simulated: the dead player is sent a full run forward and does
    // not move, while the same input moves a live one.
    const before = { ...killed.state("b").movement.feet };
    for (let i = 0; i < 30; i++) {
      killed.tick("b", { ...idleInput(0, 0), forward: 1, run: true });
    }
    expect(killed.state("b").movement.feet).toEqual(before);
    for (let i = 0; i < 30; i++) {
      killed.tick("a", { ...idleInput(0, 0), forward: 1, run: true });
    }
    expect(killed.state("a").movement.feet.z).toBeLessThan(-1);
  });

  it("puts them back on a spawn with full health once the delay is up", () => {
    const killed = combat({ hooks: fatal, rules: { damageScale: 0.5, respawnDelay: 2 } });
    killed.fire();
    expect(killed.state("b").respawnIn).toBeCloseTo(2, 1);

    // One tick short of the delay, they are still down.
    killed.idle(2 * TICK_RATE - 2);
    expect(killed.state("b").dead).toBe(true);
    expect(killed.health("b")).toBe(0);

    killed.idle(2);
    expect(killed.state("b").dead).toBe(false);
    expect(killed.health("b")).toBe(100);
    expect(killed.state("b").respawnIn).toBe(0);
  });
});

describe("a class chosen mid-game", () => {
  const fatal: ServerHooks = { playerDamage: () => ({ amount: 1000 }) };
  const other: Loadout = { name: "Other", game: GAME, primary: { weapon: "iw5/other_mp", attachments: [] }, secondary: { weapon: null, attachments: [] } };
  const held = (m: ReturnType<typeof combat>, id: PlayerId) => registry().idAt(m.state(id).weaponIndex);

  it("waits for the next spawn: not while alive, not while dead, and then it is in their hands", () => {
    const m = combat({ hooks: fatal, rules: { damageScale: 0.5, respawnDelay: 1 } });
    m.idle(1);
    expect(m.match.chooseLoadout("b", other, 1)).toBe("nextSpawn");

    m.idle(30);
    expect(held(m, "b")).toBe(ARMED);

    m.fire();
    expect(m.state("b").dead).toBe(true);
    expect(held(m, "b")).toBe(ARMED);

    m.idle(TICK_RATE + 1);
    expect(m.state("b").dead).toBe(false);
    expect(held(m, "b")).toBe("iw5/other_mp");
  });

  it("is refused for someone not in the match", () => {
    expect(combat().match.chooseLoadout("nobody", other, 1)).toBe("refuse");
  });
});

describe("friendly fire", () => {
  it("stops a teammate's round, and only a teammate's", () => {
    // One side, so the two players joined are on it together.
    const mates = combat({ gametype: oneSide });
    mates.fire();
    expect(mates.health("b")).toBe(100);

    // The control that makes the line above mean anything: the same shot with
    // friendly fire on costs what any other does.
    const allowed = combat({ gametype: oneSide, rules: { damageScale: 0.5, friendlyFire: true } });
    allowed.fire();
    expect(allowed.health("b")).toBe(100 - CHEST_DAMAGE);

    // And an enemy is never protected by it. `defaultGametype` has two sides and
    // `Match.join` alternates, so these two are on opposite ones.
    const enemies = combat();
    enemies.fire();
    expect(enemies.health("b")).toBe(100 - CHEST_DAMAGE);
  });

  it("does not stop a player hurting themselves", () => {
    // A hit on an enemy, and a hook that blows the shooter up with their own
    // grenade. `by` is the shooter, whose side is of course their own — a rule
    // written as "same side, no damage" would refuse this.
    const suicide = combat({
      hooks: { playerDamage: (ctx, hit) => void (hit.id === "b" && ctx.damage("a", 25, "a")) },
    });
    suicide.fire();
    expect(suicide.health("a")).toBe(100 - 25);
    expect(suicide.health("b")).toBe(100 - CHEST_DAMAGE);
  });
});

describe("the score", () => {
  const fatal: ServerHooks = { playerDamage: () => ({ amount: 1000 }) };

  it("gives a kill one point to the killer's side", () => {
    const killed = combat({ hooks: fatal });
    killed.fire();
    expect([...killed.match.scores]).toEqual([["allies", 1]]);
  });

  /**
   * The suicide and the teamkill refuse the same point, and on this gametype they
   * refuse it twice over: somebody is always on their own side. So this pins down
   * the outcome, and the mutation that removes only the suicide clause survives it
   * — see `awardKill`, which says so.
   */
  it("gives a suicide none", () => {
    const deaths: { id: string; by: string | null }[] = [];
    const own = combat({
      hooks: {
        // The round on `b` is an ordinary 16; the shooter then kills themselves.
        playerDamage: (ctx, hit) => void (hit.id === "b" && ctx.damage("a", 1000, "a")),
        playerDeath: (_ctx, id, by) => void deaths.push({ id, by }),
      },
    });
    own.fire();
    expect(deaths).toEqual([{ id: "a", by: "a" }]);
    expect(own.state("a").dead).toBe(true);
    expect([...own.match.scores]).toEqual([]);
  });

  it("gives a teamkill none either", () => {
    const killed = combat({ gametype: oneSide, rules: { damageScale: 0.5, friendlyFire: true }, hooks: fatal });
    killed.fire();
    expect(killed.state("b").dead).toBe(true);
    expect([...killed.match.scores]).toEqual([]);
  });
});

describe("regeneration", () => {
  /** A second before it starts, and twenty health a second once it does. */
  const rules = { damageScale: 0.5, regenDelay: 1, regenRate: 20 };

  it("starts after the delay and not before", () => {
    const hurt = combat({ rules });
    hurt.fire();
    expect(hurt.health("b")).toBe(100 - CHEST_DAMAGE);

    // The tick of the hit advanced the clock once, so a whole second is 59 more.
    // Regeneration ignoring the delay would have put back 20 by now and the health
    // below would be full.
    hurt.idle(59);
    expect(hurt.state("b").sinceDamage).toBeCloseTo(1, 2);
    expect(hurt.health("b")).toBe(100 - CHEST_DAMAGE);

    // Half a second of it: ten health back, which is a different number from
    // either "none" or "all of it".
    hurt.idle(TICK_RATE / 2);
    expect(hurt.health("b")).toBe(100 - CHEST_DAMAGE + 10);

    // And a tick into regeneration, where the simulation is holding a fraction,
    // the state still encodes: `health` is a `uint(10)`, so a snapshot carrying
    // 84.333 does not arrive slightly wrong, it throws and takes everybody's
    // snapshot with it.
    hurt.idle(1);
    expect(() =>
      encodePacket(MessageType.snapshot, {
        tick: 1,
        ack: 0,
        presence: null,
        players: [{ id: "b", state: hurt.state("b") }],
        actors: [],
        counters: [],
        events: [],
      }),
    ).not.toThrow();

    // And it stops at full rather than running past it.
    hurt.idle(5 * TICK_RATE);
    expect(hurt.health("b")).toBe(100);
  });

  it("starts again from the last hit, not from the first", () => {
    const hurt = combat({ rules });
    hurt.fire();
    hurt.idle(59);
    // A second round resets the clock, so the half-second that follows buys
    // nothing where it would have bought ten.
    hurt.fire();
    expect(hurt.health("b")).toBe(100 - 2 * CHEST_DAMAGE);
    hurt.idle(TICK_RATE / 2);
    expect(hurt.health("b")).toBe(100 - 2 * CHEST_DAMAGE);
  });
});

describe("damage from inside a damage hook", () => {
  it("drains rather than recursing", () => {
    const log: string[] = [];
    // `a` shoots `b`; b's hook damages `c`. A stack would run c's hook inside b's
    // and close it first; a queue finishes b's and then starts c's. The order of
    // these four lines is the whole difference, and it is the only thing that can
    // tell the two implementations apart from the outside.
    const chain = combat({
      players: ["a", "b", "c"],
      hooks: {
        playerDamage: (ctx, hit) => {
          log.push(`enter ${hit.id}`);
          if (hit.id === "b") {
            // The world's damage rather than `hit.by`'s: `a` and `c` are on the
            // same side here, and friendly fire is not what is being tested.
            ctx.damage("c", 10, null);
          }
          log.push(`leave ${hit.id}`);
        },
      },
    });
    chain.fire();

    expect(log).toEqual(["enter b", "leave b", "enter c", "leave c"]);
    expect(chain.health("b")).toBe(100 - CHEST_DAMAGE);
    expect(chain.health("c")).toBe(100 - 10);
  });

  it("gives up on a cycle instead of taking the tick with it", () => {
    // Two hooks damaging each other one point at a time: it would terminate, in
    // two hundred applications, which is two hundred more than a tick should
    // spend on a script that has lost its way.
    const loop = combat({
      hooks: { playerDamage: (ctx, hit) => void ctx.damage(hit.id === "a" ? "b" : "a", 1, null) },
    });
    expect(() => loop.fire()).toThrow(/did not stop/);
  });
});

describe("the verbs that used to throw", () => {
  it("score, publish, setTeam and spawn all do something now — and send still does not", () => {
    const at = { position: { x: 12, y: 1.6, z: -4 }, look: { x: 12, y: 1.6, z: -5 } } as ResolvedSpawn;
    let refused: string | undefined;
    const run = combat({
      hooks: {
        playerDamage: (ctx) => {
          ctx.score("axis", 3);
          ctx.publish({ what: "hurt", team: "axis", value: 3 });
          ctx.setTeam("b", "allies");
          ctx.spawn("b", at);
          try {
            ctx.send("somebody", {});
          } catch (error) {
            refused = (error as Error).message;
          }
        },
      },
    });
    run.fire();

    expect([...run.match.scores]).toEqual([["axis", 3]]);
    expect(run.match.eventsThisTick).toEqual([{ what: "hurt", team: "axis", value: 3 }]);
    // `b` joined second and so was on `axis`, index 1. Now they are index 0.
    expect(run.state("b").team).toBe(0);
    expect(run.state("b").movement.feet.x).toBeCloseTo(12, 4);
    expect(refused).toMatch(/send\(\), which is declared but not built/);
  });

  it("refuses a side the gametype does not have, rather than putting them on the first one", () => {
    const wrong = combat({ hooks: { playerDamage: (ctx) => ctx.setTeam("b", "spectators") } });
    expect(() => wrong.fire()).toThrow(/which gametype "default" does not have/);
  });
});

describe("the rules a match is played by", () => {
  it("takes the script's numbers over the defaults, field by field", () => {
    const strict = combat({ rules: { friendlyFire: true, maxHealth: 150 } });
    expect(strict.match.rules).toEqual({ ...DEFAULT_COMBAT_RULES, friendlyFire: true, maxHealth: 150 });
    // And a player joined under them is at that match's full health, not at a
    // hundred — which is what a client needs `joined` to carry the rules for.
    strict.idle(1);
    expect(strict.health("a")).toBe(150);
  });

  it("falls back to the defaults for a gametype whose scripts have no opinion", () => {
    const match = new Match(ground, world(), TICK_RATE, 8, registry(), {
      map: MAP,
      gametype: defaultGametype,
      catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
      bodies: stubBodies("torsoUpper", 5),
      scripts: [],
    });
    expect(match.rules).toEqual(DEFAULT_COMBAT_RULES);
  });
});

/**
 * What a client is told about all of this, which is the snapshot tail and
 * nothing else (@3d/shared/net/messages/events.ts). The two kinds are here
 * together because the difference between them is the design: a hit marker is
 * addressed and momentary, a death is broadcast and repeated.
 */
describe("what the tail carries", () => {
  /** A hook that makes any hit fatal, so one round settles it. */
  const fatal: ServerHooks = { playerDamage: () => ({ amount: 1000 }) };
  /** Ticks a death keeps riding, as `KILL_FEED_REPEAT_SECONDS` sets it at this rate. */
  const REPEATS = TICK_RATE / 2;

  it("gives the hit marker to the shooter, on the tick it landed, and to nobody else", () => {
    const hit = combat({ location: "head" });
    hit.fire();

    expect(hit.events("a")).toEqual([{ kind: "hit", id: 1, location: "head", lethal: false }]);
    // The man who was shot is told his health, not that somebody hit him.
    expect(hit.events("b")).toEqual([]);

    // And it is gone on the next tick. A marker is a moment: one repeated would
    // be a lie about when it happened, and one never cleared would flash for the
    // rest of the match.
    hit.idle(1);
    expect(hit.events("a")).toEqual([]);
  });

  it("says when the round was the one that killed them", () => {
    const killed = combat({ hooks: fatal });
    killed.fire();
    expect(killed.events("a").filter((event) => event.kind === "hit")).toEqual([{ kind: "hit", id: 2, location: "torsoUpper", lethal: true }]);
  });

  it("draws no marker for a round that cost them nothing", () => {
    // A round stopped by somebody's rifle: a hit, traced and reported, that the
    // weapon file scores at zero.
    const gun = combat({ location: "gun" });
    expect(gun.fire()[0]!.result).toMatchObject({ kind: "player", id: "b" });
    expect(gun.events("a")).toEqual([]);

    // A teammate, with friendly fire off. The trace found them and the damage was
    // refused, which is exactly the case a marker drawn from the trace would get
    // wrong.
    const mates = combat({ gametype: oneSide });
    mates.fire();
    expect(mates.health("b")).toBe(100);
    expect(mates.events("a")).toEqual([]);

    // The control, and the reason the two lines above mean anything: the same
    // shot, allowed, does draw one.
    const allowed = combat({ gametype: oneSide, rules: { damageScale: 0.5, friendlyFire: true } });
    allowed.fire();
    expect(allowed.events("a")).toMatchObject([{ kind: "hit", lethal: false }]);

    // And a round that met nobody at all. The body is already down, so the bullet
    // reaches its range and finds nothing.
    const empty = combat({ hooks: fatal });
    empty.fire();
    empty.idle(1);
    expect(empty.fire()[0]!.result).toBeNull();
    // Filtered, because the kill that emptied the map is still being repeated:
    // that is the death's reliability, and it is what a marker deliberately lacks.
    expect(empty.events("a").filter((event) => event.kind === "hit")).toEqual([]);
  });

  it("gives the death to everyone, and keeps giving it for half a second", () => {
    const killed = combat({ hooks: fatal });
    killed.fire();

    const death = { kind: "death", id: 1, victim: "b", killer: "a", cause: "bullet" };
    expect(killed.events("a").filter((event) => event.kind === "death")).toEqual([death]);
    expect(killed.events("b")).toEqual([death]);

    // The same event, with the same id, every tick of the window — which is the
    // whole of its reliability, and why the id is what a client de-dupes on.
    killed.idle(REPEATS);
    expect(killed.events("b")).toEqual([death]);

    // And then it stops. A tail never cleared would repeat this line for the rest
    // of the match, and every client that missed a packet would have it twice.
    killed.idle(1);
    expect(killed.events("b")).toEqual([]);
    expect(killed.events("a")).toEqual([]);
  });

  it("names no killer where the world did it", () => {
    // A script's own damage, from nobody: a kill volume, a fall, a round timer.
    const scripted = combat({ hooks: { playerDamage: (ctx) => void ctx.damage("b", 1000, null) } });
    scripted.fire();
    expect(scripted.events("b").filter((event) => event.kind === "death")).toEqual([{ kind: "death", id: 1, victim: "b", killer: null, cause: "script" }]);
  });

  it("counts every event once, in one order, and tells a joining player where the count is", () => {
    const killed = combat({ hooks: fatal });
    expect(killed.match.eventCursor).toBe(0);
    killed.fire();

    // The death is issued while the damage is applied and the marker after it
    // returns, so the ids are the order things happened in — which is what makes
    // "newer than the newest I have seen" a sound de-dupe at the far end.
    expect(killed.events("a").map((event) => event.id)).toEqual([1, 2]);
    expect(killed.match.eventCursor).toBe(2);

    // A player joining now is told that number, so nothing already in the tail
    // reads as news to them.
    killed.match.join("c", carrying());
    expect(killed.match.eventCursor).toBe(2);
  });

  it("drops the oldest rather than overflowing the field the count is carried in", () => {
    // Eight deaths at once: the shot kills `b`, and the hook takes the rest of
    // the match down with it — the shooter included, which is a player's own
    // grenade and is always allowed.
    const crowd = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const massacre = combat({
      players: crowd,
      gametype: oneSide,
      rules: { damageScale: 0.5, friendlyFire: true },
      hooks: {
        playerDamage: (ctx, hit) => {
          if (hit.id !== "b") {
            return { amount: 1000 };
          }
          for (const id of crowd.filter((who) => who !== "b")) {
            ctx.damage(id, 1000, null);
          }
          return { amount: 1000 };
        },
      },
    });
    massacre.fire();

    // Nine events were issued — eight deaths and the shooter's marker — and the
    // field counts to seven. Without the cap this throws inside `encodePacket`
    // and takes everybody's snapshot with it.
    expect(massacre.match.eventCursor).toBe(9);
    const tail = massacre.events("a");
    expect(tail).toHaveLength(MAX_SNAPSHOT_EVENTS);
    // The newest seven, in order: the ones dropped are those that have already
    // been sent most often, and on this tick they have all been sent once.
    expect(tail.map((event) => event.id)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(() => encodePacket(MessageType.snapshot, { tick: 1, ack: 0, presence: null, players: [], actors: [], counters: [], events: tail })).not.toThrow();
  });
});
