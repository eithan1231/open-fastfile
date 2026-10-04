// The lobby's whole life, driven by hand.
//
// The clock is injected and `tick()` is called explicitly, so a thirty-second
// countdown is three lines rather than thirty seconds — and the states that are
// awkward to reach in a browser (nobody hosting the map, a player closing their
// tab mid-countdown, a game ending) are the easy ones to reach here.
//
// Every assertion is on what a player was *told*, not on the matchmaker's
// internals, because the event stream is the only thing a client ever sees.

import { DEFAULT_GAMETYPE } from "@3d/shared/game/gametypes/registry.js";
import { ZOMBIES_GAMETYPE } from "@3d/shared/game/gametypes/zombies.js";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@3d/shared/protocol/events/server.js";
import type { UserEvent } from "@3d/shared/protocol/events/user.js";
import type { MatchmakingConfig } from "../src/config.js";
import { games } from "../src/db/schema.js";
import { HEARTBEAT_TIMEOUT_MS } from "../src/registry.js";
import { TEST_OTHER_WORLD, TEST_TOKEN, TEST_WORLD, testApp } from "../testing/app.js";

const MAP = TEST_OTHER_WORLD;
const OTHER_MAP = TEST_WORLD;

const CONFIG: MatchmakingConfig = {
  maps: [MAP],
  lobbySize: 4,
  minPlayers: 2,
  countdownSeconds: 30,
  gameDurationSeconds: 600,
  readyTimeoutMs: 30_000,
  presenceTimeoutMs: 30_000,
};

function setup(overrides: Partial<MatchmakingConfig> = {}) {
  let clock = 1_000_000;
  // The whole container, not a hand-assembled matchmaker: what is under test
  // here is the decisions, and they are the same ones a real request reaches.
  const { db, registry, matchmaking } = testApp({ now: () => clock, matchmaking: { ...CONFIG, ...overrides } });

  /**
   * A live instance with room, as the registry would learn of one.
   *
   * `worlds` is what it already has loaded — a placement hint, not a filter: an
   * instance loads whatever it is ordered to host, so an idle one (no worlds at
   * all) can still be given any map on the playlist.
   */
  const host = (worlds: string[] = [], id = "gs-1", maxPlayers = 12, maxGames = 4, games = 0) =>
    registry.heartbeat({ id, url: `http://${id}:9300`, worlds, players: 0, maxPlayers, maxGames, games });

  /** A signed-in player with an open event stream — which is what presence means. */
  function player(name: string) {
    const user = { id: name, username: name };
    const events: UserEvent[] = [];
    const unsubscribe = matchmaking.userEvents.subscribe(name, { send: (event) => events.push(event), close: () => {} });
    return {
      ...user,
      user,
      events,
      /** Close the tab: the stream goes, and the presence sweep will notice. */
      unsubscribe,
      lobby: () => [...events].reverse().find((event): event is Extract<UserEvent, { type: "lobby" }> => event.type === "lobby"),
      last: () => events.at(-1),
    };
  }

  function instance(id = "gs-1") {
    const events: ServerEvent[] = [];
    matchmaking.serverEvents.subscribe(id, { send: (event) => events.push(event), close: () => {} });
    return { events, orders: () => events.filter((event): event is Extract<ServerEvent, { type: "gameCreate" }> => event.type === "gameCreate") };
  }

  return {
    db,
    matchmaking,
    host,
    player,
    instance,
    advance: (ms: number) => void (clock += ms),
    now: () => clock,
    row: (id: string) =>
      db
        .select()
        .from(games)
        .all()
        .find((game) => game.id === id),
    firstGame: () => db.select().from(games).all()[0],
  };
}

/** Two players queued into the same lobby on a hosted map: the common start. */
function twoQueued(mm: ReturnType<typeof setup>) {
  mm.host();
  const a = mm.player("ana");
  const b = mm.player("bo");
  mm.matchmaking.enqueue(a.user);
  mm.matchmaking.enqueue(b.user);
  mm.matchmaking.tick();
  return { a, b };
}

