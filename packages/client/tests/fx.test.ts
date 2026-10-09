// The effect interpreter: curve sampling, seeded determinism, and the budget.
//
// The determinism test is the load-bearing one. `pnpm shots` settles for a few
// seconds of real, variable-dt frames before it captures, so if particles
// depended on how time was cut up, every pixel diff on a world with effects
// would be noise — and the tool stops being useful for anything else in it.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  DRAW_BILLBOARD,
  DRAW_BILLBOARD_VIEWPOINT,
  DRAW_BILLBOARD_VIEWPOINT_UP,
  DRAW_BILLBOARD_WORLD_UP,
  DRAW_LINE,
  DRAW_ORIENTED,
  DRAW_TAIL,
  FxEmitter,
  emptyView,
} from "../src/engine/fx/emitter.js";
import { fxMaterial } from "../src/engine/fx/batch.js";
import { FxSystem, distanceFade, fadeScale } from "../src/engine/fx/system.js";
import { CLOUD_POINTS, cloudPoints, cloudSlots, emptyCloudView } from "../src/engine/fx/cloud.js";
import { RAND_COUNT, interval, readFxLibrary, sampleRange, sampleVis, seeded, seedOf, emptyVisualState } from "../src/engine/fx/library.js";
import type { FxElem, FxVisSample } from "../src/engine/fx/library.js";

function visState(color: number[], size: number[], scale = 1) {
  return { color, rotationDelta: 0, rotationTotal: 0, size, scale };
}

function visSample(color: number[], size: number[]): FxVisSample {
  return { base: visState(color, size), amplitude: visState([0, 0, 0, 0], [0, 0], 0) };
}

const ZERO3 = [0, 0, 0];
const flatVel = {
  local: { velocity: { base: ZERO3, amplitude: ZERO3 }, totalDelta: { base: ZERO3, amplitude: ZERO3 } },
  world: { velocity: { base: ZERO3, amplitude: ZERO3 }, totalDelta: { base: ZERO3, amplitude: ZERO3 } },
};

function elem(over: Partial<FxElem> = {}): FxElem {
  return {
    type: "SPRITE_BILLBOARD",
    spawn: { kind: "looping", interval: 0.1, count: null },
    spawnDelay: [0, 0],
    life: [1, 0],
    spawnOrigin: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    spawnOffsetRadius: [0, 0],
    spawnOffsetHeight: [0, 0],
    spawnAngles: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    angularVelocity: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    initialRotation: [0, 0],
    gravity: [0, 0],
    atlas: { behavior: 0, index: 0, fps: 0, loopCount: 0, colIndexBits: 2, rowIndexBits: 2, entryCount: 16 },
    sortOrder: 0,
    visuals: { kind: "material", names: ["gfx_a"] },
    velSamples: [flatVel],
    visSamples: [visSample([1, 1, 1, 1], [1, 1])],
    effectOnDeath: null,
    effectEmitted: null,
    randomSeed: 7,
    flags: 0,
    spawnRange: [0, 0],
    fadeInRange: [0, 0],
    fadeOutRange: [0, 0],
    spawnFrustumCullRadius: 0,
    lightingFrac: 0,
    ...over,
  };
}

const placement = { id: 3, position: { x: 10, y: 20, z: 30 }, rotation: { x: 0, y: 0, z: 0 }, delay: 0 };

describe("range sampling", () => {
  it("is base plus a signed amplitude, not min and span", () => {
    // spawnAngles ship base 2pi, amplitude -4pi: a full turn either way.
    expect(sampleRange([6.28, -12.56], 0)).toBeCloseTo(6.28);
    expect(sampleRange([6.28, -12.56], 1)).toBeCloseTo(-6.28);
    expect(sampleRange([6.28, -12.56], 0.5)).toBeCloseTo(0);
  });
});

describe("curve sampling", () => {
  it("hits the endpoints exactly and interpolates between them", () => {
    const samples = [visSample([0, 0, 0, 0], [0, 0]), visSample([1, 1, 1, 1], [10, 10])];
    const rand = new Array<number>(RAND_COUNT).fill(0);
    const out = emptyVisualState();

    expect(sampleVis(samples, 0, rand, out).color[3]).toBeCloseTo(0);
    expect(sampleVis(samples, 1, rand, out).color[3]).toBeCloseTo(1);
    expect(sampleVis(samples, 0.5, rand, out).size[0]).toBeCloseTo(5);
  });

  it("keeps the final sample, which is the fade-out", () => {
    // The arrays are intervalCount + 1 long. Treating the length as the interval
    // count drops the last entry, and the effect pops instead of fading.
    expect(interval(3, 1)).toEqual({ i: 1, j: 2, t: 1 });
    expect(interval(1, 0.5)).toEqual({ i: 0, j: 0, t: 0 });
  });
});

