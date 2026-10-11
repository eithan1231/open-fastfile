// What each client has still to be told: events with an id, a recipient and a
// retention, riding the snapshot tail until they expire. And the one source of
// them a script controls, `publish`.

import {
  MAX_ANNOUNCE_NAME_BYTES,
  MAX_ANNOUNCE_VALUE,
  MAX_SNAPSHOT_EVENTS,
  MAX_SPAWNS_PER_SNAPSHOT,
  MIN_ANNOUNCE_VALUE,
  type AnnounceEvent,
  type DeathEvent,
  type GameEvent,
  type HitEvent,
  type SpawnEvent,
} from "@3d/shared/net/messages/events.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { Announcement } from "@3d/shared/game/announcement.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { MatchClock } from "./clock.js";

/**
 * How long a death keeps riding in the snapshot tail, seconds.
 *
 * A kill feed line that never arrives is a permanent lie about the match, and
 * there is no reliable channel to put one on (net/messages/events.ts). Half a
 * second is thirty datagrams' redundancy at 60 Hz: a burst loss longer than that
 * is a connection that has already stopped being playable. A hit marker is
 * retained for nothing at all, which is the other half of that decision.
 */
export const KILL_FEED_REPEAT_SECONDS = 0.5;

/**
 * How long an announcement keeps riding in the snapshot tail, seconds.
 *
 * Twice a death's, because the two failures are not the same size: a kill feed
 * line that never arrives is contradicted by a scoreboard the player can open,
 * and "the enemy has the flag" is contradicted by nothing — a player who missed
 * it is misinformed for the rest of the round. It costs almost nothing to say so:
 * an announcement is a handful of bytes, and they are rare where deaths are not.
 */
const ANNOUNCE_REPEAT_SECONDS = 1;

/**
 * How many announcements one tick may raise before it is a script in a loop.
 *
 * The tail carries seven events of every kind together, so a script publishing
 * per tick per player is a snapshot with nothing in it but chatter. Dropped and
 * said out loud rather than thrown, unlike a runaway `damage()`: a flood is not a
 * wrong answer the way an unanswerable hit is, and a throw here would take every
 * other game on this process's tick with it.
 */
const MAX_ANNOUNCEMENTS_PER_TICK = 8;

/** One encoder, to measure a published name against the field that has to carry it. */
const NAME_BYTES = new TextEncoder();

/** An event before the outbox has numbered it. */
type UnissuedEvent = Omit<HitEvent, "id"> | Omit<DeathEvent, "id"> | Omit<SpawnEvent, "id"> | Omit<AnnounceEvent, "id">;

/**
 * An event waiting to go out, with the last tick it may ride on and who is to
 * hear it (null: everybody).
 *
 * Retention is per event rather than per kind because it is the only thing that
 * differs between them: a hit marker lives for the tick it happened on, a death
 * for `KILL_FEED_REPEAT_SECONDS` of them.
 */
interface Outgoing {
  event: GameEvent;
  to: PlayerId | null;
  until: number;
  /** Held for no longer than the tick it happened on, so this tick's tail is its only one. */
  once: boolean;
}

export class EventOutbox {
  private readonly held: Outgoing[] = [];
  /**
   * The last event id issued, counting up for the life of this match and
   * wrapping at 16 bits.
   *
   * Never per recipient: a client de-dupes by the ids it has taken and starts
   * from the counter `joined` gave it, which only works while there is one
   * counter. An event addressed to one player is a gap in everyone else's.
   */
  private lastId = 0;

  constructor(private readonly clock: MatchClock) {}

  /** The event counter as it stands: where a joining player's de-dupe starts. Everything they are told about is above it. */
  get cursor(): number {
    return this.lastId;
  }

  /**
   * Put an event in the outbox, to ride on the next snapshot and on the ones up
   * to `hold` seconds later. The id is issued here and nowhere else.
   */
  push(event: UnissuedEvent, to: PlayerId | null, hold: number): void {
    this.lastId = (this.lastId + 1) & 0xffff;
    const ticks = this.clock.ticks(hold);
    this.held.push({ event: { ...event, id: this.lastId } as GameEvent, to, until: this.clock.tick + ticks, once: ticks === 0 });
  }

  /** Drop what has outlived its retention: once, by the clock, and not once per player who has been sent it. */
  expire(): void {
    for (let i = this.held.length - 1; i >= 0; i--) {
      if (this.held[i]!.until < this.clock.tick) {
        this.held.splice(i, 1);
      }
    }
  }

