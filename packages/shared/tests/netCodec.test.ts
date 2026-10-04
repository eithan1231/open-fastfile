// The wire format's mechanism (src/net/codec/): bits in and out of a buffer, and
// the field types a message is described with. Nothing here knows what a player
// is — netPackets.test.ts covers the messages themselves.

import { describe, expect, it } from "vitest";
import { BitReader, BitWriter } from "../src/net/codec/bits.js";
import { angle, array, bool, enumOf, f32, int, nullable, quant, str, struct, uint, type Codec } from "../src/net/codec/schema.js";

describe("BitWriter/BitReader", () => {
  it("packs sub-byte fields, so five booleans cost one byte", () => {
    const w = new BitWriter();
    for (const v of [true, false, true, true, false]) {
      w.bool(v);
    }
    expect(w.finish()).toHaveLength(1);
  });

  it("writes fields most-significant bit first, so a byte-aligned byte is that byte", () => {
    const w = new BitWriter();
    w.bits(0xab, 8);
    w.bits(0xcd, 8);
    expect([...w.finish()]).toEqual([0xab, 0xcd]);
  });

  it("round-trips every width, including the full 32 bits", () => {
    const w = new BitWriter();
    const values = [1, 2, 5, 7, 13, 17, 24, 31, 32].map((bits) => [bits, bits === 32 ? 0xffffffff : 2 ** bits - 1] as const);
    for (const [bits, value] of values) {
      w.bits(value, bits);
    }
    const r = new BitReader(w.finish());
    for (const [bits, value] of values) {
      expect(r.bits(bits)).toBe(value);
    }
  });

  it("round-trips floats across a straddled byte boundary", () => {
    const w = new BitWriter();
    w.bits(1, 3); // knock the cursor off alignment
    w.f32(-1234.5);
    const r = new BitReader(w.finish());
    r.bits(3);
    expect(r.f32()).toBe(-1234.5);
  });

  it("grows past its initial buffer", () => {
    const w = new BitWriter(1);
    for (let i = 0; i < 500; i++) {
      w.bits(i & 0xff, 8);
    }
    const r = new BitReader(w.finish());
    for (let i = 0; i < 500; i++) {
      expect(r.bits(8)).toBe(i & 0xff);
    }
  });

  it("throws past the end rather than reading zeroes", () => {
    const r = new BitReader(new Uint8Array([0xff]));
    expect(r.bits(8)).toBe(0xff);
    expect(() => r.bits(1)).toThrow(/truncated/);
  });
});

function through<T>(codec: Codec<T>, value: T): T {
  const w = new BitWriter();
  codec.write(w, value);
  return codec.read(new BitReader(w.finish()));
}

describe("field codecs", () => {
  it("carries integers, booleans, enums and strings exactly", () => {
    expect(through(uint(10), 1023)).toBe(1023);
    expect(through(int(8), -128)).toBe(-128);
    expect(through(int(8), 127)).toBe(127);
    expect(through(bool, true)).toBe(true);
    expect(through(enumOf(["a", "b", "c"]), "c")).toBe("c");
    expect(through(str(), "")).toBe("");
    expect(through(str(), "a world/with-punctuation")).toBe("a world/with-punctuation");
    // Length is bytes, not characters: these are 4 and 2 bytes respectively.
    expect(through(str(), "🎯é")).toBe("🎯é");
  });

  it("refuses a value a field cannot carry, rather than truncating it silently", () => {
    const w = new BitWriter();
    expect(() => uint(4).write(w, 16)).toThrow(/cannot carry/);
    expect(() => uint(4).write(w, -1)).toThrow(/cannot carry/);
    expect(() => uint(4).write(w, 1.5)).toThrow(/cannot carry/);
    expect(() => int(4).write(w, 8)).toThrow(/cannot carry/);
    expect(() => f32.write(w, Infinity)).toThrow(/cannot carry/);
    expect(() => f32.write(w, NaN)).toThrow(/cannot carry/);
    expect(() => str(8).write(w, "x".repeat(256))).toThrow(/exceeds/);
  });

  it("quantizes to its declared step, with both ends of the range exact", () => {
    const q = quant(0, 1, 8);
    expect(through(q, 0)).toBe(0);
    expect(through(q, 1)).toBe(1);
    // 8 bits over 0..1 is 255 steps; nothing may be further than half a step out.
    for (let i = 0; i <= 100; i++) {
      const v = i / 100;
      expect(Math.abs(through(q, v) - v)).toBeLessThanOrEqual(0.5 / 255);
    }
  });

  it("clamps a value outside a quantized range instead of wrapping it", () => {
    const q = quant(-1, 1, 8);
    expect(through(q, 5)).toBe(1);
    expect(through(q, -5)).toBe(-1);
  });

  it("wraps angles, because the simulation never normalizes yaw", () => {
    const a = angle(16);
    const step = (2 * Math.PI) / 65536;
    // A player who keeps turning arrives here with an ever-growing number.
    for (const turns of [0, 1, 7, -3, 100]) {
      expect(Math.abs(through(a, 0.5 + turns * 2 * Math.PI) - 0.5)).toBeLessThanOrEqual(step);
    }
    // +π and -π are the same direction and must land on the same step.
    expect(through(a, Math.PI)).toBeCloseTo(through(a, -Math.PI), 10);
    // Everything decodes into [-π, π).
    for (let i = 0; i < 200; i++) {
      const decoded = through(a, (i / 200) * 40 - 20);
      expect(decoded).toBeGreaterThanOrEqual(-Math.PI);
      expect(decoded).toBeLessThan(Math.PI);
    }
  });

  it("exposes the rounding a lossy field applies, so a sender can simulate with it", () => {
    const q = quant(0, 1, 8);
    const value = 0.3333333333;
    expect(q.round!(value)).toBe(through(q, value));
    // Rounding is idempotent — the whole point: a rounded value survives the wire.
    expect(q.round!(q.round!(value))).toBe(q.round!(value));
    // An exact field has none.
    expect(uint(8).round).toBeUndefined();
  });

  it("carries nulls and nested structures", () => {
    const c = nullable(struct({ n: uint(4), inner: nullable(bool) }));
    expect(through(c, null)).toBeNull();
    expect(through(c, { n: 3, inner: null })).toEqual({ n: 3, inner: null });
    expect(through(c, { n: 3, inner: false })).toEqual({ n: 3, inner: false });
  });

  it("carries an empty array and a full one", () => {
    const c = array(uint(8), 4);
    expect(through(c, [])).toEqual([]);
    expect(through(c, [1, 2, 3])).toEqual([1, 2, 3]);
    const w = new BitWriter();
    expect(() => c.write(w, new Array<number>(16).fill(0))).toThrow(/exceeds/);
  });
});
