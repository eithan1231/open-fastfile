// Playing what the actors are doing: a creature's voice and its swing, derived
// from the snapshots that already carry it rather than sent.
//
// The deciding is `@3d/shared/game/actors/sounds.ts`; this half is the browser's.
// Which alias a role is comes from the actor's kind, which names one game's bank,
// so a zombie keeps its own recordings on another game's map, as a weapon does
// (`PlaySpec.game`). Each is played out in the world at the actor, on `sfx`, and
// culled by the alias' own maximum distance like a peer's footstep.
//
// Off the snapshot and not off a frame, as a peer's footsteps are: it is the
// server's own tick state, so a swing is heard as it begins however the frames
// fall.

import type { ActorId, ActorState } from "@3d/shared/game/actors/actor.js";
import { ACTOR_KINDS } from "@3d/shared/game/actors/kinds.js";
import { actorSoundsBetween, vocalGap, vocalRole, type ActorSoundRole } from "@3d/shared/game/actors/sounds.js";
import type { AudioSystem } from "./system.js";

/** How high on its body an actor's voice comes from, as a share of its height: about the mouth. */
const MOUTH = 0.9;

interface Tracked {
  last: ActorState;
  /** When its next noise of its own is due, in the caller's seconds. */
  vocalAt: number;
  /** How many it has made: what the next gap is drawn from. */
  vocals: number;
}

export class ActorVoices {
  private readonly tracked = new Map<ActorId, Tracked>();
  /** The highest id seen this match: ids count up, so one above it is an arrival. */
  private highest = 0;
  /** The first snapshot of a match is what was already there, not a room full of arrivals. */
  private baseline = true;

  constructor(private readonly audio: AudioSystem) {}

  /** One snapshot's actors, at `now` seconds on any clock that only goes forward. */
  apply(actors: readonly ActorState[], now: number): void {
    const present = new Set<ActorId>();
    for (const state of actors) {
      present.add(state.id);
      const before = this.tracked.get(state.id);
      const spawned = !this.baseline && before === undefined && state.id > this.highest;
      this.highest = Math.max(this.highest, state.id);
      if (before === undefined) {
        // Its bank now, so its first swing is not the one that waits for the table.
        const game = ACTOR_KINDS[state.kind]?.sounds?.game;
        if (game !== undefined) {
          this.audio.prepare(game);
        }
      }
      const tracked: Tracked = before ?? { last: state, vocalAt: now + vocalGap(state.id, 0), vocals: 0 };
      for (const role of actorSoundsBetween(before?.last, state, spawned)) {
        this.play(state, role);
      }
      if (before && now >= tracked.vocalAt) {
        const role = vocalRole(state);
        if (role) {
          this.play(state, role);
        }
        tracked.vocals++;
        tracked.vocalAt = now + vocalGap(state.id, tracked.vocals);
      }
      tracked.last = state;
      this.tracked.set(state.id, tracked);
    }
    for (const id of this.tracked.keys()) {
      if (!present.has(id)) {
        this.tracked.delete(id);
      }
    }
    this.baseline = false;
  }

  /** A match ended or was left: the next one's ids start again from 1. */
  clear(): void {
    this.tracked.clear();
    this.highest = 0;
    this.baseline = true;
  }

  private play(state: ActorState, role: ActorSoundRole): void {
    const kind = ACTOR_KINDS[state.kind];
    const alias = kind?.sounds?.aliases[role];
    if (!kind?.sounds || alias === undefined) {
      return;
    }
    const at = { x: state.feet.x, y: state.feet.y + kind.height * MOUTH, z: state.feet.z };
    this.audio.playAt(alias, at, { channel: "sfx", game: kind.sounds.game });
  }
}
