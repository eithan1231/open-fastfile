// What *happened*, as against what *is*: the short tail a snapshot carries.
//
// Every other field on the wire is state. A snapshot says where everyone stands
// and what health they have, so a client that missed one is repaired by the next
// — which is why `leave` can be a hint and membership the authority. An event is
// not like that: nothing later in the stream mentions it, so a lost one is lost
// for good unless something here resends it.
//
// -- Why a tail and not a reliable message ------------------------------------
//
// There is no reliable channel to put one on. geckos' `reliable` is
// resend-and-dedupe rather than delivery, and it is not on the raw path at all
// (game-server/src/net/server.ts), so a "reliable event" message would be a
// retry with a promise attached. This is the same retry, said out loud: an event
// rides in the snapshot tail, carries a monotonic `id`, and is repeated for as
// long as it is worth repeating. The client keeps the newest id it has seen and
// drops anything at or below it, so a repeat costs bytes and nothing else.
//
// -- The kinds want opposite things, and that is the whole design -------------
//
// A **hit marker** is worth something only immediately. One that arrives late is
// a lie about time, and one that is lost is invisible, because the next round
// fired supersedes it. So it is sent on the tick it happened, to the player who
// fired, and never repeated.
//
// A **death** is a permanent record. A kill feed missing a line is wrong for the
// rest of the match, and no later state repairs it. So it is repeated, to
// everyone, for `KILL_FEED_REPEAT_SECONDS` of snapshots — sixty datagrams'
// redundancy on a fact that costs about twenty bytes, against a marker that gets
// one.
//
// A **spawn** is a death's other half and wants the same retention for the same
// reason, but it is fifty times the size: ninety-odd bytes of initial conditions
// against twenty. So it is repeated too, and capped per tail
// (`MAX_SPAWNS_PER_SNAPSHOT`) where a death is not — seven of them at once would
// be a datagram nobody should send. A **despawn** is the rarest of the four and
// exists for the one case a rule cannot derive.
//
// An **announcement** is a death's argument taken further, and it is the only
// kind a *script* raises. A kill feed line that never arrives is contradicted by
// a scoreboard the player can open; "the enemy has the flag" is contradicted by
// nothing, and a player who missed it is misinformed for the rest of the round.
// So it is repeated for twice a death's window (`ANNOUNCE_REPEAT_SECONDS`), which
// it can afford: announcements are rare where deaths are not, it is the smallest
// event here, and the tail already drops the *oldest* first — so a kind that is
// held longer is the first thing given up under pressure rather than something
// that crowds a death out.
//
// The mechanism is one field; the reliability is the retention, which is
// `Match`'s to set per event.

import { array, bool, enumOf, int, nullable, str, struct, uint, type Codec } from "../codec/schema.js";
import { ragdollSpawn, type RagdollSpawn } from "./entities.js";
import { ENTITY_KINDS, type EntityKindId } from "../../sim/entityKinds.js";
import { DAMAGE_CAUSES, type DamageCause } from "../../game/damage.js";
import { HIT_LOCATIONS, type HitLocation } from "../../sim/hitLocations.js";
import { playerId, type PlayerId } from "./fields.js";

export const GAME_EVENT_KINDS = ["hit", "death", "spawn", "despawn", "announce"] as const;
export type GameEventKind = (typeof GAME_EVENT_KINDS)[number];

/**
 * A round of yours cost somebody health. The server's own answer about its own
 * trace — a client is never told to draw one for a shot it merely thinks landed.
 *
 * Nobody is named: a marker says "that one counted", and who it counted against
 * is the kill feed's business.
 */
export interface HitEvent {
  kind: "hit";
  id: number;
  location: HitLocation;
  /** It was the round that put them down, which is what a different marker is drawn for. */
  lethal: boolean;
}

/**
 * Somebody died. `killer` is null where the world did it — a script, a fall out
 * of the world — and is the victim for their own doing; both are suicides
 * (`isSuicide`). `cause` is how, which is what a line with no killer has to say.
 */
export interface DeathEvent {
  kind: "death";
  id: number;
  victim: PlayerId;
  killer: PlayerId | null;
  cause: DamageCause;
}

/**
 * A physics entity was created, and this is everything needed to create the same
 * one — see entities.ts for why the initial conditions travel rather than being
 * recomputed.
 *
 * Repeated like a death and for the same reason: nothing later in the stream
 * mentions it, and a client that missed the one datagram would have a player
 * standing where everyone else has a body on the floor. It is de-duped twice over
 * — by `id`, like every event, and by `(kind, entity)` inside the physics world,
 * which is the layer that survives a reconnection and stops a repeat re-applying
 * an impulse.
 */
export interface SpawnEvent {
  kind: "spawn";
  id: number;
  /** Unique for the life of a match. `despawn` and any correction name this. */
  entity: number;
  what: EntityKindId;
  /** The tick it was created on, low 16 bits. Its age, and so its step count, is measured from here. */
  tick: number;
  /** The kind's own payload. One kind today; a second is a branch in the codec below. */
  ragdoll: RagdollSpawn;
}

/**
 * One ended before its lifetime did.
 *
 * Not sent for a corpse: a kind's lifetime and its cap are in `ENTITY_POLICY`, so
 * both ends free the same entity on the same tick without being told. This is for
 * the case a rule cannot derive — a grenade that went off early.
 */
export interface DespawnEvent {
  kind: "despawn";
  id: number;
  entity: number;
  tick: number;
}

