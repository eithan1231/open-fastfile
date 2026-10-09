// Node-type and property registry for the .world DSL, plus the validator
// that walks a parsed AST against it.
//
// This module answers "is this syntactically-valid file semantically sane?":
// unknown node types/property keys (with "did you mean"), wrong arity or
// primitive kind for a value, missing/invalid names, disallowed nesting,
// and duplicate names within a scope. It deliberately does NOT resolve
// anchors, units, or defaults, or check that references exist across the
// whole file — that cross-cutting work needs the full tree and lives in
// resolve.ts. Keeping schema checks purely local to one node keeps the
// error messages precise and keeps this file easy to extend with new
// node types.
//
// **Property names are global.** PROPERTY_KINDS is keyed by property name across
// every node type, so one key cannot carry two meanings: `type` is a light's
// enum, `kind` is a mantle's, `size` is a box's extent. A new node wanting one of
// those needs a different word, not a second entry. Three nodes have hit this.
//
// Two words are also reserved by the parser rather than by this table: `on` and
// `off` are BOOL_WORDS (parser.ts), so they reach an enum already parsed as a
// boolean and can never be `enumValues`. That is why `mantle`'s kind says `onto`
// where the game says `mantle_on`.

import type { ObjectNode, PropertyNode, Statement, Value } from "./ast.js";
import { isIncludeNode, isObjectNode, isPropertyNode } from "./ast.js";
import type { Diagnostic } from "./diagnostics.js";
import { didYouMean, error, warning } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Property kinds
// ---------------------------------------------------------------------------

export type PrimitiveKind = "number" | "string" | "color" | "bool" | "ref" | "enum";
export type UnitCategory = "length" | "angle" | "none";

export interface PropertyKind {
  valueKind: PrimitiveKind;
  unit?: UnitCategory; // only meaningful when valueKind === "number"
  minArity: number;
  maxArity: number;
  enumValues?: string[]; // only meaningful when valueKind === "enum"
  /**
   * Extra bare words this property accepts *alongside* its `valueKind` — for a
   * property that is mostly one kind but has a named special case. `collide` is
   * the case in point: `true`/`false` cover "solid" and "not", and `box` adds
   * "solid, but as a box rather than this mesh". Keeping that on one property
   * beats inventing a second one for the same concept — see the `height`
   * cautionary tale in CLAUDE.md's "Known rough edges".
   */
  alsoEnum?: string[];
}

