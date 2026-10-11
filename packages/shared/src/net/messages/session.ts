// Getting into a match: the messages either end repeats until the other answers.
//
// These are together because they are two exchanges — a client asks to join and
// is admitted or refused, then asks for a class and is told what became of it —
// and because none of them is on the hot path that the rest of this folder
// exists to make small. Nothing says a player has gone: a snapshot that no
// longer carries them does.

import { bool, enumOf, str, struct, uint, type Codec } from "../codec/schema.js";
import { CLASS_TIMINGS, type ClassTiming } from "../../game/classes.js";
import { MAX_HEALTH } from "../../sim/player.js";
import { playerId, type PlayerId } from "./fields.js";

export interface JoinMessage {
  /**
   * Plain `number`, not the literal PROTOCOL_VERSION: a join from a client built
   * against a different version legitimately carries a different one, and
   * refusing it is the point. Compare against PROTOCOL_VERSION rather than
   * trusting the type.
   *
   * First on the wire so a mismatch is as readable as it can be — though only
   * just: a client on an older layout produces a length prefix this one reads as
   * garbage, so decodePacket throws before anything gets to look at this field.
   */
  protocol: number;
  /** Which game on this instance. One process hosts several. */
  gameId: string;
  /** Who the api said this player is. Not the socket's id: this one survives a reconnect. */
  playerId: PlayerId;
  /** Proof that the api put this player on that game's roster. */
  authorizationKey: string;
  /**
   * `WeaponRegistry.hash`, the digest of the weapon catalogue this client
   * fetched. It rides beside `protocol` because it does the same job for a
   * faster-moving thing: a snapshot names a weapon by its index in that
   * catalogue, so two ends holding different ones put the wrong gun in
   * everybody's hands, silently. Adding a weapon changes this; it does not
   * change the protocol.
   */
  catalogHash: string;
  /**
   * `worldHash` of the world this client loaded (worlds/hash.ts). Entity ids and
   * the snapshot's presence bits are positions in that world, so two ends
   * holding different text would address different things by the same number.
   * Refused on a mismatch, as a catalogue is.
   */
  worldHash: string;
  /**
   * Which JavaScript engine this client predicts in — "chrome", "firefox", and
   * so on, or "" where it will not say.
   *
   * Recorded beside the drift it explains, and never acted on. `Math.sin` and
   * `Math.exp` are implementation-defined, so two browsers running identical
   * inputs through identical code land microscopically apart; the server is
   * authoritative and a hit box is computed here alone, so it costs nothing —
   * but a systematic drift on one browser and not another is otherwise a ghost
   * somebody will chase for a day. See `DriftReport`.
   */
  engine: string;
}

export const joinMessage = struct({
  protocol: uint(8),
  gameId: str(),
  playerId,
  authorizationKey: str(),
  catalogHash: str(),
  worldHash: str(8),
  /** A short name, capped: this is a label for a diagnostic, not something to parse. */
  engine: str(5),
}) satisfies Codec<JoinMessage>;

/**
 * The part of a match's `CombatRules` (game/rules.ts) a client acts on. The rest
 * are the server's alone to apply, so they do not travel.
 */
export interface JoinedRules {
  /** What a snapshot's `health` is out of: without it a client cannot draw a health bar at all. */
  maxHealth: number;
  /** Whether a death counts down to a respawn (`CombatRules.respawnDelay`). False: the gametype brings the dead back itself. */
  timedRespawn: boolean;
}

export interface JoinedMessage {
  /** The server's fixed tick, in hertz. A client accumulates dt to match it. */
  tickRate: number;
  /**
   * The rules being played, as an id in `GAMETYPES`.
   *
   * Here rather than derived from the world, because a world no longer says: the
   * lobby chose it and the authority put it in the game order. The client needs it
   * for two things it cannot otherwise get right — resolving `PlayerState.team`'s
   * index into a name, and asking `castFor` what a player of that side wears. Both
   * ends must reach the same answer from the same gametype, or a peer's body is not
   * the body the server is tracing bullets against.
   */
  gametype: string;
  /**
   * Sent rather than derived, for the reason `gametype` is: the numbers come from
   * a script's `combatRules`, and a client has no way to reach the answer that
   * this particular server reached. Sent **once**, because they do not change
   * during a match.
   */
  rules: JoinedRules;
  /**
   * The match's event counter as this player joined (net/messages/events.ts).
   *
   * Where their de-dupe starts, and it has to be told rather than guessed: a
   * player joining an hour in would otherwise read a counter already past 32768
   * as an id older than the nothing they have seen, and ignore every event until
   * it wrapped. It also settles what a snapshot's retained deaths mean on the
   * first tick — they happened before this player was here.
   */
  eventId: number;
  /**
   * Whether this player is already in the match — a reconnect, a reload of a tab
   * that was playing, or a gametype with no classes to choose. False is the
   * usual answer: a player is admitted, then chooses a class (`chooseClass`),
   * and only then spawns.
   */
  spawned: boolean;
  /**
   * Whether players here choose from their own classes (`ClassRules.customClasses`).
   * False takes the class menu away: they spawn on joining, armed by the gametype.
   */
  classes: boolean;
}

export const joinedMessage = struct({
  tickRate: uint(8),
  gametype: str(),
  // The width of a snapshot's own health field, which is what fixes its ceiling.
  rules: struct({ maxHealth: uint(Math.log2(MAX_HEALTH + 1)), timedRespawn: bool }) satisfies Codec<JoinedRules>,
  eventId: uint(16),
  spawned: bool,
  classes: bool,
}) satisfies Codec<JoinedMessage>;

/**
 * The class to play, by its index among the player's classes as the game order
 * carries them — never by content, so what a player carries is always a class
 * the api stored for them.
 *
 * Before a player has spawned it spawns them. After, the gametype decides when
 * it takes effect — at once, at their next spawn, or not at all (`ClassRules`,
 * and the `classChoice` hook) — and that is the server's rule, not the menu's.
 * Re-sent until `classChosen` answers, like `join`.
 */
export interface ChooseClassMessage {
  index: number;
}

/** Three bits: LOADOUT_COUNT is five. */
export const chooseClassMessage = struct({ index: uint(3) }) satisfies Codec<ChooseClassMessage>;

/** The answer to `chooseClass`: which class, and what became of it — in their hands, waiting for their next spawn, or refused. */
export interface ClassChosenMessage {
  index: number;
  timing: ClassTiming;
}

export const classChosenMessage = struct({ index: uint(3), timing: enumOf(CLASS_TIMINGS) as Codec<ClassTiming> }) satisfies Codec<ClassChosenMessage>;

/**
 * The join will not be answered, and why. Costs one datagram and saves the
 * client a ten-second silence it cannot tell from a dead network — a bad key, a
 * full game and an unknown game all look identical without it.
 */
export interface RefusedMessage {
  reason: string;
}

export const refusedMessage = struct({ reason: str() }) satisfies Codec<RefusedMessage>;
