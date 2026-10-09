// The effect definitions a world ships, and how to read a value out of one.
//
// The shape is what `scripts/cod/fx.py` writes, already in engine units: seconds,
// metres, metres per second, colour in 0..1. Nothing here touches three.js, so it
// runs in a test without a GL context.

/** `[base, amplitude]`. A sample is `base + amplitude * rand01`, and **amplitude is signed**. */
export type Range = readonly [number, number];
export type Range3 = readonly [Range, Range, Range];

export interface FxVisualState {
  color: readonly number[];
  rotationDelta: number;
  rotationTotal: number;
  size: readonly number[];
  scale: number;
}

export interface FxVisSample {
  base: FxVisualState;
  amplitude: FxVisualState;
}

export interface FxVelFrame {
  velocity: { base: readonly number[]; amplitude: readonly number[] };
  totalDelta: { base: readonly number[]; amplitude: readonly number[] };
}

export interface FxVelSample {
  local: FxVelFrame;
  world: FxVelFrame;
}

export interface FxAtlas {
  behavior: number;
  index: number;
  fps: number;
  loopCount: number;
  colIndexBits: number;
  rowIndexBits: number;
  entryCount: number;
  /** T5 only: how many cells start mode 3 (`fixedRange`) cycles through from `index`. */
  indexRange?: number;
}

export type FxSpawn =
  /** `count: null` means for ever; the dump spells that INT_MAX. */
  { kind: "looping"; interval: number; count: number | null } | { kind: "oneShot" | "emission"; count: Range };

/**
 * Which per-particle random each field draws, as iw5mp.exe numbers them
 * (`fx_randomTable[seed + key]`, keys read from FX_SpawnElem and friends).
 * Keeping the game's layout means two fields never share a random by accident.
 */
export const RAND = {
  velocity: 0, // 0..2, one per axis
  angularVelocity: 3, // 3..5
  spawnOrigin: 6, // 6..8
  offsetYaw: 9,
  offsetHeight: 10,
  offsetRadius: 11,
  spawnAngles: 12, // 12..14
  gravity: 15,
  reflection: 16,
  life: 17,
  spawnDelay: 18,
  oneShotCount: 19,
  emitDist: 20,
  visual: 21,
  atlasStart: 22,
  color: 23,
  initialRotation: 24,
  rotation: 25,
  size0: 26,
  size1: 27,
  scale: 28,
  /** T5: a cloud's particle count. */
  cloudCount: 29,
} as const;
export const RAND_COUNT = 30;

export interface FxElem {
  type: string;
  spawn: FxSpawn;
  spawnDelay: Range;
  life: Range;
  spawnOrigin: Range3;
  spawnOffsetRadius: Range;
  spawnOffsetHeight: Range;
  /** Radians, in the game's (pitch, yaw, roll) order. */
  spawnAngles: Range3;
  /** Radians per millisecond, (pitch, yaw, roll). */
  angularVelocity: Range3;
  initialRotation: Range;
  /** A multiple of 800 units/s^2, applied only with FX_FLAG_GRAVITY. */
  gravity: Range;
  /** Metres from the camera to the *effect* within which the elem spawns; amplitude 0 = always. */
  spawnRange: Range;
  /** Metres: a particle fades out beyond base, over amplitude. Amplitude 0 = off. */
  fadeInRange: Range;
  /** Metres: a particle fades out as it comes within base + amplitude of the camera. */
  fadeOutRange: Range;
  /** Metres: with FX_FLAG_FRUSTUM_CULL, nothing spawns unless this sphere is in view. */
  spawnFrustumCullRadius: number;
  /** 0..1: how much the effect origin's lighting tints the colour. Not applied yet. */
  lightingFrac: number;
  atlas: FxAtlas;
  sortOrder: number;
  visuals: { kind: string | null; names: string[] };
  velSamples: FxVelSample[];
  visSamples: FxVisSample[];
  effectOnDeath: string | null;
  effectEmitted: string | null;
  randomSeed: number;
  /** Raw FxElemDef flags; see FX_FLAG_* in emitter.ts. */
  flags: number;
  /** T5: the quad's (top, bottom) width as a fraction of full, a trapezoid. Absent means (1, 1). */
  trim?: readonly [number, number];
  /** T5: the centre moved by `pivot[0]` half-widths along A and `pivot[1]` half-heights along B. */
  pivot?: readonly [number, number];
  /** T5 CLOUD: how many of the shared 1024 points one cloud draws, `[base, amplitude]` as an FxIntRange. */
  cloudDensity?: readonly [number, number];
}

export interface FxEffect {
  name: string;
  looping: boolean;
  /** Metres, for distance culling. Computed by the exporter: IW5 ships no bounding sphere. */
  radius: number;
  elems: FxElem[];
}

