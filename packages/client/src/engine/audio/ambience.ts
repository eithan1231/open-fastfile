// The world's own ambience: a `sound` placement, the voices it comes to, and
// whether they are in earshot right now.
//
// The pure half of it, so the two things that fail as silence — a bed pinned to a
// point in space, and a loop that is never started because the cap was read as a
// curve — are decided where a test can see them.

import { hashString, seeded } from "@3d/shared/game/random.js";
import type { Vec3 } from "@3d/shared/sim/movement.js";
import type { SoundBank } from "./library.js";
import { voiceRequests, withinRange, type VoiceRequest } from "./requests.js";

/** One `sound` node, resolved: where it plays and which alias it plays. */
export interface SoundPlacement {
  id: number;
  alias: string;
  /**
   * World space. **Undefined is not the origin** — a placement with no `at` is
   * the world's bed, non-positional and at full volume everywhere. Give one a
   * position and a map-wide ambience track plays from one corner of the map.
   */
  position?: Vec3;
  /** Scales the alias' own volume. */
  volume: number;
  /** Metres, replacing the alias' own pair. */
  range?: readonly [number, number];
  /** Seconds. Negative starts it already running. */
  delay: number;
}

/** A placement and what it plays, worked out once at load. */
export interface AmbienceEntry {
  placement: SoundPlacement;
  /** The primary voice and its `with` layer, if any. Empty for an alias no table holds. */
  requests: VoiceRequest[];
}

/**
 * What each placement plays, sampled once per load from its own id.
 *
 * Seeded rather than random, and seeded by the **placement**: the same fence
 * always picks the same rattle at the same pitch and the same phase, so a world
 * sounds the same each time it is entered, and dome's nineteen identical
 * chainlink loops are nineteen different offsets into one clip rather than one
 * clip nineteen times as loud.
 */
export function ambienceEntries(placements: readonly SoundPlacement[], banks: readonly SoundBank[]): AmbienceEntry[] {
  return placements.map((placement) => ({
    placement,
    requests: voiceRequests(
      // A world's `sound` is ambience by definition — the map's own loops and
      // beds — which is what the channel falls back to for the aliases (all 23 of
      // dome's) whose rows name no mixer group.
      { alias: placement.alias, position: placement.position, volume: placement.volume, range: placement.range, delay: placement.delay, channel: "ambience" },
      banks,
      seeded(hashString(`${placement.alias}:${placement.id}`)),
    ),
  }));
}

/**
 * Whether this placement should be sounding from where the listener stands.
 *
 * `slack` is the hysteresis for one already playing: without it, standing on the
 * boundary starts and stops the loop on alternate frames. A bed has no position
 * and is therefore always audible — which is the whole of the difference between
 * `undefined` and the origin.
 */
export function entryAudible(entry: AmbienceEntry, listener: Vec3, slack = 1): boolean {
  return entry.requests.some((request) => withinRange(request, listener, slack));
}

/** Every distinct clip URL the world's ambience will ever ask for, so a load can fetch them all at once. */
export function ambienceClipUrls(entries: readonly AmbienceEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.requests.map((request) => request.url)))];
}
