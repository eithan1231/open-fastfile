// The first-person viewmodel's rig: the weapon GLB's skeleton (the view hands'
// joints with the gun grafted on at `tag_weapon`, scripts/cod/viewmodel.py)
// wearing a pair of view hands, rebound to it by joint name. engine/viewmodel.ts
// poses it and draws it over the world: docs/engine/rendering.md#the-viewmodel.

import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { GltfAsset } from "./assets.js";

// The weapon's plain-data description lives in src/shared/ so the server can
// read it without three.js; re-exported here because a viewmodel is how the
// client meets one.
import { WEAPON_FORMAT_VERSION } from "@3d/shared/sim/weaponDef.js";
import type { ClipRole, WeaponClipInfo, WeaponDef, WeaponTimes } from "@3d/shared/sim/weaponDef.js";
import type { AttachmentEntry } from "@3d/shared/sim/weaponRegistry.js";
export { WEAPON_FORMAT_VERSION };
export type { ClipRole, WeaponClipInfo, WeaponDef, WeaponTimes };

/** One attachment to hang on the gun: what the catalogue says about it, and its model. */
export interface FittedAttachment {
  entry: AttachmentEntry;
  /** The catalogue's model for it. Absent where the mesh is part of the gun already (IW4) — nothing to mount. */
  asset: GltfAsset | undefined;
}

export interface ViewmodelOptions {
  /**
   * The definition to build from: the catalogue's, with fitted attachments
   * already resolved into it. Defaults to the copy in the GLB's own extras,
   * which is the bare weapon.
   */
  def?: WeaponDef;
  /** What is fitted. Only the ones with a model of their own are mounted; the rest change the numbers and what is hidden. */
  attachments?: readonly FittedAttachment[];
}

/** The joint the camera sits at: the eye, which no clip moves. */
export const EYE_JOINT = "tag_view";

export interface ViewmodelRig {
  /** The clone of the weapon GLB's scene, hands attached. */
  root: THREE.Object3D;
  /** `tag_view`, where the camera sits. */
  eye: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
  def: WeaponDef;
}

/** Read and check the weapon definition a weapon GLB carries in its scene extras. Throws on anything else. */
export function readWeaponDef(userData: Record<string, unknown>): WeaponDef {
  const raw = userData.viewmodel as (Partial<WeaponDef> & { version?: number }) | undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error("not a weapon GLB: its scene has no `viewmodel` extras");
  }
  if (raw.version !== WEAPON_FORMAT_VERSION) {
    throw new Error(`weapon GLB format ${String(raw.version)}; this build reads ${WEAPON_FORMAT_VERSION} (re-export it)`);
  }
  if (!raw.roles?.idle) {
    throw new Error(`weapon ${raw.weapon ?? "?"} has no idle clip`);
  }
  return {
    game: raw.game ?? "",
    weapon: raw.weapon ?? "",
    gun: raw.gun ?? "",
    roles: raw.roles,
    clips: raw.clips ?? {},
    times: raw.times ?? {},
    clipSize: raw.clipSize ?? 0,
    fireType: raw.fireType ?? "Full Auto",
    boltAction: raw.boltAction ?? false,
    roundsPerLoad: raw.roundsPerLoad ?? 0,
    adsZoomFov: raw.adsZoomFov ?? null,
    adsOverlay: raw.adsOverlay ?? null,
    motion: raw.motion ?? {},
    hideBones: raw.hideBones ?? [],
    // Carried through rather than defaulted: these are optional on a `WeaponDef`,
    // so dropping them here would leave a gun that reads as doing no damage at
    // all instead of one whose numbers are missing.
    damage: raw.damage,
    spread: raw.spread,
    locationDamage: raw.locationDamage,
    shotCount: raw.shotCount,
    weaponType: raw.weaponType,
    weaponClass: raw.weaponClass,
    penetrateType: raw.penetrateType,
  };
}

/**
 * Put `weapon`'s rig in `hands`: clone both, move the hands' skinned meshes
 * onto the weapon's joints by name (their own inverse bind matrices still place
 * them), hang whatever is fitted on the gun's tags, and hide the surfaces the
 * game does not draw.
 */
