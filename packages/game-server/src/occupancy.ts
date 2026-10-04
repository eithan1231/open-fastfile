// Which triggers each player's feet are in, one match's worth, kept tick to tick
// so a script hears an entry and a leaving once each (`triggerEnter`,
// `triggerLeave`) and can ask who is where (`ctx.zonesOf`, `ctx.occupants`).
//
// A world has a couple of hundred triggers and a match a handful of players, so
// the broad phase is each trigger's axis-aligned bounds, compared before the
// exact test: sixty times a second that is well under a millisecond.
//
// Players only. An actor is in no trigger, because nothing has asked where one
// is: a script that wants it would add it here rather than in a second pass.

import type { ResolvedTrigger } from "@3d/shared/dsl/resolved.js";
import { inside, volumeBounds, type Bounds } from "@3d/shared/game/volumes.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { Vec3 } from "@3d/shared/sim/capsule.js";
import { presentIn } from "@3d/shared/sim/worldRules.js";

/** What changed for one player this tick: trigger indices, ascending. */
export interface Transition {
  readonly left: readonly number[];
  readonly entered: readonly number[];
}

const NOTHING: Transition = { left: [], entered: [] };

export class Occupancy {
  /** The triggers that exist in this mode, by index into `world.triggers`, with their bounds. */
  private readonly live: { index: number; bounds: Bounds }[] = [];
  /** Each player's triggers, ascending. A player in none has no entry. */
  private readonly inside = new Map<PlayerId, number[]>();

  constructor(
    private readonly triggers: readonly ResolvedTrigger[],
    mode: string | undefined,
  ) {
    triggers.forEach((trigger, index) => {
      if (presentIn(trigger.modes, mode)) {
        this.live.push({ index, bounds: volumeBounds(trigger) });
      }
    });
  }

  /** Where `id`'s feet are now, or null for nowhere (dead): what they entered and left since the last call. */
  update(id: PlayerId, feet: Vec3 | null): Transition {
    const now: number[] = [];
    if (feet) {
      for (const { index, bounds } of this.live) {
        const { min, max } = bounds;
        if (feet.x < min.x || feet.x > max.x || feet.y < min.y || feet.y > max.y || feet.z < min.z || feet.z > max.z) {
          continue;
        }
        if (inside(this.triggers[index]!, feet)) {
          now.push(index);
        }
      }
    }
    const was = this.inside.get(id) ?? [];
    if (now.length === 0) {
      this.inside.delete(id);
    } else {
      this.inside.set(id, now);
    }
    if (was.length === 0 && now.length === 0) {
      return NOTHING;
    }
    return { left: was.filter((i) => !now.includes(i)), entered: now.filter((i) => !was.includes(i)) };
  }

  /** Forget a player who has left the match. No `triggerLeave`: there is nobody left to have left. */
  remove(id: PlayerId): void {
    this.inside.delete(id);
  }

  /** The triggers `id` is in, ascending. */
  of(id: PlayerId): readonly number[] {
    return this.inside.get(id) ?? [];
  }

  /** The tags of every trigger `id` is in, each once, in trigger order. */
  zonesOf(id: PlayerId): string[] {
    const tags = new Set<string>();
    for (const index of this.of(id)) {
      for (const tag of this.triggers[index]!.tags) {
        tags.add(tag);
      }
    }
    return [...tags];
  }

  /** Whether `id` is in any trigger carrying `tag`. */
  isIn(id: PlayerId, tag: string): boolean {
    return this.of(id).some((index) => this.triggers[index]!.tags.includes(tag));
  }
}
