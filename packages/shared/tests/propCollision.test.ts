// Deriving a world's prop collision without a scene (src/collision/props.ts).
//
// This exists because a client and a game server used to disagree about which
// props are solid: the client collects colliders out of the scene graph it
// already built to draw them, and a server, which draws nothing, collided
// against the map's clipmap alone. So the assertions are about matching what
// scene/models.ts does, placement for placement — which mode gets the asset's
// own mesh, which gets a box, and which is skipped entirely — because a prop
// that is solid on one end and air on the other shows up as drift and reads as
// a netcode problem.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ResolvedAsset, ResolvedObject, ResolvedWorld } from "../src/dsl/resolved.js";
import { assetFileKey, buildPropCollision } from "../src/collision/props.js";
import { MIN_PROXY } from "../src/collision/hulls.js";

/** A 2x2x2 box centred a metre up, so a box proxy and the mesh itself are told apart by their bounds. */
function crateScene(): THREE.Object3D {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  mesh.position.set(0, 1, 0);
  return mesh;
}

/** A flat sheet, so the box proxy has a degenerate axis to widen to MIN_PROXY. */
function sheetScene(): THREE.Object3D {
  return new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
}

function asset(name: string, source: string, hull?: number): ResolvedAsset {
  return { name, source, hull };
}

function placement(overrides: Partial<ResolvedObject>): ResolvedObject {
  return {
    id: 0,
    tags: [],
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    size: { x: 1, y: 1, z: 1 },
    collide: "hull",
    visible: true,
    ...overrides,
  };
}

function world(assets: ResolvedAsset[], objects: ResolvedObject[]): ResolvedWorld {
  return {
    assets: Object.fromEntries(assets.map((a) => [a.name, a])),
    topLevelObjects: objects,
  } as unknown as ResolvedWorld;
}

/**
 * Loads whatever the map says, and records what was asked for.
 *
 * Handed the **asset**, not a path: `source` is relative to the world folder or to
 * a catalogue entry depending on `catalog`, so only something holding the asset can
 * resolve it. `asked` records `assetFileKey`, which is the identity two assets
 * share if and only if they name the same file.
 */
function loader(files: Record<string, () => THREE.Object3D>) {
  const asked: string[] = [];
  return {
    asked,
    load: async (asset: ResolvedAsset) => {
      const key = assetFileKey(asset);
      asked.push(key);
      return files[key]?.();
    },
  };
}

