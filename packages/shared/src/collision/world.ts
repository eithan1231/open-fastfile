// Capsule-vs-world collision: one BVH over every `userData.collide` mesh, plus
// shared per-asset hull BVHs for props. See docs/engine/collision.md.
//
// A world's removable parts (`solid`) are kept out of the base trees, each in
// trees of its own, and a `view(presence)` answers every query against the base
// plus the parts present *at query time*. The trees are built once per load and
// never rebuilt: a match changes which parts are present, never a tree.

import * as THREE from "three";
import { MeshBVH, StaticGeometryGenerator } from "three-mesh-bvh";
import { HullIndex } from "./hullIndex.js";
import type { HullPlacement } from "./hulls.js";
import type { CapsuleResolution as SimResolution, CapsuleWorld, RayHit, TraceChannel, Vec3 } from "../sim/capsule.js";
import { DEFAULT_SURFACE, type SurfaceType } from "../sim/surfaces.js";
import type { Presence } from "../worlds/presence.js";
import { compactVertices } from "./compact.js";
import { blocksAi, blocksShots } from "./source.js";
import { applyMergedSurfaces, faceSurface, triangleSurfaces } from "./surfaces.js";

/** Below this normal.y (~60° from horizontal), a surface is too steep to stand on: slide along it rather than clearing the penetration straight up. */
const MIN_GROUND_NORMAL_Y = 0.5;

/** One removable part's collision: its own trees, split as the map's are. */
interface PartTrees {
  shots?: MeshBVH;
  clip?: MeshBVH;
  /** What stops an actor and is not in `shots`: built only when `rebuild` is asked for the `ai` channel. */
  ai?: MeshBVH;
  /** World-space bounds of `shots` and `clip`: what a player meets. Undefined for a part only an actor meets. */
  bounds: THREE.Box3 | undefined;
  /** World-space bounds of `shots` and `ai`: what an actor meets. */
  aiBounds: THREE.Box3 | undefined;
}

/**
 * Who a capsule query is for. A player is stopped by what stops a player; an
 * actor (`ai`) by what stops CoD's AI — the same solid world, the clip naming
 * `ai`, and not the clip naming only `player`. A bullet is neither: `traceRay`
 * reads `TraceChannel`. docs/engine/collision.md, "Channels".
 */
export type CollisionChannel = "player" | "ai";

/** What `rebuild` builds beyond the players' trees. */
export interface RebuildOptions {
  /** Build the `ai` channel's trees too: a game server, which runs actors. A client never queries them. */
  ai?: boolean;
}

/**
 * What one query sees. A `CollisionWorld`'s own queries see everything; a view
 * sees the base, the parts its presence has now, and the hulls its mode admits.
 * Order is fixed whatever the mask: base, then parts ascending, then hulls.
 */
export interface QueryMask {
  /** Which capsule trees: a player's, or an actor's. A ray reads its own `TraceChannel` and ignores this. */
  readonly channel: CollisionChannel;
  /** The map's base trees. False only for a view of one part alone. */
  readonly base: boolean;
  part(index: number): boolean;
  hull(modes: readonly string[] | undefined): boolean;
}

const UNMASKED: QueryMask = { channel: "player", base: true, part: () => true, hull: () => true };

/**
 * How deep a capsule may sit in something and still not overlap it, metres. A
 * capsule resting where the resolver left it touches its floor to within float
 * error, and one pushed off several triangles at once keeps a little residue.
 */
const OVERLAP_SKIN = 0.005;

export interface CapsuleResolution {
  /** New feet (bottom-of-capsule) position after resolving penetrations. */
  position: THREE.Vector3;
  /** True if the capsule ended up resting on a roughly-upward-facing surface. */
  grounded: boolean;
}

/** One piece of geometry a BVH was built from, where to draw it, and what each of its triangles is made of. */
export interface DebugSurface {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  /** One surface index per triangle; absent for a prop hull and for a world with no surface data. */
  surfaces?: Uint8Array;
  /** A removable part's trees: its index among the world's solids. */
  part?: number;
}

/** Working vectors reused across calls, to keep the per-frame path allocation-free. No state survives a call. */
interface Scratch {
  segment: THREE.Line3;
  localSegment: THREE.Line3;
  bounds: THREE.Box3;
  localBounds: THREE.Box3;
  triPoint: THREE.Vector3;
  capsulePoint: THREE.Vector3;
  direction: THREE.Vector3;
  normal: THREE.Vector3;
  ray: THREE.Ray;
  rayEnd: THREE.Vector3;
}

