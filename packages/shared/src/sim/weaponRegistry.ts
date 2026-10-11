// Every weapon both ends can build, and the one place an id becomes a weapon.
//
// A weapon used to be whatever GLB a world happened to ship, which is why
// `PlayerState` could not say which one was held and why a server held none at
// all (docs/server/README.md). Here a weapon is named, and the name is what
// travels: `WeaponDef` is data, so this module is plain data too — no three.js
// and no glTF, so a game server can hold a weapon without loading a model.

import type { ClipRole, WeaponDef } from "./weaponDef.js";
import { checkWeaponLimits, WeaponController } from "./weapon.js";

/**
 * The most weapons one catalogue may hold, because the wire names a weapon by
 * its index in eight bits (net/messages/player.ts). A larger catalogue is
 * refused when it is read, rather than throwing out of the first snapshot that
 * has to name weapon 256.
 */
export const MAX_WEAPONS = 256;

/**
 * A weapon's address in the catalogue: `<game>/<name>`, as `weaponKey` builds it.
 *
 * Qualified by game because a name alone is not unique — Modern Warfare 2 and 3
 * both ship an `at4_mp`, a `javelin_mp`, an `rpg_mp`, a `stinger_mp` and a
 * `riotshield_mp`, and they are different weapons with different numbers. The
 * catalogue's own layout says the same thing: `catalog/weapons/<game>/<id>/`.
 */
export type WeaponId = string;
/** An attachment's name, unique within the weapon that offers it. */
export type AttachmentId = string;

/**
 * What kind of thing an attachment is, in the source game's own words: an optic,
 * something under the barrel, or anything else. Carried because the aiming clips
 * turn on it — see `resolveWeapon`.
 */
export type AttachmentType = "scope" | "underbarrel" | "other";

/**
 * The clips played while aiming, which a fitted optic authors itself.
 *
 * Every other role belongs to whichever attachment changed the shape of the gun
 * in the hands. Measured, not decided: Modern Warfare 2 ships a whole weapon
 * file for each of 806 two-attachment combinations, and this is the rule that
 * reproduces all 806 from the 272 single-attachment files — a grip on an MG4
 * keeps its own reload while a reflex on the same gun keeps its own ADS.
 */
const SIGHT_ROLES: readonly ClipRole[] = ["adsUp", "adsDown", "adsFire", "adsLastShot"];

/**
 * The most attachments one weapon may **offer**, because the wire names a fitted
 * one by its slot index in four bits (net/messages/player.ts).
 *
 * Measured rather than guessed: across Modern Warfare 3's 53 catalogued weapons
 * the longest `attachments` list is 11 (`{0:10, 4:6, 5:10, 7:6, 8:6, 9:5,
 * 10:7, 11:3}`), so the byte of slot flags this used to be could not represent
 * an M4 with `xmags` in slot 9 and refused the whole catalogue outright. A
 * weapon declaring more than this is still refused when the catalogue is read,
 * rather than silently truncated on the wire.
 */
export const MAX_ATTACHMENT_SLOTS = 16;

/**
 * The most attachments that may be **fitted** at once, because the wire counts
 * them in two bits — and three is what two bits reach, not a rule of the game.
 * Call of Duty allows two (Bling in Modern Warfare 2, the Attachments
 * proficiency in 3) and MW2's own pre-baked combinations go no further: of its
 * 1078 attachment variants, 272 carry one and 806 carry two. So the wire is a
 * ceiling here and the loadout is the limit that matters.
 */
export const MAX_FITTED_ATTACHMENTS = 3;

/**
 * Which attachments are fitted, as slot indices into the weapon's own list.
 *
 * A list rather than the bitmask this used to be. A mask spends a bit per slot
 * whether anything is in it or not, so a weapon offering eleven costs eleven
 * bits of every snapshot to carry the one attachment a player usually fits —
 * and widens again the next time a weapon's list grows. Order is not
 * significant: `resolveWeapon` applies them in catalogue order whatever order
 * they arrive in, so two ends cannot disagree about which won a field.
 */
