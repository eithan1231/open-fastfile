"""Server-run creatures in the catalogue: an AI type's bodies, heads and clips.

A player is a body, a head and a gun, dressed by the map's create-a-class scripts
(characters.py). A creature is dressed by the game's *AI* scripts instead, three
rawfiles deep: `aitype/<name>.gsc` names a `character/<name>.gsc`, which takes its
body from one `xmodelalias/` list and its head from another. A name repeated in a
list is a weight — the honor guard's body list is `body1` once and `body2` three
times — so the catalogue keeps each distinct model once and says how often the
game picks it. The data: docs/cod/reference.md#ai-bodies-black-ops-zombies.

Nothing is grafted but the heads' joints. A zombie holds no weapon (its aitype
names one, which the zombies script never draws) and has no first-person hands.
Every head is packed on its own and rebound by joint name at run time, and each
body carries the union of the heads' joints, so the runtime picks a body and a
head per actor from its seed rather than the catalogue baking every pair.

The clips are not a map's: every standard zombie clip is in `common_zombie.ff`,
shared by every zombies map, so they are one clip set (`animations/t5/zombie/`)
whose role table is read out of the game's own `_zombiemode.gsc`. A role names
every variant the game picks among, as its `randomintrange` does. A map can
replace a variant (theater's `walk7` is the goose step); that difference goes on
the actor, not the clip set. A clip's root motion is kept as numbers rather than
played: an actor's position comes from the simulation, and its cycle is scrubbed
to the speed it moves at. docs/cod/pipeline.md#actors.

A traversal clip is the one exception: a jump down is a path, not a cycle, so its
delta track is kept key by key (`rootPath`) for the runtime to move the body along.
Which clip a link plays is the game's own answer, read out of the traverse script
its animscript names (`traversals`); three of theater's live in the map's zone
rather than the common one, so the map's clips are dumped too.
"""

import json
import math
import os
import re
from collections import Counter
from dataclasses import dataclass

from . import catalog, hitboxes, maps
from .animations import TRANSLATION_BY_ASSET_TYPE, clip_to_gltf
from .backends import for_fastfile
from .characters import build_anim_rig, graft_head, skeleton_spec
from .files import read_bytes, read_text, write_text
from .gltf import read_glb, write_glb
from .materials import classify_materials, material_file_stem
from .pack import pack_one
from .textures import texture_index
from .units import UNITS_PER_M
from .viewmodel import _model_glb
from .xanim import decode

GAME = "t5"
KIND = "actors"
ANIM_KIND = "animations"
ANIM_FILE = "animations.glb"
FORMAT_VERSION = 1  # of an actor entry and an actor clip set's JSON
# A creature is seen across a map, as a player's body is (characters.BODY_TEXTURE_SIZE).
BODY_TEXTURE_SIZE = 512


@dataclass(frozen=True)
class ActorSource:
    """One catalogue actor: which AI type in which zone, and the clip set it plays."""

    id: str  # the catalogue id, `actors/t5/<id>/`
    kind: str  # what the runtime spawns it as: "zombie", later "dog"
    zone: str  # the map zone whose scripts and models dress it
    aitype: str  # `aitype/<aitype>.gsc`
    clips: str  # the clip set, `animations/t5/<clips>/`
    animname: str  # the key the game's clip tables are indexed by (`level.scr_anim[animname]`)


# The rows the stage builds. The dog is the next one — `zombie_dog` (aitype in
# common_zombie.ff, `zombie_wolf` in the map zone) with a `dog` clip set whose
# roles are animscripts/zombie_dog_init.gsc's — and the crawler is the same
# honor guard playing `crawl` roles (docs/cod/pipeline.md#actors).
ACTORS = (ActorSource("zombie_ger", "zombie", "zombie_theater", "zombie_ger_zombie", "zombie", "zombie"),)