describe("distance fades", () => {
  it("hides a particle far away with fadeIn and close up with fadeOut", () => {
    // FX_FadeFactor: 1 up to base, falling to 0 over amplitude.
    expect(distanceFade([10, 10], [0, 0], 5)).toBe(1);
    expect(distanceFade([10, 10], [0, 0], 15)).toBeCloseTo(0.5);
    expect(distanceFade([10, 10], [0, 0], 30)).toBe(0);
    // fadeOut is the inverse: invisible inside base, visible beyond base+amp.
    expect(distanceFade([0, 0], [2, 2], 1)).toBe(0);
    expect(distanceFade([0, 0], [2, 2], 3)).toBeCloseTo(0.5);
    expect(distanceFade([0, 0], [2, 2], 10)).toBe(1);
    // An amplitude of zero switches that fade off entirely.
    expect(distanceFade([0, 0], [0, 0], 1e6)).toBe(1);
  });
});

describe("the final alpha scale", () => {
  it("draws an unfaded 255 as 253, as the game's fixed-point product does", () => {
    // (distanceFade * occlusionFade * a) >> 16 with both fades at 255.
    expect(Math.floor(255 * fadeScale(1))).toBe(253);
    expect(fadeScale(0)).toBe(0);
  });
});

describe("the seeded generator", () => {
  it("gives the same stream for the same seed and different ones otherwise", () => {
    const draw = (s: number) => {
      const r = seeded(s);
      return [r(), r(), r()];
    };
    expect(draw(1234)).toEqual(draw(1234));
    expect(draw(1234)).not.toEqual(draw(1235));
    for (const v of draw(99)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("separates two placements of the same effect", () => {
    expect(seedOf(1, 0, 0, 7)).not.toBe(seedOf(2, 0, 0, 7));
    expect(seedOf(1, 0, 0, 7)).toBe(seedOf(1, 0, 0, 7));
  });
});

describe("an emitter", () => {
  it("spawns on its interval and retires what dies", () => {
    const e = new FxEmitter(elem({ life: [1, 0], spawn: { kind: "looping", interval: 0.25, count: null } }), 0, placement);
    e.step(1, 1000);
    // t=0, .25, .5, .75, 1 -> 5 due, none older than its 1 s life yet
    expect(e.particles.length).toBe(5);
    e.step(1, 1000);
    expect(e.particles.length).toBeGreaterThan(0);
    expect(e.particles.every((p) => e.time - p.born < p.life)).toBe(true);
  });

  it("stops spawning at the budget rather than killing anything alive", () => {
    // A long life, so nothing ages out and the only thing that can change the
    // set is the budget itself.
    const e = new FxEmitter(elem({ life: [1000, 0], spawn: { kind: "looping", interval: 0.01, count: null } }), 0, placement);
    e.step(1, 10);
    expect(e.particles.length).toBe(10);
    const born = e.particles.map((p) => p.born);

    e.step(1, 10);
    // Capped, and every particle that was alive still is: over budget an emitter
    // declines to spawn, and never culls a living particle, which would pop.
    expect(e.particles.length).toBe(10);
    expect(e.particles.map((p) => p.born)).toEqual(born);
  });

  it("makes room again as particles age out", () => {
    const e = new FxEmitter(elem({ life: [1, 0], spawn: { kind: "looping", interval: 0.01, count: null } }), 0, placement);
    e.step(1, 10);
    expect(e.particles.length).toBe(10);
    e.step(0.5, 10);
    // The first ten have aged past their 1 s life; the emitter refills to the cap.
    expect(e.particles.length).toBe(10);
    expect(e.particles.every((p) => p.born > 0.5)).toBe(true);
  });

  it("honours a finite looping count", () => {
    const e = new FxEmitter(elem({ spawn: { kind: "looping", interval: 0.1, count: 3 }, life: [100, 0] }), 0, placement);
    e.step(5, 1000);
    expect(e.particles.length).toBe(3);
  });

  it("spawns a one-shot burst exactly once", () => {
    const e = new FxEmitter(elem({ spawn: { kind: "oneShot", count: [4, 0] }, life: [100, 0] }), 0, placement);
    e.step(1, 1000);
    expect(e.particles.length).toBe(4);
    e.step(1, 1000);
    expect(e.particles.length).toBe(4);
  });

  it("travels by the integral of its velocity, scaled by the whole life", () => {
    // FX_IntegrateVelocity passes the particle's full life in milliseconds into
    // every segment. 4 intervals, 0.002 m/ms per step: stored totals 0 .. 0.008,
    // so a 10 s particle is 0.004 * 10000 = 40 m out at half-life and 80 m at the
    // end. Scaling by one step's share (life / 4) would put it a quarter as far.
    const v = [0.002, 0, 0];
    const frame = (td: number) => ({
      velocity: { base: v, amplitude: ZERO3 },
      totalDelta: { base: [td, 0, 0], amplitude: ZERO3 },
    });
    const flat = { velocity: { base: ZERO3, amplitude: ZERO3 }, totalDelta: { base: ZERO3, amplitude: ZERO3 } };
    const samples = [0, 0.002, 0.004, 0.006, 0.008].map((td) => ({ local: frame(td), world: flat }));
    const e = new FxEmitter(elem({ velSamples: samples, spawn: { kind: "oneShot", count: [1, 0] }, life: [10, 0], flags: 0x01000000 }), 0, {
      ...placement,
      position: { x: 0, y: 0, z: 0 },
    });
    const out = emptyView();

    e.step(5, 1000);
    e.sample(e.particles[0]!, out);
    expect(out.x).toBeCloseTo(40);

    e.step(4.9999, 1000);
    e.sample(e.particles[0]!, out);
    expect(out.x).toBeCloseTo(80, 1);
  });

  it("ends exactly on the last stored total when the rate varies", () => {
    // Accelerating: velocity 0 then 0.004, trapezoid total 0.002 per step.
    const frame = (vel: number, td: number) => ({
      velocity: { base: [vel, 0, 0], amplitude: ZERO3 },
      totalDelta: { base: [td, 0, 0], amplitude: ZERO3 },
    });
    const flat = { velocity: { base: ZERO3, amplitude: ZERO3 }, totalDelta: { base: ZERO3, amplitude: ZERO3 } };
    const samples = [
      { local: frame(0, 0), world: flat },
      { local: frame(0.004, 0.002), world: flat },
    ];
    const e = new FxEmitter(elem({ velSamples: samples, spawn: { kind: "oneShot", count: [1, 0] }, life: [1, 0] }), 0, {
      ...placement,
      position: { x: 0, y: 0, z: 0 },
    });
    const out = emptyView();
    e.step(0.5, 1000);
    e.sample(e.particles[0]!, out);
    // Quadratic within the step: a quarter of the way, not half.
    expect(out.x).toBeCloseTo(0.002 * 0.25 * 1000);
    e.step(0.4999, 1000);
    e.sample(e.particles[0]!, out);
    expect(out.x).toBeCloseTo(0.002 * 1000, 1);
  });

  it("does not turn world-frame travel with the emitter", () => {
    const moving = { velocity: { base: [0.001, 0, 0], amplitude: ZERO3 }, totalDelta: { base: [0.001, 0, 0], amplitude: ZERO3 } };
    const still = { velocity: { base: ZERO3, amplitude: ZERO3 }, totalDelta: { base: ZERO3, amplitude: ZERO3 } };
    const samples = [
      { local: still, world: { ...moving, totalDelta: { base: ZERO3, amplitude: ZERO3 } } },
      { local: still, world: moving },
    ];
    const turned = { ...placement, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 } };
    const e = new FxEmitter(elem({ velSamples: samples, spawn: { kind: "oneShot", count: [1, 0] }, life: [2, 0] }), 0, turned);
    e.step(1.9999, 1000);
    const out = emptyView();
    e.sample(e.particles[0]!, out);
    expect(out.x).toBeCloseTo(2, 1);
    expect(out.z).toBeCloseTo(0, 3);
  });

  it("takes its size from `size` alone, not size times scale", () => {
    // dome's sandstorm ships `scale` 0 throughout; multiplying zeroed every sprite.
    const vis = (size: number[]) => ({
      base: { color: [1, 1, 1, 1], rotationDelta: 0, rotationTotal: 0, size, scale: 0 },
      amplitude: { color: [1, 1, 1, 1], rotationDelta: 0, rotationTotal: 0, size: [0, 0], scale: 0 },
    });
    const square = new FxEmitter(elem({ visSamples: [vis([11, 22])], spawn: { kind: "oneShot", count: [1, 0] } }), 0, placement);
    square.step(0, 1000);
    const out = emptyView();
    square.sample(square.particles[0]!, out);
    // No non-uniform flag: size[1] is not used, the sprite is square.
    expect(out.w).toBeCloseTo(11);
    expect(out.h).toBeCloseTo(11);

    const tall = new FxEmitter(elem({ visSamples: [vis([11, 22])], spawn: { kind: "oneShot", count: [1, 0] }, flags: 0x10000000 }), 0, placement);
    tall.step(0, 1000);
    tall.sample(tall.particles[0]!, out);
    expect(out.w).toBeCloseTo(11);
    expect(out.h).toBeCloseTo(22);
  });

  it("treats a colour amplitude as the other end of a range, not a delta", () => {
    // 12,083 of 18,073 MW3 samples store amplitude == base. Added, that doubles
    // the colour; as a range it is simply that colour.
    const grey = [0.5, 0.5, 0.5, 0.5];
    const vis = {
      base: { color: grey, rotationDelta: 0, rotationTotal: 0, size: [1, 1], scale: 0 },
      amplitude: { color: grey, rotationDelta: 0, rotationTotal: 0, size: [0, 0], scale: 0 },
    };
    const e = new FxEmitter(elem({ visSamples: [vis], spawn: { kind: "oneShot", count: [1, 0] } }), 0, placement);
    e.step(0, 1000);
    const out = emptyView();
    e.sample(e.particles[0]!, out);
    expect([out.r, out.g, out.b, out.a]).toEqual(grey);
  });

  it("turns its spawn origin with the placement only when the elem asks", () => {
    // FX_GetOriginForElem: flag 0x2 rotates the origin range by the placement's
    // axes; without it the offset is in world axes.
    const offset = (flags: number) =>
      elem({
        flags,
        spawn: { kind: "oneShot", count: [1, 0] },
        spawnOrigin: [
          [10, 0],
          [0, 0],
          [0, 0],
        ],
      });
    const turned = { ...placement, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 } };
    const out = emptyView();

    const rotated = new FxEmitter(offset(0x2), 0, turned);
    rotated.step(0, 1000);
    rotated.sample(rotated.particles[0]!, out);
    // A quarter turn about +Y takes a local +X offset to -Z.
    expect(out.x).toBeCloseTo(0, 4);
    expect(out.z).toBeCloseTo(-10, 4);

    const world = new FxEmitter(offset(0), 0, turned);
    world.step(0, 1000);
    world.sample(world.particles[0]!, out);
    expect(out.x).toBeCloseTo(10, 4);
    expect(out.z).toBeCloseTo(0, 4);
  });

  it("falls under gravity only with the flag, at 800 units/s^2 per unit", () => {
    const heavy = (flags: number) => elem({ flags, gravity: [1, 0], spawn: { kind: "oneShot", count: [1, 0] }, life: [10, 0] });
    const at = { ...placement, position: { x: 0, y: 0, z: 0 } };
    const out = emptyView();

    const falling = new FxEmitter(heavy(0x04000000), 0, at);
    falling.step(2, 1000);
    falling.sample(falling.particles[0]!, out);
    expect(out.y).toBeCloseTo(-0.5 * (800 / 39.37) * 4);

    const floating = new FxEmitter(heavy(0), 0, at);
    floating.step(2, 1000);
    floating.sample(floating.particles[0]!, out);
    expect(out.y).toBeCloseTo(0);
  });

  it("lays a tail along its velocity", () => {
    const moving = { velocity: { base: [0, 0, 0.001], amplitude: ZERO3 }, totalDelta: { base: [0, 0, 0.001], amplitude: ZERO3 } };
    const still = { velocity: { base: [0, 0, 0.001], amplitude: ZERO3 }, totalDelta: { base: ZERO3, amplitude: ZERO3 } };
    const e = new FxEmitter(
      elem({
        type: "TAIL",
        velSamples: [
          { local: still, world: still },
          { local: moving, world: still },
        ],
        spawn: { kind: "oneShot", count: [1, 0] },
      }),
      0,
      { ...placement, position: { x: 0, y: 0, z: 0 } },
    );
    e.step(0.5, 1000);
    const out = emptyView();
    e.sample(e.particles[0]!, out);
    expect(out.mode).toBe(DRAW_TAIL);
    expect([out.ax, out.ay, out.az]).toEqual([0, 0, 1]);
  });

  it("lays an oriented sprite in its run frame, not by its own angles", () => {
    // FX_DrawOrientedSprite spans the run-mode frame's axis[1] (left) and
    // axis[2] (up). spawnAngles are a model's business; give them a value here to
    // prove they are ignored.
    const oriented = (flags: number) =>
      elem({
        type: "SPRITE_ORIENTED",
        flags,
        spawn: { kind: "oneShot", count: [1, 0] },
        spawnAngles: [
          [1, 0],
          [1, 0],
          [1, 0],
        ],
      });
    const turned = { ...placement, rotation: { x: 0, y: Math.PI / 2, z: 0 } };
    const out = emptyView();
    const axes = () => [out.ax, out.ay, out.az, out.bx, out.by, out.bz].map((v) => Math.round(v * 1e6) / 1e6 + 0);

    // Run mode 0: the world's axes. CoD left (+Y) is engine -Z, CoD up is engine +Y.
    const world = new FxEmitter(oriented(0), 0, turned);
    world.step(0, 1000);
    world.sample(world.particles[0]!, out);
    expect(out.mode).toBe(DRAW_ORIENTED);
    expect(axes()).toEqual([0, 0, -1, 0, 1, 0]);

    // Effect frame (0x40): the same axes turned with the placement.
    const framed = new FxEmitter(oriented(0x40), 0, turned);
    framed.step(0, 1000);
    framed.sample(framed.particles[0]!, out);
    expect(axes()).toEqual([-1, 0, 0, 0, 1, 0]);
  });

  it("picks atlas frames the way FX_GetAtlasUV does", () => {
    const atlas = (behavior: number, fps: number, index = 0, loopCount = 0) => ({
      behavior,
      index,
      fps,
      loopCount,
      colIndexBits: 2,
      rowIndexBits: 2,
      entryCount: 16,
    });
    const frameAt = (a: ReturnType<typeof atlas>, t: number, life = 10) => {
      const e = new FxEmitter(elem({ atlas: a, spawn: { kind: "oneShot", count: [1, 0] }, life: [life, 0] }), 0, placement);
      e.step(t, 1000);
      const out = emptyView();
      e.sample(e.particles[0]!, out);
      return out.frame;
    };
    // Fixed start, advancing at 24 fps: integer ms * fps / 1000.
    expect(frameAt(atlas(0, 24, 3), 0.25)).toBe(3 + 6);
    // Over the particle's life (behaviour 4), ignoring fps.
    expect(frameAt(atlas(4, 24), 5)).toBe(8);
    // Wrapped to the sheet.
    expect(frameAt(atlas(0, 24), 0.75)).toBe(18 & 15);
    // Held on the last frame once the loops are spent (behaviour 8).
    expect(frameAt(atlas(8, 24, 0, 1), 0.75)).toBe(15);
  });

  it("places a particle in world space, at its emitter", () => {
    const e = new FxEmitter(elem({ spawn: { kind: "oneShot", count: [1, 0] } }), 0, placement);
    e.step(0, 1000);
    const out = emptyView();
    e.sample(e.particles[0]!, out);
    expect(out.x).toBeCloseTo(10);
    expect(out.y).toBeCloseTo(20);
    expect(out.z).toBeCloseTo(30);
  });

  it("reaches the same state however time was cut up", () => {
    // The `pnpm shots` guarantee: one big step and many small ones must agree,
    // or a screenshot depends on the frame rate that led up to it.
    const make = () => new FxEmitter(elem({ life: [2, 0], spawn: { kind: "looping", interval: 0.1, count: null } }), 0, placement);

    const coarse = make();
    coarse.step(1, 1000);

    const fine = make();
    for (let i = 0; i < 100; i++) {
      fine.step(0.01, 1000);
    }

    expect(fine.particles.length).toBe(coarse.particles.length);
    const view = (e: FxEmitter) =>
      e.particles.map((p) => {
        const o = emptyView();
        e.sample(p, o);
        return [o.x.toFixed(6), o.y.toFixed(6), o.w.toFixed(6), o.a.toFixed(6)].join();
      });
    expect(view(fine)).toEqual(view(coarse));
  });
});

describe("asset urls", () => {
  it("joins a site-relative base by concatenation, as the rest of scene/ does", async () => {
    // `new URL(path, "/worlds/dome-mw3/")` throws "Invalid base URL": the base is
    // site-relative, not absolute. Every other loader in scene/ concatenates.
    const asked: string[] = [];
    const store = { fxSprite: (url: string) => (asked.push(url), {}) } as never;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return {
        ok: true,
        json: async () => ({
          _version: 4,
          materials: {
            gfx_a: {
              texture: "a.png",
              blend: "alpha",
              blendOp: "add",
              blendSrc: "srcalpha",
              blendDst: "invsrcalpha",
              alphaTest: "gt0",
              sortKey: 48,
              doubleSided: false,
              fog: true,
              featherDepth: 2,
            },
          },
          effects: {
            "w/s": {
              name: "w/s",
              looping: true,
              radius: 1,
              elems: [{ ...elem(), visuals: { kind: "material", names: ["gfx_a"] } }],
            },
          },
        }),
      };
    }) as never;

    try {
      const { buildFx } = await import("../src/scene/fx.js");
      const world = {
        fx: { source: "assets/fx/effects.json" },
        effects: [{ id: 1, fx: "w/s", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, delay: 0 }],
      } as never;
      await buildFx(world, "/worlds/dome-mw3/", store);
    } finally {
      globalThis.fetch = original;
    }

    expect(asked[0]).toBe("/worlds/dome-mw3/assets/fx/effects.json");
    expect(asked[1]).toBe("/worlds/dome-mw3/assets/fx/textures/a.png");
  });
});