export type Fitted = readonly number[];

/** No attachments. A shared empty array, since this is the overwhelmingly common case. */
export const NOTHING_FITTED: Fitted = Object.freeze([]);

/**
 * An attachment: a model on one of the gun's tags, the joints it hides or
 * reveals, and how it changes the weapon's numbers.
 *
 * Every field here is already **specific to the weapon that offers it** and
 * already **absolute**. The two games describe an attachment in ways that have
 * nothing in common — Modern Warfare 3 ships 40 `attachment` assets of
 * multiplicative scales, Modern Warfare 2 ships one whole weapon file per
 * combination — and both are collapsed to this by the exporter
 * (docs/cod/reference.md#attachments), so that no runtime code has to know that
 * either shape ever existed, and so that `resolveWeapon` is a spread.
 */
export interface AttachmentEntry {
  id: AttachmentId;
  display?: string;
  /** The source game's own category. `scope` is the one the resolver acts on. */
  type?: AttachmentType;
  /**
   * The gun joint its model mounts on (`tag_acog_2`, `tag_silencer`, ...).
   *
   * Read off the attachment model's own root joint rather than guessed from its
   * name: IW5 names that root for the gun tag it belongs on, which is how the
   * game itself knows where an ACOG goes.
   */
  tag?: string;
  /**
   * The catalogue model to mount there, for a game that ships attachments as
   * models of their own (IW5). Absent where the mesh is already part of the gun
   * and only hidden (IW4), which is what `showBones` is for.
   */
  model?: string;
  /** Joints whose surfaces this hides, on top of the weapon's own `hideBones`: the iron sights under a scope. */
  hideBones?: string[];
  /** Joints the bare weapon hides and this reveals: the gun's own attachment meshes, in a game that carries them. */
  showBones?: string[];
  /**
   * Fields of the weapon's `WeaponDef` this replaces.
   *
   * `roles`, `times`, `motion`, `damage`, `spread`, `locationDamage` and
   * `sounds` merge **key by key**; every other field replaces outright. That is not a
   * convenience — a scope changes the ADS times and a grip changes the reload
   * times, and fitting both has to keep each. The same holds of the numbers a
   * server judges a shot by: an attachment naming one spread figure must not
   * take the rest of the cone with it. `hideBones` is not read from here; it has
   * its own two fields above, because two attachments have to be able to hide a
   * joint each.
   */
  overrides?: Partial<WeaponDef>;
}

/** A weapon's catalogue address. The one place `<game>/<name>` is spelled. */
export function weaponKey(entry: { game: string; id: string }): WeaponId {
  return `${entry.game}/${entry.id}`;
}

/**
 * The two halves of a catalogue address, or null for anything that is not one.
 *
 * The inverse of `weaponKey`, and here beside it so the split is spelled once
 * too: `catalog/<kind>/<game>/<id>/` is a path, and a caller building that URL
 * from an id is the caller most likely to get the halves round the wrong way.
 */
export function splitWeaponKey(id: WeaponId): { game: string; name: string } | null {
  const cut = id.indexOf("/");
  if (cut <= 0 || cut === id.length - 1 || id.indexOf("/", cut + 1) !== -1) {
    return null;
  }
  return { game: id.slice(0, cut), name: id.slice(cut + 1) };
}

