// Several games in one process, on any number of maps: who gets in, when one is
// over, and what happens to a world nobody is playing on any more.
//
// No socket and no real world — `Match` takes a CapsuleWorld and a ResolvedWorld
// and asks nothing else of them, so flat ground and an empty world are enough to
// stand real games up. What is under test is admission, the end conditions, and
// the refcount that unloads a map, which is everything this file owns that
// match.ts does not.

import { DEFAULT_GAMETYPE } from "@3d/shared/game/gametypes/registry.js";
import "reflect-metadata";
import { indexWorld } from "@3d/shared/worlds/worldIndex.js";
import { WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { Weapons } from "../src/weapons.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { GameOrder } from "@3d/shared/protocol/events/server.js";
import { defaultLoadouts } from "@3d/shared/sim/loadout.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import { NO_BODIES } from "../src/bodies.js";
import { config } from "../src/config.js";
import { Games } from "../src/games.js";
import { Physics } from "../src/physics.js";
import { WorldRegistry, type LoadedWorld } from "../src/worlds.js";

const MAP = "rust-mw2";

/** Nothing to stand on: the simulation is not what this file is about. */
const NOWHERE: CapsuleWorld = { ready: false, resolveCapsule: () => undefined } as unknown as CapsuleWorld;

/** The least world Match's join rules will accept: a spawn, no terrain, no rooms. */
const EMPTY_WORLD = {
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

const order = (overrides: Partial<GameOrder> = {}): GameOrder => ({
  gameId: "g-1",
  map: MAP,
  gametype: DEFAULT_GAMETYPE,
  maxPlayers: 2,
  durationSeconds: 600,
  players: [
    { id: "aaaaaaaa", authorizationKey: "key-for-ana", loadouts: defaultLoadouts() },
    { id: "bbbbbbbb", authorizationKey: "key-for-bo", loadouts: defaultLoadouts() },
  ],
  ...overrides,
});

/**
 * A registry that hands out a world without loading one, counting acquires and
 * releases so a test can assert on the refcount rather than on a log line.
 * Real loading is apiIntegration.test.ts's job; this file is about who holds it.
 */
function fakeWorlds(failing: string[] = []) {
  const held = new Map<string, number>();
  const registry = {
    get loaded() {
      return [...held.keys()];
    },
    acquire: vi.fn(async (map: string): Promise<LoadedWorld> => {
      if (failing.includes(map)) {
        throw new Error(`${map}: no such world`);
      }
      held.set(map, (held.get(map) ?? 0) + 1);
      return { map, world: EMPTY_WORLD, index: indexWorld(EMPTY_WORLD), hash: "test", collision: NOWHERE };
    }),
    release: vi.fn((map: string): void => {
      const n = (held.get(map) ?? 0) - 1;
      if (n <= 0) {
        held.delete(map);
      } else {
        held.set(map, n);
      }
    }),
  };
  return { registry: registry as unknown as WorldRegistry, held };
}

/** An instance whose catalogue is empty: players here are unarmed, which these tests do not exercise. */
function noWeapons(): Weapons {
  return { all: new WeaponRegistry([]), hash: new WeaponRegistry([]).hash, load: async () => {} } as unknown as Weapons;
}

/**
 * A game server with no physics engine, which is what every test here is about:
 * the games, the roster and the clock. `Physics.create` answering undefined is
 * also the real behaviour of an instance whose engine failed to load.
 */
function noPhysics(): Physics {
  return { available: false, load: async () => {}, create: () => undefined } as unknown as Physics;
}

function setup(options: { failing?: string[] } = {}) {
  let clock = 1_000_000;
  const { registry, held } = fakeWorlds(options.failing);
  const games = new Games(registry, noWeapons(), NO_BODIES, noPhysics(), () => clock);
  return { games, registry, held, advance: (ms: number) => void (clock += ms), now: () => clock };
}

/**
 * `config` is a module const a game server reads its limits from, so a test that
 * wants a different limit overrides the field and `beforeEach` puts it back.
 */
const CONFIG_DEFAULTS = { maxGames: config.maxGames, joinGraceMs: config.joinGraceMs };

function withConfig(overrides: Partial<typeof CONFIG_DEFAULTS>): void {
  Object.assign(config, overrides);
}

beforeEach(() => {
  container.reset();
  Object.assign(config, CONFIG_DEFAULTS);
});

describe("hosting several games", () => {
  it("keeps them apart, each with its own players", async () => {
    const { games } = setup();
    const one = (await games.create(order({ gameId: "g-1" })))!;
    const two = (await games.create(order({ gameId: "g-2" })))!;

    one.match.join("aaaaaaaa");
    two.match.join("bbbbbbbb");

    expect(one.match.size).toBe(1);
    expect(two.match.size).toBe(1);
    expect(one.match.has("bbbbbbbb")).toBe(false);
    expect(games.players).toBe(2);
    expect(games.size).toBe(2);
  });

  it("refuses one game too many", async () => {
    // maxGames is config, so it is stubbed rather than passed: a game server
    // reads its limits from the environment and nothing hands them to `Games`.
    withConfig({ maxGames: 1 });
    const { games } = setup();
    await expect(games.create(order({ gameId: "g-1" }))).resolves.toBeDefined();
    await expect(games.create(order({ gameId: "g-2" }))).resolves.toBeUndefined();
    expect(games.count).toBe(1);
  });

  it("keeps every refusal for the reporter, once each, and nothing that was not one", async () => {
    withConfig({ maxGames: 1 });
    const { games } = setup({ failing: ["broken"] });
    await games.create(order({ gameId: "g-1" }));
    await games.create(order({ gameId: "g-1" })); // a replay, not a refusal
    await games.create(order({ gameId: "g-2" }));
    expect(games.takeRefusals()).toEqual([["g-2", "already hosting 1"]]);
    expect(games.takeRefusals()).toEqual([]);

    games.drop("g-1");
    await games.create(order({ gameId: "g-3", map: "broken" }));
    await games.create(order({ gameId: "g-4", gametype: "pitfighter" }));
    expect(games.takeRefusals().map(([id]) => id)).toEqual(["g-3", "g-4"]);
  });

  it("hosts games on different maps at once", async () => {
    const { games, held } = setup();
    await games.create(order({ gameId: "g-1", map: "rust-mw2" }));
    await games.create(order({ gameId: "g-2", map: "dome-mw3" }));

    expect(games.size).toBe(2);
    expect(new Set(held.keys())).toEqual(new Set(["rust-mw2", "dome-mw3"]));
  });

  it("refuses a game whose map will not load", async () => {
    const { games, held } = setup({ failing: ["broken"] });
    expect(await games.create(order({ map: "broken" }))).toBeUndefined();
    expect(games.size).toBe(0);
    // And holds no reference to it, so the next order retries the load.
    expect(held.size).toBe(0);
  });

  it("refuses a game whose gametype it does not know, and keeps hosting the rest", async () => {
    const { games, held } = setup();
    // An authority a version ahead may name a gametype this build has never heard
    // of. Refusing the *game* rather than falling over is the whole point: the
    // instance is a fleet member and its other games are not at fault.
    expect(await games.create(order({ gameId: "g-1", gametype: "pitfighter" }))).toBeUndefined();
    expect(games.size).toBe(0);
    // And no world reference was taken, so nothing leaks a load for a game that
    // never stood up — the check runs before `worlds.acquire`.
    expect(held.size).toBe(0);
    await expect(games.create(order({ gameId: "g-2" }))).resolves.toBeDefined();
    expect(games.size).toBe(1);
  });

  it("plays the gametype the order names, which is what a match is handed", async () => {
    const { games } = setup();
    const game = await games.create(order({ gametype: DEFAULT_GAMETYPE }));
    expect(game?.match.gametype.id).toBe(DEFAULT_GAMETYPE);
  });

  it("takes the same order twice, because a reconnect re-sends every one", async () => {
    const { games } = setup();
    const first = (await games.create(order()))!;
    await expect(games.create(order())).resolves.toBe(first);
    expect(games.size).toBe(1);
  });
});

describe("admission", () => {
  it("admits a player on the roster with their own key", async () => {
    const { games } = setup();
    await games.create(order());
    expect(games.admits("g-1", "aaaaaaaa", "key-for-ana")).toBe(true);
  });

  it("refuses the wrong key, another player's key, and a player who is not on it", async () => {
    const { games } = setup();
    await games.create(order());
    expect(games.admits("g-1", "aaaaaaaa", "key-for-bo")).toBe(false);
    expect(games.admits("g-1", "aaaaaaaa", "")).toBe(false);
    expect(games.admits("g-1", "cccccccc", "key-for-ana")).toBe(false);
  });

  it("refuses everyone for a game it is not hosting", async () => {
    const { games } = setup();
    expect(games.admits("g-nope", "aaaaaaaa", "key-for-ana")).toBe(false);
  });
});

describe("when a game is over", () => {
  it("is not over while its grace window is open, however empty it is", async () => {
    const { games, advance } = setup();
    await games.create(order());
    // Players are told about a game before they have loaded the world, so a new
    // one is legitimately empty. Ending it here would end every game at birth.
    advance(59_000);
    expect(games.finished()).toEqual([]);
  });

  it("is not over while everyone admitted is still choosing a class", async () => {
    const { games, advance } = setup();
    const game = (await games.create(order()))!;
    game.joined = true;
    game.choosing.add("aaaaaaaa");
    advance(config.joinGraceMs + 1);
    expect(games.finished()).toEqual([]);

    game.choosing.delete("aaaaaaaa");
    expect(games.finished().map((f) => f.ending)).toEqual(["abandoned"]);
  });

  it("is over once nobody ever arrived", async () => {
    const { games, advance } = setup();
    await games.create(order());
    advance(61_000);
    expect(games.finished().map((f) => f.ending)).toEqual(["unattended"]);
  });

  it("is over once everyone who did arrive has left", async () => {
    const { games, advance } = setup();
    const game = (await games.create(order()))!;
    game.match.join("aaaaaaaa");
    game.joined = true;

    advance(61_000);
    expect(games.finished()).toEqual([]);

    game.match.leave("aaaaaaaa");
    expect(games.finished().map((f) => f.ending)).toEqual(["abandoned"]);
  });

  it("is over at once when it threw on its tick, and says so", async () => {
    const { games } = setup();
    const game = (await games.create(order()))!;
    game.match.join("aaaaaaaa");
    game.match.fail(new Error("a script bug"));
    expect(games.finished().map((f) => f.ending)).toEqual(["errored"]);
    expect(game.match.failed).toBe("a script bug");
  });

  it("is over when its time runs out, however full it is", async () => {
    const { games, advance } = setup();
    const game = (await games.create(order({ durationSeconds: 120 })))!;
    game.match.join("aaaaaaaa");
    game.joined = true;

    advance(119_000);
    expect(games.finished()).toEqual([]);
    advance(2_000);
    expect(games.finished().map((f) => f.ending)).toEqual(["expired"]);
  });

  it("is over when its gametype says so, with people still in it", async () => {
    const { games } = setup();
    const game = (await games.create(order()))!;
    game.match.join("aaaaaaaa");
    game.joined = true;
    expect(games.finished()).toEqual([]);
    // What `ServerContext.endMatch` leaves behind.
    vi.spyOn(game.match, "ended", "get").mockReturnValue("everyone died");
    expect(games.finished().map((f) => f.ending)).toEqual(["over"]);
  });

  it("stops being hosted once it is dropped", async () => {
    const { games, advance } = setup();
    await games.create(order());
    advance(61_000);
    games.drop("g-1");
    expect(games.finished()).toEqual([]);
    expect(games.get("g-1")).toBeUndefined();
    expect(games.size).toBe(0);
  });
});

describe("the authority's list", () => {
  it("drops every game a hello does not name, running or still loading, and keeps the rest", async () => {
    const { games, held } = setup();
    await games.create(order({ gameId: "g-1" }));
    await games.create(order({ gameId: "g-2" }));
    const loading = games.create(order({ gameId: "g-3" }));

    expect(games.retain(new Set(["g-2"])).sort()).toEqual(["g-1", "g-3"]);
    expect(await loading).toBeUndefined();
    expect(games.all().map((game) => game.id)).toEqual(["g-2"]);
    expect(held.get(MAP)).toBe(1);
  });

  it("never stands a game up again once it has ended here", async () => {
    const { games, registry } = setup();
    await games.create(order());
    games.drop("g-1");
    // A hello sent before the api heard the game was over still names it.
    expect(await games.create(order())).toBeUndefined();
    expect(games.size).toBe(0);
    expect(registry.acquire).toHaveBeenCalledTimes(1);
  });
});

describe("the worlds a game holds", () => {
  it("loads a map once for several games on it, and unloads it with the last", async () => {
    const { games, registry, held } = setup();
    await games.create(order({ gameId: "g-1" }));
    await games.create(order({ gameId: "g-2" }));

    // Two games, two references, one map.
    expect(held.get(MAP)).toBe(2);
    expect(registry.acquire).toHaveBeenCalledTimes(2);

    games.drop("g-1");
    expect(held.has(MAP)).toBe(true);
    games.drop("g-2");
    // Nothing is playing on it, so nothing is holding its BVH.
    expect(held.has(MAP)).toBe(false);
  });

  it("gives the world back when a game is dropped while its map is still loading", async () => {
    const { games, held } = setup();
    const standing = games.create(order());
    // `gameEnd` arriving before the load finished: the lobby was cancelled.
    games.drop("g-1");

    expect(await standing).toBeUndefined();
    expect(games.size).toBe(0);
    // The load completed and its reference was returned rather than stranded.
    expect(held.has(MAP)).toBe(false);
  });

  it("counts a game still loading against maxGames", async () => {
    withConfig({ maxGames: 1 });
    const { games } = setup();
    const first = games.create(order({ gameId: "g-1" }));
    // Before the first has finished loading, which is when an instance would
    // otherwise overshoot its limit.
    expect(await games.create(order({ gameId: "g-2" }))).toBeUndefined();
    expect(await first).toBeDefined();
  });
});
