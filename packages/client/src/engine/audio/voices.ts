// The voice pool: a fixed number of `THREE.Audio`/`THREE.PositionalAudio`
// objects, reused.
//
// A voice is not an asset. The `AudioBuffer` it is pointed at belongs to the
// session's `AssetStore`; killing a voice frees nothing and is meant not to. The
// cap is here because two hundred footsteps is not a mixing problem to solve with
// a limiter, it is a number of `PannerNode`s the browser will not give us — and
// the hard `maxDistance` cut in requests.ts does most of that work for free.

import * as THREE from "three";
import type { Vec3 } from "@3d/shared/sim/movement.js";
import type { Mixer } from "./mixer.js";
import { distanceFrom, type VoiceRequest } from "./requests.js";

/** How many voices may sound at once, over every channel. */
export const VOICE_CAP = 48;

/** Past its own `maxDistance` a loop is stopped, with this much slack so the boundary does not chatter. */
export const RANGE_HYSTERESIS = 1.08;

const _scratch = new THREE.Vector3();

/** `THREE.Audio` for a flat voice, `THREE.PositionalAudio` for one in the world — they differ only in their output node. */
export type VoiceAudio = THREE.Audio<AudioNode>;

export interface Voice {
  readonly audio: VoiceAudio;
  readonly request: VoiceRequest;
  /** Whoever asked for it, so an owner can stop what it started. -1 for a one-shot nobody tracks. */
  owner: number;
}

/**
 * Linear attenuation, as `distanceModel: "linear"` defines it.
 *
 * Reimplemented here rather than read back off the panner, because it is what the
 * pool steals by and a `PannerNode` will not tell you its own current gain.
 * `inverse` — Web Audio's default — is deliberately not used anywhere: it never
 * reaches zero, and a footstep heard faintly from 200 m is a bug that sounds like
 * a setting.
 */
export function linearAttenuation(distance: number, range: readonly [number, number]): number {
  const [ref, max] = range;
  if (max <= ref) {
    return distance <= ref ? 1 : 0;
  }
  const d = Math.min(Math.max(distance, ref), max);
  return 1 - (d - ref) / (max - ref);
}

export class VoicePool {
  private readonly live: Voice[] = [];
  private readonly freeFlat: VoiceAudio[] = [];
  private readonly freePositional: THREE.PositionalAudio[] = [];

  constructor(
    private readonly listener: THREE.AudioListener,
    private readonly root: THREE.Object3D,
    private readonly mixer: Mixer,
    private readonly cap = VOICE_CAP,
  ) {}

  get count(): number {
    return this.live.length;
  }

  /** Every voice sounding now, for the debug readout and for a test to assert on. */
  get playing(): readonly Voice[] {
    return this.live;
  }

  /** Which owners still have a voice, so the ambience knows what it need not start again. */
  activeOwners(): Set<number> {
    return new Set(this.live.map((voice) => voice.owner));
  }

  /**
   * Start `request` on `buffer`.
   *
   * Returns undefined when the pool is full of louder voices, which is a refusal
   * and not a failure: the sound that would have been quietest at the listener is
   * the one nobody notices missing.
   */
  start(request: VoiceRequest, buffer: AudioBuffer, listener: Vec3, owner = -1): Voice | undefined {
    if (this.live.length >= this.cap && !this.steal(request, listener)) {
      return undefined;
    }
    const audio: VoiceAudio = request.position === undefined ? this.takeFlat() : this.takePositional(request);
    audio.setBuffer(buffer);
    audio.setLoop(request.loop);
    audio.setVolume(request.volume);
    audio.setPlaybackRate(request.rate);
    // The mixer, not the listener: a voice rerouted here is a voice a channel
    // slider can still turn down while it plays.
    audio.gain.disconnect();
    audio.gain.connect(this.mixer.input(request.channel));
    // A loop starts part-way in, so nineteen copies of one clip are not one
    // clip nineteen times as loud. A one-shot with a negative delay is already
    // that far in, which is what an `effect`'s negative delay means too.
    audio.offset = request.loop ? request.phase * buffer.duration : Math.max(-request.delay, 0);
    const position = request.position;
    if (position && audio instanceof THREE.PositionalAudio) {
      audio.position.set(position.x, position.y, position.z);
    }
    audio.play(Math.max(request.delay, 0));
    if (position && audio instanceof THREE.PositionalAudio) {
      // After `play`, never before: `PositionalAudio.updateMatrixWorld` writes
      // nothing at all while the voice is stopped, so a voice positioned first
      // and started second plays at the origin until the next frame. And the
      // panner is snapped rather than ramped, or a voice 40 m out sweeps in from
      // the origin over the first frame.
      audio.updateMatrixWorld(true);
      snapPanner(audio);
    }
    const voice: Voice = { audio, request, owner };
    this.live.push(voice);
    return voice;
  }

