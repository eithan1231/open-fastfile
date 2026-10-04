// Hit box view (`B`): the volumes a bullet is actually traced against, drawn on
// the peer they belong to — one wireframe box per bone, coloured by the location
// a hit on it counts as (docs/engine/collision.md#a-bullet-hits-a-bone-not-a-capsule).
//
// Nothing else can show these. A player is *moved* as a capsule and *shot* as a
// skeleton, so the collider view draws the capsule and the hit volumes are
// invisible — which is how a head box a fifth of a metre from a head goes
// unnoticed.
//
// **The boxes are read off the rig that was just posed, never posed again here.**
// `net/remotePlayers.ts` interpolates a peer to the moment it is drawn at and
// updates its matrices; this takes each bone's `matrixWorld` as it stands. A view
// that re-derived a pose of its own would be a view of a different body, and so
// worse than none — the same argument that keeps `MantleVolumes.find` in
// `engine/mantleView.ts`.
//
// A box is in its bone's own space and **in inches**: a CoD body hangs from a
// `unit-scale` root of 0.0254, and the bone's world matrix carries that scale. So
// the corners are transformed and nothing is converted — converting to metres
// here would shrink every box by forty, which looks like tidying up.

import * as THREE from "three";
import { castFilePath } from "@3d/shared/protocol/routes/catalog.js";
import { readHitboxes, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import type { HitLocation } from "@3d/shared/sim/hitLocations.js";
import type { CharacterRig } from "../scene/character.js";

/** A peer as it was just drawn. The rig, posed, with its world matrices current. */
export interface PosedBody {
  rig: CharacterRig;
}

/**
 * Where a sidecar is fetched from: the session's `AssetStore`, narrowed to the one
 * call made of it, so a debug view holds no handle on the store itself. The store
 * keys it by URL like every other asset, which is what frees it with the world.
 */
export interface SidecarSource {
  json(url: string): Promise<unknown>;
}

/** The 12 edges of a box, as index pairs into the 8 corners `corners` fills: bit 0 is +X, bit 1 +Y, bit 2 +Z. */
const BOX_EDGES: readonly [number, number][] = [
  [0, 1],
  [1, 5],
  [5, 4],
  [4, 0], // the bottom face
  [2, 3],
  [3, 7],
  [7, 6],
  [6, 2], // the top face
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7], // the struts between them
];

/**
 * A box's colour by what a hit on it counts as.
 *
 * Grouped, not nineteen colours: the question in front of a body is "is that the
 * head, the chest or an arm?", and a left forearm told apart from a right one by
 * hue is a legend nobody reads. The head and the helmet are the one pair given a
 * colour of their own — hot pink against everything else's blues, yellows and
 * greens — because the head box is the one people open this to check.
 */
const LOCATION_COLOUR: Readonly<Record<HitLocation, number>> = {
  head: 0xff2d6f,
  helmet: 0xff8fb4,
  neck: 0xff8a3d,
  torsoUpper: 0x4fd1ff,
  torsoLower: 0x2f8fd0,
  rightArmUpper: 0xffd54f,
  rightArmLower: 0xffd54f,
  rightHand: 0xffee8f,
  leftArmUpper: 0xffd54f,
  leftArmLower: 0xffd54f,
  leftHand: 0xffee8f,
  rightLegUpper: 0x5cff9d,
  rightLegLower: 0x5cff9d,
  rightFoot: 0xa6ffcb,
  leftLegUpper: 0x5cff9d,
  leftLegLower: 0x5cff9d,
  leftFoot: 0xa6ffcb,
  gun: 0x9aa5b1,
  none: 0x9aa5b1,
};

/** One box and the bone it hangs off, matched by name once per rig. */
interface Bound {
  box: Hitbox;
  bone: THREE.Object3D;
}

/**
 * Where a body's sidecar lives: beside its `.glb`, inside the same catalogue
 * entry, so it goes through the same `castFilePath` the body itself did and the
 * store holds one spelling of each. `rig.name` is the entry's id —
 * `WorldSession` builds the kit with the cast character's id as the name — and
 * `rig.set.game` is the catalogue branch that cast came out of.
 */
export function hitboxUrl(rig: CharacterRig): string {
  return castFilePath({ kind: "characters", game: rig.set.game, id: rig.name, file: `${rig.name}.hitboxes.json` });
}

