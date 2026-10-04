// Every brain, by name.
//
// A table, as `SCRIPTS` is for a script: compiled in, reached by name, and never
// read off disk. A script names a brain (`ServerContext.bots.add({ brain })`);
// it never ships one.
//
// Server-only. The api and the client are lint-banned from importing anything
// under game/bots/ (eslint.config.js): a brain decides what a bot does, and
// neither of them has a bot. A script reaches a brain by its id, which is why the
// script table — which a browser imports — pulls none of this in.

import type { AnyBrain } from "./brain.js";
import { seekNearest } from "./brains/seekNearest.js";
import { zombie } from "./brains/zombie.js";
import type { BrainId } from "./objective.js";

export const BRAINS: Readonly<Record<BrainId, AnyBrain>> = {
  [seekNearest.id]: seekNearest,
  [zombie.id]: zombie,
};

/** The brain with this id, or undefined. */
export function brainFor(id: string): AnyBrain | undefined {
  return Object.hasOwn(BRAINS, id) ? BRAINS[id] : undefined;
}
