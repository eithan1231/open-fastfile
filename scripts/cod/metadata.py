"""A map's gameplay data as `export_metadata.json`: what the zone says beyond geometry.

Everything here is read, not chosen: the entity lump (spawns, objectives, every
entity), the minimap's placement, the map's plain-text scripts, its createfx
placements, fog, sun and vision files, and the zone's asset listing. Nothing in
the engine reads this file yet.
"""

import json
import math
import os
import re
from collections import Counter

from .entities import named_keys, parse_ents
from .files import read_text
from .units import UNITS_PER_M
from .worldfile import GAMES, world_category

METADATA_FILE = "export_metadata.json"
IMAGES = {"loadscreen": "loadscreen.jpg", "minimap": "minimap.png"}  # `images`: each picture in assets/, when there

# The zone listing's `>game,` header -> the `_game` key OAT writes into manifests.
ZONE_GAMES = {"IW4": "iw4", "IW5": "iw5", "T5": "t5", "T6": "t6", "IW6": "iw6", "S1": "s1", "T9": "t9"}

# Which modes a map ships, as the zone lists them: one asset per mode, named
# after it. IW and T5 ship a config stringtable each; Ghosts ships none of those
# and a constant-baseline rawfile each instead.
MODE_ASSETS = {
    "iw6": ("rawfile", r"constbaselines/bl_pc_{stem}_(\w+)\.bin$"),
    "s1": ("rawfile", r"constbaselines/bl_pc_{stem}_(\w+)\.bin$"),
}
MODE_ASSETS_DEFAULT = ("stringtable", r"configstrings/cs_pc_{stem}_(\w+)\.csv$")

# Spawn classnames are `mp_<mode>_spawn[_<team>][_<variant>][_start]`.
_SPAWN_CLASS = re.compile(r"^mp_([a-z]+)_spawn(?:_(.+))?$")
SPAWN_TEAMS = ("allies", "axis", "attacker", "defender")
MODE_NAMES = {
    "dm": "Free-for-all",
    "tdm": "Team Deathmatch",
    "war": "Team Deathmatch",
    "dom": "Domination",
    "sd": "Search and Destroy",
    "sab": "Sabotage",
    "ctf": "Capture the Flag",
    "dd": "Demolition",
    "dem": "Demolition",
    "koth": "Headquarters",
    "hq": "Headquarters",
    "conf": "Kill Confirmed",
    "grnd": "Drop Zone",
    "gun": "Gun Game",
    "infect": "Infected",
    "jugg": "Juggernaut",
    "tjugg": "Team Juggernaut",
    "oic": "One in the Chamber",
    "tdef": "Team Defender",
    "gtnw": "Global Thermonuclear War",
    "arena": "Arena",
    "twar": "War",
    "hlnd": "Sticks and Stones",
    "shrp": "Sharpshooter",
}

# Keys the level editor leaves on entities that the game never reads.
EDITOR_KEYS = ("_color", "modelscale")

# Targetnames the editor generates (`auto123`, `pf12_auto3`) name nothing.
_GENERATED_NAME = re.compile(r"^(auto\d+|pf\w*_auto\d+|pf\d+_\d+)$")


def zone_listing(path):
    """(game key, {asset type: [names]}) from OAT's `zone_source/<map>.zone`."""
    game, assets = None, {}
    for line in read_text(path).splitlines():
        line = line.strip()
        if line.startswith(">game,"):
            game = ZONE_GAMES.get(line.split(",", 1)[1].strip())
        elif line and not line.startswith(("//", ">")) and "," in line:
            kind, name = line.split(",", 1)
            assets.setdefault(kind, []).append(name)
    return game, assets


def floats(value, n=3):
    try:
        parts = [float(v) for v in (value or "").split()]
    except ValueError:
        return None
    return parts if len(parts) == n else None


def to_engine(p):
    """CoD (x, y, z) inches, Z up -> engine [x, y, z] metres, Y up, to the millimetre."""
    return [round(p[0] / UNITS_PER_M, 3), round(p[2] / UNITS_PER_M, 3), round(-p[1] / UNITS_PER_M, 3)]