  /**
   * What rides in `id`'s tail this tick, in the order it was issued: everything
   * they have still to hear, where that fits.
   *
   * Where it does not, what is held **takes turns**. An event that lives for this
   * tick alone goes first, newest first, because no later tail will carry it. The
   * retained ones then fill what is left starting from a different one each tick,
   * so each leads a tail once in as many ticks as there are of them — a few ticks
   * of a retention that is thirty or more. Nothing is kept per recipient: the
   * turn is the clock's, and the client takes ids in any order.
   */
  for(id: PlayerId): GameEvent[] {
    const mine = this.held.filter((held) => held.to === null || held.to === id);
    if (mine.length === 0) {
      return []; // nearly every tick
    }
    const riding = new Set<Outgoing>();
    for (let i = mine.length - 1; i >= 0 && riding.size < MAX_SNAPSHOT_EVENTS; i--) {
      if (mine[i]!.once) {
        riding.add(mine[i]!);
      }
    }

    // Spawns are capped separately. One is a hundred bytes against a death's
    // twenty, nearly all of it the sixteen rotations a corpse starts from, so
    // seven of them would be a tail worth more than the snapshot it rides on.
    const retained = mine.filter((held) => !held.once);
    let spawns = 0;
    for (let i = 0; i < retained.length && riding.size < MAX_SNAPSHOT_EVENTS; i++) {
      const held = retained[(this.clock.tick + i) % retained.length]!;
      if (held.event.kind === "spawn" && ++spawns > MAX_SPAWNS_PER_SNAPSHOT) {
        continue;
      }
      riding.add(held);
    }
    return mine.filter((held) => riding.has(held)).map((held) => held.event);
  }
}

/** What scripts published, checked and capped on its way into the outbox. */
export class Announcements {
  /** Everything published this tick, cleared at the top of the next: what a test and a diagnostic read. */
  readonly thisTick: Announcement[] = [];
  /** The tick a flood was last complained about, so it is said once per tick. */
  private floodedTick = -1;

  constructor(
    private readonly clock: MatchClock,
    private readonly gametype: GametypeDecl,
    private readonly outbox: EventOutbox,
    private readonly inMatch: (id: PlayerId) => boolean,
  ) {}

  clear(): void {
    this.thisTick.length = 0;
  }

  /**
   * What a script said happened, on its way to every client.
   *
   * **Checked here rather than at the codec**, because a `str(5)` that threw
   * would do it halfway through encoding a snapshot the whole room was waiting
   * for. A malformed announcement throws where the script asked for it — a
   * countdown that said nothing, or said it about the wrong side, is a wrong
   * answer nothing would report.
   *
   * The side becomes an **index** into the gametype's `teams`, as
   * `PlayerState.team` does, and undefined stays null rather than becoming side 0.
   */
  publish(event: Announcement): void {
    const bytes = NAME_BYTES.encode(event.what).length;
    if (bytes === 0 || bytes > MAX_ANNOUNCE_NAME_BYTES) {
      throw new Error(`publish() wants a name of 1..${MAX_ANNOUNCE_NAME_BYTES} bytes, not ${bytes}: "${event.what}"`);
    }
    if (event.value !== undefined && (!Number.isInteger(event.value) || event.value < MIN_ANNOUNCE_VALUE || event.value > MAX_ANNOUNCE_VALUE)) {
      throw new Error(`publish() wants an integer in ${MIN_ANNOUNCE_VALUE}..${MAX_ANNOUNCE_VALUE}, not ${event.value}`);
    }
    const side = event.team === undefined ? null : this.gametype.teams.indexOf(event.team);
    if (side !== null && side < 0) {
      throw new Error(`publish() named side "${event.team}", which ${this.gametype.id} does not have`);
    }
    if (event.player !== undefined && !this.inMatch(event.player)) {
      throw new Error(`publish() named player "${event.player}", who is not in this match`);
    }

    if (this.thisTick.length >= MAX_ANNOUNCEMENTS_PER_TICK) {
      // Once per tick, not once per event dropped: a flood that logs per event is
      // a second flood. `thisTick` holds what actually went out, so a test and a
      // diagnostic see the cap rather than being told about it.
      if (this.floodedTick !== this.clock.tick) {
        this.floodedTick = this.clock.tick;
        console.warn(`[match] a script published more than ${MAX_ANNOUNCEMENTS_PER_TICK} announcements in one tick; dropping the rest`);
      }
      return;
    }
    this.thisTick.push(event);
    this.outbox.push(
      { kind: "announce", what: event.what, team: side, value: event.value ?? null, player: event.player ?? null },
      null,
      ANNOUNCE_REPEAT_SECONDS,
    );
  }
}