// A declarative table: one property per line reads far better than the
// reflowed multi-line objects Prettier would otherwise produce, hence the
// directive below (which must be exactly `// prettier-ignore` to take effect).
// prettier-ignore
export const PROPERTY_KINDS: Record<string, PropertyKind> = {
  name: { valueKind: "string", minArity: 1, maxArity: 1 },
  description: { valueKind: "string", minArity: 1, maxArity: 1 },
  category: { valueKind: "string", minArity: 1, maxArity: 1 },
  // `world` only: which Call of Duty the map was imported from, as the zone key
  // the catalogue's paths use (`catalog/<kind>/<game>/<id>`) rather than the
  // friendly name, so no table maps one to the other. `category` is prose for the
  // menu; this is the engine's, and what picks a game's factions and player clips.
  game: { valueKind: "enum", enumValues: ["iw4", "iw5", "iw6", "t5", "t6", "s1"], minArity: 1, maxArity: 1 },
  // `model` only: a baked lighting texture, sampled through the glTF's second UV set.
  lightmap: { valueKind: "string", minArity: 1, maxArity: 1 },
  "lightmap-intensity": { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },
  decal: { valueKind: "bool", minArity: 1, maxArity: 1 },
  // `model` only: the name of an animation clip inside the asset's glTF, played on a loop.
  // A string, not a ref: the clip lives in the file, which resolve never reads.
  animate: { valueKind: "string", minArity: 1, maxArity: 1 },
  // A group handle, deliberately NOT unique: `name` addresses one object,
  // `tag` addresses every object that shares it (the exporter writes CoD's
  // `targetname` here, and 21 of dome-mw3's 47 are shared). Several values put a
  // node in several sets at once: a spawner's group, its kind and how it enters.
  tag: { valueKind: "string", minArity: 1, maxArity: 8 },
  // `trigger` and `point`: this node points at every node carrying that tag. The
  // one cross-reference in the format; what the link *means* is a script's.
  target: { valueKind: "string", minArity: 1, maxArity: 1 },
  // `trigger` and `solid`: this can be used, and how a player reaches it —
  // standing inside (`touch`) or within reach of its centre (`near`). Everything
  // else (look-at, price, prompt, effect) belongs to the script, not the world.
  use: { valueKind: "enum", enumValues: ["near", "touch"], minArity: 1, maxArity: 1 },
  // `solid`: a part of the world's `collision` glb, by the name the exporter
  // gave it (`*12`, a brush model's). A string, not a ref: it lives in the file.
  part: { valueKind: "string", minArity: 1, maxArity: 1 },

  at: { valueKind: "number", unit: "length", minArity: 1, maxArity: 3 },
  rotate: { valueKind: "number", unit: "angle", minArity: 1, maxArity: 3 },
  scale: { valueKind: "number", unit: "none", minArity: 1, maxArity: 3 },
  size: { valueKind: "number", unit: "length", minArity: 1, maxArity: 3 },
  look: { valueKind: "number", unit: "length", minArity: 3, maxArity: 3 },

  height: { valueKind: "number", unit: "length", minArity: 1, maxArity: 1 },
  intensity: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },


  color: { valueKind: "color", minArity: 1, maxArity: 1 },
  ambient: { valueKind: "color", minArity: 1, maxArity: 1 },

  asset: { valueKind: "ref", minArity: 1, maxArity: 1 },

  collide: { valueKind: "bool", alsoEnum: ["box", "hull"], minArity: 1, maxArity: 1 },
  visible: { valueKind: "bool", minArity: 1, maxArity: 1 },
  shadows: { valueKind: "bool", minArity: 1, maxArity: 1 },

  type: { valueKind: "enum", enumValues: ["directional", "point", "spot", "ambient"], minArity: 1, maxArity: 1 },

  source: { valueKind: "string", minArity: 1, maxArity: 1 },
  // `asset` only: the catalogue entry `source` hangs off, `<kind>/<game>/<id>`.
  // A prefix selector rather than an alternative to `source`, which stays
  // required — `NodeTypeSpec.required` is unconditional, so "one of these two"
  // is not expressible here, and an author reads one rule instead of two.
  catalog: { valueKind: "string", minArity: 1, maxArity: 1 },
  // The distance past which an `asset` is culled. Parsed but not yet used:
  // nothing culls by distance, and exports predating the fix carry a wrong value.
  until: { valueKind: "number", unit: "length", minArity: 1, maxArity: 1 },
  // Which level of an `asset`'s LOD chain doubles as its collision hull, the
  // game's own XModel.collLod. Only 0 (`source`) is expressible: an `asset`
  // has no `lod` children, so resolve.ts rejects anything else.
  hull: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },
  sky: { valueKind: "color", minArity: 1, maxArity: 1 },
  visibility: { valueKind: "number", unit: "length", minArity: 1, maxArity: 1 },
  exposure: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },

  // `grade` (colour grading). Linear RGB multipliers per luminance zone, and
  // how far each zone is pulled toward grey. Straight out of a CoD .vision
  // file's r_filmLightTint / r_filmMediumTint / r_filmDarkTint /
  // r_filmDesaturation / r_filmDesaturationDark.
  "light-tint": { valueKind: "number", unit: "none", minArity: 3, maxArity: 3 },
  "medium-tint": { valueKind: "number", unit: "none", minArity: 3, maxArity: 3 },
  "dark-tint": { valueKind: "number", unit: "none", minArity: 3, maxArity: 3 },
  desaturation: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },
  "desaturation-dark": { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },
  // The grade's last step: `pow(colour, 1 / gamma)`, so 1 is neutral and above
  // it lifts the midtones. Not from a .vision file; an author's knob.
  gamma: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },



  // How far something reaches, in metres: a `minimap`'s is from the player to
  // the edge of the HUD map (one value); a `sound`'s is its alias' own [ref,
  // max] overridden (two, through `rangeArity`).
  range: { valueKind: "number", unit: "length", minArity: 1, maxArity: 1 },

  // Behaviours (see BEHAVIOUR_TYPES). Each one is scoped to its own node, so
  // these names cannot collide with a placement's — which is the whole reason
  // behaviours are a block rather than more properties on `model`. `preset` is
  // not spelled `type` precisely because `light` already owns that name.
  amount: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },
  preset: { valueKind: "string", minArity: 1, maxArity: 1 },

  // Which game modes a node exists in, and a spawn's side. Free strings rather
  // than an enum — the modes are the source game's (`tdm`, `dom`, `sd`, ...) and
  // a new import must not have to teach this file about its own. Absent `mode`
  // is every mode; a wager barrier exists in four.
  mode: { valueKind: "string", minArity: 1, maxArity: 32 },
  team: { valueKind: "string", minArity: 1, maxArity: 1 },
  start: { valueKind: "bool", minArity: 1, maxArity: 1 },

  // `trigger`: a sphere's reach, as an alternative to a box's `size`.
  radius: { valueKind: "number", unit: "length", minArity: 1, maxArity: 1 },

  // Which mantle a `mantle` volume is. Two names are forced here, and both are
  // worth knowing: not `type`, because that key is already a light's enum and
  // PROPERTY_KINDS is keyed by property name across every node; and `onto`
  // rather than the game's own `on`, because `on` is a BOOL_WORD in the parser
  // (`shadows: on`) and would reach this enum already parsed as `true`.
  kind: { valueKind: "enum", enumValues: ["onto", "over"], minArity: 1, maxArity: 1 },

  // An `effect` placement: which effect out of the `fx` library, and how long the
  // map holds it back. `fx` is a quoted string rather than a `ref` for the reason
  // `animate` is one -- the name lives inside an asset file the resolver never
  // reads, so there is nothing here to point at.
  fx: { valueKind: "string", minArity: 1, maxArity: 1 },
  // Seconds, on an `effect` or a `sound`. Negative means it starts already
  // running, which is what stops every ambient effect in a map from visibly
  // winding up on load.
  delay: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },
  // Seconds, on an `effect`: play it again once it has finished and at least this
  // long has passed since it last started (Black Ops' createfx `loopfx`).
  repeat: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },

  // A `sound` placement: which alias out of the world's `sounds` table, and how
  // loud. `alias` is a bare name rather than a quoted string because that is what
  // an alias is in the table it indexes; it is not spelled `sound` because the
  // node already is. `volume` scales the alias' own, so 1 leaves it alone.
  alias: { valueKind: "ref", minArity: 1, maxArity: 1 },
  volume: { valueKind: "number", unit: "none", minArity: 1, maxArity: 1 },

  // Which side of a `ladder` is the one to climb, in the box's own frame: front
  // faces local -Z (where yaw 0 looks), back +Z, left -X, right +X. Absent, every
  // side is, as in the maps: almost every ladder brush flags all of its faces.
  face: { valueKind: "enum", enumValues: ["front", "back", "left", "right"], minArity: 1, maxArity: 1 },
};

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export type NameMode = "none" | "optional-free" | "required-free";