/**
 * A gametype said something happened. The only event a **script** raises, and
 * the only one whose meaning this file does not know.
 *
 * `what` is a name in that gametype's own vocabulary and never an alias or a
 * file: both ends compile in the same `SCRIPTS`, so the client half of the
 * script that published it is what decides what it sounds like
 * (game/announcement.ts). Broadcast and localised at each end — "we have the
 * flag" and "the enemy has the flag" are one of these, read against the side the
 * reader is on.
 *
 * `team` is an **index into the gametype's `teams`**, as `PlayerState.team` is
 * and for the same reason: three bits against a name's ~48, and both ends
 * already hold the declaration to resolve it. Null is an announcement that
 * belongs to nobody, which is not side 0.
 *
 * `value` is the one number it is about, and **null is not zero** — zero seconds
 * left is a thing a countdown says.
 */
export interface AnnounceEvent {
  kind: "announce";
  id: number;
  what: string;
  team: number | null;
  value: number | null;
  /** The one player it is about, as an id; null for nobody in particular. */
  player: PlayerId | null;
}

/**
 * One thing that happened. `id` counts up for the life of a match and is what a
 * client de-dupes on; `JoinedMessage.eventId` is where its count starts, so a
 * player joining an hour in does not have to wait for the counter to wrap past
 * whatever it had reached.
 */
export type GameEvent = HitEvent | DeathEvent | SpawnEvent | DespawnEvent | AnnounceEvent;

/**
 * How many events one snapshot carries, and the field that counts them.
 *
 * Three bits, because the tail is a tail: a tick with more than seven live
 * events is a grenade in a crowd, and the ones dropped are the oldest, which
 * have already been sent many times over.
 */
const EVENT_COUNT_BITS = 3;
export const MAX_SNAPSHOT_EVENTS = 2 ** EVENT_COUNT_BITS - 1;

const eventKind = enumOf(GAME_EVENT_KINDS);
/** Wraps at 16 bits, and the client's de-dupe compares the way `after` does. */
const eventId = uint(16);
const hitFields = struct({ location: enumOf(HIT_LOCATIONS) as Codec<HitLocation>, lethal: bool });
const deathFields = struct({ victim: playerId, killer: nullable(playerId), cause: enumOf(DAMAGE_CAUSES) as Codec<DamageCause> });
/** 12 bits: a match that produced 4,096 corpses and grenades has other problems. */
const entityId = uint(12);
const spawnFields = struct({ entity: entityId, what: enumOf(ENTITY_KINDS) as Codec<EntityKindId>, tick: uint(16), ragdoll: ragdollSpawn });
const despawnFields = struct({ entity: entityId, tick: uint(16) });

/**
 * How long a name a gametype may publish, in UTF-8 bytes.
 *
 * Five bits of length, so 31: `what` is a **name** and not a message, and the
 * cap is what stops a script paying for a sentence out of a datagram the whole
 * room shares. `Match.publish` refuses a longer one rather than letting the
 * codec throw halfway through encoding a snapshot everybody was waiting for.
 */
const ANNOUNCE_NAME_BITS = 5;
export const MAX_ANNOUNCE_NAME_BYTES = 2 ** ANNOUNCE_NAME_BITS - 1;

/** What `value` may be: a signed 16-bit integer. A fraction is the wrong question to ask an announcement. */
const ANNOUNCE_VALUE_BITS = 16;
export const MIN_ANNOUNCE_VALUE = -(2 ** (ANNOUNCE_VALUE_BITS - 1));
export const MAX_ANNOUNCE_VALUE = 2 ** (ANNOUNCE_VALUE_BITS - 1) - 1;

/** Three bits of side, as `PlayerState.team` is: a gametype with nine teams is not a gametype. */
const announceFields = struct({
  what: str(ANNOUNCE_NAME_BITS),
  team: nullable(uint(3)),
  value: nullable(int(ANNOUNCE_VALUE_BITS)),
  player: nullable(playerId),
});

/**
 * How many spawns one snapshot's tail may carry.
 *
 * A spawn is about 95 bytes, nearly all of it sixteen rotations. Seven of them
 * would be a 665-byte tail on top of a twelve-player snapshot's ~767, which is past
 * what a datagram should be asked to hold. They are repeated for half a second
 * anyway, so the rest ride the next ticks and nobody waits.
 */
export const MAX_SPAWNS_PER_SNAPSHOT = 2;

/**
 * Hand-written rather than a `union` combinator, because two cases do not make a
 * mechanism: the kind and the id are common, and each case then writes its own
 * fields in its own order. A third kind is four lines here.
 */
export const gameEvent: Codec<GameEvent> = {
  write(w, event) {
    eventKind.write(w, event.kind);
    eventId.write(w, event.id);
    switch (event.kind) {
      case "hit":
        hitFields.write(w, event);
        return;
      case "death":
        deathFields.write(w, event);
        return;
      case "spawn":
        spawnFields.write(w, event);
        return;
      case "despawn":
        despawnFields.write(w, event);
        return;
      case "announce":
        announceFields.write(w, event);
        return;
    }
  },
  read(r) {
    const kind = eventKind.read(r);
    const id = eventId.read(r);
    switch (kind) {
      case "hit":
        return { kind, id, ...hitFields.read(r) };
      case "death":
        return { kind, id, ...deathFields.read(r) };
      case "spawn":
        return { kind, id, ...spawnFields.read(r) };
      case "despawn":
        return { kind, id, ...despawnFields.read(r) };
      case "announce":
        return { kind, id, ...announceFields.read(r) };
    }
  },
};

export const gameEvents = array(gameEvent, EVENT_COUNT_BITS);