export class CollisionWorld {
  private readonly scratch: Scratch = {
    segment: new THREE.Line3(),
    localSegment: new THREE.Line3(),
    bounds: new THREE.Box3(),
    localBounds: new THREE.Box3(),
    triPoint: new THREE.Vector3(),
    capsulePoint: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    ray: new THREE.Ray(),
    rayEnd: new THREE.Vector3(),
  };
  /**
   * What stops a bullet: the `solid` brushes and the visible `soup` shell.
   *
   * The clipmap is split in two rather than merged into one, and that is a
   * measurement rather than a preference. A bullet must not stop at a
   * `clip_player` brush (`blocksShots`), so the two sets have to be separable —
   * and building a *second* tree for shots over the whole clipmap would have cost
   * another 74-94% of it (88k of dome's 118k triangles, 296k of interchange's
   * 394k). Split by what each group stops, the totals are unchanged: every
   * triangle is in exactly one tree.
   *
   * A shot queries this one. A capsule queries both.
   */
  private bvh: MeshBVH | undefined;
  private geometry: THREE.BufferGeometry | undefined;
  /** What stops a player and nothing else: the `clip:` groups with no `solid` bit. */
  private clipBvh: MeshBVH | undefined;
  private clipGeometry: THREE.BufferGeometry | undefined;
  /**
   * What stops an actor and not a bullet: every `clip:` group naming `ai`, the
   * AI-only (`collides: false`) ones included. A second copy of most of `clipBvh`
   * rather than a split of it, so the players' two trees stay exactly what they
   * were. Built only when asked (`RebuildOptions.ai`).
   */
  private aiBvh: MeshBVH | undefined;
  private aiGeometry: THREE.BufferGeometry | undefined;
  /** Whether the last `rebuild` built the `ai` channel. */
  private aiBuilt = false;
  /** The prop hulls, and the grid a query finds them through. */
  private readonly hulls = new HullIndex();
  /** Hulls the last `traceRay` considered. See `traceCandidates`. */
  private candidates = 0;
  /** What the last `groundHit` landed on. Scratch: read it in the same statement, or not at all. */
  private hitSurface: SurfaceType = DEFAULT_SURFACE;
  /** Each solid's trees, by its index in `ResolvedWorld.solids`; undefined for one with no triangles here. */
  private parts: (PartTrees | undefined)[] = [];
  /** The trees one query walks, refilled per query. Never held across a call. */
  private readonly trees: MeshBVH[] = [];

