// A zombie: the seeker (seekNearest.ts), which also hits what it catches.
//
// Every think it first looks for a living player it is hunting within reach —
// horizontally within `reach` of its feet, and on the same floor — and if there
// is one, its goal is `attack` them: the motor stands and faces, and the actor's
// runtime lands the blow when its kind's cooldown allows. Otherwise it chases as
// the seeker does, stopping short of its quarry by less than its reach, so a
// chase that arrives is one that can swing.
//
// Four times a second rather than the seeker's two, because a quarry stepping
// out of reach should be followed in a quarter of a second, not half of one.
//
// Params: `reach` (m; an actor's runtime passes its kind's) and `run` (false for
// a walker that never breaks into a run — a gametype's choice per round).

import type { PlayerId } from "../../../net/messages/fields.js";
import type { Vec3 } from "../../../sim/capsule.js";
import { defineBrain, type Goal } from "../brain.js";
import { quarries, seek, SEEK_ARRIVE, type Chase, type SeekMemory } from "./seekNearest.js";

export const ZOMBIE = "zombie";

/** Seconds between thinks. */
export const ZOMBIE_PERIOD = 0.25;
/** Reach, m, when nothing says: an arm's length. */
export const ZOMBIE_REACH = 1;
/** A chase stops at this share of the reach, so the quarry is inside it on arrival. */
const ARRIVE_SHARE = 0.7;
/** Within reach means on the same floor too: no further above or below than this, m. */
const REACH_DY = 1;

interface Memory extends SeekMemory {
  reach: number;
  chase: Chase;
}

export const zombie = defineBrain<Memory>({
  id: ZOMBIE,
  period: ZOMBIE_PERIOD,
  init: (_self, _rng, params) => {
    const reach = typeof params.reach === "number" && params.reach > 0 ? params.reach : ZOMBIE_REACH;
    return {
      quarry: null,
      avoid: new Map(),
      reach,
      chase: { arrive: Math.min(SEEK_ARRIVE, reach * ARRIVE_SHARE), run: params.run !== false },
    };
  },
  think(ctx, self, memory): Goal {
    const objective = self.objective;
    // Only where it is hunting: a zombie sent somewhere goes there first.
    if (objective.kind === "none" || objective.kind === "hunt") {
      const hunted = quarries(ctx, self, memory, objective.kind === "hunt" ? objective.targets : undefined, null);
      const target = inReach(hunted, self.movement.feet, memory.reach);
      if (target !== null) {
        memory.quarry = target;
        return { kind: "attack", target };
      }
    }
    return seek(ctx, self, memory, memory.chase);
  },
});

/** The nearest quarry within reach and on this floor, or null. `quarries` is nearest first. */
function inReach(candidates: ReturnType<typeof quarries>, feet: Vec3, reach: number): PlayerId | null {
  for (const { id, state, distance } of candidates) {
    if (distance > reach + REACH_DY) {
      break; // nearest first: nobody further on is within reach either
    }
    if (Math.abs(state.feet.y - feet.y) <= REACH_DY && Math.hypot(state.feet.x - feet.x, state.feet.z - feet.z) <= reach) {
      return id;
    }
  }
  return null;
}