export interface NodeTypeSpec {
  type: string;
  nameMode: NameMode;
  properties: string[];
  /** Child node types allowed in this node's body. `"none"` = no nested nodes at all. */
  children: string[] | "none";
  /**
   * Properties the node is meaningless without.
   *
   * Deliberately an unconditional list — "this key must be present" is local to
   * one node, which is the line schema.ts draws (see the module header). It is
   * *not* the conditional-property support the known rough edges call for: no
   * entry here may depend on a sibling property's presence or value.
   */
  required?: string[];
  /** Overrides PROPERTY_KINDS["size"].{minArity,maxArity} for this node type. */
  sizeArity?: [number, number];
  /** Overrides PROPERTY_KINDS["at"].{minArity,maxArity} for this node type. */
  atArity?: [number, number];
  /** Overrides PROPERTY_KINDS["rotate"].{minArity,maxArity} for this node type. */
  rotateArity?: [number, number];
  /** Overrides PROPERTY_KINDS["range"].{minArity,maxArity} for this node type. */
  rangeArity?: [number, number];
  /** At most one per scope: the resolver reads the first and ignores the rest, so a second warns. */
  singleton?: true;
}

const PLACEMENT_PROPS = ["at", "rotate", "scale", "collide", "visible", "tag"];

// prettier-ignore
export const TOP_LEVEL_TYPES = ["world", "grade", "asset", "collision", "navigation", "group", "spawn", "light", "minimap", "trigger", "mantle", "ladder", "fx", "effect", "sounds", "sound", "point", "solid"];

