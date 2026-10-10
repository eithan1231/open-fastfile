// The noise a held weapon makes: a round leaving, a magazine coming out, a
// bullet arriving. Derived from state both ends already hold, never sent.
//
// The same seam `sim/footsteps.ts` has, for the same reason. Every input is
// already in a snapshot — `WeaponData.fired` is a 16-bit shot counter that
// advances once per round, and `WeaponData.clip` carries which clip is playing
// and how far into it — so a client works out that a shot or a magazine change
// happened exactly the way a server would, and nothing new goes on the wire
// (docs/engine/audio.md#diegetic-sound-costs-no-wire).
//
// Here rather than in the client because it is a function of simulation state
// and nothing else. What the client owns is *playing* it
// (client/engine/audio/weapons.ts) — this module names no alias table, touches
// no audio and knows nothing about distance.

import type { SurfaceType } from "./surfaces.js";
import type { WeaponData } from "./weapon.js";
import type { WeaponDef, WeaponSounds } from "./weaponDef.js";

/**
 * The most rounds one observation may report.
 *
 * A guard and not a rate limit. `fired` starts again at zero on a respawn or a
 * weapon swap, and the wrap-safe difference across that is 65,000-odd rounds —
 * a magazine emptied in one frame, which is what a plausible wrong result
 * sounds like. Sixteen is far more than any weapon fires in the 50 ms a viewer
 * frame or a snapshot covers (the fastest here is 1,200 rpm, which is one), so
 * anything above it is bookkeeping rather than shooting.
 *
 * It bounds the counter going *backwards* too, and the two are the same
 * question asked from either side: a correction can only put it back by the
 * rounds this client predicted ahead of the server, which is a few, and a reset
 * is tens of thousands.
 */
export const MAX_SHOTS_PER_OBSERVATION = 16;

/** One thing a weapon did that is worth hearing. */
export interface WeaponEvent {
  /**
   * `fire` is a round leaving, `note` a notetrack in the clip that is playing
   * — a magazine out, a magazine in, a bolt closing, a gun lifted.
   */
  kind: "fire" | "note";
  /** The alias, already spelled. Whether a bank holds it is the player's problem. */
  alias: string;
  /**
   * Which round of this weapon's life it was, for the seeded draw. A notetrack
   * has no ordinal of its own and reports the shot count as it stood, which is
   * enough to keep two reloads from drawing the same recording.
   */
  ordinal: number;
}

/** What a weapon sounds like firing, in whichever of the two families the listener is in. */
export function fireAlias(sounds: WeaponSounds | undefined, own: boolean): string | undefined {
  return own ? sounds?.firePlayer : sounds?.fire;
}

/** What somebody else's reload sounds like: one alias for the whole thing, as the game plays it for a body. */
export function reloadAlias(sounds: WeaponSounds | undefined, empty: boolean): string | undefined {
  return (empty ? sounds?.reloadEmpty : sounds?.reload) ?? sounds?.reload;
}

/**
 * What a round of this weapon arriving somewhere sounds like, best first.
 *
 * Two candidates rather than one, because the bank is not square: `bullet_large`
 * has 29 of the engine's 31 surfaces, `bullet_small` 30 and `bullet_ap` all 31 —
 * an M4 hitting snow or water has no alias of its own. So the exact surface
 * first and the family's own `default` behind it, and the caller plays the first
 * its bank holds. A weapon whose `impactType` names no family at all (`shotgun`,
 * which six of Modern Warfare 3's guns carry and the bank has nothing for) gets
 * neither, which is silence.
 */
export function impactAliases(sounds: WeaponSounds | undefined, surface: SurfaceType): string[] {
  const impact = sounds?.impact;
  if (impact === undefined) {
    return [];
  }
  return surface === "default" ? [`${impact}_default`] : [`${impact}_${surface}`, `${impact}_default`];
}

/**
 * Where a clip's first pass is measured from.
 *
 * Not 0: the interval below is half-open at its start, so a notetrack at exactly
 * 0 — an L96A1's magazine lift is one — would never be crossed. This is
 * `WeaponController.play`'s own `emitNotes(-1, 0)`, said on this side of the
 * seam so that the two ends agree about the first frame of a clip.
 */
const CLIP_START = -1;