def facing(yaw_degrees):
    """A CoD yaw as the engine-space unit vector it faces (the frame is mirrored: CoD +Y is engine -Z)."""
    y = math.radians(yaw_degrees)
    return [round(math.cos(y), 4), 0.0, round(-math.sin(y), 4)]


def spawn_kind(classname):
    """{mode, team, start, variant} for a spawn classname, or None if it is not one."""
    m = _SPAWN_CLASS.match(classname)
    if not m:
        return None
    parts = m.group(2).split("_") if m.group(2) else []
    start = bool(parts) and parts[-1] == "start"
    if start:
        parts = parts[:-1]
    team = parts.pop(0) if parts and parts[0] in SPAWN_TEAMS else None
    return {"mode": m.group(1), "team": team, "start": start, "variant": "_".join(parts) or None}


# Black Ops zombies places its players with script structs, not `mp_*_spawn`
# entities: `initial_spawn_points` (one per player, `script_int` 1-4) where a game
# starts, and a `player_respawn_point` per play zone (`script_noteworthy`), which
# `_zombiemode` uses between rounds.
ZOMBIES_MODE = "zombies"
ZOMBIE_SPAWN_STRUCTS = {"initial_spawn_points": True, "player_respawn_point": False}


def zombie_spawn_kind(entity):
    """{mode, team, start, variant} for a zombies spawn struct, or None if it is not one."""
    if entity.get("classname") != "script_struct" or entity.get("targetname") not in ZOMBIE_SPAWN_STRUCTS:
        return None
    start = ZOMBIE_SPAWN_STRUCTS[entity["targetname"]]
    return {"mode": ZOMBIES_MODE, "team": None, "start": start, "variant": None if start else entity.get("script_noteworthy")}


# Black Ops places a map's ambience as data rather than in createfx: a
# `script_struct` with a `script_sound`, run by `clientscripts/mp/_audio.csc`
# according to its `script_label`. A `looper` is a loop at a point, which is what
# IW's `createLoopSound` is; a `line_emitter` is one along a line, placed here at
# its first point. A `random` one plays a one-shot every `script_wait_min` to
# `script_wait_max` seconds, which a `sound` node cannot say yet, so it is kept in
# the entities and not placed.
T5_LOOPING_EMITTERS = ("looper", "line_emitter")


def t5_sound_emitters(entities):
    """The looping emitters of a Black Ops map, as createLoopSound placements."""
    return [
        {
            "create": "createLoopSound",
            "soundalias": e["script_sound"],
            "at": e["at"],
            "origin": e.get("origin"),
            "from": f"script_struct {e['script_label']}",
        }
        for e in entities
        if e.get("classname") == "script_struct"
        and e.get("script_sound")
        and e.get("script_label") in T5_LOOPING_EMITTERS
        and "at" in e
    ]


def minimap_frame(corner_a, corner_b, north_yaw, aspect=1.0):
    """Where the minimap image lies, as CoD (x, y) of its four corners and the image-up direction.

    A port of `maps/mp/_compass.gsc::setupMiniMap`: image up is `north`, at
    `north_yaw` degrees from CoD +X; the two `minimap_corner` entities are
    opposite corners of a north-aligned rectangle, which is then widened
    about its centre to `aspect` (scr_RequiredMapAspectratio, 1 by default).
    """
    n = (math.cos(math.radians(north_yaw)), math.sin(math.radians(north_yaw)))
    w = (-n[1], n[0])

    def dot(a, b):
        return a[0] * b[0] + a[1] * b[1]

    def add(a, b, s=1.0):
        return (a[0] + b[0] * s, a[1] + b[1] * s)

    diff = (corner_b[0] - corner_a[0], corner_b[1] - corner_a[1])
    along_n = dot(diff, n)
    rect = [tuple(corner_a[:2]), tuple(corner_b[:2]), add(corner_a, n, along_n), add(corner_b, n, -along_n)]
    nw = max(rect, key=lambda p: dot(p, n) + dot(p, w))
    se = min(rect, key=lambda p: dot(p, n) + dot(p, w))
    span = (nw[0] - se[0], nw[1] - se[1])
    north_len, west_len = dot(span, n), dot(span, w)
    if aspect > 0 and north_len > 0 and west_len > 0:
        ratio = west_len / north_len
        if ratio < aspect:
            grow = add((0, 0), w, west_len * (aspect / ratio - 1) * 0.5)
        else:
            grow = add((0, 0), n, north_len * (ratio / aspect - 1) * 0.5)
        nw, se = add(nw, grow), add(se, grow, -1)
        span = (nw[0] - se[0], nw[1] - se[1])
        north_len, west_len = dot(span, n), dot(span, w)
    return {
        "top_left": nw,
        "top_right": add(nw, w, -west_len),
        "bottom_left": add(nw, n, -north_len),
        "bottom_right": se,
        "up": n,
    }