const GROUP_CHILDREN = ["model", "group", "light", "trigger", "mantle", "ladder", "effect", "sound"];

/** The behaviours a `behaviours` block may hold. Append; each is a node type below. */
export const BEHAVIOUR_TYPES = ["health", "destructible"] as const;
export type BehaviourType = (typeof BEHAVIOUR_TYPES)[number];

// Same as PROPERTY_KINDS above: a hand-aligned registry, kept one entry per
// line on purpose.
/**
 * Nodes a world may no longer declare, and what to do instead.
 *
 * Kept rather than simply deleted. Dropping one from NODE_TYPES gives `unknown
 * node type "viewmodel"` with a did-you-mean, which is correct and useless — the
 * fix is to delete a file and an include, not to fix a spelling. And saying
 * nothing would be worse than either: the world would look fine and quietly stop
 * dressing its players, which is exactly the "trap that produces a plausible
 * wrong result" that CLAUDE.md says earns an assertion.
 *
 * A retired node parses, errors once, and resolves to nothing.
 */
const RETIRED_TYPES: Readonly<Record<string, string>> = {
  viewmodel: "what a player holds is a gametype's choice now (packages/shared/src/game/). Delete viewmodel.world and its `include` from world.world.",
  characters: "what a player wears is a gametype's choice now (packages/shared/src/game/). Delete characters.world and its `include` from world.world.",
};

function retirementOf(type: string): string | undefined {
  return Object.hasOwn(RETIRED_TYPES, type) ? RETIRED_TYPES[type] : undefined;
}

