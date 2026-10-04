// The world's effects, as one root beside the scene.
//
// Owns its own root rather than living in the built world, like
// net/remotePlayers.ts and for the same reason: it outlives any one world and
// drives itself. Particles are written in world space, so nothing under the root
// ever moves and no matrix is updated per frame — strictly less than the animator
// needs, and it sidesteps the frozen-matrix rules rather than opting out of them.

import * as THREE from "three";
import type { FxBatch } from "./batch.js";
import { emptyView, FX_FLAG_FRUSTUM_CULL, FxEmitter, type EmitterPlacement, type ParticleView } from "./emitter.js";
import type { FxEffect, FxLibrary, Range } from "./library.js";

/**
 * FX_FadeFactor: 1 up to `base`, falling to 0 over `amplitude`. Applied only when
 * the amplitude is non-zero; the caller decides what that means.
 */
export function fadeFactor(range: Range, distance: number): number {
  if (distance <= range[0]) {
    return 1;
  }
  return Math.min(Math.max(1 - (distance - range[0]) / range[1], 0), 1);
}

/**
 * The game's final alpha is `(distanceFade * occlusionFade * a) >> 16`, each fade
 * a byte that defaults to 255 -- so an unfaded 255 draws as 253. Occlusion fading
 * is not implemented, so it stands at its default here.
 */
export function fadeScale(distanceFade: number): number {
  return (Math.floor(distanceFade * 255) * 255) / 65536;
}

/** FX_ApplyDistanceFade: `fadeIn` hides a particle far away, `fadeOut` hides it close up. */
export function distanceFade(fadeIn: Range, fadeOut: Range, distance: number): number {
  let f = 1;
  if (fadeIn[1] !== 0) {
    f = Math.min(f, fadeFactor(fadeIn, distance));
  }
  if (fadeOut[1] !== 0) {
    f = Math.min(f, 1 - fadeFactor(fadeOut, distance));
  }
  return f;
}

/** Fixed substep for a deterministic replay. Screenshot poses depend on this being constant. */
const SEEK_STEP = 1 / 60;

/** How far a held pose runs the world forward before it is captured. */
export const POSE_TIME = 5;

export interface FxPlacement extends EmitterPlacement {
  fx: string;
}

/** What a batch is keyed by: one draw call per material and blend. */
export interface BatchKey {
  material: string;
  sortOrder: number;
}

export interface FxBuild {
  /** Ready-made batches, keyed as `${material}`. Built by scene/fx.ts, which owns the textures. */
  batches: Map<string, FxBatch>;
  /** Which batch an elem draws into, by `${effect}:${elemIndex}`. */
  batchOf: Map<string, string>;
}

export class FxSystem {
  readonly root = new THREE.Group();
  /** Stops time, so a held screenshot pose renders the same frame every run. */
  paused = false;
  /** Total live particles allowed. Over it, emitters stop spawning; nothing alive is killed. */
  budget = 6000;

  private emitters: FxEmitter[] = [];
  private batches = new Map<string, FxBatch>();
  private batchOf = new Map<string, string>();
  private view: ParticleView = emptyView();
  private skipped = new Map<string, number>();

  constructor() {
    this.root.name = "fx";
    this.root.matrixAutoUpdate = false;
  }

  /** Every element type the runtime draws. Anything else is counted, never substituted. */
  // CLOUD is not here on purpose: the game draws it with a routine of its own
  // (and skips it at scale 0), so a billboard would be a plausible wrong result.
  static readonly DRAWN = new Set(["SPRITE_BILLBOARD", "SPRITE_ORIENTED", "TAIL"]);

  /**
   * Start `placements`, replacing whatever was playing.
   *
   * Each placement becomes one emitter per drawable element. A type this build
   * does not draw is counted rather than approximated: a TAIL drawn as a
   * billboard is a plausible wrong result, and a counted absence is honest.
   */
  attach(placements: readonly FxPlacement[], library: FxLibrary, build: FxBuild): void {
    this.clear();
    this.batches = build.batches;
    this.batchOf = build.batchOf;
    for (const batch of this.batches.values()) {
      this.root.add(batch.mesh);
    }

    for (const placement of placements) {
      const effect = library.effects[placement.fx];
      if (!effect) {
        this.note("unresolved");
        continue;
      }
      this.addEmitters(effect, placement, library, 0);
    }
    this.root.updateMatrixWorld(true);
  }

