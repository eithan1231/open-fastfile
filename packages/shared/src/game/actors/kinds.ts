// What an actor is, per kind, as data.
//
// An actor is a server-run creature that is not a player: no class, no weapon,
// no prediction, and a dozen bytes on the wire rather than a `PlayerState`
// (docs/engine/actors.md). What makes a zombie a zombie and a dog a dog is a row
// here — its capsule, its speeds, its health and its blow — and the brain a
// script names when it spawns one.
//
// **A kind's index is on the wire** (`ActorState.kind`), so the table is append
// only, like `DAMAGE_CAUSES`: both ends compile it in, and reordering it would
// draw every zombie as whatever took its place.

import type { GameKey } from "../../dsl/resolved.js";
import { SLOPE_NORMAL_Y } from "../../sim/capsule.js";
import type { MovementParams } from "../../sim/movement.js";
import type { ActorSounds } from "./sounds.js";

/** A kind's name, as a script spawns one by. */
export type ActorKindId = string;

/** A blow: what it costs, how far it reaches and how often it may land. */
export interface ActorMelee {
  /** Health it takes off a player per hit, before `playerDamage` has its say. */
  readonly damage: number;
  /** Metres, horizontally, from the actor's feet to its target's. A target within it can be hit. */
  readonly reach: number;
  /** Seconds from one swing's start to the next's, at least. A clip's own length is a floor under it. */
  readonly cooldown: number;
  /**
   * Seconds a swing lasts for a kind with no attack clip, the blow landing as it
   * starts. One with a clip swings for the clip's length and lands on its `fire` notes.
   */
  readonly swing: number;
}

/**
 * The catalogue creature a kind is drawn and shot as: `catalog/actors/<game>/<id>/`,
 * which holds its bodies, heads, clip set and boxes (`actorAssetsFor`).
 */
export interface ActorBodyRef {
  readonly game: GameKey;
  readonly id: string;
}

export interface ActorKindDef extends MovementParams {
  readonly id: ActorKindId;
  /** Health at spawn, unless the spawn says otherwise (`ActorSpec.health`). */
  readonly health: number;
  readonly melee: ActorMelee;
  /** Seconds a dead one lies before it is taken out of the match, and at least as long as its fall. */
  readonly corpse: number;
  /**
   * Optional: a kind with none, or whose entry the catalogue lacks, is drawn as its
   * capsule and shot as an upright box, moving at `walkSpeed`/`runSpeed`. One with
   * a body moves at its gait clip's root-motion speed instead.
   */
  readonly body?: ActorBodyRef;
  /** What it sounds like, as roles mapped to one game's aliases (`sounds.ts`). Absent: silent. */
  readonly sounds?: ActorSounds;
}

/**
 * A Call of Duty zombie's voice and body, by role: the names both Black Ops games
 * give them, each in its own game's bank. `zmb_attack_whoosh` is the swing, and
 * `zmb_zombie_spawn` the dirt of one clawing out of the ground.
 */
function zombieSounds(game: GameKey): ActorSounds {
  return {
    game,
    aliases: {
      spawn: "zmb_zombie_spawn",
      ambient: "zmb_vocals_zombie_ambience",
      sprint: "zmb_vocals_zombie_sprint",
      attack: "zmb_vocals_zombie_attack",
      swing: "zmb_attack_whoosh",
      death: "zmb_vocals_zombie_death",
    },
  };
}

/**
 * A human-sized walker: Kino der Toten's honour guard. Narrower than a player
 * and than the entry's 0.41 m by 1.83 m box: the game's links pass close enough
 * to walls that a body as wide as either rubs along them, and a walker has no
 * speed to rub through with. Health is the aitype's 150, which a gametype
 * prices per round (`ActorSpec.health`); the blow's numbers are placeholders.
 */
export const ZOMBIE_KIND: ActorKindDef = {
  id: "zombie",
  radius: 0.3,
  height: 1.7,
  walkSpeed: 1.2,
  runSpeed: 2.8,
  // A walker has no speed to carry it up a bank a player takes at a run, so it treads one.
  footing: SLOPE_NORMAL_Y,
  health: 150,
  melee: { damage: 50, reach: 1, cooldown: 1, swing: 0.6 },
  corpse: 2,
  body: { game: "t5", id: "zombie_ger" },
  sounds: zombieSounds("t5"),
};

/**
 * TranZit's walker: Black Ops II's `zm_transit_basic`, ten bodies and four heads.
 * Kino's zombie in every number — the player's capsule for the same reason, the
 * same 150 at spawn (both games' `zombiemode.csv` MEDIUM row, reverse/t6-zombies § 5) and the
 * same placeholder blow — and its own game's creature and sounds.
 */
export const TRANSIT_ZOMBIE_KIND: ActorKindDef = {
  ...ZOMBIE_KIND,
  id: "zombie_transit",
  body: { game: "t6", id: "zm_transit_basic" },
  sounds: zombieSounds("t6"),
};

/** Every kind, in wire order: **append only**. */
export const ACTOR_KINDS: readonly ActorKindDef[] = [ZOMBIE_KIND, TRANSIT_ZOMBIE_KIND];

/** Kinds a wire index can name. Sixteen: four bits. */
export const MAX_ACTOR_KINDS = 16;

/** The kind with this id, or undefined. */
export function actorKind(id: ActorKindId): ActorKindDef | undefined {
  return ACTOR_KINDS.find((kind) => kind.id === id);
}

/** Where a kind is in `ACTOR_KINDS`, which is what the wire carries; -1 for none. */
export function actorKindIndex(id: ActorKindId): number {
  return ACTOR_KINDS.findIndex((kind) => kind.id === id);
}
