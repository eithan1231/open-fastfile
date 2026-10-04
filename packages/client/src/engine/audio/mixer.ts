// The mixer: one gain per channel into the listener's master gain, and the
// per-viewer preferences behind them.
//
//   master ─┬─ sfx        weapons, impacts, bodies
//           ├─ footsteps  its own, because it is the one people turn down
//           ├─ ambience   the world's loops and beds
//           ├─ voice      announcements, battle chatter
//           └─ ui         menus, countdowns, hitmarkers
//
// The channels are a viewer's own preference and never the server's, so they
// live in `localStorage` — and every read and write is wrapped, because a
// private window throws rather than returning nothing.

export const AUDIO_CHANNELS = ["sfx", "footsteps", "ambience", "voice", "ui"] as const;
export type Channel = (typeof AUDIO_CHANNELS)[number];

/** What a player has chosen. Volumes are 0..1 multipliers. */
export interface AudioSettings {
  master: number;
  muted: boolean;
  channels: Record<Channel, number>;
}

export function defaultAudioSettings(): AudioSettings {
  return { master: 0.8, muted: false, channels: { sfx: 1, footsteps: 1, ambience: 1, voice: 1, ui: 1 } };
}

const STORAGE_KEY = "3d.audio";

function clampVolume(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : undefined;
}

export function loadAudioSettings(): AudioSettings {
  const settings = defaultAudioSettings();
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) {
      return settings;
    }
    const parsed = JSON.parse(stored) as Partial<AudioSettings>;
    settings.master = clampVolume(parsed.master) ?? settings.master;
    settings.muted = parsed.muted === true;
    for (const channel of AUDIO_CHANNELS) {
      settings.channels[channel] = clampVolume(parsed.channels?.[channel]) ?? settings.channels[channel];
    }
  } catch {
    // Storage can be disabled outright, and the stored value can be anything.
  }
  return settings;
}

export function saveAudioSettings(settings: AudioSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not being able to remember a volume is not worth failing over.
  }
}

/**
 * The gains a voice is heard through.
 *
 * A voice connects to `input(channel)` rather than to the listener directly, so
 * turning a channel down turns down everything already playing on it — which is
 * the whole reason the channels exist rather than a multiplier at each call site.
 */
export class Mixer {
  private readonly gains: Record<Channel, GainNode>;
  private current: AudioSettings;

  constructor(
    context: BaseAudioContext,
    private readonly master: GainNode,
    settings: AudioSettings = loadAudioSettings(),
  ) {
    this.current = settings;
    this.gains = Object.fromEntries(
      AUDIO_CHANNELS.map((channel) => {
        const gain = context.createGain();
        gain.connect(master);
        return [channel, gain];
      }),
    ) as Record<Channel, GainNode>;
    this.apply();
  }

  /** Where a voice on `channel` connects. */
  input(channel: Channel): GainNode {
    return this.gains[channel];
  }

  get settings(): AudioSettings {
    return { ...this.current, channels: { ...this.current.channels } };
  }

  /** `"master"` or one channel, 0..1. Remembered per browser. */
  setVolume(channel: Channel | "master", value: number): void {
    const clamped = clampVolume(value) ?? 1;
    if (channel === "master") {
      this.current.master = clamped;
    } else {
      this.current.channels[channel] = clamped;
    }
    this.apply();
  }

  setMuted(muted: boolean): void {
    this.current.muted = muted;
    this.apply();
  }

  /**
   * What a voice on `channel` is actually heard at, which is what the pool steals
   * by: the quietest voice at the listener is the one nobody notices going.
   */
  gainOf(channel: Channel): number {
    return this.current.muted ? 0 : this.current.master * this.current.channels[channel];
  }

  private apply(): void {
    this.master.gain.value = this.current.muted ? 0 : this.current.master;
    for (const channel of AUDIO_CHANNELS) {
      this.gains[channel].gain.value = this.current.channels[channel];
    }
    saveAudioSettings(this.current);
  }
}
