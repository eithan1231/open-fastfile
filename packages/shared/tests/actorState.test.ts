// An actor on the wire (net/messages/actors.ts): twelve bytes that round-trip
// to within their quanta, in a snapshot beside players or on its own.

import { describe, expect, it } from "vitest";
import { BitReader, BitWriter } from "../src/net/codec/bits.js";
import { actorStateSchema, ACTOR_HEIGHT_REACH, ACTOR_REACH, ACTOR_SPEED_MAX, MAX_SNAPSHOT_ACTORS, MAX_TRAVERSAL_CLIPS } from "../src/net/messages/actors.js";
import type { SnapshotMessage } from "../src/net/messages/snapshot.js";
import { decodePacket, encodePacket, MessageType } from "../src/net/packet.js";
import { ACTOR_ACTIONS, type ActorState } from "../src/game/actors/actor.js";
import { ACTOR_KINDS, MAX_ACTOR_KINDS } from "../src/game/actors/kinds.js";
import { Player } from "../src/sim/player.js";
import { WeaponRegistry } from "../src/sim/weaponRegistry.js";

const actor = (id: number, overrides: Partial<ActorState> = {}): ActorState => ({
  id,
  kind: 0,
  feet: { x: 12.3, y: -1.25, z: -407.8 },
  yaw: 1.2,
  speed: 2.4,
  gait: "walk",
  action: "move",
  phase: 0.37,
  traversal: 0,
  dead: false,
  ...overrides,
});

function roundTrip(state: ActorState): { back: ActorState; bits: number } {
  const w = new BitWriter();
  actorStateSchema.write(w, state);
  const bytes = w.finish();
  return { back: actorStateSchema.read(new BitReader(bytes)), bits: bytes.length * 8 };
}

describe("ActorState", () => {
  it("is twelve bytes", () => {
    expect(roundTrip(actor(1)).bits).toBe(96);
  });

  it("round-trips to within its quanta", () => {
    for (const state of [
      actor(1),
      actor(0xffff, { kind: MAX_ACTOR_KINDS - 1, action: "die", dead: true, phase: 1, speed: 0 }),
      actor(7, { action: "attack", gait: "sprint", phase: 0, yaw: -3, feet: { x: -900, y: 200, z: 900 } }),
      actor(9, { gait: "run", speed: 3.6 }),
      actor(8, { action: "idle", feet: { x: 0, y: 0, z: 0 } }),
      // The widest action, at every gait, and the fastest speed the wire holds.
      actor(10, { action: "traverse", gait: "walk", phase: 0.5 }),
      actor(11, { action: "traverse", gait: "sprint", phase: 1 }),
      actor(12, { gait: "sprint", speed: 8 }),
    ]) {
      const { back } = roundTrip(state);
      expect(back.id).toBe(state.id);
      expect(back.kind).toBe(state.kind);
      expect(back.action).toBe(state.action);
      expect(back.dead).toBe(state.dead);
      expect(back.gait).toBe(state.gait);
      expect(Math.abs(back.feet.x - state.feet.x)).toBeLessThan(1 / 64);
      expect(Math.abs(back.feet.y - state.feet.y)).toBeLessThan(1 / 64);
      expect(Math.abs(back.feet.z - state.feet.z)).toBeLessThan(1 / 64);
      expect(Math.abs(Math.atan2(Math.sin(back.yaw - state.yaw), Math.cos(back.yaw - state.yaw)))).toBeLessThan(Math.PI / 256 + 1e-9);
      // A traverse sends its clip where the speed goes (below).
      expect(Math.abs(back.speed - (state.action === "traverse" ? 0 : state.speed))).toBeLessThan(0.07);
      expect(Math.abs(back.phase - state.phase)).toBeLessThan(0.004);
    }
  });

  it("carries a traverse's clip in the speed's bits, and a speed everywhere else", () => {
    const jumping = roundTrip(actor(1, { action: "traverse", traversal: 5, speed: 3, phase: 0.5 })).back;
    expect([jumping.traversal, jumping.speed, jumping.action]).toEqual([5, 0, "traverse"]);
    expect(roundTrip(actor(1, { action: "traverse", traversal: MAX_TRAVERSAL_CLIPS })).back.traversal).toBe(MAX_TRAVERSAL_CLIPS);
    const moving = roundTrip(actor(1, { action: "move", traversal: 5, speed: 2.4 })).back;
    expect(moving.traversal).toBe(0);
    expect(moving.speed).toBeCloseTo(2.4, 1);
    expect(roundTrip(actor(1, { action: "traverse", traversal: 5 })).bits).toBe(96);
  });

  it("clamps a position beyond its reach to the edge, rather than wrapping", () => {
    const { back } = roundTrip(actor(1, { feet: { x: 5000, y: -5000, z: -5000 } }));
    expect(back.feet).toEqual({ x: ACTOR_REACH, y: -ACTOR_HEIGHT_REACH, z: -ACTOR_REACH });
  });

  // Not sent: a body that is dying is dead, and one that is not is not.
  it("reads dead back from the action", () => {
    expect(roundTrip(actor(1, { action: "die", dead: true })).back.dead).toBe(true);
    expect(roundTrip(actor(1, { action: "attack", dead: false })).back.dead).toBe(false);
  });

  it("carries every action, and draws a speed past the top at the top", () => {
    for (const action of ACTOR_ACTIONS) {
      expect(roundTrip(actor(1, { action, dead: action === "die" })).back.action).toBe(action);
    }
    expect(roundTrip(actor(1, { speed: 20 })).back.speed).toBeCloseTo(ACTOR_SPEED_MAX, 9);
  });

  it("names every kind in four bits", () => {
    expect(ACTOR_KINDS.length).toBeLessThanOrEqual(MAX_ACTOR_KINDS);
  });
});

