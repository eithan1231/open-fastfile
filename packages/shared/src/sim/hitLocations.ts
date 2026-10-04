// Where on a body a bullet landed, and which joint answers for it.
//
// Call of Duty resolves a hit to one of nineteen locations and gives every weapon
// a damage multiplier per location (`AttLocationDamage` in the zone: `locHead`,
// `locNeck`, `locTorsoUpper`, ...). The engine does it by attaching an AABB to each
// bone and classifying the bone; this does the same, from the joint names the
// exported bodies already carry.
//
// -- Why not every joint ------------------------------------------------------
//
// The 52 exported bodies carry 265 distinct joints between them, and most are
// facial detail (`j_nasolabial_ri_3`), cloth (`j_coatfront_le`) or attachment tags
// (`tag_acog_2`). Boxing all of them would be nonsense: a bullet cannot
// meaningfully hit an eyelid, and a box per lip joint is a hundred ray tests for a
// volume already inside the head's.
//
// So about thirty joints get a box, and **every other skinned joint folds into its
// nearest boxed ancestor**. That is what keeps the result honest: a vertex weighted
// to `j_lip_top_le_2` still contributes to the head's box, so no part of the body
// is missing from the volumes a bullet can meet. `hitLocationOf` walking a parent
// chain is that rule, and `tests/hitLocations.test.ts` asserts every skinned joint
// of every exported body resolves through it.

/**
 * The nineteen locations, in the source games' own order.
 *
 * The order **is** a format: a hit event names a location by its index. Append,
 * never insert. A weapon's multipliers are keyed by *name* rather than by that
 * index (`WeaponDef.locationDamage`), because IW6 orders its own list
 * differently and interleaves the sides where IW5 groups them — see
 * docs/cod/reference.md.
 *
 * Taken from `AttLocationDamage` as the Ghosts Durango build declares it
 * (`reverse/iw6-zone/out/sizes/structs.hpp`), which is the one place any of the
 * four games publishes the list rather than implying it.
 */
export const HIT_LOCATIONS = [
  "none",
  "helmet",
  "head",
  "neck",
  "torsoUpper",
  "torsoLower",
  "rightArmUpper",
  "rightArmLower",
  "rightHand",
  "leftArmUpper",
  "leftArmLower",
  "leftHand",
  "rightLegUpper",
  "rightLegLower",
  "rightFoot",
  "leftLegUpper",
  "leftLegLower",
  "leftFoot",
  "gun",
] as const;

export type HitLocation = (typeof HIT_LOCATIONS)[number];

/**
 * The joints that get a hitbox, and what each counts as.
 *
 * `_le` and `_ri` are the character's own left and right, as the games name them —
 * so `j_shoulder_ri` is `rightArmUpper`, not the shoulder on the viewer's right.
 *
 * Every entry here is a joint that actually carries body mass. Helpers and twists
 * are included where they sit *between* two boxed joints (`j_wristtwist_ri` is
 * forearm, not hand) because otherwise their vertices would fold upwards into the
 * wrong one.
 */
export const HIT_BONES: Readonly<Record<string, HitLocation>> = {
  // The head and what is strapped to it. CoD keeps `helmet` separate from `head`
  // and gives it its own multiplier — usually a lower one, since a helmet is the
  // reason a head shot is not always a kill.
  j_head: "head",
  j_head_end: "head",
  j_helmet: "helmet",
  j_nvg: "helmet",
  j_nvg_end: "helmet",
  j_gasmask_front: "helmet",
  j_gasmask_ri: "helmet",

  j_neck: "neck",
  j_neck_helper: "neck",
  j_collar: "neck",
  j_collar_front: "neck",
  j_collar_rear: "neck",

  // Chest and shoulders. `torso_stabilizer` is the joint the engine turns to aim,
  // and it sits at the base of the chest.
  j_spine4: "torsoUpper",
  j_spineupper: "torsoUpper",
  back_mid: "torsoUpper",
  torso_stabilizer: "torsoUpper",
  j_clavicle_le: "torsoUpper",
  j_clavicle_ri: "torsoUpper",
  j_pectoral_le: "torsoUpper",
  j_pectoral_ri: "torsoUpper",

  // Belly and hips. `j_mainroot` and `pelvis` are the root of the whole skeleton,
  // so anything unclassified folds here rather than nowhere.
  j_mainroot: "torsoLower",
  pelvis: "torsoLower",
  j_spinelower: "torsoLower",
  back_low: "torsoLower",

  j_shoulder_ri: "rightArmUpper",
  j_shouldertwist_ri: "rightArmUpper",
  j_elbow_ri: "rightArmLower",
  j_wristtwist_ri: "rightArmLower",
  j_wrist_ri: "rightHand",

  j_shoulder_le: "leftArmUpper",
  j_shouldertwist_le: "leftArmUpper",
  j_elbow_le: "leftArmLower",
  j_wristtwist_le: "leftArmLower",
  j_wrist_le: "leftHand",

  j_hip_ri: "rightLegUpper",
  j_hiptwist_ri: "rightLegUpper",
  j_knee_ri: "rightLegLower",
  j_ankle_ri: "rightFoot",

  j_hip_le: "leftLegUpper",
  j_hiptwist_le: "leftLegUpper",
  j_knee_le: "leftLegLower",
  j_ankle_le: "leftFoot",

  // The weapon in the hands. CoD gives it a location so that a round stopped by
  // somebody's rifle does not count as a body shot.
  j_gun: "gun",
};

/**
 * What a hit on `bone` counts as: its own location, or its nearest ancestor's.
 *
 * `parentOf` walks the skeleton upwards. Returns `"none"` for a joint with no boxed
 * ancestor at all, which on a real body means a tag that skins nothing — and which
 * the completeness test refuses for anything that does skin something.
 */
export function hitLocationOf(bone: string, parentOf: (bone: string) => string | undefined): HitLocation {
  const seen = new Set<string>();
  let at: string | undefined = bone;
  while (at !== undefined && !seen.has(at)) {
    const found = Object.hasOwn(HIT_BONES, at) ? HIT_BONES[at] : undefined;
    if (found !== undefined) {
      return found;
    }
    seen.add(at);
    at = parentOf(at);
  }
  return "none";
}

/** Whether this joint carries a hitbox of its own, as against folding into one. */
export function isHitBone(bone: string): boolean {
  return Object.hasOwn(HIT_BONES, bone);
}
