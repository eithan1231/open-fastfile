"""Composing a map's `world.world`: its own lighting, grading and spawn, plus per-map overrides."""

import collections
import math
import os
import re
import sys

from . import gameobjects, gameplay
from .entities import named_keys, parse_ents
from .files import read_json, read_text, write_text
from .fx import ref as fx_ref
from .gltf import glb_bounds
from .nav.vocab import HEADER_FLAGS
from .props import engine_euler, num  # num: fixed-point, the DSL tokenizer has no exponent rule
from .sound import ref as sound_ref
from .units import UNITS_PER_M

# worldspawn keys, as every spelling a game uses: IW5 stores script-string
# indices ("1991"), IW4 and T5 the names, and T5 names the ambient keys differently.
# A miss is silent (the house default is used), so all spellings are tried.
WS_AMBIENT = "ambient"
WS_SUNLIGHT = "sunlight"
WS_SUNCOLOR = "suncolor"
WS_SUNDIR = "sundirection"
WS_AMBIENT_COLOR = "ambient color"

WS_KEYS = {
    WS_AMBIENT: ("ambient", "ambientintensity", "1987"),
    WS_SUNLIGHT: ("sunlight", "1989"),
    WS_SUNCOLOR: ("suncolor", "1990"),
    WS_SUNDIR: ("sundirection", "1991"),
    WS_AMBIENT_COLOR: ("_color", "_ambientcolor", "2811"),
}

# IW6 numbers its script strings differently, and a bare number means nothing
# outside its own game's table, so its keys replace the list rather than join
# it. Each holds the same shape of value in all 21 Ghosts MP zones, and what
# each means was settled against the map's own lightmap
# (docs/cod/games.md#ghosts-iw6). No ambient key is established, so a Ghosts
# world takes the house ambient below.
WS_KEYS_IW6 = {
    WS_SUNLIGHT: ("759", "32081"),
    WS_SUNCOLOR: ("760", "32066"),
    WS_SUNDIR: ("761", "32069"),
}
# S1 numbers its own again. `58` is `.116`, IW's own default ambient, on 8 of the
# 14 zones; `1047`-`1049` are consecutive, as Ghosts' three are, and the map's
# `.sun` aims its sun sprite within 30 degrees of `1048` on all twelve that have
# both. No ambient colour is established, so an AW world takes the house ambient
# (reverse/s1-zone/README.md#the-entity-keys).
WS_KEYS_S1 = {
    WS_AMBIENT: ("58",),
    WS_SUNLIGHT: ("1049",),
    WS_SUNCOLOR: ("1047",),
    WS_SUNDIR: ("1048",),
}
WS_KEYS_BY_GAME = {"iw6": WS_KEYS_IW6, "s1": WS_KEYS_S1}

# (sun, ambient) divisors bringing each game's worldspawn light values onto IW's
# scale, from the median across each game's zones. T5 writes ~12x brighter suns;
# Ghosts' median `sunlight` is 4 over its 21 MP zones against IW's 1.2, and it
# spans 0.2 (a night map) to 10. Its ambient scale never multiplies anything:
# no Ghosts ambient key is established.
LIGHT_SCALE_BY_GAME = {
    "iw4": (1.0, 1.0),
    "iw5": (1.0, 1.0),
    "t5": (1.0 / 12.0, 1.0 / 4.0),
    # Black Ops II's worldspawn holds no sun or ambient key at all (mp_la's has
    # lighting-quality and fog settings only). Its sun is GfxWorld's, and comes
    # in with the lightmap already in the engine's units (the Atlas's `sun`).
    "t6": (1.0, 1.0),
    "iw6": (1.0 / 3.0, 1.0),
    # Advanced Warfare writes IW's numbers: its `sunlight` is 0.99 to 1.7 over
    # the fourteen MP zones against IW's 1 to 1.6, so neither value is rescaled.
    "s1": (1.0, 1.0),
    # Cold War's entity lists hold no worldspawn, so nothing is read to scale.
    "t9": (1.0, 1.0),
}

# How far above a spawn entity's origin the player's eye goes, metres.
#
# A `spawn` node's `at` is an **eye** position (worlds/AUTHORING.md), and a CoD
# spawn entity's origin is on the floor, so every spawn written from one has to be
# lifted. Comfortably over the engine's EYE_HEIGHT (60 units, 1.524 m) on purpose:
# a player settles the last few centimetres onto the floor rather than starting
# inside it.
#
# Named here because it was a literal in two places and only one of them had it.
# The world's own `spawn` was lifted and the per-mode `spawn` points were not, so
# a server placing a player at one of the latter put them an eye height
# underground — and nothing noticed for as long as the server adopted whatever
# the client claimed.
PLAYER_EYE = 1.8

# Spawn preference: a team start beats a plain spawn.
SPAWN_CLASSES = (
    "mp_tdm_spawn_allies_start",
    "mp_tdm_spawn_allies",
    "mp_dm_spawn",
    "mp_tdm_spawn",
    "info_player_start",
    "mp_sab_spawn_allies_start",
    "mp_spawn_point",  # Cold War: one class for every mode, told apart by keys
)


def bake(atlas):
    """The baked-lighting properties of a `model` node, for the atlas stage 3 wrote.

    The shell and the decal pass take the same ones, so a decal is always lit
    exactly like the wall under it. What the intensity means per game is
    `scripts/cod/lightmap.py`.
    """
    return {} if atlas is None else {"lightmap": f'"assets/{atlas.file}"', "lightmap-intensity": atlas.intensity}


# The game a dump came from, keyed by the `_game` field OAT writes into every manifest.
GAMES = {
    "iw4": ("MW2", "Modern Warfare 2"),
    "iw5": ("MW3", "Modern Warfare 3"),
    "t5": ("BO", "Black Ops"),
    "t6": ("BO2", "Black Ops II"),
    "iw6": ("Ghosts", "Ghosts"),
    "s1": ("AW", "Advanced Warfare"),
    "t9": ("CW", "Black Ops Cold War"),
}