# Every role a clip set plays, and where the game keeps each one's variants.
# `table.path` reads `level.<table>["<animname>"][path...]` out of the scripts,
# `*` matching any index, in the order the game assigns them; `%name` is a clip
# the game names inline. A role is a list because the game picks among several:
# `walk` is `walk1..7`, what `_zombiemode_spawner.gsc`'s `randomintrange(1, 8)`
# indexes, and a clip listed twice (`sprint1` and `sprint3`) is picked twice as often.
ZOMBIE_CLIP_ROLES = {
    "idle": ("%ai_zombie_idle_v1_delta",),  # anim.idleAnimArray["stand"][0][0], _zombiemode.gsc
    "walk": tuple(f"scr_anim.walk{i}" for i in range(1, 8)),
    "run": tuple(f"scr_anim.run{i}" for i in range(1, 6)),  # randomintrange(1, 6): run6 is never picked
    "sprint": tuple(f"scr_anim.sprint{i}" for i in range(1, 4)),
    "attack": ("_zombie_melee.*",),
    "walkAttack": ("_zombie_walk_melee.*",),
    "runAttack": ("_zombie_run_melee.*",),
    # What `set_zombie_run_cycle` gives a standing zombie as its `deathanim`.
    "death": ("_zombie_deaths.*",),
    # `death1`/`death2`: in the game's table, never picked by the spawner.
    "deathAlt": ("scr_anim.death1", "scr_anim.death2"),
    # Climbing in through a window: animscripts/traverse/zombie_mantle_over_40.gsc, by speed.
    "windowClimb": ("%ai_zombie_traverse_v1", "%ai_zombie_traverse_v2"),
    "windowClimbRun": ("%ai_zombie_traverse_v5",),
    "windowClimbSprint": ("%ai_zombie_traverse_v6", "%ai_zombie_traverse_v7"),
    # Out of the ground, by speed; variant [1] and [2] of the walk are one role.
    "rise": ("_zombie_rise_anims.*.walk.*",),
    "riseRun": ("_zombie_rise_anims.*.run.*",),
    "riseSprint": ("_zombie_rise_anims.*.sprint.*",),
}
CLIP_SETS = {"zombie": ZOMBIE_CLIP_ROLES}
# The traverse scripts a zombie plays a clip of its own for: `animscripts/traverse/
# zombie_jump_down_190.gsc` and the like, each naming a standing zombie's clip in its
# `jump_down_zombie()`. The window climb is a role instead (it varies by speed), and
# the quads' wall and vent drops are theirs, not a walker's.
TRAVERSE_DIR = "animscripts/traverse"
TRAVERSE_SCRIPT = re.compile(r"^(zombie_jump_(?:down|up)_\w+)\.gsc$")
_ZOMBIE_TRAVERSE = re.compile(r"^\w+_zombie\(\)\s*\{(.*?)^\}", re.S | re.M)
_TRAVERSE_ANIM = re.compile(r'traverseData\[\s*"traverseAnim"\s*\]\s*=\s*%(\w+)\s*;')
# The roles an actor plays once and holds, rather than loops. Everything else loops.
ONCE_ROLES = ("attack", "walkAttack", "runAttack", "death", "deathAlt", "windowClimb", "windowClimbRun")
ONCE_ROLES += ("windowClimbSprint", "rise", "riseRun", "riseSprint")
# Where the clip tables are assigned: the common zone's, then the map's own, which
# override them (theater's `anim_override_func` sets `walk7`).
COMMON_SCRIPTS = ("maps/_zombiemode.gsc",)

# What the stage dumps, and from where. The map zone holds the AI types, their
# characters and models; `common_zombie.ff` holds every clip and the dog's AI type;
# the `_patch` zones load after their base and replace its scripts of the same name,
# so they are dumped after it. Images and materials come from every zone, because a
# model in the map names materials that live in a companion (a leading comma).
CLIP_ZONE = "common_zombie"
PATCH = "_patch"
WORK = os.path.join(maps.CACHE_DIR, "actors-bo1")


