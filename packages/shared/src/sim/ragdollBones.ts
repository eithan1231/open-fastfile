// What a corpse is made of: sixteen segments, fifteen joints, one table.
//
// Every exported body — 26 of them across three games, and whatever the importer
// produces next — hangs from the same chain of joints. 265 distinct joints exist
// across the corpus and only 87 are common to all of them, but the differences are
// facial detail, cloth and attachment tags; the sixteen bones named here are in
// every one, and so is every hit box that folds onto them. That is what lets one
// table stand in for per-body ragdoll data, exactly as `HIT_BONES` stands in for
// per-body hit boxes one file over.
//
// Plain data, in `sim/` rather than in `physics/`, for the reason `weaponDef.ts`
// and `characterDef.ts` are here: `net/messages/` has to know how many
// orientations travel and in what order without importing a physics engine, and a
// physics engine in the module that describes the wire would put Rapier in every
// process that decodes a packet.
//
// -- What is NOT here ---------------------------------------------------------
//
// Which bones each segment swallows. A segment owns every boxed bone that reaches
// it first walking *up the real skeleton*, which is `hitLocationOf`'s rule applied
// to a different set of roots — and deriving it beats writing it down, because the
// skeleton is the thing that is actually true. It also catches what a list would
// have got wrong: `j_hiptwist_le` reads like a pelvis joint and is a child of
// `j_hip_le`, so it is thigh geometry, and a hand-written table put it in the
// trunk. See `segmentOf`.

import type { HitLocation } from "./hitLocations.js";

/**
 * The segments, in the order they are built.
 *
 * The order **is** a format, twice over: a spawn carries one orientation per
 * segment in this order, and Rapier's determinism is a promise about the same
 * order of body, collider and joint construction. Append, never insert, never
 * sort.
 *
 * Thirteen of the sixteen are spelled exactly like their `HitLocation`, and that
 * is deliberate — it is what makes "the round hit `leftHand`, so push `leftHand`"
 * a lookup rather than a mapping. The three that are not are the trunk, where the
 * hit locations collapse: `torsoLower` covers both `pelvis` and `abdomen`, and
 * `torsoUpper` is `chest`. `neck` and `helmet` fold into the one skull.
 */
export const RAGDOLL_SEGMENTS = [
  "pelvis",
  "abdomen",
  "chest",
  "head",
  "leftArmUpper",
  "leftArmLower",
  "leftHand",
  "rightArmUpper",
  "rightArmLower",
  "rightHand",
  "leftLegUpper",
  "leftLegLower",
  "leftFoot",
  "rightLegUpper",
  "rightLegLower",
  "rightFoot",
] as const;

export type RagdollSegment = (typeof RAGDOLL_SEGMENTS)[number];

/**
 * The bone each segment's frame *is*.
 *
 * `chest` is `back_mid` rather than `j_spine4`, which is the joint a reader
 * reaches for first. The chain is `back_low → j_spineupper → back_mid → j_spine4 →
 * j_neck → j_head`, so rooting the chest at `j_spine4` would leave `back_mid`'s own
 * box folding *down* into the abdomen and give a chest made of nothing but the
 * clavicles. Rooted at `back_mid`, the ribcage, the clavicles and the neck are one
 * body and the abdomen is the belly, which is what a chest is.
 */
export const SEGMENT_BONES: Readonly<Record<RagdollSegment, string>> = {
  pelvis: "pelvis",
  abdomen: "back_low",
  chest: "back_mid",
  head: "j_head",
  leftArmUpper: "j_shoulder_le",
  leftArmLower: "j_elbow_le",
  leftHand: "j_wrist_le",
  rightArmUpper: "j_shoulder_ri",
  rightArmLower: "j_elbow_ri",
  rightHand: "j_wrist_ri",
  leftLegUpper: "j_hip_le",
  leftLegLower: "j_knee_le",
  leftFoot: "j_ankle_le",
  rightLegUpper: "j_hip_ri",
  rightLegLower: "j_knee_ri",
  rightFoot: "j_ankle_ri",
};