// prettier-ignore
export const NODE_TYPES: Record<string, NodeTypeSpec> = {
  world: { type: "world", nameMode: "none", singleton: true, properties: ["name", "description", "category", "game", "ambient", "sky", "visibility", "exposure"], children: "none" },

  grade: { type: "grade", nameMode: "none", singleton: true, properties: ["light-tint", "medium-tint", "dark-tint", "desaturation", "desaturation-dark", "gamma"], children: "none" },


  // A glTF model, declared once and placed by any number of `model` nodes.
  // Named and top-level for exactly the reason `material` is: the mesh belongs
  // to the asset, not to where it stands, and interchange-mw3 places 232 assets
  // 8,420 times. One level only — `source` — until the DSL grows a LOD chain.
  asset: { type: "asset", nameMode: "required-free", properties: ["source", "catalog", "until", "hull"], children: "none", required: ["source"] },

  // The map's own collision, exported from the game's clipmap rather than
  // derived from what you can see (scripts/cod/collision.py). It is a
  // separate node rather than an invisible `model` because a model with
  // `visible: false` is dropped from the BVH — StaticGeometryGenerator walks
  // with traverseVisible — which is exactly the trap scene/materials.ts's
  // HIDDEN_COLLIDER exists to document. Here scene/ applies that material for
  // the author.
  collision: { type: "collision", nameMode: "none", singleton: true, properties: ["source"], children: "none", required: ["source"] },
  // The map's own path nodes, as one `nav.bin` (docs/engine/nav-format.md):
  // `collision`'s shape, for the same reason — a file the exporter wrote, which
  // nothing draws. A world without one has no bot navigation.
  navigation: { type: "navigation", nameMode: "none", singleton: true, properties: ["source"], children: "none", required: ["source"] },
  // The effect definitions this world draws from, as one file: `collision`'s shape,
  // not `asset`'s. A world has one library rather than one node per effect, because
  // an effect names others (on death, on impact, through a runner) and the exporter
  // ships that closure as a unit.
  fx: { type: "fx", nameMode: "none", singleton: true, properties: ["source"], children: "none", required: ["source"] },
  // The alias table this world draws from, and `fx`'s shape for `fx`'s reason: an
  // alias names clips and may name a second alias as a layer, so the exporter
  // ships that closure as one file rather than as a node per alias.
  sounds: { type: "sounds", nameMode: "none", singleton: true, properties: ["source"], children: "none", required: ["source"] },

  // A top-down image laid flat on the ground plane, for the HUD's map: `at` is
  // its centre (x z), `size` the ground it covers (width depth), `rotate` the
  // yaw of its top edge away from north. The image has no height.
  minimap: { type: "minimap", nameMode: "none", singleton: true, properties: ["source", "at", "size", "rotate", "range"], children: "none", required: ["source", "at", "size"], atArity: [2, 2], sizeArity: [2, 2], rotateArity: [1, 1] },


  group: {
    type: "group",
    nameMode: "optional-free",
    properties: [...PLACEMENT_PROPS],
    children: GROUP_CHILDREN,
  },


  spawn: { type: "spawn", nameMode: "none", properties: ["at", "look", "mode", "team", "start"], children: "none", atArity: [3, 3] },

  light: {
    type: "light",
    nameMode: "optional-free",
    properties: ["type", "at", "rotate", "intensity", "shadows", "color"],
    children: "none",
    atArity: [3, 3],
  },


  // A glTF/GLB asset. `size` is the author's DECLARED footprint, not read from
  // the file, which only loads later in scene/.
  // Same bargain every other shape already makes by stating its own size.
  model: { type: "model", nameMode: "optional-free", properties: [...PLACEMENT_PROPS, "size", "asset", "lightmap", "lightmap-intensity", "decal", "animate", "mode"], children: ["behaviours"], sizeArity: [3, 3], required: ["asset"] },

  // What an object *does*, as against where it is. One scoped block per
  // placement, holding one node per behaviour, so a behaviour's own properties
  // live in its own namespace: `health { amount: }` cannot be confused with
  // anything else, and adding a behaviour costs no property on `model`.
  behaviours: { type: "behaviours", nameMode: "none", singleton: true, properties: [], children: [...BEHAVIOUR_TYPES] },
  health: { type: "health", nameMode: "none", properties: ["amount"], children: "none", required: ["amount"] },
  // `preset` names a definition the source game holds elsewhere (CoD's
  // `destructible_type`), so it is carried, not interpreted here.
  destructible: { type: "destructible", nameMode: "none", properties: ["preset"], children: "none", required: ["preset"] },

  // A volume something can be inside. It draws nothing; what a trigger *does*
  // is not in the world file, which only says where it is and what to call it.
  trigger: { type: "trigger", nameMode: "optional-free", properties: ["at", "size", "radius", "height", "rotate", "tag", "target", "mode", "use"], children: "none", sizeArity: [3, 3] },

  // A tagged position with a facing, for whatever a script wants one for: where a
  // creature appears, where a player is sent. `spawn`'s shape, but a spawn is the
  // engine's and a point is a script's. Top level only, so `look` is world space.
  point: { type: "point", nameMode: "optional-free", properties: ["at", "look", "tag", "target", "mode"], children: "none", atArity: [3, 3], required: ["at"] },

  // A piece of the world's `collision` glb that can be absent: outside its
  // `mode`s, or once a script removes it. A part no `solid` names is always there.
  solid: { type: "solid", nameMode: "optional-free", properties: ["part", "tag", "mode", "use"], children: "none", required: ["part"] },
  effect: { type: "effect", nameMode: "optional-free", properties: ["at", "rotate", "fx", "delay", "repeat", "tag"], children: "none", rotateArity: [3, 3], required: ["fx"] },

  // Where the world plays one of its aliases. `at` is optional and that is the
  // whole difference from `effect`: a placement with no `at` is the world's bed,
  // played at full volume everywhere with no panner, which is what a map's stereo
  // ambience track is. It has no `rotate` — nothing here is aimed.
  sound: { type: "sound", nameMode: "optional-free", properties: ["at", "alias", "volume", "range", "delay", "tag"], children: "none", atArity: [3, 3], rangeArity: [2, 2], required: ["alias"] },

  // Where the game lets a player climb. The box is the space they stand in to
  // do it, and its top is the surface they end on, so `size` gives both the
  // region and the climb height. A permission region, not a collider: nothing
  // draws it and it is deliberately kept out of every BVH.
  mantle: { type: "mantle", nameMode: "optional-free", properties: ["at", "size", "rotate", "kind", "tag"], children: "none", sizeArity: [3, 3], required: ["at", "size"] },

  // Where the game lets a player climb a ladder. Unlike a mantle volume the box
  // is the ladder itself: in the maps it is also a player-clip brush, so the
  // world's collision already holds it as a wall, and this says only that
  // touching it (from `face`, if given) is a grip. Nothing draws it.
  ladder: { type: "ladder", nameMode: "optional-free", properties: ["at", "size", "rotate", "face", "tag"], children: "none", sizeArity: [3, 3], required: ["at", "size"] },
};

