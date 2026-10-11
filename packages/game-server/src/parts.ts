// One match's removable parts: which solids are present, and everything that
// follows when a script changes one.
//
// `ServerContext.world.setPresent` queues a change; `flush` applies every queued
// change at the end of the tick, in one fixed order — the collision view (which
// reads the presence, so it follows by itself), the physics colliders, the
// navigation blockers, and the snapshot's bitset. Each end that steps physics
// applies its changes at the same point (`SnapshotPresence.since`).
//
// Kept out of match/ so the match only calls three things: the verbs, the
// blockers when its graph appears, and the flush.

import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { NavMatchState } from "@3d/shared/nav/dynamic.js";
import type { SnapshotPresence } from "@3d/shared/net/messages/snapshot.js";
import type { PhysicsWorld } from "@3d/shared/physics/world.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import { PLAYER_MOVEMENT, type MovementState } from "@3d/shared/sim/movement.js";
import { hullHeight } from "@3d/shared/sim/stance.js";
import type { WorldIndex } from "@3d/shared/worlds/worldIndex.js";
import { solidsNamed, type Presence } from "@3d/shared/worlds/presence.js";

/** The navigation blocker a part holds shut while present. */
export function partBlocker(part: string): string {
  return `part:${part}`;
}

export class MatchParts {
  /** Changes a script asked for and the tick has not applied, by solid index. */
  private readonly pending = new Map<number, boolean>();
  private wire: SnapshotPresence | null;
  /** Solids a restore is waiting on because somebody walked into them since it was asked for. */
  private readonly waiting = new Set<number>();

  constructor(
    private readonly world: ResolvedWorld,
    private readonly index: () => WorldIndex,
    readonly presence: Presence,
    /** One part alone, for the overlap check; absent where the collision is not a real one (a test). */
    private readonly partView?: (index: number) => CapsuleWorld,
  ) {
    this.wire = world.solids.length === 0 ? null : { since: 0, bits: Array.from(presence.bytes) };
  }

  /** What the snapshot carries: null for a world with no solids. */
  get snapshot(): SnapshotPresence | null {
    return this.wire;
  }

  /** The solids a name or tag means. Throws on one that means none, as `setTeam` does for a side. */
  resolve(tagOrName: string): number[] {
    const found = solidsNamed(this.index(), tagOrName);
    if (found.length === 0) {
      throw new Error(`world.setPresent: no solid in this world is named or tagged "${tagOrName}"`);
    }
    return found;
  }

  /**
   * Queue `on` for every solid `tagOrName` means. A restore someone living is
   * standing in throws now, where the script can see it; `occupied` asks.
   */
  request(tagOrName: string, on: boolean, occupied: (part: CapsuleWorld) => boolean): void {
    const found = this.resolve(tagOrName);
    if (on) {
      for (const i of found) {
        const part = this.partView?.(i);
        if (!this.presence.has(i) && part && occupied(part)) {
          throw new Error(`world.setPresent: cannot restore "${this.world.solids[i]!.part}" (${tagOrName}) while somebody is inside it`);
        }
      }
    }
    for (const i of found) {
      this.pending.set(i, on);
    }
  }

  /** Whether every solid `tagOrName` means is present, counting what is queued. */
  isPresent(tagOrName: string): boolean {
    return this.resolve(tagOrName).every((i) => this.pending.get(i) ?? this.presence.has(i));
  }

  /** Shut the links of every present part, on a match's navigation the moment it has one. */
  registerBlockers(state: NavMatchState, partLinks: readonly (readonly number[])[] | undefined): void {
    this.world.solids.forEach((solid, i) => {
      const links = partLinks?.[i];
      if (links && links.length > 0) {
        state.addBlocker(partBlocker(solid.part), { links }, this.presence.has(i));
      }
    });
  }

  /**
   * Apply what was queued, at the end of `tick` and after its physics step, in
   * ascending solid order. A restore that somebody has walked into since it was
   * asked for waits for a tick they are out of. Returns the solids that changed.
   */
  flush(tick: number, fan: { physics?: PhysicsWorld; nav?: NavMatchState; actorNav?: NavMatchState; occupied: (part: CapsuleWorld) => boolean }): number[] {
    if (this.pending.size === 0) {
      return [];
    }
    const changed: number[] = [];
    for (const i of [...this.pending.keys()].sort((a, b) => a - b)) {
      const on = this.pending.get(i)!;
      const part = this.partView?.(i);
      if (on && !this.presence.has(i) && part && fan.occupied(part)) {
        if (!this.waiting.has(i)) {
          this.waiting.add(i);
          console.warn(`[match] restoring "${this.world.solids[i]!.part}" waits: somebody walked into it`);
        }
        continue;
      }
      this.pending.delete(i);
      this.waiting.delete(i);
      if (this.presence.set(i, on)) {
        changed.push(i);
      }
    }
    for (const i of changed) {
      fan.physics?.setPart(i, this.presence.has(i));
    }
    for (const i of changed) {
      fan.nav?.setBlocked(partBlocker(this.world.solids[i]!.part), this.presence.has(i));
      fan.actorNav?.setBlocked(partBlocker(this.world.solids[i]!.part), this.presence.has(i));
    }
    if (changed.length > 0) {
      this.wire = { since: tick & 0xffff, bits: Array.from(this.presence.bytes) };
    }
    return changed;
  }
}

/** Whether a player in state `s` is inside `part`: their capsule as their stance has it. */
export function capsuleIn(part: CapsuleWorld, s: Readonly<MovementState>): boolean {
  return part.overlapsCapsule(s.feet, PLAYER_MOVEMENT.radius, hullHeight(s, PLAYER_MOVEMENT));
}
