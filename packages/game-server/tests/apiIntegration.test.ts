// A game server loading a world the way it really does: over the worlds URLs,
// from the api's own route code, with its service token.
//
// @3d/api is a devDependency here and imported only by this file. The two
// servers may not import each other at runtime — eslint.config.js enforces that
// on src/ and scripts/ — but a test that proves the two ends agree has to be
// able to stand both of them up, and doing it with the real routes rather than a
// mock of them is the entire point: a mock would agree with whatever this file
// assumed.
//
// `app.request` satisfies HttpFetch, so all of this runs in-process with no port
// bound anywhere.

import "reflect-metadata";
import { indexWorld } from "@3d/shared/worlds/worldIndex.js";
import { WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { Weapons } from "../src/weapons.js";
import { describe, expect, it, vi } from "vitest";
import { TEST_WORLD, testApp, type TestApp } from "@3d/api/testing/app.js";
import { createApiClient } from "@3d/shared/protocol/api.js";
import type { GameOrder, ServerEvent } from "@3d/shared/protocol/events/server.js";
import type { UserEvent } from "@3d/shared/protocol/events/user.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import { httpWorldSource } from "@3d/shared/worlds/source.js";
import { NO_BODIES } from "../src/bodies.js";
import { buildServerCollision } from "../src/collision.js";
import type { Api } from "../src/api.js";
import { Games } from "../src/games.js";
import { Housekeeping } from "../src/housekeeping.js";
import { games } from "@3d/api/db/schema.js";
import type { LoadedWorld, WorldRegistry } from "../src/worlds.js";
import { Physics } from "../src/physics.js";

const TOKEN = "test-token";

/** An instance whose catalogue is empty: what this test drives is the api handshake, not weapons. */
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

/** A registry that resolves the ordered map without fetching one: the load path is tested above. */
function worldsFor(map: string): WorldRegistry {
  const world = {
    spawn: { position: { x: 0, y: 1.6, z: 0 }, look: { x: 0, y: 1.6, z: -1 } },
    spawnPoints: [],
    triggers: [],
    mantles: [],
    ladders: [],
    points: [],
    solids: [],
    rooms: [],
    topLevelObjects: [],
  } as never;
  const loaded: LoadedWorld = {
    map,
    world,
    index: indexWorld(world),
    hash: "test",
    collision: { ready: false, resolveCapsule: () => undefined } as never,
  };
  return { loaded: [map], acquire: async () => loaded, release: () => {} } as unknown as WorldRegistry;
}

function authority(now?: () => number): { fetch: HttpFetch } & Omit<TestApp, "app"> {
  const { app, ...rest } = testApp(now ? { now } : {});
  // Relative URLs are what a same-origin browser sends; app.request takes them.
  return { fetch: app.request.bind(app) as HttpFetch, ...rest };
}

describe("a game server against the real api", () => {
  it("loads and resolves its world over the worlds URLs", async () => {
    const source = httpWorldSource({ ...authority(), token: TOKEN }).world(TEST_WORLD);
    const loaded = await loadResolvedWorld(source);

    expect(loaded.error).toBeUndefined();
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Resolved, not merely fetched, and through every `include` the entry names:
    // the payload route has to have served all of the map's sources, not just
    // `world.world`.
    expect(loaded.world?.topLevelObjects.length).toBeGreaterThan(0);
    expect(loaded.world?.spawnPoints.length).toBeGreaterThan(0);
  });

  it("builds collision from bytes the asset route served", async () => {
    // An imported map's assets/ is gitignored, so this only runs where the map
    // has actually been exported. It is the one test that drives the whole
    // chain: payload route -> resolve -> asset route -> GLB -> BVH.
    const link = { ...authority(), token: TOKEN };
    const source = httpWorldSource(link).world(TEST_WORLD);
    const loaded = await loadResolvedWorld(source);
    if (!(await source.asset(loaded.world!.collision!.source))) {
      return;
    }
    // The catalogue is served by the same api this test stands up, so a prop's
    // file comes back over the real route exactly as it does in production —
    // which is the half of the chain a prop moving to the catalogue broke.
    const catalog = createApiClient(link);
    const collision = await buildServerCollision(loaded.world!, source, (ref, rel) =>
      catalog.catalogFile({ kind: ref.kind, game: ref.game, id: ref.id, rest: rel }),
    );

    expect(collision).toBeDefined();
    expect(collision!.triangles).toBeGreaterThan(0);
    expect(collision!.world.ready).toBe(true);
  });

  it("reports a world the api does not have", async () => {
    const source = httpWorldSource({ ...authority(), token: TOKEN }).world("no-such-world");
    expect((await loadResolvedWorld(source)).error).toContain("404");
  });

  it("registers itself, and appears in the list a client reads", async () => {
    const { fetch } = authority();
    const api = createApiClient({ fetch, token: TOKEN });
    const info = { id: "gs-test", url: "http://localhost:9300", worlds: [TEST_WORLD], players: 0, maxPlayers: 12, maxGames: 4, games: 0 };

    // The route, not the loop: Heartbeat is a LoopBase whose period is the only
    // thing it adds, and a test that starts one is testing setTimeout.
    expect(await api.heartbeat(info)).toEqual({ ok: true, expiresInSeconds: 30 });
    await vi.waitFor(async () => expect((await api.servers()).servers).toEqual([info]));
  });

  it("is refused without the service token", async () => {
    const { fetch } = authority();
    const api = createApiClient({ fetch });
    await expect(api.heartbeat({ id: "gs-x", url: "http://x", worlds: [TEST_WORLD], players: 0, maxPlayers: 12, maxGames: 4, games: 0 })).rejects.toThrow(
      /401/,
    );
  });
});

// The handover: the api decides a game exists, an instance stands it up, the
// players are told where to go, and the instance says when it is over. Both ends
// are real here — the api's matchmaker and the game server's games registry —
// because a test against a mock of either would only agree with itself.
describe("the handover between the two", () => {
  const ORDER_MAP = TEST_WORLD;

  /**
   * Two players queued into one lobby, and a way to reach past the countdown.
   * The clock is injected rather than faked: the matchmaker captured `Date.now`
   * when it was built, so vi.useFakeTimers replaces a reference it never reads.
   */
  function readyToStart() {
    let clock = 1_000_000;
    const { fetch, matchmaking, registry, db } = authority(() => clock);
    const api = createApiClient({ fetch, token: TOKEN });
    const instance = { id: "gs-test", url: "http://localhost:9300", worlds: [ORDER_MAP], players: 0, maxPlayers: 12, maxGames: 4, games: 0 };

    const heard: Record<string, UserEvent[]> = { ana: [], bo: [] };
    for (const name of ["ana", "bo"]) {
      matchmaking.userEvents.subscribe(name, { send: (event) => heard[name]!.push(event), close: () => {} });
      matchmaking.enqueue({ id: name, username: name });
    }

    const orders: ServerEvent[] = [];
    matchmaking.serverEvents.subscribe(instance.id, { send: (event) => orders.push(event), close: () => {} });

    /** Run the lobby all the way to a committed game, as the real loop would. */
    function runToGame(): GameOrder {
      registry.heartbeat(instance);
      matchmaking.tick();
      clock += 31_000;
      registry.heartbeat(instance); // an instance heartbeats every 10s; the countdown is 30
      matchmaking.tick();
      const created = orders.find((event) => event.type === "gameCreate");
      expect(created).toBeDefined();
      return (created as Extract<ServerEvent, { type: "gameCreate" }>).game;
    }

    return { api, matchmaking, db, heard, orders, instance, runToGame };
  }

  it("orders a game an instance can stand up, and admits exactly its roster", async () => {
    const { api, heard, runToGame } = readyToStart();
    const order = runToGame();

    // The instance stands it up from the order alone — including which map it
    // is on, which it is told here rather than configured with.
    const games = new Games(worldsFor(order.map), noWeapons(), NO_BODIES, noPhysics());
    const game = (await games.create(order))!;
    expect(game.roster.size).toBe(2);

    // Then it tells the api, and only then are the players told where to go.
    expect(heard.ana!.some((event) => event.type === "matchReady")).toBe(false);
    expect(await api.gameReady({ gameId: order.gameId })).toEqual({ ok: true });

    const ready = heard.ana!.at(-1) as Extract<UserEvent, { type: "matchReady" }>;
    expect(ready.type).toBe("matchReady");
    expect(ready.serverUrl).toBe("http://localhost:9300");
    expect(ready.map).toBe(ORDER_MAP);
    // What the api told the player is exactly what the instance will check.
    expect(games.admits(order.gameId, ready.playerId, ready.authorizationKey)).toBe(true);
    expect(games.admits(order.gameId, ready.playerId, "not-the-key")).toBe(false);
  });

  it("reopens the lobby when the instance reports the game over", async () => {
    const { api, db, heard, runToGame } = readyToStart();
    const order = runToGame();
    await api.gameReady({ gameId: order.gameId });

    expect(await api.gameReport({ gameId: order.gameId }, { status: "ended" })).toEqual({ ok: true });

    const back = [...heard.ana!].reverse().find((event): event is Extract<UserEvent, { type: "lobby" }> => event.type === "lobby")!;
    expect(back.status).toBe("open");
    expect(back.players.map((p) => p.username)).toEqual(["ana", "bo"]);

    const row = db
      .select()
      .from(games)
      .all()
      .find((g) => g.id === order.gameId)!;
    expect(row.status).toBe("ended");
    expect(row.endedAt).not.toBeNull();
  });

  it("reopens the lobby at once when the instance refuses the order", async () => {
    const { api, db, heard, runToGame } = readyToStart();
    const order = runToGame();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // A gametype this build has never heard of: one of the orders it refuses.
    const hosted = new Games(worldsFor(order.map), noWeapons(), NO_BODIES, noPhysics());
    expect(await hosted.create({ ...order, gametype: "pitfighter" })).toBeUndefined();
    new Housekeeping(hosted, { client: api } as Api).reportRefusals();
    await vi.waitFor(() => {
      const row = db
        .select()
        .from(games)
        .all()
        .find((g) => g.id === order.gameId)!;
      expect(row.status).toBe("refused");
    });

    const back = [...heard.ana!].reverse().find((event): event is Extract<UserEvent, { type: "lobby" }> => event.type === "lobby")!;
    expect(back.status).toBe("open");
  });

  it("takes a report for a game it has forgotten, rather than arguing about it", async () => {
    const { api } = readyToStart();
    // An api that restarted mid-match knows nothing about a game still running,
    // and that is not the instance's fault.
    expect(await api.gameReport({ gameId: "a-game-from-before-the-restart" }, { status: "ended" })).toEqual({ ok: true });
  });
});
