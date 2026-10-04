// What a weapon *is*, as the exporter describes it in its GLB's scene extras
// (scripts/cod/viewmodel.py). Plain data: the numbers a server needs to validate
// a shot and the clip names a client needs to draw one, with no three.js and no
// glTF. src/scene/viewmodel.ts reads these out of a loaded asset; the state
// machine that runs on them is src/engine/player/weapon.ts.

import type { HitLocation } from "./hitLocations.js";

import { unitsToMetres } from "./units.js";

/**
 * How far a bullet reaches, metres: the games' own default `bulletRange` of 8192
 * units, and longer than any multiplayer map.
 *
 * Here rather than on either end because **both trace with it** — a server to
 * judge a round, a client to predict one — and two spellings of a bullet's reach
 * is a disagreement about every clean miss. The exporter does not copy the real
 * field out yet, so this is the default until it does. The ranges a `WeaponDef`
 * *does* carry are not it: `damage.maxRange`/`minRange` are where falloff starts
 * and ends, 20 m and 36 m on an M4.
 */
export const BULLET_RANGE = unitsToMetres(8192);

/** The `viewmodel` scene extras this reader understands (scripts/cod/viewmodel.py FORMAT_VERSION). */
export const WEAPON_FORMAT_VERSION = 5;

/**
 * Every clip a weapon can name. A list rather than a bare union because the wire
 * format encodes a role as its index here (net/messages/player.ts): the order is part
 * of the protocol, so append rather than insert.
 */
export const CLIP_ROLES = [
  "idle",
  "emptyIdle",
  "fire",
  "lastShot",
  "reload",
  "reloadEmpty",
  "raise",
  "firstRaise",
  "drop",
  "quickRaise",
  "quickDrop",
  "sprintIn",
  "sprintLoop",
  "sprintOut",
  "adsFire",
  "adsLastShot",
  "adsUp",
  "adsDown",
  "rechamber",
  "adsRechamber",
  "reloadStart",
  "reloadEnd",
] as const;

export type ClipRole = (typeof CLIP_ROLES)[number];

/** How long each state lasts in the game, in seconds (the weapon file's `*Time` values). */
export type WeaponTimes = Partial<
  Record<
    | "fire"
    | "fireInterruptible"
    | "rechamber"
    | "reload"
    | "reloadEmpty"
    | "reloadAdd"
    | "reloadStart"
    | "reloadStartAdd"
    | "reloadEnd"
    | "raise"
    | "firstRaise"
    | "drop"
    | "quickRaise"
    | "quickDrop"
    | "sprintIn"
    | "sprintLoop"
    | "sprintOut"
    | "adsIn"
    | "adsOut"
    | "adsReloadOut",
    number
  >
>;

/**
 * What one round takes off, and how far it carries.
 *
 * `max` inside `maxRange`, `min` past `minRange`, interpolated between the two.
 * Call of Duty spells `max` as plain `damage` and has no `maxDamage` at all, so
 * a reader looking for that name finds nothing and a gun does no damage.
 *
 * The two ranges are in **CoD units** (39.37 to the metre, `sim/units.ts`),
 * as every distance the exporter copies out of a weapon file is: an M4's 800 is
 * 20 m, not 800 m.
 */
export type WeaponDamage = Partial<Record<"max" | "min" | "maxRange" | "minRange" | "melee", number>>;

/**
 * The cone a shot leaves in, in degrees.
 *
 * Hip spread starts at the stance's minimum, grows by `fireAdd` a shot and by
 * `moveAdd` while moving, is clamped at the stance's maximum and decays back at
 * `decayRate` degrees a second (times `duckedDecay` or `proneDecay`). `ads` is a
 * fixed cone that replaces all of it while aiming, and is 0 on everything but a
 * shotgun and a few pistols — a weapon whose `ads` is 0 is perfectly accurate.
 */
export type WeaponSpread = Partial<
  Record<
    | "ads"
    | "hipStandMin"
    | "hipStandMax"
    | "hipDuckedMin"
    | "hipDuckedMax"
    | "hipProneMin"
    | "hipProneMax"
    | "fireAdd"
    | "turnAdd"
    | "moveAdd"
    | "decayRate"
    | "duckedDecay"
    | "proneDecay",
    number
  >
>;

/**
 * The damage multiplier per hit location: 1.4 on an M4's head, 0 on `gun`.
 *
 * Keyed by name rather than indexed by `HIT_LOCATIONS` position so that it merges
 * key by key like `times` — an attachment that changes the head must not wipe the
 * rest. **Empty** for Ghosts, whose 22 multipliers are in an order of its own
 * that the exporter does not map yet, so a reader treating an absent location as
 * 0 disarms every IW6 weapon: absent means "this game did not say", and the
 * multiplier is 1.
 */
export type WeaponLocationDamage = Partial<Record<HitLocation, number>>;

export interface WeaponClipInfo {
  /** Seconds: frames / fps. The glTF's own keys can say less (a one-frame idle says zero). */
  duration: number;
  looped: boolean;
  /** Notetracks: [name, seconds into the clip]. Sounds, rumble and events such as `interruptible`. */
  notes: [string, number][];
}

/**
 * What a weapon sounds like, as **alias names** the weapon file itself carries.
 *
 * Not derived from the weapon's id, and the M4 is why: `m4_mp` and `iw5_m4_mp`
 * both name `weap_m4carbine_*`, so a prefix rule works on most of the 53 guns in
 * a game and silently fails on the rest — the plausible-wrong-result class this
 * repo asks for data rather than a convention. Every field is optional because
 * Ghosts has none of them: its weapon sounds are not recoverable at all
 * (docs/cod/games.md), so a weapon without a field is **silent** rather than
 * falling back to another gun's — an invented alias is a wrong sound, and a
 * missing one is nothing at all.
 */