/**
 * The reverse of `SEGMENT_BONES`, built once — plus `j_mainroot`, which sits on
 * `pelvis` at bind. No other game skins a vertex to it; Advanced Warfare's costume
 * parts (pants, gear, the exo's hips) are rooted there and do, and those are hips.
 */
const SEGMENT_OF_BONE: ReadonlyMap<string, RagdollSegment> = new Map([
  ...RAGDOLL_SEGMENTS.map((segment) => [SEGMENT_BONES[segment], segment] as const),
  ["j_mainroot", "pelvis"] as const,
]);

/**
 * Which segment a bone belongs to: its own, or its nearest segmented ancestor's.
 *
 * The same shape as `hitLocationOf`, and for the same reason — a body carries far
 * more joints than anything wants to model, and every one of them has to end up
 * somewhere or a part of the body is missing from the volumes it is made of.
 *
 * Returns undefined for a bone above that (`tag_origin`, the `unit-scale` root),
 * which own no mass and are not part of a corpse.
 */
export function segmentOf(bone: string, parentOf: (bone: string) => string | undefined): RagdollSegment | undefined {
  const seen = new Set<string>();
  let at: string | undefined = bone;
  while (at !== undefined && !seen.has(at)) {
    const found = SEGMENT_OF_BONE.get(at);
    if (found !== undefined) {
      return found;
    }
    seen.add(at);
    at = parentOf(at);
  }
  return undefined;
}

/**
 * How far a joint may turn about each of its own axes, radians.
 *
 * **These are three independent ranges, not a cone and a twist**, because that is
 * what Rapier gives: a spherical joint's limits are set per angular axis, so ±θ on
 * all three admits θ·√3 about a diagonal. A figure written as "a 45° cone" and
 * applied here would be half again as loose as it read —
 * `shared/tests/physicsDeterminism.test.ts` measures exactly that.
 *
 * A CoD bone runs along its own **local X** (negated on the body's right, which is
 * mirrored), so `x` is the twist down the limb and `y`/`z` are the two ways it
 * bends. A hinge is this with two of the three pinned near zero.
 */
export interface SegmentLimits {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  readonly z: readonly [number, number];
}

/** Degrees to radians. A multiply by a constant, not a call to a transcendental. */
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Both ways by the same amount, which is what a symmetric joint wants. */
const even = (degrees: number): readonly [number, number] => [-rad(degrees), rad(degrees)];

/** Pinned. A hinge's two off-axes, and never exactly zero — a solver wants somewhere to go. */
const PINNED = even(3);

/**
 * Each segment's parent and the joint between them, in construction order.
 *
 * `pelvis` is the root and has none. The parent is written down rather than derived
 * from the skeleton so that this file stands on its own — `ragdollTable.test.ts`
 * checks every entry against the real bodies, which is the same guarantee with the
 * readability left in.
 *
 * **Which axis an elbow bends about is the one number here taken on convention
 * rather than measured**: the bone runs along X, so the bend is Y or Z, and this
 * says Z. It is wrong in the way that is cheapest to find — an arm that folds
 * sideways is obvious the first time a body falls over — and it is one field to
 * change. Phase 3 is where it is looked at.
 */