describe("the queue", async () => {
  it("tells a player they are searching, and leaves them there alone", async () => {
    const mm = setup();
    mm.host();
    const a = mm.player("ana");
    mm.matchmaking.enqueue(a.user);
    expect(a.last()).toEqual({ type: "searching", since: mm.now() });

    mm.matchmaking.tick();
    // One player is still a lobby — they have to stand somewhere — but nothing starts.
    expect(a.lobby()?.players).toHaveLength(1);
    expect(a.lobby()?.startsAt).toBeNull();
  });

  it("puts two players in one lobby and arms the countdown", async () => {
    const mm = setup();
    const { a, b } = twoQueued(mm);

    const lobby = a.lobby()!;
    expect(lobby.players.map((p) => p.username)).toEqual(["ana", "bo"]);
    expect(b.lobby()?.code).toBe(lobby.code);
    expect(lobby.map).toBe(MAP);
    expect(lobby.startsAt).toBe(mm.now() + CONFIG.countdownSeconds * 1000);
  });

  it("mints one wire identity per player, not one per round", async () => {
    const mm = setup();
    const { a, b } = twoQueued(mm);
    const ids = a.lobby()!.players.map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length === 8)).toBe(true);
    expect(b.lobby()!.players.map((p) => p.id)).toEqual(ids);
  });
});

describe("the countdown", async () => {
  it("does not arm when no instance has room", async () => {
    const mm = setup();
    mm.host([], "gs-full", 0); // live, but with no room for anyone
    const a = mm.player("ana");
    const b = mm.player("bo");
    mm.matchmaking.enqueue(a.user);
    mm.matchmaking.enqueue(b.user);
    mm.matchmaking.tick();

    // The lobby forms and waits. Nothing is an error; there is simply nowhere to play.
    expect(a.lobby()?.players).toHaveLength(2);
    expect(a.lobby()?.startsAt).toBeNull();
    expect(a.lobby()?.map).toBeNull();
  });

  it("arms once a server for the playlist appears", async () => {
    const mm = setup();
    const a = mm.player("ana");
    const b = mm.player("bo");
    mm.matchmaking.enqueue(a.user);
    mm.matchmaking.enqueue(b.user);
    mm.matchmaking.tick();
    expect(a.lobby()?.startsAt).toBeNull();

    mm.host();
    mm.matchmaking.tick();
    expect(a.lobby()?.startsAt).toBe(mm.now() + CONFIG.countdownSeconds * 1000);
  });

  it("disarms, and forgets the map, when a player leaves mid-countdown", async () => {
    const mm = setup();
    const { a, b } = twoQueued(mm);
    expect(a.lobby()?.startsAt).not.toBeNull();

    mm.matchmaking.leave(b.id);
    mm.matchmaking.tick();
    expect(a.lobby()?.startsAt).toBeNull();
    expect(a.lobby()?.map).toBeNull();
    expect(a.lobby()?.players).toHaveLength(1);
  });

  it("takes a player who queues mid-countdown without restarting it", async () => {
    const mm = setup();
    const { a } = twoQueued(mm);
    const armedAt = a.lobby()!.startsAt;

    mm.advance(10_000);
    const c = mm.player("cy");
    mm.matchmaking.enqueue(c.user);
    mm.matchmaking.tick();

    expect(c.lobby()?.code).toBe(a.lobby()?.code);
    expect(a.lobby()?.players).toHaveLength(3);
    expect(a.lobby()?.startsAt).toBe(armedAt);
  });

  it("does not fire early, and fires once", async () => {
    const mm = setup();
    const server = mm.instance();
    twoQueued(mm);

    mm.advance(CONFIG.countdownSeconds * 1000 - 1);
    mm.matchmaking.tick();
    expect(server.orders()).toHaveLength(0);

    mm.advance(1);
    mm.matchmaking.tick();
    mm.matchmaking.tick();
    expect(server.orders()).toHaveLength(1);
  });
});

describe("committing to a game", async () => {
  it("writes the row, closes the lobby and orders the instance to stand it up", async () => {
    const mm = setup();
    const server = mm.instance();
    const { a } = twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();

    const order = server.orders()[0]!.game;
    expect(order.map).toBe(MAP);
    expect(order.maxPlayers).toBe(CONFIG.lobbySize);
    expect(order.durationSeconds).toBe(CONFIG.gameDurationSeconds);
    expect(order.players).toHaveLength(2);
    // The roster carries the secret each player will present on the wire.
    expect(new Set(order.players.map((p) => p.authorizationKey)).size).toBe(2);

    expect(a.lobby()?.status).toBe("closed");
    expect(a.lobby()?.startsAt).toBeNull();

    const row = mm.row(order.gameId)!;
    expect(row.status).toBe("starting");
    expect(row.map).toBe(MAP);
    expect(row.startedAt).toBeNull();
  });

  it("tells each player where to go only once the instance says it is ready", async () => {
    const mm = setup();
    const server = mm.instance();
    const { a, b } = twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();

    expect(a.events.some((event) => event.type === "matchReady")).toBe(false);

    const gameId = server.orders()[0]!.game.gameId;
    expect(mm.matchmaking.gameReady(gameId)).toBe(true);

    const ready = a.last();
    expect(ready).toMatchObject({ type: "matchReady", gameId, serverUrl: "http://gs-1:9300", map: MAP });
    // Each player is told their own identity, not the roster.
    const mine = ready as Extract<UserEvent, { type: "matchReady" }>;
    const theirs = b.last() as Extract<UserEvent, { type: "matchReady" }>;
    expect(mine.playerId).not.toBe(theirs.playerId);
    expect(mine.authorizationKey).not.toBe(theirs.authorizationKey);

    expect(mm.row(gameId)?.status).toBe("started");
  });

  it("hands a reconnecting instance everything it should be running", async () => {
    const mm = setup();
    const server = mm.instance();
    twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();

    const hello = mm.matchmaking.helloFor("gs-1");
    expect(hello).toEqual({ type: "hello", games: [server.orders()[0]!.game] });
    // ...and nothing to an instance that is running nothing.
    expect(mm.matchmaking.helloFor("gs-2")).toEqual({ type: "hello", games: [] });
  });
});