# ---- plain-text GSC/CSC -------------------------------------------------------

_CALL = re.compile(r"\b([A-Za-z_]\w*)\s*\(([^;{}()]*(?:\([^()]*\)[^;{}()]*)*)\)\s*;")
_ASSIGN = re.compile(r"^\s*([A-Za-z_][\w.]*(?:\[\s*\"[^\"]*\"\s*\])*)\s*=\s*([^;]+);", re.M)
_EFFECT = re.compile(r'level\._effect\[\s*"([^"]+)"\s*\]\s*=\s*loadfx\(\s*"([^"]+)"\s*\)', re.I)
_NUMBER = re.compile(r"^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$", re.I)

# Calls whose arguments are named in the output. IW's setExpFog; T5's SetVolFog differs and stays positional.
CALL_ARGS = {"setexpfog": ("startDist", "halfwayDist", "red", "green", "blue", "maxOpacity", "transitionTime")}
# Kept elsewhere: loadfx as fx.effects.
SKIPPED_CALLS = ("loadfx",)


def _literal(token):
    """A GSC literal as JSON (number, string, [x, y, z]; a localized `&"NAME"` as "&NAME"), else raises."""
    t = token.strip()
    if _NUMBER.match(t):
        return float(t) if any(c in t for c in ".eE") else int(t)
    if t.startswith('&"') and t.endswith('"'):
        return "&" + t[2:-1]
    if len(t) >= 2 and t[0] == t[-1] == '"':
        return t[1:-1]
    if t in ("true", "false"):
        return t == "true"
    if t.startswith("(") and t.endswith(")"):
        return [_literal(p) for p in t[1:-1].split(",")]
    raise ValueError(t)


def _split_args(text):
    out, depth, cur = [], 0, ""
    for ch in text:
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
            continue
        depth += (ch == "(") - (ch == ")")
        cur += ch
    return out + [cur] if cur.strip() else out


def parse_script(path):
    """A plain-text script's literal settings: {dvars, calls, assignments}.

    Only calls whose arguments are all literals and assignments of a literal are
    kept, in source order. That is every map setting (setdvar, fog, minimap,
    ambience, attacking team) without interpreting the code around it.
    """
    text = re.sub(r"//[^\n]*", "", read_text(path))
    calls, dvars, assignments = [], {}, {}
    for name, args in _CALL.findall(text):
        try:
            values = [_literal(a) for a in _split_args(args)]
        except ValueError:
            continue
        if not values or name.lower() in SKIPPED_CALLS:
            continue
        if name.lower() in ("setdvar", "setdevdvar", "setsaveddvar") and len(values) >= 2:
            dvars[str(values[0])] = values[1]
            continue
        call = {"call": name, "args": values}
        if name.lower() in CALL_ARGS:
            call["named"] = dict(zip(CALL_ARGS[name.lower()], values, strict=False))  # later args stay unnamed
        calls.append(call)
    for target, value in _ASSIGN.findall(text):
        try:
            assignments[re.sub(r"\s+", "", target)] = _literal(value)
        except ValueError:
            continue
    return {"dvars": dvars, "calls": calls, "assignments": assignments}