  /**
   * Rebuild the collision mesh from every `userData.collide` mesh under `root`,
   * in two trees: what stops a bullet, and what stops only a player.
   *
   * `parts` names the world's solids in order (`ResolvedSolid.part`). A mesh
   * tagged with one of them (`userData.part`, on it or an ancestor) goes into
   * that part's own trees instead; a part no solid names stays in the base.
   */
  rebuild(root: THREE.Object3D, parts: readonly string[] = [], options: RebuildOptions = {}): void {
    this.disposeTrees();
    root.updateMatrixWorld(true);
    const withAi = options.ai === true;

    const partIndex = new Map(parts.map((part, i) => [part, i]));
    const shots: THREE.Mesh[] = [];
    const clips: THREE.Mesh[] = [];
    const ai: THREE.Mesh[] = [];
    const partMeshes = parts.map(() => ({ shots: [] as THREE.Mesh[], clips: [] as THREE.Mesh[], ai: [] as THREE.Mesh[] }));
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) {
        return;
      }
      // What stops a bullet stops an actor too, so the ai tree takes only the rest.
      const forAi = withAi && blocksAi(obj) && !blocksShots(obj);
      if (!obj.userData.collide && !forAi) {
        return;
      }
      const index = partIndex.get(partTag(obj, root) ?? "");
      const into = index === undefined ? { shots, clips, ai } : partMeshes[index]!;
      if (obj.userData.collide) {
        (blocksShots(obj) ? into.shots : into.clips).push(obj);
      }
      if (forAi) {
        into.ai.push(obj);
      }
    });

    const built = this.build(shots);
    this.geometry = built?.geometry;
    this.bvh = built?.bvh;
    const clipBuilt = this.build(clips);
    this.clipGeometry = clipBuilt?.geometry;
    this.clipBvh = clipBuilt?.bvh;
    const aiBuilt = this.build(ai);
    this.aiGeometry = aiBuilt?.geometry;
    this.aiBvh = aiBuilt?.bvh;
    this.aiBuilt = withAi;

    this.parts = partMeshes.map((meshes) => {
      const partShots = this.build(meshes.shots)?.bvh;
      const partClip = this.build(meshes.clips)?.bvh;
      const partAi = this.build(meshes.ai)?.bvh;
      if (!partShots && !partClip && !partAi) {
        return undefined; // listed, and nothing in it collides
      }
      return { shots: partShots, clip: partClip, ai: partAi, bounds: boundsOf(partShots, partClip), aiBounds: boundsOf(partShots, partAi) };
    });
  }

  private disposeTrees(): void {
    this.geometry?.dispose();
    this.geometry = undefined;
    this.bvh = undefined;
    this.clipGeometry?.dispose();
    this.clipGeometry = undefined;
    this.clipBvh = undefined;
    this.aiGeometry?.dispose();
    this.aiGeometry = undefined;
    this.aiBvh = undefined;
    this.aiBuilt = false;
    for (const part of this.parts) {
      part?.shots?.geometry.dispose();
      part?.clip?.geometry.dispose();
      part?.ai?.geometry.dispose();
    }
    this.parts = [];
  }

  /** How many solids `rebuild` was told about, whether or not each has triangles. */
  get partCount(): number {
    return this.parts.length;
  }

  /** One part's world-space bounds as `channel` meets it, or undefined for a part with nothing that stops it. */
  partBounds(index: number, channel: CollisionChannel = "player"): THREE.Box3 | undefined {
    return channel === "ai" ? this.parts[index]?.aiBounds : this.parts[index]?.bounds;
  }

  /** Whether the `ai` channel was built, so an actor's view can be asked for. */
  get hasAiChannel(): boolean {
    return this.aiBuilt;
  }

  /** One part's geometry, split as `mapSurfaces` splits the map's. Shared: the caller must not dispose it. */
  partSurfaces(index: number): { shots?: THREE.BufferGeometry; clip?: THREE.BufferGeometry } {
    const part = this.parts[index];
    return { shots: part?.shots?.geometry, clip: part?.clip?.geometry };
  }

  /**
   * The world as one match has it: the base, the parts `presence` has **when a
   * query runs**, and the prop hulls its mode admits. A `set` on the presence
   * takes effect on the next query; nothing is rebuilt. Views are independent:
   * two matches on one map hold two views over one set of trees.
   */
  view(presence: Presence, channel: CollisionChannel = "player"): CollisionView {
    this.assertChannel(channel);
    return new CollisionView(this, presence, channel);
  }

  /** One part alone, with no base and no hulls: what a navigation blocker and a restore's overlap check ask. */
  partView(index: number, channel: CollisionChannel = "player"): CapsuleWorld {
    this.assertChannel(channel);
    return new MaskedWorld(this, { channel, base: false, part: (i) => i === index, hull: () => false });
  }

  /** An `ai` query against trees that were never built would answer "nothing there" everywhere. */
  private assertChannel(channel: CollisionChannel): void {
    if (channel === "ai" && !this.aiBuilt) {
      throw new Error("collision: the ai channel was not built (rebuild with { ai: true })");
    }
  }

  /** One tree over `meshes`, or nothing when there are none of them. */
  private build(meshes: THREE.Mesh[]): { geometry: THREE.BufferGeometry; bvh: MeshBVH } | undefined {
    if (meshes.length === 0) {
      return undefined;
    }
    const generator = new StaticGeometryGenerator(meshes);
    generator.attributes = ["position"];
    const geometry = generator.generate();
    // Before the BVH, which reorders the index under it; per vertex, because
    // that reorder is exactly what a per-triangle table would not survive
    // (collision/surfaces.ts).
    applyMergedSurfaces(geometry, meshes);
    // After the surfaces, which count vertices as the meshes had them.
    compactVertices(geometry);
    return { geometry, bvh: new MeshBVH(geometry, { maxLeafTris: 5 }) };
  }

  /**
   * The trees a capsule is pushed out of, in the one order: the base's two, then
   * each present part's, ascending. The second of each pair is the channel's: a
   * player's clip, or an actor's. Scratch, refilled per call.
   */
  private capsuleTrees(mask: QueryMask): readonly MeshBVH[] {
    const trees = this.trees;
    trees.length = 0;
    const ai = mask.channel === "ai";
    if (mask.base && this.bvh) {
      trees.push(this.bvh);
    }
    const clip = ai ? this.aiBvh : this.clipBvh;
    if (mask.base && clip) {
      trees.push(clip);
    }
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (part && mask.part(i)) {
        if (part.shots) {
          trees.push(part.shots);
        }
        const partClip = ai ? part.ai : part.clip;
        if (partClip) {
          trees.push(partClip);
        }
      }
    }
    return trees;
  }

  /** What stops a bullet, in the same order: the base's shot tree, then each present part's. */
  private shotTrees(mask: QueryMask): readonly MeshBVH[] {
    const trees = this.trees;
    trees.length = 0;
    if (mask.base && this.bvh) {
      trees.push(this.bvh);
    }
    for (let i = 0; i < this.parts.length; i++) {
      const shots = this.parts[i]?.shots;
      if (shots && mask.part(i)) {
        trees.push(shots);
      }
    }
    return trees;
  }

  /**
   * The map's own two trees, in world space, for something that needs its own
   * copy of the geometry rather than a query against this one — a physics engine
   * building a trimesh, today.
   *
   * Separated where `debugSurfaces` merges, because the split is the whole point
   * of there being two trees: `shots` is what stops a bullet, `clip` what stops
   * only a player. Whichever a caller takes is a claim about what it is modelling,
   * and taking both is a claim too.
   *
   * Prop hulls are deliberately absent. They are per-asset trees reused across
   * thousands of placements (2,842 on interchange-mw3), which is exactly the
   * sharing a caller building one merged mesh would have to undo — so it asks for
   * them separately or not at all, rather than being handed them by surprise.
   *
   * Removable parts are absent too: they come and go, so `partSurfaces` hands
   * each over on its own.
   *
   * Shared, so the caller must not dispose either.
   */
  mapSurfaces(): { shots?: THREE.BufferGeometry; clip?: THREE.BufferGeometry } {
    return { shots: this.geometry, clip: this.clipGeometry };
  }

  /**
   * The geometry the BVHs were built from, with a matrix to draw each at: what
   * stops the player, by construction. Shared, so the caller must not dispose it.
   */
  debugSurfaces(): DebugSurface[] {
    const out: DebugSurface[] = [];
    if (this.geometry) {
      out.push({ geometry: this.geometry, matrix: new THREE.Matrix4(), surfaces: triangleSurfaces(this.geometry) });
    }
    if (this.clipGeometry) {
      out.push({ geometry: this.clipGeometry, matrix: new THREE.Matrix4(), surfaces: triangleSurfaces(this.clipGeometry) });
    }
    this.parts.forEach((part, index) => {
      for (const tree of [part?.shots, part?.clip]) {
        if (tree) {
          out.push({ geometry: tree.geometry, matrix: new THREE.Matrix4(), surfaces: triangleSurfaces(tree.geometry), part: index });
        }
      }
    });
    for (const hull of this.hulls.all) {
      out.push({ geometry: hull.bvh.geometry, matrix: hull.inverse.clone().invert() });
    }
    return out;
  }

  /** Install the per-asset hulls and their placements. Independent of `rebuild()`. */
  setHulls(geometries: Map<string, THREE.BufferGeometry>, placements: readonly HullPlacement[]): void {
    this.hulls.set(geometries, placements);
  }

  /** How many prop hulls are live, and over how many distinct assets. */
  get hullStats(): { instances: number; assets: number } {
    return { instances: this.hulls.count, assets: this.hulls.assets };
  }

  /**
   * How many hull instances the last `traceRay` had to consider.
   *
   * A diagnostic, because the cost of a trace is not visible in its answer: the
   * grid walk decides how many hulls are candidates, and a walk that took the
   * bounding rectangle rather than the line would return exactly the same hit
   * having tested a hundred times as many. Nothing but a count can see that, so
   * there is a count. Read by tests/traceRay.test.ts and worth putting on
   * `/healthz` the day a trace shows up in a profile.
   */
  get traceCandidates(): number {
    return this.candidates;
  }

  /**
   * See `CapsuleWorld.traceRay`. The map's shot tree first, then any prop hull
   * nearer than what it found.
   */
  traceRay(from: Vec3, direction: Vec3, distance: number, channel: TraceChannel, out?: RayHit, mask: QueryMask = UNMASKED): RayHit | null {
    void channel; // only `shots` is built; `sight` would pick a different tree
    const { segment, ray, rayEnd, normal } = this.scratch;
    let nearest = distance;
    let hitNormal: THREE.Vector3 | undefined;
    let kind: "map" | "prop" = "map";
    // What a round is about to hit, read off the same face the trace answered
    // with — the shot tree carries the surface attribute the capsule tree does.
    // A prop hull has none, so it stays `default` below.
    let surface: SurfaceType = DEFAULT_SURFACE;

    for (const tree of this.shotTrees(mask)) {
      ray.origin.set(from.x, from.y, from.z);
      ray.direction.set(direction.x, direction.y, direction.z);
      const hit = tree.raycastFirst(ray, THREE.DoubleSide, 0, nearest);
      if (hit?.face && hit.distance < nearest) {
        nearest = hit.distance;
        hitNormal = normal.copy(hit.face.normal);
        surface = hit.faceIndex === undefined || hit.faceIndex === null ? DEFAULT_SURFACE : faceSurface(tree.geometry, hit.faceIndex);
      }
    }

    segment.start.set(from.x, from.y, from.z);
    segment.end.set(from.x + direction.x * distance, from.y + direction.y * distance, from.z + direction.z * distance);
    const near = this.hulls.along(segment.start, segment.end);
    this.candidates = near.length;
    for (const hull of near) {
      if (!mask.hull(hull.modes)) {
        continue;
      }
      // Into the hull's frame, where the ray is no longer unit-length and its
      // length is scaled: a hit's share of that length is its share of ours. The
      // same correction `groundBelow` makes, and the one that is silently wrong if
      // a placement is scaled.
      ray.origin.copy(segment.start).applyMatrix4(hull.inverse);
      rayEnd.copy(segment.end).applyMatrix4(hull.inverse);
      ray.direction.subVectors(rayEnd, ray.origin);
      const far = ray.direction.length();
      if (far === 0) {
        continue;
      }
      ray.direction.multiplyScalar(1 / far);
      // Only as far as the best hit so far, in this hull's own units.
      const limit = (nearest / distance) * far;
      const hit = hull.bvh.raycastFirst(ray, THREE.DoubleSide, 0, limit);
      if (!hit?.face) {
        continue;
      }
      const along = (hit.distance / far) * distance;
      if (along < nearest) {
        nearest = along;
        hitNormal = normal.copy(hit.face.normal).applyMatrix3(hull.rotation).normalize();
        kind = "prop";
        surface = DEFAULT_SURFACE;
      }
    }

    if (hitNormal === undefined) {
      return null;
    }
    const result = out ?? { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind, surface };
    result.distance = nearest;
    result.normal.x = hitNormal.x;
    result.normal.y = hitNormal.y;
    result.normal.z = hitNormal.z;
    result.kind = kind;
    result.surface = surface;
    return result;
  }

  dispose(): void {
    this.hulls.clear();
    this.disposeTrees();
  }

  get ready(): boolean {
    return this.bvh !== undefined || this.clipBvh !== undefined || this.hulls.count > 0 || this.parts.some((part) => part !== undefined);
  }

  /**
   * Push a vertical capsule (feet at `position`, given `radius`/`height`) out
   * of any geometry it penetrates. Does not mutate `position`. Writes into `out`
   * when given, so the per-tick caller allocates nothing: a server runs this
   * once per player per tick.
   */
  resolveCapsule(position: Vec3, radius: number, height: number, out?: CapsuleResolution, mask: QueryMask = UNMASKED): CapsuleResolution {
    const trees = this.capsuleTrees(mask);
    if (trees.length === 0 && this.hulls.count === 0) {
      return write(out, position.x, position.y, position.z, false);
    }

    const scratch = this.scratch;
    const segment = scratch.segment;
    segment.start.set(position.x, position.y + radius, position.z);
    segment.end.set(position.x, position.y + Math.max(height - radius, radius), position.z);

    let grounded = false;

    // Both trees: a player is stopped by the world *and* by the invisible clips
    // over its windows. Two passes over two trees visit the same triangles one
    // merged tree used to, so the set of pushes is unchanged.
    for (const tree of trees) {
      pushOutOfBvh(tree, segment, radius, scratch.bounds, scratch, (direction) => {
        if (direction.y > 0.5) {
          grounded = true;
        }
      });
    }

    // Prop hulls, before the ground. In hull-local space the capsule's radius
    // is divided by the (uniform) scale.
    if (this.hulls.count > 0) {
      const localSegment = scratch.localSegment;

      for (const hull of this.hulls.near(segment, radius)) {
        // Cheap reject before paying for the transform.
        if (!mask.hull(hull.modes) || !hullTouches(hull.bounds, segment, radius)) {
          continue;
        }

        const localRadius = radius / hull.scale;
        localSegment.start.copy(segment.start).applyMatrix4(hull.inverse);
        localSegment.end.copy(segment.end).applyMatrix4(hull.inverse);

        // Mirror each local push onto the world segment: rotate the direction, scale the depth.
        pushOutOfBvh(hull.bvh, localSegment, localRadius, scratch.localBounds, scratch, (direction, depth) => {
          direction.applyMatrix3(hull.rotation).normalize();
          segment.start.addScaledVector(direction, depth * hull.scale);
          segment.end.addScaledVector(direction, depth * hull.scale);
          if (direction.y > 0.5) {
            grounded = true;
          }
        });
      }
    }

    return write(out, segment.start.x, segment.start.y - radius, segment.start.z, grounded);
  }

  /** See `CapsuleWorld.overlapsCapsule`. Stops at the first triangle it finds. */
  overlapsCapsule(position: Vec3, radius: number, height: number, mask: QueryMask = UNMASKED): boolean {
    const scratch = this.scratch;
    const { segment, localSegment } = scratch;
    segment.start.set(position.x, position.y + radius, position.z);
    segment.end.set(position.x, position.y + Math.max(height - radius, radius), position.z);

    for (const tree of this.capsuleTrees(mask)) {
      if (sinksInto(tree, segment, radius, OVERLAP_SKIN, scratch.bounds, scratch)) {
        return true;
      }
    }
    for (const hull of this.hulls.near(segment, radius)) {
      if (!mask.hull(hull.modes) || !hullTouches(hull.bounds, segment, radius)) {
        continue;
      }
      localSegment.start.copy(segment.start).applyMatrix4(hull.inverse);
      localSegment.end.copy(segment.end).applyMatrix4(hull.inverse);
      if (sinksInto(hull.bvh, localSegment, radius / hull.scale, OVERLAP_SKIN / hull.scale, scratch.localBounds, scratch)) {
        return true;
      }
    }
    return false;
  }

  /** See `CapsuleWorld.groundBelow`. The nearest standable hit across the map and its props. */
  groundBelow(from: Vec3, distance: number, mask: QueryMask = UNMASKED): number | null {
    const along = this.groundHit(from, distance, mask);
    return along === null ? null : from.y - along;
  }

  /** See `CapsuleWorld.surfaceAt`. The same hit `groundBelow` measures, named. */
  surfaceAt(from: Vec3, distance: number, mask: QueryMask = UNMASKED): SurfaceType | null {
    return this.groundHit(from, distance, mask) === null ? null : this.hitSurface;
  }

  /**
   * How far down the nearest standable hit from `from` is, or null.
   *
   * One search behind both `groundBelow` and `surfaceAt`, so the height a mantle
   * measures and the surface a footstep plays can never come from different
   * triangles — which, being two raycasts apart, they otherwise could. The
   * surface goes into `hitSurface` rather than into a returned pair, for the
   * reason `scratch` exists: a server runs this once per player per tick.
   */
  private groundHit(from: Vec3, distance: number, mask: QueryMask): number | null {
    const { segment, ray, rayEnd, normal } = this.scratch;
    let nearest = Infinity;
    this.hitSurface = DEFAULT_SURFACE;

    for (const tree of this.capsuleTrees(mask)) {
      ray.origin.set(from.x, from.y, from.z);
      ray.direction.set(0, -1, 0);
      const hit = tree.raycastFirst(ray, THREE.DoubleSide, 0, distance);
      // Either winding: imported soup is not reliably outward-facing (docs/cod/pitfalls.md).
      if (hit?.face && Math.abs(hit.face.normal.y) >= MIN_GROUND_NORMAL_Y && hit.distance < nearest) {
        nearest = hit.distance;
        this.hitSurface = hit.faceIndex === undefined || hit.faceIndex === null ? DEFAULT_SURFACE : faceSurface(tree.geometry, hit.faceIndex);
      }
    }

    segment.start.set(from.x, from.y, from.z);
    segment.end.set(from.x, from.y - distance, from.z);
    for (const hull of this.hulls.near(segment, 0)) {
      if (!mask.hull(hull.modes) || !hullTouches(hull.bounds, segment, 0)) {
        continue;
      }
      // Into the hull's frame, where the ray is no longer straight down and its
      // length is scaled: a hit's share of that length is its share of ours.
      ray.origin.copy(segment.start).applyMatrix4(hull.inverse);
      rayEnd.copy(segment.end).applyMatrix4(hull.inverse);
      ray.direction.subVectors(rayEnd, ray.origin);
      const far = ray.direction.length();
      ray.direction.multiplyScalar(1 / far);
      const hit = hull.bvh.raycastFirst(ray, THREE.DoubleSide, 0, far);
      if (!hit?.face) {
        continue;
      }
      normal.copy(hit.face.normal).applyMatrix3(hull.rotation);
      const along = (hit.distance / far) * distance;
      if (Math.abs(normal.y) >= MIN_GROUND_NORMAL_Y && along < nearest) {
        nearest = along;
        // A prop hull is a model's collision shape and carries no surface: the
        // exporter writes them only for a map's own clipmap. `default`, honestly.
        this.hitSurface = DEFAULT_SURFACE;
      }
    }

    return nearest === Infinity ? null : nearest;
  }
}

