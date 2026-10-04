// The hit box wireframe (src/engine/hitboxView.ts).
//
// What it has to get right is one thing: a box is in its bone's own space, in
// inches, and the *bone's* world matrix is what puts it in the world. So the rig
// every case here runs against has bones that are **not** at the origin, a pose
// that is **not** the identity, and the 0.0254 unit-scale a CoD body hangs from —
// a fixture with either of the first two missing would pass with the transform
// left out entirely, which is the bug this view must not be allowed to have.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { HITBOX_FORMAT_VERSION } from "@3d/shared/rig/hitboxes.js";
import { bindPoseOf } from "@3d/shared/rig/character.js";
import type { CharacterSet } from "../src/scene/character.js";
import { HitboxView, hitboxUrl, type PosedBody, type SidecarSource } from "../src/engine/hitboxView.js";

const INCH = 0.0254;

/** The clip table a rig carries; only `game` is read here, and it is what names the catalogue branch. */
function set(game = "iw5"): CharacterSet {
  return { game, weapon: "", animType: "", roles: { idle: "idle" }, torsoRoles: [], aimJoint: "", clips: {} };
}

/**
 * A rig posed the way a peer actually is: the root turned a quarter and moved off
 * the origin, a spine bone up the body, and a head bone out along the spine's own
 * +X and turned a quarter about Z of its own.
 *
 * Every step matters to the assertions below. The root's yaw is what catches a
 * transform that keeps only the translation; the spine's offset is what catches
 * one that uses the rig root instead of the bone; the head's own rotation is what
 * catches one that drops the bone's rotation; and the scale is what catches
 * inches read as metres.
 */
function rig(name = "mp_body_sas_urban_assault") {
  const root = new THREE.Object3D();
  root.position.set(10, 2, -5);
  root.rotation.y = Math.PI / 2;
  root.scale.setScalar(INCH);

  const spine = new THREE.Bone();
  spine.name = "j_spine4";
  spine.position.set(0, 40, 0);
  root.add(spine);

  const head = new THREE.Bone();
  head.name = "j_head";
  head.position.set(20, 0, 0);
  head.rotation.z = Math.PI / 2;
  spine.add(head);

  root.updateMatrixWorld(true);
  return { name, root, aim: undefined, clips: new Map(), bind: bindPoseOf(root), set: set() };
}

/** A sidecar as `scripts.cod hitboxes` writes it. */
function sidecar(bones: { bone: string; location: string; min: number[]; max: number[] }[]): unknown {
  return { version: HITBOX_FORMAT_VERSION, bones };
}

/** A box on `j_head` four inches long down its own +X, one inch either side of it otherwise. */
const HEAD_BOX = { bone: "j_head", location: "head", min: [-1, -1, -1], max: [7, 1, 1] };

function source(json: (url: string) => Promise<unknown>): SidecarSource & { json: ReturnType<typeof vi.fn> } {
  return { json: vi.fn(json) };
}

/** Drive the view until its sidecar fetch has settled: one update to ask, a tick, one to draw. */
async function draw(view: HitboxView, bodies: PosedBody[], sidecars: SidecarSource): Promise<void> {
  view.update(bodies, sidecars);
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.update(bodies, sidecars);
}

/** The world-space corners the view actually wrote, as a box. */
function drawnBounds(view: HitboxView): THREE.Box3 {
  const geometry = view.object.geometry;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const count = geometry.drawRange.count;
  expect(count).toBeGreaterThan(0);
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    box.expandByPoint(point.fromBufferAttribute(position, i));
  }
  return box;
}

