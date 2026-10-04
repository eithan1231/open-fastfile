// Which of a world's solids are there right now, in one match.
//
// A `solid` names a part of the world's collision and shell that can be absent:
// outside its `mode:`, or once a script removes it. The world never says which
// are present — that is a match's live state, seeded from the gametype's mode and
// changed by `ServerContext.world.setPresent`. Collision views, physics colliders,
// navigation blockers and the drawn meshes all read this one value, and the
// snapshot carries its bits so every client converges on the server's.
//
// Indices are positions in `ResolvedWorld.solids`, never entity ids: the wire
// carries one bit per solid in that order, which the join's world hash makes safe.

import type { ResolvedWorld } from "../dsl/resolved.js";
import { presentIn } from "../sim/worldRules.js";
import type { WorldIndex } from "./worldIndex.js";

export class Presence {
  /** One bit per solid, bit `i & 7` of byte `i >> 3`: the wire's own layout. */
  private readonly bits: Uint8Array;
  /** Moves on every change of any bit, so a reader can tell "changed" without comparing. */
  version = 0;

  constructor(
    /** How many solids the world declares. */
    readonly count: number,
    /**
     * The mode being played, fixed for the match: what a `model`'s `mode:` is
     * read against. A solid's own bits are seeded from it and then live.
     */
    readonly mode?: string,
    present = true,
  ) {
    this.bits = new Uint8Array(Math.ceil(count / 8));
    if (present) {
      for (let i = 0; i < count; i++) {
        this.bits[i >> 3]! |= 1 << (i & 7);
      }
    }
  }

  has(index: number): boolean {
    return index >= 0 && index < this.count && (this.bits[index >> 3]! & (1 << (index & 7))) !== 0;
  }

  /** Put one solid in or take it out. Whether anything changed. */
  set(index: number, on: boolean): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError(`presence: no solid ${index} in a world of ${this.count}`);
    }
    if (this.has(index) === on) {
      return false;
    }
    this.bits[index >> 3]! ^= 1 << (index & 7);
    this.version++;
    return true;
  }

  /** Whether a model carrying `modes` exists in this match. Fixed for the match, like the mode. */
  hasModes(modes: readonly string[] | undefined): boolean {
    return presentIn(modes, this.mode);
  }

  /** The bitset as the wire carries it. A view, not a copy: whoever keeps it copies it. */
  get bytes(): Uint8Array {
    return this.bits;
  }

  /**
   * Adopt a bitset from the wire, and say which solids changed, ascending. Bits
   * past `count` are ignored; a short bitset is a different world and throws.
   */
  assign(bytes: ArrayLike<number>): number[] {
    if (bytes.length !== this.bits.length) {
      throw new RangeError(`presence: ${bytes.length} byte(s) for a world of ${this.count} solid(s)`);
    }
    const changed: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const on = (bytes[i >> 3]! & (1 << (i & 7))) !== 0;
      if (this.has(i) !== on) {
        this.bits[i >> 3]! ^= 1 << (i & 7);
        changed.push(i);
      }
    }
    if (changed.length > 0) {
      this.version++;
    }
    return changed;
  }
}

/**
 * A match's presence at its start: every solid its gametype's mode admits
 * (`presentIn`). Free Roam (no mode) has none of the mode-tagged ones.
 */
export function presenceFor(world: Pick<ResolvedWorld, "solids">, mode: string | undefined): Presence {
  const presence = new Presence(world.solids.length, mode, false);
  world.solids.forEach((solid, i) => {
    if (presentIn(solid.modes, mode)) {
      presence.set(i, true);
    }
  });
  presence.version = 0;
  return presence;
}

/** Every solid, absent: the base world, which is what a navigation graph is baked against. */
export function basePresence(world: Pick<ResolvedWorld, "solids">): Presence {
  return new Presence(world.solids.length, undefined, false);
}

/**
 * The solids a script means by `tagOrName`: the one with that name and every one
 * carrying that tag, ascending by index. Empty when nothing matches.
 */
export function solidsNamed(index: WorldIndex, tagOrName: string): number[] {
  const found = new Set<number>();
  const all = index.solids.all;
  const named = index.solids.byName.get(tagOrName);
  if (named) {
    found.add(all.indexOf(named));
  }
  for (const solid of index.solids.byTag.get(tagOrName) ?? []) {
    found.add(all.indexOf(solid));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Whether every solid `tagOrName` means is present in `presence`: what
 * `GameView.isPresent` answers on both ends. Throws on a name no solid carries,
 * as `setPresent` does.
 */
export function presentNamed(index: WorldIndex, presence: Pick<Presence, "has">, tagOrName: string): boolean {
  const found = solidsNamed(index, tagOrName);
  if (found.length === 0) {
    throw new Error(`isPresent: no solid in this world is named or tagged "${tagOrName}"`);
  }
  return found.every((i) => presence.has(i));
}
