// @vitest-environment happy-dom
//
// Mouse look under a polling rate far above the frame rate.
//
// `InputManager` listens to `pointermove`, not `mousemove`, so the browser
// coalesces a frame's movements into one dispatch and hands the merged ones
// over in `getCoalescedEvents()`. These pin down the two properties that makes
// load-bearing: the total must survive coalescing exactly, and a browser that
// gives us no coalesced history must still not lose the movement.
//
// The bug this replaced: an 8000 Hz mouse dispatches ~130 `mousemove` events
// per 60 fps frame against a 1000 Hz mouse's 16. The arithmetic was never the
// problem — 130 deltas of 1 px sum to what 16 of 8 px do — but each dispatch is
// a trip through the event pipeline on the main thread, and once that falls
// behind the events arrive in bursts. A burst is a frame that turns the view
// further than the hand moved in it.

import { afterEach, describe, expect, it } from "vitest";
import { InputManager } from "../src/input/InputManager.js";

let input: InputManager | undefined;

afterEach(() => {
  input?.dispose();
  input = undefined;
});

/** A locked manager: the look listener is gated on pointer lock, which happy-dom has no notion of. */
function locked(): InputManager {
  const canvas = document.createElement("canvas");
  const manager = new InputManager(canvas);
  Object.defineProperty(document, "pointerLockElement", { value: canvas, configurable: true });
  Object.defineProperty(document, "exitPointerLock", { value: () => {}, configurable: true });
  input = manager;
  return manager;
}

/**
 * One `pointermove` as a browser would deliver it: its own movement, and the
 * events it merged. A real coalesced list includes the dispatched event itself,
 * so `parts` is the whole frame and never a supplement to it.
 */
function dispatch(parts: number[] | undefined, own = parts?.reduce((a, b) => a + b, 0) ?? 0): void {
  const event = new Event("pointermove") as Event & {
    movementX: number;
    movementY: number;
    getCoalescedEvents?: () => { movementX: number; movementY: number }[];
  };
  event.movementX = own;
  event.movementY = 0;
  if (parts) {
    const merged = parts.map((x) => ({ movementX: x, movementY: 0 }));
    event.getCoalescedEvents = () => merged;
  }
  document.dispatchEvent(event);
}

describe("mouse look at a polling rate above the frame rate", () => {
  it("carries the same turn however many polls it was split across", () => {
    const slow = locked();
    dispatch(Array.from({ length: 16 }, () => 8)); // 1000 Hz: 16 polls of 8 px
    const coarse = slow.takeLook().x;
    slow.dispose();

    const fast = locked();
    dispatch(Array.from({ length: 128 }, () => 1)); // 8000 Hz: 128 polls of 1 px
    const fine = fast.takeLook().x;

    expect(fine).toBe(coarse);
    expect(fine).toBe(128);
  });

  it("takes one dispatch a frame, whatever the polling rate behind it", () => {
    const manager = locked();
    // Three frames of a steady sweep, the browser merging each frame's polls.
    for (let frame = 0; frame < 3; frame++) {
      dispatch(Array.from({ length: 130 }, () => 1));
    }
    expect(manager.takeLook().x).toBe(390);
  });

  it("does not double-count: the coalesced list already holds the dispatched event", () => {
    const manager = locked();
    // A browser reporting the frame's total on the event *and* in its parts.
    dispatch([2, 3, 5], 10);
    expect(manager.takeLook().x).toBe(10);
  });

  it("falls back to the event's own movement where there is no coalesced history", () => {
    const manager = locked();
    dispatch(undefined, 12); // no getCoalescedEvents at all
    expect(manager.takeLook().x).toBe(12);
  });

  it("falls back where the coalesced events carry no movement of their own", () => {
    const manager = locked();
    // Some browsers have left `movementX` off coalesced events under pointer
    // lock. Summing those alone would silently drop every frame of aim.
    dispatch([0, 0, 0], 9);
    expect(manager.takeLook().x).toBe(9);
  });

  it("accumulates across frames until a tick drains it, and drains to zero", () => {
    const manager = locked();
    dispatch([4]);
    dispatch([6]);
    expect(manager.takeLook().x).toBe(10);
    expect(manager.takeLook().x).toBe(0);
  });

  it("ignores movement while the pointer is not locked", () => {
    const manager = locked();
    Object.defineProperty(document, "pointerLockElement", { value: null, configurable: true });
    dispatch([50]);
    expect(manager.takeLook().x).toBe(0);
  });
});
