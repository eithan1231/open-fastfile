// Debug picking: which authored thing is under the cursor, and a highlight
// over it. A ray into a `model` hits a mesh inside the glTF with no authored
// identity, so a hit walks up to the nearest ancestor scene/ tagged
// (`entityFor`). An instanced prop has no parent chain; its batch's
// `instanceOwners` maps `instanceId` back to the authored node instead.

import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, type MeshBVHOptions } from "three-mesh-bvh";
import type { EntityId } from "@3d/shared/dsl/resolved.js";

// A pick is a raycast over every mesh a ray may land on, and an imported map's
// shell is one mesh of hundreds of thousands of triangles. Patched here rather
// than in a setup module: this is the only Raycaster in the app, and a mesh
// without a `boundsTree` falls through to three's own raycast unchanged.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Above this many meshes (a map shell), highlight only the one hit rather than light up the whole world. */
const MAX_HIGHLIGHT_MESHES = 32;

/**
 * Triangles above which a candidate mesh gets its own BVH, built on the first
 * pick that sees it. Below it the build costs more than the brute-force
 * raycasts it saves, and every authored shape is far below.
 */
const MIN_BVH_TRIANGLES = 10_000;

/**
 * `indirect` keeps the geometry's own index untouched. The default build
 * reorders it, and then a hit's `faceIndex` no longer means the triangle the
 * exporter's `brushStarts` counted — every clip brush would resolve to the
 * wrong one. The option is three-mesh-bvh 0.8's, but missing from its
 * `MeshBVHOptions` type.
 */
const BVH_OPTIONS = { indirect: true } as MeshBVHOptions;

/** Drawn over the top of everything, so a selection stays visible through a wall. */
const HIGHLIGHT_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0x4fd1ff,
  transparent: true,
  opacity: 0.32,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** Colliders highlight in a different colour, so you can tell a box from the prop inside it. */
const COLLIDER_HIGHLIGHT_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xff9f43,
  transparent: true,
  opacity: 0.3,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** One resolved pick: what was hit, and everything worth showing about it. */
export interface Pick {
  /** The authored node — the `model` group a hit mesh belongs to. */
  entity: THREE.Object3D;
  /** The object's runtime address, for anything that wants to reach it again. */
  id?: EntityId;
  /** The exact mesh under the cursor, which for a `model` is one piece of the asset. */
  mesh: THREE.Mesh;
  name?: string;
  /** The non-unique group handles, when the world file gave any. */
  tags?: readonly string[];
  /** Asset path, for a `model`: the only identity an imported prop has. */
  source?: string;
  /** The hit mesh's own material name (glTF assets carry real ones), else the world file's `material:`. */
  material?: string;
  /** The world file's `collide:` value — "mesh", "box" or "none". */
  collide?: string;
  /** The clip an `animate:` model loops. */
  animation?: string;
  /** Entity origin in world space, and its orientation in degrees. */
  position: THREE.Vector3;
  rotation: THREE.Vector3;
  /** Only meaningful on a `model`, where object scale is the authored `scale:`. */
  scale?: THREE.Vector3;
  /** Where the ray actually landed, and how far away that was. */
  point: THREE.Vector3;
  distance: number;
  triangles: number;
  meshes: number;
  /** How many of `meshes` the highlight covers — fewer means MAX_HIGHLIGHT_MESHES kicked in. */
  highlighted: number;
  /** True when the ray landed on a collision proxy rather than on drawn geometry. */
  collider: boolean;
  /** Set when the ray landed on an imported map's clip brush — what it blocks, and why. */
  clip?: {
    group: string;
    contents?: string;
    blocks?: string[];
    /** False for a group the exporter marked as not colliding here (e.g. an AI-only hull). */
    collides: boolean;
    /** The clip materials on the one brush that was hit, else the group's. */
    materials?: string[];
    brushes?: number;
    /** Which brush of the group, 0-based, when the export recorded the ranges. */
    brush?: number;
    /** The brush's own triangle range in the group mesh, for the highlight. */
    range?: { start: number; end: number };
  };
  /** World-space size of whatever the highlight covers. On a proxy, this is the collision box itself. */
  size: THREE.Vector3;
  /** The meshes the highlight covers. Computed here so `highlight` cannot disagree with `highlighted`. */
  targets: THREE.Mesh[];
}

/**
 * A collision proxy stands in for something else, so it is never the answer to
 * "what is this?" — a hit on one resolves to the prop it belongs to, and says
 * so with `collider: true`.
 */
function isCollisionProxy(obj: THREE.Object3D): boolean {
  return obj.userData.collider === true;
}

/** An imported map's clip group: an invisible wall standing in for nothing, so it is itself the answer. */
function isClipGroup(obj: THREE.Object3D): boolean {
  return typeof obj.userData.collisionGroup === "string";
}

