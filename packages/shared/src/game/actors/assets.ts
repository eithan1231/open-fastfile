// What an actor kind is drawn, shot and timed from, read out of the catalogue —
// and which of it one actor gets.
//
// Plain data, tier one: the server times a blow and sets a walker's speed from
// these numbers and must not need three.js to do it. A GLB is a `CatalogRef`
// here; the client and `rig/actorRig.ts` turn it into bones.
//
// **Every per-actor choice is a hash, not a message.** A zombie wears one of two
// bodies and four heads and walks one of seven walks, and nothing on the wire
// says which: `actorLook` draws them from the match seed and the actor's id, so
// the server timing a swing and the client drawing it arrive at the same clip.
// The catalogue itself is what both ends must agree on, as they already must for
// a player's body.

import type { GameKey } from "../../dsl/resolved.js";
import { CREATURE_ROLES, type CreatureRole } from "../../sim/characterDef.js";
import type { CatalogRef } from "../cast.js";
import type { CatalogueView } from "../catalogueView.js";
import { hashString, seeded } from "../random.js";
import type { ActorGait, ActorId } from "./actor.js";

/** Bumped whenever an actor entry or its clip set changes shape; `scripts/cod/actors.py` writes it. */
export const ACTOR_FORMAT_VERSION = 1;

/** One clip's facts, as a clip set's `clipTable` holds them. */
export interface ActorClipInfo {
  duration: number;
  looped: boolean;
  /** `[name, seconds]`. The melee hit is `fire`. */
  notes: [string, number][];
  /** The delta track over one cycle, in the actor's own frame; `speed` is its ground speed, m/s. Null for none. */
  rootMotion: { forward: number; left: number; up: number; yaw: number; speed: number } | null;
  /** A traversal clip's delta track key by key: `[seconds, forward, left, up]`, metres from its start. */
  rootPath?: RootKey[] | null;
}

/** One key of a root path: `[seconds, forward, left, up]`. */
export type RootKey = [number, number, number, number];

/** `catalog/animations/<game>/<id>/<id>.json` for a creature: roles as lists of variants. */
export interface ActorClipSetEntry {
  id: string;
  game: GameKey;
  actor: true;
  version: number;
  /** The clip GLB, relative to the entry's folder: a skeleton with no meshes. */
  clips: string;
  /** The game's own table: each role, every variant it picks among, in its order, repeats kept. */
  roles: Record<string, string[]>;
  /** The clip a traversal plays, by the animscript a nav link names (`zombie_jump_down_190`). Absent: none. */
  traversals?: Record<string, string>;
  clipTable: Record<string, ActorClipInfo>;
}

/** `catalog/actors/<game>/<id>/<id>.json`: one creature's bodies, heads, clips and boxes. */
export interface ActorEntry {
  id: string;
  game: GameKey;
  kind: string;
  version: number;
  bodies: string[];
  heads?: string[];
  /** How often each body is picked, parallel to `bodies`; absent is uniform. */
  bodyWeights?: number[];
  headWeights?: number[];
  /** The clip set's id, under `animations/<game>/`. */
  animations: string;
  /** Roles this map plays differently, each replacing the clip set's whole list. */
  roles?: Record<string, string[]>;
  hitboxes: string;
  health?: number;
  /** The game's own box: metres. Recorded; a kind moves with its own capsule. */
  size?: { radius: number; height: number };
}

/** One clip an actor plays for one role. */
export interface ActorClip {
  readonly name: string;
  /** Seconds. */
  readonly duration: number;
  /** Its root motion's ground speed, m/s: what the actor moves at while playing it. 0 for one that stands. */
  readonly speed: number;
  /** Seconds into it each blow lands (its `fire` notes), in order. */
  readonly hits: readonly number[];
}

/**
 * A clip a traversal link plays: the same for every actor wearing the set, since
 * the link picks it, not the seed. Its root path is what moves the body, stretched
 * onto the link's own ends (`Actors.crossing`).
 */
export interface ActorTraversalClip {
  readonly animscript: string;
  readonly name: string;
  readonly duration: number;
  readonly path: readonly RootKey[];
}

/** An actor kind's catalogue entry, read: the files and every variant of every role. */
export interface ActorAssets {
  readonly entry: ActorEntry;
  readonly bodies: readonly CatalogRef[];
  readonly heads: readonly CatalogRef[];
  readonly clips: CatalogRef;
  readonly hitboxes: CatalogRef;
  /** Every variant of each role the engine plays; a role the set has none of is absent. */
  readonly roles: Partial<Record<CreatureRole, readonly ActorClip[]>>;
  /**
   * The swings each gait picks among: `attack` and the gait's own — `walkAttack`
   * for a walker, `runAttack` for a runner or sprinter — as CoD's
   * `pick_zombie_melee_anim` combines them. Empty for a set with no swing.
   */
  readonly swings: Readonly<Record<ActorGait, readonly ActorClip[]>>;
  /** Every traversal clip, by animscript in name order: the wire names one by its index here plus one. */
  readonly traversals: readonly ActorTraversalClip[];
}

