// The nav.bin reader against the conformance fixture (docs/engine/nav-format.md).
//
// conformance.nav.bin is conformance.json put through the Python encoder
// (scripts/cod/nav/conformance.py), which has its own test requiring it to
// reproduce these bytes exactly. So this file is the other half of one contract:
// what the exporter writes is what the game server reads, field for field.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { crc32, decodeNav, NavFormatError, NO_INDEX_16, NO_INDEX_32, yawRadians, type NavFile, type NavFormatReason } from "../src/nav/format.js";
import * as vocab from "../src/nav/vocab.js";

const DIR = path.join(import.meta.dirname, "fixtures", "nav");

interface FixtureNode {
  position: [number, number, number];
  type: keyof typeof vocab.NODE_TYPES;
  yaw: number | null;
  floorZ: boolean;
  group: number | null;
  abilities: (keyof typeof vocab.ABILITIES)[];
  stance: (keyof typeof vocab.STANCES)[];
  source: number | null;
  name: string;
}
interface FixtureLink {
  from: number;
  to: number;
  kind: keyof typeof vocab.LINK_KINDS;
  gameCost: number | null;
  flags: (keyof typeof vocab.LINK_FLAGS)[];
  traversal: number | null;
}
interface Fixture {
  flags: (keyof typeof vocab.HEADER_FLAGS)[];
  nodes: FixtureNode[];
  links: FixtureLink[];
  traversals: { begin: number; end: number; kind: keyof typeof vocab.TRAVERSAL_KINDS; animscript: string }[];
  meta: Record<string, unknown>;
  skipped: Record<string, number>;
  extra: { tag: string; version: number; required: boolean; hex: string }[];
  expected: { strings: string[]; sections: { tag: string; version: number; required: boolean }[] };
  vocab: Record<string, Record<string, number>>;
}

const fixture = JSON.parse(fs.readFileSync(path.join(DIR, "conformance.json"), "utf8")) as Fixture;
const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, "conformance.nav.bin")));

function mask<T extends Record<string, number>>(table: T, names: (keyof T)[]): number {
  return names.reduce((m, n) => m | table[n]!, 0);
}

/** The stored yaw the encoder writes for `radians`: rounded half up, wrapped to u16. */
function yaw16(radians: number): number {
  return (((Math.floor((radians / (2 * Math.PI)) * 65536 + 0.5) % 65536) + 65536) % 65536) >>> 0;
}