  /** A RUNNER spawns another effect at the same place; depth-capped, since a runner can name a runner. */
  private addEmitters(effect: FxEffect, placement: FxPlacement, library: FxLibrary, depth: number): void {
    if (depth > 4) {
      this.note("runner-depth");
      return;
    }
    effect.elems.forEach((elem, i) => {
      if (elem.type === "RUNNER") {
        for (const name of elem.visuals.names) {
          const child = library.effects[name];
          if (child) {
            this.addEmitters(child, placement, library, depth + 1);
          } else {
            this.note("unresolved");
          }
        }
        return;
      }
      if (!FxSystem.DRAWN.has(elem.type)) {
        this.note(elem.type);
        return;
      }
      this.emitters.push(new FxEmitter(elem, i, placement));
    });
  }

  private note(kind: string): void {
    this.skipped.set(kind, (this.skipped.get(kind) ?? 0) + 1);
  }

  /** What was exported but not drawn, so an absence is a number rather than nothing. */
  get skippedCounts(): ReadonlyMap<string, number> {
    return this.skipped;
  }

  get emitterCount(): number {
    return this.emitters.length;
  }

  get particleCount(): number {
    let n = 0;
    for (const e of this.emitters) {
      n += e.particles.length;
    }
    return n;
  }

  /** Advance by `dt` seconds and refill the batches, unless paused. */
  update(dt: number, camera: THREE.Camera): void {
    if (this.paused) {
      return;
    }
    this.watch(camera);
    this.advance(dt);
    this.fill();
  }

  /**
   * Replay from zero to `t` in fixed steps, then hold.
   *
   * A held screenshot pose stops time at mount, and a particle system starts
   * empty -- so without this a held shot of the sandstorm is a clear sky, which
   * reads as a rendering failure rather than a timing one. Fixed steps and seeded
   * randoms also make the result identical run to run.
   */
  seekTo(t: number, camera: THREE.Camera): void {
    for (const e of this.emitters) {
      e.particles.length = 0;
    }
    this.watch(camera);
    const steps = Math.min(Math.ceil(t / SEEK_STEP), 1200);
    for (let i = 0; i < steps; i++) {
      this.advance(SEEK_STEP);
    }
    this.fill();
  }

  private readonly eye = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();

  /** Where the camera is and what it sees, for the spawn gates and the fades. */
  private watch(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
  }

  /**
   * FX_CullElemForSpawn. An elem with a spawn range only spawns while the camera
   * is within that band of the *effect* -- particles are not spawned around the
   * camera -- and with the frustum flag only while a sphere around it is in view.
   */
  private canSpawn(e: FxEmitter): boolean {
    const elem = e.elem;
    const o = e.placement.position;
    if (elem.spawnRange[1] !== 0) {
      const d = this.eye.distanceTo(this.sphere.center.set(o.x, o.y, o.z));
      if (d < elem.spawnRange[0] || d > elem.spawnRange[0] + elem.spawnRange[1]) {
        return false;
      }
    }
    if (elem.flags & FX_FLAG_FRUSTUM_CULL) {
      this.sphere.center.set(o.x, o.y, o.z);
      this.sphere.radius = elem.spawnFrustumCullRadius;
      if (!this.frustum.intersectsSphere(this.sphere)) {
        return false;
      }
    }
    return true;
  }

  private advance(dt: number): void {
    // Share the budget evenly, so one dense emitter cannot starve the rest.
    const each = this.emitters.length > 0 ? Math.max(1, Math.floor(this.budget / this.emitters.length)) : 0;
    for (const e of this.emitters) {
      e.step(dt, each, this.canSpawn(e));
    }
  }

  private fill(): void {
    for (const batch of this.batches.values()) {
      batch.begin();
    }
    const v = this.view;
    for (const e of this.emitters) {
      const key = this.batchOf.get(e.elem.visuals.names[0] ?? "");
      const batch = key ? this.batches.get(key) : undefined;
      if (!batch) {
        continue;
      }
      const { fadeInRange, fadeOutRange } = e.elem;
      const fades = fadeInRange[1] !== 0 || fadeOutRange[1] !== 0;
      for (const p of e.particles) {
        e.sample(p, v);
        const distance = fades ? distanceFade(fadeInRange, fadeOutRange, Math.hypot(v.x - this.eye.x, v.y - this.eye.y, v.z - this.eye.z)) : 1;
        v.a *= fadeScale(distance);
        // The game skips a particle whose alpha is at or below fx_alphaThreshold (0).
        if (v.a <= 0 || v.w <= 0) {
          continue;
        }
        batch.push(v);
      }
    }
    for (const batch of this.batches.values()) {
      batch.end();
    }
  }

  /** Stop everything and drop the batches. The textures belong to the world's AssetStore. */
  clear(): void {
    this.emitters = [];
    this.skipped.clear();
    for (const batch of this.batches.values()) {
      this.root.remove(batch.mesh);
      batch.dispose();
    }
    this.batches = new Map();
    this.batchOf = new Map();
  }
}