# -- Reading the AI scripts ----------------------------------------------------------

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_LINE_COMMENT = re.compile(r"//[^\n]*")
_ALIAS_ENTRY = re.compile(r'a\[\s*\d+\s*\]\s*=\s*"([^"]+)"\s*;')
_ALIAS_CALL = re.compile(r"xmodelalias\\(\w+)::main\(\)")
_CHARACTER_CALL = re.compile(r"character\\(\w+)::main\(\)")
_SET_MODEL = re.compile(r'setModel\(\s*"([^"]+)"\s*\)')
_FIELD = re.compile(r"self\.(\w+)\s*=\s*(.+?);")
_HEALTH = re.compile(r"self\.health\s*=\s*(\d+)\s*;")
_QUAKED = re.compile(r"QUAKED\s+\S+\s+\([^)]*\)\s+\(([^)]*)\)\s+\(([^)]*)\)")
_ANIM = re.compile(r"level\.(\w+)\[\s*\"(\w+)\"\s*\]((?:\[[^\]]+\])*)\s*=\s*%(\w+)\s*;")
_INDEX = re.compile(r"\[\s*\"?([^\]\"]+?)\"?\s*\]")
GIB_FIELD = re.compile(r"(torsoDmg|legDmg|gibSpawn)\d+$")


def strip_comments(text):
    """`text` without `/* */` or `//` comments: the game's own tables keep dead lines in both."""
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


def alias_models(text):
    """The models one `xmodelalias/*.gsc` lists, in order, repeats kept (a repeat is a weight)."""
    return _ALIAS_ENTRY.findall(strip_comments(text))


def _value(expr):
    """One `self.<field> = ...` right-hand side: ("model", name), ("alias", name) or None."""
    alias = _ALIAS_CALL.search(expr)
    if alias:
        return "alias", alias.group(1)
    literal = re.fullmatch(r'\s*"([^"]+)"\s*', expr)
    return ("model", literal.group(1)) if literal else None


def read_character(text):
    """What one `character/*.gsc`'s `main()` dresses an actor in.

    {"body": (kind, name), "head": (kind, name) or None, "gibs": {field: (kind, name)}},
    each (kind, name) a ("model", xmodel) or an ("alias", xmodelalias) to pick from.
    """
    main = strip_comments(text).split("precache()")[0]
    body = None
    model = _SET_MODEL.search(main)
    if model:
        body = ("model", model.group(1))
    elif "setModelFromArray" in main:
        body = ("alias", _ALIAS_CALL.search(main.split("setModelFromArray", 1)[1]).group(1))
    fields = {m.group(1): _value(m.group(2)) for m in _FIELD.finditer(main)}
    gibs = {k: v for k, v in fields.items() if GIB_FIELD.match(k) and v}
    return {"body": body, "head": fields.get("headModel"), "gibs": gibs}


def read_aitype(text):
    """One `aitype/*.gsc`: {"characters": [name, ...], "health": int, "bounds": (mins, maxs) inches}.

    `characters` repeats a character once per `switch` case that names it, which is
    the weight `get_random_character` gives it.
    """
    bounds = _QUAKED.search(text)
    main = strip_comments(text).split("spawner()")[0]
    health = _HEALTH.search(main)
    return {
        "characters": _CHARACTER_CALL.findall(main),
        "health": int(health.group(1)) if health else None,
        "bounds": tuple(tuple(float(v) for v in b.split()) for b in bounds.groups()) if bounds else None,
    }


def anim_tables(texts, animname):
    """{table: {path: clip}} of every `level.<table>["<animname>"][...] = %clip;`, later texts overriding.

    A path is the tuple of indices after the animname (`("walk7",)`, `("1", "walk", "0")`),
    kept in the order first assigned, so a table's variants come out in the game's order.
    """
    tables = {}
    for text in texts:
        for m in _ANIM.finditer(strip_comments(text)):
            table, name, path, clip = m.groups()
            if name == animname:
                # GSC names are case-blind and the zone's are lower case: `%..._walk_altA`
                # is the clip `..._walk_alta`.
                tables.setdefault(table, {})[tuple(_INDEX.findall(path))] = clip.lower()
    return tables


