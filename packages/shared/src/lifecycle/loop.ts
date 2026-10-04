// A service with a lifecycle: something that starts, does a thing on a period,
// and stops without leaving a timer holding the process open.
//
// Every long-lived piece of either server is one of these — a game server's tick,
// heartbeat, orders stream and housekeeping; the api's matchmaking pass — so
// shutdown is the same operation on each and neither `main` knows what any of
// them do. It lives here rather than in one of them because both run it and two
// implementations of a lifecycle are two shutdowns that have to agree.
//
// Isomorphic, like the rest of this package: no timer type, no EventEmitter and
// no `assert`, so it typechecks with neither the DOM lib nor Node's types. The
// host APIs it does use are declared in platform.d.ts.
//
// -- The states --------------------------------------------------------------
//
//   neutral -> starting -> started -> stopping -> neutral
//
// `start()` resolves once the loop is actually running, and `stop()` once it has
// drained. Both are idempotent in the way that matters: a second `stop()` waits
// for the first rather than asserting, because two signals arriving together is
// ordinary and a crash on SIGTERM-after-SIGINT is not.
//
// -- Why the delay is awaited, not scheduled ----------------------------------
//
// `setInterval` will happily queue another pass while the previous one is still
// running, which for anything that awaits means overlapping work and a queue
// that grows under load. This waits for the pass to finish and *then* delays, so
// a slow iteration costs period, never correctness. `FixedRateLoop` below is for
// the one case where the period itself is the contract.

import { timeout } from "./timeout.js";

/**
 * 1. `neutral`  — the default: never started, or fully stopped
 * 2. `starting` — `loopStarting` is running
 * 3. `started`  — the loop is running
 * 4. `stopping` — aborted, draining the pass in flight
 */
export type StatusLifecycle = "neutral" | "starting" | "started" | "stopping";

export abstract class LoopBase {
  protected status: StatusLifecycle = "neutral";

  protected abstract loopDuration: number;

  protected controller: AbortController | null = null;

  /**
   * Waiting for the loop to actually be running. `start()` is the only thing
   * that has ever listened for a transition, so this is a list of resolvers
   * rather than an emitter — which is also what keeps this file free of
   * `node:events`.
   */
  private readonly startedWaiters: (() => void)[] = [];

  private running: Promise<void> | null = null;

  get name(): string {
    return this.constructor.name;
  }

  get started(): boolean {
    return this.status === "started";
  }

  async start(): Promise<void> {
    if (this.status !== "neutral") {
      throw new Error(`${this.name}.start() while ${this.status}`);
    }
    this.status = "starting";
    this.controller = new AbortController();

    try {
      await this.loopStarting?.();
    } catch (err) {
      this.status = "neutral";
      this.controller = null;
      throw err;
    }

    // Deliberately not awaited: `run` only settles when the service stops.
    const started = new Promise<void>((resolve) => this.startedWaiters.push(resolve));
    this.running = this.run();

    await started;
  }

  async stop(): Promise<void> {
    if (this.status === "neutral") {
      return;
    }

    // Two signals, or a stop racing a start. Either way, wait for the run that
    // is already ending instead of asserting on a state someone else set.
    if (this.status === "stopping") {
      await this.running;
      return;
    }

    this.status = "stopping";

    // Ends the pending delay, and anything a subclass gave this signal to.
    this.controller?.abort();

    try {
      await this.loopClosing?.();
    } catch (err) {
      console.error(`${this.name}: failed while closing`, err);
    }
    await this.running;
  }

  private async run(): Promise<void> {
    this.status = "started";

    try {
      await this.loopStarted?.();
    } catch (err) {
      console.error(`${this.name}: failed after starting`, err);
    }

    for (const resolve of this.startedWaiters.splice(0)) {
      resolve();
    }

    while (this.status === "started") {
      try {
        await this.loopIteration();
      } catch (err) {
        // A failed pass is not a failed service: the api restarting, a world
        // that would not load. The next pass tries again.
        console.error(`${this.name}: an iteration failed`, err);
      }

      if (this.status !== "started") {
        break;
      }

      await this.delay();
    }

    this.status = "neutral";
    this.controller = null;
    this.running = null;

    try {
      await this.loopClosed?.();
    } catch (err) {
      console.error(`${this.name}: failed after closing`, err);
    }
  }

  /** Overridden by `FixedRateLoop`, which owes its caller a period rather than a gap. */
  protected delay(): Promise<void> {
    return timeout(this.loopDuration, this.controller?.signal);
  }

  protected abstract loopIteration(): Promise<void>;

  /** Before the loop. Throwing here fails `start()`. */
  protected loopStarting?(): Promise<void>;

  /** Once the loop is running, before `start()` resolves. */
  protected loopStarted?(): Promise<void>;

  /** After the abort, while the last pass drains. Close listeners here. */
  protected loopClosing?(): Promise<void>;

  /** Once the loop has drained and the service is neutral again. */
  protected loopClosed?(): Promise<void>;
}

/**
 * The same lifecycle, but the period is the contract rather than the gap.
 *
 * The simulation tick is a clock: every client accumulates against the rate it
 * was told in its `joined`, so 60 Hz has to mean 60 passes a second and not "16
 * ms after whatever the last one cost". This subtracts the work from the delay,
 * and on a pass that overran skips the delay entirely rather than sleeping a
 * negative amount — so the loop catches up instead of drifting permanently.
 *
 * It does not run catch-up passes back to back. A process that cannot keep up is
 * behind either way, and a burst of ticks would only turn a slow server into a
 * lurching one.
 */
export abstract class FixedRateLoop extends LoopBase {
  private nextAt = 0;

  protected override delay(): Promise<void> {
    const now = Date.now();

    // First pass: the schedule starts from it rather than from `start()`.
    this.nextAt = this.nextAt === 0 ? now + this.loopDuration : this.nextAt + this.loopDuration;
    const wait = this.nextAt - now;

    if (wait <= 0) {
      // Overran. Give up the passes we missed rather than running them in a
      // burst, and re-base so the lateness does not accumulate.
      this.nextAt = now;
      return Promise.resolve();
    }

    return timeout(wait, this.controller?.signal);
  }

  protected override async loopStarted(): Promise<void> {
    this.nextAt = 0;
  }
}
