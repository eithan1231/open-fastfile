// Actors in a match, on flat ground with a line of nodes baked on it.
//
// What is under test is the runtime: a script spawning zombies, their brain
// walking them to a player and swinging on its cooldown through the one damage
// queue, a player's rounds reaching them through `actorDamage` and `actorDeath`,
// a body lying for its kind's `corpse` seconds and going, and the whole of it
// playing out the same twice; and, with a (synthetic) catalogue creature, a gait
// moving at its clip's root-motion speed and a blow landing on its clip's note.
// Walking a real map is bots.test.ts's business, and the motor is the same one.

import { describe, expect, it, vi } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { ActorId, ActorSpec } from "@3d/shared/game/actors/actor.js";
import { ZOMBIE_KIND } from "@3d/shared/game/actors/kinds.js";
import { ZOMBIE } from "@3d/shared/game/bots/brains/zombie.js";
import { actorLook, readActorAssets, type ActorClipSetEntry, type ActorEntry } from "@3d/shared/game/actors/assets.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { hashString } from "@3d/shared/game/random.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { DamageVerdict, Script, ServerHooks } from "@3d/shared/game/hooks.js";
import { bakeNav } from "@3d/shared/nav/bake.js";
import { NO_INDEX_16, NO_INDEX_32, type NavFile } from "@3d/shared/nav/format.js";
import type { NavGraph } from "@3d/shared/nav/graph.js";
import { HEADER_FLAGS } from "@3d/shared/nav/vocab.js";
import { MAX_SNAPSHOT_ACTORS } from "@3d/shared/net/messages/actors.js";
import type { GameEvent } from "@3d/shared/net/messages/events.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { decodePacket, encodePacket, MessageType } from "@3d/shared/net/packet.js";
import type { SnapshotMessage } from "@3d/shared/net/messages/snapshot.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import { createMovement } from "@3d/shared/sim/movement.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import * as THREE from "three";
import { NO_BODIES, type BodyView, type LoadedActorBody } from "../src/bodies.js";
import { Match } from "../src/match/match.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const PLAYER = "aaaaaaaa";

/** Where the floor ends: past this x there is nothing to stand on. */
const EDGE = 100;

/** A floor at y = 0 out to `EDGE`, and nothing else: a bullet meets only bodies. */
const ground = {
  ready: true,
  resolveCapsule(
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean },
  ) {
    const floor = position.x < EDGE;
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false };
    result.position.x = position.x;
    result.position.y = floor ? Math.max(position.y, 0) : position.y;
    result.position.z = position.z;
    result.grounded = floor && position.y <= 0;
    return result;
  },
  overlapsCapsule: (position: { x: number; y: number }) => position.x < EDGE && position.y < 0,
  groundBelow: (from: { x: number; y: number }, distance: number) => (from.x < EDGE && from.y >= 0 && from.y - distance <= 0 ? 0 : null),
  surfaceAt: () => null,
  traceRay: () => null,
};

