// The match: that a tick advances players by the inputs they sent, that the
// drift between a client's claim and our re-simulation is measured honestly, and
// that a client cannot buy movement by sending faster.
//
// "Honestly" now means *per step*: each step is replayed from where the client
// said the previous one ended, so what is measured is one step's error and not
// the sum of every step since joining. Several of these tests exist to pin that
// down, because it changes what the figure means — a standing offset stops
// showing up, and the step that opened it starts to.
//
// No socket and no geckos: Match takes a CapsuleWorld and plain messages, which
// is the whole reason it is a separate file from net/server.ts.

import { describe, expect, it } from "vitest";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { createMovement, EYE_HEIGHT, type MovementState } from "@3d/shared/sim/movement.js";
import { Player } from "@3d/shared/sim/player.js";
import { Match } from "../src/match.js";
import { decodePacket, encodePacket, MessageType } from "@3d/shared/net/packet.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

/** A floor at y=0 and nothing else, so a step has something to stand on and the maths stays checkable. */
class FlatGround {
  readonly ready = true;
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
  }

  overlapsCapsule(position: { y: number }): boolean {
    return position.y < 0;
  }

  /** Nothing here is shot at; the floor is for standing on. */
  traceRay(): null {
    return null;
  }

  groundBelow(from: { y: number }, distance: number): number | null {
    return from.y >= 0 && from.y - distance <= 0 ? 0 : null;
  }

  // Nothing here has a surface; a flat test floor is `default` either way.
  surfaceAt(): null {
    return null;
  }
}

