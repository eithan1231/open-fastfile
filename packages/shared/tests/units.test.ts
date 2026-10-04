import { describe, expect, it } from "vitest";
import { toMeters, toRadians } from "../src/dsl/units.js";

describe("units", () => {
  it("converts lengths to meters", () => {
    expect(toMeters(100, "cm")).toBeCloseTo(1, 9);
    expect(toMeters(1000, "mm")).toBeCloseTo(1, 9);
    expect(toMeters(1, "ft")).toBeCloseTo(0.3048, 9);
    expect(toMeters(1, "in")).toBeCloseTo(0.0254, 9);
    expect(toMeters(2, undefined)).toBe(2);
    expect(toMeters(2, "m")).toBe(2);
  });

  it("converts angles to radians", () => {
    expect(toRadians(180, "deg")).toBeCloseTo(Math.PI, 9);
    expect(toRadians(180, undefined)).toBeCloseTo(Math.PI, 9); // default unit is deg
    expect(toRadians(Math.PI, "rad")).toBeCloseTo(Math.PI, 9);
  });
});
