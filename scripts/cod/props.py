"""Prop placements: from the map's dumps to a generated `props.world` of `asset` + `model` nodes.

A map places models in two places, and both are needed: `GfxWorld.staticModels`
(baked scenery) and the entity lump (models the map's script places: vehicles,
tarps, animated foliage). What collides comes from the game's own clipmap.
"""

import math
import os
import re
import sys
from collections import Counter, defaultdict
from functools import cache

from . import gameobjects
from .entities import detect_keys, named_keys, parse_ents, triple
from .files import read_json
from .gltf import glb_bounds
from .pack import served_path
from .units import UNITS_PER_M, vec3

ASSET_PREFIX = "assets/props"
MODEL_EXPORT = "model_export/"  # where an XModel JSON's LOD files are, and what props/ mirrors

# Entity classes that carry scenery. Triggers, glass and script_brushmodel point
# at brush models (`*N`), which brushmodels.py places instead.
ENTITY_CLASSES = ("script_model", "misc_model", "dyn_model")

# Contents bits from an XModel's own JSON (`contents`): same bits as a brush's.
SOLID, PLAYERCLIP = 0x1, 0x10000


# -- Orientation ---------------------------------------------------------------
# A placement's orientation is Quake "pitch yaw roll" in CoD's frame, composed
# as R = Rz(yaw) . Ry(pitch) . Rx(roll) (idTech's AngleVectors). The CoD -> engine
# axis change is a rotation C, so a rotation carries over by conjugation,
# C . R . C^T. tests/props-orientation.test.ts pins the result against three.js.

COD_TO_ENGINE = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]
ENGINE_TO_COD = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]


def _mat3_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def axis_to_angles(axis):
    """`GfxPackedPlacement.axis` (rows are basis vectors) -> (pitch, yaw, roll) degrees.

    The rows are the local basis in world space, so local-to-world is the
    transpose of `axis` as stored; this inverts `cod_rotation`.
    """
    r = [[axis[j][i] for j in range(3)] for i in range(3)]
    pitch = -math.degrees(math.asin(max(-1.0, min(1.0, r[2][0]))))
    yaw = math.degrees(math.atan2(r[1][0], r[0][0]))
    roll = math.degrees(math.atan2(r[2][1], r[2][2]))
    return pitch, yaw, roll


def cod_rotation(pitch, yaw, roll):
    """The orientation as a matrix in CoD's own frame. Pitch is not negated: Ry already maps x to (cos p, 0, -sin p)."""
    p, y, r = (math.radians(v) for v in (pitch, yaw, roll))
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    cr, sr = math.cos(r), math.sin(r)
    rz = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]]
    ry = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]]
    rx = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]]
    return _mat3_mul(rz, _mat3_mul(ry, rx))


def engine_euler(pitch, yaw, roll):
    """Quake angles -> the XYZ euler degrees `rotate:` takes (three.js Euler order 'XYZ')."""
    m = _mat3_mul(COD_TO_ENGINE, _mat3_mul(cod_rotation(pitch, yaw, roll), ENGINE_TO_COD))
    m02 = min(1.0, max(-1.0, m[0][2]))
    ey = math.asin(m02)
    if abs(m02) < 0.9999999:
        ex = math.atan2(-m[1][2], m[2][2])
        ez = math.atan2(-m[0][1], m[0][0])
    else:  # gimbal lock: y is +-90, so x and z are one axis
        ex = math.atan2(m[2][1], m[1][1])
        ez = 0.0
    return [math.degrees(v) for v in (ex, ey, ez)]


def rotate_clause(e):
    """`rotate:` for one placement: one value for a pure yaw (the common case), else three."""
    if e["pitch"] == 0.0 and e["roll"] == 0.0:
        return f"rotate: {num(e['yaw'] % 360.0, 1)}"
    ex, ey, ez = engine_euler(e["pitch"], e["yaw"], e["roll"])
    return f"rotate: {num(ex, 2)} {num(ey, 2)} {num(ez, 2)}"


def num(v, places):
    """Fixed-point, never scientific notation (the DSL tokenizer has no exponent rule)."""
    s = f"{v:.{places}f}"
    return s[1:] if s.startswith("-0.") and float(s) == 0 else s  # -0.00 -> 0.00


# -- Collecting placements -------------------------------------------------------