describe("a snapshot's actors", () => {
  const players = () => {
    const player = new Player({ ready: false } as never, new WeaponRegistry([]));
    player.place({ x: 1, y: 0, z: 2 }, 0, 0);
    return [{ id: "abc12345", state: player.snapshot() }];
  };

  it("costs one byte when there are none, and twelve for each", () => {
    const base: SnapshotMessage = { tick: 9, ack: 3, presence: null, players: players(), actors: [], counters: [], events: [] };
    const size = (actors: ActorState[]) => encodePacket(MessageType.snapshot, { ...base, actors }).length;
    expect(size([actor(1)])).toBe(size([]) + 12);
    expect(size([actor(1), actor(2), actor(3)])).toBe(size([]) + 36);
  });

  it("round-trips beside players and events, and with no players at all", () => {
    for (const message of [
      {
        tick: 9,
        ack: 3,
        presence: null,
        players: players(),
        actors: [actor(1), actor(2, { action: "attack" })],
        counters: [],
        events: [{ kind: "hit" as const, id: 4, location: "torsoUpper" as const, lethal: false }],
      },
      { tick: 9, ack: 0, presence: null, players: [], actors: [actor(3)], counters: [], events: [] },
    ] satisfies SnapshotMessage[]) {
      const back = decodePacket(encodePacket(MessageType.snapshot, message)).message as SnapshotMessage;
      expect(back.players.map((p) => p.id)).toEqual(message.players.map((p) => p.id));
      expect(back.actors.map((a) => [a.id, a.action])).toEqual(message.actors.map((a) => [a.id, a.action]));
      expect(back.events).toEqual(message.events);
    }
  });

  it("carries the cap, which is what a match sends at most", () => {
    const full = Array.from({ length: MAX_SNAPSHOT_ACTORS }, (_, i) => actor(i + 1));
    const back = decodePacket(encodePacket(MessageType.snapshot, { tick: 1, ack: 0, presence: null, players: [], actors: full, counters: [], events: [] }))
      .message as SnapshotMessage;
    expect(back.actors).toHaveLength(MAX_SNAPSHOT_ACTORS);
  });
});
