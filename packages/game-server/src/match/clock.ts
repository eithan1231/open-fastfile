// A match's clock: the tick it is on and the rate it runs at. One object every
// part of the match reads, so "now" is one number rather than a copy each part
// keeps in step.

export class MatchClock {
  /** The tick last stepped: 0 before the first. Advanced only by `Match.step`. */
  tick = 0;

  constructor(readonly rate: number) {}

  /** Seconds per tick. */
  get dt(): number {
    return 1 / this.rate;
  }

  /** The match clock in seconds, which is what `GameView.now` carries: never a wall clock. */
  get now(): number {
    return this.tick / this.rate;
  }

  /** A duration in seconds as whole ticks, at this rate. */
  ticks(seconds: number): number {
    return Math.round(this.rate * seconds);
  }
}
