// The snapshot tail under load: that a tick with more to say than a tail holds
// still tells every client everything, inside each event's retention.
//
// A tail is seven events and two spawns. One grenade in a crowd is more than
// that, and what does not fit has to ride a later tail rather than be the same
// seven for half a second while the rest expire unsent. A client takes ids in
// any order, so the stand-in for one here is a set.

import { describe, expect, it } from "vitest";
import { MAX_SNAPSHOT_EVENTS, MAX_SPAWNS_PER_SNAPSHOT, type GameEvent } from "@3d/shared/net/messages/events.js";
import type { SnapshotMessage } from "@3d/shared/net/messages/snapshot.js";
import { decodePacket, encodePacket, MessageType } from "@3d/shared/net/packet.js";
import { RAGDOLL_SEGMENTS } from "@3d/shared/sim/ragdollBones.js";
import { MatchClock } from "../src/match/clock.js";
import { EventOutbox, KILL_FEED_REPEAT_SECONDS } from "../src/match/outbox.js";

const TICK_RATE = 60;
const SHOOTER = "shooter1";
const WATCHER = "watcher1";

function outbox() {
  const clock = new MatchClock(TICK_RATE);
  const box = new EventOutbox(clock);
  const tick = () => {
    clock.tick++;
    box.expire();
  };
  const hit = (lethal: boolean) => box.push({ kind: "hit", lethal }, SHOOTER, 0);
  const death = (victim: string) => box.push({ kind: "death", victim, killer: SHOOTER, cause: "bullet" }, null, KILL_FEED_REPEAT_SECONDS);
  const spawn = (entity: number, victim: string) =>
    box.push(
      {
        kind: "spawn",
        entity,
        what: "ragdoll",
        tick: clock.tick & 0xffff,
        ragdoll: {
          victim,
          origin: { x: 1, y: 2, z: 3 },
          rotations: RAGDOLL_SEGMENTS.map(() => ({ x: 0, y: 0, z: 0, w: 1 })),
          velocity: { x: 0, y: 0, z: 0 },
          knock: { x: 0, y: 0, z: 0 },
          segment: 0,
          impulse: { x: 0, y: 0, z: 0 },
        },
      },
      null,
      KILL_FEED_REPEAT_SECONDS,
    );
  return { clock, box, tick, hit, death, spawn };
}

const kinds = (events: readonly GameEvent[], kind: GameEvent["kind"]) => events.filter((event) => event.kind === kind);

describe("a tail with more to say than it holds", () => {
  it("carries three kills on one tick whole: every marker, every death, in the order they were issued", () => {
    const { box, tick, hit, death } = outbox();
    tick();
    for (const victim of ["victim01", "victim02", "victim03"]) {
      hit(true);
      death(victim);
    }

    const tail = box.for(SHOOTER);
    expect(kinds(tail, "hit")).toHaveLength(3);
    expect(kinds(tail, "death")).toHaveLength(3);
    expect(tail.map((event) => event.id)).toEqual([1, 2, 3, 4, 5, 6]);
    // A marker is the shooter's alone; the deaths are everybody's.
    expect(box.for(WATCHER).map((event) => event.id)).toEqual([2, 4, 6]);

    // And the next tick has let the markers go and still repeats the deaths.
    tick();
    expect(box.for(SHOOTER).map((event) => event.id)).toEqual([2, 4, 6]);
  });

  it("gives a marker its one tick ahead of anything a later tail will repeat", () => {
    const { box, tick, hit, death } = outbox();
    tick();
    for (let i = 0; i < 9; i++) {
      death(`victim${i}0`);
    }
    for (let i = 0; i < 4; i++) {
      hit(false);
    }
    const tail = box.for(SHOOTER);
    expect(tail).toHaveLength(MAX_SNAPSHOT_EVENTS);
    expect(kinds(tail, "hit")).toHaveLength(4);
  });

  it("tells everyone everything inside its retention, never more than a tail's worth at once", () => {
    const { clock, box, tick, hit, death, spawn } = outbox();
    tick();
    for (let i = 0; i < 10; i++) {
      death(`victim${i}0`);
    }
    for (let i = 0; i < 3; i++) {
      spawn(i + 1, `victim${i}0`);
    }
    for (let i = 0; i < 4; i++) {
      hit(i === 0);
    }
    const issued = box.cursor;
    expect(issued).toBe(17);

    const heard = { [SHOOTER]: new Set<number>(), [WATCHER]: new Set<number>() };
    const full = new Map<string, number>();
    const quiet: SnapshotMessage = { tick: 1, ack: 0, presence: null, players: [], actors: [], counters: [], events: [] };
    for (let i = 0; i < clock.ticks(KILL_FEED_REPEAT_SECONDS); i++) {
      for (const id of [SHOOTER, WATCHER] as const) {
        const tail = box.for(id);
        expect(tail.length).toBeLessThanOrEqual(MAX_SNAPSHOT_EVENTS);
        expect(kinds(tail, "spawn").length).toBeLessThanOrEqual(MAX_SPAWNS_PER_SNAPSHOT);
        // The codec is the edge that throws: an eighth event would do it here.
        const sent = decodePacket(encodePacket(MessageType.snapshot, { ...quiet, events: tail })).message as SnapshotMessage;
        for (const event of sent.events) {
          heard[id].add(event.id);
        }
        const wanted = id === SHOOTER ? issued : issued - 4;
        if (heard[id].size === wanted && !full.has(id)) {
          full.set(id, i + 1);
        }
      }
      tick();
    }

    expect(heard[SHOOTER].size).toBe(17);
    expect(heard[WATCHER].size).toBe(13);
    // Thirteen retained events take turns leading a tail, so a client that lost
    // nothing has them all in thirteen ticks of the thirty they are held for.
    expect(full.get(SHOOTER)).toBeLessThanOrEqual(13);
    expect(full.get(WATCHER)).toBeLessThanOrEqual(13);
  });

  it("still tells a client that loses every other datagram", () => {
    const { clock, box, tick, death, spawn } = outbox();
    tick();
    for (let i = 0; i < 12; i++) {
      death(`victim${i}0`);
    }
    for (let i = 0; i < 4; i++) {
      spawn(i + 1, `victim${i}0`);
    }

    const heard = new Set<number>();
    for (let i = 0; i < clock.ticks(KILL_FEED_REPEAT_SECONDS); i++) {
      const tail = box.for(WATCHER);
      if (i % 2 === 0) {
        for (const event of tail) {
          heard.add(event.id);
        }
      }
      tick();
    }
    expect(heard.size).toBe(16);
  });
});
