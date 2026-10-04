// Collider view (`C`): draws the collision you cannot otherwise see.
//
//   annotated   `collide: box` proxies and entrance ramps as wireframe boxes,
//               plus an imported map's clip groups (its own invisible walls) as
//               wireframe coloured by `contents`. `solid` and `soup` are left
//               out: they track geometry you can already see.
//   everything  what the collision BVHs were actually built from, prop hulls
//               included. The only view that cannot disagree with what stops you.
//
// See docs/engine/collision.md.

import * as THREE from "three";
import { HIDDEN_COLLIDER } from "../scene/materials.js";

/** The 12 edges of a box, as index pairs into the 8 corners produced below. */
const BOX_EDGES = [
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0], // -Z face
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4], // +Z face
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7], // the struts between them
];

/** One material per `contents` bitmask, so a kind of clip is the same colour on every map. Kept for the page's life. */
const clipMaterials = new Map<string, THREE.MeshBasicMaterial>();

function clipMaterial(contents: string | undefined): THREE.MeshBasicMaterial {
  const key = contents ?? "unknown";
  let material = clipMaterials.get(key);
  if (!material) {
    // Hash the bitmask to a stable hue.
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    material = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL((hash % 360) / 360, 0.75, 0.6),
      // Wireframe: a boundary clip can be 3 km across, and filled in it would cover the frame.
      wireframe: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    clipMaterials.set(key, material);
  }
  return material;
}

/** The "everything" view's material, instanced per geometry: one draw per prop asset, not per placement. */
const FULL_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0x4fd1ff,
  wireframe: true,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** A removable part that is present: orange, so a door reads apart from the wall it sits in. */
const PART_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xff9a3c,
  wireframe: true,
  transparent: true,
  opacity: 0.6,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** How much of the collision the view is drawing. `C` cycles these in order. */
export type ColliderMode = "off" | "annotated" | "everything";

const MODES: ColliderMode[] = ["off", "annotated", "everything"];

/** What one clip group is, for the stats readout and the console on toggle. */
export interface ClipGroup {
  group: string;
  contents?: string;
  blocks?: string[];
  materials?: string[];
  brushes?: number;
  triangles: number;
}

