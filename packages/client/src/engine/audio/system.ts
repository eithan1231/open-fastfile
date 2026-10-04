// What the world sounds like, as one root beside the scene.
//
// Owns its own root rather than living in the built world, like `engine/fx/` and
// `net/corpses.ts` and for a reason with teeth: `THREE.PositionalAudio` writes its
// panner from `updateMatrixWorld`, and this repo turns exactly that off —
// `scene.matrixWorldAutoUpdate = false` in `engine/viewer.ts` and
// `matrixAutoUpdate = false` on every node in `WorldSession`'s freeze step. A
// voice added to the built world would play at the world origin for ever and say
// nothing about it. So nothing here ever enters the built world, and this drives
// its own matrices (docs/engine/audio.md#the-frozen-matrix-trap).
//
// The system is built and running whether or not the browser has let the context
// start. There is no second path for "once a click arrives": resuming a suspended
// context is all that happens then, so the code that plays a sound is the same
// code in both cases rather than one that only ever runs once and is never tested.

import * as THREE from "three";
import type { Vec3 } from "@3d/shared/sim/movement.js";
import { ambienceEntries, entryAudible, type AmbienceEntry, type SoundPlacement } from "./ambience.js";
import { audioContext, unlockOnGesture } from "./context.js";
import { resolveAlias, type SoundBank } from "./library.js";
import { Mixer, type AudioSettings, type Channel } from "./mixer.js";
import { voiceRequests, withinRange, type PlaySpec, type VoiceRequest } from "./requests.js";
import { RANGE_HYSTERESIS, VoicePool, type Voice } from "./voices.js";

/**
 * Where a decoded clip comes from: the session's `AssetStore`, handed in rather
 * than reached for.
 *
 * A decoded `AudioBuffer` is an asset like a texture — expensive, keyed by the
 * URL it came from, and freed when the world is left. Nothing here caches one.
 */
export interface ClipSource {
  audio(url: string): Promise<AudioBuffer | undefined>;
}

/** A world's sound, as `scene/sounds.ts` hands it over. */
export interface AttachedSounds {
  /**
   * In precedence order: the world's own table, then the catalogue's bank for
   * the game it was imported from. A world with no `sounds` node still gets the
   * second, which is where every footstep, landing and weapon lives.
   */
  banks: readonly SoundBank[];
  placements: readonly SoundPlacement[];
  clips: ClipSource;
  /** The game the catalogue bank in `banks` is for: the world's own, which `bankFor` is never asked for. */
  game?: string;
  /**
   * The catalogue's bank for another game, fetched on first need. A weapon plays
   * its own game's recordings wherever it is carried, and a world only brings
   * its own game's bank (`PlaySpec.game`).
   */
  bankFor?: (game: string) => Promise<SoundBank | undefined>;
}

export class AudioSystem {
  readonly root = new THREE.Group();
  readonly listener: THREE.AudioListener;

  private readonly mixer: Mixer;
  private readonly pool: VoicePool;
  private readonly stopUnlock: () => void;
  private entries: AmbienceEntry[] = [];
  private attached: AttachedSounds | undefined;
  /** Placements whose clips are in flight, so a slow fetch is not started again every frame. */
  private readonly pending = new Set<number>();
  /** Bumped on every world change: a fetch that lands after one must not start a voice into it. */
  private generation = 0;
  /** Other games' banks, by game: null for one that was asked for and is not there. */
  private readonly gameBanks = new Map<string, SoundBank | null>();
  private readonly loadingBanks = new Set<string>();
  private readonly eye = new THREE.Vector3();
  private at: Vec3 = { x: 0, y: 0, z: 0 };

  constructor() {
    this.root.name = "audio";
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrixWorld(true); // once: the root never moves, and the scene will not do it
    this.listener = new THREE.AudioListener();
    const context = audioContext();
    this.mixer = new Mixer(context, this.listener.gain);
    this.pool = new VoicePool(this.listener, this.root, this.mixer);
    this.stopUnlock = unlockOnGesture(context);
  }

  /** The listener rides the camera, so a turn of the head pans everything at once. */
  attachTo(camera: THREE.Camera): void {
    camera.add(this.listener);
  }

  get settings(): AudioSettings {
    return this.mixer.settings;
  }

  setVolume(channel: Channel | "master", value: number): void {
    this.mixer.setVolume(channel, value);
  }

  setMuted(muted: boolean): void {
    this.mixer.setMuted(muted);
  }

  /** How many voices are sounding, for the dev readout. */
  get voiceCount(): number {
    return this.pool.count;
  }

  /**
   * The voices themselves: what each is, how loud it is and where its panner is.
   *
   * For a test, which is the only way any of this is checked — there is no audio
   * device in CI and none on the machine this was written on, so what is asserted
   * is the graph and the numbers in it rather than anything anybody heard.
   */
  get voices(): readonly Voice[] {
    return this.pool.playing;
  }

  /**
   * Whether any attached bank holds this alias.
   *
   * For a caller choosing between spellings of one sound — a bullet impact is
   * `<family>_<surface>` and the bank is not square, so `bullet_large_snow` does
   * not exist and `bullet_large_default` does. Asking is cheaper than playing
   * and finding out, because `play` on a name nothing holds is silently nothing.
   */
  knows(alias: string, game?: string): boolean {
    const banks = this.banksFor(game);
    return banks !== undefined && resolveAlias(banks, alias) !== undefined;
  }

