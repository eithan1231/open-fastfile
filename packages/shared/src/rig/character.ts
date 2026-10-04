// A third-person player: the body GLB's skeleton wearing a head and holding a
// weapon, both rebound to it by joint name, and the clips every character in the
// game shares.
//
// In `@3d/shared` rather than in the client, because **both ends build one now**: a
// player is moved as a capsule and shot as a skeleton, so a server judging a shot
// has to pose the same body the client drew and read where the bones ended up. Two
// implementations of that would be a hit box somewhere other than the body on
// screen — the same argument `sim/` is built on.
//
// One of the two subtrees of this package allowed to use three.js (see
// tsconfig.rig.json). Three as a scene graph and an animation mixer, never as a
// renderer: nothing here constructs a WebGLRenderer or touches the DOM, so it runs
// identically in a browser and in Node.
//
// `client/engine/characterAnimator.ts` poses one and `client/net/remotePlayers.ts`
// draws one per peer: docs/engine/rendering.md#player-characters.
//
// The same shape as the viewmodel's rig (scene/viewmodel.ts): the exporter
// grafts the head's and weapon's *joints* into the body GLB, so this only has to
// move their skinned meshes onto the body's bones. three rebinds an attached
// SkinnedMesh's bind matrix from its world matrix every frame, which is why
// where the mesh hangs in the graph does not move it.

import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { CHARACTER_FORMAT_VERSION, ROLE_TABLES, type CharacterRole, type CreatureRole, type RoleTableId } from "../sim/characterDef.js";

/**
 * A loaded glTF: its scene and its clips.
 *
 * Declared here rather than imported from the client's `AssetStore`, which is where
 * it used to live — a game server loads the same files with the same GLTFLoader and
 * has no asset store at all. Structurally identical, so `AssetStore.gltf()` still
 * satisfies it.
 */
export interface GltfAsset {
  /** Pristine: every user clones or copies it. `userData` holds the glTF scene's extras. */
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
}

// Both moved to `@3d/shared/sim/characterDef.ts` when `poseLayers` needed to name a
// role: a server decides which clip a peer is playing now, so the table cannot live
// in a module that imports three.js. Re-exported here because this is still where a
// character GLB is read, and every caller of that reads roles from it.
export { CHARACTER_FORMAT_VERSION, CHARACTER_ROLES, type CharacterRole } from "../sim/characterDef.js";

export interface CharacterClipInfo {
  duration: number;
  looped: boolean;
  /** `[name, seconds]` sound and event cues; nothing reads them yet. */
  notes: [string, number][];
}

/** The clip table `animations.glb` carries in its scene extras: which clip plays which role. */
export interface CharacterSet {
  game: string;
  /** The weapon whose `playerAnimType` chose these clips, and whose world model is in the hands. */
  weapon: string;
  animType: string;
  /**
   * Which roles `roles` names: a soldier's (`CHARACTER_ROLES`) when absent, or a
   * creature's (`CREATURE_ROLES`) for an actor's clips. `readCharacterSet` holds
   * `roles` to it.
   */
  table?: RoleTableId;
  roles: Partial<Record<CharacterRole | CreatureRole, string>>;
  /** Roles whose clip poses the spine up only, and so replaces those bones over a locomotion clip. */
  torsoRoles: CharacterRole[];
  /** The joint the engine turns for aim pitch; CoD ships no aim-up/down player clips. */
  aimJoint: string;
  clips: Record<string, CharacterClipInfo>;
}

/**
 * How far a rig is turned on top of the yaw a body is facing.
 *
 * A CoD rig stands facing +X and the engine's yaw 0 faces -Z, so a quarter turn is
 * the whole difference. Here because **both ends place a body**: a client draws one
 * (net/remotePlayers.ts) and a server poses the same one to trace a bullet at it, and
 * a body turned differently on each end is a hit box beside the body on screen.
 */
export const MODEL_FACING = Math.PI / 2;

/**
 * Every bone's local transform as its GLB declared it, before anything posed it.
 *
 * A ragdoll is measured from the rest pose and nothing else: where a joint hangs
 * off its parent, and how big a segment is in its own frame, are facts about the
 * skeleton rather than about the frame a body happened to die on. A rig in hand is
 * always posed, and `CharacterPoser.update` overwrites any bone a live clip keys,
 * so the rest pose has to be taken once at build time or it is gone.
 *
 * Read by `@3d/shared/physics/ragdoll.ts`. **Nothing reads it while posing**, which
 * is what keeps `CharacterPoser` a pure function of `MovementState` and
 * `WeaponData` — the property `client/tests/character.test.ts` holds to a
 * nanometre, and the reason one implementation of a pose is enough for both ends.
 */
export interface BindPose {
  /** Parent bone name, or undefined for a bone hanging off the rig root. */
  parentOf(bone: string): string | undefined;
  /** The bone's world matrix in the rest pose, relative to `CharacterRig.root`. */
  worldOf(bone: string): THREE.Matrix4 | undefined;
  /** Every bone, in the order the skeleton declares them: parents before children. */
  readonly bones: readonly string[];
}