# The `world { game: }` values the DSL accepts (packages/shared/src/dsl/schema.ts).
# A game outside it has no catalogue yet, and a world declaring no game draws its
# peers as capsules -- which is what one with no catalogue does anyway -- so its
# world file leaves the line out until the catalogue lands, and
# `ensure_world_game` adds it then. test_worldfile_games.py pins this to the schema.
DSL_GAMES = ("iw4", "iw5", "iw6", "t5", "t6", "s1")

# Black Ops zombie zones share no prefix (zombie_theater, zombietron, nacht_der_untoten);
# Black Ops II's all start `zm_` (zm_transit).
ZOMBIE_ZONES = ("zombie_", "zombietron", "nacht_", "zm_")

OVERRIDES_FILE = "_overrides.json"
OVERRIDE_SECTIONS = {
    "world": ("sky", "visibility", "exposure"),
    "grade": ("light-tint", "medium-tint", "dark-tint", "desaturation", "desaturation-dark", "gamma"),
    "shell": ("collide", "lightmap", "lightmap-intensity"),
    "decals": ("collide", "decal", "lightmap", "lightmap-intensity"),
    "sun": ("type", "at", "intensity", "color", "shadows"),
    "fill": ("type", "intensity", "color"),
    "spawn": ("at", "look"),
    # Not DSL properties: the weapon file and view-hands model the viewmodel stage exports.
    "viewmodel": ("weapon", "hands"),
    # Nor these: the `mp_body_*` models the characters stage dresses, and the
    # `head_*` beside each (same length, or absent to infer them by name).
    "characters": ("bodies", "heads"),
}
OVERRIDE_APPEND = "append"


def game_of(manifest):
    """(short, long) name for the dump's `_game`. An unknown game is fatal, never defaulted."""
    key = manifest["_game"]
    if key not in GAMES:
        sys.exit(
            f"manifest says _game={key!r}, which scripts/cod/worldfile.py has no name for (known: {', '.join(sorted(GAMES))})."
        )
    return GAMES[key]


def world_category(map_name, short):
    """Which picker group a map belongs to."""
    if map_name.startswith("mp_"):
        return f"{short} Multiplayer"
    if map_name.startswith("so_"):
        return f"{short} Special Ops"
    if map_name.startswith(ZOMBIE_ZONES):
        return f"{short} Zombies"
    return f"{short} Campaign"


def ws_get(ws, game_key, meaning):
    """A worldspawn value by any of its game's spellings, or None where that game has no key for it."""
    for spelling in WS_KEYS_BY_GAME.get(game_key, WS_KEYS).get(meaning, ()):
        if spelling in ws:
            return ws[spelling]
    return None


def _floats(value, n):
    try:
        parts = [float(v) for v in (value or "").split()]
    except ValueError:
        return None
    return parts if len(parts) == n else None


def _hex(rgb):
    """A worldspawn colour as #rrggbb. Maps write 0..1 or 0..255; any component above 1 means 0..255."""
    scale = 1.0 if any(c > 1.0 for c in rgb) else 255.0
    return "#" + "".join(f"{min(255, max(0, round(c * scale))):02x}" for c in rgb)


def _linear_hex(rgb):
    """A linear 0..1 colour as #rrggbb, sRGB-encoded: three reads a hex colour as sRGB."""

    def encode(c):
        c = min(1.0, max(0.0, c))
        return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

    return "#" + "".join(f"{round(encode(c) * 255):02x}" for c in rgb)


def dsl_value(v):
    """A JSON value as DSL source: strings verbatim (colours, vectors), booleans lower-cased."""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


class Overrides:
    """Per-map hand tuning in `_overrides.json`, re-applied on every export.

    Everything else in a generated world is derived from the zone and would be
    overwritten by the next export. Unknown sections or properties are errors,
    not silently ignored lines. `append` lines are copied verbatim (`pnpm check`
    validates them). Each override leaves a comment with the value it replaced.
    """

    def __init__(self, out_dir):
        self.path = os.path.join(out_dir, OVERRIDES_FILE)
        self.data = {}
        self.applied = []
        if not os.path.exists(self.path):
            return
        try:
            self.data = read_json(self.path)
        except ValueError as e:
            sys.exit(f"{self.path}: {e}")
        self.validate()

    def validate(self):
        if not isinstance(self.data, dict):
            sys.exit(f"{self.path}: expected an object of sections")
        known = set(OVERRIDE_SECTIONS) | {OVERRIDE_APPEND}
        for section, body in self.data.items():
            if section not in known:
                sys.exit(f"{self.path}: unknown section {section!r} (known: {', '.join(sorted(known))})")
            if section == OVERRIDE_APPEND:
                if not isinstance(body, list) or not all(isinstance(x, str) for x in body):
                    sys.exit(f"{self.path}: {OVERRIDE_APPEND} must be a list of DSL lines")
                continue
            unknown = set(body) - set(OVERRIDE_SECTIONS[section])
            if unknown:
                sys.exit(
                    f"{self.path}: {section} has no property "
                    f"{', '.join(repr(u) for u in sorted(unknown))} to override "
                    f"(known: {', '.join(OVERRIDE_SECTIONS[section])})"
                )

    def has(self, section):
        return bool(self.data.get(section))

    def _merged(self, section, generated):
        over = self.data.get(section) or {}
        out, notes = dict(generated), []
        for key, value in over.items():
            was = generated.get(key)
            self.applied.append(f"{section}.{key}")
            notes.append(f"{section}.{key} was {was}" if key in generated else f"{section}.{key} added")
            out[key] = dsl_value(value)
        return out, notes

    def render(self, section, generated, indent="  "):
        """A block node's properties, one per line, overrides applied."""
        props, notes = self._merged(section, generated)
        lines = [f"{indent}// {OVERRIDES_FILE}: {n}" for n in notes]
        return lines + [f"{indent}{k}: {v}" for k, v in props.items()]

    def inline(self, section, generated, indent=""):
        """(override-note comment lines, the `k: v, k: v` body of a one-line node)."""
        props, notes = self._merged(section, generated)
        return ([f"{indent}// {OVERRIDES_FILE}: {n}" for n in notes], ", ".join(f"{k}: {v}" for k, v in props.items()))

    def appended(self):
        extra = self.data.get(OVERRIDE_APPEND) or []
        if not extra:
            return []
        self.applied.append(f"{OVERRIDE_APPEND}[{len(extra)}]")
        return ["", f"// Added by {OVERRIDES_FILE}; not from the zone.", *extra]


