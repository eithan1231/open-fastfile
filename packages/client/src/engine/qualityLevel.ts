// The quality levels by name, and which one this browser chose. No three.js, so
// the UI can name a level without pulling the renderer into its bundle; what
// each level does is engine/quality.ts.

export type QualityLevel = "low" | "medium" | "high";

/** Cycle order, ascending, so repeated presses climb then wrap. */
export const QUALITY_LEVELS: readonly QualityLevel[] = ["low", "medium", "high"];

const STORAGE_KEY = "3d-designer:quality";
const DEFAULT_LEVEL: QualityLevel = "high";

function isLevel(value: string | null): value is QualityLevel {
  return value !== null && (QUALITY_LEVELS as readonly string[]).includes(value);
}

export function loadQualityLevel(): QualityLevel {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLevel(stored) ? stored : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL; // storage can be disabled outright
  }
}

export function saveQualityLevel(level: QualityLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // not being able to remember the setting is not worth failing over
  }
}

export function nextQualityLevel(level: QualityLevel): QualityLevel {
  const i = QUALITY_LEVELS.indexOf(level);
  return QUALITY_LEVELS[(i + 1) % QUALITY_LEVELS.length]!;
}