/**
 * Which brush of a clip group was hit, and its triangle range. A group merges
 * thousands of brushes into one mesh; `brushStarts` (ascending first-triangle
 * offsets from the exporter) is bisected for the hit face.
 */
function clipBrushAt(mesh: THREE.Mesh, faceIndex: number | null | undefined): { index: number; start: number; end: number } | undefined {
  const starts = mesh.userData.brushStarts;
  if (faceIndex == null || !Array.isArray(starts) || starts.length === 0) {
    return undefined;
  }
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= faceIndex) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const total = Math.floor((mesh.geometry.index?.count ?? 0) / 3);
  return { index: lo, start: starts[lo] as number, end: (starts[lo + 1] as number | undefined) ?? total };
}

/** A node scene/ tagged with an identity. Anything else (a glTF's internals) is part of something. */
function isEntity(obj: THREE.Object3D): boolean {
  if (isCollisionProxy(obj)) {
    return false;
  }
  const d = obj.userData;
  return d.source !== undefined || d.model === true || d.name !== undefined;
}

/**
 * Mirrors scene/instancing.ts's InstancedPart. Declared structurally rather
 * than imported: picking reads this tag, it does not own it.
 */
interface InstancedPart {
  mesh: THREE.InstancedMesh;
  instanceId: number;
}

/**
 * A free-standing Mesh for one instance of a batch, so bounds, highlighting and
 * counts work as for any mesh. Parentless with `matrixAutoUpdate` off, so its
 * matrix survives `updateWorldMatrix`. Geometry and material are borrowed.
 */
function instanceStandIn(source: THREE.InstancedMesh, instanceId: number): THREE.Mesh {
  const stand = new THREE.Mesh(source.geometry, source.material as THREE.Material);
  stand.matrixAutoUpdate = false;
  source.getMatrixAt(instanceId, stand.matrix);
  stand.matrix.premultiply(source.matrixWorld);
  stand.matrixWorld.copy(stand.matrix);
  return stand;
}

/** The authored node behind an instanced hit, or undefined if the hit was an ordinary mesh. */
function resolveInstance(hit: THREE.Intersection): { entity: THREE.Object3D; mesh: THREE.Mesh } | undefined {
  const owners = hit.object.userData.instanceOwners as THREE.Object3D[] | undefined;
  if (!owners || hit.instanceId === undefined) {
    return undefined;
  }
  const entity = owners[hit.instanceId];
  if (!entity) {
    return undefined;
  }
  return { entity, mesh: instanceStandIn(hit.object as THREE.InstancedMesh, hit.instanceId) };
}

/** Every instanced piece of one authored node — a prop whose asset had two primitives has two. */
function instancedPartsOf(entity: THREE.Object3D): THREE.Mesh[] {
  const parts = entity.userData.instancedParts as InstancedPart[] | undefined;
  if (!parts) {
    return [];
  }
  return parts.map((part) => instanceStandIn(part.mesh, part.instanceId));
}

function entityFor(mesh: THREE.Object3D): THREE.Object3D {
  for (let o: THREE.Object3D | null = mesh; o; o = o.parent) {
    if (isEntity(o)) {
      return o;
    }
  }
  return mesh; // an untagged mesh is still worth reporting on its own terms
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/**
 * Whether a ray may land here. Hidden colliders are visible objects with a
 * material that does not draw (docs/engine/collision.md), so they are skipped
 * unless collider view is on; otherwise every click on a prop would return the
 * invisible box in front of it.
 */
function isPointable(obj: THREE.Object3D, colliders: boolean): obj is THREE.Mesh {
  if (!(obj instanceof THREE.Mesh)) {
    return false;
  }
  if (colliders && (isCollisionProxy(obj) || isClipGroup(obj))) {
    return true;
  }
  return materialsOf(obj).some((m) => m?.visible !== false);
}

/** The clip materials recorded for one brush of a group, if any. */
function brushMaterials(mesh: THREE.Mesh, index: number | undefined): string[] | undefined {
  const all = mesh.userData.brushMaterials;
  if (index === undefined || !Array.isArray(all)) {
    return undefined;
  }
  const entry = all[index];
  return typeof entry === "string" && entry ? entry.split(",") : undefined;
}

/**
 * One brush's triangles, copied into their own geometry. Sharing the group's
 * buffers would let `clear` dispose them, and a `drawRange` on the shared
 * geometry would hide the rest of the group's collision.
 */
function clipSlice(geometry: THREE.BufferGeometry, range: { start: number; end: number }): THREE.BufferGeometry | undefined {
  const index = geometry.index;
  const position = geometry.getAttribute("position");
  if (!index || !position) {
    return undefined;
  }
  const positions = new Float32Array((range.end - range.start) * 9);
  let out = 0;
  for (let i = range.start * 3; i < range.end * 3; i++) {
    const v = index.getX(i);
    positions[out++] = position.getX(v);
    positions[out++] = position.getY(v);
    positions[out++] = position.getZ(v);
  }
  const slice = new THREE.BufferGeometry();
  slice.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return slice;
}

/** One clip brush's world-space bounds, from the group mesh's index range. */
function clipBrushBounds(mesh: THREE.Mesh, range: { start: number; end: number }): THREE.Box3 | undefined {
  const index = mesh.geometry.index;
  const position = mesh.geometry.getAttribute("position");
  if (!index || !position) {
    return undefined;
  }
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = range.start * 3; i < range.end * 3; i++) {
    const j = index.getX(i);
    box.expandByPoint(v.set(position.getX(j), position.getY(j), position.getZ(j)));
  }
  return box.isEmpty() ? undefined : box.applyMatrix4(mesh.matrixWorld);
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const count = geometry.index ? geometry.index.count : (geometry.getAttribute("position")?.count ?? 0);
  return Math.floor(count / 3);
}