def parse_vision(path):
    """A map's `.vision` film grading as `grade` properties, or {} when it has none.

    The r_film* cvars are already `grade`'s shape: three tints on a 0..2 scale
    (1 = neutral) and two desaturations.
    """
    if not path or not os.path.exists(path):
        return {}
    cvars = dict(re.findall(r'(\S+)\s+"([^"]*)"', read_text(path)))
    if cvars.get("r_filmEnable", "0") != "1":
        return {}
    tints = {
        k: _floats(cvars.get(f"r_film{n}Tint"), 3)
        for k, n in (("light-tint", "Light"), ("medium-tint", "Medium"), ("dark-tint", "Dark"))
    }
    if not all(tints.values()):
        return {}
    props = {k: " ".join(str(v) for v in tints[k]) for k in ("light-tint", "medium-tint", "dark-tint")}
    props["desaturation"] = (_floats(cvars.get("r_filmDesaturation"), 1) or [0.0])[0]
    props["desaturation-dark"] = (_floats(cvars.get("r_filmDesaturationDark"), 1) or [0.0])[0]
    return props


def render_grade(props, vision_path, overrides):
    """The `grade` block, or [] when neither the zone nor an override defines one."""
    if not props and not overrides.has("grade"):
        return []
    source = (
        f"from its `{os.path.basename(vision_path)}`"
        if props
        else f"defined entirely in {OVERRIDES_FILE}; the zone ships no vision file"
    )
    return [
        "",
        f"// The map's own colour grading (r_film* cvars), {source}.",
        "grade {",
        *overrides.render("grade", props),
        "}",
    ]


def minimap_node(frame):
    """The `minimap` node's properties for `export_metadata.json`'s `image_corners`, or None without them.

    `at` is the image's centre and `size` its width and depth, from the engine
    x z of its corners; `rotate` turns north (0, -1) onto its up, as the DSL's
    rotateY does. No `range`: the map's compassmaxrange would zoom each map
    differently (35 m to 100 m), so every map takes the engine's default.
    """
    if not frame:
        return None
    tl, tr, bl = (frame[k]["xz"] for k in ("top_left", "top_right", "bottom_left"))
    right = (tr[0] - tl[0], tr[1] - tl[1])
    up = (tl[0] - bl[0], tl[1] - bl[1])
    width, depth = math.hypot(*right), math.hypot(*up)
    yaw = math.atan2(-up[0], -up[1])  # rotateY(north, yaw) = (-sin, -cos)
    # rotateY(east, yaw) = (cos, -sin) must be the image's right; otherwise the frame is mirrored.
    if (right[0] * math.cos(yaw) - right[1] * math.sin(yaw)) < 0.99 * width:
        raise ValueError(f"minimap frame is mirrored or skewed: right {right}, up {up}")
    return {
        "source": '"assets/minimap.png"',
        "at": f"{(tr[0] + bl[0]) / 2:.3f} {(tr[1] + bl[1]) / 2:.3f}",
        "size": f"{width:.3f} {depth:.3f}",
        "rotate": f"{round(math.degrees(yaw), 2) + 0.0:g}",
    }


def write_minimap_world(out_dir, map_name, minimap):
    """`minimap.world`, which world.world includes, from `export_metadata.json`'s `minimap` (None: no image).

    Returns its path, or None, having removed a stale one, when there is no image or frame.
    """
    path = os.path.join(out_dir, "minimap.world")
    props = minimap_node(minimap["image_corners"]) if minimap else None
    if not props:
        if os.path.exists(path):
            os.remove(path)
        return None
    lines = [
        f"// {map_name}'s HUD map: the game's own compass image, where the game draws it",
        "// (docs/cod/reference.md#minimap).",
        "// GENERATED by `python3 -m scripts.cod export`.",
        "",
        "minimap {",
        *(f"  {k}: {v}" for k, v in props.items()),
        "}",
        "",
    ]
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    return path


def write_mantle_world(out_dir, map_name, volumes):
    """`mantle.world`, which world.world includes: where the map lets a player climb.

    Its own file rather than part of `gameplay.world`, for a reason worth knowing:
    `--gameplay-only` rewrites that file from the committed
    `export_metadata.json`, and a mantle volume is not in there — it comes from
    the clipmap. Folded in, every gameplay-only run would silently delete every
    mantle in the map.

    Returns its path, or None (having removed a stale file) when the map has no
    mantle volumes at all — which is true of 8 of the 34 Black Ops zones.
    """
    path = os.path.join(out_dir, "mantle.world")
    if not volumes:
        if os.path.exists(path):
            os.remove(path)
        return None

    named = sum(1 for v in volumes if v["kind"])
    lines = [
        f"// Where {map_name} lets a player climb: the map's own mantle volumes,",
        "// from the brushes its clipmap marks `0x01000000` (scripts/cod/mantle.py).",
        "// GENERATED by `python3 -m scripts.cod export`: do not edit by hand.",
        "//",
        "// A volume encloses what a player climbs, and its top is the surface they",
        f"// end on. {len(volumes)} volume(s), {named} naming a kind.",
        "",
    ]
    for i, v in enumerate(volumes):
        at, size = v["at"], v["size"]
        props = [f"at: {at[0]} {at[1]} {at[2]}", f"size: {size[0]} {size[1]} {size[2]}"]
        # A yaw of zero is the default, so say nothing rather than say nothing twice.
        if v["yaw"]:
            props.append(f"rotate: {v['yaw']}")
        # `kind`, not `type`: PROPERTY_KINDS is keyed by property name across
        # every node and `type` is already a light's enum (dsl/schema.ts).
        if v["kind"]:
            props.append(f"kind: {v['kind']}")
        lines.append(f"mantle m{i} {{ " + ", ".join(props) + " }")
    lines.append("")

    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    return path