/** One character, ready to pose. */
export interface CharacterRig {
  /** The world's name for it ("allies", "axis"). */
  name: string;
  /** Stands at the origin on its feet, facing CoD's +X; a placer turns it by `MODEL_FACING`. */
  root: THREE.Object3D;
  /** The joint aim pitch turns, or undefined on a body that has none. */
  aim: THREE.Bone | undefined;
  /** Only the clips this rig's own skeleton can play, exactly as they were authored. */
  clips: Map<string, THREE.AnimationClip>;
  /** The skeleton at rest, captured before anything posed it. See `BindPose`. */
  bind: BindPose;
  set: CharacterSet;
}

/**
 * One rig's `clips`, handed to the next rig on the same body so it shares them
 * rather than copying every track again: clips are read-only data, and each rig's
 * mixer binds its own. A head adds no joint a clip keys, so any head will do.
 */
export type FittedClips = ReadonlyMap<string, THREE.AnimationClip>;

/** Read and check the clip table `animations.glb` carries. Throws on anything else. */
export function readCharacterSet(userData: Record<string, unknown>): CharacterSet {
  const raw = userData.characters as (Partial<CharacterSet> & { version?: number }) | undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error("not a character animations GLB: its scene has no `characters` extras");
  }
  if (raw.version !== CHARACTER_FORMAT_VERSION) {
    throw new Error(`character GLB format ${String(raw.version)}; this build reads ${CHARACTER_FORMAT_VERSION} (re-export it)`);
  }
  if (!raw.roles?.idle) {
    throw new Error("the character clip table has no idle clip");
  }
  const table = (raw as { roleTable?: string }).roleTable ?? "soldier";
  if (!Object.hasOwn(ROLE_TABLES, table)) {
    throw new Error(`the character clip table names role table "${table}", which this build does not have`);
  }
  const known: readonly string[] = ROLE_TABLES[table as RoleTableId].roles;
  for (const role of Object.keys(raw.roles)) {
    if (!known.includes(role)) {
      throw new Error(`the character clip table names role "${role}", which a ${table}'s clips do not play`);
    }
  }
  return {
    game: raw.game ?? "",
    weapon: raw.weapon ?? "",
    animType: raw.animType ?? "",
    table: table as RoleTableId,
    roles: raw.roles,
    torsoRoles: raw.torsoRoles ?? [],
    aimJoint: raw.aimJoint ?? "",
    clips: raw.clips ?? {},
  };
}

/**
 * Build one character: `body` cloned, with `head`'s and `weapon`'s skinned
 * meshes moved onto its bones, playing whichever of `animations`' clips its own
 * skeleton has the joints for — or exactly `animations`, where another rig on
 * this body already fitted them (`FittedClips`).
 */
export function buildCharacterRig(
  name: string,
  set: CharacterSet,
  animations: readonly THREE.AnimationClip[] | FittedClips,
  body: GltfAsset,
  head?: GltfAsset,
  weapon?: GltfAsset,
): CharacterRig {
  const root = SkeletonUtils.clone(body.scene);
  const joints = new Map<string, THREE.Bone>();
  root.traverse((item) => {
    if (item instanceof THREE.Bone) {
      joints.set(item.name, item);
    }
  });
  if (joints.size === 0) {
    throw new Error(`character ${name}: its body GLB has no skeleton`);
  }

  for (const worn of [head, weapon]) {
    if (worn) {
      rebind(root, joints, worn, name);
    }
  }

  root.traverse((item) => {
    if (!(item instanceof THREE.Mesh)) {
      return;
    }
    // A run carries arms and legs well outside the bind pose's box, and there
    // are only ever a handful of players; culling them by a stale box costs
    // more in vanished bodies than it saves.
    item.frustumCulled = false;
    // It moves every frame and `shadowMap.autoUpdate` is off, so a cast shadow
    // would be left behind where the body used to stand. Receiving is free: the
    // map's own sun shadow is already in the map (engine/shadows.ts).
    item.castShadow = false;
    item.receiveShadow = true;
  });

  root.userData.name = name; // what the inspector reports, like every other tagged node
  // Captured here, before a poser is ever attached: from this point on the bones
  // hold whatever the last `CharacterPoser.update` left, and the rest pose is not
  // recoverable from them.
  const bind = bindPoseOf(root);
  return {
    name,
    root,
    aim: joints.get(set.aimJoint),
    clips: isFitted(animations) ? new Map(animations) : clipsFor(joints, set, animations),
    bind,
    set,
  };
}

/**
 * Read a skeleton's rest pose off a rig nothing has posed yet.
 *
 * `updateMatrixWorld(true)` first, because a clone's matrices are whatever the
 * loader left and `WorldSession` has switched the scene's automatic update off by
 * the time anybody asks. The matrices are copied rather than referenced: the bones
 * are about to start moving.
 *
 * Exported so that a rig assembled by hand — a test's two-bone skeleton, say — gets
 * the same bind pose as a real body rather than a stub that agrees with nothing.
 */