function world(): ResolvedWorld {
  return {
    game: "iw5",
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

/** Nodes half a metre above the floor, every 4 m along -Z from the spawn: links derived at load. */
function lineFile(count: number): NavFile {
  const position = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    position.set([0, 0.5, -4 * i], i * 3);
  }
  return {
    major: 1,
    minor: 0,
    flags: HEADER_FLAGS.DERIVE_WALK_LINKS,
    nodes: {
      count,
      position,
      yaw: new Uint16Array(count),
      type: new Uint8Array(count),
      flags: new Uint8Array(count),
      abilities: new Uint32Array(count),
      source: new Uint32Array(count).fill(NO_INDEX_32),
      name: new Uint32Array(count),
      group: new Uint16Array(count).fill(NO_INDEX_16),
      stance: new Uint8Array(count),
    },
    links: {
      count: 0,
      first: new Uint32Array(count + 1),
      target: new Uint32Array(0),
      gameCost: new Float32Array(0),
      kind: new Uint8Array(0),
      flags: new Uint8Array(0),
      traversal: new Uint16Array(0),
    },
    traversals: { count: 0, begin: new Uint32Array(0), end: new Uint32Array(0), kind: new Uint8Array(0), animscript: new Uint32Array(0) },
    strings: [""],
    meta: null,
    sections: [],
  };
}

let baked: NavGraph | undefined;
/** Five nodes over 16 m. */
function lineGraph(): NavGraph {
  baked ??= bakeNav(lineFile(5), ground, movementRules(world()), { tickRate: TICK_RATE }).graph;
  return baked;
}

/** Full damage inside 10 m; a chest round is 40 × 0.8. */
const CHEST_DAMAGE = 32;

function registry(): WeaponRegistry {
  return new WeaponRegistry([
    {
      id: "test_mp",
      game: "iw5",
      slot: "primary",
      class: "rifle",
      def: weaponDef({ clipSize: 30, damage: { max: 40, min: 20, maxRange: 394, minRange: 1181 }, locationDamage: { torsoUpper: 0.8 } }),
      attachments: [],
    },
  ]);
}

const RIFLE: Loadout = { name: "Test", game: "iw5", primary: { weapon: "iw5/test_mp", attachments: [] }, secondary: { weapon: null, attachments: [] } };

interface Setup {
  hooks?: ServerHooks;
  nav?: boolean;
  /** Spawned on the match's first step. */
  spawn?: ActorSpec[];
  armed?: boolean;
  bodies?: BodyView;
  catalogue?: CatalogueView;
}

/** A creature for the zombie kind: two bodies, one head, and a clip per role with made-up numbers. */
const ENTRY: ActorEntry = {
  id: "zombie_ger",
  game: "t5",
  kind: "zombie",
  version: 1,
  bodies: ["b0.glb", "b1.glb"],
  heads: ["h0.glb"],
  bodyWeights: [1, 3],
  animations: "zombie",
  hitboxes: "z.hitboxes.json",
};
const clip = (duration: number, speed: number | null, fire: number[] = []) => ({
  duration,
  looped: fire.length === 0,
  notes: fire.map((at): [string, number] => ["fire", at]),
  rootMotion: speed === null ? null : { forward: speed * duration, left: 0, up: 0, yaw: 0, speed },
});
const CLIP_SET: ActorClipSetEntry = {
  id: "zombie",
  game: "t5",
  actor: true,
  version: 1,
  clips: "animations.glb",
  roles: { idle: ["idle"], walk: ["walk"], sprint: ["sprint"], attack: ["attack"], death: ["death"] },
  clipTable: { idle: clip(2, null), walk: clip(2, 0.9), sprint: clip(1, 3.5), attack: clip(1.5, null, [0.5]), death: clip(3, 0.3) },
};
const CREATURES = catalogueViewOf(
  { version: CATALOG_VERSION, weapons: [], actors: [ENTRY], animations: [{ ...CLIP_SET, animType: "zombie" }] },
  new WeaponRegistry([]),
);

function arena(setup: Setup = {}) {
  let ctx: ServerContext | undefined;
  const spawned: ActorId[] = [];
  const script: Script = {
    id: "actors-test",
    server: {
      // A player who can take a few blows and does not heal between them.
      combatRules: () => ({ maxHealth: 1000, regenRate: 0 }),
      matchStart: (c) => {
        for (const spec of setup.spawn ?? []) {
          spawned.push(c.actors.spawn(spec));
        }
      },
      tick: (c) => {
        ctx = c;
      },
      ...setup.hooks,
    },
  };
  const match = new Match(ground, world(), TICK_RATE, 4, registry(), {
    map: "flat",
    gametype: defaultGametype,
    catalogue: setup.catalogue ?? catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: setup.bodies ?? NO_BODIES,
    scripts: [script],
    nav: setup.nav === false ? undefined : { graph: lineGraph() },
  });
  match.join(PLAYER, setup.armed ? RIFLE : undefined);

  let seq = 0;
  const snapshots: SnapshotMessage[] = [];
  const events: GameEvent[] = [];
  const tick = (input: PlayerInput = idleInput(0, 0)) => {
    const message: InputMessage = {
      seq: ++seq,
      dt: DT,
      input,
      claim: createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
      renderTick: match.tick & 0xffff,
      renderFrac: 0,
    };
    match.receive(PLAYER, message);
    const step = match.step();
    const mine = match.snapshotFor(PLAYER, step.players);
    snapshots.push(mine);
    events.push(...mine.events);
    return mine;
  };
  const run = (seconds: number, input?: PlayerInput) => {
    for (let i = 0; i < Math.round(seconds * TICK_RATE); i++) {
      tick(input);
    }
  };
  return { match, tick, run, snapshots, events, spawned, ctx: () => ctx! };
}

/** Two runners at the far end of the line, hunting whoever there is: with no creature, a run is the kind's `runSpeed`. */
const HORDE: ActorSpec[] = [
  { kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -16 }, gait: "run" },
  { kind: "zombie", brain: ZOMBIE, at: { x: 0.5, y: 0, z: -15 }, look: { x: 0, y: 0, z: 0 }, gait: "run" },
];

