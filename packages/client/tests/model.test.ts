import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { parseWorldFile } from "@3d/shared/dsl/parser.js";
import { validateStatements } from "@3d/shared/dsl/schema.js";
import { resolveWorld } from "@3d/shared/dsl/resolve.js";
import type { ResolvedObject } from "@3d/shared/dsl/resolved.js";
import { buildModelMesh, buildBoxCollider } from "../src/scene/models.js";
import { disposeScene, type BuiltScene } from "../src/scene/scene.js";
import { isBlended } from "../src/scene/importedMaterials.js";
import { AssetStore } from "../src/scene/assets.js";

function resolve(src: string) {
  const { ast } = parseWorldFile(src, "world.world");
  return resolveWorld(ast.statements);
}

describe("model node", () => {
  it("resolves an asset reference and keeps the declared size", () => {
    const { world, diagnostics } = resolve(`
      world { name: "W" }
      asset chair { source: "assets/chair.glb" }
      group hall {
        model seat { asset: chair, size: 0.5 0.9 0.5, at: 1 0 2, rotate: 45 }
      }
    `);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    const obj = world!.topLevelObjects[0]!;
    expect(obj.asset).toBe("chair");
    expect(world!.assets["chair"]!.source).toBe("assets/chair.glb");
    // `size` is the declared footprint anchors use; it never rescales the asset
    expect(obj.size).toMatchObject({ x: 0.5, y: 0.9, z: 0.5 });
    expect(obj.rotation.y).toBeCloseTo(Math.PI / 4);
  });

  it("errors when asset is missing, since there is nothing to draw", () => {
    const { diagnostics } = resolve(`
      world { name: "W" }
      group hall {
        model { size: 1 1 1 }
      }
    `);
    expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("asset"))).toBe(true);
  });

  it("errors on a reference to an asset nobody declared, with a suggestion", () => {
    const { diagnostics } = resolve(`
      world { name: "W" }
      asset chair { source: "assets/chair.glb" }
      group hall {
        model { asset: chiar, size: 1 1 1 }
      }
    `);
    const err = diagnostics.find((d) => d.severity === "error");
    expect(err?.message).toContain('unknown asset "chiar"');
    expect(err?.message).toContain('did you mean "chair"?');
  });

  it("is accepted in a group and in a nested group, with each transform baked in", () => {
    const { world, diagnostics } = resolve(`
      world { name: "W" }
      asset a { source: "a.glb" }
      asset b { source: "b.glb" }
      group props {
        at: 5 0 5
        model { asset: a, size: 1 1 1, at: 1 0 0 }
      }
      group hall {
        group inner { model { asset: b, size: 1 1 1 } }
      }
    `);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    // a group's transform is baked into each child (ResolvedObject is flat)
    expect(world!.topLevelObjects[0]!.position).toMatchObject({ x: 6, y: 0, z: 5 });
    expect(world!.topLevelObjects[0]!.asset).toBe("a");
    expect(world!.topLevelObjects[1]!.asset).toBe("b");
  });

  it("rejects an unknown property on a model", () => {
    const { ast } = parseWorldFile(`world { name: "W" }\nasset a { source: "a.glb" }\ngroup r {\n model { asset: a, size: 1 1 1, wibble: 2 } }`, "world.world");
    const d = validateStatements(ast.statements);
    expect(d.some((x) => x.severity === "error" && x.message.includes("wibble"))).toBe(true);
  });
});

describe("shadow casting by alpha mode", () => {
  // glTF alphaMode MASK -> alphaTest; BLEND -> transparent. three.js's depth
  // material carries the first but not the second, so only MASK may cast.
  const cutout = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
  const blended = new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false });
  const opaque = new THREE.MeshStandardMaterial();

  it("keeps a cutout (foliage, chainlink) casting a shaped shadow", () => {
    expect(isBlended(cutout)).toBe(false);
    expect(isBlended(opaque)).toBe(false);
  });

  it("stops a soft overlay (graffiti, rust stain) casting its whole quad", () => {
    expect(isBlended(blended)).toBe(true);
  });

  it("only spares a multi-material mesh when every slot is blended", () => {
    expect(isBlended([blended, blended])).toBe(true);
    expect(isBlended([blended, opaque])).toBe(false);
  });
});

function schemaDiags(src: string) {
  const { ast } = parseWorldFile(src, "world.world");
  return validateStatements(ast.statements);
}