def write_ladder_world(out_dir, map_name, ladders):
    """`ladder.world`, which world.world includes: where the map lets a player climb a ladder.

    Its own file for the reason `mantle.world` is: it comes from the clipmap,
    which `--gameplay-only` never reads. Returns its path, or None (having
    removed a stale file) when the map has no ladders, as 18 of 41 Modern
    Warfare zones do.
    """
    path = os.path.join(out_dir, "ladder.world")
    if not ladders:
        if os.path.exists(path):
            os.remove(path)
        return None

    faced = sum(1 for v in ladders if v["face"])
    lines = [
        f"// Where {map_name} lets a player climb a ladder: the map's own ladder brushes,",
        "// whose faces its clipmap flags `ladder` (surfaceFlags 0x8; scripts/cod/ladder.py).",
        "// GENERATED by `python3 -m scripts.cod export`: do not edit by hand.",
        "//",
        "// Each box is also a wall, in collision.glb. It is climbed from any side, or",
        "// only from the side `face` names when the map flags just that one.",
        f"// {len(ladders)} ladder(s), {faced} naming a face.",
        "",
    ]
    for i, v in enumerate(ladders):
        at, size = v["at"], v["size"]
        props = [f"at: {at[0]} {at[1]} {at[2]}", f"size: {size[0]} {size[1]} {size[2]}"]
        # The same convention and default as a mantle's (write_mantle_world).
        if v["yaw"]:
            props.append(f"rotate: {v['yaw']}")
        if v["face"]:
            props.append(f"face: {v['face']}")
        lines.append(f"ladder l{i} {{ " + ", ".join(props) + " }")
    lines.append("")

    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    return path


# The file `navigation.world` names, and where `export` writes it: in the world's
# gitignored `assets/`, beside collision.glb, since it is the game's data too.
NAV_FILE = "assets/nav.bin"


def write_nav_world(out_dir, map_name, nav):
    """`navigation.world`, which world.world includes: the map's path-node graph, as one `nav.bin`.

    Its own file for the reason `mantle.world` is, and one line long: what is in
    the graph is the binary's business (docs/engine/nav-format.md), and the
    header comment only says so for a reader. `nav` is the `NavData` written to
    NAV_FILE, or None when the map has no graph -- then a stale file is removed
    and None returned.
    """
    path = os.path.join(out_dir, "navigation.world")
    if nav is None:
        if os.path.exists(path):
            os.remove(path)
        return None
    meta = nav.meta or {}
    lines = [
        f"// {map_name}'s path nodes, for bots: {len(nav.nodes)} node(s) and {len(nav.traversals)} traversal(s),",
        f"// from the map's {'entity lump' if meta.get('source') == 'ents' else 'path data'} (scripts/cod/nav/).",
        "// GENERATED by `python3 -m scripts.cod export`: do not edit by hand.",
    ]
    if nav.flags & HEADER_FLAGS["DERIVE_WALK_LINKS"]:
        lines.append("// Walk links are derived when the world loads, against its collision.")
    lines += ["", f'navigation {{ source: "{NAV_FILE}" }}', ""]
    write_text(path, "\n".join(lines))
    return path


RADIUS_TRIGGERS = gameplay.RADIUS_TRIGGERS


def _spawn_lines(spawns):
    """One `spawn` node per spawn entity, qualified by mode, side and round-start."""
    lines = []
    for s in spawns:
        # Lifted to the eye, as the world's own `spawn` is: a spawn entity's origin
        # is on the floor and a `spawn` node's `at` is an eye position.
        at = [s["at"][0], round(s["at"][1] + PLAYER_EYE, 3), s["at"][2]]
        face = s.get("facing") or [0.0, 0.0, -1.0]
        look = [round(at[i] + face[i], 3) for i in range(3)]
        props = [f'mode: "{s["mode"]}"']
        if s.get("team"):
            props.append(f'team: "{s["team"]}"')
        if s.get("start"):
            props.append("start: on")
        props.append(f"at: {at[0]} {at[1]} {at[2]}")
        props.append(f"look: {look[0]} {look[1]} {look[2]}")
        lines.append("spawn { " + ", ".join(props) + " }")
    return lines


def _in_every_mode(entity):
    return None


def _linkage(tags, target=None, modes=None, use=None):
    """The properties every gameplay node spells the same way: `tag`, `target`, `mode`, `use`."""
    props = []
    if tags:
        props.append(f"tag: {gameplay.strings(tags)}")
    if target:
        props.append(f"target: {gameplay.quote(target)}")
    if modes:
        props.append(gameobjects.mode_clause(modes))
    if use:
        props.append(f"use: {use}")
    return props


def _trigger_lines(entities, modes_of=_in_every_mode, targets=None):
    """`trigger` nodes for the entities whose volume the entity itself describes.

    Returns (lines, volumes, skipped): a brush-volume trigger (`*N`) is counted
    in `volumes`, since volumes.world writes it from the clipmap, and any other
    trigger (IW's `?N`) in `skipped`, since nothing reads its volume.
    `modes_of(entity)` lists the game modes a trigger exists in, or is None.
    `targets` (gameplay.Targets) resolves each one's `target`.
    """
    lines, volumes, skipped = [], 0, 0
    for e in entities:
        cls = e.get("classname", "")
        if not gameplay.is_volume_class(cls):
            continue
        if gameplay.is_brush_volume(e):
            volumes += 1
            continue
        if not gameplay.is_radius_trigger(e):
            skipped += cls.startswith("trigger")
            continue
        at = e["at"]
        props = [f"at: {at[0]} {at[1]} {at[2]}", f"radius: {round(float(e['radius']) / UNITS_PER_M, 3)}"]
        if e.get("height"):
            props.append(f"height: {round(float(e['height']) / UNITS_PER_M, 3)}")
        props += _linkage(gameplay.tags_of(e), targets.of(e) if targets else None, modes_of(e))
        # The entity id, so two triggers sharing a targetname stay distinguishable.
        lines.append(f"trigger t{e['id']} {{ " + ", ".join(props) + " }")
    return lines, volumes, skipped