interface Blow {
  tick: number;
  amount: number;
  by: string | null;
  cause: string;
  actor: ActorId | undefined;
}

function chase() {
  const blows: Blow[] = [];
  const deaths: unknown[] = [];
  const a = arena({
    spawn: HORDE,
    hooks: {
      playerDamage: (c, hit) => {
        blows.push({ tick: Math.round(c.now * TICK_RATE), amount: hit.amount, by: hit.by, cause: hit.cause, actor: hit.actor });
      },
      playerDeath: (_c, id, by, cause, actor) => {
        deaths.push({ id, by, cause, actor });
      },
    },
  });
  a.run(14);
  return { ...a, blows, deaths };
}

describe("actors in a match", () => {
  it("are spawned by a script, walk the graph to a player and hit them on the kind's cooldown", () => {
    const { blows, snapshots, spawned, match } = chase();
    expect(spawned).toEqual([1, 2]);

    // They came: the first blow lands once they have covered the 16 m, at the kind's own speed.
    expect(blows.length).toBeGreaterThanOrEqual(6);
    const first = blows[0]!.tick;
    expect(first / TICK_RATE).toBeGreaterThan(16 / ZOMBIE_KIND.runSpeed - 1);
    expect(first / TICK_RATE).toBeLessThan(12);

    // Through the queue, as nobody's melee, carrying the actor that swung.
    for (const blow of blows) {
      expect(blow).toMatchObject({ amount: ZOMBIE_KIND.melee.damage, by: null, cause: "melee" });
      expect(spawned).toContain(blow.actor);
    }
    // No actor swings faster than its cooldown.
    for (const id of spawned) {
      const ticks = blows.filter((b) => b.actor === id).map((b) => b.tick);
      expect(ticks.length).toBeGreaterThan(1);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]! - ticks[i - 1]!).toBeGreaterThanOrEqual(ZOMBIE_KIND.melee.cooldown * TICK_RATE);
      }
    }

    // The health moved by exactly what the blows said.
    const last = snapshots.at(-1)!;
    expect(last.players[0]!.state.health).toBe(1000 - blows.length * ZOMBIE_KIND.melee.damage);
    // And the wire said what they were doing: walking in, then swinging where the player stands.
    const actions = new Set(snapshots.flatMap((s) => s.actors.map((x) => x.action)));
    expect(actions.has("move") && actions.has("attack")).toBe(true);
    expect(actions.has("die")).toBe(false);
    for (const actor of last.actors) {
      expect(Math.hypot(actor.feet.x, actor.feet.z)).toBeLessThan(ZOMBIE_KIND.melee.reach + 0.1);
    }
    expect(match.tick).toBe(14 * TICK_RATE);
  });

  it("kills a player it keeps hitting, as nobody's melee with the actor beside it", () => {
    const deaths: { by: unknown; cause: unknown; actor: unknown }[] = [];
    const a = arena({
      spawn: [HORDE[0]!],
      hooks: {
        combatRules: () => ({ maxHealth: 100, regenRate: 0 }),
        playerDeath: (_c, _id, by, cause, actor) => {
          deaths.push({ by, cause, actor });
        },
      },
    });
    a.run(14);
    expect(deaths[0]).toEqual({ by: null, cause: "melee", actor: 1 });
    // The kill feed hears it as the world's doing, by melee.
    expect(a.events.find((e) => e.kind === "death")).toMatchObject({ victim: PLAYER, killer: null, cause: "melee" });
  });

  it("plays out the same twice", () => {
    const one = chase();
    const two = chase();
    expect(two.blows).toEqual(one.blows);
    expect(JSON.stringify(two.snapshots.map((s) => s.actors))).toBe(JSON.stringify(one.snapshots.map((s) => s.actors)));
  });

  it("never stands two in one place: a pile at one spawn spreads, and a horde surrounds its quarry", () => {
    const apart = (a: ReturnType<typeof arena>) => {
      const feet = a.spawned.map((id) => a.ctx().actors.state(id)!.feet);
      let nearest = Infinity;
      for (let i = 0; i < feet.length; i++) {
        for (let j = i + 1; j < feet.length; j++) {
          nearest = Math.min(nearest, Math.hypot(feet[i]!.x - feet[j]!.x, feet[i]!.z - feet[j]!.z));
        }
      }
      return nearest;
    };
    const touching = 2 * ZOMBIE_KIND.radius - 0.02;

    const pile = arena({ nav: false, spawn: Array.from({ length: 4 }, () => ({ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -8 } })) });
    pile.run(1);
    expect(apart(pile)).toBeGreaterThan(touching);

    const blows = new Map<ActorId | undefined, number>();
    const horde = arena({
      spawn: Array.from({ length: 5 }, (_, i) => ({ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -16 + i * 0.1 }, gait: "run" as const })),
      hooks: { playerDamage: (_c, hit) => void blows.set(hit.actor, (blows.get(hit.actor) ?? 0) + 1) },
    });
    horde.run(16);
    expect(apart(horde)).toBeGreaterThan(touching);
    // Every one of them got round to the player, not just the first in the queue.
    expect([...blows.keys()].sort()).toEqual(horde.spawned);
  });

  it("is shot, heard by actorDamage and then actorDeath, lies for its corpse time and goes", () => {
    const damage: unknown[] = [];
    const deaths: unknown[] = [];
    const a = arena({
      nav: false,
      armed: true,
      spawn: [{ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -5 }, health: 100 }],
      hooks: {
        actorDamage: (_c, actor, amount, by, location, cause) => {
          damage.push({ actor, amount, by, location, cause });
        },
        actorDeath: (_c, actor, by, cause, location) => {
          deaths.push({ actor, by, cause, location });
        },
      },
    });
    const fire = { ...idleInput(0, 0), fire: true };
    for (let i = 0; i < 300 && deaths.length === 0; i++) {
      a.tick(fire);
    }
    // 100 health at 32 a round: the fourth kills it.
    expect(damage).toHaveLength(4);
    expect(damage[0]).toEqual({ actor: 1, amount: CHEST_DAMAGE, by: PLAYER, location: "torsoUpper", cause: "bullet" });
    expect(deaths).toEqual([{ actor: 1, by: PLAYER, cause: "bullet", location: "torsoUpper" }]);
    // A marker per round that cost it something, and the last one lethal.
    const hits = a.events.filter((e) => e.kind === "hit");
    expect(hits).toHaveLength(4);
    expect(hits.at(-1)).toMatchObject({ lethal: true });

    // Lying there: on the wire as dying, and in the script's list.
    const lying = a.snapshots.at(-1)!.actors[0]!;
    expect(lying).toMatchObject({ id: 1, action: "die", dead: true });
    // A body stops no round: what is fired at it now goes past.
    const met: (string | undefined)[] = [];
    for (let i = 0; i < 30; i++) {
      a.tick(fire);
      met.push(...a.match.shotsThisTick.map((shot) => shot.result?.kind));
    }
    expect(met.length).toBeGreaterThan(0);
    expect(met.includes("actor")).toBe(false);
    a.run(ZOMBIE_KIND.corpse - 0.6);
    expect(a.snapshots.at(-1)!.actors.map((x) => x.id)).toEqual([1]);
    expect(a.ctx().actors.state(1)).toMatchObject({ alive: false, health: 0 });
    a.run(0.2);
    expect(a.snapshots.at(-1)!.actors).toEqual([]);
    expect(a.ctx().actors.ids()).toEqual([]);
  });

  it("is shot against the body its look wears, posed as it stands", () => {
    const posed: { body: number; state: unknown; look: unknown }[] = [];
    const rig = (body: number) => ({
      rig: { root: new THREE.Object3D() },
      poser: { update: (state: unknown, look: unknown) => posed.push({ body, state, look }) },
      boxes: { trace: () => ({ bone: "j_head", location: "head", fraction: 0.01 }) },
    });
    const body = { kind: "zombie", bodies: [rig(0), rig(1)] } as unknown as LoadedActorBody;
    const damage: unknown[] = [];
    const a = arena({
      nav: false,
      armed: true,
      catalogue: CREATURES,
      bodies: { get: () => undefined, actor: (kind) => (kind === "zombie" ? body : undefined) },
      spawn: [{ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -5 } }],
      hooks: {
        actorDamage: (_c, _actor, _amount, _by, location) => {
          damage.push(location);
          return { ignore: true };
        },
      },
    });
    const fire = { ...idleInput(0, 0), fire: true };
    for (let i = 0; i < 300 && damage.length === 0; i++) {
      a.tick(fire);
    }
    expect(damage).toEqual(["head"]);
    // The body and clips the client draws for actor 1 on this map, from the same seed.
    const look = actorLook(readActorAssets(ENTRY, CLIP_SET), hashString("flat"), 1, "walk");
    expect(posed[0]).toEqual({ body: look.body, state: expect.objectContaining({ action: "idle", gait: "walk" }), look });
  });

  it("moves at its gait clip's root-motion speed, its cycle turning at the clip's own rate", () => {
    for (const [gait, speed, duration] of [
      ["walk", 0.9, 2],
      ["sprint", 3.5, 1],
    ] as const) {
      const a = arena({ catalogue: CREATURES, spawn: [{ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -16 }, gait }] });
      a.run(3);
      const moving = a.snapshots.map((s) => s.actors[0]!).filter((x) => x.action === "move" && Math.abs(x.speed - speed) < 0.1);
      expect(moving.length).toBeGreaterThan(30);
      expect(Math.max(...a.snapshots.map((s) => s.actors[0]!.speed))).toBeLessThan(speed + 0.1);
      expect(moving.every((x) => x.gait === gait)).toBe(true);
      // At its own speed, one tick turns the cycle by a tick's share of the clip.
      const [p, q] = [moving.at(-2)!.phase, moving.at(-1)!.phase];
      expect((q - p + 1) % 1).toBeCloseTo(DT / duration, 2);
    }
  });

  it("lands its blow on the attack clip's note, and swings no faster than the clip is long", () => {
    const blows: number[] = [];
    const a = arena({
      catalogue: CREATURES,
      spawn: [{ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -16 }, gait: "sprint" }],
      hooks: {
        playerDamage: (c) => {
          blows.push(Math.round(c.now * TICK_RATE));
        },
      },
    });
    a.run(12);
    expect(blows.length).toBeGreaterThan(2);
    // Each blow half a second (the note) after its swing began on the wire.
    const swings = a.snapshots.filter((s) => s.actors[0]!.action === "attack" && s.actors[0]!.phase === 0).map((s) => s.tick);
    for (const at of blows) {
      const began = Math.max(...swings.filter((tick) => tick <= at));
      expect(at - began).toBe(0.5 * TICK_RATE);
    }
    for (let i = 1; i < blows.length; i++) {
      expect(blows[i]! - blows[i - 1]!).toBeGreaterThanOrEqual(1.5 * TICK_RATE);
    }
  });

  it("takes a script's verdict on a hit", () => {
    const deaths: unknown[] = [];
    const verdicts: (DamageVerdict | undefined)[] = [{ ignore: true }, { amount: 1000 }];
    const a = arena({
      nav: false,
      armed: true,
      spawn: [{ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -5 } }],
      hooks: {
        actorDamage: () => verdicts.shift(),
        actorDeath: (_c, actor) => {
          deaths.push(actor);
        },
      },
    });
    const fire = { ...idleInput(0, 0), fire: true };
    for (let i = 0; i < 300 && deaths.length === 0; i++) {
      a.tick(fire);
    }
    // The first was refused and drew no marker; the second was re-priced past its health.
    expect(deaths).toEqual([1]);
    expect(a.events.filter((e) => e.kind === "hit")).toHaveLength(1);
  });

  it("answers the script: spawn, order, remove, damage, ids and state", () => {
    const a = arena({ nav: false });
    a.tick();
    const ctx = a.ctx();
    expect(() => ctx.actors.spawn({ kind: "dragon", brain: ZOMBIE, at: { x: 0, y: 0, z: 0 } })).toThrow(/dragon/);
    expect(() => ctx.actors.spawn({ kind: "zombie", brain: "nobody", at: { x: 0, y: 0, z: 0 } })).toThrow(/nobody/);
    const one = ctx.actors.spawn({ kind: "zombie", brain: ZOMBIE, at: { x: 1, y: 0, z: -3 }, health: 40 });
    const two = ctx.actors.spawn({ kind: "zombie", brain: ZOMBIE, at: { x: -1, y: 0, z: -3 } });
    expect([one, two]).toEqual([1, 2]);
    expect(ctx.actors.state(one)).toEqual({ id: 1, kind: "zombie", feet: { x: 1, y: 0, z: -3 }, yaw: 0, alive: true, health: 40 });
    expect(ctx.actors.remove(one)).toBe(true);
    expect(ctx.actors.remove(one)).toBe(false);
    expect(ctx.actors.state(one)).toBeUndefined();
    // Never reused.
    expect(ctx.actors.spawn({ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -3 } })).toBe(3);
    expect(ctx.actors.ids()).toEqual([2, 3]);
    ctx.actors.order(two, { kind: "goto", point: { x: 0, y: 0, z: -8 } });
    ctx.actors.order(99, null); // not here: nothing
    ctx.actors.damage(two, ZOMBIE_KIND.health, null);
    expect(ctx.actors.state(two)).toMatchObject({ alive: false, health: 0 });
    a.tick();
    expect(a.snapshots.at(-1)!.actors.map((x) => [x.id, x.action])).toEqual([
      [2, "die"],
      [3, "idle"],
    ]);
  });

  it("dies of falling under the world, past a script's say", () => {
    const damage = vi.fn();
    const deaths: unknown[] = [];
    const a = arena({
      nav: false,
      spawn: [{ kind: "zombie", brain: ZOMBIE, at: { x: EDGE + 10, y: 0, z: 0 } }],
      hooks: {
        actorDamage: damage,
        actorDeath: (_c, actor, by, cause) => {
          deaths.push({ actor, by, cause });
        },
      },
    });
    a.run(3);
    expect(deaths).toEqual([{ actor: 1, by: null, cause: "outOfWorld" }]);
    expect(damage).not.toHaveBeenCalled();
  });

  it("sends each player the nearest past the cap, and every one below it", () => {
    const a = arena({ nav: false });
    a.tick();
    const ctx = a.ctx();
    const count = MAX_SNAPSHOT_ACTORS + 6;
    // Spawned furthest first, so the nearest are the last ids.
    for (let i = 0; i < count; i++) {
      ctx.actors.spawn({ kind: "zombie", brain: ZOMBIE, at: { x: 0, y: 0, z: -(count - i) } });
    }
    const snapshot = a.tick();
    expect(snapshot.actors).toHaveLength(MAX_SNAPSHOT_ACTORS);
    expect(Math.min(...snapshot.actors.map((x) => x.id))).toBe(7);
    // And it fits a datagram's encoder, cap and all.
    const back = decodePacket(encodePacket(MessageType.snapshot, snapshot)).message as SnapshotMessage;
    expect(back.actors).toHaveLength(MAX_SNAPSHOT_ACTORS);

    for (let i = 1; i <= 6; i++) {
      ctx.actors.remove(i + MAX_SNAPSHOT_ACTORS);
    }
    expect(a.tick().actors.map((x) => x.id)).toEqual(Array.from({ length: MAX_SNAPSHOT_ACTORS }, (_, i) => i + 1));
  });
});