describe("a game the fleet never stands up", async () => {
  /** Ordered, and then silence: the instance crashed, restarted, or could not load the map. */
  function stillborn() {
    const mm = setup();
    const server = mm.instance();
    const { a, b } = twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();
    return { mm, server, a, b, gameId: server.orders()[0]!.game.gameId };
  }

  it("waits out the timeout before giving up on it", async () => {
    const { mm, a } = stillborn();
    mm.advance(CONFIG.readyTimeoutMs - 1);
    mm.matchmaking.tick();
    expect(a.lobby()?.status).toBe("closed");
  });

  it("reopens the lobby with the same people in it", async () => {
    const { mm, a, b } = stillborn();
    mm.host(); // somewhere to play the next one
    mm.advance(CONFIG.readyTimeoutMs);
    mm.matchmaking.tick();

    const lobby = a.lobby()!;
    expect(lobby.status).toBe("open");
    expect(lobby.players.map((p) => p.username)).toEqual(["ana", "bo"]);
    expect(b.lobby()?.code).toBe(lobby.code);
    // And it can be played again, rather than being a room nobody can leave.
    mm.matchmaking.tick();
    expect(a.lobby()?.startsAt).toBe(mm.now() + CONFIG.countdownSeconds * 1000);
  });

  it("tells the instance to drop it, in case it was only slow", async () => {
    const { mm, server, gameId } = stillborn();
    mm.advance(CONFIG.readyTimeoutMs);
    mm.matchmaking.tick();
    expect(server.events.filter((event) => event.type === "gameEnd")).toEqual([{ type: "gameEnd", gameId }]);
  });

  it("records a game that never started", async () => {
    const { mm, gameId } = stillborn();
    mm.advance(CONFIG.readyTimeoutMs);
    mm.matchmaking.tick();
    const row = mm.row(gameId)!;
    expect(row.status).toBe("ended");
    expect(row.startedAt).toBeNull();
  });

  it("leaves a game that did report ready alone", async () => {
    const { mm, a, gameId } = stillborn();
    mm.matchmaking.gameReady(gameId);
    mm.advance(CONFIG.readyTimeoutMs * 10);
    // Still heartbeating: an instance that went quiet is a different story (below).
    mm.host();
    mm.matchmaking.tick();
    expect(a.lobby()?.status).toBe("closed");
    expect(mm.row(gameId)?.status).toBe("started");
  });
});

describe("a game ending", async () => {
  function played() {
    const mm = setup();
    const server = mm.instance();
    const { a, b } = twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();
    const gameId = server.orders()[0]!.game.gameId;
    mm.matchmaking.gameReady(gameId);
    return { mm, server, a, b, gameId };
  }

  it("puts the same people back in the same lobby, and arms the next round", async () => {
    const { mm, a, b, gameId } = played();
    mm.advance(CONFIG.gameDurationSeconds * 1000);
    // A round outlasts the heartbeat timeout many times over, so the instance
    // has to still be saying it is alive for there to be anywhere to play next.
    mm.host();
    expect(mm.matchmaking.gameEnded(gameId)).toBe(true);

    const lobby = a.lobby()!;
    expect(lobby.status).toBe("open");
    expect(lobby.players.map((p) => p.username)).toEqual(["ana", "bo"]);
    expect(lobby.startsAt).toBeNull();
    expect(b.lobby()?.code).toBe(lobby.code);

    mm.matchmaking.tick();
    expect(a.lobby()?.startsAt).toBe(mm.now() + CONFIG.countdownSeconds * 1000);
  });

  it("closes the row out", async () => {
    const { mm, gameId } = played();
    mm.advance(60_000);
    mm.matchmaking.gameEnded(gameId);
    const row = mm.row(gameId)!;
    expect(row.status).toBe("ended");
    expect(row.endedAt).toBe(Math.floor(mm.now() / 1000));
    expect(row.endedAt!).toBeGreaterThan(row.startedAt!);
  });

  it("drops a lobby whose players all left during the game", async () => {
    const { mm, a, b, gameId } = played();
    mm.matchmaking.leave(a.id);
    mm.matchmaking.leave(b.id);
    mm.matchmaking.gameEnded(gameId);
    expect(mm.matchmaking.describe().lobbies).toBe(0);
  });
});