def _entity_placements(ents_path, animation_of, facts=None, game=None):
    """Script-placed models from the entity lump, as (model, origin, angles, scale, clip or None, modes).

    `modes` is gameobjects.modes_of under `facts`: None for a model every game mode has.
    """
    entities = parse_ents(ents_path)
    classname, origin, angles, model = detect_keys(entities)
    print(f"  entity keys detected: classname={classname} origin={origin} angles={angles} model={model}")

    out, skipped_brush = [], 0
    for e in entities:
        if e.get(classname) not in ENTITY_CLASSES:
            continue
        name = e.get(model)
        if not name or name.startswith("*"):
            if name:
                skipped_brush += 1  # a brush model ("*12"); brushmodels.py places those
            continue
        name = name.removeprefix(",")  # companion-zone marker, see collect_placements
        pos = triple(e.get(origin, ""))
        if not pos:
            continue
        ang = triple(e.get(angles, "")) or [0.0, 0.0, 0.0]
        modes = gameobjects.modes_of(game, named_keys([e], game)[0], facts) if facts else None
        out.append((name, pos, ang, 1.0, animation_of(e) if animation_of else None, modes))
    restricted = sum(1 for p in out if p[5])
    print(
        f"  {len(out)} entity placements ({skipped_brush} inline brushmodels skipped)"
        f"{f', {restricted} only in some game modes' if restricted else ''}"
    )
    return out


def collect_placements(gfxworld, ents_path, animation_of=None, facts=None):
    """Every model placement, in the engine frame: [{model, x, y, z, pitch, yaw, roll, scale, anim, modes}].

    `animation_of(entity)` names the clip a script-placed model plays (see
    animations.ClipAssignments); `anim` is None for everything else. `modes`
    lists the game modes a script-placed model exists in, under `facts`
    (gameobjects.MapFacts), and is None for one every mode has.
    """
    placements, unnamed, referenced = [], 0, 0
    for p in gfxworld["staticModels"]:
        if not p.get("model"):
            unnamed += 1
            continue
        # A leading comma marks an asset defined in a companion zone (common_mp.ff).
        # It is linkage, not identity: left on, the placement matches no exported model.
        name = p["model"]
        if name.startswith(","):
            name, referenced = name[1:], referenced + 1
        placements.append((name, vec3(p["origin"]), axis_to_angles(p["axis"]), p.get("scale", 1.0), None, None))
    print(
        f"  {len(placements)} GfxWorld static placements"
        f"{f' ({unnamed} unnamed)' if unnamed else ''}"
        f"{f', {referenced} defined in a companion zone' if referenced else ''}"
    )

    n_static = len(placements)
    placements += _entity_placements(ents_path, animation_of, facts, gfxworld.get("_game"))

    out = []
    for name, (x, y, z), (pitch, yaw, roll), scale, anim, modes in placements:
        out.append(
            {
                "model": name,
                "x": x / UNITS_PER_M,
                "y": z / UNITS_PER_M,
                "z": -y / UNITS_PER_M,
                "pitch": round(pitch, 4),
                "yaw": round(yaw, 4),
                "roll": round(roll, 4),
                "scale": scale,
                "anim": anim,
                "modes": modes,
            }
        )
    print(f"  {len(out)} placements ({n_static} static + {len(out) - n_static} scripted)")
    return out


def referenced_placements(manifest_path):
    """How many static placements name an asset defined in another zone (a leading comma)."""
    models = read_json(manifest_path)["staticModels"]
    return sum(1 for m in models if str(m.get("model", "")).startswith(","))


# -- Per-asset facts from the XModel dump ----------------------------------------------


@cache
def _xmodel(xmodels, model):
    """
    One model's XModel JSON, or None. Cached for the life of the process: a map
    asks per placement — 8,400 times over 232 models on interchange — and the
    depot does not change under an export. Callers only read what comes back.
    """
    path = os.path.join(xmodels, model + ".json")
    return read_json(path) if os.path.exists(path) else None


def model_blocks_player(model, xmodels):
    """Whether this model's own contents stop the player; None when there is no XModel JSON.

    Being in the clipmap's model list says only that a model collides with
    *something*: shrubs (0x2) and glass debris (0x10) are listed too.
    """
    info = _xmodel(xmodels, model)
    if info is None:
        return None
    return bool((info.get("contents") or 0) & (SOLID | PLAYERCLIP))


def coll_lod(model, xmodels, level_count):
    """The exported LOD level that doubles as the collision hull (XModel.collLod, clamped to what was packed)."""
    info = _xmodel(xmodels, model)
    if info is None:
        return None
    lod = info.get("collLod")
    if lod is None:
        return None
    return max(0, min(int(lod), level_count - 1))


