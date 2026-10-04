// One live emitter: an `effect` placement crossed with one of its elements.
//
// Simulated on the CPU, following iw5mp.exe's FX update and draw code. CoD's
// elem semantics are branchy -- per-particle random ranges, flag-selected frames,
// runners -- so a GPU integrator would be a second implementation of the same
// interpreter; this way `seekTo` is exact and the whole thing tests in Node.

import { unitsToMetres } from "@3d/shared/sim/units.js";
import type { FxElem, FxVisualState } from "./library.js";
import { RAND, RAND_COUNT, emptyVisualState, sampleRange, sampleTravel, sampleVelocity, sampleVis, seeded, seedOf } from "./library.js";

/*
 * FxElemDef flag bits. The meanings are read from iw5mp.exe (FX_GetOriginForElem,
 * FX_ApplySpawnOffset, FX_GetOrientation, FX_IntegrateVelocity,
 * FX_CullElemForSpawn); the velocity/gravity/size ones were also checked against
 * all 2,734 elems of MW3's 581 effects with no mismatch.
 */
/** Rotate `spawnOrigin` by the placement's axes; without it the origin offset is in world axes. */
export const FX_FLAG_ROTATE_SPAWN_ORIGIN = 0x2;
/** Spawn only if a `spawnFrustumCullRadius` sphere around the effect is in view. */
export const FX_FLAG_FRUSTUM_CULL = 0x4;
export const FX_FLAG_OFFSET_MASK = 0x30;
export const FX_FLAG_OFFSET_SPHERE = 0x10;
/** Which frame local velocity is in: 0 is world axes; anything else is the placement's. */
export const FX_FLAG_RUN_MASK = 0xc0;
export const FX_FLAG_LOCAL_VELOCITY = 0x01000000;
export const FX_FLAG_WORLD_VELOCITY = 0x02000000;
export const FX_FLAG_GRAVITY = 0x04000000;
export const FX_FLAG_NONUNIFORM_SIZE = 0x10000000;

/** `gravity` is a multiple of 800 units/s^2 (FX_IntegrateWithGravity), here in m/s^2. */
/**
 * FX_IntegrateWithGravity has no flag test of its own: FX_UpdateElemPosition
 * takes it whenever the world graph or gravity bit is set. MW3's data only
 * carries a non-zero gravity with 0x4000000, so the two agree in practice.
 */
const GRAVITY_PATH = 0x06000000;
const GRAVITY = unitsToMetres(800);

/** How a batch expands a particle's quad. */
export const DRAW_BILLBOARD = 0;
export const DRAW_ORIENTED = 1;
export const DRAW_TAIL = 2;

type Vec = [number, number, number];

/** The placement's rotation, in three.js' own XYZ Euler order, as a column-major 3x3. */
function rotationMatrix(r: { x: number; y: number; z: number }): number[] {
  const c1 = Math.cos(r.x);
  const s1 = Math.sin(r.x);
  const c2 = Math.cos(r.y);
  const s2 = Math.sin(r.y);
  const c3 = Math.cos(r.z);
  const s3 = Math.sin(r.z);
  return [c2 * c3, c1 * s3 + s1 * s2 * c3, s1 * s3 - c1 * s2 * c3, -c2 * s3, c1 * c3 - s1 * s2 * s3, s1 * c3 + c1 * s2 * s3, s2, -s1 * c2, c1 * c2];
}

function rotate(m: number[], x: number, y: number, z: number): Vec {
  return [m[0]! * x + m[3]! * y + m[6]! * z, m[1]! * x + m[4]! * y + m[7]! * z, m[2]! * x + m[5]! * y + m[8]! * z];
}

/** A CoD-axis direction (x forward, y left, z up) in engine axes: the same swap the exporter applies. */
function toEngine(x: number, y: number, z: number): Vec {
  return [x, z, -y];
}

export interface Particle {
  born: number;
  life: number;
  sequence: number;
  /** Spawn position relative to the placement, engine metres, already offset and rotated. */
  sx: number;
  sy: number;
  sz: number;
  rot: number;
  rands: number[];
}

export interface EmitterPlacement {
  id: number;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  delay: number;
}

export interface ParticleView {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  rot: number;
  r: number;
  g: number;
  b: number;
  a: number;
  frame: number;
  mode: number;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
}

export function emptyView(): ParticleView {
  return { x: 0, y: 0, z: 0, w: 0, h: 0, rot: 0, r: 1, g: 1, b: 1, a: 1, frame: 0, mode: DRAW_BILLBOARD, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0 };
}

const scratchVis: FxVisualState = emptyVisualState();
const scratchLocal: number[] = [0, 0, 0];
const scratchWorld: number[] = [0, 0, 0];