export const SEGMENT_JOINTS: Readonly<Record<RagdollSegment, { readonly parent: RagdollSegment; readonly limits: SegmentLimits } | null>> = {
  pelvis: null,

  // The trunk barely bends, and a corpse that folds at the waist reads as boneless.
  abdomen: { parent: "pelvis", limits: { x: even(12), y: even(12), z: even(18) } },
  chest: { parent: "abdomen", limits: { x: even(10), y: even(10), z: even(14) } },
  // A neck twists further than it nods.
  head: { parent: "chest", limits: { x: even(45), y: even(30), z: even(40) } },

  // Shoulders are still the loosest joint in a body, and an arm is meant to trail —
  // but trailing is not the same as windmilling, and this is where that line sits.
  leftArmUpper: { parent: "chest", limits: { x: even(25), y: even(50), z: even(50) } },
  rightArmUpper: { parent: "chest", limits: { x: even(25), y: even(50), z: even(50) } },
  // An elbow bends one way only, and the sides are mirrored, so the range is too.
  leftArmLower: { parent: "leftArmUpper", limits: { x: PINNED, y: PINNED, z: [-rad(120), 0] } },
  rightArmLower: { parent: "rightArmUpper", limits: { x: PINNED, y: PINNED, z: [0, rad(120)] } },
  leftHand: { parent: "leftArmLower", limits: { x: even(15), y: even(20), z: even(50) } },
  rightHand: { parent: "rightArmLower", limits: { x: even(15), y: even(20), z: even(50) } },

  // **Legs are the rigid half of a corpse, and deliberately so.** A body knocked
  // backwards should pivot about its feet and go over in one piece; legs as free as
  // arms give a corpse that sits down into a heap instead, with the knees arriving
  // before the shoulders. These are a good deal tighter than a living hip and knee
  // really are, and that is the trade: a dead body is not using them.
  leftLegUpper: { parent: "pelvis", limits: { x: even(10), y: even(20), z: even(30) } },
  rightLegUpper: { parent: "pelvis", limits: { x: even(10), y: even(20), z: even(30) } },
  // A knee bends the opposite way to an elbow, and a dead one does not fold double.
  leftLegLower: { parent: "leftLegUpper", limits: { x: PINNED, y: PINNED, z: [0, rad(85)] } },
  rightLegLower: { parent: "rightLegUpper", limits: { x: PINNED, y: PINNED, z: [-rad(85), 0] } },
  leftFoot: { parent: "leftLegLower", limits: { x: even(6), y: even(8), z: even(15) } },
  rightFoot: { parent: "rightLegLower", limits: { x: even(6), y: even(8), z: even(15) } },
};

/**
 * Kilograms per segment.
 *
 * Dempster's segment fractions of a 72 kg body, written out rather than derived
 * from each collider's volume — and that is the point of them being explicit. A
 * collider comes from the body's own hit box, a hit box comes from its skin
 * weights, and the three `mp_body_ally_ghillie_*_sniper` bodies skin a hood to
 * `j_head` and derive a head half a metre across (docs/engine/collision.md). A
 * density-derived mass would give one of them a twelve-kilogram skull and a corpse
 * that lands face first every time, on three bodies out of twenty-six, for a reason
 * nobody would find.
 */
export const SEGMENT_MASS: Readonly<Record<RagdollSegment, number>> = {
  pelvis: 11.0,
  abdomen: 8.5,
  chest: 16.0,
  head: 5.0,
  leftArmUpper: 2.1,
  leftArmLower: 1.16,
  leftHand: 0.44,
  rightArmUpper: 2.1,
  rightArmLower: 1.16,
  rightHand: 0.44,
  leftLegUpper: 7.5,
  leftLegLower: 3.5,
  leftFoot: 1.0,
  rightLegUpper: 7.5,
  rightLegLower: 3.5,
  rightFoot: 1.0,
};

/** What the sixteen come to. Asserted, so a segment added without a mass is a test failure. */
export const RAGDOLL_MASS = 71.9;

/**
 * How hard each segment is to spin, and it is the main dial on how a corpse reads.
 *
 * Joint limits say where a limb may go; damping says how fast it gets there. Limits
 * alone give a body that reaches its stops and stays there, arms and legs snapping
 * from one extreme to the other — flailing, which is the single most common way a
 * ragdoll looks wrong.
 *
 * **Legs are damped three times as hard as arms**, and that asymmetry is the whole
 * shape of a fall. A body knocked backwards should go over about its feet in one
 * piece; legs as loose as arms fold at the knee first and the corpse sits down into
 * a heap. Arms are left loose because an arm *should* trail — it is the part that
 * arrives last and sells the whole thing.
 */