# T5 calls the create functions through their file (`maps\mp\_utility::createOneshotEffect`).
_FX_CREATE = r"ent\s*=\s*(?:[\w\\]+::)?(create\w+)"
_FX_BLOCK = re.compile(_FX_CREATE + r"\s*\(([^)]*)\)\s*;(.*?)(?=" + _FX_CREATE + r"|\Z)", re.S)
_FX_FIELD = re.compile(r'ent\.v\[\s*"(\w+)"\s*\]\s*=\s*([^;]+);')
# The compact form some IW5 maps (mp_village) were saved in: fxid only as the
# create argument, `ent set_origin_and_angles( origin, angles );`, and the
# defaults left out. The one-shot delay every verbose file writes is -15.
_FX_ORIGIN_ANGLES = re.compile(r"ent\s+set_origin_and_angles\s*\((.*)\)\s*;")
_ONESHOT_DELAY = -15


def parse_createfx(path):
    """Every createfx placement: [{create, name, <fields>...}], positions converted like entities."""
    out = []
    for kind, arg, body, _next in _FX_BLOCK.findall(read_text(path)):
        fx = {"create": kind}
        if arg.strip().strip('"'):
            fx["name"] = arg.strip().strip('"')
        compact = _FX_ORIGIN_ANGLES.search(body)
        if compact:
            origin, angles = (_literal(a) for a in _split_args(compact.group(1)))
            fx.update(origin=origin, angles=angles)
            if kind == "createOneshotEffect":
                fx.update(fxid=fx.get("name"), delay=_ONESHOT_DELAY)
        for key, value in _FX_FIELD.findall(body):
            try:
                fx[key] = _literal(value)
            except ValueError:
                fx[key] = value.strip()
        if isinstance(fx.get("origin"), list) and len(fx["origin"]) == 3:
            fx["at"] = to_engine(fx["origin"])
        out.append(fx)
    return out


def parse_cvars(path):
    """A `.vision` or `.sun` file: {cvar: value}."""
    text = read_text(path)
    return {k: v for k, v in re.findall(r'(\S+)\s+"([^"]*)"', text)}


# ---- assembling the file -------------------------------------------------------


def _entity(index, e):
    out = {"id": index, **e}
    origin = floats(e.get("origin"))
    if origin:
        out["at"] = to_engine(origin)
    return out


def read_entities(ents_path, game_key):
    """Every entity of an entity-lump dump as `export_metadata.json` lists it: keys named, `id`, `at`."""
    return [_entity(i, e) for i, e in enumerate(named_keys(parse_ents(ents_path), game_key))]


def _brief(e):
    """An entity cut to what identifies it, for the grouped sections."""
    keep = (
        "id",
        "classname",
        "targetname",
        "script_label",
        "script_gameobjectname",
        "model",
        "radius",
        "height",
        "target",
        "at",
        "origin",
    )
    return {k: e[k] for k in keep if k in e}


def _find(raw_dir, *suffixes):
    """Rawfiles under `raw_dir` whose path ends in one of `suffixes`, sorted."""
    hits = []
    for dirpath, _dirs, files in os.walk(raw_dir or ""):
        for f in files:
            rel = os.path.relpath(os.path.join(dirpath, f), raw_dir).replace(os.sep, "/")
            if rel.endswith(suffixes):
                hits.append(rel)
    return sorted(hits)


