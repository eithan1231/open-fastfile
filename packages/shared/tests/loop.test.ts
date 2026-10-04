// The lifecycle every long-lived piece of either server shares.
//
// What is worth testing here is not that a loop loops, but the four things that
// bite: a start that resolves only once the loop is running, a stop that waits
// for the pass in flight, a stop that is safe to call twice — two signals
// arriving together is ordinary — and a failed pass that does not take the
// service down with it.

import { describe, expect, it, vi } from "vitest";
import { FixedRateLoop, LoopBase } from "../src/lifecycle/loop.js";
import { timeout } from "../src/lifecycle/timeout.js";

class Counter extends LoopBase {
  protected loopDuration = 1;
  passes = 0;
  readonly seen: string[] = [];
  failFor = 0;

  protected async loopIteration(): Promise<void> {
    this.passes += 1;
    if (this.failFor > 0) {
      this.failFor -= 1;
      throw new Error("a pass that failed");
    }
  }

  protected override async loopStarting(): Promise<void> {
    this.seen.push("starting");
  }
  protected override async loopStarted(): Promise<void> {
    this.seen.push("started");
  }
  protected override async loopClosing(): Promise<void> {
    this.seen.push("closing");
  }
  protected override async loopClosed(): Promise<void> {
    this.seen.push("closed");
  }
}

describe("a looping service", () => {
  it("is running by the time start() resolves, and stopped by the time stop() does", async () => {
    const loop = new Counter();
    await loop.start();

    expect(loop.started).toBe(true);
    expect(loop.passes).toBeGreaterThan(0);
    expect(loop.seen).toEqual(["starting", "started"]);

    await loop.stop();
    expect(loop.started).toBe(false);
    expect(loop.seen).toEqual(["starting", "started", "closing", "closed"]);

    // And it really stopped, rather than stopping a tick later.
    const passes = loop.passes;
    await timeout(20);
    expect(loop.passes).toBe(passes);
  });

  it("can be started again once it has stopped", async () => {
    const loop = new Counter();
    await loop.start();
    await loop.stop();
    await expect(loop.start()).resolves.toBeUndefined();
    await loop.stop();
  });

  it("takes a second stop() without throwing, because two signals arrive together", async () => {
    const loop = new Counter();
    await loop.start();
    // SIGINT and SIGTERM, or a stop racing a shutdown.
    await Promise.all([loop.stop(), loop.stop()]);
    expect(loop.started).toBe(false);
  });

  it("survives a pass that throws, and keeps going", async () => {
    const loop = new Counter();
    loop.failFor = 2;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await loop.start();
      await vi.waitFor(() => expect(loop.passes).toBeGreaterThan(3));
      expect(loop.started).toBe(true);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await loop.stop();
    }
  });

  it("fails start() when the service cannot come up, and stays neutral", async () => {
    class Broken extends Counter {
      protected override async loopStarting(): Promise<void> {
        throw new Error("no");
      }
    }
    const loop = new Broken();
    await expect(loop.start()).rejects.toThrow("no");
    expect(loop.started).toBe(false);
    // Neutral rather than wedged: it can be started again.
    expect(loop.passes).toBe(0);
  });

  it("waits for the pass in flight rather than cutting it off", async () => {
    let finished = false;
    class Slow extends LoopBase {
      protected loopDuration = 1;
      protected async loopIteration(): Promise<void> {
        await timeout(30);
        finished = true;
      }
    }
    const loop = new Slow();
    await loop.start();
    await loop.stop();
    expect(finished).toBe(true);
  });
});

describe("a fixed-rate service", () => {
  it("holds its period rather than adding the work to it", async () => {
    const PERIOD = 10;
    const WORK = 6;
    class Ticker extends FixedRateLoop {
      protected loopDuration = PERIOD;
      readonly at: number[] = [];
      protected async loopIteration(): Promise<void> {
        this.at.push(Date.now());
        await timeout(WORK);
      }
    }
    const loop = new Ticker();
    await loop.start();
    await vi.waitFor(() => expect(loop.at.length).toBeGreaterThanOrEqual(5), { timeout: 2000 });
    await loop.stop();

    const spans = loop.at.slice(1).map((at, i) => at - loop.at[i]!);
    const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
    // A plain LoopBase sleeps PERIOD *after* WORK and averages PERIOD + WORK
    // here; this should average PERIOD. Asserted at the midpoint, which is the
    // widest margin that still tells the two apart — a shared CI box is not a
    // realtime system, and what is under test is that the work is subtracted,
    // not the timer's precision.
    expect(mean).toBeLessThan(PERIOD + WORK / 2);
  });
});
