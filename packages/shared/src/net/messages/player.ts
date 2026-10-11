// A player's simulation state on the wire: what `Player.snapshot()` produces and
// `Player.restore()` takes back.
//
// Not a message of its own — a snapshot carries one of these per player. It is
// separate because it is the one description that has to track the simulation
// field for field: `satisfies Codec<...>` on each schema below is what turns a
// field added to sim/ and forgotten here into a typecheck failure rather than a
// state that silently stops arriving.

import { array, bool, enumOf, nullable, quant, scaled, struct, uint, union, type Codec } from "../codec/schema.js";
import { CLIP_ROLES, type ClipRole } from "../../sim/weaponDef.js";
import { MAX_BURST, MAX_CLIP_RATE, MAX_CLIP_SIZE, MAX_FIRE_TIME, WEAPON_STATES, type WeaponData } from "../../sim/weapon.js";
import { KICK_LIMIT, KICK_SPEED_LIMIT, VIEW_KICK_LIMIT, VIEW_KICK_SPEED_LIMIT } from "../../sim/recoil.js";
import { EYE_PATHS, type MovementState } from "../../sim/movement.js";
import { MAX_HEALTH, type PlayerState } from "../../sim/player.js";
import { MAX_ATTACHMENT_SLOTS, MAX_FITTED_ATTACHMENTS, MAX_WEAPONS } from "../../sim/weaponRegistry.js";
import { MAX_POINTS } from "../../game/matchValues.js";
import { axis, climb, combatTimer, eyeTimer, landTimer, metres, pitch, shortTimer, unit, vec3, weaponTimer, yaw } from "./fields.js";

export const movementSchema = struct({
  feet: vec3,
  velocity: vec3,
  yaw,
  pitch,
  grounded: bool,
  /** A bit for everybody not in a jump, and the takeoff's height for whoever is. */
  jumpFrom: nullable(metres),
  landing: landTimer,
  /**
   * Which move owns the player's steps: two bits for the walk nearly everybody
   * is in, and a climb's target and timers or a ladder's yaw only while
   * somebody is on one.
   */
  move: union("kind", {
    walk: {},
    mantle: { target: vec3, left: shortTimer, rise: climb, over: bool },
    ladder: { facing: yaw },
  }),
  /**
   * Two bits standing or crouched, and a lying body's heading and torso pitch
   * only while somebody lies. A bit more for an eye at rest, and its path and
   * clock while it moves: a standing player costs three bits here.
   */
  stance: union("kind", {
    stand: {},
    crouch: {},
    prone: { heading: yaw, torso: pitch },
  }),
  eyeShift: nullable(struct({ path: enumOf(EYE_PATHS), elapsed: eyeTimer })),
  ladderLock: bool,
  sinceJump: shortTimer,
  jumpHeld: bool,
  /**
   * The pose blends: how much of a gait is under way, and how far off the ground the
   * pose is. Smoothed booleans rather than derived from speed, because a player
   * crosses IDLE_SPEED in one tick — see GAIT_BLEND.
   */
  gait: unit,
  airborne: unit,
  /**
   * The direction of travel, smoothed. `axis` rather than `unit` because it is
   * signed and because standing still has to encode as an exact zero — a body with
   * a thousandth of a heading it never had would never quite settle.
   */
  travelForward: axis,
  travelRight: axis,
  /** The run-cycle phase. 8 bits is 1/256 of a cycle, ~7 ms of stride at STRIDE_PERIOD. */
  stride: unit,
}) satisfies Codec<MovementState>;

const POINTS_BITS = Math.log2(MAX_POINTS + 1);

// Both caps are powers of two, so each is exactly its own field: sixteen slots
// in four bits, and a count of nought to three in two.
const ATTACHMENT_SLOT_BITS = Math.log2(MAX_ATTACHMENT_SLOTS);
/** Eight bits: `MAX_WEAPONS`, which the registry holds a catalogue to. */
const WEAPON_INDEX_BITS = Math.log2(MAX_WEAPONS);
const FITTED_COUNT_BITS = Math.log2(MAX_FITTED_ATTACHMENTS + 1);

/**
 * How hot the weapon is, and the kick: degrees and degrees a second. Every kick
 * range is a clamp `sim/recoil.ts` already holds the simulation to, so the two
 * cannot disagree about what is carryable; the widths give 1/32 of a degree of
 * kick and two degrees a second of kick speed. `scaled` rather than `quant`,
 * because a gun at rest is the common case and decoding it as a thirtieth of a
 * degree of kick would give every player a small permanent bias in their aim.
 *
 * The first is a **fraction** rather than an angle — `WeaponData.spread` is how
 * far between the weapon's own minimum and maximum it has opened, and
 * `shotSpread` is what turns that into degrees. Ten bits for a number in [0, 1]
 * is far more than it needs, and stays ten because the widths below add to
 * **exactly 112 bits**: the snapshot's event tail follows them, and a player's
 * state that grew or shrank by a number of bits not divisible by eight would
 * shift every count in `tests/netPackets.test.ts` by the padding rather than by
 * anything real. 10 + (12 + 12 + 11 + 11) + (12 + 12 + 16 + 16).
 */