def resolve_roles(role_table, tables):
    """{role: [clip, ...]} of `role_table` (ZOMBIE_CLIP_ROLES' shape) over parsed `tables`.

    Raises on a reference that matches nothing: a role quietly empty is a creature
    that stands in its bind pose where it should attack.
    """
    out = {}
    for role, refs in role_table.items():
        clips = []
        for ref in refs:
            if ref.startswith("%"):
                clips.append(ref[1:].lower())
                continue
            table, *pattern = ref.split(".")
            found = [
                clip
                for path, clip in tables.get(table, {}).items()
                if len(path) == len(pattern) and all(p in ("*", v) for p, v in zip(pattern, path, strict=True))
            ]
            if not found:
                raise ValueError(f"{role}: {ref} names no clip in the scripts")
            clips += found
        out[role] = clips
    return out


def traversal_clip(text):
    """The clip a traverse script plays for a standing zombie: its `*_zombie()`'s one `traverseAnim`, or None."""
    m = _ZOMBIE_TRAVERSE.search(strip_comments(text))
    anims = _TRAVERSE_ANIM.findall(m.group(1)) if m else []
    return anims[0].lower() if len(anims) == 1 else None


def read_traversals(raw_dir):
    """{animscript: clip} for every zombie traverse script dumped, in name order."""
    folder = os.path.join(raw_dir, TRAVERSE_DIR)
    out = {}
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        m = TRAVERSE_SCRIPT.match(name)
        clip = m and traversal_clip(read_text(os.path.join(folder, name)))
        if clip:
            out[m.group(1)] = clip
    return out


def _weighted(names):
    """[(name, weight)] in first-seen order: how often a list with repeats picks each."""
    return list(Counter(names).items())


def _script(raw_dir, rel):
    path = os.path.join(raw_dir, rel)
    if not os.path.exists(path):
        raise ValueError(f"{rel} was not dumped")
    return read_text(path)


def _models(raw_dir, ref):
    """The xmodels one character field names: itself, or an alias list's entries."""
    kind, name = ref
    return [name] if kind == "model" else alias_models(_script(raw_dir, f"xmodelalias/{name}.gsc"))


def read_cast(raw_dir, aitype):
    """How the game dresses one AI type: its bodies and heads with weights, its gibs, health and size."""
    ai = read_aitype(_script(raw_dir, f"aitype/{aitype}.gsc"))
    if not ai["characters"]:
        raise ValueError(f"aitype/{aitype}.gsc names no character")
    bodies, heads, gibs = [], [], {}
    for name in ai["characters"]:
        character = read_character(_script(raw_dir, f"character/{name}.gsc"))
        if character["body"] is None:
            raise ValueError(f"character/{name}.gsc sets no model")
        bodies += _models(raw_dir, character["body"])
        heads += _models(raw_dir, character["head"]) if character["head"] else []
        for field, ref in character["gibs"].items():
            gibs[field] = sorted(set(gibs.get(field, [])) | set(_models(raw_dir, ref)))
    return {
        "characters": sorted(set(ai["characters"])),
        "bodies": _weighted(bodies),
        "heads": _weighted(heads),
        "gibs": gibs,
        "health": ai["health"],
        "bounds": ai["bounds"],
    }


# -- Clips ---------------------------------------------------------------------------


