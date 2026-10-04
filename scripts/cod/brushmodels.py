"""Where each brush model goes, and whether it collides.

A brush model N >= 1 is `GfxWorld.models[N]` (render surfaces) plus the
clipmap's `cmodels[N]` (brushes and soup). Its geometry is stored relative to
whatever places it, so read as world geometry it lands at the world origin.
In every stock MP map each one has exactly one placer: an entity whose model
is `"*N"` (at its origin) or a dynamic entity whose `brushModel` is N (at its
pose). See docs/cod/pitfalls.md.
"""

import re
import sys
from collections import Counter

from . import gameobjects
from .entities import detect_keys, named_keys, parse_ents, triple
from .units import vec3, vec4

# Entity classes whose brush model is solid in game. The rest (trigger_*,
# occlusion_override, heli_height_lock, ...) are script volumes: Black Ops marks
# them SOLID in their contents, and trusting that turns every trigger into a wall.
SOLID_CLASSES = ("script_brushmodel", "glass")

#: `script_brushmodel` spawnflags bit 1, DYNAMICPATH: the game connects and
#: disconnects the path links through it, so a script can take it away. Every
#: door, window clip and dog clip on the zombies maps has it, and nothing else
#: there does (reverse/t5-zombies/README.md#3-door-links).
DYNAMIC_PATH = 1

_WRITER_GAP = "The backend's GfxWorld and clipmap writers must write it (docs/cod/pipeline.md#the-dump-tree)."