export interface FxMaterial {
  /** The file under `assets/fx/textures/`. Named after the image, not the material: several effects share a sheet. */
  texture: string;
  /**
   * How the game blends it. Read from the material rather than assumed: every one
   * of dome's fx materials is `alpha`, not additive, and drawn additively they
   * saturate to white blobs on a bright sky rather than hanging as haze.
   */
  blend: "alpha" | "add" | "multiply" | "screen";
  /** The literal RGB blend, as the game names it: what the renderer actually uses. */
  blendOp: string;
  blendSrc: string;
  blendDst: string;
  /** The game's alpha test, or null. `gt0` means "discard fully transparent texels". */
  alphaTest: string | null;
  sortKey: number | null;
  doubleSided: boolean;
  /** False for a `nofog` technique set: sheets meant to read at any distance. */
  fog: boolean;
  /** Metres, from zfeather's featherParms: fades a sprite as it nears the camera. */
  featherDepth: number | null;
  /**
   * T5: what the shader writes. `straight` is IW5's zfeather blend; `alpha` is
   * colour times alpha (`effect_add`), `luma` colour times alpha times its own
   * luminance (`effect_zfeather_add`). Absent means `straight`.
   */
  output?: "straight" | "alpha" | "luma";
  /** T5: an additive sheet fades to black in fog rather than toward the fog colour. */
  fogFade?: boolean;
  /** T5: `f = sat(dot(view, normal)^2 * scale + bias)` tints by lerp(end, begin, f) and scales alpha by f. */
  falloff?: { scale: number; bias: number; begin: readonly number[]; end: readonly number[] };
  /** T5: metres the sprite is pulled toward the eye, keeping its size on screen. */
  eyeOffset?: number;
  /** A technique set the runtime cannot draw (distortion), so its elems are counted instead. */
  undrawn?: string;
}

/** Whose conventions the library follows, where the games differ (docs/cod/reference.md#effects-fx). */
export type FxGame = "iw5" | "t5";

export interface FxLibrary {
  game: FxGame;
  effects: Record<string, FxEffect>;
  materials: Record<string, FxMaterial>;
}

const LIBRARY_VERSION = 4;

/**
 * Parse `effects.json`, refusing a version this build does not know.
 *
 * A silently-parsed future version is worse than a hard failure: the fields it
 * renamed would read as zero, and an effect that spawns nothing looks like a
 * rendering bug rather than a stale asset.
 */
export function readFxLibrary(data: unknown, source: string): FxLibrary {
  const d = data as { _version?: number; game?: FxGame; effects?: Record<string, FxEffect>; materials?: Record<string, FxMaterial> };
  if (d?._version !== LIBRARY_VERSION) {
    throw new Error(`${source}: fx library version ${String(d?._version)}, expected ${LIBRARY_VERSION}; re-export the world`);
  }
  // Libraries written before T5 carry no game: they are all MW3's.
  return { game: d.game ?? "iw5", effects: d.effects ?? {}, materials: d.materials ?? {} };
}

/**
 * A small, fast, seedable PRNG (mulberry32).
 *
 * Every random this subtree draws comes from one of these, never `Math.random`:
 * a held screenshot pose has to render the same particles every run, or the
 * pixel diffs `pnpm shots` produces are noise for the whole world, not just fx.
 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix a placement's own identity into an elem's authored seed, so copies differ but reproduce. */