/** The world-space bounds of whichever of two trees exist, or undefined for neither. */
function boundsOf(a: MeshBVH | undefined, b: MeshBVH | undefined): THREE.Box3 | undefined {
  if (!a && !b) {
    return undefined;
  }
  const bounds = new THREE.Box3();
  for (const tree of [a, b]) {
    if (tree) {
      tree.geometry.computeBoundingBox();
      bounds.union(tree.geometry.boundingBox!);
    }
  }
  return bounds;
}

/** Fill a caller's resolution, or make one when it did not bring its own. */
function write(out: CapsuleResolution | undefined, x: number, y: number, z: number, grounded: boolean): CapsuleResolution {
  if (!out) {
    return { position: new THREE.Vector3(x, y, z), grounded };
  }
  // Field by field, not `.set()`: the simulation (engine/player/capsule.ts)
  // passes a plain { x, y, z } scratch object, which has no Vector3 methods.
  out.position.x = x;
  out.position.y = y;
  out.position.z = z;
  out.grounded = grounded;
  return out;
}

/**
 * Push `segment` out of every triangle of `bvh` it penetrates, growing the
 * query bounds as it moves. `onPush` gets each unit direction (scratch; it may
 * mutate it) and depth.
 */
function pushOutOfBvh(
  bvh: MeshBVH,
  segment: THREE.Line3,
  radius: number,
  bounds: THREE.Box3,
  scratch: Scratch,
  onPush: (direction: THREE.Vector3, depth: number) => void,
): void {
  bounds.makeEmpty();
  bounds.expandByPoint(segment.start);
  bounds.expandByPoint(segment.end);
  bounds.min.addScalar(-radius);
  bounds.max.addScalar(radius);

  const { triPoint, capsulePoint, direction } = scratch;

  bvh.shapecast({
    intersectsBounds: (box) => box.intersectsBox(bounds),
    intersectsTriangle: (tri) => {
      const distance = tri.closestPointToSegment(segment, triPoint, capsulePoint);
      if (distance >= radius) {
        return;
      }

      let depth = radius - distance;
      direction.subVectors(capsulePoint, triPoint);
      const len = direction.length();
      if (len > 1e-8) {
        direction.multiplyScalar(1 / len);
      }
      // On the triangle's plane: no separating direction, so pick up.
      else {
        direction.set(0, 1, 0);
      }

      // On standable ground, clear the penetration vertically rather than along
      // the normal. Along the normal, gravity's per-frame sinking returns as
      // sideways motion and a standing player creeps downhill (~13 cm/s on 30°).
      // Walls and ceilings are untouched. "Up" is the segment's space: world up
      // for the world mesh and yaw-only props.
      if (direction.y >= MIN_GROUND_NORMAL_Y) {
        depth /= direction.y;
        direction.set(0, 1, 0);
      }

      segment.start.addScaledVector(direction, depth);
      segment.end.addScaledVector(direction, depth);
      bounds.expandByPoint(segment.start);
      bounds.expandByPoint(segment.end);

      onPush(direction, depth);
    },
  });
}

