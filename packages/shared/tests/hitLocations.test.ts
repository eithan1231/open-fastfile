// Where on a body a bullet landed (sim/hitLocations.ts).
//
// The table names about thirty joints and lets every other one fold into its
// nearest boxed ancestor, which is only sound if every joint actually *has* such an
// ancestor. That is not something to reason about: the 52 exported bodies carry 265
// distinct joints between them, mostly facial detail and cloth, and one of them
// falling outside the table would mean a part of a body no bullet can hit — or,
// worse, one silently counted as `none` and doing no damage.
//
// So the last test here reads the real skeletons and checks all of them.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HIT_BONES, HIT_LOCATIONS, hitLocationOf, isHitBone, type HitLocation } from "../src/sim/hitLocations.js";

/** A parent lookup over a literal tree, for the unit tests below. */
const parents = (tree: Record<string, string>) => (bone: string) => tree[bone];

describe("the location table", () => {
  it("is the source games' nineteen, in their order", () => {
    // The order is a format: a hit names a location by index and a weapon's
    // multipliers arrive in this order, so a reordering is a silent rearming.
    expect(HIT_LOCATIONS).toHaveLength(19);
    expect(HIT_LOCATIONS[0]).toBe("none");
    expect(HIT_LOCATIONS[2]).toBe("head");
    expect(HIT_LOCATIONS[HIT_LOCATIONS.length - 1]).toBe("gun");
  });

  it("names only locations it declares", () => {
    const known = new Set<string>(HIT_LOCATIONS);
    for (const [bone, location] of Object.entries(HIT_BONES)) {
      expect(known.has(location), `${bone} -> ${location}`).toBe(true);
    }
  });

  it("keeps the character's own left and right, not the viewer's", () => {
    // `_ri` is the character's right arm, which is on the viewer's left. Getting
    // this backwards is invisible until someone notices that shooting a player's
    // right arm reports the left.
    expect(HIT_BONES["j_shoulder_ri"]).toBe("rightArmUpper");
    expect(HIT_BONES["j_shoulder_le"]).toBe("leftArmUpper");
    expect(HIT_BONES["j_ankle_ri"]).toBe("rightFoot");
    expect(HIT_BONES["j_ankle_le"]).toBe("leftFoot");
  });

  it("separates a helmet from the head under it", () => {
    // CoD gives `helmet` its own multiplier, which is why a head shot is not
    // always a kill.
    expect(HIT_BONES["j_head"]).toBe("head");
    expect(HIT_BONES["j_helmet"]).toBe("helmet");
    expect(HIT_BONES["j_nvg"]).toBe("helmet");
  });

  it("puts a twist joint with the limb it lies along, not the one past it", () => {
    // `j_wristtwist_ri` is forearm. Classified as a hand, every vertex between the
    // elbow and the wrist would fold forwards into the hand's box.
    expect(HIT_BONES["j_wristtwist_ri"]).toBe("rightArmLower");
    expect(HIT_BONES["j_wrist_ri"]).toBe("rightHand");
    expect(HIT_BONES["j_shouldertwist_le"]).toBe("leftArmUpper");
  });
});

describe("folding a joint into its nearest boxed ancestor", () => {
  it("answers for a joint that carries a box itself", () => {
    expect(hitLocationOf("j_head", parents({}))).toBe("head");
    expect(isHitBone("j_head")).toBe(true);
  });

  it("walks up to the first one that does", () => {
    // A vertex weighted to a lip joint is part of the head, and has to contribute
    // to the head's volume rather than to nothing.
    const tree = { j_lip_top_le_2: "j_lip_top_le", j_lip_top_le: "j_jaw", j_jaw: "j_head", j_head: "j_neck" };
    expect(hitLocationOf("j_lip_top_le_2", parents(tree))).toBe("head");
    expect(isHitBone("j_lip_top_le_2")).toBe(false);
  });

  it("stops at the nearest, not the highest", () => {
    // Every chain ends at `j_mainroot`, which is torsoLower. A walk that did not
    // stop early would report every hit as a gut shot.
    const tree = { j_index_ri_3: "j_index_ri_2", j_index_ri_2: "j_index_ri_1", j_index_ri_1: "j_wrist_ri", j_wrist_ri: "j_elbow_ri", j_elbow_ri: "j_mainroot" };
    expect(hitLocationOf("j_index_ri_3", parents(tree))).toBe("rightHand");
  });

  it("is `none` for a joint with no boxed ancestor, and does not hang on a cycle", () => {
    expect(hitLocationOf("tag_origin", parents({}))).toBe("none");
    // A malformed skeleton must not spin: the parent walk is bounded by what it has
    // already seen rather than by a depth it hopes is enough.
    expect(hitLocationOf("a", parents({ a: "b", b: "a" }))).toBe("none");
  });
});