export const SEGMENT_ANGULAR_DAMPING: Readonly<Record<RagdollSegment, number>> = {
  pelvis: 5,
  abdomen: 5,
  chest: 4.5,
  head: 3,
  leftArmUpper: 4,
  leftArmLower: 3.5,
  leftHand: 3,
  rightArmUpper: 4,
  rightArmLower: 3.5,
  rightHand: 3,
  leftLegUpper: 10,
  leftLegLower: 11,
  leftFoot: 13,
  rightLegUpper: 10,
  rightLegLower: 11,
  rightFoot: 13,
};

/**
 * Air, near enough. Small on purpose: a corpse thrown backwards is *meant* to
 * travel, and damping the whole body linearly stops it in its tracks and gives a
 * death with no follow-through.
 */
export const RAGDOLL_LINEAR_DAMPING = 0.05;

/**
 * Solver iterations beyond the world's own, per segment.
 *
 * Fifteen joints in a loop-free chain still need more than the default four passes
 * to hold together under a hard impulse; below this, a hip visibly stretches away
 * from its pelvis on a sniper hit. Per body rather than on the world, so that one
 * corpse's stiffness is not an integration parameter every other kind inherits —
 * `physics/engine.ts` is the only place allowed to touch those.
 */
export const RAGDOLL_SOLVER_ITERATIONS = 4;

/**
 * How far ahead a segment looks for a surface it is about to pass through, metres.
 *
 * Continuous collision, softly. A corpse made of a player who was already falling
 * arrives fast: thirty metres of drop is 33 m/s, which at a sixtieth of a second is
 * 0.55 m of travel in one step — further than most floors are thick, so the body
 * goes straight through the map and keeps going. Measured: a test corpse dropped
 * down a stairwell ended nine metres under the world.
 *
 * Soft rather than full CCD because full is a per-pair sweep and this is sixteen
 * bodies; soft prediction costs a widened broad phase and catches the case that
 * actually happens, which is a fast body against static geometry.
 */
export const RAGDOLL_CCD_PREDICTION = 0.25;

/**
 * What a round does to a body, in two parts — and the two parts are the whole
 * reason a death reads as "shot" rather than "dropped".
 *
 * A single impulse at the bone that was hit cannot do both jobs. Big enough to throw
 * the body, it tears the limb off its joint; small enough to look right on the limb,
 * it moves the body not at all. Nor is one number enough to be fair across segments:
 * the same push is 61 m/s into a 0.44 kg hand and 1.7 m/s into a 16 kg chest.
 *
 * So a round delivers:
 *
 *  - a **body knock** — a speed, along the round, given to *every* segment equally,
 *    which is what carries the whole corpse backwards and makes it fall the way it
 *    was shot; and
 *  - a **local knock** — a further speed given only to the segment that was hit,
 *    which is the snap. Expressed as a speed rather than an impulse so that it is
 *    the same *visible* whip wherever it lands: the impulse is that speed times
 *    whatever the segment weighs.
 *
 * A head shot with a sniper is then exactly the sequence you would want: the head
 * goes first and fastest, the chest follows it through the neck a moment later, and
 * the arms — the loosest joints and the lightest damping — arrive last.
 *
 * These are feel numbers, and the only ones in this file that are. A rifle round
 * (30) knocks a body back at 0.8 m/s and whips the bone it hit at 2.7; a sniper
 * (~100) is held to the caps, 2.6 and 6.5.
 */
export const BODY_KNOCK_PER_DAMAGE = 0.028;
export const MAX_BODY_KNOCK = 2.6;
export const LOCAL_KNOCK_PER_DAMAGE = 0.09;
export const MAX_LOCAL_KNOCK = 6.5;

/** How fast the whole corpse is carried along the round, m/s. */
export function bodyKnock(damage: number): number {
  return Math.min(MAX_BODY_KNOCK, Math.max(0, damage) * BODY_KNOCK_PER_DAMAGE);
}

