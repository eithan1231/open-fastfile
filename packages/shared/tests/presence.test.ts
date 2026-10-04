// Which solids a match has (worlds/presence.ts), and the hash that makes a
// solid's bit on the wire mean the same solid at both ends (worlds/hash.ts).

import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { indexWorld } from "../src/worlds/worldIndex.js";
import { Presence, basePresence, presenceFor, solidsNamed } from "../src/worlds/presence.js";
import { worldHash } from "../src/worlds/hash.js";

function world(source: string) {
  const { ast } = parseWorldFile(source);
  return resolveWorld(ast.statements).world!;
}

const DOORS = `
  collision { source: "assets/collision.glb" }
  solid front { part: "*1", tag: "door" "backstage_door" }
  solid { part: "*2", tag: "door" }
  solid barrier { part: "*3", mode: "gun" "oic" }
  solid { part: "*4", mode: "tdm" }
`;

describe("a presence", () => {
  it("is one bit per solid, in the wire's own layout", () => {
    const presence = new Presence(10, undefined, false);
    expect(presence.bytes.length).toBe(2);
    expect(presence.set(9, true)).toBe(true);
    expect(presence.set(9, true)).toBe(false);
    expect([...presence.bytes]).toEqual([0, 2]);
    expect(presence.has(9)).toBe(true);
    expect(presence.has(10)).toBe(false);
    expect(() => presence.set(10, true)).toThrow(/no solid 10/);
  });

  it("moves its version on a change and on nothing else", () => {
    const presence = new Presence(3);
    presence.set(0, true);
    expect(presence.version).toBe(0);
    presence.set(0, false);
    expect(presence.version).toBe(1);
  });

  it("adopts a bitset and says which solids changed", () => {
    const presence = new Presence(10);
    expect(presence.assign([0xff, 0x03])).toEqual([]);
    expect(presence.assign([0xfe, 0x01])).toEqual([0, 9]);
    expect(presence.has(0)).toBe(false);
    expect(presence.version).toBe(1);
    expect(() => presence.assign([0xff])).toThrow(/1 byte/);
  });

  it("starts a match with every solid its mode admits", () => {
    const doors = world(DOORS);
    const tdm = presenceFor(doors, "tdm");
    expect([0, 1, 2, 3].map((i) => tdm.has(i))).toEqual([true, true, false, true]);
    const gun = presenceFor(doors, "gun");
    expect([0, 1, 2, 3].map((i) => gun.has(i))).toEqual([true, true, true, false]);
    // Free Roam: the untagged ones only.
    const none = presenceFor(doors, undefined);
    expect([0, 1, 2, 3].map((i) => none.has(i))).toEqual([true, true, false, false]);
    expect(tdm.version).toBe(0);
    expect([0, 1, 2, 3].some((i) => basePresence(doors).has(i))).toBe(false);
  });

  it("reads a model's mode against the match's", () => {
    expect(new Presence(0, "sd").hasModes(["sd", "dd"])).toBe(true);
    expect(new Presence(0, "tdm").hasModes(["sd"])).toBe(false);
    expect(new Presence(0).hasModes(undefined)).toBe(true);
  });
});

describe("solidsNamed", () => {
  it("finds solids by name and by tag, ascending and once each", () => {
    const index = indexWorld(world(DOORS));
    expect(solidsNamed(index, "door")).toEqual([0, 1]);
    expect(solidsNamed(index, "front")).toEqual([0]);
    expect(solidsNamed(index, "backstage_door")).toEqual([0]);
    expect(solidsNamed(index, "barrier")).toEqual([2]);
    expect(solidsNamed(index, "nothing")).toEqual([]);
  });
});

describe("worldHash", () => {
  it("is the same for the same text, and ignores what moves nothing an id names", () => {
    const a = worldHash(world(DOORS));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(worldHash(world(DOORS))).toBe(a);
    expect(worldHash(world(`${DOORS}\n// a comment`))).toBe(a);
  });

  it("changes when an id would mean something else", () => {
    const a = worldHash(world(DOORS));
    // Two solids swapped: the same parts, and every bit after the first means another one.
    const swapped = DOORS.replace(
      `solid { part: "*2", tag: "door" }\n  solid barrier { part: "*3", mode: "gun" "oic" }`,
      `solid barrier { part: "*3", mode: "gun" "oic" }\n  solid { part: "*2", tag: "door" }`,
    );
    expect(swapped).not.toBe(DOORS);
    expect(worldHash(world(swapped))).not.toBe(a);
    expect(worldHash(world(`${DOORS}\npoint { at: 0 0 0 }`))).not.toBe(a);
  });
});
