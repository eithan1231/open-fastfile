// What to play, decided once: an alias and a place become a list of voices with
// nothing left to sample.
//
// Pure, and split out of the engine for that reason — everything that could be
// got subtly wrong (the weighting, the `with` layer, which sounds are flat, the
// hard distance cap) is decided here, where a test can see it without an audio
// device.

import type { Vec3 } from "@3d/shared/sim/movement.js";
import { pickClip, resolveAlias, sampleRange, type SoundAlias, type SoundBank } from "./library.js";
import type { Channel } from "./mixer.js";

/**
 * The game's own `mixerGroup`, where it named one.
 *
 * Only these three are honoured, because only these three are in the dump — and
 * they win over the caller, which is the point of the game having said so. The
 * rest is assigned by whatever raised the sound: a footstep is a footstep
 * because the footstep code played it, not because of anything in its row. Dome
 * is the case that matters — none of its 23 ambience aliases names a group, so
 * without the caller's fallback the whole map's ambience plays on `sfx` and the
 * ambience slider does nothing.
 */
const MIXER_GROUPS: Record<string, Channel> = { weapons: "sfx", ambience: "ambience", mission: "voice" };

/** What a caller asks for. */
export interface PlaySpec {
  alias: string;
  /**
   * Where it plays, world space. **Undefined is not the origin** — it is the
   * world's bed, or a sound with no place in the world at all.
   */
  position?: Vec3;
  /**
   * Emitted by the listener's own body.
   *
   * Played flat whatever the alias says: a `PannerNode` at zero distance has no
   * well-defined direction and attenuates by nothing anyway, so the positional
   * path buys nothing and risks an unstable pan. This is the rule that makes the
   * game's own `_plr` inconsistency stop mattering — `step_run_plr_dirt` carries
   * an ordinary short distance and `step_walk_plr_*` does not, and neither fact
   * has to be remembered anywhere (docs/engine/audio.md#_plr-is-not-the-test-for-non-positional).
   */
  atListener?: boolean;
  /** Scales the alias' own volume. */
  volume?: number;
  /** Metres, replacing the alias' own pair. */
  range?: readonly [number, number];
  /** Seconds. Negative starts it already that far in. */
  delay?: number;
  /** Which channel, for an alias whose row names no mixer group of its own. */
  channel?: Channel;
  /**
   * The game whose catalogue bank this sound belongs to, when that may not be
   * the world's: a weapon carried onto another game's map. Looked in first.
   */
  game?: string;
}

/** One voice to start. Every number here is final. */
export interface VoiceRequest {
  alias: string;
  /**
   * Where the clip is, already resolved against the bank that held the alias —
   * a world's own `assets/sounds/`, or the catalogue's. Built in
   * `scene/assetUrl.ts` and nowhere else, which is what keeps the key an
   * `AssetStore` holds byte-identical to the URL the route serves.
   */
  url: string;
  volume: number;
  /** `playbackRate`. */
  rate: number;
  /** Metres: `[refDistance, maxDistance]`. `maxDistance` is a hard cap, not the end of a curve. */
  range: readonly [number, number];
  loop: boolean;
  /** Undefined: flat — no panner, no attenuation, no cull. */
  position?: Vec3;
  channel: Channel;
  /** Seconds before it starts; negative means it starts already that far in. */
  delay: number;
  /**
   * Where in the clip a loop starts, 0..1 of its length.
   *
   * Drawn for every request whether or not it loops, so one alias' stream does
   * not depend on the other's `loop` flag. Dome has nineteen identical chainlink
   * loops within earshot of each other: started in phase they are a comb filter,
   * not ambience.
   */
  phase: number;
}

/**
 * The voices `spec` comes to, including its `with` layer.
 *
 * `rand` is drawn from in a fixed order — clip, volume, pitch, phase — so the
 * same seed gives the same voice. The layer is resolved one level deep and no
 * further: `with` is the exporter's closure over a pair, and a chain of them is
 * not a thing the bank contains.
 */
export function voiceRequests(spec: PlaySpec, banks: readonly SoundBank[], rand: () => number): VoiceRequest[] {
  const out: VoiceRequest[] = [];
  const found = resolveAlias(banks, spec.alias);
  if (!found) {
    return out;
  }
  const primary = voiceRequest(spec.alias, found.alias, found.bank, spec, rand);
  if (primary) {
    out.push(primary);
  }
  if (found.alias.with !== undefined) {
    // Resolved against every bank again rather than against the one that held
    // the primary: a world's ambience may layer in an alias only the catalogue
    // holds, and the exporter's closure covers one table at a time.
    const layer = resolveAlias(banks, found.alias.with);
    // The layer plays where the primary does and is scaled with it, but keeps its
    // own reach: a rifle's distant-report tail carries much further than the shot.
    const layered = layer ? voiceRequest(found.alias.with, layer.alias, layer.bank, { ...spec, range: undefined }, rand) : undefined;
    if (layered) {
      out.push(layered);
    }
  }
  return out;
}

function voiceRequest(name: string, alias: SoundAlias, bank: SoundBank, spec: PlaySpec, rand: () => number): VoiceRequest | undefined {
  const clip = pickClip(alias.clips, rand());
  if (!clip) {
    return undefined;
  }
  const volume = sampleRange(alias.volume, rand()) * (spec.volume ?? 1);
  const rate = sampleRange(alias.pitch, rand());
  const phase = rand();
  // A sound at the listener is flat whatever `spatial` says; a sound with no
  // position has nowhere to be panned from in the first place.
  const flat = spec.atListener === true || spec.position === undefined || !alias.spatial;
  return {
    alias: name,
    url: bank.clipUrl(clip.file),
    volume,
    rate,
    range: spec.range ?? alias.range,
    loop: alias.loop,
    position: flat ? undefined : spec.position,
    channel: MIXER_GROUPS[alias.channel ?? ""] ?? spec.channel ?? "sfx",
    delay: (spec.delay ?? 0) + alias.delay,
    phase,
  };
}

/**
 * How far away a request is, or `undefined` for a flat one, which has no distance.
 */
export function distanceFrom(request: VoiceRequest, listener: Vec3): number | undefined {
  const p = request.position;
  return p === undefined ? undefined : Math.hypot(p.x - listener.x, p.y - listener.y, p.z - listener.z);
}

/**
 * Whether this voice may start at all.
 *
 * `range[1]` is a hard cap: past it there is no voice, no panner and no fetch. A
 * footstep across the map is not a very quiet footstep. `slack` is the pool's
 * hysteresis for a loop already playing, so standing on the boundary does not
 * start and stop it every frame.
 */
export function withinRange(request: VoiceRequest, listener: Vec3, slack = 1): boolean {
  const distance = distanceFrom(request, listener);
  return distance === undefined || distance <= request.range[1] * slack;
}
