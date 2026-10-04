// What a script may ask of a bot: which brain drives it, and what it is for.
//
// Types only, and deliberately so. A script names a brain by id and hands it an
// objective as data, exactly as a world names a script — so the script table
// (which both ends import) never pulls the brains and the motor into a browser.
// The brains themselves are in `BRAINS` (registry.ts), server-run.
//
// An objective is the *script's* layer of the three (docs/engine/scripting.md,
// "Bots"): what the bot is for. The brain turns it into a goal, and the motor
// turns that into input. A brain decides what each objective means for it, and
// what `none` means is the brain's own instinct.

import type { PlayerId } from "../../net/messages/fields.js";
import type { Vec3 } from "../../sim/capsule.js";
import type { TeamId } from "../gametypes/declaration.js";

/** A brain's name in `BRAINS`. */
export type BrainId = string;

/** What a script wants a bot to do. */
export type Objective =
  /** Nothing asked: the brain's own instinct. A seek brain hunts; another may stand. */
  | { readonly kind: "none" }
  /** Chase these players, or every living opponent when `targets` is absent. */
  | { readonly kind: "hunt"; readonly targets?: readonly PlayerId[] }
  /** Go to a point, or to a node of the world's graph, and stay there. */
  | { readonly kind: "goto"; readonly point: Vec3 }
  | { readonly kind: "goto"; readonly node: number }
  /** Keep to within `radius` of a point, dealing with what comes inside it. */
  | { readonly kind: "hold"; readonly point: Vec3; readonly radius: number }
  /** Stay with a player. */
  | { readonly kind: "follow"; readonly id: PlayerId };

export const NO_OBJECTIVE: Objective = { kind: "none" };

/** Tuning a script hands a brain when it adds a bot, read once by `Brain.init`. Plain data. */
export type BrainParams = Readonly<Record<string, number | string | boolean>>;

/** A bot a script adds (`ServerContext.bots.add`). */
export interface BotSpec {
  /** Which brain drives it, by its id in `BRAINS`. A name nothing declares throws. */
  readonly brain: BrainId;
  /** Its side, by a name the gametype's `teams` lists. Absent: the side a joining player would get. */
  readonly team?: TeamId;
  /** What it is for, from the start. Absent: `none`. `bots.order` changes it later. */
  readonly objective?: Objective;
  readonly params?: BrainParams;
}