def _point_lines(entities, modes_of, targets):
    """One `point` per AI spawner and per named struct or origin (gameplay.is_point), at its origin."""
    lines = []
    for e in entities:
        if not gameplay.is_point(e):
            continue
        at, look = e["at"], gameplay.look_at(e)
        props = [f"at: {at[0]} {at[1]} {at[2]}", f"look: {look[0]} {look[1]} {look[2]}"]
        props += _linkage(gameplay.tags_of(e), targets.of(e), modes_of(e))
        lines.append(f"point p{e['id']} {{ " + ", ".join(props) + " }")
    return lines


def _solid_lines(entities, modes_of):
    """One `solid` per part collision.py splits out (brushmodels.part_of), tagged so a script can find it.

    A part is a solid brush model only some game modes have, or a DYNAMICPATH
    one; with no `mode` it is in every mode and a script may still remove it.
    """
    return [
        f'solid {{ part: "{ref}"' + "".join(f", {p}" for p in _linkage(gameplay.tags_of(e), modes=modes_of(e))) + " }"
        for ref, e in gameplay.parts(entities, modes_of).items()
    ]


#: What write_gameplay_world wrote. `volumes` counts the brush-volume triggers it
#: left to volumes.world, `skipped` the triggers nothing exports, and `dropped`
#: is gameplay.Targets.report's line.
Gameplay = collections.namedtuple("Gameplay", "path spawns triggers volumes skipped solids points dropped")


def write_gameplay_world(out_dir, map_name, data, facts=None):
    """`gameplay.world`, which world.world includes: the map's spawns, radius triggers, points and solids.

    This is the map's own entity lump expressed in the DSL. It is written here
    rather than read from `export_metadata.json` at run time on purpose: the
    world file is the one description of a world the engine reads, which is what
    keeps `pnpm check` the whole truth about one. `facts` (gameobjects.MapFacts)
    is the export's own, so a name it has reported is not reported again.

    Returns a `Gameplay`, whose `path` is None when the map has none of them —
    having removed a stale file.
    """
    path = os.path.join(out_dir, "gameplay.world")
    entities = data.get("entities", [])
    modes_of = gameplay.modes_function(data.get("game"), data.get("map", map_name), entities, facts)
    targets = gameplay.Targets(entities, modes_of)

    spawns = _spawn_lines(data.get("spawns", []))
    triggers, volumes, skipped = _trigger_lines(entities, modes_of, targets)
    points = _point_lines(entities, modes_of, targets)
    solids = _solid_lines(entities, modes_of)
    dropped = targets.report()

    if not spawns and not triggers and not solids and not points:
        if os.path.exists(path):
            os.remove(path)
        return Gameplay(None, 0, 0, volumes, skipped, 0, 0, dropped)

    lines = [
        f"// {map_name}'s spawn points, triggers, points and removable solids, from the map's own entity lump.",
        "// GENERATED by `python3 -m scripts.cod export`: do not edit by hand.",
        "//",
        f"// {len(spawns)} spawn(s) over {len({s['mode'] for s in data.get('spawns', [])})} game mode(s).",
    ]
    if volumes:
        lines.append(f"// {volumes} brush-volume trigger(s) are in volumes.world, from the clipmap.")
    if skipped:
        lines.append(f"// {skipped} trigger(s) not exported: their volumes are in the entity lump's trigger table.")
    if dropped:
        lines.append(f"// {dropped}.")
    lines.append("")

    if spawns:
        lines += [
            "// Where each mode and side starts. The engine widens the match when a",
            "// mode asks for a combination this map never anticipated.",
            *spawns,
            "",
        ]
    if triggers:
        lines += ["// Volumes something can be inside. What that means is the game's, not this file's.", *triggers, ""]
    if points:
        lines += ["// Positions a script finds by tag: AI spawners, and named structs and origins.", *points, ""]
    if solids:
        lines += [
            "// Brush models in assets/collision.glb and assets/world.glb that can be absent:",
            "// outside the modes named, or once a script removes them. The rest is always there.",
            *solids,
            "",
        ]

    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    return Gameplay(path, len(spawns), len(triggers), volumes, skipped, len(solids), len(points), dropped)


def write_volumes_world(out_dir, map_name, triggers):
    """`volumes.world`, which world.world includes: the brush-volume triggers and zones, from the clipmap.

    Its own file for the reason `mantle.world` is: `--gameplay-only` rewrites
    `gameplay.world` from `export_metadata.json`, which does not hold a brush's
    planes. `triggers` is triggers.read_triggers'. Returns its path, or None
    (having removed a stale file) when there are none.
    """
    path = os.path.join(out_dir, "volumes.world")
    if not triggers:
        if os.path.exists(path):
            os.remove(path)
        return None
    entities = len({t["name"].split("_", 1)[0] for t in triggers})
    lines = [
        f"// {map_name}'s trigger volumes and zones: each brush of every `info_volume` and",
        "// `trigger_*` brush model, as a box (scripts/cod/triggers.py).",
        "// GENERATED by `python3 -m scripts.cod export`: do not edit by hand.",
        "//",
        "// An area is every trigger sharing a tag. What being in one or using one means",
        f"// is the game's. {len(triggers)} box(es) of {entities} entit{'y' if entities == 1 else 'ies'}.",
        "",
    ]
    for cls in sorted({t["cls"] for t in triggers}):
        lines.append(f"// {cls}")
        for t in (t for t in triggers if t["cls"] == cls):
            at, size = t["at"], t["size"]
            props = [f"at: {at[0]} {at[1]} {at[2]}", f"size: {size[0]} {size[1]} {size[2]}"]
            # A yaw of zero is the default, as a mantle's (write_mantle_world).
            if t["yaw"]:
                props.append(f"rotate: {t['yaw']}")
            props += _linkage(t["tags"], t["target"], t["modes"], t["use"])
            lines.append(f"trigger {t['name']} {{ " + ", ".join(props) + " }")
        lines.append("")
    write_text(path, "\n".join(lines))
    return path


