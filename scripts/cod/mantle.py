"""The map's mantle volumes: where the game lets a player climb, as `mantle` nodes.

A mantle brush is contents `0x01000000` and blocks nobody, so `collision.py`
rightly drops it from the collision mesh — a mantle volume is a *permission
region*, not a surface. It comes out here instead, as world-file nodes, because
that is where gameplay data lives (docs/cod/reference.md#collision).

Two facts about the data make this possible:

- **A yaw-aligned box is a faithful shape.** Half the hulls are exactly boxes,
  and fitting a box to the rest costs a median 1% of volume. `volumes.fit_box`
  proves this per volume, and `tests/test_mantle.py` asserts it.
- **The volume's top face is usually the surface you land on**, so its height is
  the climb height — which is also what picks the animation
  (`mp_mantle_up_21`..`_57`, named in inches).

The second holds for 84% of volumes by `landing_check`, which is a **coarse
report, not a proof**: it reads brush bounds only, so a ledge made of triangle
soup or of a sloped brush counts as unconfirmed even where it is really there.
So the volume is exported as the map drew it and the engine decides the final
height by tracing the collision it already has, taking the volume as the
permission and the direction rather than as the answer. That is also what keeps
the 320 volumes over 2 m tall (a whole wall's worth, and never a `mantle_over`)
from claiming a 14 m climb.

The kind (`mantle_on` / `mantle_over`) comes off the brush's faces: the material
each names on MW2/MW3 and Ghosts, and on Black Ops and Black Ops II, whose faces
carry flags and no material, the `mantleOn`/`mantleOver` surface flags the game
itself reads (reverse/t6-traversal/README.md). See docs/cod/games.md.
"""

import collections
import math

from .collision import FACE_FLAG_GAMES, face_flags
from .files import read_json
from .units import UNITS_PER_M
from .volumes import box_footprint, brush_owners, fit_box, hull_faces, hull_volume, solid_tops

#: Contents bit marking a mantle edge. Blocks nothing; see docs/cod/reference.md#collision.
MANTLE = 0x01000000

#: Black Ops II's face surface flags for the kind: its own `infoParms[]` names them
#: `mantleOn`, `mantleOver` and `mount` (each with contents MANTLE), and `Mantle_Check`
#: reads over before on off the face it traced. reverse/t6-traversal/README.md.
MANTLE_ON = 0x04000000
MANTLE_OVER = 0x08000000
MOUNT = 0x10000000

#: How far a blocking surface may sit from the volume's top and still count as
#: the one it lands on, metres. Generous: brushes are inset a unit from the
#: surfaces they back (docs/cod/reference.md#brush-models).
LANDING_TOLERANCE = 0.08

#: How far below a volume's top a surface may be and still be a candidate for it.
#: Past this it is the floor the player is standing on, not the ledge.
LANDING_REACH = 1.0

#: A volume taller than this cannot be a ledge a player climbs; the animation set
#: tops out at 57 in (1.45 m). Reported, never dropped: the map says what it says.
IMPLAUSIBLE_HEIGHT = 2.0


def kind_of(brush, materials, game, planes=None):
    """`"onto"`, `"over"`, `"mixed"` or None: which mantle the brush's faces name.

    Every face counts, the six axial ones included: 38% of Modern Warfare
    volumes are all-axial boxes with no `sides` at all, and their material is
    only in `axialMaterialNum`. Read that way, every one of
    5,825 volumes names a kind. The engine treats an unnamed volume as `onto`;
    it is left out rather than guessed so that a world file never claims more
    than the map said.

    Black Ops and Black Ops II faces name no material, only flags. The game reads
    the kind off the one face its trace hit, over before on (`Mantle_Check`:
    T6 0x94a314, T5 0x41e6f2); a brush is one volume here, so its faces' flags
    are pooled. `planes`, the hull's own (`hull_faces`), leaves out a plane no
    trace can hit: 5 of Black Ops II's 7 two-kind brushes name `on` only there.
    `mount` (0x10000000) is not a mantle kind and is ignored.

    The game's own name for `onto` is `mantle_on`, but `on` is a boolean in the
    DSL (`shadows: on`), so the node spells it `onto` — see dsl/schema.ts.
    """
    if game in FACE_FLAG_GAMES:
        bits = 0
        for plane, (flags, _) in enumerate(face_flags(brush, materials, game)):
            if planes is None or plane in planes:
                bits |= flags
        over, on = bool(bits & MANTLE_OVER), bool(bits & MANTLE_ON)
    else:
        names = {name for _, name in face_flags(brush, materials, game) if name and "mantle" in name}
        over_names = {n for n in names if "mantle_over" in n}
        over, on = bool(over_names), bool(names - over_names)
    # Never seen in 5,825 Modern Warfare volumes; 7 of Black Ops II's 2,245. Worth
    # hearing about rather than quietly picking one.
    if over and on:
        return "mixed"
    return "over" if over else "onto" if on else None