/** Whether any triangle of `bvh` comes closer than `radius - skin` to `segment`. */
function sinksInto(bvh: MeshBVH, segment: THREE.Line3, radius: number, skin: number, bounds: THREE.Box3, scratch: Scratch): boolean {
  bounds.makeEmpty();
  bounds.expandByPoint(segment.start);
  bounds.expandByPoint(segment.end);
  bounds.min.addScalar(-radius);
  bounds.max.addScalar(radius);
  const { triPoint, capsulePoint } = scratch;
  return bvh.shapecast({
    intersectsBounds: (box) => box.intersectsBox(bounds),
    intersectsTriangle: (tri) => tri.closestPointToSegment(segment, triPoint, capsulePoint) < radius - skin,
  });
}

/** Whether a hull's world AABB could touch the capsule at all. */
function hullTouches(bounds: THREE.Box3, segment: THREE.Line3, radius: number): boolean {
  return (
    bounds.min.x - radius <= Math.max(segment.start.x, segment.end.x) &&
    bounds.max.x + radius >= Math.min(segment.start.x, segment.end.x) &&
    bounds.min.y - radius <= Math.max(segment.start.y, segment.end.y) &&
    bounds.max.y + radius >= Math.min(segment.start.y, segment.end.y) &&
    bounds.min.z - radius <= Math.max(segment.start.z, segment.end.z) &&
    bounds.max.z + radius >= Math.min(segment.start.z, segment.end.z)
  );
}

