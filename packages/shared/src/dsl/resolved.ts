// The resolver's output: a flat, three.js-agnostic description of a world.
// Plain data (metres, radians, absolute positions), produced by resolve.ts and
// read by scene/ and engine/.

import type { Diagnostic } from "./diagnostics.js";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A world object's runtime address: dense, and assigned in the order objects are
 * emitted (rooms in declaration order, then top level). It is not in the world
 * text, so both ends derive the same ids from the same sources without the
 * exporter writing any — but that also means an id is only meaningful between
 * two ends that resolved the *same* text. See `net/messages/session.ts`.
 *
 * Ids above DYNAMIC_ID_BASE are minted at runtime by a server and never appear
 * here.
 */
export type EntityId = number;

/** The first id a server may mint for an entity that is not in the world text. */
export const DYNAMIC_ID_BASE = 1 << 16;

/** An object that was built but never emitted: see `resolveScopeBody`. */
export const UNASSIGNED_ENTITY_ID: EntityId = -1;

/** A model declared once and placed many times, shared by reference. */
/** A catalogue entry a world reaches into: the three path segments that name one. */
export interface CatalogEntryRef {
  kind: string;
  game: string;
  id: string;
}

export interface ResolvedAsset {
  name: string;
  /** The file, relative to the world folder — or to the catalogue entry when `catalog` names one. */
  source: string;
  /**
   * The catalogue entry `source` hangs off, if the asset is a shared one.
   *
   * Undefined for an asset the world ships itself. Which root a file comes from is
   * a type here rather than a scheme inside `source`, so nothing downstream has to
   * parse a string to know how to fetch it — `scene/assetUrl.ts` is the one place
   * either becomes a URL.
   */
  catalog?: CatalogEntryRef;
  /** Metres beyond which the model is not drawn. Parsed and carried; nothing culls by it yet. */
  until?: number;
  /**
   * The asset's own mesh doubles as its collision hull (`hull: 0`). Undefined:
   * a placement asking for `collide: hull` gets a box instead.
   */
  hull?: number;
}

/**
 * How an object takes part in collision: its geometry (`mesh`), not at all
 * (`none`), a box (`box`, for props whose full mesh is detail nothing should
 * catch on), or its asset's shared hull (`hull`).
 */
export type CollideMode = "mesh" | "box" | "hull" | "none";

/** Hit points an object starts with. What reaching zero *means* is the server's, not the world file's. */
export interface ResolvedHealth {
  amount: number;
}

/** A destructible, naming a definition the source game holds elsewhere (CoD's `destructible_type`). */
export interface ResolvedDestructible {
  preset: string;
}

/**
 * What an object does, as against where it is. Each behaviour is its own node in
 * the world file, so its properties live in its own namespace — see
 * `BEHAVIOUR_TYPES` in schema.ts.
 */
export interface ResolvedBehaviours {
  health?: ResolvedHealth;
  destructible?: ResolvedDestructible;
}

/**
 * One place a player may start. A world may declare many, qualified by game mode
 * and side; `ResolvedWorld.spawn` is the unqualified fallback every world has.
 */
export interface ResolvedSpawn {
  position: Vec3;
  look: Vec3;
  /** The source game's own mode keys (`tdm`, `dom`, `sd`, ...). Undefined: any mode. */
  modes?: readonly string[];
  /** The side this belongs to (`allies`, `axis`, `attacker`, ...). Undefined: any side. */
  team?: string;
  /** A round-start spawn, used only for the opening spawn of a match. */
  start: boolean;
}

/**
 * How a usable thing is reached: standing inside its volume (`touch`), or with
 * the eye within reach of its centre and nothing in between (`near`). That it
 * can be used is all the world says — whether it must also be looked at, a
 * price, a prompt and what using it does are the script's.
 */
export type UseMode = "near" | "touch";

/**
 * A volume something can be inside. It draws nothing and does nothing on its
 * own: the world file says where a trigger is and what to call it, and the
 * server decides what being inside one means.
 */
