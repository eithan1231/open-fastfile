// The page's one AudioContext, and getting a browser to start it.
//
// It goes through `THREE.AudioContext` because that is where `THREE.AudioListener`
// takes its own from, and a buffer decoded against one context is not a buffer
// another can play. One context, one clock, one listener.

import * as THREE from "three";

/** The shared context. Created suspended: browsers will not start one without a gesture. */
export function audioContext(): AudioContext {
  return THREE.AudioContext.getContext() as AudioContext;
}

/**
 * Resume the context on the first user gesture there is.
 *
 * Deliberately not a deferred build: the whole system runs against a suspended
 * context — voices start, loops are scheduled, gains are set — and resuming only
 * lets the clock move. A branch that builds everything a second way once a click
 * arrives is a code path that runs once per session and is therefore never
 * tested. Returns a function that removes the listeners.
 */
export function unlockOnGesture(context: AudioContext, target: EventTarget | undefined = globalThis.window): () => void {
  const events = ["pointerdown", "keydown", "touchstart"] as const;
  if (!target) {
    return () => undefined; // no page to take a gesture from: a test, or a worker
  }
  // The listeners come off only once a resume has actually succeeded. A gesture
  // the browser does not count as one leaves the context suspended, and dropping
  // them on the attempt would mean never getting another.
  const resume = (): void => {
    void context
      .resume()
      .then(remove)
      .catch(() => undefined);
  };
  const remove = (): void => {
    for (const event of events) {
      target.removeEventListener(event, resume);
    }
  };
  if (context.state === "suspended") {
    for (const event of events) {
      target.addEventListener(event, resume);
    }
  }
  return remove;
}
