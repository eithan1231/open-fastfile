// Who a player is: the body they are drawn as, the hands they see, the clips they
// play and the gun they hold when their class names none.
//
// This used to be a world's answer. `characters.world` listed the bodies a map
// shipped and `viewmodel.world` named one pair of hands and one gun, so a body
// could not be worn anywhere else and a map decided what a player carried. Here
// the catalogue holds the people and a gametype chooses among them.
//
// **Pure, and that is load-bearing.** `pnpm dev` starts no game server, and a
// client with no game server to join plays exactly as it does offline — so the
// browser has to reach the same cast on its own that a game server reaches for a
// real match. Same inputs, same cast, for the same reason `resolveWeapon` must
// give a client and a server identical numbers out of identical ids. No clock, no
// ambient randomness, no host.

import type { GameKey } from "../dsl/resolved.js";
import type { WeaponId } from "../sim/weaponRegistry.js";
import type { CatalogueView, CharacterEntry } from "./catalogueView.js";
import type { GametypeDecl, TeamId } from "./gametypes/declaration.js";
import { hashString } from "./random.js";

/**
 * What a player spawns holding when their class names nothing.
 *
 * Per game, because it is measured rather than chosen: every one of the 42
 * imported worlds named exactly one weapon for its own game — `iw4/m4_mp` in all
 * 16 Modern Warfare 2 maps, `iw5/iw5_m4_mp` in all 25 Modern Warfare 3 maps,
 * `iw6/iw6_ak12_mp` in Ghosts. So this reproduces what every world said, without
 * any world saying it. Black Ops' worlds never named one; its M16 is what the
 * exporter rigs their hands and bodies onto (`viewmodel.DEFAULT_WEAPON`).
 *
 * Not the same decision as `viewmodel.DEFAULT_WEAPON` in the exporter, which picks
 * which gun to *rig a pair of hands onto* at export time. The two happen to name
 * the same weapons and answer different questions.
 */
const DEFAULT_WEAPON: Record<GameKey, WeaponId | null> = {
  iw4: "iw4/m4_mp",
  iw5: "iw5/iw5_m4_mp",
  iw6: "iw6/iw6_ak12_mp",
  t5: "t5/m16_mp",
  // Black Ops II's own first default class (`mp/statstable.csv` in `patch_mp.ff`) carries the MTAR.
  t6: "t6/tar21_mp",
  // Advanced Warfare's own default class (`CLASS_DEFAULT` in `mp/classtable.csv`) carries the Bal-27.
  s1: "s1/iw5_bal27_mp",
};

/**
 * The hands a game's players see, when no side has asked for its own.
 *
 * The pair most of that game's maps named, so the common case looks as it does
 * today: 13 of 25 Modern Warfare 3 maps named `viewhands_delta`, 7 of 16 Modern
 * Warfare 2 maps `viewhands_militia`, and Ghosts' one map
 * `viewhands_us_rangers_woodland`. Black Ops names no pair; its create-a-class
 * scripts give each faction's default class its own arms, and these are the urban
 * CIA's, the allies on the most Black Ops maps.
 */
const DEFAULT_HANDS: Record<GameKey, string | null> = {
  iw4: "viewhands_militia",
  iw5: "viewhands_delta",
  iw6: "viewhands_us_rangers_woodland",
  t5: "viewmodel_usa_cia_standard_arms",
  // TEAM_ALLIES is the SEALs (`mp/factiontable.csv`), and the catalogue's guns are rigged on this pair.
  t6: "c_usa_mp_seal6_longsleeve_viewhands",
  // AW's arms are a costume's; this pair is the default costume's, the one `common_mp.ff` keeps resident.
  s1: "viewhands_costume_default",
};

/**
 * **STOPGAP.** A game with no cast of its own yet is dressed and armed as another.
 *
 * Black Ops II has its own weapons and hands but no bodies in the catalogue yet, so
 * its players borrow Black Ops' bodies and clips. Each part falls
 * back on its own — bodies, hands, default weapon — so the day a t6 part is built
 * it replaces the borrowed one, and this row goes once all three are. Nothing else
 * in the repo knows a game borrows another's cast.
 */
const CAST_STAND_IN: Partial<Record<GameKey, GameKey>> = {
  t6: "t5",
};

/** One file of one catalogue entry, as the client turns into a URL with `catalogFilePath`. */
export interface CatalogRef {
  kind: string;
  game: string;
  id: string;
  /** The file's name inside the entry's folder. */
  file: string;
}

/** One body in a cast: the files it is built from, and what it is. */
export interface CastCharacter {
  id: string;
  /** The faction the source game put it on, or undefined for a body whose family is unknown. */
  side?: string;
  body: CatalogRef;
  head?: CatalogRef;
  /**
   * The third-person gun, hung on the body's `j_gun`.
   *
   * The one this body was *rigged holding* rather than the one its player's class
   * names: `characters.py` grafts that gun's joint tree into the body at export,
   * so swapping it needs run-time grafting, which is not built.
   */
  weapon?: CatalogRef;
}

/** Everything a player needs to be drawn and armed. */
export interface CastChoice {
  /** The bodies this side may wear, in catalogue order. A peer's id picks one. */
  characters: readonly CastCharacter[];
  /** The clips every one of them plays. */
  animations: CatalogRef;
  /** The first-person hands. */
  hands: CatalogRef;
  /** What a player holds when their class names nothing. Null: unarmed, which is visible. */
  defaultWeapon: WeaponId | null;
}

