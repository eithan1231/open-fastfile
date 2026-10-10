// Lag compensation: the moment a shooter was drawing, clamped to one this server
// can answer, and where somebody was at it.

import type { InputMessage } from "@3d/shared/net/messages/input.js";
import type { MovementState } from "@3d/shared/sim/movement.js";
import type { PlayerHistory } from "../history.js";
import type { MatchClock } from "./clock.js";

/**
 * How much of the recent past to keep, seconds.
 *
 * Deliberately four times `MAX_REWIND_SECONDS`, so that **the ring is never the
 * binding constraint**: a tick that has aged out of it can only come from a clock
 * that has drifted or a client that is lying, which keeps those two failure modes
 * distinguishable from ordinary lag. At 60 Hz and ~200 bytes a state it is about
 * 12 KB per player.
 */
const HISTORY_SECONDS = 1;

/**
 * How far back a shot may reach, seconds.
 *
 * This is the bound on the injustice lag compensation does to the person being
 * shot at: they can be killed up to this long after they broke line of sight on
 * their own screen. A quarter-second is the usual figure, and it is a number a
 * victim can reason about.
 */
const MAX_REWIND_SECONDS = 0.25;

/**
 * How often a client asked to be judged against a moment this server could not
 * honour as asked. Counted once per shot, however many players it is judged against.
 *
 * Measured before it is trusted, exactly as drift was: `implausible` is a client
 * naming a tick we never sent it, `clamped` is one reaching further back than
 * `MAX_REWIND_SECONDS` allows. Neither refuses the shot. Both being zero is the
 * expected state, and either being nonzero says something specific — a clock that
 * has drifted, or a client that is lying.
 */
export interface RewindReport {
  implausible: number;
  clamped: number;
}

/** A moment in the past: a tick, and how far towards the next one. */
export interface RewindTarget {
  tick: number;
  frac: number;
}

export class Rewinder {
  private readonly counts: RewindReport = { implausible: 0, clamped: 0 };

  constructor(private readonly clock: MatchClock) {}

  /** Ticks of history a member keeps. */
  get historyLength(): number {
    return Math.max(2, this.clock.ticks(HISTORY_SECONDS));
  }

  /** How far back a rewind may reach, in ticks. A quarter of a second, whatever the rate. */
  get maxTicks(): number {
    return Math.max(1, this.clock.ticks(MAX_REWIND_SECONDS));
  }

  get report(): RewindReport {
    return { ...this.counts };
  }

  /**
   * The absolute tick a client's `renderTick` names, clamped to something this
   * server can actually answer, and counted where it had to be. `sent` is the
   * newest tick sent to the shooter, or -1 for none.
   *
   * `renderTick` is the low 16 bits, so the rest is recovered from our own clock:
   * the tick named is in the recent past, and the masked difference is how far
   * back. That is wrap-safe for anything inside 32768 ticks, against a window of
   * sixty.
   *
   * Never refuses. A refused shot is indistinguishable from a miss to the player
   * who fired it and impossible to account for afterwards, while a clamped one is
   * resolved against a *more current* world, which is the conservative direction.
   */
  target(sent: number, message: InputMessage): RewindTarget {
    const now = this.clock.tick;
    let tick = now - ((now - message.renderTick) & 0xffff);
    let frac = Math.min(Math.max(message.renderFrac, 0), 1);
    if (sent >= 0 && tick > sent) {
      // They cannot have drawn a snapshot we never sent.
      tick = sent;
      frac = 0;
      this.counts.implausible++;
    }
    const floor = now - this.maxTicks;
    if (tick < floor) {
      tick = floor;
      frac = 0;
      this.counts.clamped++;
    }
    return { tick, frac };
  }

  /**
   * Where `history`'s player was at `at`, into `out`. One who joined after that
   * tick is judged at their oldest, the earliest they can be; null for one with
   * no history at all.
   */
  sample(history: PlayerHistory, at: RewindTarget, out: MovementState): MovementState | null {
    const sampled = history.sample(at.tick, at.frac, out);
    if (sampled) {
      return sampled;
    }
    const oldest = history.oldest;
    return oldest < 0 ? null : history.sample(oldest, 0, out);
  }
}