def build_metadata(map_name, game_key, ents_path, raw_dir, zone_path, minimap=None, assets_dir=None):
    """The whole of `export_metadata.json` as a dict. `minimap` is (archive, (w, h)) or None."""
    entities = read_entities(ents_path, game_key)
    worldspawn = next((e for e in entities if e.get("classname") == "worldspawn"), {})
    _zone_game, assets = zone_listing(zone_path)
    short, long = GAMES[game_key]

    spawns, influencers, intermission, objects = [], [], [], {}
    targetnames = {}
    for e in entities:
        cls = e.get("classname", "")
        if e.get("targetname") and not _GENERATED_NAME.match(e["targetname"]):
            targetnames.setdefault(e["targetname"], []).append(e["id"])
        for mode in e.get("script_gameobjectname", "").split():
            objects.setdefault(mode, []).append(_brief(e))
        kind = spawn_kind(cls) or zombie_spawn_kind(e)
        if kind and "at" in e:
            yaw = (floats(e.get("angles")) or [0, 0, 0])[1]
            extra = {k: v for k, v in e.items() if k not in ("id", "classname", "origin", "angles", "at", *EDITOR_KEYS)}
            spawns.append(
                {
                    "id": e["id"],
                    "class": cls,
                    **kind,
                    "at": e["at"],
                    "yaw": yaw,
                    "facing": facing(yaw),
                    "origin": e["origin"],
                    **extra,
                }
            )
        elif cls == "mp_uspawn_influencer":
            influencers.append({k: v for k, v in e.items() if k not in EDITOR_KEYS})
        elif cls == "mp_global_intermission" or cls.startswith("info_player_start"):
            intermission.append({**_brief(e), "angles": e.get("angles")})

    counts = {}
    for s in spawns:
        label = "_".join(p for p in (s["team"], s["variant"], "start" if s["start"] else None) if p) or "any"
        counts.setdefault(s["mode"], Counter())[label] += 1

    # The minimap: the image, and where the game draws it.
    corners = [floats(e.get("origin")) for e in entities if e.get("targetname") == "minimap_corner"]
    corners = [c for c in corners if c]
    north_yaw_value = floats(worldspawn.get("northyaw"), 1)
    north_yaw = north_yaw_value[0] if north_yaw_value else 0.0
    frame = None
    if len(corners) == 2:
        f = minimap_frame(corners[0], corners[1], north_yaw)
        # `xz`: the engine's ground-plane coordinates; the image has no height.
        frame = {
            k: {"origin": [round(v, 2) for v in p], "xz": to_engine((p[0], p[1], 0))[::2]} for k, p in f.items() if k != "up"
        }
        frame["up"] = {"cod": [round(v, 4) for v in f["up"]], "engine": [round(f["up"][0], 4), 0.0, round(-f["up"][1], 4)]}

    # Plain-text scripts that belong to this map (IW5 compiles its own; see zone.scriptfile).
    stem = map_name.lower()
    scripts, fx_effects = {}, {}
    for rel in _find(raw_dir, ".gsc", ".csc"):
        if stem not in rel.lower() or "/createfx/" in rel:
            continue
        path = os.path.join(raw_dir, rel)
        parsed = parse_script(path)
        if any(parsed.values()):
            scripts[rel] = parsed
        for fx_id, fx_path in _EFFECT.findall(read_text(path)):
            fx_effects[fx_id] = fx_path
    compass_range = next((s["dvars"]["compassmaxrange"] for s in scripts.values() if "compassmaxrange" in s["dvars"]), None)
    fog = {rel: scripts.pop(rel) for rel in list(scripts) if "/createart/" in rel}

    # createfx: the server copy when there is one; T5's client copy repeats it.
    fx_files = _find(raw_dir, f"createfx/{stem}_fx.gsc") or _find(raw_dir, f"createfx/{stem}_fx.csc")
    fx = [p for rel in fx_files for p in parse_createfx(os.path.join(raw_dir, rel))]
    fx += t5_sound_emitters(entities)

    vision = next((parse_cvars(os.path.join(raw_dir, r)) for r in _find(raw_dir, f"vision/{stem}.vision")), None)
    sun = next((parse_cvars(os.path.join(raw_dir, r)) for r in _find(raw_dir, f"sun/{stem}.sun")), None)
    kind, pattern = MODE_ASSETS.get(game_key, MODE_ASSETS_DEFAULT)
    mode_tables = sorted(m.group(1) for t in assets.get(kind, []) if (m := re.search(pattern.format(stem=re.escape(stem)), t)))

    numeric_keys = sorted({k for e in entities for k in e if k.isdigit()}, key=int)
    has = (lambda f: os.path.exists(os.path.join(assets_dir, f))) if assets_dir else (lambda f: False)

    return {
        "_about": (
            "GENERATED by `python3 -m scripts.cod export` from the map's own zone; see docs/cod/pipeline.md. "
            "`origin`/`angles` are the game's values (inches, Z up, pitch-yaw-roll degrees); `at` is the "
            "engine position in metres (x, y up, z); `facing` an engine-space unit vector. Nothing reads this file yet."
        ),
        "map": map_name,
        "game": game_key,
        "game_name": long,
        "category": world_category(map_name, short),
        "images": {key: f"assets/{name}" if has(name) else None for key, name in IMAGES.items()},
        "minimap": {
            "material": next((n for n in assets.get("material", []) if n.startswith("compass_map_")), f"compass_map_{stem}"),
            "archive": minimap[0] if minimap else None,
            "size": list(minimap[1]) if minimap else None,
            "north_yaw": north_yaw,
            "north_yaw_source": "worldspawn northyaw" if north_yaw_value else "engine default (0: image up is CoD +X)",
            "corners": [list(c) for c in corners],
            "image_corners": frame,
            "compass_max_range": compass_range,
        },
        "worldspawn": {k: v for k, v in worldspawn.items() if k not in ("id", "classname")},
        "game_modes": {
            "names": MODE_NAMES,
            "with_spawns": sorted(counts),
            "with_objects": sorted(objects),
            "config_tables": mode_tables,
        },
        "spawn_counts": {mode: dict(sorted(c.items())) for mode, c in sorted(counts.items())},
        "spawns": spawns,
        "spawn_influencers": influencers,
        "game_objects": dict(sorted(objects.items())),
        "intermission": intermission,
        "scripts": scripts,
        "fog": fog,
        "sun": sun,
        "vision": vision,
        "fx": {"counts": dict(Counter(p["create"] for p in fx).most_common()), "effects": fx_effects, "placements": fx},
        "entity_counts": dict(Counter(e.get("classname", "?") for e in entities).most_common()),
        "targetnames": dict(sorted(targetnames.items())),
        "unnamed_keys": numeric_keys,
        "zone": {
            "assets": {k: len(v) for k, v in sorted(assets.items(), key=lambda kv: -len(kv[1]))},
            "rawfiles": assets.get("rawfile", []),
            "scriptfiles": assets.get("scriptfile", []),
            "stringtables": assets.get("stringtable", []),
        },
        "entities": entities,
    }


