// What the world scene holds, and the one place that changes it.
//
// Two kinds of child. The **world** is a built world's root, with its sky and
// fog: replaced whole on every load and gone on leaving. **Kept** roots live
// beside it for the page — effects, peers, corpses, actors, sound, the debug
// overlays — each driving its own matrices (CLAUDE.md, "Nothing in a built world
// moves"). They are added once, so they are present during a load, and so
// visible to the prewarm, rather than re-added after it.

import * as THREE from "three";

export interface WorldSky {
  background: THREE.Color | null;
  fog: THREE.Fog | THREE.FogExp2 | null;
}

export class SceneRoots {
  private world: THREE.Object3D | undefined;

  constructor(private readonly scene: THREE.Scene) {}

  /** Add roots that outlive every world. */
  keep(...roots: THREE.Object3D[]): void {
    this.scene.add(...roots);
  }

  /** Swap in a built world and its sky, or, with no root, leave an empty sky. */
  setWorld(root: THREE.Object3D | undefined, sky: WorldSky = { background: null, fog: null }): void {
    if (this.world) {
      this.scene.remove(this.world);
    }
    this.world = root;
    if (root) {
      this.scene.add(root);
    }
    this.scene.background = sky.background;
    this.scene.fog = sky.fog;
  }
}
