// The debug inspector's picking rules (src/engine/picking.ts).
//
// Two of these guard mistakes that look like nothing on screen: picking the
// invisible collision proxy that stands in front of a prop rather than the
// prop, and highlighting an entity that happens to be the entire world.
//
// three.js runs headless in Node; nothing here touches a renderer or the DOM.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ScenePicker } from "../src/engine/picking.js";
import { HIDDEN_COLLIDER } from "../src/scene/materials.js";

const geometry = new THREE.BoxGeometry(1, 1, 1);

function mesh(material: THREE.Material = new THREE.MeshBasicMaterial()): THREE.Mesh {
  return new THREE.Mesh(geometry, material);
}

/** A camera at the origin looking down -Z, matching the engine's convention. */
function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);
  return cam;
}

const CENTER = new THREE.Vector2(0, 0);

describe("ScenePicker", () => {
  it("reports the authored node, not the mesh inside its asset", () => {
    // What a `model` actually looks like once loaded: a tagged group wrapping
    // an untagged hierarchy that came out of the glTF.
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.userData = { model: true, source: "assets/props/mw2_forklift_lod0.glb", collideMode: "box" };
    const inner = new THREE.Group(); // the glTF's own scene node
    const surf = mesh();
    inner.add(surf);
    group.add(inner);
    group.position.set(0, 0, -5);
    root.add(group);
    root.updateMatrixWorld(true);

    const pick = new ScenePicker().pick(CENTER, camera(), root);
    expect(pick?.entity).toBe(group);
    expect(pick?.mesh).toBe(surf);
    expect(pick?.source).toBe("assets/props/mw2_forklift_lod0.glb");
    expect(pick?.collide).toBe("box");
  });

  it("looks through a collide: box proxy to the prop it stands for", () => {
    // The proxy is a real, visible object carrying a material that does not
    // draw — it has to be, or the BVH would drop it. Sitting nearer the camera
    // than the prop, it would otherwise be every single pick.
    const root = new THREE.Group();

    const group = new THREE.Group();
    group.userData = { model: true, source: "assets/props/com_barrel_white_rust_lod0.glb" };
    const surf = mesh();
    group.add(surf);
    group.position.set(0, 0, -5);
    root.add(group);

    const proxy = mesh(HIDDEN_COLLIDER);
    proxy.userData.collider = true;
    proxy.position.set(0, 0, -3); // nearer the camera than the prop
    root.add(proxy);
    root.updateMatrixWorld(true);

    const pick = new ScenePicker().pick(CENTER, camera(), root);
    expect(pick?.mesh).toBe(surf);
    expect(pick?.entity).toBe(group);
  });

  it("highlights a prop whole but a huge entity only where you pointed", () => {
    const picker = new ScenePicker();

    const prop = new THREE.Group();
    prop.userData = { model: true, source: "prop.glb" };
    for (let i = 0; i < 4; i++) {
      prop.add(mesh());
    }
    prop.position.set(0, 0, -5);
    const propRoot = new THREE.Group().add(prop);
    propRoot.updateMatrixWorld(true);

    const small = picker.pick(CENTER, camera(), propRoot);
    expect(small?.meshes).toBe(4);
    expect(small?.highlighted).toBe(4);

    // The map shell: one authored node, 123 sibling meshes. Highlighting it
    // whole would light up the entire world.
    const shell = new THREE.Group();
    shell.userData = { model: true, source: "assets/world.glb", name: "shell" };
    for (let i = 0; i < 40; i++) {
      const m = mesh();
      m.position.set(0, 0, -5 - i * 0.01);
      shell.add(m);
    }
    const shellRoot = new THREE.Group().add(shell);
    shellRoot.updateMatrixWorld(true);

    const big = picker.pick(CENTER, camera(), shellRoot);
    expect(big?.meshes).toBe(40);
    expect(big?.highlighted).toBe(1);
  });

  it("reports orientation in degrees, which is what a bad import shows up in", () => {
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.userData = { model: true, source: "dome.glb" };
    group.rotation.set(Math.PI / 2, 0, -98 * (Math.PI / 180)); // the `dome` prop's real rotation
    group.scale.setScalar(2.54);
    group.add(mesh());
    group.position.set(0, 0, -5);
    root.add(group);
    root.updateMatrixWorld(true);

    const pick = new ScenePicker().pick(CENTER, camera(), root);
    expect(pick?.rotation.x).toBeCloseTo(90, 4);
    expect(pick?.rotation.z).toBeCloseTo(-98, 4);
    expect(pick?.scale?.x).toBeCloseTo(2.54, 6);
  });

  it("borrows geometry for the highlight rather than owning it", () => {
    // disposeScene frees every untagged geometry under the built root. If a
    // highlight cloned geometry it would leak; if it disposed the geometry it
    // borrowed, the real mesh would vanish on the next reload.
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.userData = { model: true, source: "prop.glb" };
    const surf = mesh();
    group.add(surf);
    group.position.set(0, 0, -5);
    root.add(group);
    root.updateMatrixWorld(true);

    const picker = new ScenePicker();
    const pick = picker.pick(CENTER, camera(), root)!;
    picker.highlight(pick);

    const clones = picker.overlay.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    expect(clones).toHaveLength(1);
    expect(clones[0]!.geometry).toBe(surf.geometry);

    picker.clear();
    expect(picker.overlay.children).toHaveLength(0);
    // Still usable after the highlight went away.
    expect(surf.geometry.getAttribute("position")).toBeDefined();
  });

  it("puts the highlight where the mesh actually is", () => {
    // The clones set `matrixAutoUpdate = false` and copy the source's world
    // matrix, which only works because three.js re-derives matrixWorld from
    // the parent every frame (Scene.updateMatrix flags it, and force cascades).
    // If that ever stopped holding, every highlight would silently draw at the
    // world origin instead of on the thing you clicked.
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.userData = { model: true, source: "prop.glb" };
    const surf = mesh();
    group.add(surf);
    group.position.set(3, 4, -5);
    root.add(group);
    scene.add(root);

    const picker = new ScenePicker();
    scene.add(picker.overlay);
    scene.updateMatrixWorld(true);

    const cam = camera();
    cam.position.set(3, 4, 0);
    cam.lookAt(3, 4, -5);
    cam.updateMatrixWorld(true);

    picker.highlight(picker.pick(CENTER, cam, root)!);
    scene.updateMatrixWorld(false); // exactly what the render loop does

    const clone = picker.overlay.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    const at = new THREE.Vector3().setFromMatrixPosition(clone.matrixWorld);
    expect(at.distanceTo(new THREE.Vector3().setFromMatrixPosition(surf.matrixWorld))).toBeLessThan(1e-9);
  });

  it("points at the collision box itself in collider mode", () => {
    // The same scene as the test above, asked the other question. A proxy is
    // never its own answer to "what is this?" — it resolves to the prop it
    // stands for — but it is what gets measured and highlighted.
    const root = new THREE.Group();

    const group = new THREE.Group();
    group.userData = { model: true, source: "assets/props/com_barrel_white_rust_lod0.glb" };
    const surf = mesh();
    surf.scale.setScalar(0.5); // the barrel, inside its box
    group.add(surf);

    // buildBoxCollider parents the proxy to the model group, so it wraps the
    // prop and the ray meets its front face first.
    const proxy = mesh(HIDDEN_COLLIDER);
    proxy.userData.collider = true;
    proxy.scale.set(0.74, 1.12, 0.74); // a barrel's measured bounds
    group.add(proxy);

    group.position.set(0, 0, -5);
    root.add(group);
    root.updateMatrixWorld(true);

    const pick = new ScenePicker().pick(CENTER, camera(), root, true);
    expect(pick?.collider).toBe(true);
    expect(pick?.mesh).toBe(proxy);
    expect(pick?.entity).toBe(group); // still identified as the barrel
    expect(pick?.source).toBe("assets/props/com_barrel_white_rust_lod0.glb");

    // Highlights the box alone, not the prop's drawn geometry.
    expect(pick?.targets).toEqual([proxy]);
    expect(pick?.size.x).toBeCloseTo(0.74, 6);
    expect(pick?.size.y).toBeCloseTo(1.12, 6);
  });

  it("keeps a named proxy from posing as its own entity", () => {
    // buildBoxCollider names the proxy `<owner>.collider`, which would
    // otherwise make it look like an authored node and hide the prop behind it.
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.userData = { model: true, source: "crate.glb", name: "crate" };
    const proxy = mesh(HIDDEN_COLLIDER);
    proxy.userData = { collider: true, name: "crate.collider", collide: true };
    group.add(proxy);
    group.position.set(0, 0, -5);
    root.add(group);
    root.updateMatrixWorld(true);

    const pick = new ScenePicker().pick(CENTER, camera(), root, true);
    expect(pick?.entity).toBe(group);
    expect(pick?.name).toBe("crate");
  });

  it("returns nothing when the ray misses everything", () => {
    const root = new THREE.Group();
    const m = mesh();
    m.position.set(50, 0, -5); // off to the side, out of frame
    root.add(m);
    root.updateMatrixWorld(true);
    expect(new ScenePicker().pick(CENTER, camera(), root)).toBeUndefined();
  });

  // engine/viewer.ts sets `scene.matrixWorldAutoUpdate = false`, so the renderer
  // never walks the graph to turn a node's `matrix` into the `matrixWorld` it
  // draws with. The overlay and its children all have `matrixAutoUpdate` off
  // too, so if `highlight` stops updating them itself, every highlight silently
  // renders at the world origin instead of around the thing that was picked.
  it("gives the highlight a world matrix without help from a scene walk", () => {
    const root = new THREE.Group();
    const m = mesh();
    m.position.set(0, 0, -5);
    m.userData = { name: "crate", shape: "box" };
    root.add(m);
    root.updateMatrixWorld(true);

    const picker = new ScenePicker();
    const pick = picker.pick(CENTER, camera(), root);
    expect(pick?.name).toBe("crate");

    picker.highlight(pick!);
    expect(picker.overlay.children.length).toBeGreaterThan(0);

    // Nothing updates the overlay here — exactly as in the running app, where
    // the scene's own walk is switched off. An un-updated matrixWorld is the
    // identity, which would put every one of these at z = 0.
    const position = new THREE.Vector3();
    for (const child of picker.overlay.children) {
      child.matrixWorld.decompose(position, new THREE.Quaternion(), new THREE.Vector3());
      expect(position.z).toBeCloseTo(-5);
    }
  });
});