describe("an instance that goes away mid-game", async () => {
  function playing() {
    const mm = setup();
    const server = mm.instance();
    const { a, b } = twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();
    const gameId = server.orders()[0]!.game.gameId;
    mm.matchmaking.gameReady(gameId);
    return { mm, a, b, gameId };
  }

  it("reopens the lobby once the instance stops heartbeating, since nothing will report the game over", async () => {
    const { mm, a, gameId } = playing();
    mm.advance(HEARTBEAT_TIMEOUT_MS + 1);
    mm.matchmaking.tick();
    expect(a.lobby()?.status).toBe("open");
    expect(a.lobby()?.players).toHaveLength(2);
    expect(mm.row(gameId)?.status).toBe("ended");
  });

  it("leaves a game alone while its instance is still heartbeating", async () => {
    const { mm, a } = playing();
    for (let i = 0; i < 5; i++) {
      mm.advance(HEARTBEAT_TIMEOUT_MS / 2);
      mm.host();
      mm.matchmaking.tick();
    }
    expect(a.lobby()?.status).toBe("closed");
  });
});

describe("a player coming back", async () => {
  it("is handed their ticket again, with the lobby, when a stream opens mid-game", async () => {
    const mm = setup();
    const server = mm.instance();
    const { a } = twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();
    const gameId = server.orders()[0]!.game.gameId;

    // Ordered but not standing: there is nowhere to send them yet.
    expect(mm.matchmaking.snapshotFor(a.id).map((event) => event.type)).toEqual(["lobby"]);

    mm.matchmaking.gameReady(gameId);
    const told = a.events.find((event) => event.type === "matchReady");
    const [lobby, ticket] = mm.matchmaking.snapshotFor(a.id);
    expect(lobby).toMatchObject({ type: "lobby", status: "closed" });
    // The very ticket they were first given: the instance's roster holds that key.
    expect(ticket).toEqual(told);
  });

  it("is told the lobby they are already in when they ask to queue", async () => {
    const mm = setup();
    const { a } = twoQueued(mm);
    const code = a.lobby()!.code;
    a.events.length = 0;
    mm.matchmaking.enqueue(a.user);
    expect(a.events).toEqual([expect.objectContaining({ type: "lobby", code })]);
  });
});

describe("presence", async () => {
  it("drops a player whose event stream has been gone too long", async () => {
    const mm = setup();
    const { a, b } = twoQueued(mm);

    b.unsubscribe(); // the tab closed
    mm.advance(CONFIG.presenceTimeoutMs + 1);
    mm.matchmaking.tick();

    expect(a.lobby()?.players.map((p) => p.username)).toEqual(["ana"]);
    // ...and with one player left, the round it was counting down to is off.
    expect(a.lobby()?.startsAt).toBeNull();
  });

  it("keeps a player who is still connected, however long they wait", async () => {
    const mm = setup();
    const { a } = twoQueued(mm);
    for (let i = 0; i < 5; i++) {
      mm.advance(CONFIG.presenceTimeoutMs);
      mm.matchmaking.tick();
    }
    expect(a.lobby()?.players).toHaveLength(2);
  });
});