/**
 * How far a playhead may appear to have gone backwards without having moved.
 *
 * **A predicted clip time is not monotonic, and that is the wire and not a bug.**
 * `clip.time` travels as `quant(0, 32, 14)` (net/messages/player.ts), a grid of
 * about 2 ms; a correction restores the server's quantised value and the client
 * replays from *that*, so the playhead is snapped up or down by up to half a
 * step on every snapshot — twenty times a second. Measured against the last
 * observation, each of those snaps re-crossed every notetrack behind it, which
 * is a reload's whole foley arriving again 20 times a second.
 *
 * Two steps, so the margin is the snap's and not exactly its bound. Nothing real
 * hides under it: the closest two notetracks in the catalogue are 33 ms apart,
 * and a clip that has genuinely started again is hundreds of milliseconds back.
 */
export const CLIP_TIME_GRAIN = (2 * 32) / (2 ** 14 - 1);

/** Mixed into the seed so one shot's draws are not the next one's. Arbitrary odd constants, as `stepStream`'s are. */
const SHOT_SOUND_STREAM = 0x9e3779b1;
const NOTE_STREAM = 0x85ebca6b;

/**
 * The stream one weapon sound's clip, volume and pitch are drawn from: the
 * body's own seed, mixed with which round it was and which layer of it this is.
 *
 * `shotStream`'s shape, and `stepStream`'s reasons. `layer` separates the shot
 * from the impact it caused, which are two draws off one round.
 */
export function weaponStream(seed: number, ordinal: number, layer: number): number {
  return (seed ^ Math.imul(ordinal + 1, SHOT_SOUND_STREAM) ^ Math.imul(layer + 2, NOTE_STREAM)) | 0;
}

/**
 * One weapon's noise, watched across the states it passes through.
 *
 * An *observer* of the simulation, holding the last state it saw and nothing
 * else — which is why none of this is in `WeaponData` and nothing here is on the
 * wire. One per player: the local player's own, stepped every frame off the
 * predicted state, and one per peer, stepped every snapshot off the state the
 * server sent.
 *
 * **Your own weapon and everybody else's are heard differently and that is the
 * game's own answer, not a simplification.** Your own reload is the `_plr`
 * notetracks its first-person clip carries — a magazine out at 0.37 s, in at
 * 1.23, the bolt at 1.73 on an M4 — because you are holding it. A peer's is the
 * single `_npc` alias the game plays for a body at a distance, whose own `with`
 * layer carries the magazine going back in. So the two paths differ in what they
 * read rather than in how loud they are.
 */
export class WeaponWatcher {
  /** What was being watched, so a swap or a respawn starts again rather than reporting a burst. */
  private held: unknown = undefined;
  private fired = 0;
  /** The clip playing, by the name it resolves to, and the playhead as last believed. */
  private pass: string | null = null;
  private reached = CLIP_START;
  /** Whether a peer was already reloading, so one reload is one alias and not one a snapshot. */
  private reloading = false;

  /** Forget what was seen: a respawn, a swap, a world change. */
  reset(): void {
    this.held = undefined;
    this.pass = null;
    this.reached = CLIP_START;
    this.reloading = false;
  }

  /**
   * What `data` says has happened since the last state this watcher saw.
   *
   * `key` is whatever identifies the weapon being held — a controller, a
   * catalogue index. It is compared and never read: a different one resets the
   * counters instead of reporting the difference, because `fired` starts again
   * at zero on a new weapon and subtracting across that invents a magazine.
   */
  observe(key: unknown, def: WeaponDef | undefined, data: Readonly<WeaponData> | undefined, own: boolean): WeaponEvent[] {
    const out: WeaponEvent[] = [];
    if (def === undefined || data === undefined || key === undefined || key === null) {
      this.reset();
      return out;
    }
    const started = key !== this.held;
    if (started) {
      this.held = key;
      this.fired = data.fired;
      this.pass = null;
      this.reached = CLIP_START;
      this.reloading = false;
    }

    const sounds = def.sounds;
    // Wrap-safe, as `Shots.fire` is: `fired` is a uint16 on both ends.
    const count = (data.fired - this.fired) & 0xffff;
    const before = this.fired;
    // **Held where it was through a correction**, for `notes`' reason and the
    // same failure: a server that had not fired this round yet puts the counter
    // back, the replay fires it again, and the round is heard twice. A counter
    // that has *started again* — a respawn, a swap — is a jump of tens of
    // thousands rather than of a magazine, and re-baselines instead.
    const rewound = (this.fired - data.fired) & 0xffff;
    if (rewound === 0 || rewound > MAX_SHOTS_PER_OBSERVATION) {
      this.fired = data.fired;
    }
    const fire = fireAlias(sounds, own);
    if (fire !== undefined && count > 0 && count <= MAX_SHOTS_PER_OBSERVATION) {
      for (let i = 0; i < count; i++) {
        out.push({ kind: "fire", alias: fire, ordinal: (before + i + 1) & 0xffff });
      }
    }

    // Your own gun only: every notetrack in the map is a `_plr` alias, and
    // playing one for a peer would put the listener's own magazine across the map.
    if (own) {
      this.notes(def, data, out, started);
    } else {
      this.remoteReload(def, data, out, started);
    }
    return out;
  }