// An imported CoD map's clip brushes (scripts/cod/collision.py). Every
// brush sharing one `contents` value is merged into a single mesh, so without
// the per-brush ranges a hit resolves only to "one of 377 clip_player volumes"
// — and the reported position and size describe a mesh that spans the map.
describe("ScenePicker: map clip brushes", () => {
  /**
   * Two boxes merged into one indexed mesh, the way a clip group arrives.
   * Box A is 2 m at z = -5; box B is 2 m at z = -30, directly behind it.
   * `brushStarts` marks where each one's triangles begin.
   */
  /**
   * A merged clip group. `padding` brushes of the same size are appended behind
   * the two the assertions use, to push the mesh over MIN_BVH_TRIANGLES: past
   * that a pick goes through a BVH, and a hit's `faceIndex` still has to count
   * triangles in the exporter's own order.
   */
  function clipGroup(padding = 0): THREE.Mesh {
    const a = new THREE.BoxGeometry(2, 2, 2).translate(0, 0, -5);
    const b = new THREE.BoxGeometry(2, 2, 2).translate(0, 0, -30);
    const trianglesPerBox = (a.index?.count ?? 0) / 3;
    const extra = Array.from({ length: padding }, (_, k) => new THREE.BoxGeometry(2, 2, 2).translate(0, 0, -60 - k * 4));

    const positions: number[] = [];
    const index: number[] = [];
    for (const g of [a, b, ...extra]) {
      const base = positions.length / 3;
      const p = g.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        positions.push(p.getX(i), p.getY(i), p.getZ(i));
      }
      const gi = g.index;
      if (gi) {
        for (let i = 0; i < gi.count; i++) {
          index.push(base + gi.getX(i));
        }
      }
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    merged.setIndex(index);

    const clip = new THREE.Mesh(merged, HIDDEN_COLLIDER);
    clip.userData.clipOnly = true;
    clip.userData.collisionGroup = "clip:0x08030000";
    clip.userData.clipGroup = "clip:0x08030000";
    clip.userData.clipContents = "0x08030000";
    clip.userData.clipBlocks = ["player", "ai", "detail"];
    clip.userData.clipMaterials = ["clip_nosight", "clip_player"];
    clip.userData.clipBrushes = 2 + padding;
    clip.userData.brushStarts = Array.from({ length: 2 + padding }, (_, k) => k * trianglesPerBox);
    clip.userData.brushMaterials = ["clip_player", "clip_nosight", ...extra.map(() => "clip_nosight")];
    return clip;
  }

  it("is invisible to a ray until collider view is on", () => {
    const root = new THREE.Group();
    root.add(clipGroup());
    root.updateMatrixWorld(true);

    const picker = new ScenePicker();
    expect(picker.pick(CENTER, camera(), root, false)).toBeUndefined();
    expect(picker.pick(CENTER, camera(), root, true)?.clip?.group).toBe("clip:0x08030000");
  });

  it("resolves the hit to one brush, with that brush's own material", () => {
    const root = new THREE.Group();
    root.add(clipGroup());
    root.updateMatrixWorld(true);

    // The nearer box is brush 0, so its material wins over the group's list.
    const pick = new ScenePicker().pick(CENTER, camera(), root, true);
    expect(pick?.clip?.brush).toBe(0);
    expect(pick?.clip?.materials).toEqual(["clip_player"]);
    expect(pick?.clip?.contents).toBe("0x08030000");
    expect(pick?.clip?.blocks).toEqual(["player", "ai", "detail"]);
  });

  it("reports the brush's own position and size, not the merged mesh's", () => {
    const root = new THREE.Group();
    root.add(clipGroup());
    root.updateMatrixWorld(true);

    // The merged mesh spans z -31..-4; brush 0 alone is the 2 m box at z = -5.
    const pick = new ScenePicker().pick(CENTER, camera(), root, true);
    expect(pick?.size.z).toBeCloseTo(2, 5);
    expect(pick?.position.z).toBeCloseTo(-5, 5);
  });

  it("resolves the same brush once the group is big enough for a BVH", () => {
    // 900 boxes is ~10.8k triangles, over the threshold. A BVH built the default
    // way reorders the group's index, and the hit's faceIndex would then point
    // into a brush the exporter never wrote there.
    const root = new THREE.Group();
    const clip = clipGroup(898);
    root.add(clip);
    root.updateMatrixWorld(true);
    expect(clip.geometry.index!.count / 3).toBeGreaterThan(10_000);

    const picker = new ScenePicker();
    const pick = picker.pick(CENTER, camera(), root, true);
    expect(clip.geometry.boundsTree).toBeDefined(); // it really did go through a BVH

    expect(pick?.clip?.brush).toBe(0); // the nearest box is still brush 0
    expect(pick?.clip?.materials).toEqual(["clip_player"]);
    expect(pick?.position.z).toBeCloseTo(-5, 5);
    expect(pick?.size.z).toBeCloseTo(2, 5);
    picker.releaseTrees();
  });

  it("highlights only the hit brush, and owns that geometry", () => {
    const root = new THREE.Group();
    root.add(clipGroup());
    root.updateMatrixWorld(true);

    const picker = new ScenePicker();
    const pick = picker.pick(CENTER, camera(), root, true);
    expect(pick).toBeDefined();
    picker.highlight(pick!);

    // One clone, holding one box's triangles rather than the merged two.
    const clones = picker.overlay.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    expect(clones).toHaveLength(1);
    const drawn = clones[0]!.geometry.getAttribute("position").count / 3;
    expect(drawn).toBe(12);
    expect(clones[0]!.userData.ownsGeometry).toBe(true);
  });
});