def _effect_lines(placements, effects, available):
    """One `effect` node per createfx placement whose definition was exported.

    Returns (lines, skipped, unknown). A placement naming an effect that is not in
    `available` is skipped and counted rather than emitted: the world file must not
    name an effect `effects.json` does not hold, which nothing would report at run
    time beyond the effect quietly never playing.
    """
    lines, skipped, unknown, taken = [], 0, set(), {}
    for p in placements:
        if p.get("create") != "createOneshotEffect" or "at" not in p:
            skipped += 1
            continue
        path = effects.get(p.get("fxid"))
        path = fx_ref(path) if path else None
        if not path or path not in available:
            unknown.add(p.get("fxid"))
            continue
        at = p["at"]
        # createfx angles are Quake (pitch, yaw, roll) degrees. `rotate:` takes
        # engine XYZ Euler, so they go through the same conversion props use --
        # written raw, every effect was aimed in the wrong convention, and dome's
        # sandstorm stood up as a wall instead of lying across the ground.
        angles = p.get("angles") or [0.0, 0.0, 0.0]
        # A createfx id is free text ("fire/fire_barrel_trash", "Dripping blood"),
        # and a node name is a DSL identifier.
        base = re.sub(r"\W", "_", p["fxid"])
        if not re.match(r"[A-Za-z_]", base):
            base = "_" + base
        taken[base] = taken.get(base, -1) + 1
        props = [
            f'fx: "{path}"',
            f"at: {num(at[0], 3)} {num(at[1], 3)} {num(at[2], 3)}",
        ]
        if any(angles):
            ex, ey, ez = engine_euler(*angles[:3])
            props.append(f"rotate: {num(ex, 3)} {num(ey, 3)} {num(ez, 3)}")
        if p.get("delay"):
            props.append(f"delay: {num(float(p['delay']), 3)}")
        lines.append(f"effect {base}_{taken[base]} {{ " + ", ".join(props) + " }")
    return lines, skipped, unknown


def write_fx_world(out_dir, map_name, data, available, counts=None):
    """`fx.world`, which world.world includes: where the map plays its effects.

    The placements come from the map's own createfx script, already parsed into
    `export_metadata.json`. They are re-expressed here for the same reason spawns
    are: the world file is the one description of a world the engine reads, and
    nothing in `packages/` may read the metadata dump.

    Returns (path, effects, placements, skipped, unknown), or (None, 0, 0, 0, set())
    when the map places none -- having removed a stale file.
    """
    path = os.path.join(out_dir, "fx.world")
    fx_data = data.get("fx") or {}
    lines, skipped, unknown = _effect_lines(fx_data.get("placements", []), fx_data.get("effects", {}), available)

    if not lines:
        if os.path.exists(path):
            os.remove(path)
        return None, 0, 0, skipped, unknown

    out = [
        f"// {map_name}'s world effects, from the map's own createfx script.",
        "// GENERATED by `python3 -m scripts.cod export`: do not edit by hand.",
        "//",
        f"// {len(lines)} placement(s) of {len(available)} exported effect(s).",
    ]
    if unknown:
        out.append(f"// {len(unknown)} effect(s) placed but not exported (defined in a zone that was not dumped).")
    if counts:
        drawn = ", ".join(f"{n} {t.lower()}" for t, n in sorted(counts.items()))
        out.append(f"// Elements: {drawn}.")
    out += [
        "",
        'fx { source: "assets/fx/effects.json" }',
        "",
        "// Where each effect plays. The definition says what it looks like; this says where.",
        *lines,
        "",
    ]

    write_text(path, "\n".join(out))
    return path, len(available), len(lines), skipped, unknown


def _sound_lines(placements, available):
    """One `sound` node per createLoopSound placement whose alias was exported.

    Returns (lines, unknown alias names). A placement naming an alias
    `sounds.json` does not hold is dropped and named rather than emitted, for the
    reason an effect's is: nothing at run time would report it beyond the
    emitter quietly never playing.
    """
    lines, unknown, taken = [], set(), {}
    for p in placements:
        if p.get("create") != "createLoopSound" or "at" not in p:
            continue
        # The map's own spelling is not the table's: dome places
        # `emt_wind_grass_Ext` against a zone that defines `..._ext`.
        alias = sound_ref(p.get("soundalias") or "")
        if not alias or alias not in available:
            unknown.add(p.get("soundalias"))
            continue
        at = p["at"]
        taken[alias] = taken.get(alias, -1) + 1
        # No `rotate:`: a sound has no facing. No `delay:` either -- staggering
        # identical loops is the engine's to do from a per-placement seed, and a
        # delay baked here would be the same offset on every reload.
        lines.append(f"sound {alias}_{taken[alias]} {{ alias: {alias}, at: {num(at[0], 3)} {num(at[1], 3)} {num(at[2], 3)} }}")
    return lines, unknown


def write_sound_world(out_dir, map_name, data, available):
    """`sound.world`, which world.world includes: where the map plays its ambience.

    The placements are the `createLoopSound` half of the same createfx script the
    effects come from, already parsed into `export_metadata.json`. `fx.world`'s
    sibling in every respect, for the same reason: the world file is the one
    description of a world the engine reads, and nothing in `packages/` may read
    the metadata dump.

    Returns (path, aliases, placements, unknown), or (None, 0, 0, set()) when the
    map places none -- having removed a stale file.
    """
    path = os.path.join(out_dir, "sound.world")
    fx_data = data.get("fx") or {}
    lines, unknown = _sound_lines(fx_data.get("placements", []), available)

    if not lines:
        if os.path.exists(path):
            os.remove(path)
        return None, 0, 0, unknown

    out = [
        f"// {map_name}'s ambience, from the map's own createfx script.",
        "// GENERATED by `python3 -m scripts.cod export`: do not edit by hand.",
        "//",
        f"// {len(lines)} placement(s) of {len(available)} exported alias(es).",
    ]
    if unknown:
        out.append(f"// {len(unknown)} alias(es) placed but not exported (defined in a zone that was not dumped).")
    out += [
        "",
        'sounds { source: "assets/sounds/sounds.json" }',
        "",
        "// Where each alias plays. The alias says what it sounds like; this says where.",
        *lines,
        "",
    ]

    write_text(path, "\n".join(out))
    return path, len(available), len(lines), unknown