/** The mesh's removable part, from `userData.part` on it or on an ancestor below `root`. */
function partTag(mesh: THREE.Object3D, root: THREE.Object3D): string | undefined {
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    if (typeof node.userData.part === "string") {
      return node.userData.part;
    }
    if (node === root) {
      break;
    }
  }
  return undefined;
}

/** A `CollisionWorld` seen through one fixed mask. */
class MaskedWorld implements CapsuleWorld {
  constructor(
    protected readonly collision: CollisionWorld,
    private readonly mask: QueryMask,
  ) {}

  get ready(): boolean {
    return this.collision.ready;
  }

  resolveCapsule(position: Vec3, radius: number, height: number, out?: SimResolution): SimResolution {
    return this.collision.resolveCapsule(position, radius, height, out as CapsuleResolution | undefined, this.mask);
  }

  overlapsCapsule(position: Vec3, radius: number, height: number): boolean {
    return this.collision.overlapsCapsule(position, radius, height, this.mask);
  }

  groundBelow(from: Vec3, distance: number): number | null {
    return this.collision.groundBelow(from, distance, this.mask);
  }

  surfaceAt(from: Vec3, distance: number): SurfaceType | null {
    return this.collision.surfaceAt(from, distance, this.mask);
  }

  traceRay(from: Vec3, direction: Vec3, distance: number, channel: TraceChannel, out?: RayHit): RayHit | null {
    return this.collision.traceRay(from, direction, distance, channel, out, this.mask);
  }
}

/**
 * One match's collision (`CollisionWorld.view`). The presence is read on every
 * query, never copied, so a change is seen by the next one. Assignable, for a
 * client that keeps one view across the worlds it mounts.
 */
export class CollisionView extends MaskedWorld {
  constructor(
    collision: CollisionWorld,
    public presence: Presence,
    readonly channel: CollisionChannel = "player",
  ) {
    super(collision, {
      channel,
      base: true,
      part: (index) => this.presence.has(index),
      hull: (modes) => this.presence.hasModes(modes),
    });
  }

  /** The trees underneath, for what needs geometry rather than queries (physics, the debug views). */
  get world(): CollisionWorld {
    return this.collision;
  }
}

// The simulation only ever sees this narrow, three.js-free view of the world
// (engine/player/capsule.ts). Asserted here so the two cannot drift apart.
const _satisfiesCapsuleWorld: CapsuleWorld = null as unknown as CollisionWorld;
void _satisfiesCapsuleWorld;