export function bindPoseOf(root: THREE.Object3D): BindPose {
  root.updateMatrixWorld(true);
  const inverseRoot = root.matrixWorld.clone().invert();
  const parents = new Map<string, string | undefined>();
  const worlds = new Map<string, THREE.Matrix4>();
  const order: string[] = [];
  root.traverse((item) => {
    if (!(item instanceof THREE.Bone)) {
      return;
    }
    parents.set(item.name, item.parent instanceof THREE.Bone ? item.parent.name : undefined);
    worlds.set(item.name, inverseRoot.clone().multiply(item.matrixWorld));
    order.push(item.name);
  });
  return {
    parentOf: (bone) => parents.get(bone),
    worldOf: (bone) => worlds.get(bone),
    bones: order,
  };
}

/** Move every skinned mesh of `worn` onto `root`'s bones, matched by joint name. */
function rebind(root: THREE.Object3D, joints: Map<string, THREE.Bone>, worn: GltfAsset, name: string): void {
  const clone = SkeletonUtils.clone(worn.scene);
  const meshes: THREE.SkinnedMesh[] = [];
  clone.traverse((item) => {
    if (item instanceof THREE.SkinnedMesh) {
      meshes.push(item);
    }
  });
  for (const mesh of meshes) {
    const bones = mesh.skeleton.bones.map((bone) => {
      const joint = joints.get(bone.name);
      if (!joint) {
        throw new Error(`character ${name}: its body has no joint ${bone.name} to hang this on (re-export the world)`);
      }
      return joint;
    });
    // The loader binds with an identity bind matrix, so where the mesh hangs does not move it.
    mesh.bind(new THREE.Skeleton(bones, mesh.skeleton.boneInverses), mesh.bindMatrix);
    root.add(mesh);
  }
}

/**
 * The clips this rig can play. `animations.glb` holds the union of every
 * character's skeleton — a body with no coat has no coat bones — so each rig
 * takes a copy with the tracks it cannot bind dropped, rather than letting
 * three warn once per unresolved track per action.
 *
 * Torso clips are left exactly as they are. They pose the spine and above — a
 * strict subset of the bones a locomotion clip keys — and they pose it *fully*: a
 * reload is where the arms are, not an offset from where they were. They used to
 * be made additive here, against their own first frame, which composed a reload's
 * arm motion on top of a run's arm swing and drew neither. The layering they
 * actually want is a bone mask, and `rig/poser.ts` gets one out of the mixer's
 * per-property weights instead.
 */
function isFitted(animations: readonly THREE.AnimationClip[] | FittedClips): animations is FittedClips {
  return animations instanceof Map;
}

function clipsFor(joints: Map<string, THREE.Bone>, set: CharacterSet, animations: readonly THREE.AnimationClip[]): Map<string, THREE.AnimationClip> {
  const out = new Map<string, THREE.AnimationClip>();
  for (const source of animations) {
    const tracks = source.tracks.filter((track) => joints.has(track.name.split(".")[0] ?? ""));
    if (tracks.length === 0) {
      continue;
    }
    const clip = new THREE.AnimationClip(
      source.name,
      source.duration,
      tracks.map((t) => t.clone()),
      source.blendMode,
    );
    const info = set.clips[clip.name];
    if (info) {
      // A one-frame clip has every key at t = 0, and three would give it duration zero.
      clip.duration = Math.max(info.duration, clip.duration);
    }
    out.set(clip.name, clip);
  }
  return out;
}

/** One character a world ships, as the files it is built from. */
export interface CharacterSource {
  name: string;
  body: GltfAsset;
  head?: GltfAsset;
  weapon?: GltfAsset;
}

/**
 * Every character a world ships, ready to dress a player in one.
 *
 * A rig cannot be shared: two players in the same body would pose one skeleton
 * between them. So this holds the loaded files — which *are* shared, and belong
 * to the world's AssetStore — and builds a rig per player on the spot.
 */
export class CharacterKit {
  constructor(
    readonly set: CharacterSet,
    private readonly animations: readonly THREE.AnimationClip[],
    private readonly sources: readonly CharacterSource[],
  ) {
    if (sources.length === 0) {
      throw new Error("a character kit needs at least one character");
    }
  }

  get names(): string[] {
    return this.sources.map((s) => s.name);
  }

  /**
   * A rig for the `index`th character, wrapping round. Which player gets which
   * is the caller's: there are no teams in the protocol yet, so a peer's id
   * picks one and everyone agrees on it because the id is the same everywhere.
   */
  build(index: number): CharacterRig {
    const source = this.sources[((index % this.sources.length) + this.sources.length) % this.sources.length]!;
    return buildCharacterRig(source.name, this.set, this.animations, source.body, source.head, source.weapon);
  }
}