def dumps(value, indent=0, width=120):
    """JSON with short values on one line: one entity, spawn or vector per line, not one number per line."""
    flat = json.dumps(value, ensure_ascii=False)
    if len(flat) + indent <= width or not isinstance(value, (dict, list)) or not value:
        return flat
    if isinstance(value, list) and not any(isinstance(v, (dict, list)) for v in value):
        return flat
    pad, inner = " " * indent, " " * (indent + 1)
    if isinstance(value, dict):
        items = [f"{inner}{json.dumps(k)}: {dumps(v, indent + 1, width)}" for k, v in value.items()]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    items = [
        f"{inner}{dumps(v, indent + 1, width) if not isinstance(v, dict) else json.dumps(v, ensure_ascii=False)}" for v in value
    ]
    return "[\n" + ",\n".join(items) + f"\n{pad}]"


def record_images(out_dir):
    """Rewrite `export_metadata.json`'s `images` from the pictures in `assets/`, touching
    nothing else in it; returns whether it changed (False, too, when there is no file)."""
    path = os.path.join(out_dir, METADATA_FILE)
    if not os.path.exists(path):
        return False
    data = json.loads(read_text(path, "utf-8"))
    images = {
        key: f"assets/{name}" if os.path.exists(os.path.join(out_dir, "assets", name)) else None for key, name in IMAGES.items()
    }
    if data.get("images") == images:
        return False
    data["images"] = images
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(dumps(data) + "\n")
    return True


def write_metadata(out_dir, map_name, game_key, ents_path, raw_dir, zone_path, minimap=None):
    """Write `<out_dir>/export_metadata.json`; return (path, the data)."""
    data = build_metadata(map_name, game_key, ents_path, raw_dir, zone_path, minimap, os.path.join(out_dir, "assets"))
    path = os.path.join(out_dir, METADATA_FILE)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(dumps(data) + "\n")
    return path, data