/**
 * How much of the body knock a segment takes, by how high up the body it sits:
 * `KNOCK_AT_FEET` at the soles, `KNOCK_AT_HEAD` at the crown, straight line between.
 *
 * **This is what makes a corpse fall the way it was shot.** Given to every segment
 * equally, the knock slides the whole body backwards — feet included — and which
 * way it then topples is decided by whatever lean the last animation frame happened
 * to have. Measured: a hand shot ended up a metre *toward* the shooter.
 *
 * Weighted by height it becomes a torque about the feet instead, which is what a
 * round actually does to somebody standing up: the chest goes and the soles do not,
 * so the body rotates over and goes down backwards. It is also half of why the legs
 * read as rigid — they are barely pushed, so they stay under the body and it rolls
 * across them rather than folding into them.
 *
 * The average over a standing body is near 1, so the *amount* of knock a round
 * delivers is unchanged; only where it lands is.
 */
export const KNOCK_AT_FEET = 0.25;
export const KNOCK_AT_HEAD = 1.8;

/**
 * The extra push on the bone that was hit, newton-seconds.
 *
 * Scaled by that segment's own mass, so a hand and a chest are whipped at the same
 * speed rather than with the same force — which is what stops a hand shot launching
 * a hand and a chest shot doing nothing at all.
 */
export function localKnock(damage: number, segment: RagdollSegment): number {
  return Math.min(MAX_LOCAL_KNOCK, Math.max(0, damage) * LOCAL_KNOCK_PER_DAMAGE) * SEGMENT_MASS[segment];
}

/**
 * The largest half-extent a segment's collider may have, metres. Absent is uncapped.
 *
 * **Only the head has an argument for one**, and the argument is specific: a hit box
 * comes from a body's own skin weights, and the three `mp_body_ally_ghillie_*_sniper`
 * bodies skin a hood to `j_head` and derive a head 0.49 m across
 * (docs/engine/collision.md). As a cuboid that puts a chin through the floor.
 *
 * Measured rather than guessed: an ordinary body's head comes out at 0.152 half —
 * a helmet and night vision included — so 0.16 leaves every normal body untouched
 * and takes a third off the three that are wrong.
 *
 * **The hit box itself is not touched**, and the difference matters. That document
 * has already decided a silently shrunk hit box is the worse lie, and it is right:
 * that is a question about who dies. This is a different question about the same
 * number — whether a corpse's chin ends up under the floor — and a visible artefact
 * on three bodies is worth clamping where a fairness difference is not.
 *
 * Nothing else is capped, and an earlier draft capping everything at 0.18 is why
 * this says so: it truncated every long bone in the body, turning a 0.48 m shin
 * into a 0.36 m one on every single body, to fix a head.
 */
export const MAX_SEGMENT_HALF_EXTENT: Partial<Readonly<Record<RagdollSegment, number>>> = { head: 0.16 };

/**
 * Where a round that landed on `location` pushes.
 *
 * Nineteen locations, sixteen segments: the trunk collapses, and `gun` is not a
 * part of a body at all — a round stopped by somebody's rifle pushes the hand
 * holding it.
 */
export const SEGMENT_FOR_LOCATION: Readonly<Record<HitLocation, RagdollSegment>> = {
  none: "chest",
  helmet: "head",
  head: "head",
  neck: "head",
  torsoUpper: "chest",
  torsoLower: "abdomen",
  rightArmUpper: "rightArmUpper",
  rightArmLower: "rightArmLower",
  rightHand: "rightHand",
  leftArmUpper: "leftArmUpper",
  leftArmLower: "leftArmLower",
  leftHand: "leftHand",
  rightLegUpper: "rightLegUpper",
  rightLegLower: "rightLegLower",
  rightFoot: "rightFoot",
  leftLegUpper: "leftLegUpper",
  leftLegLower: "leftLegLower",
  leftFoot: "leftFoot",
  gun: "rightHand",
};