describe("hit box view", () => {
  it("draws a box through its bone's world matrix, not the rig's and not unscaled", async () => {
    const view = new HitboxView();
    view.setVisible(true);
    const one = rig();
    await draw(
      view,
      [{ rig: one }],
      source(() => Promise.resolve(sidecar([HEAD_BOX]))),
    );

    // Worked through by hand from the chain in `rig()`, because agreeing with the
    // view's own maths would only prove it agrees with itself.
    //
    // j_head sits at root · (0,40,0) + (20,0,0) inches. Ry(90°) sends (x,y,z) to
    // (z,y,-x), so (0.508, 1.016, 0) m becomes (0, 1.016, -0.508): the bone is at
    // (10, 3.016, -5.508).
    //
    // The box spans -1..7 along the bone's own +X. Rz(90°) sends the bone's X to
    // the spine's +Y, which Ry leaves alone — so the long axis comes out along
    // **world Y**, centred 3 inches up from the bone. Its other two axes are one
    // inch either side.
    const bounds = drawnBounds(view);
    const centre = bounds.getCenter(new THREE.Vector3());
    expect(centre.x).toBeCloseTo(10, 6);
    expect(centre.y).toBeCloseTo(3.016 + 3 * INCH, 6);
    expect(centre.z).toBeCloseTo(-5.508, 6);

    const size = bounds.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(2 * INCH, 6);
    expect(size.y).toBeCloseTo(8 * INCH, 6);
    expect(size.z).toBeCloseTo(2 * INCH, 6);
    view.dispose();
  });

  it("follows the pose it is handed: a bone that turns takes its box with it", async () => {
    const view = new HitboxView();
    view.setVisible(true);
    const one = rig();
    const sidecars = source(() => Promise.resolve(sidecar([HEAD_BOX])));
    await draw(view, [{ rig: one }], sidecars);
    const before = drawnBounds(view);

    // The head turns back to level, as a pose would turn it between two frames.
    // Nothing else moves, and nothing is refetched.
    const head = one.root.getObjectByName("j_head")!;
    head.rotation.z = 0;
    one.root.updateMatrixWorld(true);
    view.update([{ rig: one }], sidecars);
    const after = drawnBounds(view);

    // The long axis was world Y; with the bone level it is the spine's +X, which
    // Ry(90°) sends to world -Z.
    expect(after.getSize(new THREE.Vector3()).y).toBeCloseTo(2 * INCH, 6);
    expect(after.getSize(new THREE.Vector3()).z).toBeCloseTo(8 * INCH, 6);
    expect(after.getCenter(new THREE.Vector3()).z).toBeCloseTo(-5.508 - 3 * INCH, 6);
    expect(before.equals(after)).toBe(false);
    expect(sidecars.json).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("fetches nothing until it is switched on, and once per body after that", async () => {
    const view = new HitboxView();
    const one = rig();
    const sidecars = source(() => Promise.resolve(sidecar([HEAD_BOX])));

    view.update([{ rig: one }], sidecars);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sidecars.json).not.toHaveBeenCalled();
    expect(view.counts).toEqual({ boxes: 0, bodies: 0 });

    view.setVisible(true);
    await draw(view, [{ rig: one }], sidecars);
    view.update([{ rig: one }], sidecars);
    expect(sidecars.json).toHaveBeenCalledTimes(1);
    expect(sidecars.json).toHaveBeenCalledWith(hitboxUrl(one));
    view.dispose();
  });

  it("asks for the sidecar beside the body's own file, in the same catalogue entry", () => {
    expect(hitboxUrl(rig("mp_body_sas_urban_assault"))).toBe("/api/catalog/characters/iw5/mp_body_sas_urban_assault/mp_body_sas_urban_assault.hitboxes.json");
  });

  it("draws nothing and warns rather than throwing when a sidecar will not read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = new HitboxView();
    view.setVisible(true);
    const one = rig();

    // Both the ways it fails: a store that could not fetch it resolves undefined,
    // and a file of the wrong shape parses and then refuses.
    const missing = source(() => Promise.resolve(undefined));
    await draw(view, [{ rig: one }], missing);
    expect(view.counts).toEqual({ boxes: 0, bodies: 0 });

    const wrong = source(() => Promise.resolve({ version: 99, bones: [] }));
    const other = rig("mp_body_delta_elite_assault_aa");
    await draw(view, [{ rig: other }], wrong);
    expect(view.counts).toEqual({ boxes: 0, bodies: 0 });

    expect(warn).toHaveBeenCalledTimes(2);
    // Remembered, not retried: a fetch per frame forever is the other way this fails.
    view.update([{ rig: one }, { rig: other }], missing);
    expect(missing.json).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    view.dispose();
  });

  it("drops a box naming a bone this body does not have, and keeps the rest", async () => {
    const view = new HitboxView();
    view.setVisible(true);
    const one = rig();
    await draw(
      view,
      [{ rig: one }],
      source(() =>
        Promise.resolve(
          sidecar([HEAD_BOX, { bone: "j_coatfront_le", location: "torsoUpper", min: [-1, -1, -1], max: [1, 1, 1] }, { ...HEAD_BOX, bone: "j_spine4" }]),
        ),
      ),
    );
    // Two of the three: the coat joint is one this skeleton has no bone for, which
    // is ordinary — bodies differ in their cloth joints.
    expect(view.counts).toEqual({ boxes: 2, bodies: 1 });
    view.dispose();
  });

  it("gives the head a colour of its own, so it is told apart at a glance", async () => {
    const view = new HitboxView();
    view.setVisible(true);
    const one = rig();
    await draw(
      view,
      [{ rig: one }],
      source(() => Promise.resolve(sidecar([HEAD_BOX, { ...HEAD_BOX, bone: "j_spine4", location: "torsoUpper" }]))),
    );
    const colours = view.object.geometry.getAttribute("color") as THREE.BufferAttribute;
    const head = new THREE.Color().fromBufferAttribute(colours, 0);
    // 24 vertices per box, so the second box's first vertex is index 24.
    const torso = new THREE.Color().fromBufferAttribute(colours, 24);
    expect(head.equals(torso)).toBe(false);
    view.dispose();
  });
});