describe("a private lobby", async () => {
  it("is not filled by the queue, and waits for its host however full it is", async () => {
    const mm = setup();
    mm.host();
    const host = mm.player("ana");
    const friend = mm.player("bo");
    const stranger = mm.player("cy");

    const created = await mm.matchmaking.createLobby(host.user, MAP);
    expect(created.ok).toBe(true);
    const code = created.ok ? created.code : "";

    expect(mm.matchmaking.joinLobby(friend.user, code)).toEqual({ ok: true, code });
    mm.matchmaking.enqueue(stranger.user);
    mm.matchmaking.tick();

    // Two people, a hosted map, and still no countdown: an invite is not a queue.
    expect(host.lobby()?.startsAt).toBeNull();
    expect(host.lobby()?.players).toHaveLength(2);
    // The stranger got a lobby of their own rather than this one.
    expect(stranger.lobby()?.code).not.toBe(code);
  });

  it("starts when its host says so, and only its host", async () => {
    const mm = setup();
    mm.host();
    const host = mm.player("ana");
    const friend = mm.player("bo");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    mm.matchmaking.joinLobby(friend.user, code);

    expect(mm.matchmaking.startLobby(friend.user, code)).toEqual({ ok: false, why: "not the host" });
    expect(mm.matchmaking.startLobby(host.user, code)).toEqual({ ok: true });
    expect(host.lobby()?.startsAt).toBe(mm.now() + CONFIG.countdownSeconds * 1000);
  });

  it("starts on a map no instance has loaded, because any of them can load it", async () => {
    const mm = setup();
    mm.host([MAP]); // has MAP loaded, and is told to host OTHER_MAP anyway
    const host = mm.player("ana");
    const created = await mm.matchmaking.createLobby(host.user, OTHER_MAP);
    const code = created.ok ? created.code : "";
    expect(mm.matchmaking.startLobby(host.user, code)).toEqual({ ok: true });
  });

  it("will not start when the whole fleet is full", async () => {
    const mm = setup();
    mm.host([], "gs-full", 0);
    const host = mm.player("ana");
    const created = await mm.matchmaking.createLobby(host.user, OTHER_MAP);
    const code = created.ok ? created.code : "";
    expect(mm.matchmaking.startLobby(host.user, code)).toEqual({ ok: false, why: "no server for that map" });
  });

  it("refuses an unknown code, and a full one", async () => {
    const mm = setup({ lobbySize: 2 });
    mm.host();
    const host = mm.player("ana");
    const friend = mm.player("bo");
    const late = mm.player("cy");
    expect(mm.matchmaking.joinLobby(friend.user, "ZZZZZZ")).toEqual({ ok: false, why: "no such lobby" });

    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    mm.matchmaking.joinLobby(friend.user, code);
    expect(mm.matchmaking.joinLobby(late.user, code)).toEqual({ ok: false, why: "lobby is full" });
  });

  it("refuses to be joined while its game is running", async () => {
    const mm = setup();
    mm.host();
    const host = mm.player("ana");
    const friend = mm.player("bo");
    const late = mm.player("cy");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    mm.matchmaking.joinLobby(friend.user, code);
    mm.matchmaking.startLobby(host.user, code);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();

    expect(mm.matchmaking.joinLobby(late.user, code)).toEqual({ ok: false, why: "game in progress" });
  });

  it("keeps its map across a round, where a public one re-picks", async () => {
    const mm = setup();
    mm.host();
    const server = mm.instance();
    const host = mm.player("ana");
    const friend = mm.player("bo");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    mm.matchmaking.joinLobby(friend.user, code);
    mm.matchmaking.startLobby(host.user, code);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();

    mm.matchmaking.gameEnded(server.orders()[0]!.game.gameId);
    expect(host.lobby()?.status).toBe("open");
    expect(host.lobby()?.map).toBe(MAP);
  });
});