export class FxEmitter {
  readonly particles: Particle[] = [];
  /** Seconds of effect time elapsed. Advanced only by `step`, never by wall clock. */
  private t = 0;
  private nextSpawn = 0;
  private spawned = 0;
  private ordinal = 0;
  /** The placement's rotation, and its forward/left/up axes in engine space. */
  private readonly rotation: number[];
  private readonly forward: Vec;
  private readonly left: Vec;
  private readonly up: Vec;

  constructor(
    readonly elem: FxElem,
    readonly elemIndex: number,
    readonly placement: EmitterPlacement,
  ) {
    // A negative delay means the map wants this already running; `seekTo` replays it.
    this.nextSpawn = Math.max(0, placement.delay);
    this.rotation = rotationMatrix(placement.rotation);
    // R·toEngine(v) takes a CoD-local vector to engine world space, so the
    // placement's axes are R applied to each CoD basis vector's engine image.
    this.forward = rotate(this.rotation, 1, 0, 0);
    this.left = rotate(this.rotation, 0, 0, -1);
    this.up = rotate(this.rotation, 0, 1, 0);
  }

  get time(): number {
    return this.t;
  }

  /** Whether local-frame travel and elem axes turn with the placement. */
  private get inPlacementFrame(): boolean {
    return (this.elem.flags & FX_FLAG_RUN_MASK) !== 0;
  }

  /**
   * Advance by `dt` seconds: retire what died, spawn what is due.
   *
   * `allowSpawn` is the system's distance and frustum gate. A gated emitter keeps
   * its schedule -- the game culls the spawn, not the clock -- so it resumes in
   * step rather than dumping a burst when the camera comes back.
   */
  step(dt: number, budget: number, allowSpawn = true): void {
    this.t += dt;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      if (this.t - p.born >= p.life) {
        this.particles.splice(i, 1);
      }
    }

    const spawn = this.elem.spawn;
    if (spawn.kind === "looping") {
      const interval = Math.max(spawn.interval, 1 / 1000);
      while (this.t >= this.nextSpawn) {
        if (spawn.count !== null && this.spawned >= spawn.count) {
          break;
        }
        // Over budget the emitter declines to spawn; a living particle is never
        // killed mid-life, which would pop.
        if (allowSpawn && this.particles.length < budget) {
          this.birth(this.nextSpawn);
        }
        this.nextSpawn += interval;
        this.spawned++;
      }
      return;
    }