describe("collide modes", () => {
  it("reads true/false/box/omitted as mesh/none/box/mesh", () => {
    const { world, diagnostics } = resolve(`
      world { name: "W" }
      asset x { source: "x.glb" }
      group r {
        model a { asset: x, size: 1 1 1, collide: true }
        model b { asset: x, size: 1 1 1, collide: false }
        model c { asset: x, size: 1 1 1, collide: box }
        model d { asset: x, size: 1 1 1 }
      }
    `);
    expect(diagnostics.filter((x) => x.severity === "error")).toHaveLength(0);
    expect(world!.topLevelObjects.map((o) => o.collide)).toEqual(["mesh", "none", "box", "mesh"]);
  });

  it("rejects any other bare word, with a suggestion", () => {
    const d = schemaDiags(`world { name: "W" }\nasset x { source: "x.glb" }\ngroup r {\n model { asset: x, size: 1 1 1, collide: bax } }`);
    const err = d.find((x) => x.severity === "error");
    expect(err?.message).toContain('invalid value "bax"');
    expect(err?.message).toContain('did you mean "box"?');
  });
});

describe("box-proxy collider", () => {
  const obj = (over: Partial<ResolvedObject> = {}): ResolvedObject => ({
    id: 0,
    tags: [],
    asset: "crate",
    position: { x: 1, y: 0, z: 2 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    size: { x: 1.6, y: 0.8, z: 1.2 },
    collide: "box",
    visible: true,
    ...over,
  });

  // A CoD prop's pivot is wherever the artist left it: barrels and crates sit
  // on theirs, the humvee is centred on its, and a container locking bar hangs
  // almost entirely below its own. So the proxy has to come from the asset's
  // MEASURED bounds, not from `size` centred on the node — that would be
  // half-buried for some props and nowhere near the mesh for others.
  it("is placed and sized from the measured bounds, not the node origin", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-0.4, 0, -0.3), new THREE.Vector3(0.4, 2, 0.3));
    const collider = buildBoxCollider(obj(), bounds);
    expect(collider.position.toArray()).toEqual([0, 1, 0]); // centre of the bounds, not 0,0,0
    expect(collider.scale.toArray()).toEqual([0.8, 2, 0.6]);
  });

  it("handles a pivot the geometry hangs below", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-0.1, -2.34, -0.05), new THREE.Vector3(0.1, 0.21, 0.05));
    const collider = buildBoxCollider(obj(), bounds);
    expect(collider.position.y).toBeCloseTo(-1.065);
    expect(collider.scale.y).toBeCloseTo(2.55);
  });

  // collision.ts collects colliders with a visibility-agnostic traverse(), but
  // StaticGeometryGenerator then uses traverseVisible — so visible=false would
  // silently drop every prop out of the BVH. Hiding by material keeps it in.
  it("is hidden by material, never by visibility", () => {
    const collider = buildBoxCollider(obj(), new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)));
    expect(collider.visible).toBe(true);
    expect((collider.material as THREE.Material).visible).toBe(false);
    expect(collider.userData.collide).toBe(true);
    expect(collider.castShadow).toBe(false);
  });

  it("never lets a flat prop collapse to a degenerate box", () => {
    const flat = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 0, 1));
    expect(buildBoxCollider(obj(), flat).scale.y).toBeGreaterThan(0);
  });

  it("reuses the shared unit box, so proxies allocate no geometry", () => {
    const a = buildBoxCollider(obj(), new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)));
    const b = buildBoxCollider(obj(), new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(2, 2, 2)));
    expect(a.geometry).toBe(b.geometry);
    expect(a.geometry.userData.shared).toBe(true);
  });

  it("adds no collider to the group until the asset has loaded", () => {
    // The box is measured from the asset, so it cannot exist before the load
    // resolves. WorldSession awaits `pending` before collision.rebuild for exactly
    // this reason.
    const pending: Promise<void>[] = [];
    const group = buildModelMesh(obj(), { name: "crate", source: "assets/crate.glb" }, { baseUrl: "/worlds/w/", pending, store: new AssetStore() });
    expect(group.children).toHaveLength(0);
    expect(pending).toHaveLength(1);
  });

  // `collide: box` is also the fallback when `collide: hull` finds no hull
  // source, so this geometry is on a path imported maps really take. It is
  // shared by every proxy in the process and tagged `shared` for exactly this:
  // freeing it on leaving a world would leave the next world's proxies drawing
  // from released buffers — a failure that only shows on the *second* load.
  it("keeps its shared geometry across a world unload", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    const first = buildBoxCollider(obj(), bounds);
    const root = new THREE.Group();
    root.add(first);

    const disposed = vi.spyOn(first.geometry, "dispose");
    disposeScene({
      root,
      spawn: {},
      pending: [],
      animated: [],
      nodes: new Map(),
      hulls: { geometries: new Map(), requested: new Set(), placements: [] },
    } as unknown as BuiltScene);

    expect(disposed).not.toHaveBeenCalled();
    expect(buildBoxCollider(obj(), bounds).geometry).toBe(first.geometry);
  });
});

