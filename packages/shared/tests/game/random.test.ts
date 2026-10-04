// Seeded randomness and the id hash: the two things a script may use in place of
// `Math.random()`, which eslint bans over that subtree.

import { describe, expect, it } from "vitest";
import { hashString, seeded } from "../../src/game/random.js";

describe("seeded", () => {
  it("draws the same sequence from the same seed, which is why it exists", () => {
    const a = seeded(1234);
    const b = seeded(1234);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("draws a different sequence from a different seed", () => {
    expect(seeded(1)()).not.toBe(seeded(2)());
  });

  it("stays in [0, 1)", () => {
    const next = seeded(99);
    for (let i = 0; i < 1000; i++) {
      const n = next();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  // 0 is a fixed point of xorshift: seeded with it, the sequence never moves.
  it("survives a zero seed", () => {
    const next = seeded(0);
    const drawn = new Set([next(), next(), next()]);
    expect(drawn.size).toBe(3);
  });
});

describe("hashString", () => {
  it("is stable, so every client picks the same body for one player", () => {
    expect(hashString("player-7")).toBe(hashString("player-7"));
  });

  it("is a non-negative 32-bit number, so it indexes an array", () => {
    for (const id of ["", "a", "player-7", "x".repeat(200)]) {
      const h = hashString(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("separates ids that differ by one character", () => {
    expect(hashString("player-1")).not.toBe(hashString("player-2"));
  });
});