export function seedOf(entityId: number, elemIndex: number, ordinal: number, authored: number): number {
  let h = (authored ^ 0x9e3779b9) >>> 0;
  for (const v of [entityId, elemIndex, ordinal]) {
    h = Math.imul(h ^ (v >>> 0), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

export function sampleRange(r: Range, rand: number): number {
  return r[0] + r[1] * rand;
}

/**
 * Where in a sample array `u` in [0, 1] falls: the pair to blend and how far.
 *
 * The arrays are `intervalCount + 1` long, so the last entry is the value at the
 * end of life. Treating the length as the interval count drops it, which is
 * exactly the fade-out: the effect pops instead of fading.
 */
export function interval(count: number, u: number): { i: number; j: number; t: number } {
  if (count <= 1) {
    return { i: 0, j: 0, t: 0 };
  }
  const spans = count - 1;
  const x = Math.min(Math.max(u, 0), 1) * spans;
  const i = Math.min(Math.floor(x), spans - 1);
  return { i, j: i + 1, t: x - i };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The visual state at `u` through a particle's life, with this particle's own randoms. */
/**
 * A curve that is the running integral of another, at sample-space position `t`
 * between samples `i` and `i + 1`, in "per sample step" units.
 *
 * `totalDelta` integrates `velocity` and `rotationTotal` integrates
 * `rotationDelta` by the trapezoid rule over sample index (the ratio is 1.0 across
 * every interval of all 581 MW3 effects). Within a step the rate is linear, so the
 * integral is quadratic; at t = 1 this lands exactly on the next stored total.
 * The engine multiplies by the particle's whole life in milliseconds.
 */
export function integrated(totalA: number, rateA: number, rateB: number, t: number): number {
  return totalA + rateA * t + ((rateB - rateA) * t * t) / 2;
}

/**
 * The visual state at `u` through a particle's life, with this particle's own randoms.
 *
 * `rotationTotal` comes back integrated, in sample-step units; the caller scales it
 * by the step duration.
 */
export function sampleVis(samples: FxVisSample[], u: number, rand: readonly number[], out: FxVisualState): FxVisualState {
  if (samples.length === 0) {
    out.color = [1, 1, 1, 1];
    out.size = [1, 1];
    out.scale = 1;
    out.rotationDelta = 0;
    out.rotationTotal = 0;
    return out;
  }
  const { i, j, t } = interval(samples.length, u);
  const a = samples[i]!;
  const b = samples[j]!;

  // Colour's amplitude is a second colour, not a delta: 12,083 of 18,073 samples
  // store amplitude == base, which only makes sense as "the other end of a
  // range". Adding them doubled the brightness. One random picks the point for
  // all four channels, so a particle's hue stays a hue.
  const rc = rand[RAND.color]!;
  const color: number[] = [];
  for (let k = 0; k < 4; k++) {
    const av = lerp(a.base.color[k]!, a.amplitude.color[k]!, rc);
    const bv = lerp(b.base.color[k]!, b.amplitude.color[k]!, rc);
    color[k] = lerp(av, bv, t);
  }

  // Everything else is base plus a signed delta, each size from its own random.
  const size: number[] = [];
  for (let k = 0; k < 2; k++) {
    const rs = rand[RAND.size0 + k]!;
    size[k] = lerp(a.base.size[k]! + a.amplitude.size[k]! * rs, b.base.size[k]! + b.amplitude.size[k]! * rs, t);
  }
  const rs = rand[RAND.scale]!;

  const rr = rand[RAND.rotation]!;
  const rdA = a.base.rotationDelta + a.amplitude.rotationDelta * rr;
  const rdB = b.base.rotationDelta + b.amplitude.rotationDelta * rr;
  const rtA = a.base.rotationTotal + a.amplitude.rotationTotal * rr;

  out.color = color;
  out.size = size;
  out.scale = lerp(a.base.scale + a.amplitude.scale * rs, b.base.scale + b.amplitude.scale * rs, t);
  out.rotationDelta = lerp(rdA, rdB, t);
  out.rotationTotal = integrated(rtA, rdA, rdB, t);
  return out;
}

/**
 * How far a particle has travelled at `u`, per velocity frame: metres per
 * millisecond integrated over sample index. Multiply by the particle's whole
 * life in milliseconds for metres -- not by one step's duration: FX_IntegrateVelocity
 * passes the full life through unchanged into every segment.
 *
 * The local frame turns with the emitter and the world frame does not, so they
 * come back separately. An elem only fills the frame its flags select; the other
 * is all zeros.
 */
export function sampleTravel(samples: FxVelSample[], u: number, rand: readonly number[], local: number[], world: number[]): void {
  local[0] = local[1] = local[2] = 0;
  world[0] = world[1] = world[2] = 0;
  if (samples.length < 2) {
    return;
  }
  const { i, j, t } = interval(samples.length, u);
  for (const [frame, out] of [
    ["local", local],
    ["world", world],
  ] as const) {
    const a = samples[i]![frame];
    const b = samples[j]![frame];
    for (let k = 0; k < 3; k++) {
      const r = rand[RAND.velocity + k]!;
      const total = a.totalDelta.base[k]! + a.totalDelta.amplitude[k]! * r;
      const rateA = a.velocity.base[k]! + a.velocity.amplitude[k]! * r;
      const rateB = b.velocity.base[k]! + b.velocity.amplitude[k]! * r;
      out[k] = integrated(total, rateA, rateB, t);
    }
  }
}

/** The velocity at `u`, per frame, in metres per millisecond (a direction for tails). */
export function sampleVelocity(samples: FxVelSample[], u: number, rand: readonly number[], local: number[], world: number[]): void {
  local[0] = local[1] = local[2] = 0;
  world[0] = world[1] = world[2] = 0;
  if (samples.length === 0) {
    return;
  }
  const { i, j, t } = interval(samples.length, u);
  for (const [frame, out] of [
    ["local", local],
    ["world", world],
  ] as const) {
    const a = samples[i]![frame].velocity;
    const b = samples[j]![frame].velocity;
    for (let k = 0; k < 3; k++) {
      const r = rand[RAND.velocity + k]!;
      out[k] = lerp(a.base[k]! + a.amplitude[k]! * r, b.base[k]! + b.amplitude[k]! * r, t);
    }
  }
}

export function emptyVisualState(): FxVisualState {
  return { color: [1, 1, 1, 1], rotationDelta: 0, rotationTotal: 0, size: [1, 1], scale: 1 };
}