export interface ResolvedTrigger {
  /** Numbered after every object, so object ids stay dense from zero. */
  id: EntityId;
  name?: string;
  /** Group handles, not unique. Empty when the node declared none. */
  tags: readonly string[];
  /** A tag this points at: every node carrying it. What the link means is a script's. */
  target?: string;
  /** The game modes this exists in. Undefined: every mode (`presentIn`). */
  modes?: readonly string[];
  /** Usable, and how it is reached. Undefined: occupancy only. */
  use?: UseMode;
  position: Vec3;
  /** Radians. */
  yaw: number;
  /** A box's full extents. Mutually exclusive with `radius`. */
  size?: Vec3;
  /** A sphere's reach, or a cylinder's when `height` is given too. */
  radius?: number;
  /** Only with `radius`: makes the volume a vertical cylinder rather than a sphere. */
  height?: number;
}

/**
 * A tagged position with a facing, for a script: where a creature appears, where
 * a player is sent. Faces the way a `ResolvedSpawn` does, by a point to look at.
 */
export interface ResolvedPoint {
  /** Numbered after every older kind, so no existing id moves. */
  id: EntityId;
  name?: string;
  tags: readonly string[];
  position: Vec3;
  /** A point to face, world space. One metre north of `position` when not declared. */
  look: Vec3;
  target?: string;
  modes?: readonly string[];
}

/**
 * A part of the world's `collision` glb that can be absent — outside its
 * `modes`, or once a script removes it. A part no `solid` names is base, and
 * always present. Presence is applied where things are built, never here.
 */
export interface ResolvedSolid {
  /** Numbered after the points, so no existing id moves. */
  id: EntityId;
  name?: string;
  /** The part's name in the glb (`extras.part`), e.g. `*12`. Unique within a world. */
  part: string;
  tags: readonly string[];
  modes?: readonly string[];
  use?: UseMode;
}

/**
 * Where a world plays one of its effects: a placement, against the `fx` library.
 *
 * Purely cosmetic and client-side — nothing here crosses the wire, and no
 * simulation reads it. The definition says what the effect looks like; this says
 * only where it plays and when it starts.
 */
export interface ResolvedEffect {
  /** Numbered with the triggers and mantles, after every object, so object ids stay dense from zero. */
  id: EntityId;
  name?: string;
  tags: readonly string[];
  /** Where the effect plays, world space. */
  position: Vec3;
  /** Radians, three.js' convention. An effect can be oriented on all three axes: a sand spray is aimed. */
  rotation: Vec3;
  /**
   * Which effect, by name, inside the world's `fx` library. Not checked here: the
   * library is an asset file the resolver never reads, exactly as `animate` names
   * a clip inside a glTF.
   */
  fx: string;
  /**
   * Seconds before the first spawn. Negative means the emitter starts already
   * running, pre-warmed by that much, which is what stops a map's ambient effects
   * from visibly winding up as a world loads.
   */
  delay: number;
  /**
   * Seconds, or 0 for a placement that plays once. A repeating effect starts a new
   * instance once the last has finished and at least this long has passed since it
   * started, polling every quarter second (Black Ops' `loopfx`, clientscripts/mp/_fx.csc).
   */
  repeat: number;
}

/**
 * Where a world plays one of its sound aliases: a placement, against the
 * `sounds` table.
 *
 * The alias says what it sounds like — its clips, its own volume and pitch
 * ranges, whether it loops; this says only where it plays and how the world
 * bends it. Nothing here crosses the wire: ambience is derived from the world
 * text both ends already hold.
 */
export interface ResolvedSound {
  /** Numbered after every other kind, so no existing id moves. */
  id: EntityId;
  name?: string;
  tags: readonly string[];
  /**
   * Where it plays, world space — **undefined is not the origin**. A placement
   * with no `at` is the world's ambient bed: non-positional, at full volume
   * everywhere, which is what a map's stereo ambience track is. Give one a
   * position and a map-wide bed plays from one corner of the map.
   */
  position?: Vec3;
  /**
   * Which alias, by name, inside the world's `sounds` table. Not checked here:
   * the table is an asset file the resolver never reads, exactly as `animate`
   * names a clip inside a glTF.
   */
  alias: string;
  /** Scales the alias' own volume. 1 leaves it alone. */
  volume: number;
  /**
   * Metres, replacing the alias' own pair: full volume within the first, and
   * **never started at all** past the second — a hard cap, not the end of a
   * curve (docs/engine/audio.md). Undefined: the alias' own reach stands.
   */
  range?: [number, number];
  /** Seconds before it starts. Negative starts it already running, as an `effect`'s does. */
  delay: number;
}