/** What one actor wears and plays: indices into `ActorAssets.bodies`/`heads`, and one variant per role. */
export interface ActorLook {
  readonly body: number;
  /** Undefined for an entry with no heads. */
  readonly head: number | undefined;
  readonly clips: Partial<Record<CreatureRole, ActorClip>>;
  /** The set's, not drawn: `ActorAssets.traversals`. */
  readonly traversals: readonly ActorTraversalClip[];
}

/** The clip set's role each engine role is read from, where the two names differ. */
const SOURCE_ROLE: Partial<Record<CreatureRole, string>> = {
  die: "death",
  climb: "windowClimb",
  climbRun: "windowClimbRun",
  climbSprint: "windowClimbSprint",
};

/**
 * A kind's catalogue actor, read against the catalogue it came from. Undefined
 * where the catalogue holds no such entry — a kind drawn and shot as its capsule.
 * Throws on an entry that is there and malformed, which a caller says once.
 */
export function actorAssetsFor(ref: { game: GameKey; id: string }, catalogue: CatalogueView): ActorAssets | undefined {
  const raw = catalogue.actorFor(ref.game, ref.id);
  if (raw === undefined) {
    return undefined;
  }
  const entry = readActorEntry(raw);
  const set = catalogue.animationsFor(entry.game, entry.animations);
  if (set === undefined) {
    throw new Error(`actor ${entry.game}/${entry.id} plays clip set "${entry.animations}", which the catalogue does not hold`);
  }
  return readActorAssets(entry, readActorClipSet(set));
}

/** An entry and its clip set, joined: the map's own roles over the set's, each variant's facts looked up. */
export function readActorAssets(entry: ActorEntry, set: ActorClipSetEntry): ActorAssets {
  const ref = (file: string): CatalogRef => ({ kind: "actors", game: entry.game, id: entry.id, file });
  const variants = (source: string): ActorClip[] =>
    (entry.roles?.[source] ?? set.roles[source] ?? []).map((name) => {
      const info = set.clipTable[name];
      if (!info) {
        throw new Error(`actor ${entry.id}'s ${source} names clip ${name}, which clip set ${set.id} does not hold`);
      }
      return {
        name,
        duration: info.duration,
        speed: info.rootMotion?.speed ?? 0,
        hits: info.notes.filter(([note]) => note === "fire").map(([, at]) => at),
      };
    });
  const roles: Partial<Record<CreatureRole, readonly ActorClip[]>> = {};
  for (const role of CREATURE_ROLES) {
    const found = variants(SOURCE_ROLE[role] ?? role);
    if (found.length > 0) {
      roles[role] = found;
    }
  }
  const attack = roles.attack ?? [];
  const running = [...attack, ...variants("runAttack")];
  const swings = { walk: [...attack, ...variants("walkAttack")], run: running, sprint: running };
  if (!roles.idle) {
    throw new Error(`actor ${entry.id}'s clip set ${set.id} has no idle`);
  }
  const traversals = Object.keys(set.traversals ?? {})
    .sort()
    .flatMap((animscript): ActorTraversalClip[] => {
      const name = set.traversals![animscript]!;
      const info = set.clipTable[name];
      if (!info) {
        throw new Error(`clip set ${set.id}'s traversal ${animscript} names clip ${name}, which it does not hold`);
      }
      const path = info.rootPath ?? [];
      // A clip with no path cannot move a body: the link is crossed as if it had none.
      return path.length < 2 ? [] : [{ animscript, name, duration: info.duration, path }];
    });
  return {
    entry,
    bodies: entry.bodies.map(ref),
    heads: (entry.heads ?? []).map(ref),
    clips: { kind: "animations", game: set.game, id: set.id, file: set.clips },
    hitboxes: ref(entry.hitboxes),
    roles,
    swings,
    traversals,
  };
}

/**
 * One actor's body, head and a variant of every role, from the match seed, its id
 * and its gait alone (the gait picks which swings it draws among). Drawn in a
 * fixed order — body, head, then `CREATURE_ROLES` in order — so adding a role at
 * the end of that list changes nobody's walk.
 */
export function actorLook(assets: ActorAssets, seed: number, id: ActorId, gait: ActorGait): ActorLook {
  const rng = seeded(avalanche(hashString(`${seed}:${id}`)));
  const body = weighted(rng(), assets.bodies.length, assets.entry.bodyWeights);
  const headDraw = rng();
  const head = assets.heads.length === 0 ? undefined : weighted(headDraw, assets.heads.length, assets.entry.headWeights);
  const clips: Partial<Record<CreatureRole, ActorClip>> = {};
  for (const role of CREATURE_ROLES) {
    const draw = rng();
    const variants = role === "attack" ? assets.swings[gait] : (assets.roles[role] ?? []);
    if (variants.length > 0) {
      clips[role] = variants[Math.min(variants.length - 1, Math.floor(draw * variants.length))];
    }
  }
  return { body, head, clips, traversals: assets.traversals };
}