export interface WeaponSounds {
  /** Somebody else's round leaving, positional. Its `with` layer is the distant report. */
  fire?: string;
  /** The listener's own round leaving. Played flat, whatever the alias says (`_plr` is not the test). */
  firePlayer?: string;
  /** The trigger on an empty magazine, the same two ways round. */
  emptyFire?: string;
  emptyFirePlayer?: string;
  /**
   * A peer's whole reload, as the one alias the game plays for a body at a
   * distance. The listener's own reload is not this: it is the notetracks its
   * clip carries, below.
   */
  reload?: string;
  reloadEmpty?: string;
  melee?: string;
  meleePlayer?: string;
  /**
   * What a round of this sounds like arriving: `bullet_large`, `bullet_small`,
   * `bullet_ap`, and a surface name concatenated onto it. The weapon file's own
   * `impactType`, which is also an FX table's name in the game.
   */
  impact?: string;
  /**
   * `{notetrack: alias}` — the weapon file's `notetrackSoundMap`.
   *
   * This is what makes a first-person reload a *sequence* rather than one sound:
   * `WeaponClipInfo.notes` already carries every notetrack with its time into the
   * clip, and this says which of them are sounds. Nearly an identity map (33 of
   * 8,875 pairs across three games are not), but it is also the only thing that
   * separates `weap_m4carbine_clipin_plr` from `viewmodel_small` and
   * `interruptible` without a keep-list per game.
   */
  notes?: Record<string, string>;
}

/** A weapon as the exporter describes it in its GLB. */
export interface WeaponDef {
  game: string;
  weapon: string;
  gun: string;
  roles: Partial<Record<ClipRole, string>>;
  clips: Record<string, WeaponClipInfo>;
  times: WeaponTimes;
  clipSize: number;
  /** "Full Auto", "Single Shot", "3-Round Burst", ... */
  fireType: string;
  /**
   * Rounds loaded at a time by a reload that feeds one at a time — a shotgun's
   * tube, a lever gun's gate. **0 is a magazine**, which is every other weapon.
   *
   * It is a count rather than the weapon file's `segmentedReload` flag because
   * the flag alone is not enough to run one: `reloadAmmoAdd` says how many go in
   * per loop, and the two are only ever meaningful together. A segmented reload
   * is `reloadStart`, then a `reload` loop per load, then `reloadEnd`, and the
   * player can break out of it after any load — which is what `reloadTime`
   * (0.666 s for a SPAS-12) times, not the whole thing.
   */
  roundsPerLoad: number;
  /**
   * The action is worked between shots: a bolt, a pump or a lever. `rechamber`
   * is how long that takes and is the bulk of the time between two shots — an
   * MSR's `fire` is 0.05 s and its `rechamber` 0.865 s — so a weapon read
   * without this fires as fast as the trigger moves.
   *
   * Not inferred from a `rechamber` clip: MW3's default weapon and its `xm25_mp`
   * name one and are not bolt-action.
   */
  boltAction: boolean;
  /** The ADS field of view, in the game's `cg_fov` units; null when the weapon does not zoom. */
  adsZoomFov: number | null;
  /**
   * The scope picture drawn over the whole screen at full aim, as a catalogue id
   * under `catalog/overlays/<game>/`; null for a weapon whose sights are
   * geometry the player looks through.
   *
   * A weapon with one is not aimed by looking down the gun at all: the game
   * hides the viewmodel outright and multiplies this image over the frame, which
   * is the only reason a 15° field of view is not a screenful of receiver. A
   * fitted optic owns it (`resolveWeapon`) — an ACOG on a sniper rifle takes it
   * away, a thermal replaces it.
   */
  adsOverlay: string | null;
  /**
   * The procedural motion's parameters, by their weapon-file names — which is
   * also how `sim/recoil.ts` spells them when it reads one back.
   *
   * Two recoil families live in here and they are not interchangeable:
   * `*GunKick*` rocks the model in the hands (engine/weaponMotion.ts) and
   * `*ViewKick*` punches the aim (`aimAngles`). Format 5 is where the second
   * arrived; a format-4 definition has the first only, which is no recoil at all
   * for a scoped sniper.
   */
  motion: Record<string, number>;
  /**
   * What a shot does, from the weapon file. Optional as a block, unlike every
   * field above: these arrived at format 4, and a `WeaponDef` built from a
   * format-3 GLB's extras or by hand in a test carries none of them. A reader
   * that needs a number here wants the catalogue entry, which always has it.
   */
  damage?: WeaponDamage;
  spread?: WeaponSpread;
  locationDamage?: WeaponLocationDamage;
  /** Pellets one shot casts: 8 for a SPAS-12, 1 for a rifle, 0 for what fires no bullet at all. */
  shotCount?: number;
  /** `bullet` (hitscan), `grenade`, `projectile`, `riotshield` or `none`: what a shot even is. */
  weaponType?: string;
  /** The game's own category (`rifle`, `smg`, `sniper`, ...). The same key `WeaponEntry.class` shows a menu. */
  weaponClass?: string;
  /** What a round goes through: `none`, `small`, `medium` or `large`. */
  penetrateType?: string;
  /** Joints whose surfaces are not drawn: the weapon's hideTags and the folded backup sight. */
  hideBones: string[];
  /**
   * The aliases this weapon is heard through. Optional as a block, like the
   * ballistics above: a definition built by hand in a test, or read out of a GLB
   * exported before this existed, simply makes no sound.
   */
  sounds?: WeaponSounds;
}