describe("the conformance fixture", () => {
  const nav = decodeNav(bytes);

  it("has the header the JSON describes", () => {
    expect(nav.major).toBe(1);
    expect(nav.minor).toBe(0);
    expect(nav.flags).toBe(mask(vocab.HEADER_FLAGS, fixture.flags));
  });

  it("lists every section in order, the unknown one included and skipped", () => {
    expect(nav.sections.map((s) => ({ tag: s.tag, version: s.version, required: (s.flags & vocab.SECTION_FLAGS.REQUIRED) !== 0 }))).toEqual(
      fixture.expected.sections,
    );
    expect(nav.sections.filter((s) => !s.read).map((s) => s.tag)).toEqual(["ZZZZ"]);
    const zzzz = nav.sections.find((s) => s.tag === "ZZZZ")!;
    const hex = Array.from(bytes.subarray(zzzz.offset, zzzz.offset + zzzz.length), (v) => v.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(fixture.extra[0]!.hex);
    for (const s of nav.sections) {
      expect(s.offset % 8, s.tag).toBe(0);
    }
  });

  it("reads every node field", () => {
    const n = nav.nodes;
    expect(n.count).toBe(fixture.nodes.length);
    fixture.nodes.forEach((f, i) => {
      const at = `node ${i}`;
      expect([n.position[i * 3], n.position[i * 3 + 1], n.position[i * 3 + 2]], at).toEqual(f.position.map(Math.fround));
      expect(n.type[i], at).toBe(vocab.NODE_TYPES[f.type]);
      const flags =
        (f.yaw !== null ? vocab.NODE_FLAGS.HAS_YAW : 0) | (f.floorZ ? vocab.NODE_FLAGS.FLOOR_Z : 0) | (f.group !== null ? vocab.NODE_FLAGS.DYNAMIC : 0);
      expect(n.flags[i], at).toBe(flags);
      expect(n.yaw[i], at).toBe(f.yaw === null ? 0 : yaw16(f.yaw));
      expect(n.abilities[i], at).toBe(mask(vocab.ABILITIES, f.abilities));
      expect(n.stance[i], at).toBe(mask(vocab.STANCES, f.stance));
      expect(n.source[i], at).toBe(f.source ?? NO_INDEX_32);
      expect(n.group[i], at).toBe(f.group ?? NO_INDEX_16);
      expect(nav.strings[n.name[i]!], at).toBe(f.name);
    });
  });

  it("groups the links by node, keeping their order within a node", () => {
    const l = nav.links;
    expect(l.count).toBe(fixture.links.length);
    expect(l.first).toHaveLength(nav.nodes.count + 1);
    const got: FixtureLink[] = [];
    for (let node = 0; node < nav.nodes.count; node++) {
      for (let i = l.first[node]!; i < l.first[node + 1]!; i++) {
        const cost = l.gameCost[i]!;
        got.push({
          from: node,
          to: l.target[i]!,
          kind: (Object.keys(vocab.LINK_KINDS) as (keyof typeof vocab.LINK_KINDS)[]).find((k) => vocab.LINK_KINDS[k] === l.kind[i])!,
          gameCost: Number.isNaN(cost) ? null : cost,
          flags: (Object.keys(vocab.LINK_FLAGS) as (keyof typeof vocab.LINK_FLAGS)[]).filter((k) => l.flags[i]! & vocab.LINK_FLAGS[k]),
          traversal: l.traversal[i] === NO_INDEX_16 ? null : l.traversal[i]!,
        });
      }
    }
    const want = [...fixture.links].sort((a, b) => a.from - b.from).map((f) => ({ ...f, gameCost: f.gameCost === null ? null : Math.fround(f.gameCost) }));
    expect(got).toEqual(want);
  });

  it("reads the traversals, and the links name them", () => {
    const t = nav.traversals;
    expect(t.count).toBe(fixture.traversals.length);
    fixture.traversals.forEach((f, i) => {
      expect([t.begin[i], t.end[i], t.kind[i], nav.strings[t.animscript[i]!]]).toEqual([f.begin, f.end, vocab.TRAVERSAL_KINDS[f.kind], f.animscript]);
    });
  });

  it("interns strings, non-ASCII ones included, in first-use order", () => {
    expect(nav.strings).toEqual(fixture.expected.strings);
  });

  it("reads META as the JSON object it was, with the skipped counts inside", () => {
    expect(nav.meta).toEqual({ ...fixture.meta, skipped: fixture.skipped });
  });

  it("stores yaw as a fraction of a turn", () => {
    expect(yawRadians(16384)).toBeCloseTo(Math.PI / 2, 12);
    expect(nav.nodes.yaw[1]).toBe(16384);
  });

  it("reads a file that does not start at its buffer's first byte", () => {
    // A fetched body can arrive as a view into a larger buffer, at any offset.
    const host = new Uint8Array(bytes.length + 3);
    host.set(bytes, 3);
    const shifted = decodeNav(host.subarray(3));
    expect(shifted.nodes.position).toEqual(nav.nodes.position);
    expect(shifted.links.gameCost).toEqual(nav.links.gameCost);
  });

  it("holds the same vocabulary as the fixture, and so as the encoder", () => {
    expect(fixture.vocab).toEqual({
      nodeTypes: vocab.NODE_TYPES,
      nodeFlags: vocab.NODE_FLAGS,
      stances: vocab.STANCES,
      abilities: vocab.ABILITIES,
      linkKinds: vocab.LINK_KINDS,
      linkFlags: vocab.LINK_FLAGS,
      traversalKinds: vocab.TRAVERSAL_KINDS,
      headerFlags: vocab.HEADER_FLAGS,
      sectionFlags: vocab.SECTION_FLAGS,
    });
  });
});

// -- Refusals, each on a mutated copy of the fixture ------------------------------

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
const setU16 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint16(at, v, true);
const setU32 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(at, v, true);

/** A copy with `edit` applied and the checksum made right again, so only the edit is tested. */
function mutated(edit: (b: Uint8Array) => void): Uint8Array {
  const b = bytes.slice();
  edit(b);
  setU32(b, 24, crc32(b.subarray(32)));
  return b;
}

/** Where section `tag`'s table entry is. */
function entry(tag: string): number {
  const nav = decodeNav(bytes);
  return 32 + nav.sections.findIndex((s) => s.tag === tag) * 16;
}

function refusal(b: Uint8Array): NavFormatReason {
  try {
    decodeNav(b);
  } catch (e) {
    expect(e).toBeInstanceOf(NavFormatError);
    return (e as NavFormatError).reason;
  }
  throw new Error("decoded without complaint");
}

describe("refusals", () => {
  it("the fixture's own CRC is right", () => {
    expect(u32(bytes, 24)).toBe(crc32(bytes.subarray(32)));
    expect(u32(bytes, 24)).not.toBe(0);
  });

  it("an unknown section marked REQUIRED", () => {
    const zzzz = entry("ZZZZ");
    expect(refusal(mutated((b) => setU16(b, zzzz + 6, vocab.SECTION_FLAGS.REQUIRED)))).toBe("required");
  });

  it("a known section at a version this reader does not know, marked REQUIRED", () => {
    expect(refusal(mutated((b) => setU16(b, entry("TRAV") + 4, 2)))).toBe("required");
  });

  it("but not the same optional section, which is skipped", () => {
    const nav = decodeNav(mutated((b) => setU16(b, entry("META") + 4, 2)));
    expect(nav.meta).toBeNull();
    expect(nav.sections.find((s) => s.tag === "META")!.read).toBe(false);
  });

  it("a major version other than 1", () => {
    expect(refusal(mutated((b) => setU16(b, 4, 2)))).toBe("version");
  });

  it("accepts a later minor version", () => {
    expect(decodeNav(mutated((b) => setU16(b, 6, 9))).minor).toBe(9);
  });

  it("an unknown must-understand header bit", () => {
    expect(refusal(mutated((b) => setU32(b, 8, u32(b, 8) | (1 << 17))))).toBe("flags");
  });

  it("but not an unknown advisory one", () => {
    expect(decodeNav(mutated((b) => setU32(b, 8, u32(b, 8) | (1 << 5)))).flags & (1 << 5)).toBeTruthy();
  });

  it("a truncated file", () => {
    expect(refusal(bytes.subarray(0, bytes.length - 8))).toBe("truncated");
    expect(refusal(bytes.subarray(0, 20))).toBe("truncated");
  });

  it("bytes beyond the stated length", () => {
    const longer = new Uint8Array(bytes.length + 8);
    longer.set(bytes);
    expect(refusal(longer)).toBe("length");
  });

  it("a CRC mismatch", () => {
    const b = bytes.slice();
    b[b.length - 20] = b[b.length - 20]! ^ 0x40;
    expect(refusal(b)).toBe("checksum");
  });

  it("a CRC of 0 is not checked", () => {
    const b = bytes.slice();
    setU32(b, 24, 0);
    expect(decodeNav(b).nodes.count).toBe(fixture.nodes.length);
  });

  it("a section out of bounds", () => {
    const node = entry("NODE");
    expect(refusal(mutated((b) => setU32(b, node + 12, bytes.length)))).toBe("bounds");
  });

  it("a misaligned section, and two that overlap", () => {
    expect(refusal(mutated((b) => setU32(b, entry("LINK") + 8, u32(b, entry("LINK") + 8) + 4)))).toBe("bounds");
    expect(refusal(mutated((b) => setU32(b, entry("TRAV") + 8, u32(b, entry("LINK") + 8))))).toBe("bounds");
  });

  it("bad magic", () => {
    expect(refusal(mutated((b) => (b[0] = 0x34)))).toBe("magic");
  });

  it("a link to a node that does not exist", () => {
    const nav: NavFile = decodeNav(bytes);
    const link = nav.sections.find((s) => s.tag === "LINK")!;
    const records = link.offset + 16 + (nav.nodes.count + 1) * 4;
    const aligned = records + ((8 - (records % 8)) % 8);
    expect(refusal(mutated((b) => setU32(b, aligned, nav.nodes.count)))).toBe("malformed");
  });

  it("a record stride below version 1's", () => {
    const node = decodeNav(bytes).sections.find((s) => s.tag === "NODE")!;
    expect(refusal(mutated((b) => setU32(b, node.offset + 4, 28)))).toBe("malformed");
  });

  it("a string index with no string table", () => {
    // Renaming STRS to an unknown optional tag leaves the names pointing nowhere.
    const strs = entry("STRS");
    expect(
      refusal(
        mutated((b) => {
          b.set([0x51, 0x51, 0x51, 0x51], strs);
          setU16(b, strs + 6, 0);
        }),
      ),
    ).toBe("missing");
  });

  it("no NODE section", () => {
    expect(
      refusal(
        mutated((b) => {
          b.set([0x4e, 0x4f, 0x50, 0x45], entry("NODE"));
          setU16(b, entry("NODE") + 6, 0);
        }),
      ),
    ).toBe("missing");
  });
});