  /**
   * Start fetching `game`'s bank, if it is not the world's own and has not been
   * asked for. For a caller that knows a sound is coming — a weapon in hand —
   * so its first shot is not the one that waits for the table.
   */
  prepare(game: string): void {
    const sounds = this.attached;
    if (!sounds?.bankFor || game === sounds.game || this.gameBanks.has(game) || this.loadingBanks.has(game)) {
      return;
    }
    this.loadingBanks.add(game);
    const generation = this.generation;
    sounds
      .bankFor(game)
      .catch((error: unknown) => {
        console.warn(`[sound] no catalogue bank for ${game} (${error instanceof Error ? error.message : String(error)}); its weapons are silent here`);
        return undefined;
      })
      .then((bank) => {
        if (generation === this.generation) {
          this.gameBanks.set(game, bank ?? null);
          this.loadingBanks.delete(game);
        }
      });
  }

  /** What the world's ambience came to: its placements and how many resolved to a voice. */
  get ambienceCount(): { placements: number; resolved: number } {
    return { placements: this.entries.length, resolved: this.entries.filter((e) => e.requests.length > 0).length };
  }

  /**
   * Take over a world's ambience, replacing whatever was playing.
   *
   * Nothing starts here: `update` starts what is in earshot on the first frame,
   * which is also what starts a loop when the player walks up to it later. One
   * rule rather than two.
   */
  attach(sounds: AttachedSounds): void {
    this.clear();
    this.attached = sounds;
    this.entries = ambienceEntries(sounds.placements, sounds.banks);
  }

  /**
   * Follow the listener: retire what has finished, start what has come into
   * earshot and stop what has left it.
   */
  update(_dt: number, camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    // three writes the listener's position and orientation from its own matrix,
    // and the camera is outside the scene's (disabled) matrix update.
    this.listener.updateMatrixWorld(true);
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.at = { x: this.eye.x, y: this.eye.y, z: this.eye.z };
    this.pool.reap(this.at);
    this.followAmbience();
  }

  /**
   * Play one alias. **The seam everything that is not world ambience comes
   * through** — a footstep, a weapon, a script's feedback.
   *
   * `random` is taken rather than drawn so a sound both ends derive picks the
   * same clip from the same seed: a footstep is never sent, it is worked out
   * (docs/engine/audio.md#diegetic-sound-costs-no-wire).
   */
  play(spec: PlaySpec, random: () => number = Math.random): void {
    const banks = this.banksFor(spec.game);
    if (!banks) {
      return;
    }
    for (const request of voiceRequests(spec, banks, random)) {
      void this.startVoice(request, -1);
    }
  }

  /** A sound somewhere in the world. Beyond the alias' max distance nothing is started at all. */
  playAt(alias: string, position: Vec3, options: Omit<PlaySpec, "alias" | "position" | "atListener"> = {}, random?: () => number): void {
    this.play({ ...options, alias, position }, random);
  }

  /**
   * A sound the local player's own body or weapon makes, or one a script says out
   * loud. Played flat whatever the alias' `spatial` says — see `PlaySpec.atListener`.
   */
  playAtListener(alias: string, options: Omit<PlaySpec, "alias" | "position" | "atListener"> = {}, random?: () => number): void {
    this.play({ ...options, alias, atListener: true }, random);
  }

  /** Resume the context now, for a caller that knows it is inside a user gesture. */
  unlock(): void {
    void audioContext()
      .resume()
      .catch(() => undefined);
  }

  /** Everything stops and the world's ambience is forgotten. The buffers belong to the AssetStore. */
  clear(): void {
    this.generation++;
    this.pending.clear();
    this.pool.clear();
    this.entries = [];
    this.attached = undefined;
    this.gameBanks.clear();
    this.loadingBanks.clear();
  }

  /**
   * The tables a sound of `game` resolves against: that game's own bank first,
   * when it is not the world's, then the world's. Its own first because a name
   * two games share is two recordings, and a rifle keeps its own.
   */
  private banksFor(game: string | undefined): readonly SoundBank[] | undefined {
    const sounds = this.attached;
    if (!sounds) {
      return undefined;
    }
    if (game === undefined || game === sounds.game) {
      return sounds.banks;
    }
    this.prepare(game);
    const own = this.gameBanks.get(game);
    return own ? [own, ...sounds.banks] : sounds.banks;
  }

  dispose(): void {
    this.clear();
    this.stopUnlock();
    this.listener.removeFromParent();
  }

  private followAmbience(): void {
    const owners = this.pool.activeOwners();
    for (const entry of this.entries) {
      const id = entry.placement.id;
      const pending = this.pending.has(id);
      const live = pending || owners.has(id);
      // Slack only while it is already playing, so standing on the boundary does
      // not start and stop the loop on alternate frames.
      const wanted = entryAudible(entry, this.at, live ? RANGE_HYSTERESIS : 1);
      if (wanted && !live) {
        this.startEntry(entry);
      } else if (!wanted && !pending) {
        this.pool.stopOwned(id);
      }
    }
  }

  private startEntry(entry: AmbienceEntry): void {
    const id = entry.placement.id;
    this.pending.add(id);
    void Promise.all(entry.requests.map((request) => this.startVoice(request, id))).finally(() => this.pending.delete(id));
  }

  /**
   * Fetch this request's clip if need be, then start it.
   *
   * The range check comes **before** the fetch: a sound past its own max distance
   * is not a quiet sound, it is no sound, and it costs no round trip either. It
   * is checked again afterwards, because a clip takes long enough to arrive that
   * the player can have walked out of earshot by then.
   */
  private async startVoice(request: VoiceRequest, owner: number): Promise<void> {
    const sounds = this.attached;
    if (!sounds || !withinRange(request, this.at)) {
      return;
    }
    const generation = this.generation;
    const buffer = await sounds.clips.audio(request.url);
    if (!buffer || generation !== this.generation || !withinRange(request, this.at, RANGE_HYSTERESIS)) {
      return;
    }
    this.pool.start(request, buffer, this.at, owner);
  }
}