def lod_chain(model, assets_dir, xmodels):
    """[(source, until metres or None)] for the packed levels of one model, highest detail first.

    An XModel LOD's `distance` is where the *next* LOD takes over, and the last
    one's is where the game stops drawing the model. Usually only lod0 is
    packed, standing in for every level, so each packed level is drawn until the
    next *packed* level takes over, and the last until the model's cull distance.
    1e5 inches and up means "never culled".
    """
    info = _xmodel(xmodels, model)
    lods = (info.get("lods") if info else None) or []
    packed = []
    for i, lod in enumerate(lods):
        f = served_path(lod.get("file", "").removeprefix(MODEL_EXPORT))
        if f and os.path.exists(os.path.join(assets_dir, f)):
            packed.append((i, f))
    levels = []
    for k, (_, f) in enumerate(packed):
        last = packed[k + 1][0] - 1 if k + 1 < len(packed) else len(lods) - 1
        d = lods[last].get("distance")
        levels.append((f"{ASSET_PREFIX}/{f}", None if d is None or d >= 1e5 else d / UNITS_PER_M))
    return levels


def _packed_files(assets_dir):
    """Every packed .glb under `assets_dir`, as paths relative to it, sorted."""
    out = []
    for dirpath, _, files in os.walk(assets_dir):
        out += [os.path.relpath(os.path.join(dirpath, f), assets_dir) for f in files if f.endswith(".glb")]
    return sorted(out)


def asset_name(stem, taken):
    """A .glb stem -> a legal DSL identifier, unique within the world."""
    name = re.sub(r"[^A-Za-z0-9_-]", "_", stem)
    if not re.match(r"^[A-Za-z_]", name):
        name = "m_" + name
    if name in taken:
        n = 2
        while f"{name}_{n}" in taken:
            n += 1
        name = f"{name}_{n}"
    return name


def _playable_area(clip):
    """(min x, max x, min y, max y) in metres, CoD axes: the middle 96% of the player-clip brushes."""
    clips = [b for b in clip.get("brushes", []) if (b.get("contents", 0) & 0x10000) and not (b.get("contents", 0) & 0x1)]
    if not clips:
        return None
    mids = [vec3(b["bounds"]["midPoint"]) for b in clips]
    xs = sorted(m[0] / UNITS_PER_M for m in mids)
    ys = sorted(m[1] / UNITS_PER_M for m in mids)

    def q(v, f):
        return v[int(len(v) * f)]

    return (q(xs, 0.02), q(xs, 0.98), q(ys, 0.02), q(ys, 0.98))


# -- Writing props.world ---------------------------------------------------------