describe("the library", () => {
  it("refuses a version it does not know rather than reading zeroes", () => {
    expect(() => readFxLibrary({ _version: 99, effects: {} }, "x.json")).toThrow(/version 99/);
    expect(() => readFxLibrary({}, "x.json")).toThrow();
    // A library written before materials carried their blend mode is refused too:
    // read as v2 it would draw every sheet additive and saturate to white.
    expect(() => readFxLibrary({ _version: 3, effects: {}, materials: {} }, "x.json")).toThrow(/version 3/);
    expect(readFxLibrary({ _version: 4, effects: {}, materials: {} }, "x.json").effects).toEqual({});
  });

  it("defaults a missing materials table rather than failing", () => {
    expect(readFxLibrary({ _version: 4, effects: {} }, "x.json").materials).toEqual({});
  });
});

describe("Black Ops (T5) elements", () => {
  const once = { kind: "oneShot", count: [1, 0] } as const;
  const sampled = (e: FxElem, game: "iw5" | "t5" = "t5", place = placement, t = 0) => {
    const emitter = new FxEmitter(e, 0, place, game);
    emitter.step(t, 1000);
    const out = emptyView();
    emitter.sample(emitter.particles[0]!, out);
    return out;
  };
  const round = (vs: number[]) => vs.map((v) => Math.round(v * 1e6) / 1e6 + 0);

  it("lays a rotated sprite on its own spawn angles, through the run frame", () => {
    // Yaw 90 degrees: CoD left (+Y) turns to -X, and up stays up.
    const rotated = (flags: number) =>
      elem({
        type: "SPRITE_ROTATED",
        flags,
        spawn: once,
        spawnAngles: [
          [0, 0],
          [Math.PI / 2, 0],
          [0, 0],
        ],
      });
    let out = sampled(rotated(0));
    expect(out.mode).toBe(DRAW_ORIENTED);
    // CoD (-1, 0, 0) is engine (-1, 0, 0); CoD up is engine +Y.
    expect(round([out.ax, out.ay, out.az, out.bx, out.by, out.bz])).toEqual([-1, 0, 0, 0, 1, 0]);

    // In the effect's frame, a placement turned 90 degrees about engine Y turns it again.
    out = sampled(rotated(0x40), "t5", { ...placement, rotation: { x: 0, y: Math.PI / 2, z: 0 } });
    expect(round([out.ax, out.ay, out.az])).toEqual([0, 0, 1]);
  });

  it("draws a line ahead of its particle and a tail behind it, both rolling on T5", () => {
    const moving = {
      local: flatVel.local,
      world: { velocity: { base: [0, 1, 0], amplitude: ZERO3 }, totalDelta: { base: ZERO3, amplitude: ZERO3 } },
    };
    const streak = (type: string) => elem({ type, spawn: once, flags: 0x02000000, velSamples: [moving, moving], initialRotation: [0.5, 0] });
    expect(sampled(streak("LINE")).mode).toBe(DRAW_LINE);
    expect(sampled(streak("TAIL")).mode).toBe(DRAW_TAIL);
    expect(sampled(streak("TAIL")).rot).toBeCloseTo(0.5);
    // IW5's tail draw is unread on roll, so it keeps drawing without one.
    expect(sampled(streak("TAIL"), "iw5").rot).toBe(0);
  });

  it("faces a billboard by T5's world-up and viewpoint flags, and ignores them on IW5", () => {
    const facing = (flags: number, game: "iw5" | "t5" = "t5") => sampled(elem({ flags, spawn: once }), game).mode;
    expect(facing(0)).toBe(DRAW_BILLBOARD);
    expect(facing(0x80000)).toBe(DRAW_BILLBOARD_WORLD_UP);
    expect(facing(0x100000)).toBe(DRAW_BILLBOARD_VIEWPOINT);
    expect(facing(0x180000)).toBe(DRAW_BILLBOARD_VIEWPOINT_UP);
    expect(facing(0x180000, "iw5")).toBe(DRAW_BILLBOARD);
  });

  it("carries a trim and pivot to the quad, defaulting to a full, centred one", () => {
    let out = sampled(elem({ spawn: once }));
    expect([out.trimTop, out.trimBottom, out.pivotX, out.pivotY]).toEqual([1, 1, 0, 0]);
    out = sampled(elem({ spawn: once, trim: [0.29, 0.53], pivot: [0, -1] }));
    expect([out.trimTop, out.trimBottom, out.pivotX, out.pivotY]).toEqual([0.29, 0.53, 0, -1]);
  });

  it("cycles a fixed range of atlas cells from its index (start mode 3)", () => {
    const atlas = { behavior: 3, index: 4, fps: 10, loopCount: 0, colIndexBits: 2, rowIndexBits: 2, entryCount: 16, indexRange: 3 };
    const frameAt = (t: number) => sampled(elem({ atlas, spawn: once, life: [10, 0] }), "t5", placement, t).frame;
    expect([0, 0.1, 0.2, 0.3].map(frameAt)).toEqual([4, 5, 6, 4]);
  });

  it("draws an unfaded 255 as 254, rounding its fade to a byte", () => {
    expect(Math.round(255 * fadeScale(1, "t5"))).toBe(254);
    expect(fadeScale(0, "t5")).toBe(0);
  });
});

