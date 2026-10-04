// What a player was doing a moment ago, so a shot can be judged against it.
//
// A client draws other players one tick behind the newest snapshot and
// interpolated between two of them, so it aims at where they *were* — by its own
// ping plus that interpolation. To judge a shot at all, this server has to be able
// to put the world back the way the shooter saw it. That is the whole job here:
// keep the recent past, and hand back any moment in it.
//
// Two things make it cheap. The states are preallocated and overwritten
// (`copyMovement`), so a tick allocates nothing; and only what a *pose* and a hit
// need is kept — `MovementState` — rather than the whole `PlayerState`, because a
// rewind never needs to know what was in anybody's magazine.
//
// It keeps `MovementState` rather than a packed float array for a reason worth
// stating: a rewind interpolates with `lerpMovement`, the same function the client
// drew with. A packed record would need a second lerp beside it, and two
// implementations of "where was this player between two ticks" is exactly the
// disagreement that makes a hit land where nobody was.

import { copyMovement, lerpMovement } from "@3d/shared/sim/interpolate.js";
import { createMovement, type MovementState } from "@3d/shared/sim/movement.js";

/**
 * A ring of one player's recent states, by tick.
 *
 * Sized in ticks rather than seconds by its caller, so that a server running at
 * something other than 60 Hz keeps the same *duration* of history.
 */
export class PlayerHistory {
  private readonly slots: MovementState[];
  /** Which tick each slot holds. -1 means never written, which a fresh join has everywhere. */
  private readonly ticks: Int32Array;
  private newest = -1;

  constructor(readonly depth: number) {
    this.slots = Array.from({ length: depth }, () => createMovement({ x: 0, y: 0, z: 0 }, 0, 0));
    this.ticks = new Int32Array(depth).fill(-1);
  }

  /** Keep `movement` as this player's state at the end of `tick`. */
  record(tick: number, movement: MovementState): void {
    const slot = ((tick % this.depth) + this.depth) % this.depth;
    copyMovement(movement, this.slots[slot]!);
    this.ticks[slot] = tick;
    if (tick > this.newest) {
      this.newest = tick;
    }
  }

  /** The newest tick recorded, or -1 before anything is. */
  get latest(): number {
    return this.newest;
  }

  /** The oldest tick still in the ring, or -1 when it is empty. */
  get oldest(): number {
    let best = -1;
    for (let i = 0; i < this.depth; i++) {
      const tick = this.ticks[i]!;
      if (tick >= 0 && (best === -1 || tick < best)) {
        best = tick;
      }
    }
    return best;
  }

  /** The state at exactly `tick`, or undefined if that tick is not in the ring. */
  at(tick: number): MovementState | undefined {
    const slot = ((tick % this.depth) + this.depth) % this.depth;
    return this.ticks[slot] === tick ? this.slots[slot] : undefined;
  }

  /**
   * Where this player was at `tick + frac`, written into `out`.
   *
   * Interpolated between the two recorded ticks that bracket it, by the same
   * `lerpMovement` the client drew with — which is the point of the whole
   * exercise. Falls back to the single tick it has when the next one does not
   * exist yet, which is what happens when a client names the newest tick it has
   * seen: there is nothing to interpolate towards and its own draw would have
   * clamped too.
   *
   * Null when the tick is not in the ring at all. The caller clamps; this does not
   * guess.
   */
  sample(tick: number, frac: number, out: MovementState): MovementState | null {
    const from = this.at(tick);
    if (!from) {
      return null;
    }
    const to = this.at(tick + 1);
    if (!to || frac <= 0) {
      return copyMovement(from, out);
    }
    return lerpMovement(from, to, frac, out);
  }
}