export function buildViewmodelRig(weapon: GltfAsset, hands: GltfAsset, options: ViewmodelOptions = {}): ViewmodelRig {
  // The GLB's own copy is read even when the catalogue's is given: it is the
  // only check that this file is a weapon GLB at all, and the fallback for a
  // client whose catalogue never arrived.
  const own = readWeaponDef(weapon.scene.userData);
  const def = options.def ?? own;
  const root = SkeletonUtils.clone(weapon.scene);
  const joints = new Map<string, THREE.Object3D>();

  root.traverse((item) => {
    if (item instanceof THREE.Bone) {
      joints.set(item.name, item);
    }
  });

  const eye = joints.get(EYE_JOINT);
  if (!eye) {
    throw new Error(`weapon ${def.weapon} has no ${EYE_JOINT} joint`);
  }

  const handsClone = SkeletonUtils.clone(hands.scene);
  const handMeshes: THREE.SkinnedMesh[] = [];
  handsClone.traverse((item) => {
    if (item instanceof THREE.SkinnedMesh) {
      handMeshes.push(item);
    }
  });

  if (handMeshes.length === 0) {
    throw new Error("the view hands have no skinned mesh");
  }

  graftMissingJoints(root, joints, handsClone, def.weapon);

  for (const mesh of handMeshes) {
    const bones = mesh.skeleton.bones.map((bone) => joints.get(bone.name) as THREE.Bone);

    // The loader binds with an identity bind matrix, so where the mesh hangs in the graph does not move it.
    mesh.bind(new THREE.Skeleton(bones, mesh.skeleton.boneInverses), mesh.bindMatrix);
    root.add(mesh);
  }

  mountAttachments(root, joints, options.attachments ?? [], def.weapon);

  // After the attachments: `def.hideBones` is the resolved set, so an optic that
  // hides the iron sights hides them on the mesh it just brought with it too.
  hideByBones(root, def.hideBones);
  root.traverse((item) => {
    if (!(item instanceof THREE.Mesh)) {
      return;
    }

    item.frustumCulled = false; // the clips carry the arms well outside their bind-pose bounds
    item.castShadow = false;
    item.receiveShadow = true; // the world's sun shadow, shared by engine/viewmodel.ts's light copies
  });

  const clips = new Map<string, THREE.AnimationClip>();
  for (const source of weapon.clips) {
    const clip = source.clone(); // the store's copy stays pristine
    const info = def.clips[clip.name];

    // A one-frame clip (every idle) has all its keys at t = 0, and three would give it duration zero.
    if (info) {
      clip.duration = Math.max(info.duration, clip.duration);
    }

    clips.set(clip.name, clip);
  }

  for (const [role, name] of Object.entries(def.roles)) {
    if (!clips.has(name)) {
      throw new Error(`weapon ${def.weapon}: its ${role} clip ${name} is not in the file`);
    }
  }

  root.userData.name = def.weapon;

  return { root, eye, clips, def };
}

/**
 * Give the rig any joint the hands have and it does not.
 *
 * A weapon GLB carries a copy of the view-hands skeleton from the game the
 * *weapon* was exported from, and the two games' hands are not quite the same:
 * Modern Warfare 3's carry a `tag_knife_attach2` that no Modern Warfare 2 weapon
 * has ever heard of. Refusing the weapon over one missing tag left a player
 * empty-handed the moment their class named a gun from the other game, which is
 * half the catalogue — so the hands' own joint is copied in instead, under the
 * parent it names, where its geometry expects to find it.
 */
function graftMissingJoints(root: THREE.Object3D, joints: Map<string, THREE.Object3D>, hands: THREE.Object3D, weapon: string): void {
  const added: string[] = [];
  // Parents first, which is the order `traverse` visits them in, so a missing
  // joint under another missing one still finds somewhere to hang.
  hands.traverse((item) => {
    if (!(item instanceof THREE.Bone) || joints.has(item.name)) {
      return;
    }
    const parent = item.parent instanceof THREE.Bone ? joints.get(item.parent.name) : undefined;
    const bone = new THREE.Bone();
    bone.name = item.name;
    bone.position.copy(item.position);
    bone.quaternion.copy(item.quaternion);
    bone.scale.copy(item.scale);
    (parent ?? root).add(bone);
    joints.set(bone.name, bone);
    added.push(bone.name);
  });
  if (added.length > 0) {
    console.info(`[viewmodel] ${weapon}: these hands bring ${added.join(", ")}, which its own rig does not carry`);
  }
}

/** Every bone named in `bones`, plus every bone under one of them. */
function subtreesOf(root: THREE.Object3D, bones: readonly string[]): Set<string> {
  const wanted = new Set(bones);
  const hidden = new Set(bones);
  root.traverse((item) => {
    if (item instanceof THREE.Bone && wanted.has(item.name)) {
      item.traverse((below) => {
        if (below instanceof THREE.Bone) {
          hidden.add(below.name);
        }
      });
    }
  });
  return hidden;
}

/** Hang each fitted attachment's model on the gun. `joints` is the rig's bones by name. */
export function mountAttachments(root: THREE.Object3D, joints: Map<string, THREE.Object3D>, fitted: readonly FittedAttachment[], weapon: string): void {
  for (const attachment of fitted) {
    mountAttachment(root, joints, attachment, weapon);
  }
}

