// Climb view (`M`): draws the mantle volumes and ladders a world lets you
// climb, which nothing else in the scene can show you — a mantle volume is not a
// collider at all, and a ladder's collider looks like any other clip brush
// (docs/engine/player.md#mantling, #ladders).
//
// For mantles, two things are drawn, and the second is the useful one:
//
//   every volume   a wireframe box, coloured by the kind the source map named
//                  (`onto`, `over`, or unnamed — which most Black Ops volumes
//                  and a third of Modern Warfare's are).
//   the live one   the volume the player could climb *right now*, highlighted,
//                  with the path the capsule would take and a marker where
//                  they would come down. This asks
//                  `MantleVolumes.find` — the same call `stepMovement` makes —
//                  so it cannot disagree with what actually happens when you
//                  press jump. That is what makes it worth having: a volume you
//                  are standing in that stays unhighlighted is the answer to
//                  "why did that not climb?".
//
// A volume's **top face is the surface you land on**, so the top edges are drawn
// brighter than the rest: a box whose bright edge does not sit on the ledge is a
// map that breaks the convention the exporter assumes.
//
// Ladders get the same pair: every ladder as an orange box, with its one
// climbable side bright where the map names one, and the side the grab check's
// probe meets from where you stand (`ladderAhead`, the simulation's own call)
// highlighted with the box.

import * as THREE from "three";
import type { ResolvedLadder, ResolvedMantle } from "@3d/shared/dsl/resolved.js";
import { LadderVolumes, type LadderHit } from "@3d/shared/sim/ladder.js";
import { MantleVolumes, type MantleTarget } from "@3d/shared/sim/mantle.js";
import type { CapsuleWorld, Vec3 } from "@3d/shared/sim/capsule.js";
import { HEIGHT, RADIUS, type MovementState } from "@3d/shared/sim/movement.js";
import { ladderAhead } from "@3d/shared/sim/ladder.js";

/** The 12 edges of a box as index pairs into the 8 corners `corners` produces. */
const BOX_EDGES: readonly [number, number][] = [
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0], // bottom face
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4], // top face — the surface you land on
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7], // the struts between them
];

/** Which of BOX_EDGES are the top face, drawn brighter because that is the landing surface. */
const TOP_EDGES = new Set([4, 5, 6, 7]);

/** A volume's colour by what the map called it. Unnamed is the common case, not an error, so it is not red. */
const KIND_COLOUR: Record<string, THREE.Color> = {
  onto: new THREE.Color(0x4fd1ff),
  over: new THREE.Color(0xffd54f),
  unnamed: new THREE.Color(0x9aa5b1),
};

/** A ladder, whichever side can be climbed. */
const LADDER_COLOUR = new THREE.Color(0xff9e57);

/** A ladder's named side, as indices into BOX_EDGES: the four edges of that face (see `corners`' order). */
const FACE_EDGES: Record<NonNullable<ResolvedLadder["face"]>, ReadonlySet<number>> = {
  front: new Set([0, 4, 8, 9]),
  back: new Set([2, 6, 10, 11]),
  left: new Set([3, 7, 8, 10]),
  right: new Set([1, 5, 9, 11]),
};

/** The volume the player can climb right now. */
const LIVE_COLOUR = new THREE.Color(0x5cff9d);
/** Vertices the live outline draws: the box's edges, the path's two legs, the landing cross's three arms. */
const LIVE_POINTS = (12 + 2 + 3) * 2;

/** How much darker a volume's non-top edges are drawn. */
const SIDE_DIM = 0.45;

/** The eight corners of one box in world space, in the order BOX_EDGES indexes: bit 0 is +X, bit 1 +Z, bit 2 +Y. */
function corners(volume: Pick<ResolvedMantle, "position" | "yaw" | "size">, into: THREE.Vector3[]): THREE.Vector3[] {
  const { x: hx, y: hy, z: hz } = { x: volume.size.x / 2, y: volume.size.y / 2, z: volume.size.z / 2 };
  const c = Math.cos(volume.yaw);
  const s = Math.sin(volume.yaw);
  let i = 0;
  for (const dy of [-hy, hy]) {
    for (const dz of [-hz, hz]) {
      for (const dx of [-hx, hx]) {
        // Out of the box's own frame: rotateY by +yaw, as the exporter's `box_at`
        // does and as `ResolvedMantle` documents.
        into[i]!.set(volume.position.x + dx * c + dz * s, volume.position.y + dy, volume.position.z - dx * s + dz * c);
        i++;
      }
    }
  }
  return into;
}