// Both registries are plain objects, so `in` and a bare index also answer for
// `constructor`, `__proto__` and friends. Every lookup goes through these.

export function nodeSpec(type: string): NodeTypeSpec | undefined {
  return Object.hasOwn(NODE_TYPES, type) ? NODE_TYPES[type] : undefined;
}

function propertyKind(key: string): PropertyKind | undefined {
  return Object.hasOwn(PROPERTY_KINDS, key) ? PROPERTY_KINDS[key] : undefined;
}

export function isKnownType(type: string): boolean {
  return nodeSpec(type) !== undefined;
}

// A node's allowed properties and children as sets, built once. `includes` over
// a spec's list ran for every property of every node — 50k properties on
// interchange-mw3, against lists of twenty-odd strings.
const PROPERTY_SETS = new Map<string, ReadonlySet<string>>(Object.entries(NODE_TYPES).map(([type, spec]) => [type, new Set(spec.properties)]));
const CHILD_SETS = new Map<string, ReadonlySet<string>>(
  Object.entries(NODE_TYPES)
    .filter(([, spec]) => spec.children !== "none")
    .map(([type, spec]) => [type, new Set(spec.children as readonly string[])]),
);

function allowsProperty(nodeType: string, key: string): boolean {
  return PROPERTY_SETS.get(nodeType)?.has(key) === true;
}