/** Where a root path is `seconds` in, between its keys: `forward` and `up`, m. Clamped to its ends. */
export function rootAt(path: readonly RootKey[], seconds: number): { forward: number; up: number } {
  let i = 1;
  while (i < path.length - 1 && path[i]![0] < seconds) {
    i++;
  }
  const a = path[i - 1]!;
  const b = path[i]!;
  const span = b[0] - a[0];
  const t = span > 0 ? Math.min(1, Math.max(0, (seconds - a[0]) / span)) : 1;
  return { forward: a[1] + (b[1] - a[1]) * t, up: a[3] + (b[3] - a[3]) * t };
}

/** The role a gait moves in, falling back to the nearest one the set has. */
export function gaitRole(gait: ActorGait, has: (role: CreatureRole) => boolean): CreatureRole | undefined {
  return GAIT_FALLBACK[gait].find(has);
}

const GAIT_FALLBACK: Record<ActorGait, readonly CreatureRole[]> = {
  walk: ["walk", "run", "sprint"],
  run: ["run", "sprint", "walk"],
  sprint: ["sprint", "run", "walk"],
};

/** The role a gait climbs in (a window, a wall), falling back as `gaitRole` does; undefined for a set with no climb. */
export function climbRole(gait: ActorGait, has: (role: CreatureRole) => boolean): CreatureRole | undefined {
  return CLIMB_FALLBACK[gait].find(has);
}

const CLIMB_FALLBACK: Record<ActorGait, readonly CreatureRole[]> = {
  walk: ["climb", "climbRun", "climbSprint"],
  run: ["climbRun", "climbSprint", "climb"],
  sprint: ["climbSprint", "climbRun", "climb"],
};

/**
 * MurmurHash3's finaliser. Consecutive ids hash to seeds xorshift's first draw
 * barely separates (a lag-one correlation of 0.2, measured: runs of eleven
 * zombies all in the heavier body), so the seed is mixed before it is drawn from.
 */
function avalanche(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** `draw` in [0, 1) to an index in [0, count), each weighted; absent or unusable weights are uniform. */
function weighted(draw: number, count: number, weights: readonly number[] | undefined): number {
  const usable = weights && weights.length === count && weights.every((w) => w >= 0) ? weights : undefined;
  const total = usable ? usable.reduce((a, b) => a + b, 0) : count;
  if (!(total > 0)) {
    return 0;
  }
  let at = draw * total;
  for (let i = 0; i < count; i++) {
    at -= usable ? usable[i]! : 1;
    if (at < 0) {
      return i;
    }
  }
  return count - 1;
}

/** Check an actor entry's shape. Throws on what it cannot use. */
export function readActorEntry(raw: unknown): ActorEntry {
  const entry = raw as Partial<ActorEntry> | null;
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.game !== "string") {
    throw new Error("actor entry: no id or game");
  }
  if (entry.version !== ACTOR_FORMAT_VERSION) {
    throw new Error(`actor ${entry.id}: format ${String(entry.version)}; this build reads ${ACTOR_FORMAT_VERSION} (re-run scripts.cod actors)`);
  }
  if (!isStrings(entry.bodies) || entry.bodies.length === 0 || (entry.heads !== undefined && !isStrings(entry.heads))) {
    throw new Error(`actor ${entry.id}: no bodies`);
  }
  if (typeof entry.animations !== "string" || typeof entry.hitboxes !== "string") {
    throw new Error(`actor ${entry.id}: no clip set or hitboxes`);
  }
  return entry as ActorEntry;
}

/** Check a creature clip set's shape. Throws on what it cannot use. */
export function readActorClipSet(raw: unknown): ActorClipSetEntry {
  const set = raw as Partial<ActorClipSetEntry> | null;
  if (!set || typeof set !== "object" || typeof set.id !== "string" || set.actor !== true) {
    throw new Error("not a creature clip set");
  }
  if (set.version !== ACTOR_FORMAT_VERSION) {
    throw new Error(`clip set ${set.id}: format ${String(set.version)}; this build reads ${ACTOR_FORMAT_VERSION} (re-run scripts.cod actors)`);
  }
  if (typeof set.clips !== "string" || typeof set.roles !== "object" || set.roles === null || typeof set.clipTable !== "object" || set.clipTable === null) {
    throw new Error(`clip set ${set.id}: no clips, roles or clip table`);
  }
  return set as ActorClipSetEntry;
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