describe("timing", () => {
  it("holds each particle back by its own spawn delay and draws it only after", () => {
    const e = new FxEmitter(elem({ spawn: { kind: "oneShot", count: [1, 0] }, spawnDelay: [0.5, 0], life: [1, 0] }), 0, placement);
    e.step(0.25, 1000);
    expect(e.particles.length).toBe(1);
    expect(e.isBorn(e.particles[0]!)).toBe(false);
    e.step(0.5, 1000);
    expect(e.isBorn(e.particles[0]!)).toBe(true);
    // It lives its whole second after being born, not after being spawned.
    e.step(0.6, 1000);
    expect(e.particles.length).toBe(1);
    e.step(0.5, 1000);
    expect(e.done).toBe(true);
  });

  it("plays a repeating placement again only once the last instance has finished", () => {
    const camera = new THREE.PerspectiveCamera();
    const burst = elem({ spawn: { kind: "oneShot", count: [1, 0] }, life: [2, 0] });
    const library = { game: "t5" as const, effects: { burst: { name: "burst", looping: false, radius: 1, elems: [burst] } }, materials: {} };
    const sys = new FxSystem();
    sys.attach([{ ...placement, fx: "burst", repeat: 0.5 }], library, { batches: new Map(), batchOf: new Map() });
    // The repeat passes at 0.5 s but the particle lives until 2 s: the next starts at
    // the first quarter-second poll after it dies, never on top of it.
    const counts: number[] = [];
    for (let i = 0; i < 180; i++) {
      sys.update(1 / 60, camera);
      if (i % 15 === 14) {
        counts.push(sys.particleCount);
      }
    }
    expect(Math.max(...counts)).toBe(1);
    expect(counts.filter((n) => n === 0).length).toBeLessThan(3);
  });

  it("never restarts a placement whose effect loops for ever", () => {
    const camera = new THREE.PerspectiveCamera();
    const library = { game: "t5" as const, effects: { snow: { name: "snow", looping: true, radius: 1, elems: [elem({ life: [0.5, 0] })] } }, materials: {} };
    const sys = new FxSystem();
    sys.attach([{ ...placement, fx: "snow", repeat: 0.5 }], library, { batches: new Map(), batchOf: new Map() });
    for (let i = 0; i < 120; i++) {
      sys.update(1 / 60, camera);
    }
    // One instance spawning every 0.1 s with a 0.5 s life: five alive, not ten.
    expect(sys.particleCount).toBe(5);
  });
});

