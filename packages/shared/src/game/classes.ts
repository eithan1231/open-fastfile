// Who may choose a class in a match, and when a choice takes effect: the numbers a
// gametype sets, and the shapes its scripts use to arm somebody themselves.
//
// The split `rules.ts` already has. The engine owns the mechanism — the game
// server holds a choice, applies it at a spawn or at once, and tells the client
// which (`classChosen`) — and a script owns the policy, through `classRules` once
// at match start, the `classChoice` hook per request, and three verbs on
// `ServerContext`. Nothing here runs; it is what both ends agree the words mean.

import type { PlayerId } from "../net/messages/fields.js";
import type { AttachmentId, WeaponId } from "../sim/weaponRegistry.js";

/**
 * When a class chosen mid-game takes effect, as the answer to one request.
 *
 * - `now`: in their hands at once — full magazines, primary up.
 * - `nextSpawn`: held until they next spawn. What a change made while dead always
 *   is, since the next spawn is the soonest anything can happen.
 * - `refuse`: not taken. Their class stays as it was.
 *
 * In wire order (`classChosen` carries one): append only.
 */
export const CLASS_TIMINGS = ["now", "nextSpawn", "refuse"] as const;
export type ClassTiming = (typeof CLASS_TIMINGS)[number];

/** What a gametype says about classes. Asked of the scripts once, at match start, like `CombatRules`. */
export interface ClassRules {
  /**
   * Whether players choose from their own classes at all.
   *
   * False: nobody is offered the class menu, and a player spawns the moment they
   * join, carrying what a script arms them with (`setLoadout`) or the gametype's
   * default weapon. A choice sent anyway is refused.
   */
  customClasses: boolean;
  /**
   * Seconds after a spawn during which a change takes effect `now`. Call of Duty's
   * rule for a player who picked the wrong class and noticed as they landed. Zero
   * is no grace at all.
   */
  grace: number;
  /** What a change made while alive and past `grace` does. A player's own override (`setClassChange`) comes first. */
  change: ClassTiming;
}

/** The rules where no script has said otherwise: choose freely, and a change waits for the next spawn. */
export const DEFAULT_CLASS_RULES: ClassRules = {
  customClasses: true,
  grace: 0,
  change: "nextSpawn",
};

/** A player asking for one of their classes, as the `classChoice` hook is handed it. */
export interface ClassRequest {
  readonly id: PlayerId;
  /** Which of their classes, as the game order lists them. */
  readonly index: number;
  /** Their first: they have not spawned yet, and this is what spawns them. Refusing it spawns them unarmed by a class. */
  readonly first: boolean;
  readonly alive: boolean;
  /** Seconds since they last spawned; 0 on a first choice. */
  readonly sinceSpawn: number;
  /** What the engine would do without this hook: the rules, the grace and any override already applied. */
  readonly timing: ClassTiming;
}

/** One weapon a script hands somebody: a catalogue id, and attachments by id. */
export interface ArmedWeapon {
  readonly weapon: WeaponId;
  readonly attachments?: readonly AttachmentId[];
}

/**
 * What a script arms somebody with, bypassing their class.
 *
 * Primary then secondary, like a class, and either may be absent — one pistol is
 * an answer. Unlike a class nothing restricts which weapon goes in which slot, or
 * which game it is from: a script handing out a rocket launcher as a primary
 * means it.
 */
export interface ArmedWith {
  readonly primary?: ArmedWeapon | null;
  readonly secondary?: ArmedWeapon | null;
}