/** What a cast is chosen against. */
export interface CastQuery {
  /** The world's `game:`. Undefined means a hand-written world, which has no cast. */
  game: GameKey | undefined;
  gametype: GametypeDecl;
  /** Which side is asking. Undefined offline, and in a free-for-all. */
  team?: TeamId;
}

function ref(kind: string, game: string, id: string, file: string): CatalogRef {
  return { kind, game, id, file };
}

/**
 * The cast for one side of one gametype on one game's map, or undefined.
 *
 * Undefined means "this deployment cannot dress anyone" — a hand-written world, a
 * game with no catalogue built, or a catalogue with no clips for it — and the
 * caller draws capsules, which is what a world without a `characters` has always
 * done.
 *
 * Narrowing the side is deliberately not exact, for the reason `spawnPoints`
 * widens a spawn query: a gametype must still be able to dress a player on a game
 * whose bodies carry no faction at all. Ghosts is that case today — its two
 * rangers are not in the exporter's `SIDES` table — so asking for `allies` there
 * falls back to every body rather than to nothing.
 */
export function castFor(query: CastQuery, catalogue: CatalogueView): CastChoice | undefined {
  const { game, team } = query;
  if (game === undefined) {
    return undefined;
  }
  const standIn = CAST_STAND_IN[game];
  const own = catalogue.charactersFor(game);
  const bodiesOf = own.length === 0 && standIn !== undefined ? standIn : game;
  const all = bodiesOf === game ? own : catalogue.charactersFor(bodiesOf);
  if (all.length === 0) {
    return undefined;
  }
  const sided = team === undefined ? [] : all.filter((c) => c.side === team);
  const chosen = sided.length > 0 ? sided : all;

  // Every body of one game shares a clip set, keyed by the anim type its skeleton
  // expects. They agree in practice — one per game on this disk — so the first
  // body's answer stands for the cast.
  const animType = chosen.find((c) => c.animType)?.animType;
  const animations = animType === undefined ? undefined : catalogue.animationsFor(bodiesOf, animType);
  if (animations === undefined) {
    return undefined;
  }

  const hands = pickHands(game, catalogue) ?? (standIn === undefined ? undefined : pickHands(standIn, catalogue));
  if (hands === undefined) {
    return undefined;
  }

  // An id the catalogue does not hold leaves the player unarmed rather than
  // holding something else: a missing gun is visible, a substituted one is not.
  // The stand-in's is not a substitution in that sense: it is the declared answer
  // for a game that has named none.
  const held = (key: GameKey | undefined): WeaponId | null => {
    const weapon = key === undefined ? null : DEFAULT_WEAPON[key];
    return weapon && catalogue.weapon(weapon) ? weapon : null;
  };
  return {
    characters: chosen.map(toCastCharacter),
    animations: ref("animations", bodiesOf, animations.id, animations.clips),
    hands,
    defaultWeapon: DEFAULT_WEAPON[game] !== null ? held(game) : held(standIn),
  };
}

function toCastCharacter(entry: CharacterEntry): CastCharacter {
  const gun = entry.bakedWeapon;
  return {
    id: entry.id,
    side: entry.side ?? undefined,
    body: ref("characters", entry.game, entry.id, entry.body),
    head: entry.head === undefined ? undefined : ref("characters", entry.game, entry.id, entry.head),
    // Its own kind, addressed rather than listed: one world weapon serves every
    // body of a game, so it is stored once instead of inside each entry.
    weapon: gun ? ref("worldweapons", entry.game, gun, `${gun}.glb`) : undefined,
  };
}

/** This game's usual pair, or any pair it has. */
function pickHands(game: GameKey, catalogue: CatalogueView): CatalogRef | undefined {
  const offered = catalogue.viewhandsFor(game);
  if (offered.length === 0) {
    return undefined;
  }
  const wanted = DEFAULT_HANDS[game] ?? undefined;
  // `offered[0]` exists: the length check above is what makes the index safe, and
  // noUncheckedIndexedAccess cannot see that.
  const entry = offered.find((h) => h.id === wanted) ?? offered[0]!;
  return ref("viewhands", game, entry.id, entry.hands);
}

/**
 * Which of a side's bodies a player wears.
 *
 * In shared, and derived from the player's id, because **both ends have to reach the
 * same answer**. A client draws a peer in one of these; a server traces a bullet
 * against that body's bones, and each body has its own box sizes — a head derived
 * from a ghillie hood is 0.49 m across where an ordinary one is 0.29. Two ends
 * disagreeing about which body somebody is wearing is a hit box a fifth of a metre
 * from where it is drawn.
 *
 * `hashString` rather than the 31-multiplier the client's `remotePlayers.ts` grew for
 * itself: one hash, in one place, so that "everyone dresses this player the same" is
 * true across the whole deployment rather than within one browser.
 */
export function bodyIndex(playerId: string, count: number): number {
  return count <= 0 ? 0 : hashString(playerId) % count;
}

/** The same choice, as the character itself. */
export function bodyFor(playerId: string, characters: readonly CastCharacter[]): CastCharacter | undefined {
  return characters.length === 0 ? undefined : characters[bodyIndex(playerId, characters.length)];
}