// -- Against the real bodies ---------------------------------------------------

const CHARACTERS = path.resolve(import.meta.dirname, "../../../worlds/catalog/characters");

/** Every exported body's GLB. Empty when the catalogue has not been built. */
function bodies(): string[] {
  if (!fs.existsSync(CHARACTERS)) {
    return [];
  }
  const out: string[] = [];
  for (const game of fs.readdirSync(CHARACTERS)) {
    const dir = path.join(CHARACTERS, game);
    if (!fs.statSync(dir).isDirectory()) {
      continue;
    }
    for (const id of fs.readdirSync(dir)) {
      for (const file of fs.readdirSync(path.join(dir, id))) {
        if (file.endsWith(".glb")) {
          out.push(path.join(dir, id, file));
        }
      }
    }
  }
  return out;
}

/** A GLB's JSON chunk. Only the node tree is needed, so the binary is left alone. */
function gltfJson(file: string): { nodes: { name?: string; children?: number[] }[]; skins?: { joints: number[] }[] } {
  const bytes = fs.readFileSync(file);
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
}

describe("every joint on every exported body", () => {
  it("resolves to a location, or is a tag that skins nothing", () => {
    const files = bodies();
    if (files.length === 0) {
      return; // the catalogue is gitignored; `python3 -m scripts.cod catalog` builds it
    }

    const unresolved = new Map<string, number>();
    let joints = 0;
    for (const file of files) {
      const gltf = gltfJson(file);
      const parentOf = new Map<number, number>();
      gltf.nodes.forEach((node, index) => {
        for (const child of node.children ?? []) {
          parentOf.set(child, index);
        }
      });
      const byName = new Map<string, number>();
      gltf.nodes.forEach((node, index) => {
        if (node.name !== undefined) {
          byName.set(node.name, index);
        }
      });
      const parent = (bone: string): string | undefined => {
        const index = byName.get(bone);
        const up = index === undefined ? undefined : parentOf.get(index);
        return up === undefined ? undefined : gltf.nodes[up]?.name;
      };

      for (const index of gltf.skins?.[0]?.joints ?? []) {
        const name = gltf.nodes[index]?.name;
        if (name === undefined) {
          continue;
        }
        joints++;
        // `tag_*` joints are mount points — a sight, a stowed weapon — and skin
        // nothing, so having no box above them is correct.
        if (name.startsWith("tag_")) {
          continue;
        }
        if (hitLocationOf(name, parent) === "none") {
          unresolved.set(name, (unresolved.get(name) ?? 0) + 1);
        }
      }
    }

    expect(joints).toBeGreaterThan(1000);
    // Named rather than counted, so a failure says which joint to classify.
    expect([...unresolved.keys()].sort()).toEqual([]);
  });

  it("classifies every location the table can reach", () => {
    // Every location except `none` should be reachable, or the table has a row
    // nothing can ever land on.
    const reachable = new Set<HitLocation>(Object.values(HIT_BONES));
    for (const location of HIT_LOCATIONS) {
      if (location === "none") {
        continue;
      }
      expect(reachable.has(location), `nothing maps to ${location}`).toBe(true);
    }
  });
});