export class ColliderView {
  /** Every proxy in one LineSegments, one draw call, rebuilt on toggle and on load. */
  readonly object = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    // Depth-tested: through walls, a whole map's boxes are unreadable.
    new THREE.LineBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.85 }),
  );

  private count = 0;

  /** The clip meshes found by the last build. Already in the scene, so showing one is a `visible` flag and a material. */
  private clips: { mesh: THREE.Mesh; info: ClipGroup }[] = [];

  /**
   * A clip mesh's ancestors. WorldSession hides the whole collision subtree
   * after the BVH build, and a hidden ancestor hides its children, so showing a
   * clip group means un-hiding its chain too. Siblings stay hidden on their own flags.
   */
  private clipAncestors: THREE.Object3D[] = [];

  /** Every collision group mesh, for the "everything" view. */
  private full: THREE.Mesh[] = [];
  private fullAncestors = new Set<THREE.Object3D>();

  /** The "everything" view's meshes. */
  readonly fullObject = new THREE.Group();

  private mode: ColliderMode = "off";

  constructor() {
    this.object.name = "collider-view";
    this.object.visible = false;
    this.object.frustumCulled = false; // one object spanning the whole world
    this.object.renderOrder = 998;
  }

  /** How many proxies the last build found. */
  get colliderCount(): number {
    return this.count;
  }

  /** The clip groups the last build found, largest first. */
  get clipGroups(): ClipGroup[] {
    return this.clips.map((c) => c.info).sort((a, b) => b.triangles - a.triangles);
  }

  /** Total clip brushes across every group. */
  get clipBrushCount(): number {
    return this.clips.reduce((n, c) => n + (c.info.brushes ?? 0), 0);
  }

  /** True in any mode but `off`. */
  get visible(): boolean {
    return this.mode !== "off";
  }

  get currentMode(): ColliderMode {
    return this.mode;
  }

  /** Advance to the next mode and return it. `C` calls this. */
  nextMode(): ColliderMode {
    return MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
  }

  /** Rebuild from the scene as it stands, in world space. */
  build(root: THREE.Object3D): void {
    const positions: number[] = [];
    this.count = 0;
    this.clips = [];
    const ancestors = new Set<THREE.Object3D>();

    root.updateWorldMatrix(false, true);
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) {
        return;
      }

      if (obj.userData.clipOnly === true) {
        for (let o = obj.parent; o && o !== root; o = o.parent) {
          ancestors.add(o);
        }
        const index = obj.geometry.index;
        this.clips.push({
          mesh: obj,
          info: {
            group: String(obj.userData.clipGroup ?? "clip"),
            contents: obj.userData.clipContents,
            blocks: obj.userData.clipBlocks,
            materials: obj.userData.clipMaterials,
            brushes: obj.userData.clipBrushes,
            triangles: Math.floor((index?.count ?? obj.geometry.getAttribute("position")?.count ?? 0) / 3),
          },
        });
        return;
      }

      if (obj.userData.collider !== true) {
        return;
      }
      this.count++;

      // The geometry's own box under the world matrix is the exact, rotated volume.
      if (!obj.geometry.boundingBox) {
        obj.geometry.computeBoundingBox();
      }
      const box = obj.geometry.boundingBox;
      if (!box) {
        return;
      }

      const corners: THREE.Vector3[] = [];
      for (const z of [box.min.z, box.max.z]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const x of [box.min.x, box.max.x]) {
            corners.push(new THREE.Vector3(x, y, z).applyMatrix4(obj.matrixWorld));
          }
        }
      }
      for (const [a, b] of BOX_EDGES) {
        positions.push(corners[a!]!.x, corners[a!]!.y, corners[a!]!.z);
        positions.push(corners[b!]!.x, corners[b!]!.y, corners[b!]!.z);
      }
    });

    this.clipAncestors = [...ancestors];

    this.object.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    this.object.geometry = geometry;
  }

  /** Rebuild the "everything" view from the collision world's own surfaces, not the scene graph. */
  buildFull(root: THREE.Object3D, surfaces: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; part?: number }[]): void {
    this.clearFull();

    // Every group that collides, `solid` and `soup` included.
    this.full = [];
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || typeof obj.userData.collisionGroup !== "string" || obj.userData.collide !== true) {
        return;
      }
      for (let o = obj.parent; o && o !== root; o = o.parent) {
        this.fullAncestors.add(o);
      }
      this.full.push(obj);
    });
    const byGeometry = new Map<THREE.BufferGeometry, THREE.Matrix4[]>();
    const parts = new Set<THREE.BufferGeometry>();
    for (const { geometry, matrix, part } of surfaces) {
      if (part !== undefined) {
        parts.add(geometry);
      }
      const list = byGeometry.get(geometry);
      if (list) {
        list.push(matrix);
      } else {
        byGeometry.set(geometry, [matrix]);
      }
    }
    for (const [geometry, matrices] of byGeometry) {
      const mesh = new THREE.InstancedMesh(geometry, parts.has(geometry) ? PART_MATERIAL : FULL_MATERIAL, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.renderOrder = 997;
      this.fullObject.add(mesh);
    }
  }

  /** Drop the "everything" meshes but not their geometry, which the collision world still queries. */
  private clearFull(): void {
    for (const child of [...this.fullObject.children]) {
      if (child instanceof THREE.InstancedMesh) {
        child.dispose();
      }
      this.fullObject.remove(child);
    }
    for (const mesh of this.full) {
      mesh.visible = false;
      mesh.material = HIDDEN_COLLIDER;
    }
    this.full = [];
    this.fullAncestors.clear();
  }

  setMode(mode: ColliderMode): void {
    this.mode = mode;
    this.fullObject.visible = mode === "everything";
    // Hide or show every group first; `setVisible` then puts back the clip subset for annotated.
    const showing = mode === "everything";
    for (const parent of this.fullAncestors) {
      parent.visible = showing;
    }
    for (const mesh of this.full) {
      mesh.visible = showing;
      mesh.material = showing ? clipMaterial(String(mesh.userData.collisionGroup)) : HIDDEN_COLLIDER;
    }
    if (mode !== "everything") {
      this.clearFull();
    }
    this.setVisible(mode === "annotated");
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
    // Hidden and HIDDEN_COLLIDER after the BVH build, so showing needs both.
    for (const parent of this.clipAncestors) {
      parent.visible = visible;
    }
    for (const { mesh, info } of this.clips) {
      mesh.visible = visible;
      mesh.material = visible ? clipMaterial(info.contents) : HIDDEN_COLLIDER;
    }
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.clips = [];
    this.clipAncestors = [];
    this.clearFull();
  }
}