/**
 * Where a player may climb: one of the map's own mantle volumes.
 *
 * The box encloses the obstacle with room to spare on every side, and its **top
 * is the surface they end on**, so `size` carries the region and roughly the
 * climb height at once; the collision decides the rest (sim/mantle.ts). Nothing
 * draws it and nothing collides with it — it is a permission region, and putting
 * it in a BVH would make every ledge an invisible wall.
 *
 * A world point is inside it when `rotateY(point - position, -yaw)` lies within
 * half of `size` on each axis. The exporter fits its boxes with that same
 * inverse (`scripts/cod/mantle.py`'s `box_at`), and getting the sign wrong would
 * mirror every turned volume about its own centre rather than fail outright.
 */
export interface ResolvedMantle {
  /** Numbered with the triggers, after every object, so object ids stay dense from zero. */
  id: EntityId;
  name?: string;
  tags: readonly string[];
  /** The box's centre, world space. */
  position: Vec3;
  /** Radians about +Y, three.js' convention. */
  yaw: number;
  /** The box's full extents. `size.y` is the climb height. */
  size: Vec3;
  /**
   * Which mantle the source map called this, when it said: `onto` climbs onto
   * the surface, `over` vaults across it. The game spells the first `mantle_on`,
   * but `on` is a boolean in this DSL, so the node says `onto`.
   *
   * Undefined is the common case rather than the exception — a Black Ops volume
   * never names one, and neither does an axial brush on any game — so a reader
   * must have a default rather than treat it as missing data.
   */
  kind?: "onto" | "over";
}

/**
 * Where a player may climb a ladder: one of the map's own ladder brushes.
 *
 * The box **is** the ladder — in an imported map, the thin player-clip brush the
 * game flags as one, which the world's collision already holds as a wall. This
 * adds only the permission: a player whose probe ahead touches the box, on a
 * side that counts, grabs it (sim/ladder.ts). Nothing draws it.
 *
 * The frame is `ResolvedMantle`'s: a world point is inside when
 * `rotateY(point - position, -yaw)` lies within half of `size` on each axis.
 */
export interface ResolvedLadder {
  /** Numbered with the triggers, mantles and effects, after every object. */
  id: EntityId;
  name?: string;
  tags: readonly string[];
  /** The box's centre, world space. */
  position: Vec3;
  /** Radians about +Y, three.js' convention. */
  yaw: number;
  /** The box's full extents. */
  size: Vec3;
  /**
   * The one side that can be climbed, in the box's own frame: `front` has its
   * outward normal along local -Z, `back` +Z, `left` -X, `right` +X. Undefined
   * is the common case and means every side can, which is what the maps say
   * for 147 of their 154 ladders.
   */
  face?: "front" | "back" | "left" | "right";
}

export interface ResolvedObject {
  /** Runtime address, unique within a world and dense across it. Assigned on emission. */
  id: EntityId;
  name?: string;
  /** Group handles, unlike `name` not unique: `WorldIndex.byTag` returns every object sharing one. Empty when none. */
  tags: readonly string[];
  /** `model` only: the game modes this exists in. Undefined: every mode (`presentIn`). */
  modes?: readonly string[];
  position: Vec3; // world space, geometric center
  rotation: Vec3; // radians, euler XYZ
  scale: Vec3;
  size: Vec3; // the author's DECLARED footprint, not measured from the asset
  /** `model` only: the name of the declared `asset` this places. */
  asset?: string;
  /** `model` only: path to a baked lighting texture, relative to the world folder. Sampled through the asset's second UV set. */
  lightmap?: string;
  /** Multiplier on `lightmap`'s contribution; meaningless without it. Defaults to 1. */
  lightmapIntensity?: number;
  /** `model` only: coplanar with the surface beneath, so it gets a depth bias (scene/importedMaterials.ts). */
  decal?: boolean;
  /** `model` only: the glTF animation clip this placement loops. Not checked here: the clip lives in the asset file. */
  animation?: string;
  collide: CollideMode;
  visible: boolean;
  /** What this object does. Undefined when the placement declared no `behaviours` block. */
  behaviours?: ResolvedBehaviours;
}

export interface ResolvedLight {
  name?: string;
  type: "directional" | "point" | "spot" | "ambient";
  position: Vec3;
  rotation: Vec3;
  /**
   * `rotate:` was authored, so `rotation` is where the light points. A light in
   * a rotated group inherits that yaw either way, so `rotation` alone cannot say.
   */
  aimed: boolean;
  intensity: number;
  color?: string;
  shadows: boolean;
}

