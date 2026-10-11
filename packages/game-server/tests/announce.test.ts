// What a script says, all the way to a snapshot: `publish` into the outbox, the
// tail it rides, how long it keeps riding it, and what it refuses.
//
// No shooting and no bodies — `combat.test.ts` owns the hit that raises the
// engine's own events, and this owns the one a *gametype* raises. The countdown
// script is driven through a real `Match` rather than called directly, because
// the thing under test is the seam: a hook is asked once per tick, what it
// publishes is turned into an event with an id and a retention, and every player
// in the game is given it.

import { describe, expect, it, vi } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { Script, ServerHooks } from "@3d/shared/game/hooks.js";
import type { AnnounceEvent, GameEvent } from "@3d/shared/net/messages/events.js";
import { MAX_ANNOUNCE_NAME_BYTES } from "@3d/shared/net/messages/events.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { NO_BODIES } from "../src/bodies.js";
import { Match } from "../src/match/match.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const MAP = "dome-mw3";

/** Flat ground and nothing to hit: this file never fires a round. */
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

interface Options {
  players?: string[];
  gametype?: GametypeDecl;
  /** Absent means the real registry's answer, which is what a real game gets. */
  hooks?: ServerHooks;
}

function game(options: Options = {}) {
  const scripts: Script[] | undefined = options.hooks ? [{ id: "test", server: options.hooks }] : undefined;
  const match = new Match(ground, world(), TICK_RATE, 8, new WeaponRegistry([]), {
    map: MAP,
    gametype: options.gametype ?? defaultGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    scripts,
  });

  let seq = 0;
  let latest: PlayerSnapshot[] = [];
  const players = options.players ?? ["a"];
  const join = (id: string): void => {
    match.join(id);
  };

  /** One tick, with everybody's input drained, and the tail each player was sent. */
  const tick = (): Map<string, GameEvent[]> => {
    for (const id of players.filter((p) => match.has(p))) {
      match.receive(id, { seq: ++seq, dt: DT, input: idleInput(0, 0), claim: { x: 0, y: 0, z: 0 }, drawn: { tick: 0, frac: 0 } });
    }
    const snapshot = match.step();
    latest = snapshot.players;
    return new Map(latest.map((player) => [player.id, match.snapshotFor(player.id, latest).events]));
  };

  /**
   * Each announcement the first player was told about, the tick it *first*
   * arrived on.
   *
   * De-duplicated by id here exactly as `unseenEvents` does it in the browser,
   * which is what makes a repeated tail readable at all: at the tick a new line
   * is raised the old one is still riding, so "the first event in the tail" is
   * the previous line for another half-second.
   */
  const run = (ticks: number): { tick: number; event: AnnounceEvent }[] => {
    const out: { tick: number; event: AnnounceEvent }[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < ticks; i++) {
      for (const event of tick().get(players[0]!) ?? []) {
        if (event.kind === "announce" && !seen.has(event.id)) {
          seen.add(event.id);
          out.push({ tick: match.tick, event });
        }
      }
    }
    return out;
  };

  return { match, join, tick, run, latest: () => latest };
}

describe("publish reaches a browser", () => {
  it("puts what a script said in every player's tail, with an id of its own", () => {
    const said = game({ players: ["a", "b"], hooks: { tick: (ctx) => ctx.publish({ what: "flagTaken", team: "axis", value: 2 }) } });
    said.join("a");
    said.join("b");
    const tails = said.tick();
    // The same event, to everybody: an announcement carries the side it is about
    // and each client reads that against its own, rather than the server
    // addressing two different messages.
    for (const id of ["a", "b"]) {
      expect(tails.get(id)).toEqual([{ kind: "announce", id: 1, what: "flagTaken", team: 1, value: 2, player: null }]);
    }
  });

  it("carries the side as an index, as PlayerState.team does", () => {
    const sides: GametypeDecl = { id: "sides", display: "Sides", teams: ["allies", "axis", "neutral"] };
    const named = game({ gametype: sides, hooks: { tick: (ctx) => ctx.publish({ what: "held", team: "neutral" }) } });
    named.join("a");
    const [event] = named.tick().get("a") as AnnounceEvent[];
    expect(event).toEqual({ kind: "announce", id: 1, what: "held", team: 2, value: null, player: null });
  });

  it("names the one player it is about, to everybody", () => {
    const bought = game({ players: ["a", "b"], hooks: { tick: (ctx) => ctx.publish({ what: "purchase", player: "b", value: 750 }) } });
    bought.join("a");
    bought.join("b");
    const tails = bought.tick();
    for (const id of ["a", "b"]) {
      expect(tails.get(id)).toEqual([{ kind: "announce", id: 1, what: "purchase", team: null, value: 750, player: "b" }]);
    }
  });

  // Absent is not zero, at either end: a countdown reading zero is a thing to say
  // and an announcement that belongs to nobody is not one that belongs to side 0.
  it("keeps an absent side and an absent number absent", () => {
    const bare = game({ hooks: { tick: (ctx) => ctx.publish({ what: "roundStart" }) } });
    bare.join("a");
    expect(bare.tick().get("a")).toEqual([{ kind: "announce", id: 1, what: "roundStart", team: null, value: null, player: null }]);
  });
});