# The `collision` node, spelled once: `write_world_file` writes it and
# `ensure_include` anchors on it.
COLLISION_LINE = 'collision { source: "assets/collision.glb" }'

# The order `write_world_file` writes the includes in, so that `ensure_include`
# puts a line where a full export would have and the two never disagree.
INCLUDE_ORDER = (
    "props.world",
    "gameplay.world",
    "volumes.world",
    "minimap.world",
    "mantle.world",
    "ladder.world",
    "navigation.world",
    "fx.world",
    "sound.world",
)


def ensure_include(out_dir, name):
    """Add `include "<name>"` to an existing world.world where a full export would put it, unless it is there.

    The include block sits directly after the `collision` node, which is the one
    line `world.world` cannot be written without -- so that is the anchor when no
    earlier include is present, as on a map whose backend dumps no models.
    """
    path = os.path.join(out_dir, "world.world")
    line = f'include "{name}"'
    text = read_text(path, "utf-8")
    if line in text:
        return False
    earlier = INCLUDE_ORDER[: INCLUDE_ORDER.index(name)]
    candidates = [f'include "{e}"\n' for e in reversed(earlier)] + [COLLISION_LINE + "\n\n"]
    anchor = next((a for a in candidates if a in text), None)
    if anchor is None:
        sys.exit(f"{path} has no `{COLLISION_LINE}` to add {line} after; run a full export")
    write_text(path, text.replace(anchor, anchor + line + "\n", 1))
    return True


def drop_include(out_dir, name):
    """Remove `include "<name>"` from an existing world.world. The inverse of `ensure_include`.

    Returns whether the file changed, so a migration can report what it touched
    rather than rewriting all 44 worlds to say nothing.
    """
    path = os.path.join(out_dir, "world.world")
    line = f'include "{name}"\n'
    text = read_text(path, "utf-8")
    if line not in text:
        return False
    write_text(path, text.replace(line, "", 1))
    return True


def ensure_world_game(out_dir, game_key):
    """Add `game: <key>` to an existing world.world's `world {` block, unless it is there.

    The sibling of `ensure_include`, and idempotent for the same reason: it puts
    the line where a full export would have, so a world touched by either route
    reads the same. After `category:`, which every generated world has.

    A bare word, not a string: `game` is an enum, and the DSL spells those the way
    it spells `kind: onto` and `type: directional`.
    """
    if game_key not in DSL_GAMES:
        return False
    path = os.path.join(out_dir, "world.world")
    text = read_text(path, "utf-8")
    if re.search(r"^\s*game:", text, re.MULTILINE):
        return False
    anchor = re.search(r"^(\s*)category: .*\n", text, re.MULTILINE)
    if not anchor:
        sys.exit(f"{path} has no `category:` in its `world {{` block to add `game:` after; run a full export")
    indent = anchor.group(1)
    write_text(path, text[: anchor.end()] + f"{indent}game: {game_key}\n" + text[anchor.end() :])
    return True