def write_props_world(placements, assets_dir, out_path, xmodels, clip_path, animated=None):
    """Write `props.world`: one `asset` per model, then its placements grouped, densest first.

    `animated` is {model: clip names embedded in its GLB}; a placement whose clip
    is among them gets `animate:`.
    """
    animated = animated or {}
    assets, bounds = {}, {}
    for f in _packed_files(assets_dir):
        name = f[:-9] if f.endswith("_lod0.glb") else f[:-4]
        assets[name] = f
        bounds[name] = glb_bounds(os.path.join(assets_dir, f))

    by_model = defaultdict(list)
    for e in placements:
        by_model[e["model"]].append(e)
    missing = {m: len(v) for m, v in by_model.items() if served_path(m) not in assets}

    # What the game itself collided against: baked props and destructibles.
    # Script-spawned destructibles appear in neither list, so a `*destructible*`
    # model inside the playable area keeps its collision.
    clip = read_json(clip_path)
    game_collides = {m.get("model") for m in clip.get("staticModels", [])}
    game_collides |= {e.get("model") for lst in clip.get("dynEnts", []) for e in lst}

    def listed(model):
        # IW6 draws `mv/<model>` where its clipmap lists `<model>`, at the same origin.
        return model in game_collides or model.rsplit("/", 1)[-1] in game_collides

    playable = _playable_area(clip)

    def reachable(e):
        if not playable:
            return True
        lo_x, hi_x, lo_y, hi_y = playable
        return lo_x <= e["x"] <= hi_x and lo_y <= -e["z"] <= hi_y

    names, chains, hulls, taken = {}, {}, {}, set()
    for model in sorted(by_model):
        if model in missing:
            continue
        packed = assets[served_path(model)]
        stem = packed[:-9] if packed.endswith("_lod0.glb") else packed[:-4]
        names[model] = asset_name(stem, taken)
        taken.add(names[model])
        chain = lod_chain(model, assets_dir, xmodels)
        chains[model] = chain or [(f"{ASSET_PREFIX}/{packed}", None)]
        hulls[model] = coll_lod(model, xmodels, len(chains[model]))

    emitted = colliding = animating = restricted = 0
    reasons = Counter()
    out = []

    for model in sorted(names, key=lambda m: names[m]):
        chain = chains[model]
        head, tail = chain[0], chain[1:]
        until = "" if head[1] is None else f", until: {num(head[1], 1)}"
        hull = hulls.get(model)
        hull_clause = "" if hull is None else f", hull: {hull}"
        if not tail:
            out.append(f'asset {names[model]} {{ source: "{head[0]}"{until}{hull_clause} }}')
        else:
            out.append(f"asset {names[model]} {{")
            out.append(f'  source: "{head[0]}"{until}')
            for src, dist in tail:
                d = "" if dist is None else f", until: {num(dist, 1)}"
                out.append(f'  lod {{ source: "{src}"{d} }}')
            if hull is not None:
                out.append(f"  hull: {hull}")
            out.append("}")
    out.append("")

    # Densest kinds first, then by name, so a regenerated file diffs meaningfully.
    for model in sorted(by_model, key=lambda m: (-len(by_model[m]), m)):
        if model in missing:
            continue
        group = sorted(by_model[model], key=lambda e: (e["x"], e["z"]))
        size = bounds.get(served_path(model)) or [0.1, 0.1, 0.1]

        out.append(f"// {model} — {len(group)} placement(s), bbox {num(size[0], 2)} x {num(size[1], 2)} x {num(size[2], 2)} m")
        out.append("group {")
        blocks = model_blocks_player(model, xmodels)  # the model's own contents: the same for every placement
        for e in group:
            if blocks is False:
                solid, why = False, "non-blocking contents (foliage/glass/decoration)"
            elif listed(model):
                solid, why = True, None
            elif "destructible" in model and reachable(e):
                solid, why = True, None
            elif not reachable(e):
                solid, why = False, "outside the playable area"
            else:
                solid, why = False, "the game did not collide it"
            if solid:
                colliding += 1
            else:
                reasons[why] += 1
            scale = e.get("scale", 1.0)
            scale_clause = "" if round(scale, 4) == 1.0 else f"scale: {num(scale, 4)}, "
            anim = e.get("anim")
            anim_clause = f', animate: "{anim}"' if anim and anim in animated.get(model, ()) else ""
            animating += bool(anim_clause)
            modes = e.get("modes")
            restricted += bool(modes)
            out.append(
                f"  model {{ asset: {names[model]}, "
                f"at: {num(e['x'], 3)} {num(e['y'], 3)} {num(e['z'], 3)}, "
                f"{rotate_clause(e)}, "
                f"size: {num(size[0], 2)} {num(size[1], 2)} {num(size[2], 2)}, "
                f"{scale_clause}"
                f"collide: {('hull' if hulls.get(model) is not None else 'box') if solid else 'false'}{anim_clause}"
                f"{f', {gameobjects.mode_clause(modes)}' if modes else ''} }}"
            )
            emitted += 1
        out.append("}")
        out.append("")

    skipped = sum(missing.values())
    if emitted + skipped != len(placements):
        sys.exit(f"accounting error: {emitted} emitted + {skipped} skipped != {len(placements)} placements")

    header = [
        "// GENERATED by `python3 -m scripts.cod export`: do not edit by hand.",
        "//",
        f"// {emitted} model placements over {len(by_model) - len(missing)} assets.",
        f"// {colliding} collide; {emitted - colliding} render only:",
    ]
    for reason, n in reasons.most_common():
        header.append(f"//     {n:5d}  {reason}")
    if "brushes" not in clip:
        header.append("// The clipmap dump has no brushes yet, so no playable area bounds the destructibles.")
    if animating:
        clips = len({c for names in animated.values() for c in names})
        header.append(f"// {animating} animate, playing {clips} clip(s) from the map's own scripts.")
    if restricted:
        header.append(f"// {restricted} exist only in the game modes their `mode:` names.")
    if missing:
        header += ["//", f"// SKIPPED — {skipped} placement(s) whose asset did not export:"]
        for m, n in sorted(missing.items()):
            header.append(f"//     {n:5d}  {m}")
    header.append("")

    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(header + out))
    print("\n".join(line[3:] for line in header if line.startswith("//")))
    print(f"-> {out_path}")