const RAD_TO_DEG = 180 / Math.PI;

export class ScenePicker {
  /**
   * Highlight geometry, outside the built scene: the clones share their sources'
   * geometry, which `disposeScene` would free, and they must stay out of
   * `contentBounds` and the collision rebuild.
   */
  readonly overlay = new THREE.Group();

  private readonly raycaster = new THREE.Raycaster();

  /** Geometry this picker built a BVH for, so `releaseTrees` can free them again. */
  private readonly trees = new Set<THREE.BufferGeometry>();

  constructor() {
    this.raycaster.firstHitOnly = true; // only the nearest hit per mesh is ever read
    this.overlay.name = "inspector-overlay";
    this.overlay.renderOrder = 999;
    this.overlay.matrixAutoUpdate = false;
  }

  /** The thing under a normalised device coordinate. `root` is the built scene, not the THREE.Scene, or the highlight would pick itself. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera, root: THREE.Object3D, colliders = false): Pick | undefined {
    this.raycaster.setFromCamera(ndc, camera);
    // Only pointable meshes are handed to the raycaster. three's own traversal
    // ignores `visible`, so `intersectObject(root, true)` brute-forces the
    // hidden collision mesh and every clip group on every pick.
    const hit = this.raycaster.intersectObjects(this.candidates(root, colliders), false)[0];
    if (!hit) {
      return undefined;
    }

    // An instanced hit has no parent chain to walk, so it resolves by index
    // instead; everything after this point is identical either way.
    const instance = resolveInstance(hit);
    const mesh = instance?.mesh ?? (hit.object as THREE.Mesh);
    const entity = instance?.entity ?? entityFor(mesh);
    const d = entity.userData;

    // Highlight the proxy alone rather than its owner's drawn geometry: when
    // you point at a collision box, the box is the thing you are asking about.
    const proxy = isCollisionProxy(mesh);
    const clipMesh = isClipGroup(mesh);
    const clipBrush = clipMesh ? clipBrushAt(mesh, hit.faceIndex) : undefined;
    // An instanced node's own meshes have moved into the batches, so its parts
    // come from the tag rather than from its children.
    const meshes: THREE.Mesh[] = instancedPartsOf(entity);
    entity.traverse((o) => {
      if (isPointable(o, colliders)) {
        meshes.push(o);
      }
    });
    // A clip group is thousands of brushes in one mesh, so the highlight is narrowed to one brush below.
    const targets = proxy || clipMesh || meshes.length > MAX_HIGHLIGHT_MESHES ? [mesh] : meshes;

    // A clip group's bounds span the map; measure the one brush.
    if (clipBrush) {
      mesh.updateWorldMatrix(true, false);
    }
    const brushBounds = clipBrush ? clipBrushBounds(mesh, clipBrush) : undefined;
    const bounds = brushBounds ?? new THREE.Box3();
    if (!brushBounds) {
      for (const target of targets) {
        target.updateWorldMatrix(true, false);
        bounds.expandByObject(target);
      }
    }

    entity.updateWorldMatrix(true, false);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    entity.matrixWorld.decompose(position, quaternion, scale);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");

    const assetMaterial = materialsOf(mesh).find((m) => m?.name)?.name;

    return {
      entity,
      mesh,
      id: typeof d.id === "number" ? d.id : undefined,
      name: typeof d.name === "string" ? d.name : undefined,
      tags: Array.isArray(d.tags) && d.tags.length > 0 ? (d.tags as string[]) : undefined,
      source: typeof d.source === "string" ? d.source : undefined,
      material: assetMaterial || (typeof d.material === "string" ? d.material : undefined),
      collide: typeof d.collideMode === "string" ? d.collideMode : undefined,
      animation: typeof d.animation === "string" ? d.animation : undefined,
      // A clip group sits at the origin like any merged mesh, so its transform
      // says nothing. Report where the brush actually is.
      position: brushBounds ? brushBounds.getCenter(new THREE.Vector3()) : position,
      rotation: new THREE.Vector3(euler.x * RAD_TO_DEG, euler.y * RAD_TO_DEG, euler.z * RAD_TO_DEG),
      scale,
      point: hit.point.clone(),
      distance: hit.distance,
      triangles: triangleCount(mesh.geometry),
      meshes: meshes.length,
      highlighted: targets.length,
      collider: proxy || clipMesh,
      clip: clipMesh
        ? {
            group: String(mesh.userData.collisionGroup ?? mesh.userData.clipGroup ?? "clip"),
            contents: mesh.userData.clipContents,
            blocks: mesh.userData.clipBlocks,
            collides: mesh.userData.collide === true,
            materials: brushMaterials(mesh, clipBrush?.index) ?? mesh.userData.clipMaterials,
            brushes: mesh.userData.clipBrushes,
            brush: clipBrush?.index,
            range: clipBrush ? { start: clipBrush.start, end: clipBrush.end } : undefined,
          }
        : undefined,
      size: bounds.isEmpty() ? new THREE.Vector3() : bounds.getSize(new THREE.Vector3()),
      targets,
    };
  }

  /** Draw the highlight for a pick. Replaces whatever was highlighted before. */
  highlight(pick: Pick): void {
    this.clear();

    for (const mesh of pick.targets) {
      mesh.updateWorldMatrix(true, false);
      // Borrowed geometry, except a clip brush's slice, which `clear` disposes.
      const geometry = (pick.clip?.range && mesh.geometry.index ? clipSlice(mesh.geometry, pick.clip.range) : undefined) ?? mesh.geometry;
      const clone = new THREE.Mesh(geometry, pick.collider ? COLLIDER_HIGHLIGHT_MATERIAL : HIGHLIGHT_MATERIAL);
      clone.userData.ownsGeometry = geometry !== mesh.geometry;
      clone.matrixAutoUpdate = false;
      clone.matrix.copy(mesh.matrixWorld);
      clone.renderOrder = 999;
      clone.frustumCulled = false;
      this.overlay.add(clone);
    }

    // The entity's local axes (red/green/blue = X/Y/Z), to check an import's
    // orientation. Not for a clip brush, whose "entity" sits at the origin.
    if (pick.clip) {
      this.overlay.updateMatrixWorld(true);
      return;
    }
    const axes = new THREE.AxesHelper(THREE.MathUtils.clamp(pick.size.length() * 0.35, 0.25, 4));
    axes.matrixAutoUpdate = false;
    axes.matrix.copy(pick.entity.matrixWorld);
    axes.renderOrder = 1000;
    const axesMaterial = axes.material as THREE.LineBasicMaterial;
    axesMaterial.depthTest = false;
    axesMaterial.transparent = true;
    this.overlay.add(axes);

    // Nothing updates world matrices per frame, so without this the highlight draws at the origin.
    this.overlay.updateMatrixWorld(true);
  }