describe("the retention a script's event gets", () => {
  /**
   * A second, which is twice a death's half — the reasoning is in
   * net/messages/events.ts. What is asserted here is that it *is* a retention and
   * that it ends: a kind repeated for ever would fill the seven-event tail with
   * history, and a kind repeated for nothing would be a hit marker.
   */
  it("repeats for a second and then stops, where a hit marker is sent once", () => {
    const once = game({ hooks: { tick: (ctx) => void (ctx.now < 2 * (1 / 60) && ctx.publish({ what: "roundStart" })) } });
    once.join("a");

    let carried = 0;
    for (let i = 0; i < 120; i++) {
      if ((once.tick().get("a") ?? []).some((event) => event.kind === "announce")) {
        carried++;
      }
    }
    // The tick it was raised on, and then a second of repeats: `until` is
    // `currentTick + rate * hold` and an event is dropped once the clock is past
    // it, so a death's half-second is 31 datagrams and this is 61.
    expect(carried).toBe(TICK_RATE + 1);
  });

  it("is de-duplicated by the id, so sixty datagrams are one announcement", () => {
    const once = game({ hooks: { tick: (ctx) => void (ctx.now < 2 * (1 / 60) && ctx.publish({ what: "roundStart" })) } });
    once.join("a");
    const ids = new Set<number>();
    for (let i = 0; i < 90; i++) {
      for (const event of once.tick().get("a") ?? []) {
        ids.add(event.id);
      }
    }
    expect([...ids]).toEqual([1]);
  });
});

describe("what publish refuses", () => {
  /** A script bug is loud here, as it is for `setTeam`: a wrong answer nothing reports is the worse failure. */
  const publishing = (event: unknown) => {
    const bad = game({ hooks: { tick: (ctx) => ctx.publish(event as never) } });
    bad.join("a");
    return () => bad.tick();
  };

  it("refuses a name that is empty or longer than the field carrying it", () => {
    expect(publishing({ what: "" })).toThrow(/wants a name/);
    expect(publishing({ what: "x".repeat(MAX_ANNOUNCE_NAME_BYTES + 1) })).toThrow(/wants a name/);
    // Bytes and not characters, because that is what the length field counts.
    expect(publishing({ what: "é".repeat(MAX_ANNOUNCE_NAME_BYTES) })).toThrow(/wants a name/);
    expect(publishing({ what: "x".repeat(MAX_ANNOUNCE_NAME_BYTES) })).not.toThrow();
  });

  it("refuses a side the gametype does not have", () => {
    expect(publishing({ what: "held", team: "martians" })).toThrow(/does not have/);
  });

  it("refuses a player who is not in the match", () => {
    expect(publishing({ what: "purchase", player: "nobody" })).toThrow(/not in this match/);
    expect(publishing({ what: "purchase", player: "a" })).not.toThrow();
  });

  it("refuses a number the wire cannot carry, rather than rounding it", () => {
    expect(publishing({ what: "score", value: 1.5 })).toThrow(/wants an integer/);
    expect(publishing({ what: "score", value: 40_000 })).toThrow(/wants an integer/);
  });

  it("drops a flood instead of throwing, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const flood = game({
      hooks: {
        tick: (ctx) => {
          for (let i = 0; i < 50; i++) {
            ctx.publish({ what: `line${i}` });
          }
        },
      },
    });
    flood.join("a");
    expect(() => flood.tick()).not.toThrow();
    // A flood is not a wrong answer the way an unanswerable hit is, and a throw
    // here would take every other game on this process's tick with it.
    expect(flood.match.eventsThisTick).toHaveLength(8);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("the countdown, through a real match", () => {
  it("says five, four, three, two, one and then the round, one per second", () => {
    // No `hooks`, so this is `scriptsFor(default, dome-mw3)` — what a real game
    // runs, the registry's own table, the real script.
    const match = game();
    match.join("a");
    const heard = match.run(7 * TICK_RATE);
    expect(heard.map(({ event }) => [event.what, event.value])).toEqual([
      ["countdown", 5],
      ["countdown", 4],
      ["countdown", 3],
      ["countdown", 2],
      ["countdown", 1],
      ["roundStart", null],
    ]);
    // One a second from the join, and the first is a second in rather than on the
    // tick somebody arrived: nothing has elapsed at that instant.
    expect(heard.map(({ tick }) => tick)).toEqual([60, 120, 180, 240, 300, 360]);
  });

  it("says nothing until somebody is there to hear it", () => {
    const empty = game({ players: [] });
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      empty.tick();
    }
    expect(empty.match.eventCursor).toBe(0);

    // And then the count is theirs, from where they came in rather than from the
    // tick the process happened to create this match on.
    empty.join("late");
    for (let i = 0; i < TICK_RATE; i++) {
      empty.tick();
    }
    const tail = empty.match.snapshotFor("late", empty.latest()).events.filter((event) => event.kind === "announce");
    expect(tail.map((event) => event.value)).toEqual([5]);
  });
});
