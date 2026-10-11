// Server → clients, every tick: the authoritative state of everyone.

import { array, int, nullable, struct, uint, type Codec } from "../codec/schema.js";
import { MATCH_VALUE_MAX, MAX_COUNTERS } from "../../game/matchValues.js";
import type { PlayerState } from "../../sim/player.js";
import type { ActorState } from "../../game/actors/actor.js";
import { actorStateSchema } from "./actors.js";
import { gameEvents, type GameEvent } from "./events.js";
import { playerId, type PlayerId } from "./fields.js";
import { playerStateSchema } from "./player.js";

/** The server's verdict on one player. */
export interface PlayerSnapshot {
  id: PlayerId;
  state: PlayerState;
}

/**
 * Which of the world's solids are present (worlds/presence.ts), as state: sent
 * whole on every snapshot of a world that has any, so a late joiner and a lost
 * datagram converge on the next one. It is a few bytes — one bit per solid —
 * against a player's eighty-odd, which is cheaper than the bookkeeping of sending it
 * only when it changes.
 */
export interface SnapshotPresence {
  /**
   * The low 16 bits of the tick the bits last changed on. A change is applied
   * after that tick's physics step, so a client stepping its own physics applies
   * it at the same point rather than whenever the datagram happened to land.
   */
  since: number;
  /** One bit per solid in `ResolvedWorld.solids` order, bit `i & 7` of byte `i >> 3`. */
  bits: number[];
}

/** Ten bits of length: 8,184 solids, against a zombies map's few dozen. */
const snapshotPresence = struct({ since: uint(16), bits: array(uint(8), 10) }) satisfies Codec<SnapshotPresence>;

/**
 * One authoritative tick. `ack` is the last `InputMessage.seq` this server had
 * applied for the receiving player, which is what tells that client how far to
 * rewind before replaying.
 *
 * `players` is the same list for everyone; `ack` and `events` are the receiving
 * player's own (`Match.snapshotFor`). A hit marker is addressed to whoever fired
 * the round, and nobody else is told about it at all.
 */
export interface SnapshotMessage {
  tick: number;
  ack: number;
  /** Null for a world with no solids: one bit. */
  presence: SnapshotPresence | null;
  players: PlayerSnapshot[];
  /**
   * The actors this player is told about: every one, or past
   * `MAX_SNAPSHOT_ACTORS` the ones nearest them. Appearing is a spawn and
   * disappearing a despawn — there is no other message for either.
   */
  actors: ActorState[];
  /**
   * The gametype's counters (`GametypeDecl.counters`), values only and in its
   * order: both ends hold the declaration that names them. Empty for a gametype
   * with none, which costs four bits.
   */
  counters: number[];
  events: GameEvent[];
}

/** A counter: a signed 24-bit integer (game/matchValues.ts). */
const counterValue = int(Math.log2(MATCH_VALUE_MAX + 1) + 1);
/**
 * Four bits of count, `MAX_COUNTERS`. Four and not three because a player's purse
 * is twenty: the two together are three whole bytes, so what follows — the event
 * tail — starts on the boundary it always did, and costs what it always cost.
 */
const COUNTER_COUNT_BITS = Math.log2(MAX_COUNTERS + 1);

export const snapshotMessage = struct({
  tick: uint(32),
  ack: uint(16),
  presence: nullable(snapshotPresence),
  // Every field of every player, every tick. A delta against the last snapshot a
  // client acked is the obvious next compression, and drops in here as a changed-
  // field bitmask without disturbing anything else.
  players: array(struct({ id: playerId, state: playerStateSchema })),
  // Eight bits of count, so a snapshot with none grows by exactly one byte.
  actors: array(actorStateSchema, 8),
  counters: array(counterValue, COUNTER_COUNT_BITS),
  // Last, and usually empty: three bits on a quiet tick. This is the only place
  // on the wire where something that *happened* can arrive, so it is also the
  // only field a lost datagram loses for good — hence the repeats and the
  // monotonic id that makes them harmless (messages/events.ts).
  events: gameEvents,
}) satisfies Codec<SnapshotMessage>;
