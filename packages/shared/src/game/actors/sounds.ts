// What an actor sounds like: which of its kind's sound roles two snapshots of it
// mean, and when it next makes a noise of its own.
//
// The deciding half, as `sim/footsteps.ts` is for a player's boots: pure and
// derived from the state the wire already carries, so an actor's sound costs no
// wire (docs/engine/audio.md#diegetic-sound-costs-no-wire). The browser's half —
// which alias, which bank, where — is `client/src/engine/audio/actors.ts`.
//
// A kind declares its roles as aliases (`ActorKindDef.sounds`); what each role
// *means* is here, once, for every kind.

import type { GameKey } from "../../dsl/resolved.js";
import { hashString, seeded } from "../random.js";
import type { ActorId, ActorState } from "./actor.js";

/**
 * What an actor can sound like, by what it is doing.
 *
 * - `spawn`: it arrived in the match (a new id), once, where it stands;
 * - `ambient`, `sprint`: the noise it makes on its own while alive, every few
 *   seconds — `sprint` for a runner or a sprinter, `ambient` otherwise;
 * - `attack`: its voice as a swing begins;
 * - `swing`: the swing itself, as it begins;
 * - `death`: as it starts to fall.
 */
export const ACTOR_SOUND_ROLES = ["spawn", "ambient", "sprint", "attack", "swing", "death"] as const;
export type ActorSoundRole = (typeof ACTOR_SOUND_ROLES)[number];

/** A kind's sounds: its roles as aliases, in one game's catalogue bank. */
export interface ActorSounds {
  /**
   * The game whose catalogue bank holds the aliases. Named rather than taken from
   * the world, because a kind is spawned wherever a script puts it: one game's
   * zombie on another game's map still sounds like itself.
   */
  readonly game: GameKey;
  /** A role left out makes no sound. */
  readonly aliases: Partial<Record<ActorSoundRole, string>>;
}

/**
 * The shortest and longest gaps, in seconds, between one actor's own noises.
 *
 * This engine's choice, not a game's: CoD's vocals are driven by script loops
 * and animation notetracks the engine does not play yet. Long enough that a
 * horde of twenty-four is a murmur rather than a wall, short enough that one
 * walker in a corridor is heard before it is seen.
 */
export const VOCAL_GAP: readonly [number, number] = [3, 8];

/**
 * The one-shot roles between two snapshots of one actor, in the order to play them.
 *
 * `before` undefined is an actor seen for the first time, which is a spawn only
 * when the caller says so (`spawned`): an id appearing is also somebody joining a
 * match already in progress, or an actor coming back into the nearest-64 window,
 * and neither of those is an arrival.
 *
 * A swing is new when the action turns to `attack`, or when its phase starts
 * over while it stays there (a second swing at the same target).
 */
export function actorSoundsBetween(before: ActorState | undefined, after: ActorState, spawned = false): ActorSoundRole[] {
  if (before === undefined) {
    return spawned && after.action !== "die" ? ["spawn"] : [];
  }
  const out: ActorSoundRole[] = [];
  if (after.action === "attack" && (before.action !== "attack" || after.phase < before.phase)) {
    out.push("attack", "swing");
  }
  if (after.action === "die" && before.action !== "die") {
    out.push("death");
  }
  return out;
}

/** The noise a living actor makes on its own: its gait's, or none once it is dead. */
export function vocalRole(state: ActorState): ActorSoundRole | undefined {
  if (state.action === "die") {
    return undefined;
  }
  return state.gait === "walk" ? "ambient" : "sprint";
}

/**
 * Seconds from one actor's `count`th noise of its own to the next, in `VOCAL_GAP`.
 *
 * Drawn from the id and the count, so a horde spawned together does not moan in
 * unison, and without an ambient random: `game/` may not use one.
 */
export function vocalGap(id: ActorId, count: number): number {
  const [lo, hi] = VOCAL_GAP;
  const rng = seeded(hashString(`vocal:${id}:${count}`));
  rng(); // the first draw from neighbouring ids' hashes is correlated (assets.ts, `avalanche`)
  return lo + (hi - lo) * rng();
}