// P1: a pick used to raycast the whole scene, hidden collision mesh included,
// 15 times a second. Candidates are filtered first and big meshes get a BVH;
// the answer must not change.
describe("ScenePicker raycast cost", () => {
  /** A plane dense enough to cross MIN_BVH_TRIANGLES (80 x 80 x 2 = 12,800 triangles). */
  function bigMesh(): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 80, 80), new THREE.MeshBasicMaterial());
    m.userData.name = "shell";
    m.position.set(0, 0, -5); // facing the camera, which looks down -Z
    return m;
  }

  /** Counts how many times a mesh is handed to the raycaster. */
  function countRaycasts(target: THREE.Mesh): () => number {
    let calls = 0;
    const original = target.raycast.bind(target);
    target.raycast = (raycaster, intersects) => {
      calls++;
      original(raycaster, intersects);
    };
    return () => calls;
  }

  it("builds a BVH for a big mesh once, and picks the same point with it", () => {
    const root = new THREE.Group();
    const shell = bigMesh();
    root.add(shell);
    root.updateMatrixWorld(true);

    const picker = new ScenePicker();
    const first = picker.pick(CENTER, camera(), root);
    expect(shell.geometry.boundsTree).toBeDefined();
    expect(first?.mesh).toBe(shell);
    expect(first?.point.z).toBeCloseTo(-5, 5);

    const tree = shell.geometry.boundsTree;
    const second = picker.pick(CENTER, camera(), root);
    expect(shell.geometry.boundsTree).toBe(tree); // not rebuilt per pick
    expect(second?.distance).toBeCloseTo(first!.distance, 10);

    picker.releaseTrees();
    expect(shell.geometry.boundsTree ?? null).toBeNull();
  });

  it("leaves a small mesh to three's own raycast", () => {
    const root = new THREE.Group();
    const small = mesh();
    small.position.set(0, 0, -5);
    root.add(small);
    root.updateMatrixWorld(true);

    expect(new ScenePicker().pick(CENTER, camera(), root)?.mesh).toBe(small);
    expect(small.geometry.boundsTree ?? null).toBeNull();
  });

  it("never raycasts the hidden collision mesh unless collider view is on", () => {
    const root = new THREE.Group();
    const collision = mesh(HIDDEN_COLLIDER);
    collision.userData.collisionMesh = true;
    collision.userData.collide = true;
    collision.userData.collisionGroup = "solid"; // what buildCollisionMesh tags each group with
    collision.position.set(0, 0, -3); // nearer than the prop
    const prop = mesh();
    prop.userData.name = "crate";
    prop.position.set(0, 0, -5);
    root.add(collision, prop);
    root.updateMatrixWorld(true);

    const calls = countRaycasts(collision);
    const picker = new ScenePicker();
    expect(picker.pick(CENTER, camera(), root, false)?.mesh).toBe(prop);
    expect(calls()).toBe(0);

    expect(picker.pick(CENTER, camera(), root, true)?.mesh).toBe(collision);
    expect(calls()).toBe(1);
  });
});