  /**
   * The meshes a ray may land on, with a BVH on the big ones. Collected per
   * pick rather than cached: one traversal is cheap next to a raycast, and
   * instancing, collider view and hot reload all reshape the graph.
   */
  private candidates(root: THREE.Object3D, colliders: boolean): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    root.traverse((obj) => {
      if (!isPointable(obj, colliders)) {
        return;
      }
      out.push(obj);
      const geometry = obj.geometry;
      if (geometry.boundsTree || triangleCount(geometry) < MIN_BVH_TRIANGLES) {
        return;
      }
      try {
        geometry.computeBoundsTree(BVH_OPTIONS);
        this.trees.add(geometry);
      } catch (err) {
        console.warn("[inspector] could not build a BVH for picking; falling back to a brute-force raycast", err);
      }
    });
    return out;
  }

  /** Free the picking BVHs. Called before the scene goes: a hot reload keeps the geometry, and the trees hold onto it. */
  releaseTrees(): void {
    for (const geometry of this.trees) {
      geometry.disposeBoundsTree();
    }
    this.trees.clear();
  }

  clear(): void {
    for (const child of [...this.overlay.children]) {
      if (child instanceof THREE.AxesHelper) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      } else if (child instanceof THREE.Mesh && child.userData.ownsGeometry === true) {
        child.geometry.dispose();
      }
      this.overlay.remove(child);
    }
  }
}