def _quat_matrix(x, y, z, w):
    """Unit quaternion (x, y, z, w) -> row-major 3x3, world = R . local."""
    return (
        (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
        (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
        (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
    )


def dynamic_path(entity):
    """Whether an entity (keys named) is a `script_brushmodel` with DYNAMICPATH set."""
    if entity.get("classname") != "script_brushmodel":
        return False
    try:
        return bool(int(entity.get("spawnflags") or 0) & DYNAMIC_PATH)
    except ValueError:
        return False


def part_of(where):
    """The part name (`*N`) of a placement that can be absent, else None.

    A solid brush model is removable when only some game modes have it, or when
    it is DYNAMICPATH: the collision and the shell both split exactly this set
    out of the base (docs/cod/reference.md#game-mode-objects).
    """
    if where and where.get("solid") and (where.get("modes") is not None or where.get("dynamic_path")):
        return f"*{where['n']}"
    return None


def load(ents_path, clip, facts=None):
    """{N: placement} for every brush model something places.

    A placement is {n, source: "entity" | "dynEnt", classname, origin (CoD units),
    rotation (None or a 3x3 matrix), solid}; one an entity places also carries
    `entity`, its index in the lump (and in export_metadata.json), `modes`,
    `gameobjects.modes_of` under `facts` (None when there are no facts), and
    `dynamic_path`.
    """
    entities = parse_ents(ents_path)
    classname, origin, angles, model = detect_keys(entities)
    game = clip.get("_game")
    named = named_keys(entities, game)
    out, rotated, no_origin = {}, [], 0
    for index, e in enumerate(entities):
        ref = e.get(model, "")
        if not re.fullmatch(r"\*\d+", ref):
            continue
        pos = triple(e.get(origin, ""))
        if pos is None:
            no_origin += 1
            continue
        n = int(ref[1:])
        ang = triple(e.get(angles, "")) if angles else None
        if ang and any(abs(a) > 1e-6 for a in ang):
            rotated.append(n)
        cls = e.get(classname, "")
        modes = gameobjects.modes_of(game, named[index], facts) if facts else None
        out[n] = {
            "n": n,
            "source": "entity",
            "classname": cls,
            "origin": tuple(pos),
            "rotation": None,
            "solid": cls in SOLID_CLASSES,
            "entity": index,
            "modes": modes,
            "dynamic_path": dynamic_path({**named[index], "classname": cls}),
        }

    # No stock map rotates a brush-model entity, so what its angles would mean is unmeasured.
    if rotated:
        print(
            f"  WARNING: {len(rotated)} brush-model entities carry angles (*{', *'.join(map(str, rotated[:8]))})."
            " Placed by origin only: no stock map has one, and whether the angles are"
            " already baked into the geometry is unmeasured."
        )
    if no_origin:
        print(f"  WARNING: {no_origin} brush-model entities have no origin and are not placed")

    for lst in clip.get("dynEnts", []):
        for d in lst:
            n = d.get("brushModel")
            if not n:
                continue
            if n in out:
                print(f"  WARNING: *{n} is placed by both an entity and a dynamic entity; keeping the entity")
                continue
            x, y, z, w = vec4(d["quat"])
            identity = abs(abs(w) - 1.0) < 1e-6 and max(abs(x), abs(y), abs(z)) < 1e-6
            out[n] = {
                "n": n,
                "source": "dynEnt",
                "classname": None,
                "origin": vec3(d["origin"]),
                "rotation": None if identity else _quat_matrix(x, y, z, w),
                "solid": True,
            }
    return out


def preflight(gfxworld, clip, ents_exists, ents_path, facts=None):
    """Refuse a dump that cannot place its brush models; return the placements.

    Run before any work, because a misplaced brush model still loads: nothing
    downstream would fail. With `facts` (gameobjects.MapFacts), each entity's
    placement says which game modes have it.
    """
    if "models" not in gfxworld:
        sys.exit(f"the GfxWorld dump has no `models` table, so its brush models cannot be placed. {_WRITER_GAP}")
    if "cmodels" not in clip:
        sys.exit(f"the clipmap dump is missing or has no `cmodels`, so brush-model collision cannot be placed. {_WRITER_GAP}")
    models, cmodels = gfxworld["models"], clip["cmodels"]
    if len(models) != len(cmodels):
        sys.exit(
            f"GfxWorld has {len(models)} brush models and the clipmap {len(cmodels)}; every stock "
            "map agrees, so the dumps do not describe the same map"
        )
    if not ents_exists:
        sys.exit(f"no entity lump at {ents_path}: nothing to place the brush models by")

    placements = load(ents_path, clip, facts)
    needed = [n for n in range(1, len(models)) if models[n]["surfaceCount"] or cmodels[n]["brushes"] or cmodels[n]["partitions"]]
    unplaced = [n for n in needed if n not in placements]
    # A rendered brush model nothing places would draw its walls at the world
    # origin, which is the trap this guard exists for, and is also what a dump
    # whose dynamic entities carry no `brushModel` looks like. A collision-only one
    # cannot be seen: it is an orphan the map's author left behind (mp_frag's
    # *69), and collision.py counts and skips it.
    invisible = [n for n in unplaced if not models[n]["surfaceCount"]]
    if unplaced != invisible:
        sys.exit(
            f"{len(unplaced) - len(invisible)} rendered brush model(s) have nothing placing them "
            f"(*{', *'.join(str(n) for n in unplaced if n not in invisible)}). In all 54 stock MP maps each is "
            "placed by exactly one entity or dynamic entity. If the clipmap's dynEnts carry no `brushModel`, "
            f"{_WRITER_GAP} Otherwise this map breaks that rule: see docs/cod/pitfalls.md."
        )
    source = Counter(placements[n]["source"] for n in needed if n in placements)
    volumes = sum(1 for n in needed if n in placements and not placements[n]["solid"])
    orphans = f"; {len(invisible)} collision-only with nothing placing them, skipped" if invisible else ""
    restricted = sum(1 for n in needed if n in placements and placements[n]["solid"] and placements[n].get("modes"))
    dynamic = sum(1 for n in needed if n in placements and placements[n]["solid"] and placements[n].get("dynamic_path"))
    print(
        f"      {len(needed)} brush models: {source['entity']} placed by entity, "
        f"{source['dynEnt']} by dynamic entity; {volumes} non-solid volumes kept out of the collision{orphans}"
        f"{f'; {restricted} solid only in some game modes' if restricted else ''}"
        f"{f'; {dynamic} DYNAMICPATH' if dynamic else ''}"
    )
    return placements


def place(placement, p):
    """A point in a brush model's own space -> the world, CoD units."""
    r = placement["rotation"]
    if r:
        p = (
            r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
            r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
            r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2],
        )
    o = placement["origin"]
    return (p[0] + o[0], p[1] + o[1], p[2] + o[2])


def orient(placement, v):
    """A direction (a normal) in a brush model's own space -> the world."""
    r = placement["rotation"]
    if not r:
        return v
    return (
        r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2],
        r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2],
        r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2],
    )


def owners(models):
    """{surface index: N} for every surface a brush model N >= 1 owns."""
    out = {}
    for n, m in enumerate(models):
        if n and m.get("surfaceCount"):
            for s in range(m["startSurfIndex"], m["startSurfIndex"] + m["surfaceCount"]):
                out[s] = n
    return out