/** One weapon in the catalogue, as `catalog/weapons/<game>/<id>/<id>.json` holds it. */
export interface WeaponEntry {
  /** The game's own name for it, unique within that game but not across games. */
  id: string;
  /** The source game (`iw4`, `iw5`, `t5`), which is also its path segment. */
  game: string;
  /** What a player is shown. Falls back to the id. */
  display?: string;
  /**
   * Which loadout slot this belongs in.
   *
   * Derived by the exporter from the weapon file's `weaponClass`, **not** read
   * from it: a Call of Duty weapon file marks a pistol, a launcher and a rifle
   * alike as `inventoryType: primary`, and the primary/secondary split lives in
   * the game's menu files, which the pipeline does not dump. Undefined for a
   * weapon catalogued from a world's own GLB, which carries no weapon file.
   */
  slot?: "primary" | "secondary";
  /** The source game's own category: `rifle`, `smg`, `sniper`, `pistol`, `spread`, `mg`, `rocketlauncher`. */
  class?: string;
  def: WeaponDef;
  /**
   * What may be fitted, in slot order — the order IS the wire format, so append
   * to a weapon's list rather than inserting, and `catalogHash` covers it.
   *
   * The order is also how two attachments touching one field are settled:
   * `resolveWeapon` walks it front to back and the later one wins. So the
   * exporter writes it by `type` — `other`, then `scope`, then `underbarrel` —
   * because that is the order that reproduces Modern Warfare 2's own
   * combinations. See docs/cod/reference.md#attachments.
   */
  attachments: AttachmentEntry[];
}

/**
 * The catalogue as the api serves it, seen from the weapons in it.
 *
 * Named for what this module reads rather than for the whole file: the catalogue
 * also carries characters, view-hands and player animations, each with its own
 * reader, and none of them is this one's business. A kind this build has never
 * heard of is simply a key it does not name.
 */
export interface WeaponCatalog {
  version: number;
  weapons: WeaponEntry[];
}

/**
 * The **weapon entry** shape this reader understands.
 *
 * Deliberately not a version of the whole catalogue. Both readers refuse the
 * entire thing on a mismatch — `client/src/net/catalog.ts` and
 * `game-server/src/weapons.ts` each fall back to an empty registry, which leaves
 * every player unarmed — so this may only move when a `WeaponEntry` itself
 * changes shape, and never merely because a new kind moved in beside it. Adding a
 * kind costs no version: an older reader sees a key it does not know rather than
 * an entry it must learn to skip.
 *
 * It is also the **only** thing that catches a stale weapon's numbers. `hash`
 * below digests the catalogue's weapon and attachment order and nothing else, so
 * two ends holding the same guns with different damage tables agree on it — this
 * has to move whenever a `WeaponDef` field a server judges a shot by does.
 */
export const CATALOG_VERSION = 4;

/**
 * Apply fitted attachments to a weapon's own definition.
 *
 * Pure and deterministic, because **both ends derive their numbers from this** —
 * a client predicting a shot and a server replaying it must get identical values
 * out of the same ids, or the two diverge exactly where it is hardest to see.
 * Slots are applied in catalogue order, so two attachments touching one field
 * always resolve the same way round — except the aiming clips, which a fitted
 * optic keeps whatever else is on the gun (SIGHT_ROLES).
 */