def write_world_file(
    out_dir,
    map_name,
    ents_path,
    assets_dir,
    vision_path,
    game,
    game_key,
    lightmap=None,
    props=True,
    gameplay=False,
    volumes=False,
    minimap=False,
    mantle=False,
    ladder=False,
    navigation=False,
    fx=False,
    sound=False,
):
    """Compose `world.world` from the map's worldspawn and spawn entities.

    The sun follows idTech's AngleVectors (forward = (cos p cos y, cos p sin y,
    -sin p)), converted to the engine frame and placed 120 m out.
    Returns (path, found a spawn, found a sun direction, overrides applied).
    """
    entities = parse_ents(ents_path)
    cls = next((k for e in entities for k, v in e.items() if v == "worldspawn"), "1668")
    ws = next((e for e in entities if e.get(cls) == "worldspawn"), {})
    sun_dir = _floats(ws_get(ws, game_key, WS_SUNDIR), 3)
    sun_col = _floats(ws_get(ws, game_key, WS_SUNCOLOR), 3)
    ambient_col = _floats(ws_get(ws, game_key, WS_AMBIENT_COLOR), 3)
    sun_scale, ambient_scale = LIGHT_SCALE_BY_GAME[game_key]
    sun_int = (_floats(ws_get(ws, game_key, WS_SUNLIGHT), 1) or [1.0 / sun_scale])[0] * sun_scale
    ambient = (_floats(ws_get(ws, game_key, WS_AMBIENT), 1) or [0.15 / ambient_scale])[0] * ambient_scale

    # A bake whose units are known against the game's own sun (T6) brings that sun
    # and a fill with it: their ratio to the lightmap is the game's, so neither is
    # taken from the worldspawn (scripts/cod/lightmap.py).
    baked_sun = lightmap.sun if lightmap is not None else None
    if baked_sun is not None:
        sun_dir = [baked_sun.pitch, baked_sun.yaw, 0.0]
        sun_int = baked_sun.intensity
    if lightmap is not None and lightmap.fill is not None:
        ambient = lightmap.fill.intensity

    if sun_dir:
        pitch, yaw = math.radians(sun_dir[0]), math.radians(sun_dir[1])
        cod = (math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), -math.sin(pitch))
        sun_at = [round(120 * c, 1) for c in (cod[0], cod[2], -cod[1])]
    else:
        sun_at = [30.0, 100.0, -60.0]
    sun_hex = _hex(sun_col) if sun_col else "#fff2cc"
    ambient_hex = _hex(ambient_col) if ambient_col else "#cce6ff"
    if baked_sun is not None:
        sun_hex = _linear_hex(baked_sun.color)
    if lightmap is not None and lightmap.fill is not None:
        ambient_hex = _linear_hex(lightmap.fill.color)

    spawn_at, look_at = None, None
    named = named_keys(entities, game_key)
    for wanted in SPAWN_CLASSES:
        hit = next((e for e in named if e.get("classname") == wanted), None)
        if not hit:
            continue
        # The named keys where the game has a table, and the shape of the values
        # where it has not: a map-scale triple is the origin, one within +-361 the
        # angles. Naming them first is not a nicety — Advanced Warfare's only
        # spawn entity sits inside 361 units of the origin on 3 of its 14 maps, and
        # the shape rule alone reads that map as having no spawn at all.
        origin = _floats(hit.get("origin"), 3) or next(
            (
                _floats(v, 3)
                for k, v in hit.items()
                if k != "classname" and _floats(v, 3) and max(abs(x) for x in _floats(v, 3)) > 361
            ),
            None,
        )
        if not origin:
            continue
        angles = _floats(hit.get("angles"), 3) or next(
            (_floats(v, 3) for k, v in hit.items() if _floats(v, 3) and max(abs(x) for x in _floats(v, 3)) <= 361), [0, 0, 0]
        )
        ex, ey, ez = origin[0] / UNITS_PER_M, origin[2] / UNITS_PER_M, -origin[1] / UNITS_PER_M
        yaw = math.radians(angles[1])
        spawn_at = [round(ex, 2), round(ey + PLAYER_EYE, 2), round(ez, 2)]
        look_at = [round(ex + 10 * math.cos(yaw), 2), round(ey + 1.6, 2), round(ez - 10 * math.sin(yaw), 2)]
        break

    shell = glb_bounds(os.path.join(assets_dir, "world.glb"))
    decals_path = os.path.join(assets_dir, "decals.glb")
    decals = glb_bounds(decals_path) if os.path.exists(decals_path) else None

    # `_cls` (classic re-release) and `_ss` (Face Off) are zone variants, not part of the name.
    stem = re.sub(r"_(cls|ss)$", "", map_name.replace("mp_", "").replace("so_", ""))
    pretty = stem.replace("_", " ").title()
    short, long = game
    category = world_category(map_name, short)
    overrides = Overrides(out_dir)
    lines = (
        [
            f"// {map_name} — {long}, imported from the game's own fastfile.",
            "// GENERATED by `python3 -m scripts.cod export`: hand edits belong in _overrides.json.",
            "// Lighting, grading and spawn are the map's own values. See docs/cod/README.md.",
            "",
            "world {",
            f'  name: "{pretty} ({short})"',
            f"  description: \"{long}'s {map_name}, imported from the game's own fastfile.\"",
            f'  category: "{category}"',
            # The zone key, not the friendly name: it is the same token the
            # catalogue's paths use, and what the engine reads to pick this game's
            # factions and player clips. `category` stays prose for the menu.
            f"  game: {game_key}" if game_key in DSL_GAMES else None,
            # House defaults for properties the zone has no value for.
            *overrides.render("world", {"sky": "#b9c6d4", "visibility": 600, "exposure": 0.5}),
            "}",
            "",
            *render_grade(parse_vision(vision_path), vision_path, overrides),
            "",
            'asset world { source: "assets/world.glb" }',
            'asset decals { source: "assets/decals.glb" }' if decals else None,
            "",
            "group map {",
            "  at: 0 0 0",
            "",
            "  // Collision comes from the map's clipmap (`collision` below), not this mesh.",
            "  model shell {",
            "    asset: world",
            "    at: 0 0 0",
            f"    size: {shell[0]:.0f} {shell[1]:.0f} {shell[2]:.0f}",
        ]
        + overrides.render("shell", {"collide": "false", **bake(lightmap)}, indent="    ")
        + [
            "  }",
        ]
    )
    if decals:
        lines += [
            "",
            "  // Rendered, never collided, depth-biased by `decal: on`. Lightmap values",
            "  // match the shell's so each decal is lit like the wall under it.",
            "  model decals {",
            "    asset: decals",
            "    at: 0 0 0",
            f"    size: {max(decals[0], 1):.0f} {max(decals[1], 1):.0f} {max(decals[2], 1):.0f}",
            *overrides.render("decals", {"collide": "false", "decal": "on", **bake(lightmap)}, indent="    "),
            "  }",
        ]
    lines = [line for line in lines if line is not None]
    lines += ["}", ""]
    lines += [COLLISION_LINE, ""]
    lines += [
        *(
            f'include "{name}"'
            for name, wanted in zip(
                INCLUDE_ORDER, (props, gameplay, volumes, minimap, mantle, ladder, navigation, fx, sound), strict=True
            )
            if wanted
        ),
        "",
    ]
    if baked_sun is not None:
        lines.append(
            f"// GfxWorld sun: angles {baked_sun.pitch:g} {baked_sun.yaw:g}; the lightmap, sun and fill"
            " are in the game's own units (scripts/cod/lightmap.py)."
        )
    elif sun_dir:
        lines.append(
            f'// worldspawn: sundirection "{" ".join(str(v) for v in sun_dir)}", '
            f'sunlight "{sun_int}", ambient "{ambient}"'
            + (f', _color "{" ".join(str(v) for v in ambient_col)}"' if ambient_col else "")
            + "."
        )
    sun_notes, sun_body = overrides.inline(
        "sun",
        {
            "type": "directional",
            "at": f"{sun_at[0]} {sun_at[1]} {sun_at[2]}",
            "intensity": round(sun_int, 3),
            "color": sun_hex,
            "shadows": "on",
        },
    )
    fill_notes, fill_body = overrides.inline(
        "fill",
        {
            "type": "ambient",
            "intensity": round(ambient, 3),
            "color": ambient_hex,
        },
    )
    lines += [*sun_notes, f"light sun {{ {sun_body} }}", *fill_notes, f"light fill {{ {fill_body} }}", ""]

    if not spawn_at:
        lines.append("// No spawn entity found; placed above the shell's centre.")
    spawn_notes, spawn_body = overrides.inline(
        "spawn",
        {
            "at": (f"{spawn_at[0]} {spawn_at[1]} {spawn_at[2]}" if spawn_at else "0 2 0"),
            "look": (f"{look_at[0]} {look_at[1]} {look_at[2]}" if spawn_at else "0 2 -10"),
        },
    )
    lines += [*spawn_notes, f"spawn {{ {spawn_body} }}"]
    lines += overrides.appended()

    path = os.path.join(out_dir, "world.world")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    return path, bool(spawn_at), bool(sun_dir), overrides.applied