describe("a private lobby's host", async () => {
  async function hosted() {
    const mm = setup();
    mm.host();
    const server = mm.instance();
    const host = mm.player("ana");
    const friend = mm.player("bo");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    mm.matchmaking.joinLobby(friend.user, code);
    return { mm, server, host, friend, code };
  }

  async function started(ready = true) {
    const it = await hosted();
    it.mm.matchmaking.startLobby(it.host.user, it.code);
    it.mm.advance(CONFIG.countdownSeconds * 1000);
    it.mm.matchmaking.tick();
    const gameId = it.server.orders()[0]!.game.gameId;
    if (ready) {
      it.mm.matchmaking.gameReady(gameId);
    }
    return { ...it, gameId };
  }

  it("ends the running game for everyone, and they land back in the lobby", async () => {
    const { mm, server, host, friend, code, gameId } = await started();
    expect(mm.matchmaking.endLobby(host.user, code)).toEqual({ ok: true });

    expect(server.events.filter((event) => event.type === "gameEnd")).toEqual([{ type: "gameEnd", gameId }]);
    for (const player of [host, friend]) {
      expect(player.lobby()).toMatchObject({ code, status: "open", map: MAP, startsAt: null });
    }
    expect(mm.row(gameId)?.status).toBe("ended");
  });

  it("can then change the map and start the next one", async () => {
    const { mm, server, host, code } = await started();
    mm.matchmaking.endLobby(host.user, code);
    // A report arriving late for the game the host ended changes nothing.
    mm.matchmaking.gameEnded(server.orders()[0]!.game.gameId);

    expect(await mm.matchmaking.setLobbyMap(host.user, code, OTHER_MAP)).toEqual({ ok: true });
    expect(mm.matchmaking.startLobby(host.user, code)).toEqual({ ok: true });
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.host(); // still heartbeating: commit re-checks the instance is live
    mm.matchmaking.tick();
    expect(server.orders().map((order) => order.game.map)).toEqual([MAP, OTHER_MAP]);
  });

  it("ends a game that is still being stood up", async () => {
    const { mm, server, host, code, gameId } = await started(false);
    expect(mm.matchmaking.endLobby(host.user, code)).toEqual({ ok: true });
    expect(server.events.filter((event) => event.type === "gameEnd")).toEqual([{ type: "gameEnd", gameId }]);
    expect(host.lobby()?.status).toBe("open");
  });

  it("stops a countdown, and keeps the map it was counting down to", async () => {
    const { mm, server, host, code } = await hosted();
    mm.matchmaking.startLobby(host.user, code);
    expect(mm.matchmaking.endLobby(host.user, code)).toEqual({ ok: true });
    expect(host.lobby()).toMatchObject({ startsAt: null, map: MAP });

    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();
    expect(server.orders()).toEqual([]);
  });

  it("is the only one who may, and only in a private lobby with something to end", async () => {
    const { mm, host, friend, code } = await started();
    expect(mm.matchmaking.endLobby(friend.user, code)).toEqual({ ok: false, why: "not the host" });
    expect(mm.matchmaking.endLobby(host.user, "ZZZZZZ")).toEqual({ ok: false, why: "no such lobby" });
    mm.matchmaking.endLobby(host.user, code);
    expect(mm.matchmaking.endLobby(host.user, code)).toEqual({ ok: false, why: "nothing to end" });

    const pub = setup();
    const { a, b } = twoQueued(pub);
    const lobby = a.lobby()!;
    const first = lobby.players.find((player) => player.host)!.username === "ana" ? a : b;
    expect(pub.matchmaking.endLobby(first.user, lobby.code)).toEqual({ ok: false, why: "not a private lobby" });
  });

  it("hands the lobby on when they leave, so it is not a room nobody can start", async () => {
    const { mm, host, friend, code } = await hosted();
    mm.matchmaking.leave(host.id);
    expect(friend.lobby()?.players).toEqual([expect.objectContaining({ username: "bo", host: true })]);
    expect(mm.matchmaking.startLobby(friend.user, code)).toEqual({ ok: true });
  });

  it("moves between lobbies without being told they left, which would send a browser to the menu", async () => {
    const { mm, friend } = await hosted();
    friend.events.length = 0;
    await mm.matchmaking.createLobby(friend.user, OTHER_MAP);
    expect(friend.events.map((event) => event.type)).toEqual(["lobby"]);
  });
});

// The gametype: chosen in the lobby, carried in the order, and validated at both
// ends. The authority checks the name and the map; only the instance, which has
// the resolved world, can check a `games` restriction — see `admitsMap`.
describe("the gametype", async () => {
  it("opens with a default, because a game with no rules is not a thing", async () => {
    const mm = setup();
    mm.host();
    const host = mm.player("ana");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    expect(host.lobby()?.gametype).toBe(DEFAULT_GAMETYPE);
    expect(code).not.toBe("");
  });

  it("reaches the instance in the order, which is the only way it gets there", async () => {
    const mm = setup();
    const server = mm.instance();
    twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.matchmaking.tick();
    expect(server.orders()[0]!.game.gametype).toBe(DEFAULT_GAMETYPE);
  });

  it("is the host's to set, and refuses a name that is not in the table", async () => {
    const mm = setup();
    mm.host();
    const host = mm.player("ana");
    const friend = mm.player("bo");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    mm.matchmaking.joinLobby(friend.user, code);

    expect(mm.matchmaking.setLobbyGametype(friend.user, code, DEFAULT_GAMETYPE)).toEqual({ ok: false, why: "not the host" });
    // `Object.hasOwn` in `gametype()` is what keeps these from resolving to
    // something off Object's prototype.
    expect(mm.matchmaking.setLobbyGametype(host.user, code, "no-such-mode")).toEqual({ ok: false, why: "no such gametype" });
    expect(mm.matchmaking.setLobbyGametype(host.user, code, "toString")).toEqual({ ok: false, why: "no such gametype" });
    expect(mm.matchmaking.setLobbyGametype(host.user, code, DEFAULT_GAMETYPE)).toEqual({ ok: true });
  });

  it("is refused once the countdown is running, as the map is", async () => {
    const mm = setup();
    mm.instance();
    mm.host();
    const host = mm.player("ana");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    mm.matchmaking.startLobby(host.user, code);

    // Everyone in the lobby has seen what they are about to play; swapping it
    // underneath them is worse than making them wait for the next round.
    expect(mm.matchmaking.setLobbyGametype(host.user, code, DEFAULT_GAMETYPE)).toEqual({
      ok: false,
      why: "the match is already starting",
    });
  });

  it("tells the lobby, so a host who changes it is not the only one who knows", async () => {
    const mm = setup();
    mm.host();
    const host = mm.player("ana");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    const before = host.events.length;
    expect(mm.matchmaking.setLobbyGametype(host.user, code, DEFAULT_GAMETYPE)).toEqual({ ok: true });
    expect(host.events.length).toBeGreaterThan(before);
    expect(host.lobby()?.gametype).toBe(DEFAULT_GAMETYPE);
  });
});