export function resolveWeapon(entry: WeaponEntry, fitted: Fitted): WeaponDef {
  if (fitted.length === 0) {
    return entry.def;
  }

  // Walked in catalogue order rather than in the order `fitted` lists, so a
  // repeated or reordered list off the network resolves to the same weapon.
  const slots = new Set(fitted);
  const hidden = new Set(entry.def.hideBones);
  let def = entry.def;
  let bonesMoved = false;

  entry.attachments.forEach((attachment, slot) => {
    if (!slots.has(slot)) {
      return;
    }
    const overrides = attachment.overrides;
    if (overrides) {
      def = {
        ...def,
        ...overrides,
        roles: overrides.roles ? { ...def.roles, ...overrides.roles } : def.roles,
        times: overrides.times ? { ...def.times, ...overrides.times } : def.times,
        motion: overrides.motion ? { ...def.motion, ...overrides.motion } : def.motion,
        damage: overrides.damage ? { ...def.damage, ...overrides.damage } : def.damage,
        spread: overrides.spread ? { ...def.spread, ...overrides.spread } : def.spread,
        // Key by key like the rest, and for the one case that exists: a silencer
        // replaces the two fire aliases and nothing else, so a silenced M4 must
        // keep its own reload, melee and notetracks.
        sounds: overrides.sounds ? { ...def.sounds, ...overrides.sounds } : def.sounds,
        locationDamage: overrides.locationDamage ? { ...def.locationDamage, ...overrides.locationDamage } : def.locationDamage,
        // Never from `overrides`: what is drawn is settled by the two lists
        // below, so two attachments can each hide a joint of their own.
        hideBones: def.hideBones,
      };
    }
    if (attachment.hideBones?.length || attachment.showBones?.length) {
      bonesMoved = true;
      for (const bone of attachment.hideBones ?? []) {
        hidden.add(bone);
      }
      for (const bone of attachment.showBones ?? []) {
        hidden.delete(bone);
      }
    }
  });

  // A second pass, because a sight and a grip each author clips for the same
  // weapon and the winner depends on the role rather than on the slot: the sight
  // owns the aiming clips and the grip everything it changed about the handling.
  const sights = entry.attachments.filter((attachment, slot) => slots.has(slot) && attachment.type === "scope");
  if (sights.length > 0) {
    const roles = { ...def.roles };
    let aimed = false;
    // The scope picture goes the same way and for the same reason, but it is one
    // field rather than a set of clips: whichever optic is on the gun decides
    // what the player looks through, however late in the list an underbarrel sits.
    let overlay = def.adsOverlay;
    let overlaid = false;
    for (const sight of sights) {
      for (const role of SIGHT_ROLES) {
        const clip = sight.overrides?.roles?.[role];
        if (clip !== undefined && clip !== roles[role]) {
          roles[role] = clip;
          aimed = true;
        }
      }
      if (sight.overrides && "adsOverlay" in sight.overrides) {
        overlay = sight.overrides.adsOverlay ?? null;
        overlaid = true;
      }
    }
    if (aimed || overlaid) {
      def = { ...def, roles, adsOverlay: overlay };
    }
  }

  return bonesMoved ? { ...def, hideBones: [...hidden].sort() } : def;
}

/** The slots a set of attachment ids occupies on one weapon, in slot order; an id it does not offer is ignored. */
export function fittedSlots(entry: WeaponEntry, ids: readonly AttachmentId[]): number[] {
  const wanted = new Set(ids);
  const slots: number[] = [];
  entry.attachments.forEach((attachment, slot) => {
    if (wanted.has(attachment.id)) {
      slots.push(slot);
    }
  });
  return slots;
}

/** The attachment ids a set of slots names, in slot order. A slot this weapon does not offer is ignored. */
export function fittedIds(entry: WeaponEntry, fitted: Fitted): AttachmentId[] {
  const slots = new Set(fitted);
  return entry.attachments.filter((_, slot) => slots.has(slot)).map((a) => a.id);
}

/** Whether two fitted sets name the same slots, whatever order each is in. */
export function sameFitted(a: Fitted, b: Fitted): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const slots = new Set(a);
  return b.every((slot) => slots.has(slot));
}

/**
 * Which weapons exist, and how to build one.
 *
 * The order is the wire's: a snapshot carries a weapon as its index here rather
 * than its name, so both ends must hold the same catalogue. `hash` is what makes
 * that checkable — a game server refuses a join whose hash disagrees, the way it
 * refuses one whose protocol version does, because the catalogue will change far
 * more often than the protocol will.
 */
export class WeaponRegistry {
  private readonly byId = new Map<WeaponId, WeaponEntry>();
  readonly order: readonly WeaponId[];
  readonly hash: string;