describe("particle clouds", () => {
  it("scatters the uniform points by an LFSR that visits every slot exactly once", () => {
    const slots = cloudSlots();
    expect(slots[0]).toBe(0);
    expect(new Set(slots).size).toBe(CLOUD_POINTS);
    expect(Math.max(...slots)).toBe(CLOUD_POINTS - 1);
  });

  it("fills a cube with one half and a clipped gaussian with the other", () => {
    const p = cloudPoints();
    const half = (from: number) => Array.from(p.subarray(from * 3, (from + CLOUD_POINTS) * 3));
    const uniform = half(0);
    const gaussian = half(CLOUD_POINTS);
    expect(Math.min(...uniform)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...uniform)).toBeLessThanOrEqual(1);
    const spread = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
    // A uniform cube's RMS is 1/sqrt(3); a quarter-normal's is about 0.25.
    expect(spread(uniform)).toBeCloseTo(1 / Math.sqrt(3), 1);
    expect(spread(gaussian)).toBeCloseTo(0.25, 1);
  });

  it("draws a window of the shared points, scaled in game units, and nothing at scale 0", () => {
    const cloud = (scale: number, density: [number, number]) =>
      elem({
        type: "CLOUD",
        spawn: { kind: "oneShot", count: [1, 0] },
        cloudDensity: density,
        visSamples: [{ base: visState([1, 1, 1, 1], [0.1, 0.1], scale), amplitude: visState([1, 1, 1, 1], [0, 0], 0) }],
      });
    const view = emptyCloudView();
    const e = new FxEmitter(cloud(100, [1024, 0]), 0, placement, "t5");
    e.step(0, 1000);
    expect(e.sampleCloud(e.particles[0]!, view)).toBe(true);
    expect(view.scale).toBeCloseTo(100 * 0.0254);
    // The whole buffer: every cloud of density 1024 draws the same points.
    expect([view.offset, view.count]).toEqual([0, 1024]);

    const few = new FxEmitter(cloud(100, [10, 0]), 0, placement, "t5");
    few.step(0, 1000);
    few.sampleCloud(few.particles[0]!, view);
    expect(view.count).toBe(10);
    expect(view.offset + view.count).toBeLessThanOrEqual(CLOUD_POINTS);

    const flat = new FxEmitter(cloud(0, [1024, 0]), 0, placement, "t5");
    flat.step(0, 1000);
    expect(flat.sampleCloud(flat.particles[0]!, view)).toBe(false);
  });
});

describe("soft particles", () => {
  const material = (blendSrc: string, blendDst: string) =>
    fxMaterial(new THREE.Texture(), { blendOp: "add", blendSrc, blendDst, doubleSided: false, fog: false, featherDepth: 0.5 }, { cols: 1, rows: 1 });

  it("fades an additive blend by its colour, since one/one ignores alpha", () => {
    expect(material("one", "one").defines.SOFT_RGB).toBeDefined();
    expect(material("invdestcolor", "one").defines.SOFT_RGB).toBeDefined();
    expect(material("srcalpha", "invsrcalpha").defines.SOFT_RGB).toBeUndefined();
  });
});
