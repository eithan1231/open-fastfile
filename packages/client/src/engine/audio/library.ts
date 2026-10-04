// A world's alias table: what a name sounds like, and which of its clips a voice
// gets.
//
// The shape is `assets/sounds/sounds.json`, already in engine units — metres, a
// playbackRate, seconds — exactly as `docs/cod/audio.md` derives it. Nothing here
// touches three.js or Web Audio, so the picker and the parser run in a test with
// no audio device at all.

/** One recording an alias may pick. */
export interface SoundClip {
  /** The clip's path with **no extension**; `scene/assetUrl.ts` turns it into a URL. */
  file: string;
  /**
   * Unnormalised: the dump carries 3.0 beside 0.2 beside 1.0, and the same file
   * appears twice where the game wanted it twice as often. `pickClip` normalises
   * across an alias' own clips, so a table summing to 1 and one summing to 9 pick
   * alike.
   */
  weight: number;
}

/** An envelope over one name's variants: what it sounds like, never where it is. */
export interface SoundAlias {
  clips: SoundClip[];
  /** Multiplier, sampled per voice. */
  volume: readonly [number, number];
  /** `playbackRate`, sampled per voice. */
  pitch: readonly [number, number];
  /** Metres: full volume within the first, **never started** past the second. */
  range: readonly [number, number];
  loop: boolean;
  /** False ⇒ `THREE.Audio`, no panner. Derived by the exporter from the distance, never re-derived here. */
  spatial: boolean;
  /** Seconds before it starts. */
  delay: number;
  /**
   * The game's raw word. Only bit 0 has evidence (looping), and the exporter has
   * already read it into `loop`; nothing here interprets any of the rest.
   */
  flags: number;
  /** The game's own `mixerGroup`, absent where it named none. */
  channel?: string;
  /** Another alias to play alongside, one level deep. Absent where there is none. */
  with?: string;
}

export interface SoundLibrary {
  /** Which game it was dumped from, for the log. */
  game: string;
  /** Keyed by **lower-case** name: the game's own data spells `Land_plr_carpet` beside `land_plr_ceramic`. */
  aliases: Record<string, SoundAlias>;
}

const LIBRARY_VERSION = 1;

/**
 * Parse `sounds.json`, refusing a version this build does not know.
 *
 * The same rule `readFxLibrary` is built on: a silently-parsed future version
 * would read its renamed fields as zero, and a sound that never starts is
 * indistinguishable from an engine that cannot play it.
 */
export function readSoundLibrary(data: unknown, source: string): SoundLibrary {
  const d = data as { _version?: number; game?: string; aliases?: Record<string, SoundAlias> };
  if (d?._version !== LIBRARY_VERSION) {
    throw new Error(`${source}: sound library version ${String(d?._version)}, expected ${LIBRARY_VERSION}; re-export the world`);
  }
  const aliases: Record<string, SoundAlias> = {};
  for (const [name, row] of Object.entries(d.aliases ?? {})) {
    aliases[name.toLowerCase()] = row;
  }
  return { game: d.game ?? "", aliases };
}

/** An alias by name, case-insensitively — which is how the game's own data has to be read. */
export function aliasNamed(library: SoundLibrary, name: string): SoundAlias | undefined {
  return library.aliases[name.toLowerCase()];
}

/**
 * One table and where the clips it names are fetched from.
 *
 * Two are in play: the world's own `assets/sounds/`, and the catalogue's bank
 * for the game the world was imported from — footsteps, landings, weapons and
 * body foley, which belong to no one map. Which table held a name is what
 * decides where its clips come from, so the URL builder (`scene/assetUrl.ts`,
 * still the only place either becomes a URL) travels with the table.
 */
export interface SoundBank {
  library: SoundLibrary;
  clipUrl: (file: string) => string;
}

/**
 * The first bank that holds `name`, with the row it holds.
 *
 * **The world's own table wins**, and that order is measured rather than
 * arbitrary: ten of the aliases a map zone defines are genuinely *different*
 * recordings from one map to the next — `emt_mtl_chainlink_rattle_ext` and
 * seven other `emt_*`, plus two `fx_electransformer_spark_*`, compared across
 * dome, paris, seatown and village. A world that ships one has to keep it, or
 * dome's fence rattles with paris' recording once the same name reaches the
 * catalogue. The catalogue is the fallback, and holds what no map has at all.
 */
export function resolveAlias(banks: readonly SoundBank[], name: string): { alias: SoundAlias; bank: SoundBank } | undefined {
  for (const bank of banks) {
    const alias = aliasNamed(bank.library, name);
    if (alias) {
      return { alias, bank };
    }
  }
  return undefined;
}

/**
 * Which clip a voice gets, for `r` in [0, 1).
 *
 * Pure, and takes its random rather than drawing one: a footstep both ends
 * derive has to pick the same recording from the same seed, and `Math.random`
 * inside here would make that impossible to arrange from outside.
 */
export function pickClip(clips: readonly SoundClip[], r: number): SoundClip | undefined {
  if (clips.length === 0) {
    return undefined;
  }
  let total = 0;
  for (const clip of clips) {
    total += Math.max(clip.weight, 0);
  }
  const u = Math.min(Math.max(r, 0), 1 - Number.EPSILON);
  // Every weight zero or negative is still a choice between the clips, not silence.
  if (total <= 0) {
    return clips[Math.floor(u * clips.length)];
  }
  let x = u * total;
  for (const clip of clips) {
    x -= Math.max(clip.weight, 0);
    if (x < 0) {
      return clip;
    }
  }
  return clips[clips.length - 1];
}

/** A value from a `[min, max]` pair, for `r` in [0, 1). */
export function sampleRange(range: readonly [number, number], r: number): number {
  return range[0] + (range[1] - range[0]) * Math.min(Math.max(r, 0), 1);
}
