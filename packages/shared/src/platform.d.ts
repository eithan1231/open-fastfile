// The host globals this package is allowed to use.
//
// tsconfig.json loads neither the DOM lib nor any ambient @types, so the only
// globals in scope are ES2022's. A few things beyond that exist everywhere the
// shared code runs — every browser and Node 17+ — but live in TypeScript's DOM
// lib, which would drag in `window`, `document` and the rest if we loaded it.
//
// Declaring them one at a time keeps the guard strict and, more usefully, makes
// this file the complete list of platform APIs @3d/shared depends on. Anything
// not named here is a build failure, which is the point.

/** Deep-clones plain data. Used by the simulation's snapshot/restore. */
declare function structuredClone<T>(value: T): T;

/** UTF-8, for the strings in the binary wire format (net/schema.ts). */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  /** `fatal` makes invalid bytes throw instead of decoding to U+FFFD, which is what a codec wants. */
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}

// -- Timers and cancellation, for lifecycle/ ---------------------------------

/**
 * The timer handle, as the two hosts differ: Node hands back an object with
 * `unref`, a browser a number. Declared as the intersection of what this package
 * uses — nothing but `clearTimeout` and an *optional* `unref` — so the same code
 * compiles against both without either's full timer type.
 */
interface TimeoutHandle {
  /** Node only: stops this timer from keeping the process alive. */
  unref?(): void;
}

declare function setTimeout(handler: () => void, ms?: number): TimeoutHandle;
declare function clearTimeout(handle: TimeoutHandle | undefined): void;

/** Ending a pending delay early, which is how a stopping loop stops at once rather than at its period. */
declare class AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

/**
 * Only what `lifecycle/` reports with: a pass that failed, and a service that
 * could not close cleanly. Deliberately three methods rather than the DOM's
 * whole Console — this package builds data and has nothing else to say.
 */
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
