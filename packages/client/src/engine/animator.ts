// Plays the looping clips of `animate:` placements and advances the clock the
// flag-wind shader reads. The one per-frame writer of transforms in a built
// world, so it keeps the matrices of what it moves current itself (the scene
// no longer updates any): docs/engine/rendering.md#animated-props.

import * as THREE from "three";
import type { AnimatedPlacement } from "../scene/animation.js";
import type { ShaderClock } from "../scene/flag.js";

const scratch = new THREE.Vector3();

/**
 * Where in its loop a placement starts, in [0, 1), from where it stands. The
 * game starts every copy together; staggered, a field of brush does not sway
 * in lockstep. Deterministic, so a screenshot pose renders the same each time.
 */
export function phaseOf(position: THREE.Vector3): number {
  const h = Math.sin(position.x * 12.9898 + position.y * 78.233 + position.z * 37.719) * 43758.5453;
  return h - Math.floor(h);
}

export class Animator {
  /** Stops time, so a held screenshot pose renders the same frame every run (its start phases are deterministic). */
  paused = false;
  private mixers: THREE.AnimationMixer[] = [];
  private roots: THREE.Object3D[] = [];
  private clock: ShaderClock | undefined;

  /** Start `placements`, replacing whatever was playing. Call after the world's matrices are frozen. */
  attach(placements: readonly AnimatedPlacement[], clock?: ShaderClock): void {
    this.clear();
    this.clock = clock;
    for (const { root, clip } of placements) {
      // The build froze every node; a bone that stays frozen never takes the mixer's pose.
      root.traverse((node) => {
        node.matrixAutoUpdate = true;
      });
      const mixer = new THREE.AnimationMixer(root);
      const action = mixer.clipAction(clip).play();
      action.time = phaseOf(root.getWorldPosition(scratch)) * clip.duration;
      this.mixers.push(mixer);
      this.roots.push(root);
    }
    this.pose(0);
  }

  /** Advance everything by `dt` seconds, unless paused. */
  update(dt: number): void {
    if (!this.paused) {
      this.pose(dt);
    }
  }

  private pose(dt: number): void {
    if (this.clock) {
      this.clock.value += dt;
    }
    for (const mixer of this.mixers) {
      mixer.update(dt);
    }
    for (const root of this.roots) {
      root.updateMatrixWorld(true);
    }
  }

  /** How many placements are playing. */
  get count(): number {
    return this.mixers.length;
  }

  /** Stop and forget everything. The clock is the AssetStore's and stays where it is. */
  clear(): void {
    for (let i = 0; i < this.mixers.length; i++) {
      this.mixers[i]!.stopAllAction();
      this.mixers[i]!.uncacheRoot(this.roots[i]!);
    }
    this.mixers = [];
    this.roots = [];
    this.clock = undefined;
  }
}