// Placement: what the api has promised an instance counts against it, because a
// heartbeat is ten seconds old and knows nothing of the countdowns since.
describe("placing games on instances", () => {
  /** Two public lobbies of two, armed in the same tick. */
  function twoLobbies(mm: ReturnType<typeof setup>) {
    const players = ["ana", "bo", "cy", "di"].map((name) => mm.player(name));
    for (const player of players) {
      mm.matchmaking.enqueue(player.user);
    }
    mm.matchmaking.tick();
    return { a: players[0]!, c: players[2]! };
  }

  it("does not put two lobbies armed in one tick on an instance with room for one", () => {
    const mm = setup({ lobbySize: 2 });
    mm.host([], "gs-1", 12, 1);
    const { a, c } = twoLobbies(mm);
    expect(a.lobby()?.code).not.toBe(c.lobby()?.code);
    // One counts down; the other waits for room rather than being promised the same slot.
    expect([a.lobby()?.startsAt, c.lobby()?.startsAt].filter((at) => at !== null)).toHaveLength(1);
  });

  it("sends the second to another instance when there is one", () => {
    const mm = setup({ lobbySize: 2 });
    const one = mm.instance("gs-1");
    const two = mm.instance("gs-2");
    mm.host([], "gs-1", 12, 1);
    mm.host([], "gs-2", 12, 1);
    const { a, c } = twoLobbies(mm);
    expect(a.lobby()?.startsAt).not.toBeNull();
    expect(c.lobby()?.startsAt).not.toBeNull();

    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.host([], "gs-1", 12, 1);
    mm.host([], "gs-2", 12, 1);
    mm.matchmaking.tick();
    expect(one.orders()).toHaveLength(1);
    expect(two.orders()).toHaveLength(1);
  });

  it("counts the games an instance says it is already holding", () => {
    const mm = setup();
    const a = mm.player("ana");
    const b = mm.player("bo");
    mm.host([], "gs-1", 12, 2, 2);
    mm.matchmaking.enqueue(a.user);
    mm.matchmaking.enqueue(b.user);
    mm.matchmaking.tick();
    expect(a.lobby()?.startsAt).toBeNull();
  });

  it("re-places a countdown at commit if its instance filled up in the meantime", () => {
    const mm = setup();
    const one = mm.instance("gs-1");
    const two = mm.instance("gs-2");
    mm.host([], "gs-1", 12, 1);
    twoQueued(mm);

    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.host([], "gs-1", 12, 1, 1); // a game this api never ordered
    mm.host([], "gs-2", 12, 1);
    mm.matchmaking.tick();
    expect(one.orders()).toHaveLength(0);
    expect(two.orders()).toHaveLength(1);
  });
});

describe("an instance refusing a game", () => {
  function ordered() {
    const mm = setup();
    const one = mm.instance("gs-1");
    const two = mm.instance("gs-2");
    mm.host([], "gs-1");
    const { a, b } = twoQueued(mm);
    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.host([], "gs-1");
    mm.matchmaking.tick();
    return { mm, one, two, a, b, gameId: one.orders()[0]!.game.gameId };
  }

  it("reopens the lobby at once rather than at the ready timeout", () => {
    const { mm, a, gameId } = ordered();
    expect(a.lobby()?.status).toBe("closed");
    expect(mm.matchmaking.gameRefused(gameId, "already hosting 4")).toBe(true);
    expect(a.lobby()).toMatchObject({ status: "open", startsAt: null });
    expect(a.lobby()?.players).toHaveLength(2);
    expect(mm.row(gameId)?.status).toBe("refused");
  });

  it("places that lobby's next game on another instance", () => {
    const { mm, one, two, a, gameId } = ordered();
    mm.host([], "gs-2");
    mm.matchmaking.gameRefused(gameId, undefined);
    mm.matchmaking.tick();
    expect(a.lobby()?.startsAt).not.toBeNull();

    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.host([], "gs-1");
    mm.host([], "gs-2");
    mm.matchmaking.tick();
    expect(one.orders()).toHaveLength(1);
    expect(two.orders()).toHaveLength(1);
  });

  it("waits rather than going straight back to the instance that refused", () => {
    const { mm, a, gameId } = ordered();
    mm.matchmaking.gameRefused(gameId, undefined);
    mm.matchmaking.tick();
    expect(a.lobby()?.startsAt).toBeNull();
  });

  it("is answered through the report route", async () => {
    const { app, registry, matchmaking } = testApp();
    registry.heartbeat({ id: "gs-1", url: "http://gs-1:9300", worlds: [], players: 0, maxPlayers: 12, maxGames: 4, games: 0 });
    const res = await app.request("/internal/games/no-such-game/report", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ status: "refused", reason: "full" }),
    });
    expect(res.status).toBe(200);
    expect(matchmaking.describe().lobbies).toBe(0);
  });
});

