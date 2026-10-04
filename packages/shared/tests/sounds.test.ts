// `sounds` and `sound`: the alias table a world draws from, and where it plays.
//
// Three things a reader depends on. That a world file can say it; that a
// placement inside a turned group lands where the exporter meant; and that a
// placement with no `at` stays position-less, because a bed given the origin is
// a map-wide ambience track playing from one corner of the map.

import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";

function resolve(source: string) {
  const { ast, diagnostics } = parseWorldFile(source);
  expect(diagnostics).toHaveLength(0);
  return resolveWorld(ast.statements);
}

function resolveOk(source: string) {
  const result = resolve(source);
  if (hasErrors(result.diagnostics)) {
    throw new Error("unexpected errors: " + result.diagnostics.map((d) => d.message).join("; "));
  }
  return result.world!;
}

const codes = (source: string) => resolve(source).diagnostics.map((d) => d.code);

/** Every snippet below that places a sound needs a table for it to name. */
const TABLE = `sounds { source: "assets/sounds/sounds.json" }`;

describe("the sounds table", () => {
  it("is read off the world, like the fx library", () => {
    expect(resolveOk(TABLE).soundLibrary).toEqual({ source: "assets/sounds/sounds.json" });
  });

  it("is absent when the world declares none", () => {
    expect(resolveOk(`world { name: "w" }`).soundLibrary).toBeUndefined();
    expect(resolveOk(`world { name: "w" }`).sounds).toEqual([]);
  });

  it("needs a source", () => {
    expect(codes(`sounds { }`)).toContain("missing-property");
  });

  it("is one per world: an alias names clips, and a second table would shadow the first", () => {
    expect(codes(TABLE + "\n" + TABLE)).toContain("duplicate-sounds");
  });
});

describe("a sound placement", () => {
  it("carries its alias, position, volume, range and delay", () => {
    const world = resolveOk(`${TABLE}
      sound flap { alias: emt_wind_dome_flap_ext, at: 1 2 3, volume: 0.8, range: 4 18, delay: -2 }`);
    expect(world.sounds).toHaveLength(1);
    const s = world.sounds[0]!;
    expect(s.name).toBe("flap");
    expect(s.alias).toBe("emt_wind_dome_flap_ext");
    expect(s.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(s.volume).toBe(0.8);
    expect(s.range).toEqual([4, 18]);
    expect(s.delay).toBe(-2);
  });

  it("leaves the alias' own volume and reach alone when it says nothing", () => {
    const s = resolveOk(`${TABLE}\n sound { alias: a, at: 0 0 0 }`).sounds[0]!;
    expect(s.volume).toBe(1);
    expect(s.range).toBeUndefined();
    expect(s.delay).toBe(0);
  });

  it("needs an alias to play", () => {
    expect(codes(`${TABLE}\n sound s { at: 0 0 0 }`)).toContain("missing-property");
  });

  it("takes its range in lengths, so an author may write the unit", () => {
    const s = resolveOk(`${TABLE}\n sound { alias: a, at: 0 0 0, range: 4m 1800cm }`).sounds[0]!;
    expect(s.range).toEqual([4, 18]);
  });

  it("refuses a range whose maximum is inside its reference distance", () => {
    // Silent everywhere rather than broken: the panner would start no voice a
    // reader could hear, and nothing else would say so.
    expect(codes(`${TABLE}\n sound { alias: a, at: 0 0 0, range: 18 4 }`)).toContain("sound-bad-range");
  });

  it("refuses an alias that is not a plain name", () => {
    expect(codes(`${TABLE}\n sound { alias: a.b, at: 0 0 0 }`)).toContain("bad-alias-ref");
  });

  it("is placed through its group's origin and yaw", () => {
    const world = resolveOk(`${TABLE}
      group g {
        at: 10 0 0
        rotate: 0 90 0
        sound s { alias: a, at: 2 0 0 }
      }
    `);
    const s = world.sounds[0]!;
    // A quarter turn about +Y takes local +X to -Z, then the group's origin.
    expect(s.position!.x).toBeCloseTo(10);
    expect(s.position!.y).toBeCloseTo(0);
    expect(s.position!.z).toBeCloseTo(-2);
  });

  it("resolves in declaration order", () => {
    const world = resolveOk(`${TABLE}
      sound { alias: a, at: 0 0 0 }
      sound { alias: b, at: 1 0 0 }
      sound { alias: c, at: 2 0 0 }
    `);
    expect(world.sounds.map((s) => s.alias)).toEqual(["a", "b", "c"]);
  });

  it("does not disturb the ids of anything that existed before it", () => {
    // Entity ids cross the wire (net/messages/session.ts), so each new kind is
    // numbered after every older one. Renumbering an effect is a protocol break.
    const source = `
      trigger t { at: 0 0 0, size: 1 1 1 }
      mantle k { at: 0 0 0, size: 1 1 1 }
      effect e { fx: "x/a", at: 0 0 0 }
      ladder l { at: 0 0 0, size: 1 1 1 }
    `;
    const without = resolveOk(source);
    const with_ = resolveOk(TABLE + source + `\n sound s { alias: a, at: 0 0 0 }`);

    expect(with_.triggers.map((t) => t.id)).toEqual(without.triggers.map((t) => t.id));
    expect(with_.effects.map((e) => e.id)).toEqual(without.effects.map((e) => e.id));
    expect(with_.ladders.map((l) => l.id)).toEqual(without.ladders.map((l) => l.id));
    const highest = Math.max(...without.ladders.map((l) => l.id), ...without.effects.map((e) => e.id));
    expect(with_.sounds[0]!.id).toBeGreaterThan(highest);
  });

  it("rejects a property that belongs to another node", () => {
    expect(codes(`${TABLE}\n sound s { alias: a, at: 0 0 0, rotate: 0 90 0 }`)).toContain("property-not-allowed");
  });
});

describe("a sound with no position", () => {
  it("is the world's bed, and says so by having no position at all", () => {
    const s = resolveOk(`${TABLE}\n sound bed { alias: ambient_dome_ext, volume: 0.6 }`).sounds[0]!;
    expect(s.position).toBeUndefined();
    expect(s.alias).toBe("ambient_dome_ext");
    expect(s.volume).toBe(0.6);
  });

  it("stays position-less inside a group, rather than taking the group's origin", () => {
    // The walker works out an origin for every placement it visits. A bed must
    // drop it: a group's origin is a corner of the map, and a bed is all of it.
    const world = resolveOk(`${TABLE}
      group g { at: 10 0 -20, rotate: 0 45 0
        sound bed { alias: a }
      }
    `);
    expect(world.sounds[0]!.position).toBeUndefined();
  });
});

describe("a sound with no table to name", () => {
  it("is an error: the world says nothing about where its aliases come from", () => {
    expect(codes(`sound s { alias: a, at: 0 0 0 }`)).toContain("no-sound-library");
  });

  it("is reported once, not once per placement", () => {
    const reported = codes(`
      sound { alias: a, at: 0 0 0 }
      sound { alias: b, at: 1 0 0 }
      sound { alias: c, at: 2 0 0 }
    `).filter((c) => c === "no-sound-library");
    expect(reported).toHaveLength(1);
  });
});
