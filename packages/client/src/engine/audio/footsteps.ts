// Playing what a body's own motion says it did: footsteps and landings.
//
// The *deciding* is `@3d/shared/sim/footsteps.ts` — whether a step happened,
// which gait, which surface — because it is a function of simulation state and
// both ends have to reach the same answer. This half is the browser's: which
// alias that spells, which stream its clip and pitch are drawn from, and whether
// it is played at the listener or out in the world.
//
// **Your own boots and everybody else's are different sounds and different
// paths.** `step_<gait>_plr_<surface>` goes through `playAtListener` and is
// therefore flat whatever the alias' `spatial` says — of dome's own
// `step_*_plr_*`, six are non-positional and four are not, and
// `step_run_plr_dirt` is one of the four, so the `_plr` infix cannot be read as
// "play it flat" (docs/engine/audio.md#_plr-is-not-the-test-for-non-positional).
// `step_<gait>_<surface>` goes through `playAt` at that player's feet and is
// culled by the alias' own hard `maxDistance` — 10.2 m walking, 30.5 running,
// 35.6 sprinting, 40.6 for a landing. **No constant in this repo sets those**:
// they are the game's own numbers, and a footstep heard across the map would be
// this engine having overridden them.

import { hashString, seeded } from "@3d/shared/game/random.js";
import { footfallAlias, FootstepWatcher, stepStream } from "@3d/shared/sim/footsteps.js";
import type { CapsuleWorld, MovementState } from "@3d/shared/sim/movement.js";
import type { AudioSystem } from "./system.js";

/** One peer, as a snapshot describes them. Structural, so this stays clear of the wire's own types. */
export interface FootstepPeer {
  id: string;
  state: { dead: boolean; movement: MovementState };
}

/** What a body is watched with, and how many of its steps have been heard. */
interface Tracked {
  watcher: FootstepWatcher;
  /** `hashString(id)`: the same number the server would mix, and the same one everywhere. */
  seed: number;
}

export class Footsteps {
  private readonly own: Tracked = { watcher: new FootstepWatcher(), seed: 0 };
  /**
   * How many of the local player's steps have been heard. A counter rather than
   * anything on the wire: nobody else plays this player's `_plr` aliases, so
   * there is nothing for it to agree with, and it only has to keep consecutive
   * steps from drawing the same recording.
   */
  private ordinal = 0;
  private readonly peers = new Map<string, Tracked>();

  constructor(
    private readonly audio: AudioSystem,
    private readonly world: CapsuleWorld,
  ) {}

  /** The seed this player's own steps draw from: the recoil's, so one id gives one stream. */
  setSeed(seed: number): void {
    this.own.seed = seed | 0;
  }

  /**
   * The local player, every frame.
   *
   * Per frame and not per tick, because the watcher compares the state it last
   * saw with the state now and catches every footfall between them however many
   * ticks that was — see `footfallsCrossed`.
   */
  local(movement: Readonly<MovementState>): void {
    for (const footfall of this.own.watcher.observe(movement, this.world)) {
      const random = seeded(stepStream(this.own.seed, this.ordinal++, footfall.index));
      this.audio.playAtListener(footfallAlias(footfall, true), { channel: "footsteps" }, random);
    }
  }

  /**
   * Everybody else, once per snapshot.
   *
   * Driven by the snapshot rather than by the frame, and that is what makes a
   * peer's footsteps the same everywhere: these are the server's own tick states,
   * arriving identically at every client, and `tick` is a number all of them
   * agree on — so the same step draws the same recording in every browser. Doing
   * it per frame off the interpolated body would make each client's draw times
   * part of the answer.
   *
   * Membership follows the snapshot, as `net/remotePlayers.ts`'s does, so a peer
   * who leaves stops being watched.
   */
  remote(players: readonly FootstepPeer[], tick: number): void {
    for (const { id, state } of players) {
      let tracked = this.peers.get(id);
      if (!tracked) {
        tracked = { watcher: new FootstepWatcher(), seed: hashString(id) };
        this.peers.set(id, tracked);
      }
      // A dead player keeps arriving in every snapshot, frozen where they fell.
      // Forgotten rather than skipped, so the respawn that moves them across the
      // map is a fresh start and not one enormous stride.
      if (state.dead) {
        tracked.watcher.reset();
        continue;
      }
      for (const footfall of tracked.watcher.observe(state.movement, this.world)) {
        const random = seeded(stepStream(tracked.seed, tick, footfall.index));
        this.audio.playAt(footfallAlias(footfall, false), footfall.at, { channel: "footsteps" }, random);
      }
    }
    if (this.peers.size !== players.length) {
      const present = new Set(players.map((p) => p.id));
      for (const id of [...this.peers.keys()]) {
        if (!present.has(id)) {
          this.peers.delete(id);
        }
      }
    }
  }

  /** Everyone leaves: a world change, or the connection going away. */
  clear(): void {
    this.peers.clear();
    this.own.watcher.reset();
  }
}