export class MantleView {
  /** Every volume, one draw call. Vertex-coloured, so kinds and the top face differ without a material each. */
  readonly object = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 }));

  /** The live volume, its path and its landing marker, rewritten in place each frame one is found. */
  readonly liveObject = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(LIVE_POINTS * 3), 3)),
    // Drawn through walls: the point is to see the volume you are pressed against.
    new THREE.LineBasicMaterial({ color: LIVE_COLOUR, transparent: true, opacity: 0.95, depthTest: false }),
  );

  /** The ladder the probe meets, rewritten in place each frame one is found. */
  readonly ladderObject = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(BOX_EDGES.length * 2 * 3), 3)),
    new THREE.LineBasicMaterial({ color: LIVE_COLOUR, transparent: true, opacity: 0.95, depthTest: false }),
  );

  private volumes: readonly ResolvedMantle[] = [];
  private query = new MantleVolumes([]);
  private ladders = new LadderVolumes([]);
  private shown = false;
  /** What `update` last found, so the stats readout reads it rather than querying again. */
  private live: MantleTarget | null = null;
  private liveLadder: LadderHit | null = null;

  /** Scratch, so a per-frame update allocates nothing. */
  private readonly scratch = Array.from({ length: 8 }, () => new THREE.Vector3());

  constructor() {
    for (const object of [this.object, this.liveObject, this.ladderObject]) {
      object.visible = false;
      object.frustumCulled = false; // one object spanning the whole world
      object.renderOrder = 998;
    }
    this.object.name = "mantle-view";
    this.liveObject.name = "mantle-view-live";
    this.ladderObject.name = "mantle-view-ladder";
  }

  get count(): number {
    return this.volumes.length;
  }

  get ladderCount(): number {
    return this.ladders.count;
  }

  /** The ladder side the grab check meets from where the player was at the last `update`, or null. */
  get ladderAhead(): LadderHit | null {
    return this.liveLadder;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** The climb available where the player was standing at the last `update`, or null. */
  get liveClimb(): MantleTarget | null {
    return this.live;
  }

  /** How many volumes name a kind: all-unnamed is expected on Black Ops and suspicious on Modern Warfare. */
  get namedCount(): number {
    return this.volumes.filter((v) => v.kind).length;
  }

  /** Take a world's volumes and ladders. Cheap enough to redo on every load; there are ~70 in an imported map. */
  build(volumes: readonly ResolvedMantle[], ladders: readonly ResolvedLadder[] = []): void {
    this.volumes = volumes;
    this.query = new MantleVolumes(volumes);
    this.ladders = new LadderVolumes(ladders);
    this.live = null;
    this.liveLadder = null;
    this.liveObject.visible = false;
    this.ladderObject.visible = false;

    const boxes = [
      ...volumes.map((volume) => ({ box: volume, colour: KIND_COLOUR[volume.kind ?? "unnamed"] ?? KIND_COLOUR.unnamed!, bright: TOP_EDGES })),
      // Without a named side every side is climbable, so the whole box is bright.
      ...ladders.map((ladder) => ({ box: ladder, colour: LADDER_COLOUR, bright: ladder.face ? FACE_EDGES[ladder.face] : undefined })),
    ];
    const positions = new Float32Array(boxes.length * BOX_EDGES.length * 6);
    const colours = new Float32Array(boxes.length * BOX_EDGES.length * 6);
    let at = 0;
    for (const { box: volume, colour: base, bright } of boxes) {
      const box = corners(volume, this.scratch);
      for (let e = 0; e < BOX_EDGES.length; e++) {
        const [a, b] = BOX_EDGES[e]!;
        const dim = !bright || bright.has(e) ? 1 : SIDE_DIM;
        for (const corner of [box[a]!, box[b]!]) {
          positions[at] = corner.x;
          positions[at + 1] = corner.y;
          positions[at + 2] = corner.z;
          colours[at] = base.r * dim;
          colours[at + 1] = base.g * dim;
          colours[at + 2] = base.b * dim;
          at += 3;
        }
      }
    }
    this.object.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    this.object.geometry = geometry;
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    this.object.visible = visible;
    this.liveObject.visible = visible && this.live !== null;
    this.ladderObject.visible = visible && this.liveLadder !== null;
  }

  /**
   * Refresh the live outline from where the player is standing and looking.
   *
   * Asks the same `find` the simulation asks, with the same body and the same
   * collision, so what lights up is exactly what a jump would climb.
   */
  update(movement: Readonly<MovementState>, world: CapsuleWorld): MantleTarget | null {
    if (!this.shown) {
      this.live = null;
      this.liveLadder = null;
      return null;
    }
    this.liveLadder = ladderAhead(movement, this.ladders);
    this.ladderObject.visible = this.liveLadder !== null;
    if (this.liveLadder) {
      const box = corners(this.liveLadder.ladder, this.scratch);
      const position = this.ladderObject.geometry.getAttribute("position") as THREE.BufferAttribute;
      const array = position.array as Float32Array;
      BOX_EDGES.forEach(([a, b], e) => {
        array.set([box[a]!.x, box[a]!.y, box[a]!.z, box[b]!.x, box[b]!.y, box[b]!.z], e * 6);
      });
      position.needsUpdate = true;
    }
    const found = this.query.find(movement.feet, movement.yaw, { radius: RADIUS, height: HEIGHT }, world);
    // Redrawn every frame it is found: the path starts at the player's feet,
    // and the face — so the landing — changes as they walk round the volume.
    this.live = found;
    this.liveObject.visible = found !== null;
    if (found) {
      this.drawLive(found, movement.feet);
    }
    return found;
  }

  /** The live volume's box, the climb's two legs, and a cross where the player would come down. */
  private drawLive(found: MantleTarget, from: Readonly<Vec3>): void {
    const box = corners(found.volume, this.scratch);
    const points: number[] = [];
    for (const [a, b] of BOX_EDGES) {
      points.push(box[a]!.x, box[a]!.y, box[a]!.z, box[b]!.x, box[b]!.y, box[b]!.z);
    }
    // Up, then across: what `advanceMantle` moves along and `find` checked clear.
    const { x: tx, y: ty, z: tz } = found.feet;
    points.push(from.x, from.y, from.z, from.x, ty, from.z, from.x, ty, from.z, tx, ty, tz);
    // A cross at the landing, at the feet height the climb ends on: where the
    // player will actually be standing, which is the half of a mantle that no
    // amount of looking at the box tells you.
    const r = RADIUS;
    points.push(tx - r, ty, tz, tx + r, ty, tz, tx, ty, tz - r, tx, ty, tz + r, tx, ty, tz, tx, ty + 0.25, tz);

    const position = this.liveObject.geometry.getAttribute("position") as THREE.BufferAttribute;
    (position.array as Float32Array).set(points);
    position.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.liveObject.geometry.dispose();
    this.ladderObject.geometry.dispose();
  }
}