def root_motion(clip):
    """The clip's whole-cycle root motion in metres and degrees, or None without a delta track.

    In the actor's own frame at the clip's start: `forward` is CoD's +x, `left` +y,
    `up` +z. `speed` is the ground distance over the clip's length, which is what a
    runtime divides its movement speed by to scrub the cycle.
    """
    if not clip.has_root_motion:
        return None
    moved = [0.0, 0.0, 0.0]
    if clip.delta_translation:
        first, last = clip.delta_translation.values[0], clip.delta_translation.values[-1]
        moved = [(b - a) / UNITS_PER_M for a, b in zip(first, last, strict=True)]
    yaw = 0.0
    if clip.delta_rotation:
        z, w = clip.delta_rotation.values[-1][2:]
        z0, w0 = clip.delta_rotation.values[0][2:]
        yaw = math.degrees(2 * math.atan2(z, w) - 2 * math.atan2(z0, w0))
        yaw = (yaw + 180) % 360 - 180
    ground = math.hypot(moved[0], moved[1])
    return {
        "forward": round(moved[0], 4),
        "left": round(moved[1], 4),
        "up": round(moved[2], 4),
        "yaw": round(yaw, 2),
        "speed": round(ground / clip.duration, 4) if clip.duration else 0.0,
    }


def root_path(clip):
    """The delta track key by key: `[seconds, forward, left, up]` in metres from the clip's start, or None.

    The frame is the actor's at the clip's start, as `root_motion`'s. The yaw is
    left out: no traversal clip turns, and a runtime faces along the link.
    """
    track = clip.delta_translation
    if not clip.has_root_motion or not track or not clip.fps:
        return None
    first = track.values[0]
    return [
        [round(frame / clip.fps, 4), *(round((v - v0) / UNITS_PER_M, 4) for v, v0 in zip(value, first, strict=True))]
        for frame, value in zip(track.indices, track.values, strict=True)
    ]


def clip_entry(clip, path=False):
    """One clip as the runtime reads it: length, looping, cues and root motion; with `path`, its root path too."""
    entry = {
        "duration": round(clip.duration, 6),
        "frames": clip.frames,
        "fps": clip.fps,
        "looped": clip.looped,
        "notes": [[n, round(frame / clip.fps, 4)] for n, frame in clip.notetracks],
        "rootMotion": root_motion(clip),
    }
    if path:
        entry["rootPath"] = root_path(clip)
    return entry


def clip_set_entry(ident, roles, clips, joints, traversals=None, game=GAME):
    """`animations/t5/<ident>/<ident>.json`: the role table, the traversal table and every clip's facts.

    `animType` is the id, so `animationsFor(game, animType)` finds it the way it
    finds a soldier's set; `actor` says the roles are lists, not one clip each.
    A traversal's clip carries its root path, which is what moves the body.
    """
    traversals = traversals or {}
    paths = set(traversals.values())
    return {
        "id": ident,
        "game": game,
        "animType": ident,
        "actor": True,
        "version": FORMAT_VERSION,
        "clips": ANIM_FILE,
        "joints": joints,
        "roles": roles,
        "onceRoles": [r for r in ONCE_ROLES if r in roles],
        "traversals": dict(sorted(traversals.items())),
        "clipTable": {name: clip_entry(clips[name], name in paths) for name in sorted(clips)},
    }


def write_clip_glb(out_path, specs, clips):
    """The skeleton-only clip file: the union of `specs` with every clip in `clips`. Returns [problems]."""
    gltf = build_anim_rig(specs)
    gltf["skins"][0]["name"] = "actor"
    buf = bytearray()
    problems = []
    for name in sorted(clips):
        clip = clips[name]
        if clip.asset_type not in TRANSLATION_BY_ASSET_TYPE:
            problems.append(f"{name}: asset type {clip.asset_type}, translations read as offsets (unverified)")
        written, unmatched = clip_to_gltf(gltf, buf, clip)
        if not written:
            problems.append(f"{name} drives no joint of the actor skeleton")
        elif unmatched > len(clip.bones) // 2:
            problems.append(f"{name}: {unmatched} of {len(clip.bones)} bones not in the skeleton")
    gltf["buffers"] = [{"byteLength": len(buf)}]
    write_glb(out_path, gltf, buf)
    return problems


# -- The entry -----------------------------------------------------------------------