/**
 * Colour grading: a tint per luminance zone plus a pull toward grey, in the
 * shape of a CoD `.vision` film tweak. Tints are linear multipliers (1 is
 * neutral) applied after tone mapping, as authored (engine/grade.ts).
 */
export interface ResolvedGrade {
  /** Multiplier for the brightest zone. */
  lightTint: Vec3;
  /** Multiplier for midtones. */
  mediumTint: Vec3;
  /** Multiplier for the darkest zone. */
  darkTint: Vec3;
  /** How far bright pixels are pulled toward their own luminance, 0..1. */
  desaturation: number;
  /** The same for dark pixels; CoD grades them separately and usually less. */
  desaturationDark: number;
  /** Applied last as `pow(colour, 1 / gamma)`: 1 is neutral, above 1 lifts the midtones. Always positive. */
  gamma: number;
}

/**
 * A `minimap`: a top-down image lying on the ground plane. Its right edge runs
 * along `rotateY(east, rotation)` and its top along `rotateY(north, rotation)`.
 */
export interface ResolvedMinimap {
  /** World-relative path to the image. */
  source: string;
  /** The ground point under the image's centre. */
  center: { x: number; z: number };
  /** Metres of ground across the image, left to right. */
  width: number;
  /** Metres of ground down the image, top to bottom. */
  depth: number;
  /** Radians; the three.js yaw convention, as every `rotate:` (dsl/resolveUtil.ts rotateY). */
  rotation: number;
  /** Metres from the player to the edge of the HUD map. */
  range: number;
}

/**
 * A Call of Duty this repo imports from, as its zone key.
 *
 * The same token the catalogue's paths use (`catalog/<kind>/<game>/<id>`), so a
 * world's `game:` and a catalogue entry's folder are comparable without a mapping
 * table. `category:` is the prose the menu groups by; this is what the engine
 * reads to pick a game's factions and player clips.
 */
export type GameKey = "iw4" | "iw5" | "iw6" | "t5" | "t6" | "s1";

export interface ResolvedWorld {
  name: string;
  description?: string;
  /**
   * The game this world was imported from. Undefined for a hand-written world,
   * which has no game's cast to draw from and whose peers stay capsules.
   */
  game?: GameKey;
  ambient?: string;
  sky?: string;
  visibility?: number;
  exposure: number;
  /** Colour grading, if the world declares a `grade` node. */
  grade?: ResolvedGrade;
  assets: Record<string, ResolvedAsset>;
  /** The map's own collision mesh, if the world declares one. Drawn by nothing; collided against by everything. */
  collision?: { source: string };
  /** The map's path-node graph, a `nav.bin` (docs/engine/nav-format.md), if the world declares one. Absent: no bot navigation. */
  navigation?: { source: string };
  /** The HUD map, if the world declares one (app/minimap.ts). */
  minimap?: ResolvedMinimap;
  lights: ResolvedLight[];
  topLevelObjects: ResolvedObject[];
  /** The fallback start: the first unqualified `spawn`, else derived. Every world has one. */
  spawn: { position: Vec3; look: Vec3 };
  /** Every `spawn` the world declared, in declaration order. Empty for a world that declared none. */
  spawnPoints: ResolvedSpawn[];
  triggers: ResolvedTrigger[];
  /** Every `mantle` volume, in declaration order. Empty for a world that declared none. */
  mantles: ResolvedMantle[];
  /** Every `ladder`, in declaration order. Empty for a world that declared none. */
  ladders: ResolvedLadder[];
  /** The effect definitions the world draws from, if it declares an `fx` node. */
  fx?: { source: string };
  /** Every `effect` placement, in declaration order. Empty for a world that declared none. */
  effects: ResolvedEffect[];
  /**
   * The alias table the world draws from, if it declares a `sounds` node. Named
   * for what it is rather than after its node, because the placements below are
   * what `sounds` reads as in a list of them.
   */
  soundLibrary?: { source: string };
  /** Every `sound` placement, in declaration order. Empty for a world that declared none. */
  sounds: ResolvedSound[];
  /** Every `point`, in declaration order. Empty for a world that declared none. */
  points: ResolvedPoint[];
  /** Every `solid`, in declaration order. Empty for a world that declared none: every part is then base. */
  solids: ResolvedSolid[];
}

export interface ResolveResult {
  world?: ResolvedWorld;
  diagnostics: Diagnostic[];
}
