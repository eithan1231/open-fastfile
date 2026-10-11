// One member's inputs: the queue a datagram fills and the tick drains, the ack
// it echoes, the use key's edge, and the drift between what the client claimed
// and what our replay of the same input did.

import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { InputMessage, InputStep } from "@3d/shared/net/messages/input.js";
import { after } from "@3d/shared/net/seq.js";
import type { Vec3 } from "@3d/shared/sim/capsule.js";

/**
 * Inputs one player may spend in a single tick. A client at our tick rate sends
 * one; a burst after a stall is legitimate and worth draining. Past this it is
 * either a stall long enough that replaying it is pointless or a client buying
 * itself extra movement, and neither deserves the CPU.
 */
export const MAX_INPUTS_PER_TICK = 4;

/** How far a client's claim sits from our replay of the same step. Metres, per step, never cumulative. */
export interface DriftReport {
  /** The most recent input applied. */
  current: number;
  /** The worst single step this session: a spike, which one bad tick is enough to cause. */
  max: number;
  /**
   * The average step. This is the number that catches a systematic mismatch —
   * a prop solid on one end and air on the other holds a small error on *every*
   * step, which `max` cannot tell apart from one dropped packet.
   */
  mean: number;
  /** Inputs compared so far, so a max of 0 can be told from no data. */
  samples: number;
}

export class InputQueue {
  private readonly queue: InputMessage[] = [];
  /** The last seq we applied, echoed back as SnapshotMessage.ack. Never goes back: the queue is in seq order. */
  private acked = 0;
  /**
   * The newest seq queued or applied, or undefined before the first. Datagrams
   * arrive reordered and repeat each other's inputs (`InputPacket.earlier`), so
   * anything not after this is a copy or a straggler and is dropped.
   */
  private newest: number | undefined;
  /**
   * Whether the last input spent held the use key. Kept across inputs and ticks,
   * so a press is its rising edge and a repeated or re-sent input presses nothing.
   */
  private useHeld = false;
  /** Dropped because the queue was already full: a flooding or badly lagged client. */
  dropped = 0;
  readonly drift: DriftReport = { current: 0, max: 0, mean: 0, samples: 0 };

  /**
   * `seen` is the newest seq this player sent before they were being simulated
   * (`UnspawnedInputs`): everything up to it counts as dealt with, so nothing
   * made before the spawn is stepped after it.
   */
  constructor(seen?: number) {
    this.acked = seen ?? 0;
    this.newest = seen;
  }

  get ack(): number {
    return this.acked;
  }

  /**
   * Queue one input off the wire, if it is newer than any before it: one that
   * arrives after a later one would be applied out of order and lower `ack`, and
   * a repeat would be applied twice. A packet's inputs come oldest first, so a
   * gap is filled in order.
   */
  receive(message: InputMessage): void {
    if (this.newest !== undefined && !after(message.seq, this.newest)) {
      return;
    }
    // A cap rather than unbounded growth: a client that stops reading is a
    // memory leak, and replaying a two-second-old input helps nobody.
    if (this.queue.length >= MAX_INPUTS_PER_TICK * 4) {
      this.dropped++;
      return;
    }
    this.queue.push(message);
    this.newest = message.seq;
  }

  /**
   * Queue an input this server wrote itself (a bot's). It has no seq to check or
   * to acknowledge and claims nothing, so it leaves the ack where it stands.
   */
  push(step: InputStep): void {
    this.queue.push({ ...step, seq: this.acked, claim: null });
  }

  /**
   * Forget which seqs were sent, the ack with them: a new connection counts from
   * the start again, and an ack left over from the old one would tell it that
   * inputs it has only just sent were already applied.
   */
  reset(): void {
    this.queue.length = 0;
    this.newest = undefined;
    this.acked = 0;
  }

  /** This tick's inputs, oldest first, at most `MAX_INPUTS_PER_TICK`. */
  take(): InputMessage[] {
    return this.queue.splice(0, MAX_INPUTS_PER_TICK);
  }

  /**
   * `message` is being spent: it is acked, and this says whether it pressed the
   * use key. An edge and never a level, tracked while dead too, so a key held
   * through a respawn presses nothing.
   */
  spend(message: InputMessage): boolean {
    this.acked = message.seq;
    const pressed = message.input.use && !this.useHeld;
    this.useHeld = message.input.use;
    return pressed;
  }

  /** How far our replay of a step landed from where its client said it did. */
  measure(ours: Vec3, claimed: Vec3): void {
    const metres = Math.hypot(ours.x - claimed.x, ours.y - claimed.y, ours.z - claimed.z);
    const drift = this.drift;
    drift.current = metres;
    drift.max = Math.max(drift.max, metres);
    drift.samples++;
    // Incremental, so nothing has to hold a running total that /healthz would then serialise.
    drift.mean += (metres - drift.mean) / drift.samples;
  }
}

/**
 * The inputs of players who are seated but not in the match: sent a snapshot
 * every tick, choosing a class, and simulated by nothing.
 *
 * Nothing is stepped for them, but each is still acknowledged. A client keeps
 * what it has sent until an ack covers it and replays the lot onto its next
 * correction, so one left unanswered through a class menu would arrive at its
 * spawn two seconds of input ahead of it.
 */
export class UnspawnedInputs {
  private readonly newest = new Map<PlayerId, number>();

  /** An input arrived from somebody not in the match. */
  receive(id: PlayerId, seq: number): void {
    const seen = this.newest.get(id);
    if (seen === undefined || after(seq, seen)) {
      this.newest.set(id, seq);
    }
  }

  /** The newest seq they have sent, or undefined for none. */
  ack(id: PlayerId): number | undefined {
    return this.newest.get(id);
  }

  /** They are spawning, or gone: hand over what was seen and keep nothing. */
  take(id: PlayerId): number | undefined {
    const seen = this.newest.get(id);
    this.newest.delete(id);
    return seen;
  }
}