def actor_entry(source, cast, role_overrides, game=GAME):
    """`actors/t5/<id>/<id>.json`: the files, how often each is picked, and the game's numbers."""
    entry = {
        "id": source.id,
        "game": game,
        "kind": source.kind,
        "version": FORMAT_VERSION,
        "bodies": [f"{name}.glb" for name, _ in cast["bodies"]],
        "heads": [f"{name}.glb" for name, _ in cast["heads"]],
    }
    # Omitted when every file is as likely as the next, which is what a runtime assumes.
    for key, weighted in (("bodyWeights", cast["bodies"]), ("headWeights", cast["heads"])):
        if len({w for _, w in weighted}) > 1:
            entry[key] = [w for _, w in weighted]
    entry["animations"] = source.clips
    if role_overrides:
        entry["roles"] = role_overrides
    entry["hitboxes"] = f"{source.id}.hitboxes.json"
    if cast["health"] is not None:
        entry["health"] = cast["health"]
    if cast["bounds"]:
        mins, maxs = cast["bounds"]
        entry["size"] = {
            "radius": round(max(abs(v) for v in (*mins[:2], *maxs[:2])) / UNITS_PER_M, 4),
            "height": round((maxs[2] - mins[2]) / UNITS_PER_M, 4),
        }
    entry["source"] = {"zone": source.zone, "aitype": source.aitype, "characters": cast["characters"]}
    # Not exported yet: the dismemberment pieces the game swaps in, by the field that names them.
    if cast["gibs"]:
        entry["gibs"] = cast["gibs"]
    return entry