// The `asset` node: a model declared once and placed many times (interchange-mw3
// places 232 assets 8,420 times).
describe("asset node", () => {
  const parse = (src: string) => validateStatements(parseWorldFile(src, "w.world").ast.statements);

  it("carries its source and cull distance", () => {
    const { world, diagnostics } = resolve(`
      world { name: "W" }
      asset rubble { source: "p/rubble.glb", until: 29 }
      group r {
        model { asset: rubble, size: 1 1 1 }
      }
    `);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(world!.assets["rubble"]).toEqual({ name: "rubble", source: "p/rubble.glb", until: 29, hull: undefined });
  });

  it("requires a name and a source", () => {
    expect(parse(`world { name: "W" }\nasset { source: "a.glb" }`).some((d) => d.message.includes("requires a name"))).toBe(true);
    expect(parse(`world { name: "W" }\nasset a { until: 5 }`).some((d) => d.message.includes('requires a "source"'))).toBe(true);
  });

  it("takes no children, and sits only at the top level", () => {
    expect(parse(`world { name: "W" }\nasset a { source: "a.glb", box { size: 1 1 1 } }`).some((d) => d.message.includes("cannot contain nested nodes"))).toBe(
      true,
    );
    expect(
      parse(`world { name: "W" }\nasset a { source: "a.glb", lod { source: "b.glb" } }`).some((d) => d.message.includes("cannot contain nested nodes")),
    ).toBe(true);
    expect(parse(`world { name: "W" }\ngroup r {\n asset a { source: "a.glb" } }`).some((d) => d.message.includes("cannot appear inside"))).toBe(true);
  });
});

// The `collision` node: a world's own collision mesh, exported from the game's
// clipmap rather than derived from render geometry (scripts/cod/collision.py).
describe("collision node", () => {
  it("resolves a source path", () => {
    const { world, diagnostics } = resolve(`
      world { name: "W" }
      collision { source: "assets/collision.glb" }
      group r {}
    `);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(world!.collision).toEqual({ source: "assets/collision.glb" });
  });

  it("is absent when not declared", () => {
    const { world } = resolve(`world { name: "W" }\ngroup r {}`);
    expect(world!.collision).toBeUndefined();
  });

  it("requires a source, takes no name, and only sits at the top level", () => {
    const d = (src: string) => validateStatements(parseWorldFile(src, "w.world").ast.statements);
    expect(d(`world { name: "W" }\ncollision { }`).some((x) => x.message.includes('requires a "source"'))).toBe(true);
    expect(d(`world { name: "W" }\ncollision c { source: "a.glb" }`).some((x) => x.message.includes("does not take a name"))).toBe(true);
    expect(d(`world { name: "W" }\ngroup r {\n collision { source: "a.glb" } }`).some((x) => x.message.includes("cannot appear inside"))).toBe(true);
  });
});

// `hull: 0`: the asset's own mesh doubles as its collision shape, instead of a
// box that is mostly empty air around a thin prop.
describe("asset hull", () => {
  const parse = (src: string) => validateStatements(parseWorldFile(src, "w.world").ast.statements);

  it("records that the asset has a hull", () => {
    const { world, diagnostics } = resolve(`
      world { name: "W" }
      asset light { source: "p/light.glb", until: 20, hull: 0 }
      group r {
        model { asset: light, size: 1 1 1, collide: hull }
      }
    `);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(world!.assets["light"]!.hull).toBe(0);
    expect(world!.topLevelObjects[0]!.collide).toBe("hull");
  });

  it("defaults to no hull, which keeps every existing world valid", () => {
    const { world } = resolve(`
      world { name: "W" }
      asset a { source: "a.glb" }
      group r {
        model { asset: a, size: 1 1 1, collide: box }
      }
    `);
    expect(world!.assets["a"]!.hull).toBeUndefined();
    expect(world!.topLevelObjects[0]!.collide).toBe("box");
  });

  it("rejects any index but 0", () => {
    const { diagnostics } = resolve(`
      world { name: "W" }
      asset a { source: "a.glb", hull: 3 }
      group r {
        model { asset: a, size: 1 1 1 }
      }
    `);
    expect(diagnostics.some((d) => d.severity === "error" && d.message.includes('use "hull: 0"'))).toBe(true);
  });

  it("accepts `hull` wherever `box` is accepted", () => {
    expect(
      parse(`world { name: "W" }\nasset a { source: "a.glb" }\ngroup r {\n model { asset: a, size: 1 1 1, collide: hull } }`).filter(
        (d) => d.severity === "error",
      ),
    ).toHaveLength(0);
  });
});
