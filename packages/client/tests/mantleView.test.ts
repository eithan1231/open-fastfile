// The mantle wireframe (src/engine/mantleView.ts).
//
// A mantle volume has no geometry in the scene, so this view builds its boxes
// from `ResolvedMantle` numbers alone. What it has to get right is the same
// thing the exporter and the resolver have to agree on: a turned box goes out of
// its own frame by rotateY(+yaw). Get that sign wrong and every volume with a
// yaw is drawn mirrored about its own centre — still a plausible box, in the
// wrong place, which is exactly the class of bug a debug view must not have.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { MantleView } from "../src/engine/mantleView.js";
import { CollisionWorld } from "@3d/shared/collision/world.js";
import { MantleVolumes } from "@3d/shared/sim/mantle.js";
import { createMovement, HEIGHT, RADIUS } from "@3d/shared/sim/movement.js";
import type { ResolvedLadder, ResolvedMantle } from "@3d/shared/dsl/resolved.js";

function volume(over: Partial<ResolvedMantle> = {}): ResolvedMantle {
  return {
    id: 1,
    tags: [],
    position: { x: 0, y: 0.5, z: 0 },
    yaw: 0,
    size: { x: 3, y: 1, z: 0.4 },
    ...over,
  };
}

/** A floor, and the 20 cm rail `volume()` encloses: something for a live climb to land on. */
function railWorld(): CollisionWorld {
  const root = new THREE.Group();
  const boxes: [[number, number, number], [number, number, number]][] = [
    [
      [10, 1, 10],
      [0, -0.5, 0],
    ],
    [
      [3, 1, 0.2],
      [0, 0.5, 0],
    ],
  ];
  for (const [size, at] of boxes) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.set(...at);
    mesh.userData.collide = true;
    root.add(mesh);
  }
  const world = new CollisionWorld();
  world.rebuild(root);
  return world;
}

const BODY = { radius: RADIUS, height: HEIGHT };

/** Every vertex the main wireframe drew, as Vector3s. */
function vertices(view: MantleView): THREE.Vector3[] {
  const position = view.object.geometry.getAttribute("position");
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    out.push(new THREE.Vector3().fromBufferAttribute(position as THREE.BufferAttribute, i));
  }
  return out;
}