const spreadCone = quant(0, 1, 10);
const kickAngle = scaled(KICK_LIMIT, 12);
const kickSpeed = scaled(KICK_SPEED_LIMIT, 11);
/** The aim's own kick: a twelfth of the gun's range in the same twelve bits, so 1/64°. */
const viewKickAngle = scaled(VIEW_KICK_LIMIT, 12);
/**
 * And the speed it is travelling at. Sixteen bits rather than twelve because the
 * range has to clear four times the largest impulse in the catalogue — the fall
 * back to the aim keeps accelerating the whole way home — and because an error
 * here is an *angle* error by the time the view lands: at twelve bits the quantum
 * would be 8°/s, which is most of a degree over a bounce.
 */
const viewKickSpeed = scaled(VIEW_KICK_SPEED_LIMIT, 16);

export const weaponSchema = struct({
  state: enumOf(WEAPON_STATES),
  input: struct({ trigger: bool, ads: bool, sprint: bool }),
  timer: weaponTimer,
  /** What `timer` started at: a countdown cannot say how far through a state is on its own. */
  span: weaponTimer,
  /** Ten bits. No magazine is near 1023 rounds, and the registry refuses one that is. */
  ammo: uint(Math.log2(MAX_CLIP_SIZE + 1)),
  cooldown: quant(0, MAX_FIRE_TIME, 10),
  pressed: bool,
  burstLeft: uint(Math.log2(MAX_BURST + 1)),
  ads: unit,
  reloadQueued: bool,
  refillAt: nullable(weaponTimer),
  /**
   * The shot counter, which wraps at 16 bits exactly as the simulation's does —
   * a server reads a shot out of its own replay by watching this advance, so the
   * two ends have to wrap at the same place or a corrected client would report a
   * burst of 65535.
   */
  fired: uint(16),
  /**
   * How hot the weapon is, and the kick. Both are simulation now rather than the
   * client drawing effect they were: the server decides what a shot hit, and it
   * hits inside a cone this sets the width of, along the player's intent *plus*
   * this kick — so a client that predicted either differently would watch its own
   * crosshair argue with its hit markers.
   */
  spread: spreadCone,
  kick: struct({ pitch: kickAngle, yaw: kickAngle, pitchSpeed: kickSpeed, yawSpeed: kickSpeed }),
  /**
   * The kick that is the aim. Separate from `kick` above because the two are
   * different quantities off one shot — that one rocks the model, this one bends
   * the round — and because this is the one a correction has to land exactly: a
   * client whose view kick drifted from the server's would see its own crosshair
   * disagree with its hit markers.
   */
  viewKick: struct({ pitch: viewKickAngle, yaw: viewKickAngle, pitchVel: viewKickSpeed, yawVel: viewKickSpeed }),
  clip: nullable(
    struct({
      role: enumOf(CLIP_ROLES) as Codec<ClipRole>,
      /** Seconds into the clip. No viewmodel animation runs anywhere near 32 s. */
      time: quant(0, 32, 14),
      /** A clip is stretched to fit its state; it never plays backwards, and the simulation holds it to this ceiling. */
      rate: quant(0, MAX_CLIP_RATE, 10),
      loop: bool,
    }),
  ),
}) satisfies Codec<WeaponData>;

/**
 * Which weapon is held travels as its **catalogue index**, not its name: this
 * rides in every snapshot for every player every tick, where `str(8)` would cost
 * ~72 bits against this 9. Both ends fetched the same catalogue over HTTP, and a
 * game server refuses a join whose `catalogHash` disagrees (messages/session.ts),
 * which is what makes an index safe to send at all — the failure it prevents is a
 * player silently holding the wrong gun.
 *
 * 8 bits caps the catalogue at 256 weapons. `attachments` names the fitted ones
 * by their slot in that weapon's own list, counted first: two bits of count and
 * four bits per slot, so the usual one attachment costs six bits and nothing
 * costs two. A mask would have been one bit per slot whether fitted or not —
 * sixteen bits of every snapshot to carry at most three of them, and a wider
 * field again the next time a weapon's list grew.
 */
export const playerStateSchema = struct({
  movement: movementSchema,
  weaponIndex: nullable(uint(WEAPON_INDEX_BITS)),
  attachments: array(uint(ATTACHMENT_SLOT_BITS), FITTED_COUNT_BITS),
  weapon: nullable(weaponSchema),
  /**
   * The weapon on their back, and which of the two is in hand: ten-odd bits so a
   * weapon a server hands over mid-life is never something a client guesses at.
   * No state for the spare — it is either fresh (a new `armed`) or exactly as the
   * client already simulated it, since it is stepped by nothing while carried.
   */
  slot: uint(1) as Codec<0 | 1>,
  spareIndex: nullable(uint(WEAPON_INDEX_BITS)),
  spareAttachments: array(uint(ATTACHMENT_SLOT_BITS), FITTED_COUNT_BITS),
  armed: uint(3),
  swapping: bool,
  stowed: bool,
  /**
   * The side, as an index into the gametype's `teams`. Three bits, so eight sides
   * — every mode the games ship has two, and a name would have cost ~48 bits in
   * every snapshot for every player.
   */
  team: nullable(uint(3)),
  /**
   * What is left of them. Ten bits caps `CombatRules.maxHealth` at 1023, which is
   * ten times the games' own — and an integer rather than a quantized range
   * because health *is* a whole number: `Player.hurt` rounds, so the wire is
   * carrying the simulation's value and not an approximation of it.
   */
  health: uint(Math.log2(MAX_HEALTH + 1)),
  dead: bool,
  respawnIn: combatTimer,
  /** Twenty bits: `MAX_POINTS`, a little over a million. In every snapshot, so no wider. */
  points: uint(POINTS_BITS),
}) satisfies Codec<PlayerState>;