/**
 * Hang a fitted attachment's model on the gun.
 *
 * **The model's own root joint is named for the gun tag it belongs on** —
 * `viewmodel_acog`'s root is `tag_acog_2`, which is a joint of every rifle that
 * takes one — so mounting is: clear that root's own transform, which is OAT's
 * axis change and is already applied to the whole rig at `tag_origin`, and hang
 * it from the rig's joint of the same name.
 *
 * Its meshes keep their own bones rather than being rebound by name the way the
 * hands are, because those names are not unique across attachments: an ACOG, an
 * EOTech and a reflex each carry a `tag_reticle_attach`, and binding by name
 * would give a fitted one another's. They are moved onto `root` for the same
 * reason the hands' are — see above.
 */
function mountAttachment(root: THREE.Object3D, joints: Map<string, THREE.Object3D>, fitted: FittedAttachment, weapon: string): void {
  const tag = fitted.entry.tag;
  if (!fitted.asset || tag === undefined) {
    return; // nothing of its own to draw: it changes the numbers, or the gun already carries its mesh
  }
  const at = joints.get(tag);
  if (!at) {
    console.warn(`[viewmodel] ${weapon} has no ${tag} to mount ${fitted.entry.id} on`);
    return;
  }

  const clone = SkeletonUtils.clone(fitted.asset.scene);
  let mount: THREE.Object3D | undefined;
  const skinned: THREE.SkinnedMesh[] = [];
  const rigid: THREE.Mesh[] = [];
  clone.traverse((item) => {
    if (item instanceof THREE.SkinnedMesh) {
      skinned.push(item);
    } else if (item instanceof THREE.Mesh) {
      rigid.push(item);
    } else if (item instanceof THREE.Bone && item.name === tag) {
      mount ??= item;
    }
  });

  if (mount) {
    mount.position.set(0, 0, 0);
    mount.quaternion.identity();
    mount.scale.set(1, 1, 1);
    at.add(mount);
    // Drawing flags are set for every mesh of the rig once, below.
    for (const mesh of skinned) {
      root.add(mesh);
    }
    return;
  }

  if (rigid.length === 0) {
    console.warn(`[viewmodel] ${fitted.entry.id}'s model has no ${tag} joint to hang it by`);
    return;
  }
  at.add(uprightRigid(rigid));
}

/**
 * A rigid attachment's meshes, hung so the rest of the rig's frame does not turn
 * them on their side.
 *
 * Five of IW5's sniper scopes have no joints at all, and OAT bakes its Z-up to
 * Y-up change into the vertices of such a model rather than onto a root joint.
 * The weapon rig applies that same change once, at `tag_origin`, for everything
 * under it — a skinned attachment's root joint carries it too, which is why
 * mounting one *clears* that root's transform. A rigid model brings it already
 * applied, so hanging one under a gun tag applies it twice, and the scope ends
 * up lying on its side beside the rifle. This undoes it.
 */
function uprightRigid(meshes: readonly THREE.Mesh[]): THREE.Object3D {
  const holder = new THREE.Group();
  holder.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  for (const mesh of meshes) {
    holder.add(mesh);
  }
  return holder;
}

/**
 * Hide every surface with a vertex on one of `bones` **or on anything parented
 * under one**. The game skips a whole surface by the bones it touches, and the
 * exporter keeps one primitive per surface, so this is the same rule.
 *
 * The subtree is the part that is easy to miss and expensive to get wrong. A
 * weapon file hides an attachment by naming the one tag it hangs from, and
 * everything the attachment is made of hangs below that: `tag_acog_2` carries a
 * `tag_reticle_acog`, `tag_shotgun` four masterkey joints, `tag_gp25` the
 * grenade launcher's own. Hiding only the named bone left a Modern Warfare 2
 * rifle wearing the reticle of a scope it did not have, a motion tracker's
 * screen, and a floating M203 — every attachment's odds and ends at once, which
 * reads as a broken texture rather than as geometry that should not be there.
 */
export function hideByBones(root: THREE.Object3D, bones: readonly string[]): number {
  if (bones.length === 0) {
    return 0;
  }
  const hidden = subtreesOf(root, bones);
  let count = 0;
  root.traverse((item) => {
    if (!(item instanceof THREE.SkinnedMesh)) {
      return;
    }

    const index = item.geometry.index;
    const joints = item.geometry.getAttribute("skinIndex");
    const weights = item.geometry.getAttribute("skinWeight");
    if (!joints || !weights) {
      return;
    }

    const n = index ? index.count : joints.count;

    for (let k = 0; k < n; k++) {
      const v = index ? index.getX(k) : k;
      for (let c = 0; c < 4; c++) {
        if (weights.getComponent(v, c) > 0 && hidden.has(item.skeleton.bones[joints.getComponent(v, c)]?.name ?? "")) {
          item.visible = false;
          count++;
          return;
        }
      }
    }
  });

  return count;
}