describe("MantleView", () => {
  it("draws twelve edges per volume", () => {
    const view = new MantleView();
    view.build([volume(), volume({ id: 2 })]);
    expect(vertices(view)).toHaveLength(2 * 12 * 2);
    expect(view.count).toBe(2);
  });

  it("puts an unturned box exactly on the volume's bounds", () => {
    const view = new MantleView();
    view.build([volume({ position: { x: 4, y: 2, z: -6 }, size: { x: 2, y: 1, z: 0.5 } })]);
    const box = new THREE.Box3().setFromPoints(vertices(view));
    expect(box.min.x).toBeCloseTo(3, 6);
    expect(box.max.x).toBeCloseTo(5, 6);
    expect(box.min.y).toBeCloseTo(1.5, 6);
    expect(box.max.y).toBeCloseTo(2.5, 6);
    expect(box.min.z).toBeCloseTo(-6.25, 6);
    expect(box.max.z).toBeCloseTo(-5.75, 6);
  });

  it("turns a box the way the resolver and the exporter do, not its mirror", () => {
    // The corners of a yaw-turned slab must land where rotateY(+yaw) puts them.
    // A sign error still gives a box of the right size, reflected about z.
    const yaw = Math.PI / 6;
    const view = new MantleView();
    view.build([volume({ position: { x: 0, y: 0.5, z: 0 }, size: { x: 4, y: 1, z: 0 }, yaw })]);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // The +x end of the slab, out of the box's frame: (2c, ., -2s).
    const expected = new THREE.Vector3(2 * c, 0, -2 * s);
    const found = vertices(view).some((v) => Math.abs(v.x - expected.x) < 1e-6 && Math.abs(v.z - expected.z) < 1e-6);
    expect(found).toBe(true);
    // And the mirror is NOT drawn.
    const mirrored = vertices(view).some((v) => Math.abs(v.x - 2 * c) < 1e-6 && Math.abs(v.z - 2 * s) < 1e-6);
    expect(mirrored).toBe(false);
  });

  it("agrees with the simulation about which volume is live", () => {
    // The view's whole value is that it asks the same question `stepMovement`
    // does. If the two ever diverged, a box would light up that a jump refuses.
    const volumes = [volume()];
    const view = new MantleView();
    view.build(volumes);
    view.setVisible(true);
    const query = new MantleVolumes(volumes);
    const world = railWorld();

    // Standing on the -Z side, looking across the slab at +Z (yaw 0 faces -Z).
    const state = createMovement({ x: 0, y: 0, z: -0.4 }, Math.PI, 0);
    expect(view.update(state, world)).not.toBeNull();
    expect(view.liveClimb).toEqual(query.find(state.feet, state.yaw, BODY, world));
    expect(view.liveObject.visible).toBe(true);

    // Turned away: the simulation refuses it, so the view must stop drawing it.
    const away = createMovement({ x: 0, y: 0, z: -0.4 }, 0, 0);
    expect(view.update(away, world)).toBeNull();
    expect(query.find(away.feet, away.yaw, BODY, world)).toBeNull();
    expect(view.liveObject.visible).toBe(false);
  });

  it("draws the path a climb would take: up from the feet, then across to the landing", () => {
    const view = new MantleView();
    view.build([volume()]);
    view.setVisible(true);
    const state = createMovement({ x: 0, y: 0, z: -0.4 }, Math.PI, 0);
    const found = view.update(state, railWorld())!;
    const position = view.liveObject.geometry.getAttribute("position") as THREE.BufferAttribute;
    const at = (i: number) => new THREE.Vector3().fromBufferAttribute(position, i);
    // After the box's 24 vertices: feet → corner, corner → landing.
    expect(at(24).toArray()).toEqual([0, 0, expect.closeTo(-0.4, 5)]);
    expect(at(25).y).toBeCloseTo(found.feet.y, 5);
    expect(at(25).z).toBeCloseTo(-0.4, 5);
    expect(at(27).z).toBeCloseTo(found.feet.z, 5);
  });

  it("reports no live climb while hidden, so the readout cannot go stale", () => {
    const view = new MantleView();
    view.build([volume()]);
    view.setVisible(true);
    view.update(createMovement({ x: 0, y: 0, z: -0.4 }, Math.PI, 0), railWorld());
    expect(view.liveClimb).not.toBeNull();
    view.setVisible(false);
    view.update(createMovement({ x: 0, y: 0, z: -0.4 }, Math.PI, 0), railWorld());
    expect(view.liveClimb).toBeNull();
  });

  it("counts the volumes that name a kind", () => {
    const view = new MantleView();
    view.build([volume({ id: 1, kind: "onto" }), volume({ id: 2, kind: "over" }), volume({ id: 3 })]);
    expect(view.count).toBe(3);
    expect(view.namedCount).toBe(2);
  });

  it("starts hidden, and a world with none draws nothing", () => {
    const view = new MantleView();
    expect(view.visible).toBe(false);
    view.build([]);
    view.setVisible(true);
    expect(vertices(view)).toHaveLength(0);
    expect(view.update(createMovement({ x: 0, y: 0, z: 0 }, 0, 0), railWorld())).toBeNull();
    expect(view.liveObject.visible).toBe(false);
  });

  describe("ladders", () => {
    const ladder: ResolvedLadder = { id: 3, tags: [], position: { x: 0, y: 1.5, z: -2 }, yaw: 0, size: { x: 0.8, y: 3, z: 0.2 }, face: "back" };

    /** The colour of every vertex, as [r, g, b]. */
    function colours(view: MantleView): number[][] {
      const colour = view.object.geometry.getAttribute("color");
      return Array.from({ length: colour.count }, (_, i) => [colour.getX(i), colour.getY(i), colour.getZ(i)]);
    }

    it("draws them beside the volumes, with a named side's edges the brightest", () => {
      const view = new MantleView();
      view.build([volume()], [ladder]);
      expect(view.ladderCount).toBe(1);
      const points = vertices(view).slice(24);
      const tints = colours(view).slice(24);
      expect(points).toHaveLength(24);
      // The back side is local +Z: its edges are the bright ones, and all at z = -1.9.
      const bright = Math.max(...tints.map((c) => c[0]!));
      points.forEach((point, i) => {
        if (tints[i]![0] === bright && tints[i + (i % 2 ? -1 : 1)]![0] === bright) {
          expect(point.z).toBeCloseTo(-1.9, 6);
        }
      });
    });

    it("highlights the ladder the grab check would meet, and nothing looking away", () => {
      const view = new MantleView();
      view.build([], [ladder]);
      view.setVisible(true);
      const world = railWorld();
      view.update(createMovement({ x: 0, y: 0, z: -1.5 }, 0, 0), world);
      expect(view.ladderAhead?.ladder).toBe(ladder);
      expect(view.ladderObject.visible).toBe(true);
      view.update(createMovement({ x: 0, y: 0, z: -1.5 }, Math.PI, 0), world);
      expect(view.ladderAhead).toBeNull();
      expect(view.ladderObject.visible).toBe(false);
    });
  });
});