  stop(voice: Voice): void {
    const index = this.live.indexOf(voice);
    if (index < 0) {
      return;
    }
    this.live.splice(index, 1);
    this.retire(voice);
  }

  /** Everything `owner` started. */
  stopOwned(owner: number): void {
    for (const voice of this.live.filter((v) => v.owner === owner)) {
      this.stop(voice);
    }
  }

  /** Retire the one-shots that have finished and the loops that have gone out of earshot. */
  reap(listener: Vec3): void {
    for (const voice of [...this.live]) {
      const done = !voice.audio.isPlaying;
      const gone = voice.request.loop && !this.audibleFrom(voice, listener);
      if (done || gone) {
        this.stop(voice);
      }
    }
  }

  private audibleFrom(voice: Voice, listener: Vec3): boolean {
    const distance = distanceFrom(voice.request, listener);
    return distance === undefined || distance <= voice.request.range[1] * RANGE_HYSTERESIS;
  }

  /** What this voice is actually heard at: its own volume, its channel's, and the distance. */
  loudness(voice: Voice, listener: Vec3): number {
    const distance = distanceFrom(voice.request, listener);
    const attenuation = distance === undefined ? 1 : linearAttenuation(distance, voice.request.range);
    return voice.request.volume * this.mixer.gainOf(voice.request.channel) * attenuation;
  }

  /** Make room for `request` by taking the quietest voice, if `request` would be louder than it. */
  private steal(request: VoiceRequest, listener: Vec3): boolean {
    let quietest: Voice | undefined;
    let quietestGain = Infinity;
    for (const voice of this.live) {
      const gain = this.loudness(voice, listener);
      if (gain < quietestGain) {
        quietest = voice;
        quietestGain = gain;
      }
    }
    const distance = distanceFrom(request, listener);
    const attenuation = distance === undefined ? 1 : linearAttenuation(distance, request.range);
    if (!quietest || request.volume * this.mixer.gainOf(request.channel) * attenuation <= quietestGain) {
      return false;
    }
    this.stop(quietest);
    return true;
  }

  private retire(voice: Voice): void {
    const audio = voice.audio;
    if (audio.isPlaying) {
      audio.stop();
    }
    // The buffer belongs to the session's AssetStore; a retired voice must not be
    // the last thing holding one after the world it came from is gone.
    audio.buffer = null;
    audio.offset = 0;
    this.root.remove(audio);
    if (audio instanceof THREE.PositionalAudio) {
      this.freePositional.push(audio);
    } else {
      this.freeFlat.push(audio);
    }
  }

  private takeFlat(): VoiceAudio {
    const audio = this.freeFlat.pop() ?? new THREE.Audio(this.listener);
    this.root.add(audio);
    return audio;
  }

  private takePositional(request: VoiceRequest): THREE.PositionalAudio {
    const audio = this.freePositional.pop() ?? new THREE.PositionalAudio(this.listener);
    // `linear` and never `inverse`: see linearAttenuation above. `max` is the end
    // of the curve *and* the hard cap, which requests.ts enforces before we get here.
    audio.setDistanceModel("linear");
    audio.setRolloffFactor(1);
    audio.setRefDistance(request.range[0]);
    audio.setMaxDistance(Math.max(request.range[1], request.range[0] + 0.01));
    this.root.add(audio);
    return audio;
  }

  /** Stop everything, keeping the objects: a world change, a hot reload, leaving the page. */
  clear(): void {
    for (const voice of [...this.live]) {
      this.stop(voice);
    }
  }
}

/**
 * Write the panner where the object already is, with no ramp.
 *
 * three ramps over `listener.timeDelta` so a moving source glides, which is right
 * every frame but the first: a voice starting 40 m away would sweep in from the
 * origin.
 */
function snapPanner(audio: THREE.PositionalAudio): void {
  const { panner } = audio;
  const p = _scratch.setFromMatrixPosition(audio.matrixWorld);
  panner.positionX.cancelScheduledValues(0);
  panner.positionY.cancelScheduledValues(0);
  panner.positionZ.cancelScheduledValues(0);
  panner.positionX.value = p.x;
  panner.positionY.value = p.y;
  panner.positionZ.value = p.z;
}
