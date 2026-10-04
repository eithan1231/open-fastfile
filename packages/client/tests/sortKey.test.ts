import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applySortKey, OPAQUE_SORT_KEY } from "../src/scene/importedMaterials.js";

function mesh(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
}

describe("sortKey — the map's own draw order", () => {
  it("leaves the opaque world alone", () => {
    // Key 1 is 98 of mp_dome's 156 shell materials. They must keep depth
    // writes and three's own front-to-back sort, which is what makes early-z work.
    const m = mesh();
    applySortKey(m, 1);

    expect(m.renderOrder).toBe(0);
    expect((m.material as THREE.MeshStandardMaterial).polygonOffset).toBe(false);
  });

  it("orders overlay tiers the way the game does", () => {
    // A puddle at 15 draws over a stain at 9 draws over the concrete at 1.
    const stain = mesh();
    const puddle = mesh();
    applySortKey(stain, 9);
    applySortKey(puddle, 15);

    expect(stain.renderOrder).toBeLessThan(puddle.renderOrder);
    expect(stain.renderOrder).toBeGreaterThan(0);
  });

  it("separates overlay tiers with depth-buffer units, not with the slope factor", () => {
    // `offset = factor * m + units * r`. Only `units` may scale with the tier:
    // it multiplies one depth-buffer LSB, so it is tiny and view-independent.
    const low = mesh();
    const high = mesh();
    applySortKey(low, OPAQUE_SORT_KEY);
    applySortKey(high, 16);

    const lowMat = low.material as THREE.MeshStandardMaterial;
    const highMat = high.material as THREE.MeshStandardMaterial;
    expect(lowMat.polygonOffset).toBe(true);
    expect(lowMat.polygonOffsetUnits).toBeLessThan(0); // negative pulls toward the camera
    // A higher tier sits further forward, so it clears the tier below it too.
    expect(highMat.polygonOffsetUnits).toBeLessThan(lowMat.polygonOffsetUnits);
  });

  it("never applies a slope term, at any tier", () => {
    // `factor` multiplies the polygon's depth slope, which grows without bound as
    // a surface turns edge-on — so any non-zero value drags a large ground plane
    // toward the camera when viewed along its length, far enough to pass the
    // depth test against a wall in front of it. It buys nothing here anyway:
    // these surfaces are coplanar with the ones they sit on, so they share a
    // slope and a constant bias separates them uniformly.
    for (const key of [OPAQUE_SORT_KEY, 9, 16, 29]) {
      const m = mesh();
      applySortKey(m, key);
      const mat = m.material as THREE.MeshStandardMaterial;
      expect(mat.polygonOffsetFactor, `sortKey ${key}`).toBe(0);
      expect(mat.polygonOffsetUnits, `sortKey ${key}`).toBeLessThan(0);
    }
  });

  it("stops a blended overlay writing depth, so the tier above it still draws", () => {
    const m = mesh();
    (m.material as THREE.MeshStandardMaterial).transparent = true;
    applySortKey(m, 9);

    expect((m.material as THREE.MeshStandardMaterial).depthWrite).toBe(false);
  });

  it("keeps depth writes on an opaque overlay", () => {
    // com_crater_dirt is key 9 but binary-alpha and so opaque; it is still a
    // surface, and dropping its depth writes would let things behind it through.
    const m = mesh();
    applySortKey(m, 9);

    expect((m.material as THREE.MeshStandardMaterial).depthWrite).toBe(true);
  });
});