export class HitboxView {
  /** Every box on every peer, one draw call. Vertex-coloured, so a location costs no material. */
  readonly object = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    // Through walls, and through the body itself: a box derived from a limb's own
    // vertices sits within a millimetre of the skin, so depth-testing it against
    // the body it describes would hide most of what this is for.
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }),
  );

  private shown = false;
  /** A body's boxes by sidecar URL: `null` where it could not be read, absent while it is in flight. */
  private readonly boxes = new Map<string, Hitbox[] | null>();
  private readonly pending = new Set<string>();
  /** Bound once per rig: a name lookup over ~124 bones, for ~25 boxes, is not a per-frame cost. */
  private readonly bound = new WeakMap<CharacterRig, Bound[]>();

  /** Vertices the geometry has room for, and what the last update filled. */
  private capacity = 0;
  private drawn = 0;
  private bodies = 0;
  /** Scratch for one update, so a per-frame pass allocates nothing. */
  private readonly drawing: Bound[] = [];
  private readonly corner = new THREE.Vector3();
  private readonly colour = new THREE.Color();

  constructor() {
    this.object.name = "hitbox-view";
    this.object.visible = false;
    this.object.frustumCulled = false; // it follows bodies that move every frame
    this.object.renderOrder = 999;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** How many boxes the last update drew, and on how many bodies. For the stats readout. */
  get counts(): { boxes: number; bodies: number } {
    return { boxes: this.drawn, bodies: this.bodies };
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    this.object.visible = visible;
    if (!visible) {
      this.drawn = 0;
      this.bodies = 0;
    }
  }

  /** Forget what was read for the world being left: its sidecars belong to that session's store. */
  clear(): void {
    this.boxes.clear();
    this.pending.clear();
    this.drawn = 0;
    this.bodies = 0;
    this.object.geometry.setDrawRange(0, 0);
  }

  /**
   * Redraw every peer's boxes from the pose they are standing in right now.
   *
   * A sidecar is fetched the first time a body is seen **with the view open**, so a
   * view nobody pressed `B` for costs nothing; the body is simply drawn without
   * boxes until its sidecar lands, which is a frame or two.
   */
  update(bodies: readonly PosedBody[], sidecars: SidecarSource | undefined): void {
    if (!this.shown) {
      return;
    }
    this.drawing.length = 0;
    this.bodies = 0;
    for (const { rig } of bodies) {
      const url = hitboxUrl(rig);
      const boxes = this.boxes.get(url);
      if (boxes === undefined) {
        if (sidecars) {
          this.request(url, sidecars);
        }
        continue;
      }
      if (boxes === null) {
        continue;
      }
      const bound = this.bind(rig, boxes);
      this.bodies += bound.length > 0 ? 1 : 0;
      for (const one of bound) {
        this.drawing.push(one);
      }
    }
    this.fill();
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
  }

  /**
   * Read the sidecar once. A missing or unparseable one is remembered as `null` and
   * warned about once — a debug view must never be able to take a frame down, and
   * retrying it every frame would be a fetch per frame forever.
   */
  private request(url: string, sidecars: SidecarSource): void {
    if (this.pending.has(url)) {
      return;
    }
    this.pending.add(url);
    void Promise.resolve()
      .then(() => sidecars.json(url))
      .then(readHitboxes)
      .then(
        (boxes) => {
          this.boxes.set(url, boxes);
        },
        (e: unknown) => {
          this.boxes.set(url, null);
          console.warn(`[hitboxes] ${url}: ${e instanceof Error ? e.message : String(e)}; this body is drawn without boxes`);
        },
      )
      .finally(() => this.pending.delete(url));
  }

  /** A box naming a bone this body does not have is dropped, as `BoundHitboxes` drops it: bodies differ in their cloth joints. */
  private bind(rig: CharacterRig, boxes: readonly Hitbox[]): Bound[] {
    let bound = this.bound.get(rig);
    if (bound) {
      return bound;
    }
    const bones = new Map<string, THREE.Object3D>();
    rig.root.traverse((node) => {
      if (node.name) {
        bones.set(node.name, node);
      }
    });
    bound = [];
    for (const box of boxes) {
      const bone = bones.get(box.bone);
      if (bone) {
        bound.push({ box, bone });
      }
    }
    this.bound.set(rig, bound);
    return bound;
  }

  /** Write this frame's boxes into the buffer, growing it if more bodies have arrived. */
  private fill(): void {
    this.ensure(this.drawing.length);
    const geometry = this.object.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const colour = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
    this.drawn = this.drawing.length;
    if (!position || !colour) {
      return; // nothing to draw yet, so nothing was allocated
    }
    const points = position.array as Float32Array;
    const colours = colour.array as Float32Array;
    let at = 0;
    for (const { box, bone } of this.drawing) {
      this.colour.setHex(LOCATION_COLOUR[box.location]).convertSRGBToLinear();
      for (const [a, b] of BOX_EDGES) {
        for (const index of [a, b]) {
          // The bone's own matrix, as the pose left it: it carries the rig's
          // 0.0254 unit-scale, which is what turns the box's inches into metres.
          this.corner
            .set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z)
            .applyMatrix4(bone.matrixWorld);
          points[at] = this.corner.x;
          points[at + 1] = this.corner.y;
          points[at + 2] = this.corner.z;
          colours[at] = this.colour.r;
          colours[at + 1] = this.colour.g;
          colours[at + 2] = this.colour.b;
          at += 3;
        }
      }
    }
    position.needsUpdate = true;
    colour.needsUpdate = true;
    geometry.setDrawRange(0, this.drawing.length * BOX_EDGES.length * 2);
  }

  private ensure(boxes: number): void {
    const vertices = boxes * BOX_EDGES.length * 2;
    if (vertices <= this.capacity) {
      return;
    }
    // Doubling, because a body joining mid-frame must not reallocate per box.
    const size = Math.max(vertices, this.capacity * 2);
    this.object.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(size * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(size * 3), 3));
    this.object.geometry = geometry;
    this.capacity = size;
  }
}