  /**
   * The notetracks the playing clip crossed since the last observation.
   *
   * Half-open at the playhead as last believed and closed at this one, the same
   * rule `footfallsCrossed` uses and for the same reason: a note landing exactly
   * on the boundary sounds once.
   *
   * The playhead can also appear to move **backwards**, three ways that want
   * three different answers, and telling them apart is the whole of this. A snap
   * of the wire's own grid is not motion at all (`CLIP_TIME_GRAIN`). A loop has
   * come round, so the join is the tail of the old pass plus the head of the new.
   * A clip that does not loop has started again — a reload sprint-cancelled and
   * asked for again, a shotgun's next shell — and it is reported by what it
   * crosses from here, never by replaying what it has already sounded.
   */
  private notes(def: WeaponDef, data: Readonly<WeaponData>, out: WeaponEvent[], started: boolean): void {
    const clip = data.clip;
    // A pass is one playing of one *clip file*, not of one role: several roles
    // name the same clip — `adsFire` and `idle` are both `viewmodel_l96_idle` —
    // and `WeaponController.play` already refuses to restart one for another, so
    // a pass keyed on the role would see a change where nothing changed.
    const name = clip === null ? undefined : def.roles[clip.role];
    if (!clip || name === undefined) {
      this.pass = null;
      this.reached = CLIP_START;
      return;
    }
    const to = clip.time;
    const fresh = name !== this.pass;
    const back = this.reached - to;
    const snapped = !fresh && back > 0 && back <= CLIP_TIME_GRAIN;
    const looped = !fresh && back > CLIP_TIME_GRAIN && clip.loop;
    const restarted = !fresh && back > CLIP_TIME_GRAIN && !clip.loop;

    this.pass = name;
    const from = fresh ? CLIP_START : this.reached;
    // Held where it was through a snap, so the note it sits on is behind us for
    // good: this is the one line that keeps a correction from sounding a note
    // that has already sounded.
    if (!snapped) {
      this.reached = to;
    }

    // A weapon this watcher has not seen before is a baseline and not a pass:
    // `Player.restore` can rebuild a controller mid-reload, and the notes behind
    // that clip's playhead were heard by whoever was holding it.
    if (snapped || restarted || started) {
      return;
    }
    const info = def.clips[name];
    const map = def.sounds?.notes;
    if (!info || !map) {
      return;
    }
    for (const [note, at] of info.notes) {
      const alias = map[note];
      if (alias === undefined) {
        continue;
      }
      const crossed = looped ? at > from || at <= to : at > from && at <= to;
      if (crossed) {
        out.push({ kind: "note", alias, ordinal: this.fired });
      }
    }
  }

  /**
   * A peer's reload, as one alias on the tick the state is first seen.
   *
   * Not the notetracks above: those are the listener's own hands. `started`
   * suppresses it for the first observation of a weapon, because a peer who
   * comes into view mid-reload would otherwise start theirs from the beginning.
   */
  private remoteReload(def: WeaponDef, data: Readonly<WeaponData>, out: WeaponEvent[], started: boolean): void {
    const reloading = data.state === "reloading" || data.state === "reloadStart";
    const was = this.reloading;
    this.reloading = reloading;
    if (!reloading || was || started) {
      return;
    }
    // Empty is what the clip says, not the ammunition: `reloadEmpty` is the role
    // the state machine chose for this reload, and it already knows whether the
    // bolt has to be worked.
    const alias = reloadAlias(def.sounds, data.clip?.role === "reloadEmpty");
    if (alias !== undefined) {
      out.push({ kind: "note", alias, ordinal: this.fired });
    }
  }
}