  constructor(entries: readonly WeaponEntry[]) {
    if (entries.length > MAX_WEAPONS) {
      throw new Error(`the catalogue holds ${entries.length} weapons; the wire names ${MAX_WEAPONS}`);
    }
    // Sorted, so two ends that fetched the catalogue at different moments, or
    // built one from a directory listing, still agree on every index.
    const sorted = [...entries].sort((a, b) => {
      const [x, y] = [weaponKey(a), weaponKey(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const entry of sorted) {
      const key = weaponKey(entry);
      if (entry.attachments.length > MAX_ATTACHMENT_SLOTS) {
        throw new Error(`weapon "${key}" declares ${entry.attachments.length} attachments; the wire carries ${MAX_ATTACHMENT_SLOTS}`);
      }
      if (this.byId.has(key)) {
        throw new Error(`two weapons share the id "${key}"`);
      }
      checkWeaponLimits(entry.def, key);
      for (const attachment of entry.attachments) {
        checkWeaponLimits(attachment.overrides ?? {}, `${key}+${attachment.id}`);
      }
      this.byId.set(key, entry);
    }
    this.order = sorted.map(weaponKey);
    this.hash = hashOf(sorted);
  }

  get size(): number {
    return this.order.length;
  }

  entry(id: WeaponId | null | undefined): WeaponEntry | undefined {
    return id === null || id === undefined ? undefined : this.byId.get(id);
  }

  /**
   * The catalogue address for a game's own name for a weapon, when exactly one
   * game ships it. Null when none does, and null when two do — `at4_mp` is in
   * both Modern Warfares, and guessing which would arm a player wrongly in
   * silence. A caller with a game to hand should build the key itself.
   */
  resolveName(name: string): WeaponId | null {
    const found = this.order.filter((key) => key.endsWith(`/${name}`));
    return found.length === 1 ? found[0]! : null;
  }

  /** Everything that goes in one loadout slot, in catalogue order. For a class menu. */
  inSlot(slot: "primary" | "secondary"): readonly WeaponEntry[] {
    return this.order.map((id) => this.byId.get(id)!).filter((entry) => entry.slot === slot);
  }

  /** The wire's index for a weapon, or null for one this catalogue does not hold. */
  indexOf(id: WeaponId | null): number | null {
    if (id === null) {
      return null;
    }
    const index = this.order.indexOf(id);
    return index < 0 ? null : index;
  }

  idAt(index: number | null): WeaponId | null {
    return index === null ? null : (this.order[index] ?? null);
  }

  /** A weapon ready to hold, with `fitted` attachments applied. Undefined for an unknown id. */
  build(id: WeaponId | null, fitted: Fitted = NOTHING_FITTED): WeaponController | undefined {
    const entry = this.entry(id);
    return entry ? new WeaponController(resolveWeapon(entry, fitted)) : undefined;
  }
}

/**
 * A short, stable digest of everything the wire addresses positionally: the
 * catalogue's weapon order, and each weapon's own attachment order.
 *
 * The attachments are in it because they are indexed the same way a weapon is —
 * a snapshot carries slot 3, not "acog", so a catalogue built from a different
 * attachment dump puts a silencer where the far end draws a scope. Adding a
 * weapon or an attachment changes this; it does not change PROTOCOL_VERSION.
 *
 * FNV-1a rather than a real hash: this only has to catch two ends holding
 * different catalogues, which is a mistake and not an attack — a client that
 * lies about it only breaks its own weapon. Kept here so both ends compute it
 * identically.
 */
function hashOf(sorted: readonly WeaponEntry[]): string {
  let h = 0x811c9dc5;
  const mix = (byte: number): void => {
    h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  };
  const term = (text: string): void => {
    for (const ch of text) {
      mix(ch.codePointAt(0)! & 0xff);
    }
    // A separator, so ["ab","c"] and ["a","bc"] cannot collide.
    mix(0xff);
  };
  for (const entry of sorted) {
    term(weaponKey(entry));
    for (const attachment of entry.attachments) {
      term(attachment.id);
    }
  }
  return h.toString(16).padStart(8, "0");
}
