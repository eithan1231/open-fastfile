// `ResolvedWorld.sounds` -> what the runtime needs: the alias tables, the
// placements, and every clip the ambience will ask for, decoded.
//
// The build half only; engine/audio/ does the playing. Buffers come from the
// world's AssetStore, so leaving the world frees them with everything else and a
// hot reload re-decodes only what changed — the catalogue's clips included, which
// CLAUDE.md is explicit about: a catalogue asset is not exempt from the session's
// ownership, and re-fetching one costs a warm HTTP cache where not freeing it
// costs a leak nothing can find.

import type { GameKey, ResolvedSound, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { ambienceClipUrls, ambienceEntries, type SoundPlacement } from "../engine/audio/ambience.js";
import { readSoundLibrary, type SoundBank } from "../engine/audio/library.js";
import type { AttachedSounds } from "../engine/audio/system.js";
import type { AssetStore } from "./assets.js";
import { soundClipUrl, soundLibraryUrl, type SoundHome } from "./assetUrl.js";

export function soundPlacements(sounds: readonly ResolvedSound[]): SoundPlacement[] {
  return sounds.map((s) => ({
    id: s.id,
    alias: s.alias,
    // Copied only when there is one: `undefined` is the world's bed, not the origin.
    position: s.position ? { x: s.position.x, y: s.position.y, z: s.position.z } : undefined,
    volume: s.volume,
    range: s.range,
    delay: s.delay,
  }));
}

/** One table, fetched and parsed, with the URL builder for its own clips bound to it. */
async function readBank(home: SoundHome, label: string): Promise<SoundBank> {
  const url = soundLibraryUrl(home);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return { library: readSoundLibrary(await response.json(), label), clipUrl: (file) => soundClipUrl(home, file) };
}

/**
 * Fetch the alias tables a world resolves names against, and decode every clip
 * its own ambience names.
 *
 * Two tables, in precedence order: the world's own `sounds` node, then the
 * catalogue's bank for the game it was imported from. Either may be absent — a
 * hand-written world has no game, most worlds have no `sounds` node yet — and
 * undefined comes back only when there is neither.
 *
 * The *ambience* clips are waited for rather than trickled in: a map's ambience
 * is a couple of megabytes of Opus, and a world that comes up silent and fades in
 * over the next few seconds reads as a bug in the engine rather than a load still
 * running. The catalogue's 556 clips are not — a footstep fetches its own the
 * first time it is played, because nothing knows in advance which surfaces a
 * player will walk on.
 */
export async function buildSounds(world: ResolvedWorld, baseUrl: string, assets: AssetStore): Promise<AttachedSounds | undefined> {
  const banks: SoundBank[] = [];
  if (world.soundLibrary) {
    // `baseUrl` is a site-relative prefix like "/worlds/dome-mw3/", so it is
    // concatenated as everything else in scene/ does; `new URL(x, baseUrl)` throws
    // on a relative base.
    banks.push(await readBank({ base: baseUrl, source: world.soundLibrary.source }, world.soundLibrary.source));
  }
  if (world.game) {
    // Never fatal, and deliberately not: a deployment with no catalogue built
    // still has a world to walk around and its own ambience to hear, exactly as
    // the weapon catalogue degrades. What is lost is footsteps.
    try {
      banks.push(await readBank({ game: world.game satisfies GameKey }, `catalog/sounds/${world.game}`));
    } catch (error) {
      console.warn(`[sound] no catalogue bank for ${world.game} (${error instanceof Error ? error.message : String(error)}); no footsteps or weapons`);
    }
  }
  if (banks.length === 0) {
    return undefined;
  }

  const placements = soundPlacements(world.sounds);
  // The same entries the system will derive, used here only to know which clips
  // there are: seeded by placement, so this list is the whole of what the
  // ambience can ask for and there is no second fetch once the world is up.
  await Promise.all(ambienceClipUrls(ambienceEntries(placements, banks)).map((url) => assets.audio(url)));
  // Another game's bank is fetched when something of that game first sounds —
  // a weapon carried onto this map — and resolves its clips like this world's.
  const bankFor = (game: string) => readBank({ game }, `catalog/sounds/${game}`);
  return { banks, placements, clips: assets, game: world.game, bankFor };
}
