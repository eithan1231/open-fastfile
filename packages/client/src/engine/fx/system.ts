// The world's effects, as one root beside the scene.
//
// Owns its own root rather than living in the built world, like
// net/remotePlayers.ts and for the same reason: it outlives any one world and
// drives itself. Particles are written in world space, so nothing under the root
// ever moves and no matrix is updated per frame — strictly less than the animator
// needs, and it sidesteps the frozen-matrix rules rather than opting out of them.

import * as THREE from "three";
import type { FxBatch } from "./batch.js";
import { emptyCloudView, type FxCloudBatch } from "./cloud.js";
import type { RenderPass } from "../render/pipeline.js";
import { emptyView, FX_FLAG_FRUSTUM_CULL, FxEmitter, type EmitterPlacement, type ParticleView } from "./emitter.js";
import { RAND, type FxEffect, type FxFadeQuantise, type FxLibrary, type Range } from "./library.js";

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
 * The distance fade as the alpha multiplier the game draws with (`FxFadeQuantise`).
 * `floor` is `(distanceFade * occlusionFade * a) >> 16` with occlusion at its
 * default 255, since occlusion fading is not implemented.
 */
export function fadeScale(distanceFade: number, quantise: FxFadeQuantise = "floor"): number {
  if (quantise === "round") {
    return Math.floor(distanceFade * 255 + 0.5) / 256;
  }
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

/** A repeating placement's emitters, which start their next instance together. */
interface FxLoop {
  emitters: FxEmitter[];
  repeat: number;
  /** Effect seconds at which to next check whether the last instance has finished. */
  due: number;
}

/** How often Black Ops' `loopfx` polls `isfxplaying` once the repeat has passed. */
const LOOP_POLL = 0.25;

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
  /** A CLOUD elem's draws, keyed by material: a pool of cloud meshes rather than a quad batch. */
  clouds?: Map<string, FxCloudBatch>;
}

export class FxSystem {
  /** Drawn by the pipeline's "effects" pass, after the world has been tone-mapped onto the canvas. */
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  /** Stops time, so a held screenshot pose renders the same frame every run. */
  paused = false;
  /** Total live particles allowed. Over it, emitters stop spawning; nothing alive is killed. */
  budget = 6000;

  private emitters: FxEmitter[] = [];
  private loops: FxLoop[] = [];
  private batches = new Map<string, FxBatch>();
  private clouds = new Map<string, FxCloudBatch>();
  private cloudView = emptyCloudView();
  /** Soft particles: feathered sheets fade where they meet the world, by the frame's depth. */
  soft = true;
  private batchOf = new Map<string, string>();
  private view: ParticleView = emptyView();
  private skipped = new Map<string, number>();

  constructor() {
    this.root.name = "fx";
    this.root.matrixAutoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.add(this.root);
  }

  /** Every element type the runtime draws. Anything else is counted, never substituted. */
  // CLOUD draws through a routine of its own (cloud.ts), never as a billboard.
  static readonly DRAWN = new Set(["SPRITE_BILLBOARD", "SPRITE_ORIENTED", "SPRITE_ROTATED", "TAIL", "LINE", "CLOUD"]);

  private fadeQuantise: FxFadeQuantise = "floor";

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
    this.fadeQuantise = library.fadeQuantise;
    this.clouds = build.clouds ?? new Map();
    for (const batch of this.batches.values()) {
      this.root.add(batch.mesh);
    }
    for (const cloud of this.clouds.values()) {
      this.root.add(cloud.root);
    }

