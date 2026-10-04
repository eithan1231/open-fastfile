// A sleep that an abort ends early, rather than one a shutdown has to wait out.
//
// A stopping service aborts its signal and the pending delay resolves at once,
// which is what lets a loop with a 10s period stop in microseconds instead of
// holding the process open for the rest of its interval.

export function timeout(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    // Nothing here should keep a process alive on its own: the service holding
    // this loop is what decides the process lives, not the delay between passes.
    // Optional because a browser's timer handle is a number and has no such
    // method — see platform.d.ts.
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}