// Host commands belong to a private lobby's host while it waits. A public lobby's
// "host" is whoever the queue put there first, and its rounds are everyone's.
describe("host commands", () => {
  function publicLobby() {
    const mm = setup();
    const { a, b } = twoQueued(mm);
    const lobby = a.lobby()!;
    const host = lobby.players.find((player) => player.host)!.username === "ana" ? a : b;
    return { mm, host, code: lobby.code };
  }

  it("are refused to a public lobby's host", async () => {
    const { mm, host, code } = publicLobby();
    const refused = { ok: false, why: "not a private lobby" };
    expect(await mm.matchmaking.setLobbyMap(host.user, code, OTHER_MAP)).toEqual(refused);
    expect(mm.matchmaking.setLobbyGametype(host.user, code, DEFAULT_GAMETYPE)).toEqual(refused);
    expect(mm.matchmaking.startLobby(host.user, code)).toEqual(refused);
    expect(host.lobby()?.map).toBe(MAP);
  });

  it("refuse a map that is not a world on disk", async () => {
    const mm = setup();
    mm.host();
    const host = mm.player("ana");
    expect(await mm.matchmaking.createLobby(host.user, "no-such-world")).toEqual({ ok: false, why: "no such map" });
    const created = await mm.matchmaking.createLobby(host.user, null);
    const code = created.ok ? created.code : "";
    expect(await mm.matchmaking.setLobbyMap(host.user, code, "no-such-world")).toEqual({ ok: false, why: "no such map" });
    expect(host.lobby()?.map).toBeNull();
  });

  it("refuse a map the lobby's gametype is not played on", async () => {
    const mm = setup();
    const host = mm.player("ana");
    const created = await mm.matchmaking.createLobby(host.user, null);
    const code = created.ok ? created.code : "";
    expect(mm.matchmaking.setLobbyGametype(host.user, code, ZOMBIES_GAMETYPE)).toEqual({ ok: true });
    expect(await mm.matchmaking.setLobbyMap(host.user, code, MAP)).toEqual({ ok: false, why: "that gametype is not played on that map" });
    expect(host.lobby()?.map).toBeNull();
  });

  it("are refused once the countdown runs, and while the game does, except ending it", async () => {
    const mm = setup();
    mm.host();
    mm.instance();
    const host = mm.player("ana");
    const created = await mm.matchmaking.createLobby(host.user, MAP);
    const code = created.ok ? created.code : "";
    expect(mm.matchmaking.startLobby(host.user, code)).toEqual({ ok: true });

    const starting = { ok: false, why: "the match is already starting" };
    expect(mm.matchmaking.startLobby(host.user, code)).toEqual(starting);
    expect(await mm.matchmaking.setLobbyMap(host.user, code, OTHER_MAP)).toEqual(starting);

    mm.advance(CONFIG.countdownSeconds * 1000);
    mm.host();
    mm.matchmaking.tick();
    const running = { ok: false, why: "game in progress" };
    expect(mm.matchmaking.startLobby(host.user, code)).toEqual(running);
    expect(await mm.matchmaking.setLobbyMap(host.user, code, OTHER_MAP)).toEqual(running);
    expect(mm.matchmaking.setLobbyGametype(host.user, code, DEFAULT_GAMETYPE)).toEqual(running);
    expect(mm.matchmaking.endLobby(host.user, code)).toEqual({ ok: true });
  });

  it("take a map only in the shape of a world slug", async () => {
    const { app, users, sessions } = testApp();
    const user = await users.create("ana", "hunter2hunter2");
    const res = await app.request("/api/lobbies", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `sid=${sessions.create(user.id)}` },
      body: JSON.stringify({ map: "../secrets" }),
    });
    expect(res.status).toBe(400);
  });
});