/** The least world that satisfies the rules Match applies: a spawn, no terrain, no rooms. */
function world(): ResolvedWorld {
  return {
    spawn: { position: { x: 0, y: EYE_HEIGHT, z: 0 }, look: { x: 0, y: EYE_HEIGHT, z: -1 } },
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

function match(collision: FlatGround = new FlatGround(), maxPlayers = 4): Match {
  return new Match(collision, world(), TICK_RATE, maxPlayers);
}

/** A world whose map declares its own start spawns, as an imported one does. */
function worldWithSpawns(xs: number[]): ResolvedWorld {
  return {
    ...world(),
    spawnPoints: xs.map((x) => ({
      position: { x, y: EYE_HEIGHT, z: 0 },
      look: { x, y: EYE_HEIGHT, z: -1 },
      modes: ["tdm"],
      start: true,
    })),
  } as unknown as ResolvedWorld;
}

/** An input plus the claim a perfectly honest client would make: the same step, run locally. */
function honest(seq: number, input: PlayerInput, shadow: Player): InputMessage {
  shadow.step(input, DT);
  // renderTick 0 with no history yet clamps to the oldest tick we have, which is
  // what an honest client that has not been sent a snapshot would also get.
  return { seq, dt: DT, input, claim: structuredClone(shadow.movement) as MovementState, renderTick: 0, renderFrac: 0 };
}

const forward: PlayerInput = { ...idleInput(0, 0), forward: 1 };

describe("a match", () => {
  it("admits a player at the spawn, and a repeated join does not teleport them", () => {
    const m = match();
    m.join("a");
    const shadow = new Player(new FlatGround());
    shadow.place({ x: 0, y: 0, z: 0 }, 0, 0);

    for (let i = 1; i <= 30; i++) {
      m.receive("a", honest(i, forward, shadow));
      m.step();
    }
    const moved = m.step().players[0]!.state.movement.feet.z;
    expect(moved).toBeLessThan(-0.5); // yaw 0 faces -Z

    m.join("a");
    expect(m.size).toBe(1);
    expect(m.step().players[0]!.state.movement.feet.z).toBeCloseTo(moved, 5);
  });

  it("reports ~no drift when the client's claim is what the same input really produces", () => {
    const m = match();
    m.join("a");
    const shadow = new Player(new FlatGround());
    shadow.place({ x: 0, y: 0, z: 0 }, 0, 0);

    for (let i = 1; i <= 120; i++) {
      m.receive("a", honest(i, forward, shadow));
      m.step();
    }

    const drift = m.drift("a")!;
    // Every input is compared. One used to be spent seeding us from the client's
    // first claim; nothing is adopted now, so nothing is skipped.
    expect(drift.samples).toBe(120);
    // f32 on the wire against the f64 both sides step in: millimetres, not metres.
    expect(drift.max).toBeLessThan(0.01);
  });

  it("reports the drift on the step a client claims somewhere it could not have reached", () => {
    const m = match();
    m.join("a");
    const shadow = new Player(new FlatGround());
    shadow.place({ x: 0, y: 0, z: 0 }, 0, 0);

    for (let i = 1; i <= 60; i++) {
      const message = honest(i, forward, shadow);
      if (i > 1) {
        message.claim!.feet.x += 5; // it teleports sideways, and stays there
      }
      m.receive("a", message);
      m.step();
    }

    // A client that lies once and then walks honestly from where it lied itself
    // to is reported for every step after it, not just the one. That is a change:
    // re-anchoring made this a single spike and then silence, because the server
    // moved itself to the lie. It cannot any more, so the disagreement persists —
    // which is the honest reading of a client that is five metres from where we
    // have it, and the number a validator gets a threshold against.
    expect(m.drift("a")!.max).toBeGreaterThan(4.9);
    expect(m.drift("a")!.current).toBeGreaterThan(4.9);
    // And it does not *grow*: they are walking, not accelerating away.
    expect(m.drift("a")!.current).toBeLessThan(5.1);
  });

  it("one bad claim moves nobody, and shows up once", () => {
    const m = match();
    m.join("a");
    const shadow = new Player(new FlatGround());
    shadow.place({ x: 0, y: 0, z: 0 }, 0, 0);

    for (let i = 1; i <= 60; i++) {
      const message = honest(i, forward, shadow);
      if (i === 30) {
        message.claim!.feet.x += 2; // one bad step, and honest either side of it
      }
      m.receive("a", message);
      m.step();
    }

    // The server never adopted the lie, so it never has to recover from it: the
    // thirtieth step reports ~2 m and every other step is unaffected. Back when
    // the claim was re-anchored to, *two* steps reported it — the one that left
    // the truth and the one that came back — because the next step was replayed
    // from the lie. Now there is nothing to come back from.
    expect(m.drift("a")!.max).toBeGreaterThan(1.9);
    expect(m.drift("a")!.current).toBeLessThan(0.01);
    expect(m.drift("a")!.mean).toBeCloseTo(2 / 60, 2);

    // And the player is where *we* put them, not two metres to the side of it.
    expect(m.step().players[0]!.state.movement.feet.x).toBeCloseTo(shadow.movement.feet.x, 1);
  });

  it("spends at most four inputs a tick, so flooding buys no extra simulation", () => {
    const m = match();
    m.join("a");
    // Ten ticks' worth into a single tick. Sixteen is the queue's ceiling, so
    // the rest never even lands.
    for (let i = 1; i <= 40; i++) {
      m.receive("a", { seq: i, dt: DT, input: forward, claim: createMovement({ x: 0, y: 0, z: 0 }, 0, 0), renderTick: 0, renderFrac: 0 });
    }
    m.step();

    // Four spent, and all four compared — none is spent seeding any more. The
    // rest are still queued or were dropped at the door, and none was stepped.
    expect(m.drift("a")!.samples).toBe(4);
    expect(m.report()[0]!.dropped).toBe(24);
  });

  it("acks each player's own last applied input", () => {
    const m = match();
    m.join("a");
    m.join("b");
    m.receive("a", { seq: 7, dt: DT, input: forward, claim: createMovement({ x: 0, y: 0, z: 0 }, 0, 0), renderTick: 0, renderFrac: 0 });
    m.receive("b", { seq: 99, dt: DT, input: forward, claim: createMovement({ x: 0, y: 0, z: 0 }, 0, 0), renderTick: 0, renderFrac: 0 });
    const players = m.step().players;

    expect(m.snapshotFor("a", players).ack).toBe(7);
    expect(m.snapshotFor("b", players).ack).toBe(99);
    // Both see both: the snapshot is the whole world, uncompressed, for now.
    expect(m.snapshotFor("a", players).players).toHaveLength(2);
  });

  it("never lowers ack, and never applies an input twice, whatever order they arrive in", () => {
    // The data channel is unordered: a datagram can overtake the one before it,
    // and a straggler must neither be stepped late nor take the ack back.
    const m = match();
    m.join("a");
    const shadow = new Player(new FlatGround());
    shadow.place({ x: 0, y: 0, z: 0 }, 0, 0);
    const sent = [1, 2, 3, 4].map((seq) => honest(seq, forward, shadow));

    m.receive("a", sent[0]!);
    m.receive("a", sent[2]!);
    let players = m.step().players;
    expect(m.snapshotFor("a", players).ack).toBe(3);

    m.receive("a", sent[1]!); // late: 3 is already applied
    m.receive("a", sent[2]!); // and a repeat
    players = m.step().players;
    expect(m.snapshotFor("a", players).ack).toBe(3);
    expect(m.drift("a")!.samples).toBe(2);

    m.receive("a", sent[3]!);
    players = m.step().players;
    expect(m.snapshotFor("a", players).ack).toBe(4);
    expect(m.drift("a")!.samples).toBe(3);
  });

  it("orders inputs across the 16-bit wrap", () => {
    const m = match();
    m.join("a");
    const input = (seq: number): InputMessage => ({ seq, dt: DT, input: forward, claim: null, renderTick: 0, renderFrac: 0 });
    m.receive("a", input(65535));
    m.receive("a", input(0));
    m.receive("a", input(65534)); // before both: dropped
    const players = m.step().players;
    expect(m.snapshotFor("a", players).ack).toBe(0);
  });

  it("counts from the start again for a new connection, once told to", () => {
    const m = match();
    m.join("a");
    const input = (seq: number): InputMessage => ({ seq, dt: DT, input: forward, claim: null, renderTick: 0, renderFrac: 0 });
    m.receive("a", input(5000));
    m.step();
    // A fresh client starts at 1, which reads as 4999 inputs old.
    m.receive("a", input(1));
    expect(m.snapshotFor("a", m.step().players).ack).toBe(5000);
    m.resetInputs("a");
    m.receive("a", input(2));
    expect(m.snapshotFor("a", m.step().players).ack).toBe(2);
  });

  it("clamps the dt a client claims, so a long step cannot be bought", () => {
    // 0.25 s is what the wire allows; two ticks is what a step may actually use.
    // One input each, from our own spawn — which is where a player now starts
    // whatever they say.
    const where = (dt: number) => {
      const shadow = new Player(new FlatGround());
      shadow.place({ x: 0, y: 0, z: 0 }, 0, 0);
      shadow.step(forward, dt);
      return structuredClone(shadow.movement) as MovementState;
    };

    // Asking for a quarter-second buys two ticks, and the gap between what was
    // asked for and what was given is what the drift reports. The floor absorbs
    // the vertical difference — that much gravity lands on it either way — so
    // what is left is the ~0.1 m of extra walking a client tried to buy.
    const clamped = match();
    clamped.join("a");
    clamped.receive("a", { seq: 1, dt: 0.25, input: forward, claim: where(0.25), renderTick: 0, renderFrac: 0 });
    clamped.step();
    expect(clamped.drift("a")!.current).toBeGreaterThan(0.09);

    // And a client asking for no more than it may have lands exactly where we put
    // it, which is what makes the figure above the clamp and not a coincidence.
    const honestDt = match();
    honestDt.join("a");
    honestDt.receive("a", { seq: 1, dt: 2 * DT, input: forward, claim: where(2 * DT), renderTick: 0, renderFrac: 0 });
    honestDt.step();
    expect(honestDt.drift("a")!.current).toBeLessThan(0.001);
  });

  it("turns a player away when the match is full, and lets them in once someone leaves", () => {
    const m = match(new FlatGround(), 1);
    m.join("a");
    expect(m.full).toBe(true);
    m.leave("a");
    expect(m.full).toBe(false);
    m.join("b");
    expect(m.size).toBe(1);
  });
});

describe("a joining player", () => {
  it("spawns where we say, whatever the client claims", () => {
    const m = match();
    m.join("a");
    const shadow = new Player(new FlatGround());
    // Somewhere a pose link might have dropped them, far from our spawn.
    shadow.place({ x: 40, y: 0, z: -25 }, 0, 0);

    for (let i = 1; i <= 30; i++) {
      m.receive("a", honest(i, forward, shadow));
      m.step();
    }

    // We simulate their *inputs* from our own spawn. Walking forward for half a
    // second from the origin is where they are, and 40 m away is not.
    const feet = m.step().players[0]!.state.movement.feet;
    expect(feet.x).toBeCloseTo(0, 1);
    expect(feet.z).toBeLessThan(-0.5);

    // This used to be adopted — the server took the first claim as given, because
    // a client believed anyway may as well be believed about where it started.
    // Owning the correction means owning the spawn, so the offset between the two
    // starting points now reads as what it is: a client a long way from where we
    // have them.
    expect(m.drift("a")!.max).toBeGreaterThan(40);
  });

  it("spawns at the world's spawn before any input arrives", () => {
    const m = match();
    m.join("a");
    const feet = m.step().players[0]!.state.movement.feet;
    expect(feet.x).toBe(0);
    expect(feet.z).toBe(0);
  });
});

describe("spawn points", () => {
  /**
   * The visible symptom of having only one: everybody standing inside everybody
   * else at the start of a match.
   */
  it("puts consecutive joiners on different points", () => {
    const m = new Match(new FlatGround(), worldWithSpawns([10, 20, 30]), TICK_RATE, 4);
    m.join("a");
    m.join("b");
    m.join("c");

    const xs = m.step().players.map((p) => p.state.movement.feet.x);
    expect([...xs].sort((l, r) => l - r)).toEqual([10, 20, 30]);
  });

  it("wraps round when more players join than the map has points", () => {
    const m = new Match(new FlatGround(), worldWithSpawns([10, 20]), TICK_RATE, 4);
    for (const id of ["a", "b", "c"]) {
      m.join(id);
    }
    expect(m.step().players.map((p) => p.state.movement.feet.x)).toEqual([10, 20, 10]);
  });

  it("does not move a player a repeated join names", () => {
    const m = new Match(new FlatGround(), worldWithSpawns([10, 20]), TICK_RATE, 4);
    m.join("a");
    m.join("a");
    expect(m.step().players.map((p) => p.state.movement.feet.x)).toEqual([10]);
  });

  /** A world that declares no `spawn` points must still work. */
  it("falls back to the world's single spawn when there are none", () => {
    const m = match();
    m.join("a");
    expect(m.step().players[0]!.state.movement.feet.x).toBe(0);
  });
});

// Sides. The default gametype declares two (`allies`, `axis`), and 9,463 `spawn`
// nodes across the imported worlds already carry a `team:` that nothing spent
// until now. A score needs sides, so this is where they start.
describe("sides", () => {
  it("fills the smallest side, so four players come out two and two", () => {
    const m = match();
    m.join("a");
    m.join("b");
    m.join("c");
    m.join("d");
    const teams = m.step().players.map((p) => p.state.team);
    expect(teams).toEqual([0, 1, 0, 1]);
  });

  it("is deterministic, so two runs of the same joins agree", () => {
    const sides = () => {
      const m = match();
      for (const id of ["x", "y", "z"]) {
        m.join(id);
      }
      return m.step().players.map((p) => p.state.team);
    };
    expect(sides()).toEqual(sides());
    expect(sides()).toEqual([0, 1, 0]);
  });

  it("goes by who is actually on each side, not by how many have joined", () => {
    const m = match();
    m.join("a"); // side 0
    m.join("b"); // side 1
    m.join("c"); // side 0 — the smallest
    m.leave("c"); // and straight back out: 1 v 1 again
    m.join("d");
    // Three players have joined before `d`, so a counter would deal it side 1.
    // Occupancy says the sides are level, and a level tie goes to the first —
    // which is what makes this assertion tell the two rules apart.
    const byId = new Map(m.step().players.map((p) => [p.id, p.state.team]));
    expect(byId.get("d")).toBe(0);
    expect([...byId.values()].filter((t) => t === 0)).toHaveLength(2);
    expect([...byId.values()].filter((t) => t === 1)).toHaveLength(1);
  });

  it("survives the wire, since a snapshot is how a client learns anyone's side", () => {
    const m = match();
    m.join("a");
    m.join("b");
    const snapshot = m.step();
    const back = decodePacket(encodePacket(MessageType.snapshot, snapshot));
    expect(back.type).toBe(MessageType.snapshot);
    if (back.type === MessageType.snapshot) {
      expect(back.message.players.map((p) => p.state.team)).toEqual([0, 1]);
    }
  });
});