def landing_check(volume_top, footprint, solid_tops):
    """The signed metres from a volume's top to the highest blocking surface under it.

    None when nothing blocks beneath it at all. `solid_tops` is
    (min_x, max_x, min_z, max_z, top) per blocking brush, engine space.

    Coarse on purpose: brush *bounds*, and no triangle soup. A ledge that is
    soup, or the sloped face of a brush whose bounds reach higher, comes back
    unconfirmed even though it is there. Read the result as a report on the
    export, never as a condition for emitting a volume.
    """
    min_x, max_x, min_z, max_z = footprint
    best = None
    for sx0, sx1, sz0, sz1, top in solid_tops:
        if sx1 < min_x or sx0 > max_x or sz1 < min_z or sz0 > max_z:
            continue
        if top > volume_top + LANDING_TOLERANCE or top < volume_top - LANDING_REACH:
            continue
        if best is None or top > best:
            best = top
    return None if best is None else best - volume_top


def read_mantles(manifest_path, placements):
    """Every mantle volume in one clipmap dump, as boxes, plus a report on them.

    `placements` is `brushmodels.preflight`'s. Returns (volumes, stats). A volume is
    `{at, size, yaw, kind, fill, height, landing}` — `at`/`size` in engine metres,
    `yaw` in degrees, `fill` the share of the box its hull actually occupies, and
    `landing` the signed metres from the box's top to the surface beneath it
    (None: nothing found).
    """
    manifest = read_json(manifest_path)
    game = manifest.get("_game")
    materials = manifest.get("materials", [])
    brushes = manifest.get("brushes", [])

    # cmodels[N] for N >= 1 belongs to a brush model, placed by an entity. None of
    # the 3,006 Modern Warfare and Black Ops volumes is owned by one; 8 of
    # mp_prisonbreak's 176 are, and are placed as collision.py places a wall.
    owned = brush_owners(manifest)

    tops = solid_tops(brushes)
    volumes = []
    stats = collections.Counter()
    for index, brush in enumerate(brushes):
        if not brush.get("contents", 0) & MANTLE:
            continue
        stats["found"] += 1
        placement = None
        if index in owned:
            placement = placements.get(owned[index])
            if placement is None or not placement["solid"]:
                # Nothing places the wall this volume is the ledge of, so there is no climb.
                stats["skipped: owned by an unplaced or non-solid brush model"] += 1
                continue
            stats["placed by a brush model"] += 1
        faces = hull_faces(brush, placement)
        if not faces:
            stats["skipped: degenerate hull"] += 1
            continue

        centre, size, yaw = fit_box(faces)
        box_volume = size[0] * size[1] * size[2]
        fill = hull_volume(faces) / box_volume if box_volume > 1e-9 else 0.0

        kind = kind_of(brush, materials, game, {face.plane for face in faces})
        if kind == "mixed":
            stats["kind named both on and over"] += 1
            kind = "over"
        if kind is None and game in FACE_FLAG_GAMES:
            # The game mantles only off a face flagged on or over (T6 0x9486f6,
            # 0x949c2a). None of Black Ops II's 2,245 volumes lacks one.
            stats["skipped: no face flagged mantleOn or mantleOver"] += 1
            continue
        stats[f"kind: {kind or 'unnamed'}"] += 1

        landing = landing_check(centre[1] + size[1] / 2, box_footprint(centre, size, yaw), tops)
        if landing is None or abs(landing) > LANDING_TOLERANCE:
            stats["landing surface unconfirmed (brushes only; soup not read)"] += 1
        if size[1] > IMPLAUSIBLE_HEIGHT:
            stats["taller than any mantle animation, so the engine will trace for the ledge"] += 1

        volumes.append(
            {
                "at": tuple(round(v, 3) for v in centre),
                "size": tuple(round(v, 3) for v in size),
                "yaw": round(math.degrees(yaw), 2),
                "kind": kind,
                "fill": fill,
                "height": size[1],
                "landing": landing,
            }
        )
    stats["exported"] = len(volumes)
    return volumes, stats


def report(volumes, stats):
    """Print what came out, the way the other export stages do."""
    if not stats["found"]:
        print("mantle volumes: none in this map")
        return
    print(f"mantle volumes: {stats['exported']:,} exported of {stats['found']:,} found")
    for key in sorted(k for k in stats if k not in ("found", "exported")):
        print(f"  {key}: {stats[key]:,}")
    if volumes:
        fills = sorted(v["fill"] for v in volumes)
        heights = sorted(v["height"] for v in volumes)
        median_height = heights[len(heights) // 2]
        print(f"  box fit (hull / box volume): median {fills[len(fills) // 2]:.2f}, worst {fills[0]:.2f}")
        print(f"  climb height: median {median_height:.2f} m ({round(median_height * UNITS_PER_M)} in), max {heights[-1]:.2f} m")