    if (this.spawned === 0 && this.t >= this.nextSpawn) {
      this.spawned = 1;
      if (!allowSpawn) {
        return;
      }
      const rand = seeded(seedOf(this.placement.id, this.elemIndex, 0, this.elem.randomSeed));
      const n = Math.max(0, Math.round(sampleRange(spawn.count, rand())));
      for (let i = 0; i < n && this.particles.length < budget; i++) {
        this.birth(this.nextSpawn);
      }
    }
  }

  private birth(at: number): void {
    const sequence = this.ordinal++;
    const rand = seeded(seedOf(this.placement.id, this.elemIndex, sequence, this.elem.randomSeed));
    const r: number[] = [];
    for (let i = 0; i < RAND_COUNT; i++) {
      r.push(rand());
    }

    const e = this.elem;
    const life = Math.max(sampleRange(e.life, r[RAND.life]!), 1 / 1000);

    // FX_GetOriginForElem: the origin range, in the placement's axes only with
    // the flag. (The exporter already swapped the ranges into engine axis order.)
    let [ox, oy, oz] = [
      sampleRange(e.spawnOrigin[0], r[RAND.spawnOrigin]!),
      sampleRange(e.spawnOrigin[1], r[RAND.spawnOrigin + 1]!),
      sampleRange(e.spawnOrigin[2], r[RAND.spawnOrigin + 2]!),
    ];
    if (e.flags & FX_FLAG_ROTATE_SPAWN_ORIGIN) {
      [ox, oy, oz] = rotate(this.rotation, ox, oy, oz);
    }

    // FX_ApplySpawnOffset: a sphere shell in world axes, or a cylinder around
    // the placement's forward axis.
    const offsetMode = e.flags & FX_FLAG_OFFSET_MASK;
    if (offsetMode) {
      const radius = sampleRange(e.spawnOffsetRadius, r[RAND.offsetRadius]!);
      const theta = r[RAND.offsetYaw]! * Math.PI * 2;
      if (offsetMode === FX_FLAG_OFFSET_SPHERE) {
        const cz = r[RAND.offsetHeight]! * 2 - 1;
        const s = Math.sqrt(Math.max(0, 1 - cz * cz));
        const [dx, dy, dz] = toEngine(s * Math.cos(theta), s * Math.sin(theta), cz);
        ox += radius * dx;
        oy += radius * dy;
        oz += radius * dz;
      } else {
        const height = sampleRange(e.spawnOffsetHeight, r[RAND.offsetHeight]!);
        const c = radius * Math.cos(theta);
        const s = radius * Math.sin(theta);
        ox += height * this.forward[0] + c * this.left[0] + s * this.up[0];
        oy += height * this.forward[1] + c * this.left[1] + s * this.up[1];
        oz += height * this.forward[2] + c * this.left[2] + s * this.up[2];
      }
    }

    this.particles.push({
      born: at,
      life,
      sequence,
      sx: ox,
      sy: oy,
      sz: oz,
      rot: sampleRange(e.initialRotation, r[RAND.initialRotation]!),
      rands: r,
    });
  }

  /**
   * Where a particle is and how it is drawn now, into `out`. Distance fades are
   * the system's; this is everything that depends on the particle alone.
   */
  sample(p: Particle, out: ParticleView): void {
    const e = this.elem;
    const age = Math.max(this.t - p.born, 0);
    const u = Math.min(age / p.life, 1);
    const lifeMs = p.life * 1000;
    const ageMs = age * 1000;
    const framed = this.inPlacementFrame;

    sampleVis(e.visSamples, u, p.rands, scratchVis);
    sampleTravel(e.velSamples, u, p.rands, scratchLocal, scratchWorld);

    // FX_IntegrateVelocity passes the particle's whole life, in milliseconds,
    // into every segment -- not one segment's share of it. The curves' samples
    // are authored so that this is right.
    let [lx, ly, lz] = [scratchLocal[0]! * lifeMs, scratchLocal[1]! * lifeMs, scratchLocal[2]! * lifeMs];
    if (framed) {
      [lx, ly, lz] = rotate(this.rotation, lx, ly, lz);
    }
    const g = e.flags & GRAVITY_PATH ? sampleRange(e.gravity, p.rands[RAND.gravity]!) * GRAVITY : 0;
    const o = this.placement.position;

    out.x = o.x + p.sx + lx + scratchWorld[0]! * lifeMs;
    out.y = o.y + p.sy + ly + scratchWorld[1]! * lifeMs - 0.5 * g * age * age;
    out.z = o.z + p.sz + lz + scratchWorld[2]! * lifeMs;

    // A half-extent: the quad is 2·size on each side. `scale` is never read for
    // a sprite or tail. size[1] only with the non-uniform flag.
    out.w = scratchVis.size[0]!;
    out.h = e.flags & FX_FLAG_NONUNIFORM_SIZE ? scratchVis.size[1]! : scratchVis.size[0]!;
    out.rot = p.rot + scratchVis.rotationTotal * lifeMs;
    out.r = scratchVis.color[0]!;
    out.g = scratchVis.color[1]!;
    out.b = scratchVis.color[2]!;
    out.a = scratchVis.color[3]!;
    out.frame = this.atlasFrame(p, u, ageMs);

    out.mode = DRAW_BILLBOARD;
    if (e.type === "TAIL") {
      // A tail stretches along its velocity (FX_DrawTail).
      sampleVelocity(e.velSamples, u, p.rands, scratchLocal, scratchWorld);
      let [vx, vy, vz] = [scratchLocal[0]!, scratchLocal[1]!, scratchLocal[2]!];
      if (framed) {
        [vx, vy, vz] = rotate(this.rotation, vx, vy, vz);
      }
      vx += scratchWorld[0]!;
      vy += scratchWorld[1]! - (g * age) / 1000;
      vz += scratchWorld[2]!;
      const len = Math.hypot(vx, vy, vz);
      if (len > 1e-9) {
        out.mode = DRAW_TAIL;
        out.ax = vx / len;
        out.ay = vy / len;
        out.az = vz / len;
      }
    } else if (e.type === "SPRITE_ORIENTED") {
      // FX_DrawOrientedSprite (0x4d60e0): the quad spans axis[1] and axis[2] of
      // the run-mode frame, facing along axis[0]. spawnAngles and angularVelocity
      // play no part -- only models read them. In run mode 0 the frame is the
      // world's, so the quad lies in CoD's YZ plane.
      out.mode = DRAW_ORIENTED;
      if (framed) {
        [out.ax, out.ay, out.az] = this.left;
        [out.bx, out.by, out.bz] = this.up;
      } else {
        [out.ax, out.ay, out.az] = toEngine(0, 1, 0);
        [out.bx, out.by, out.bz] = toEngine(0, 0, 1);
      }
    }
  }

  /** FX_GetAtlasUV's frame index. */
  private atlasFrame(p: Particle, u: number, ageMs: number): number {
    const atlas = this.elem.atlas;
    const count = Math.max(atlas.entryCount, 1);
    if (count === 1) {
      return 0;
    }
    const start = atlas.behavior & 3;
    let frame = start === 0 ? atlas.index : start === 1 ? Math.floor(p.rands[RAND.atlasStart]! * count) : p.sequence & (count - 1);
    if (atlas.behavior & 4) {
      frame += Math.floor(u * count);
    } else if (atlas.fps) {
      frame += Math.floor((Math.floor(ageMs) * atlas.fps) / 1000);
    }
    if (atlas.behavior & 8 && frame >= atlas.loopCount * count) {
      frame = count - 1;
    }
    return frame & (count - 1);
  }
}