def _write_json(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_text(path, json.dumps(body, indent=1) + "\n")


COLOUR_MAP = "colorMap"


def fill_colour_maps(gltf, material_dir):
    """Give each material with no colour map the one its dumped JSON names. Returns the names filled.

    A model can wear a material another zone defines (a leading comma), and the
    zone's own copy is then a stub with no textures, so its GLB material has none:
    the honor guard's linen, leather, metal and skin all draw white without this.
    The companion's JSON has the table.
    """
    filled = []
    for mat in gltf.get("materials", []):
        if (mat.get("pbrMetallicRoughness") or {}).get("baseColorTexture"):
            continue
        path = os.path.join(material_dir, f"{material_file_stem(mat.get('name', ''))}.json")
        if not os.path.exists(path):
            continue
        image = next(
            (t["image"] for t in json.loads(read_text(path)).get("textures", []) if t.get("semantic") == COLOUR_MAP), None
        )
        if image is None:
            continue
        # One texture per image, so four materials sharing one map pack it once.
        uri = f"../images/{image}.dds"
        textures = gltf.setdefault("textures", [])
        images = gltf.setdefault("images", [])
        index = next((i for i, t in enumerate(textures) if images[t.get("source", -1)].get("uri") == uri), None)
        if index is None:
            images.append({"uri": uri})
            textures.append({"source": len(images) - 1})
            index = len(textures) - 1
        pbr = mat.setdefault("pbrMetallicRoughness", {"metallicFactor": 0.0})
        pbr["baseColorTexture"] = {"index": index}
        filled.append(mat["name"])
    return filled


def _pack(path, out_path, work, iwi, states):
    """Pack one model with its companion materials' colour maps filled in. Returns textures missing."""
    gltf, buf = read_glb(path)
    if fill_colour_maps(gltf, os.path.join(work, "mat", "materials")):
        path = os.path.join(work, "filled", os.path.basename(path))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_glb(path, gltf, buf)
    return pack_one(path, out_path, iwi, BODY_TEXTURE_SIZE, states, False)[1]


def build_actor(source, work, worlds_root, states, iwi, cast=None, game=GAME):
    """One actor's bodies and heads into the catalogue. Returns (cast, [skeleton spec], [problems]).

    `cast` is read from the text AI scripts unless given: T6 compiles its scripts,
    and t6/actors.py reads them its own way.
    """
    models = os.path.join(work, "models")
    cast = cast or read_cast(os.path.join(work, "raw"), source.aitype)
    out = catalog.entry_dir(worlds_root, KIND, game, source.id)
    os.makedirs(out, exist_ok=True)
    problems, missing = [], 0

    heads = []
    for name, _ in cast["heads"]:
        path = _model_glb(models, name)
        if path is None:
            raise ValueError(f"{source.id}: the head {name} was not dumped")
        missing += _pack(path, os.path.join(out, f"{name}.glb"), work, iwi, states)
        heads.append(read_glb(path)[0])

    specs = []
    for name, weight in cast["bodies"]:
        path = _model_glb(models, name)
        if path is None:
            raise ValueError(f"{source.id}: the body {name} was not dumped")
        packed = os.path.join(out, f"{name}.glb")
        missing += _pack(path, packed, work, iwi, states)
        gltf, buf = read_glb(packed)
        added = [joint for head in heads for joint in graft_head(gltf, head)]
        gltf["buffers"] = [{"byteLength": len(buf)}]
        write_glb(packed, gltf, buf)
        specs.append(skeleton_spec(gltf))
        print(f"  + {KIND}/{game}/{source.id}: {name} x{weight} (+{len(added)} head joints)")
    if missing:
        problems.append(f"{source.id}: {missing} texture(s) not in the dump, drawn white")
    return cast, specs, problems


def build(work, worlds_root, sources=ACTORS):
    """Every actor in `sources` and the clip sets they play into `<worlds_root>/catalog/`. Returns [problems]."""
    raw = os.path.join(work, "raw")
    anim_dir = os.path.join(work, "anim", "xanim")
    _, _, _, states = classify_materials(os.path.join(work, "mat", "materials"), set(), GAME)
    iwi = texture_index(os.path.join(work, "img"))
    common = [_script(raw, rel) for rel in COMMON_SCRIPTS]
    problems = []
    # A script whose clip no dumped zone holds is another map's (pentagon's 184 and
    # 222): said, and left out, rather than stopping the build.
    traversals = {}
    for script, clip in read_traversals(raw).items():
        if os.path.exists(os.path.join(anim_dir, clip)):
            traversals[script] = clip
        else:
            print(f"  . {script}: {clip} is in no zone dumped")

    by_set = {}  # clip set -> (roles, [clip names every actor needs], [skeleton specs])
    built = []
    for source in sources:
        cast, specs, trouble = build_actor(source, work, worlds_root, states, iwi)
        problems += trouble
        role_table = CLIP_SETS[source.clips]
        base = resolve_roles(role_table, anim_tables(common, source.animname))
        own_path = os.path.join(raw, "maps", f"{source.zone}.gsc")
        own = [read_text(own_path)] if os.path.exists(own_path) else []
        mine = resolve_roles(role_table, anim_tables(common + own, source.animname))
        overrides = {role: clips for role, clips in mine.items() if clips != base[role]}
        roles, needed, all_specs = by_set.setdefault(source.clips, (base, set(), []))
        needed |= {c for clips in (*base.values(), *mine.values()) for c in clips} | set(traversals.values())
        all_specs += specs
        entry = actor_entry(source, cast, overrides)
        built.append((source, entry))

    for ident, (roles, needed, specs) in sorted(by_set.items()):
        absent = sorted(n for n in needed if not os.path.exists(os.path.join(anim_dir, n)))
        if absent:
            raise ValueError(f"clip set {ident}: {', '.join(absent)} not in the dump")
        clips = {name: decode(read_bytes(os.path.join(anim_dir, name)), name) for name in sorted(needed)}
        out = catalog.entry_dir(worlds_root, ANIM_KIND, GAME, ident)
        os.makedirs(out, exist_ok=True)
        problems += write_clip_glb(os.path.join(out, ANIM_FILE), specs, clips)
        joints = len({name for spec in specs for name, _, _ in spec})
        _write_json(os.path.join(out, f"{ident}.json"), clip_set_entry(ident, roles, clips, joints, traversals))
        print(f"  + {ANIM_KIND}/{GAME}/{ident}: {len(roles)} role(s) over {len(clips)} clip(s), {joints} joints")

    for source, entry in built:
        out = catalog.entry_dir(worlds_root, KIND, GAME, source.id)
        _write_json(os.path.join(out, f"{source.id}.json"), entry)
        if hitboxes.write_entry(out, source.id, entry["bodies"] + entry["heads"]) is None:
            problems.append(f"{source.id}: no skin, so no hitboxes")
    return problems


# -- Dumping and the command ---------------------------------------------------------


def zone_folder(game="bo1"):
    """The Black Ops `zone/Common` folder, wherever this machine keeps it (maps.require_game)."""
    return maps.require_game(game)["zones"][0]


def companions(map_name):
    """The map's companion zones, as maps.json lists them (file names beside the map)."""
    _, entries = maps.load_maps()
    entry = next((e for e in entries if e["map"] == map_name), None)
    return list(entry.get("common", [])) if entry else [f"{CLIP_ZONE}.ff"]


def dump(map_names, work, zone_dir=None):
    """Dump what the stage reads into `work`. A zone and kind already dumped there is skipped."""
    games, _ = maps.load_maps()
    zone_dir = zone_dir or zone_folder()
    search = ";".join(games["bo1"]["search"])

    def ff(name):
        return os.path.normpath(os.path.join(zone_dir, name if name.endswith(".ff") else f"{name}.ff"))

    backend = for_fastfile(ff(CLIP_ZONE), search)
    # Scripts in load order, so a patch's copy lands last and wins.
    plan = [(ff(CLIP_ZONE), "raw", "rawfile"), (ff(CLIP_ZONE + PATCH), "raw", "rawfile"), (ff(CLIP_ZONE), "anim", "xanim")]
    for name in map_names:
        others = [ff(c) for c in companions(name)]
        plan += [(ff(name), "raw", "rawfile"), (ff(name + PATCH), "raw", "rawfile")]
        # Companions first and the map last, so the map's own copy of an image wins.
        plan += [(p, sub, kind) for p in (*others, ff(name)) for sub, kind in (("img", "image"), ("mat", "material"))]
        plan += [(ff(name), "models", "xmodel"), (ff(name), "anim", "xanim")]
    done_path = os.path.join(work, ".dumped")
    done = set(read_text(done_path).split()) if os.path.exists(done_path) else set()
    os.makedirs(work, exist_ok=True)
    for path, sub, kind in plan:
        key = f"{os.path.basename(path)}:{kind}"
        if key in done or not os.path.exists(path):
            continue
        print(f"  dumping {os.path.basename(path)} {kind}")
        backend.dump(path, os.path.join(work, sub), kind)
        done.add(key)
        write_text(done_path, "\n".join(sorted(done)) + "\n")
    return work


GAMES = ("bo1", "bo2")  # `--game`: games.json's keys; Black Ops II's stage is t6/actors.py


def main(args):
    """`python3 -m scripts.cod actors [--game bo1|bo2]`: dump what the actors need, build them, rebuild the index."""
    problems = []
    for game in [args.game] if args.game else GAMES:
        if game == "bo2":
            from .t6 import actors as t6_actors  # imported late: t6/actors.py imports this module

            problems += t6_actors.main(args)
            continue
        work = (args.work if args.game else None) or WORK  # --work is one game's
        if not args.no_dump:
            dump(sorted({s.zone for s in ACTORS}), work)
        problems += build(work, args.worlds)
    by_kind = catalog.scan_entries(args.worlds)
    path = catalog.write_index(args.worlds, by_kind)
    print(f"  = {len(by_kind.get(KIND, []))} actor(s) in the catalogue -> {os.path.relpath(path, args.worlds)}")
    for p in problems:
        print(f"  !! {p}")
    return not problems
