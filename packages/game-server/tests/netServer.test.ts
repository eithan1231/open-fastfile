// The transport's own two jobs, over a channel that is a plain object: that one
// game throwing on its tick ends only that game, and that inputs reach a match
// once each and in order however the datagrams carrying them arrive.
//
// No geckos: `NetServer` is handed a channel by geckos' `onConnection`, so a test
// hands it one too and plays the client's side of the datagrams.

import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerChannel } from "@geckos.io/server";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { Script } from "@3d/shared/game/hooks.js";
import { roundDt, type InputPacket, type InputStep } from "@3d/shared/net/messages/input.js";
import { decodePacket, encodePacket, MessageType, PROTOCOL_VERSION, type Packet } from "@3d/shared/net/packet.js";
import type { SnapshotMessage } from "@3d/shared/net/messages/snapshot.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { createMovement } from "@3d/shared/sim/movement.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { NO_BODIES } from "../src/bodies.js";
import type { GameInstance, Games } from "../src/games.js";
import { Match } from "../src/match/match.js";
import { NetServer } from "../src/net/server.js";
import { GameTick } from "../src/tick.js";
import type { Weapons } from "../src/weapons.js";

const TICK_RATE = 60;
const PLAYER = "aaaaaaaa";

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
  surfaceAt: () => null,
  traceRay: () => null,
};

const WORLD = {
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

const PLAIN: GametypeDecl = { id: "plain", display: "Plain", teams: ["us"] };

function game(id: string, scripts: Script[] = []): GameInstance {
  const match = new Match(ground, WORLD, TICK_RATE, 4, new WeaponRegistry([]), {
    map: "flat",
    gametype: PLAIN,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    scripts,
  });
  // Spawned here rather than by a class choice: what is under test is the tick.
  match.join(PLAYER);
  return { id, map: "flat", worldHash: "w", match, roster: new Map(), createdAt: 0, durationMs: 600_000, joined: true, choosing: new Set() };
}

/** A geckos channel as `NetServer` uses one: a raw handler to feed, and what it was sent. */
function channel(id: string) {
  let onRaw: (data: unknown) => void = () => {};
  let onGone: () => void = () => {};
  const sent: Packet[] = [];
  const fake = {
    id,
    onDisconnect: (handler: () => void) => void (onGone = handler),
    onRaw: (handler: (data: unknown) => void) => void (onRaw = handler),
    raw: { emit: (data: ArrayBuffer) => void sent.push(decodePacket(new Uint8Array(data))) },
    close: () => {},
  };
  return { channel: fake as unknown as ServerChannel, deliver: (bytes: Uint8Array) => onRaw(bytes), disconnect: () => onGone(), sent };
}

/** A server hosting `hosted`, with one seated player in each. */
function serve(hosted: GameInstance[]) {
  const games = {
    all: () => hosted,
    get: (id: string) => hosted.find((g) => g.id === id),
    admits: () => true,
  } as unknown as Games;
  const net = new NetServer(games, { hash: "h" } as unknown as Weapons);
  const seats = hosted.map((g) => {
    const seat = channel(`socket-${g.id}`);
    (net as unknown as { onConnection(c: ServerChannel): void }).onConnection(seat.channel);
    seat.deliver(
      encodePacket(MessageType.join, {
        protocol: PROTOCOL_VERSION,
        gameId: g.id,
        playerId: PLAYER,
        authorizationKey: "k",
        catalogHash: "h",
        worldHash: "w",
        engine: "test",
      }),
    );
    expect(seat.sent.map((p) => p.type)).toEqual([MessageType.joined]);
    seat.sent.length = 0;
    return seat;
  });
  return { net, seats, tick: new GameTick(games, net) };
}

const snapshots = (sent: Packet[]) => sent.filter((p) => p.type === MessageType.snapshot).length;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a game that throws on its tick", () => {
  it("ends itself, and the game after it keeps stepping and sending", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = game("g-broken", [
      {
        id: "broken",
        server: {
          tick: () => {
            throw new Error("a script bug");
          },
        },
      },
    ]);
    const fine = game("g-fine");
    const { tick, seats } = serve([broken, fine]);

    for (let i = 0; i < 5; i++) {
      tick.run();
    }

    expect(broken.match.failed).toBe("a script bug");
    // Said once, with the game it was, rather than once a tick.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toContain("g-broken");
    // Stepped once more — the tick that threw — and never again.
    expect(broken.match.tick).toBe(1);
    expect(snapshots(seats[0]!.sent)).toBe(0);

    // First in the loop, so before this the second game never stepped at all.
    expect(fine.match.failed).toBeUndefined();
    expect(fine.match.tick).toBe(5);
    expect(snapshots(seats[1]!.sent)).toBe(5);
  });
});

describe("a game that throws as somebody leaves", () => {
  it("ends itself rather than the socket's handler, and the game beside it plays on", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const broken = game("g-broken", [
      {
        id: "broken",
        server: {
          playerLeave: () => {
            throw new Error("a script bug");
          },
        },
      },
    ]);
    const fine = game("g-fine");
    const { tick, seats } = serve([broken, fine]);

    expect(() => seats[0]!.disconnect()).not.toThrow();
    expect(broken.match.failed).toBe("a script bug");
    expect(String(errors.mock.calls[0]![0])).toContain("g-broken");

    tick.run();
    expect(fine.match.failed).toBeUndefined();
    expect(snapshots(seats[1]!.sent)).toBe(1);
  });
});

describe("inputs off an unordered, lossy channel", () => {
  const claim = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  const step = (forward: number): InputStep => ({ dt: roundDt(1 / TICK_RATE), input: { ...idleInput(0, 0), forward }, renderTick: 0, renderFrac: 0 });
  const packet = (seq: number, newest: InputStep, earlier: InputStep[]): Uint8Array =>
    encodePacket(MessageType.input, { seq, claim, ...newest, earlier } satisfies InputPacket);

  it("recovers a lost datagram's input from the next one, and applies none twice", () => {
    const hosted = game("g-1");
    const { tick, seats } = serve([hosted]);
    const [a, b, c] = [step(1), step(1), step(1)];

    seats[0]!.deliver(packet(1, a, []));
    // seq 2 = b is lost on the way; seq 3 repeats it.
    seats[0]!.deliver(packet(3, c, [a, b]));
    // And the lost one turns up late, after all.
    seats[0]!.deliver(packet(2, b, [a]));
    tick.run();

    const snapshot = seats[0]!.sent.find((p) => p.type === MessageType.snapshot)!.message as SnapshotMessage;
    expect(snapshot.ack).toBe(3);
    // Exactly three steps forward: one fewer is the lost input, one more a replay.
    const after = (n: number) => {
      const reference = new Match(ground, WORLD, TICK_RATE, 4);
      reference.join(PLAYER);
      for (let i = 1; i <= n; i++) {
        reference.receive(PLAYER, { ...a, seq: i, claim });
      }
      return reference.step().players[0]!.state.movement.feet.z;
    };
    const got = snapshot.players[0]!.state.movement.feet.z;
    expect(got).toBeCloseTo(after(3), 5);
    expect(got).not.toBeCloseTo(after(2), 5);
    expect(got).not.toBeCloseTo(after(4), 5);
    // The recovered input carried no claim, so two of the three were measured.
    expect(hosted.match.report()[0]!.drift.samples).toBe(2);
  });
});
