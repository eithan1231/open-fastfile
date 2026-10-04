// A world's authored collision mesh: an imported map's own collision, split by
// the exporter into groups (`solid`, `soup`, one `clip:…` per contents mask)
// with the decoded bits in glTF `extras`. See docs/engine/collision.md.
//
// Only the geometry and the tagging live here, because both ends need them: the
// client to draw and pick them, the server to know which groups actually stop a
// player. Fetching the file and choosing a material are the caller's business —
// the client hides these behind an invisible material rather than `visible =
// false`, which would make the BVH build skip them.

import * as THREE from "three";

/** The empty group a world's collision hangs from, named and tagged the one way. */
export function createCollisionGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = "world-collision";
  group.userData.collisionMesh = true;
  return group;
}

/** Every group of a loaded collision glTF, tagged, with the glTF's transforms flattened in. */
export function collisionGroupMeshes(loaded: THREE.Object3D, material: THREE.Material): THREE.Mesh[] {
  loaded.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  loaded.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshes.push(collisionGroupMesh(child, material));
    }
  });
  return meshes;
}

/** `createCollisionGroup` filled with `collisionGroupMeshes`: what a headless load wants. */
export function buildCollisionGroups(loaded: THREE.Object3D, material: THREE.Material): THREE.Group {
  const group = createCollisionGroup();
  for (const mesh of collisionGroupMeshes(loaded, material)) {
    group.add(mesh);
  }
  return group;
}

/**
 * One group of the collision glTF as a mesh of the caller's own: a loaded asset
 * is shared across mounts, and both this and collider view overwrite `material`
 * on what they are given.
 */
export function collisionGroupMesh(source: THREE.Mesh, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(source.geometry, material);
  mesh.name = source.name;
  // The glTF's own node transforms, flattened: the group itself sits at the origin.
  mesh.applyMatrix4(source.matrixWorld);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // The geometry belongs to whoever loaded it, which frees it; disposeScene must not.
  source.geometry.userData.shared = true;
  // Not `collider`: that marks a per-prop box proxy, which collider view draws as a box.
  mesh.userData.collisionMesh = true;

  // GLTFLoader puts `extras` on the node, the mesh's parent; copy them down for picking.
  const extras = { ...source.parent?.userData, ...source.userData };
  // Named for the debug views but kept out of the BVH, e.g. Black Ops' AI and vehicle hulls.
  mesh.userData.collide = extras.collides !== false;
  if (typeof extras.group === "string") {
    mesh.userData.clipGroup = extras.group;
    mesh.userData.collisionGroup = extras.group;
    mesh.userData.clipContents = extras.contents;
    mesh.userData.clipBlocks = extras.blocks;
    mesh.userData.clipMaterials = extras.materials;
    mesh.userData.clipBrushes = extras.brushes;
    // Per-brush ranges and materials; absent on older exports, where picking names only the group.
    mesh.userData.brushStarts = extras.brushStarts;
    mesh.userData.brushMaterials = extras.brushMaterials;
    // Only clip groups have nothing visible behind them, so only they are drawn in the annotated view.
    mesh.userData.clipOnly = extras.group.startsWith("clip:");
  }
  // A removable part's triangles: kept out of the base trees when a `solid` names it.
  if (typeof extras.part === "string") {
    mesh.userData.part = extras.part;
  }
  return mesh;
}

/**
 * Whether this collision group stops a **bullet**, as against stopping a player.
 *
 * They are not the same set, and treating them as one is a bug you cannot see:
 * `clip_player` brushes are invisible, and a map is full of them over windows,
 * railings and gaps. dome-mw3 carries seven such groups and 30,536 triangles of
 * them; interchange-mw3 carries 98,496. A bullet traced against everything that
 * stops a player dies in mid-air in every window on the map, and the shooter is
 * told they missed.
 *
 * Measured, not assumed. Firing level from 40 start spawns in four directions on
 * each map, a bullet that ignores these groups travels further than one that does
 * not on **110 of 160 traces on dome-mw3** (by 14.6 m on average) and **126 of
 * 160 on interchange-mw3** (by 5.1 m). Roughly three shots in four would have
 * stopped at nothing.
 *
 * Decided from the exporter's own decoded `blocks` list rather than from a bit
 * mask re-derived here, because the bit *labels* differ between games and four of
 * IW4/IW5's were guessed wrong (docs/cod/reference.md#collision). `solid` is one
 * of the two the pipeline decides on and means the same thing in all four games.
 *
 * A group with no `blocks` at all is real geometry — the `solid` brushes and the
 * `soup` shell, which is the visible world — and stops everything.
 *
 * Deliberately narrow. A `projectile` clip is not included: whatever stops a
 * rocket is a question for a rocket, and `TraceChannel` is where that answer will
 * go. Conservative in the right direction either way — this decides only what a
 * bullet passes *through*.
 */
export function blocksShots(mesh: THREE.Object3D): boolean {
  if (!mesh.userData.collide) {
    return false;
  }
  const blocks: unknown = mesh.userData.clipBlocks;
  return !Array.isArray(blocks) || blocks.includes("solid");
}

/**
 * Whether this collision group stops an **AI** — an actor — as against a player.
 *
 * Read from the same decoded `blocks` list: a group naming `ai` does, whether or
 * not it stops a player (`collides: false` is "stops no player", and the map's
 * AI-only clip is written that way), and what stops a bullet stops everyone. A
 * player-only clip (`blocks: player`, no `ai`) does not: CoD's AI walks through
 * it. docs/engine/collision.md, "Channels".
 */
export function blocksAi(mesh: THREE.Object3D): boolean {
  if (blocksShots(mesh)) {
    return true;
  }
  const blocks: unknown = mesh.userData.clipBlocks;
  return Array.isArray(blocks) && blocks.includes("ai");
}