function allowsChild(nodeType: string, childType: string): boolean {
  return CHILD_SETS.get(nodeType)?.has(childType) === true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function valueKindOf(v: Value): PrimitiveKind {
  if (v.kind === "ref") {
    return "ref";
  } // enum/ref both come from bare idents; checked contextually below
  return v.kind;
}

function describeExpected(kind: PropertyKind): string {
  switch (kind.valueKind) {
    case "number":
      return kind.unit === "angle"
        ? "an angle (number, optionally with deg/rad)"
        : kind.unit === "length"
          ? "a length (number, optionally with m/cm/mm/ft/in)"
          : "a plain number";
    case "string":
      return "a quoted string";
    case "color":
      return "a color (#rgb or #rrggbb)";
    case "bool":
      return "a boolean (true/false/on/off)";
    case "ref":
      return "a reference (an identifier, optionally dotted)";
    case "enum":
      return `one of: ${kind.enumValues?.join(", ")}`;
  }
}

function validateProperty(nodeType: string, prop: PropertyNode, diags: Diagnostic[]): void {
  const kind = propertyKind(prop.key);
  if (!kind) {
    diags.push(error(`unknown property "${prop.key}"${didYouMean(prop.key, Object.keys(PROPERTY_KINDS))}`, prop.keySpan, "unknown-property"));
    return;
  }

  const spec = nodeSpec(nodeType);
  if (spec && !allowsProperty(nodeType, prop.key)) {
    diags.push(error(`property "${prop.key}" is not valid on ${nodeType}${didYouMean(prop.key, spec.properties)}`, prop.keySpan, "property-not-allowed"));
    return;
  }

  let minArity = kind.minArity;
  let maxArity = kind.maxArity;
  if (prop.key === "size" && spec?.sizeArity) {
    [minArity, maxArity] = spec.sizeArity;
  } else if (prop.key === "at" && spec?.atArity) {
    [minArity, maxArity] = spec.atArity;
  } else if (prop.key === "rotate" && spec?.rotateArity) {
    [minArity, maxArity] = spec.rotateArity;
  } else if (prop.key === "range" && spec?.rangeArity) {
    [minArity, maxArity] = spec.rangeArity;
  }

  if (prop.values.length === 0) {
    return;
  } // already reported by the parser as "expected a value"

  if (prop.values.length < minArity || prop.values.length > maxArity) {
    const arityDesc = minArity === maxArity ? `exactly ${minArity} value${minArity === 1 ? "" : "s"}` : `${minArity}-${maxArity} values`;
    diags.push(error(`property "${prop.key}" expects ${arityDesc}, found ${prop.values.length}`, prop.span, "bad-arity"));
    return;
  }

  for (const v of prop.values) {
    const actual = valueKindOf(v);
    if (kind.valueKind === "ref") {
      // Any bare/dotted identifier is acceptable syntactically; existence is
      // checked by the resolver, which has the full symbol table.
      if (actual !== "ref") {
        diags.push(error(`property "${prop.key}" expects ${describeExpected(kind)}, found ${v.kind}`, v.span, "bad-value-kind"));
      }
      continue;
    }
    if (kind.valueKind === "enum") {
      if (v.kind !== "ref" || v.path.length !== 1) {
        diags.push(error(`property "${prop.key}" expects ${describeExpected(kind)}, found ${v.kind}`, v.span, "bad-value-kind"));
        continue;
      }
      const word = v.path[0]!;
      if (!kind.enumValues?.includes(word)) {
        diags.push(
          error(
            `invalid value "${word}" for "${prop.key}" — expected ${describeExpected(kind)}${didYouMean(word, kind.enumValues ?? [])}`,
            v.span,
            "bad-enum-value",
          ),
        );
      }
      continue;
    }
    // A property may accept a few named bare words on top of its own kind
    // (`collide: box` alongside `collide: true`). A bare word parses as a ref,
    // so this has to be checked before the kind mismatch below rejects it.
    if (kind.alsoEnum && v.kind === "ref") {
      if (v.path.length !== 1 || !kind.alsoEnum.includes(v.path[0]!)) {
        const word = v.path.join(".");
        diags.push(
          error(
            `invalid value "${word}" for "${prop.key}" — expected ${describeExpected(kind)} or ${kind.alsoEnum.map((w) => `"${w}"`).join("/")}${didYouMean(word, kind.alsoEnum)}`,
            v.span,
            "bad-enum-value",
          ),
        );
      }
      continue;
    }
    if (actual !== kind.valueKind) {
      diags.push(error(`property "${prop.key}" expects ${describeExpected(kind)}, found ${v.kind}`, v.span, "bad-value-kind"));
      continue;
    }
    if (kind.valueKind === "number" && v.kind === "number") {
      const category = unitCategoryOf(v.unit);
      if (kind.unit === "none" && v.unit !== undefined) {
        diags.push(error(`property "${prop.key}" does not take a unit, found "${v.unit}"`, v.span, "unexpected-unit"));
      } else if ((kind.unit === "length" || kind.unit === "angle") && v.unit !== undefined && category !== kind.unit) {
        diags.push(error(`property "${prop.key}" expects ${describeExpected(kind)}, found unit "${v.unit}"`, v.span, "wrong-unit-category"));
      }
    }
    // three.js reads neither #rgba nor #rrggbbaa: it leaves the material white
    // and warns to the console, which is a worse answer than this one.
    if (kind.valueKind === "color" && v.kind === "color" && !OPAQUE_HEX.test(v.value)) {
      diags.push(
        error(`"${v.value}" carries an alpha channel, which "${prop.key}" has no use for — write it as #rgb or #rrggbb`, v.span, "color-alpha-unsupported"),
      );
    }
  }
}

const OPAQUE_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;

const LENGTH_UNITS = new Set(["m", "cm", "mm", "ft", "in"]);
const ANGLE_UNITS = new Set(["deg", "rad"]);

function unitCategoryOf(unit: string | undefined): UnitCategory {
  if (unit === undefined) {
    return "none";
  }
  if (LENGTH_UNITS.has(unit)) {
    return "length";
  }
  if (ANGLE_UNITS.has(unit)) {
    return "angle";
  }
  return "none";
}

function validateNode(node: ObjectNode, isTopLevel: boolean, diags: Diagnostic[]): void {
  const retired = retirementOf(node.type);
  if (retired !== undefined) {
    diags.push(error(`"${node.type}" is no longer a world's to declare: ${retired}`, node.typeSpan, "node-retired"));
    return;
  }
  if (!isKnownType(node.type)) {
    const pool = isTopLevel ? TOP_LEVEL_TYPES : Object.keys(NODE_TYPES);
    diags.push(error(`unknown node type "${node.type}"${didYouMean(node.type, pool)}`, node.typeSpan, "unknown-type"));
    return;
  }

  const spec = nodeSpec(node.type)!;

  if (isTopLevel && !TOP_LEVEL_TYPES.includes(node.type)) {
    diags.push(error(`"${node.type}" cannot appear at the top level of a world file`, node.typeSpan, "type-not-allowed-here"));
  }

  switch (spec.nameMode) {
    case "none":
      if (node.name) {
        diags.push(warning(`"${node.type}" does not take a name; "${node.name}" is ignored`, node.nameSpan!, "unexpected-name"));
      }
      break;
    case "required-free":
      if (!node.name) {
        diags.push(error(`"${node.type}" requires a name, e.g. "${node.type} my${node.type}"`, node.typeSpan, "missing-name"));
      }
      break;
    case "optional-free":
      break;
  }

  // Only the keys are read back, and a leaf node (every `asset` in a generated
  // props file) has no child to name at all: both are built as they are needed.
  const seenKeys = new Set<string>();
  let seenNames: Map<string, ObjectNode> | undefined;
  const seenSingletons = new Set<string>();

  for (const stmt of node.body) {
    if (isPropertyNode(stmt)) {
      if (seenKeys.has(stmt.key)) {
        diags.push(warning(`duplicate property "${stmt.key}" — the later value wins`, stmt.keySpan, "duplicate-property"));
      }
      seenKeys.add(stmt.key);
      validateProperty(node.type, stmt, diags);
    } else if (isObjectNode(stmt)) {
      if (spec.children === "none") {
        diags.push(error(`"${node.type}" cannot contain nested nodes (found "${stmt.type}")`, stmt.typeSpan, "children-not-allowed"));
      } else if (!allowsChild(node.type, stmt.type) && isKnownType(stmt.type)) {
        diags.push(error(`"${stmt.type}" cannot appear inside "${node.type}"${didYouMean(stmt.type, spec.children)}`, stmt.typeSpan, "type-not-allowed-here"));
      }
      duplicateSingleton(stmt, seenSingletons, diags);
      if (stmt.name) {
        seenNames ??= new Map<string, ObjectNode>();
        const prior = seenNames.get(stmt.name);
        if (prior) {
          diags.push(error(`duplicate name "${stmt.name}" — already used by a ${prior.type} in this scope`, stmt.nameSpan!, "duplicate-name"));
        } else {
          seenNames.set(stmt.name, stmt);
        }
      }
      validateNode(stmt, false, diags);
    } else if (isIncludeNode(stmt)) {
      diags.push(error(`"include" is only allowed at the top level of a world file`, stmt.span, "include-not-allowed-here"));
    }
  }

  for (const key of spec.required ?? []) {
    if (!seenKeys.has(key)) {
      diags.push(error(`"${node.type}" requires a "${key}" property`, node.typeSpan, "missing-property"));
    }
  }
}

function duplicateSingleton(stmt: ObjectNode, seen: Set<string>, diags: Diagnostic[]): void {
  if (!nodeSpec(stmt.type)?.singleton) {
    return;
  }
  if (seen.has(stmt.type)) {
    diags.push(warning(`multiple "${stmt.type}" blocks found — only the first is used`, stmt.typeSpan, `duplicate-${stmt.type}`));
  }
  seen.add(stmt.type);
}

/**
 * Validate a (already parsed) list of top-level statements. `include`
 * statements are ignored here — the resolver expands them into their own
 * top-level statement lists before this runs on the merged tree.
 */
export function validateStatements(statements: Statement[]): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const seenNames = new Map<string, ObjectNode>();
  const seenSingletons = new Set<string>();

  for (const stmt of statements) {
    if (isIncludeNode(stmt)) {
      continue;
    }
    if (isPropertyNode(stmt)) {
      diags.push(error(`a bare property is not allowed at the top level (found "${stmt.key}:")`, stmt.span, "property-not-allowed-here"));
      continue;
    }
    duplicateSingleton(stmt, seenSingletons, diags);
    if (stmt.name && nodeSpec(stmt.type)?.nameMode === "required-free") {
      const prior = seenNames.get(stmt.name);
      if (prior) {
        diags.push(error(`duplicate name "${stmt.name}" — already used by a ${prior.type} in this scope`, stmt.nameSpan!, "duplicate-name"));
      } else {
        seenNames.set(stmt.name, stmt);
      }
    }
    validateNode(stmt, true, diags);
  }

  return diags;
}