    for (const placement of placements) {
      const effect = library.effects[placement.fx];
      if (!effect) {
        this.note("unresolved");
        continue;
      }
      const first = this.emitters.length;
      this.addEmitters(effect, placement, library, 0);
      const repeat = placement.repeat ?? 0;
      if (repeat > 0 && this.emitters.length > first) {
        this.loops.push({ emitters: this.emitters.slice(first), repeat, due: Math.max(placement.delay, 0) + repeat });
      }
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
      const undrawn = library.materials[elem.visuals.names[0] ?? ""]?.undrawn;
      if (undrawn) {
        this.note(undrawn);
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
    // clientscripts/mp/_fx.csc's loopfx: wait out the repeat, then poll every
    // quarter second until the last instance has finished, then play a new one.
    // Instances never overlap.
    for (const loop of this.loops) {
      const t = loop.emitters[0]!.time;
      while (t >= loop.due) {
        if (loop.emitters.every((e) => e.done)) {
          for (const e of loop.emitters) {
            e.restart(loop.due);
          }
          loop.due += loop.repeat;
        } else {
          loop.due += LOOP_POLL;
        }
      }
    }
  }

  private fill(): void {
    for (const batch of this.batches.values()) {
      batch.begin();
    }
    for (const cloud of this.clouds.values()) {
      cloud.begin();
    }
    const v = this.view;
    const c = this.cloudView;
    for (const e of this.emitters) {
      const names = e.elem.visuals.names;
      const { fadeInRange, fadeOutRange } = e.elem;
      const fades = fadeInRange[1] !== 0 || fadeOutRange[1] !== 0;
      for (const p of e.particles) {
        if (!e.isBorn(p)) {
          continue;
        }
        // An elem with several visuals draws one per particle, chosen by its own
        // random (key 21): a fire's flicker mixes blended and additive sheets.
        const name = names.length > 1 ? names[Math.min(Math.floor(p.rands[RAND.visual]! * names.length), names.length - 1)] : names[0];
        if (e.elem.type === "CLOUD") {
          const cloud = this.clouds.get(name ?? "");
          if (cloud && e.sampleCloud(p, c)) {
            const distance = fades ? distanceFade(fadeInRange, fadeOutRange, Math.hypot(c.x - this.eye.x, c.y - this.eye.y, c.z - this.eye.z)) : 1;
            c.a *= fadeScale(distance, this.fadeQuantise);
            if (c.a > 0 && c.w > 0) {
              cloud.push(c);
            }
          }
          continue;
        }
        const key = this.batchOf.get(name ?? "");
        const batch = key ? this.batches.get(key) : undefined;
        if (!batch) {
          continue;
        }
        e.sample(p, v);
        const distance = fades ? distanceFade(fadeInRange, fadeOutRange, Math.hypot(v.x - this.eye.x, v.y - this.eye.y, v.z - this.eye.z)) : 1;
        v.a *= fadeScale(distance, this.fadeQuantise);
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
    for (const cloud of this.clouds.values()) {
      cloud.end();
    }
  }

  /**
   * The pipeline's "effects" pass. After the output pass, onto the canvas, so a
   * sheet blends in display space and skips tone mapping as the game's do
   * (docs/engine/rendering.md#effects); each tests against the frame's depth in
   * its shader, and a feathered one fades by it.
   */
  readonly pass: RenderPass = {
    scene: this.scene,
    render: ({ renderer, camera, target, roots }) => {
      this.scene.fog = roots.fog;
      for (const batch of this.batches.values()) {
        if (batch.count > 0) {
          batch.useDepth(target, this.soft && batch.feathered);
        }
      }
      for (const cloud of this.clouds.values()) {
        cloud.useDepth(target);
      }
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(null);
      renderer.render(this.scene, camera);
      renderer.autoClear = autoClear;
    },
    prewarm: async ({ renderer, camera, roots }) => {
      this.scene.fog = roots.fog;
      renderer.setRenderTarget(null);
      await renderer.compileAsync(this.scene, camera);
    },
  };

  /** Stop everything and drop the batches. The textures belong to the world's AssetStore. */
  clear(): void {
    this.emitters = [];
    this.loops = [];
    this.skipped.clear();
    for (const batch of this.batches.values()) {
      this.root.remove(batch.mesh);
      batch.dispose();
    }
    for (const cloud of this.clouds.values()) {
      this.root.remove(cloud.root);
      cloud.dispose();
    }
    this.batches = new Map();
    this.batchOf = new Map();
    this.clouds = new Map();
  }
}