describe("prop collision", () => {
  it("gives a `collide: hull` placement the asset's own mesh", async () => {
    const { load } = loader({ "crate.glb": crateScene });
    const built = await buildPropCollision(world([asset("crate", "crate.glb", 0)], [placement({ asset: "crate" })]), load);

    expect(built.missing).toBe(0);
    expect(built.placements).toHaveLength(1);
    expect([...built.geometries.keys()]).toEqual(["crate"]);
    // The mesh's own bounds, not a box around them: the crate sits a metre up.
    const box = new THREE.Box3().setFromBufferAttribute(built.geometries.get("crate")!.getAttribute("position") as THREE.BufferAttribute);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(box.max.y).toBeCloseTo(2, 5);
  });

  it("reads each asset once however many times it is placed", async () => {
    const { asked, load } = loader({ "crate.glb": crateScene });
    const crate = asset("crate", "crate.glb", 0);
    const built = await buildPropCollision(
      world([crate], [placement({ asset: "crate" }), placement({ asset: "crate", position: { x: 5, y: 0, z: 0 } })]),
      load,
    );

    expect(asked).toEqual(["crate.glb"]);
    expect(built.geometries.size).toBe(1);
    expect(built.placements).toHaveLength(2);
  });

  it("bakes a placement's position, rotation and scale into its matrix", async () => {
    const { load } = loader({ "crate.glb": crateScene });
    const built = await buildPropCollision(
      world(
        [asset("crate", "crate.glb", 0)],
        [placement({ asset: "crate", position: { x: 3, y: 1, z: -2 }, rotation: { x: 0, y: Math.PI / 2, z: 0 }, scale: { x: 2, y: 2, z: 2 } })],
      ),
      load,
    );

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    built.placements[0]!.matrix.decompose(position, quaternion, scale);
    expect(position.toArray()).toEqual([3, 1, -2]);
    expect(scale.x).toBeCloseTo(2, 6);
    // Yaw only, so +X maps to -Z, which is what a wrong euler order would break.
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).z).toBeCloseTo(-1, 6);
  });

  it("stands a box in for a hull the asset has none of, keyed apart from its mesh", async () => {
    const { load } = loader({ "crate.glb": crateScene });
    // `hull` undefined: scene/models.ts falls back to the box proxy, so this must too.
    const built = await buildPropCollision(world([asset("crate", "crate.glb")], [placement({ asset: "crate" })]), load);

    expect([...built.geometries.keys()]).toEqual(["crate#box"]);
    expect(built.placements[0]!.asset).toBe("crate#box");
  });

  it("never lets a box proxy be degenerate, so a flat prop makes no zero-area triangles", async () => {
    const { load } = loader({ "sheet.glb": sheetScene });
    const built = await buildPropCollision(world([asset("sheet", "sheet.glb")], [placement({ asset: "sheet", collide: "box" })]), load);

    const box = new THREE.Box3().setFromBufferAttribute(built.geometries.get("sheet#box")!.getAttribute("position") as THREE.BufferAttribute);
    expect(box.max.z - box.min.z).toBeCloseTo(MIN_PROXY, 6);
  });

  it("collides one asset as both a mesh and a box when two placements ask differently", async () => {
    const { load } = loader({ "crate.glb": crateScene });
    const crate = asset("crate", "crate.glb", 0);
    const built = await buildPropCollision(
      world([crate], [placement({ asset: "crate", collide: "hull" }), placement({ asset: "crate", collide: "box" })]),
      load,
    );

    expect([...built.geometries.keys()].sort()).toEqual(["crate", "crate#box"]);
  });

  it("skips what the client's BVH skips: `collide: false` and an invisible placement", async () => {
    const { asked, load } = loader({ "crate.glb": crateScene });
    const crate = asset("crate", "crate.glb", 0);
    const built = await buildPropCollision(
      world([crate], [placement({ asset: "crate", collide: "none" }), placement({ asset: "crate", visible: false })]),
      load,
    );

    expect(asked).toEqual([]);
    expect(built.placements).toEqual([]);
  });

  it("counts a prop it could not read rather than refusing to host the map", async () => {
    const { load } = loader({ "crate.glb": crateScene });
    const built = await buildPropCollision(
      world([asset("crate", "crate.glb", 0), asset("gone", "gone.glb", 0)], [placement({ asset: "crate" }), placement({ asset: "gone" })]),
      load,
    );

    expect(built.missing).toBe(1);
    // And the placement goes with it, so `placements.length` is what really collides.
    expect(built.placements).toHaveLength(1);
    expect(built.placements[0]!.asset).toBe("crate");
  });

  // A prop belongs to the catalogue now (`asset { catalog: ..., source: ... }`), and
  // `source` is then relative to the catalogue entry rather than to the world. This
  // module used to be handed the bare `source` string and treated it as
  // world-relative always, so **every prop on every imported map resolved to a file
  // that is not there**: dome-mw3 has 133 such assets under 1,223 colliding
  // placements, and a game server collided with none of them while every client
  // collided with all of them. Under an authoritative server that reads as jitter —
  // stand on a rock, be told you are falling, predict back onto it, repeat.
  describe("an asset that lives in the catalogue", () => {
    const shared = (name: string, source: string, id: string): ResolvedAsset => ({
      name,
      source,
      hull: 0,
      catalog: { kind: "props", game: "iw5", id },
    });

    it("is read from its catalogue entry and not from the world folder", async () => {
      const crate = shared("rock", "rock_lod0.glb", "rock_lod0");
      const { asked, load } = loader({ "props/iw5/rock_lod0/rock_lod0.glb": crateScene });
      const built = await buildPropCollision(world([crate], [placement({ asset: "rock" })]), load);

      expect(asked).toEqual(["props/iw5/rock_lod0/rock_lod0.glb"]);
      expect(built.missing).toBe(0);
      expect(built.placements).toHaveLength(1);
      expect([...built.geometries.keys()]).toEqual(["rock"]);
    });

    it("keeps two entries apart when they ship a file of the same name", async () => {
      // `source` is a bare filename inside its entry, so two catalogue entries can
      // both hold `model.glb`. Deduplicating the reads on that alone hands one of
      // them the other's geometry: a prop with somebody else's collision, and
      // nothing at all to suggest why.
      const rock = shared("rock", "model.glb", "rock_lod0");
      const barrel = shared("barrel", "model.glb", "barrel_lod0");
      const { asked, load } = loader({
        "props/iw5/rock_lod0/model.glb": crateScene,
        "props/iw5/barrel_lod0/model.glb": sheetScene,
      });
      const built = await buildPropCollision(world([rock, barrel], [placement({ asset: "rock" }), placement({ asset: "barrel" })]), load);

      expect(asked).toHaveLength(2);
      expect(new Set(asked)).toEqual(new Set(["props/iw5/rock_lod0/model.glb", "props/iw5/barrel_lod0/model.glb"]));
      expect(built.geometries.size).toBe(2);
    });

    it("still reads a world's own asset from the world folder", async () => {
      // The other half: `catalog` absent means `source` is world-relative, exactly
      // as it always was.
      const { asked, load } = loader({ "crate.glb": crateScene });
      const built = await buildPropCollision(world([asset("crate", "crate.glb", 0)], [placement({ asset: "crate" })]), load);
      expect(asked).toEqual(["crate.glb"]);
      expect(built.missing).toBe(0);
    });
  });
});
