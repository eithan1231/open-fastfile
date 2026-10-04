// How far the view turns for a given movement of the mouse, and where the
// player's choice of that is kept.
//
// -- What a "count" is -------------------------------------------------------
//
// `InputManager` asks for pointer lock with `unadjustedMovement`, so what
// arrives is the *device's* own deltas: one unit is one count of the mouse's
// sensor, and no curve has been applied to it. That is the finest movement the
// hardware can report, which makes `MOUSE_YAW` below the smallest angle the view
// can possibly turn by — the aim's resolution, and the one number that decides
// whether small corrections read as smooth or as steps.
//
// At 90° across a 1920-pixel window, a degree is about 21 pixels, so a step of
// 0.126° (where this used to sit, as a bare `0.0022` radians per count) moves the
// picture nearly three pixels at a time and considerably more through a scope.
// Nothing about that is jitter — it is the quantum — and no amount of smoothing
// fixes it, because there is nothing between one count and the next to smooth.
// Only a smaller angle per count does, which is what a sensitivity setting is
// for.
//
// The units are CoD's, so that a number a player already knows means what they
// expect: `m_yaw` is 0.022° per count, and the sensitivity multiplies it.

/** Degrees the view turns per count at sensitivity 1. The games' `m_yaw`. */
const MOUSE_YAW = 0.022;

/** The games' own default, and ours. About 0.066° per count. */
export const DEFAULT_SENSITIVITY = 3;

/**
 * What the setting may be set to. The top end is where this used to sit outright
 * (0.126° per count); the bottom is finer than any mouse's own jitter.
 */
export const SENSITIVITY_RANGE = { min: 0.2, max: 8, step: 0.1 } as const;

/** Radians of view per count of mouse movement, at `sensitivity`. */
export function radiansPerCount(sensitivity: number): number {
  return (clampSensitivity(sensitivity) * MOUSE_YAW * Math.PI) / 180;
}

/** `value` brought into range, with anything unusable falling back to the default. */
export function clampSensitivity(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SENSITIVITY;
  }
  return Math.min(SENSITIVITY_RANGE.max, Math.max(SENSITIVITY_RANGE.min, value));
}

const STORAGE_KEY = "3d.sensitivity";

export function loadSensitivity(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_SENSITIVITY : clampSensitivity(Number(stored));
  } catch {
    return DEFAULT_SENSITIVITY; // storage can be disabled outright
  }
}

export function saveSensitivity(value: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // not being able to remember the setting is not worth failing over
  }
}
