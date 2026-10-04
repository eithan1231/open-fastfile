"""The map's ladders: where the game lets a player climb a wall, as `ladder` nodes.

A ladder is a face whose surface flags carry `LADDER` (the `ladder` infoparm, in
all three games). In the data it is always a thin invisible player-clip box of
its own, never a flagged face of an ordinary wall, and nowhere else: no soup
triangle and no model carries the flag. So a ladder is two things at once. The
box stays a wall in `collision.glb`, where `collision.py` already puts it, and
the permission to climb comes out here as a world-file node, beside the mantle
volumes and for the same reason (docs/cod/reference.md#collision).

- **Every face counts, the axial ones included.** More than half of all ladder
  faces are one of a brush's six axial faces, which the dump names apart from
  `sides` (`axialMaterialNum`, or T5's `axialSurfaceFlags`).
- **The flagged side is usually every side** (147 of 154 brushes), so the game
  lets you grab one from anywhere. `face` is written only for a box flagged on
  exactly one side, and names which of the box's sides that is.
- **Brush-model brushes are ladders too** (5 of 154), placed where their entity
  puts them, as the collision exporter places them.

`landing_sides` is a coarse report, never a filter: the top of a ladder is
usually flush with a walkable surface on exactly one side of it.
"""

import collections
import math

from .collision import face_flags
from .files import read_json
from .units import UNITS_PER_M
from .volumes import blocking_bounds, brush_owners, fit_box, hull_faces, to_box_frame

#: Surface flag marking a ladder face (OAT MaterialConstantsIW4.h, infoparm `ladder`).
LADDER = 0x8

#: Surface flag of a sky face. MW3's `sky_ny_manhattan_01` also carries `LADDER`
#: (flags `0x3c`), on 36 faces that are no ladder.
SKY = 0x4

#: A face steeper than this (normal's up component below it) is one a player
#: climbs rather than stands on or hits their head on. CoD's walkable limit.
SIDE_FACE = 0.7

#: The box's local sides, by the outward normal each names (dsl/schema.ts `face`).
SIDES = {"front": (2, -1), "back": (2, 1), "left": (0, -1), "right": (0, 1)}

#: How far from a ladder's top a surface may be, either way, and still be where
#: the climb ends; and how far out from the box the probe looks for it. 16 in:
#: the game carries a climber over a lip of up to its 18 in step.
LANDING_REACH = 16 / UNITS_PER_M

#: A flagged face whose normal is further than this from the side it is named
#: after (cosine) is reported: a slanted ladder, whose tilt the box loses.
SIDE_ALIGNMENT = 0.95


def is_ladder(flags):
    """Whether a face's surface flags make it climbable."""
    return bool(flags & LADDER) and not flags & SKY


def side_of(normal, yaw):
    """(side name, alignment) of a CoD-space face normal against a box turned by `yaw`.

    The normal goes to engine space (x, z, -y) and into the box's frame, where
    the larger horizontal component names the side. The alignment is that
    component of the unit normal, so a tilted face scores low as well as a
    turned one.
    """
    lx, _, lz = to_box_frame((normal[0], normal[2], -normal[1]), yaw)
    if abs(lx) > abs(lz):
        return ("right" if lx > 0 else "left"), abs(lx)
    return ("back" if lz > 0 else "front"), abs(lz)


class Floors:
    """The walkable top faces of the map's world brushes, for a report on where ladders end.

    Brushes only: no soup, and no brush-model brushes, which would need placing.
    A brush's hull is built the first time a probe comes near it, since only the
    few around a ladder's top are ever asked about.
    """

    def __init__(self, brushes, skip):
        self.brushes = brushes
        self.boxes = [(index, box) for index, box in blocking_bounds(brushes) if index not in skip]
        self.hulls = {}

    def heights(self, x, z, low, high):
        """Heights of walkable brush faces over (x, z) between `low` and `high`, engine space."""
        out = []
        for index, (x0, x1, z0, z1, top) in self.boxes:
            if not (x0 <= x <= x1 and z0 <= z <= z1) or top < low:
                continue
            if index not in self.hulls:
                faces = hull_faces(self.brushes[index]) or ()
                self.hulls[index] = [f for f in faces if f.normal[2] >= SIDE_FACE]
            for face in self.hulls[index]:
                height = _height_on(face, x, z)
                if height is not None and low <= height <= high:
                    out.append(height)
        return out


def _height_on(face, x, z):
    """The height of a face's plane over (x, z), or None when (x, z) is outside its footprint."""
    poly = face.polygon
    inside = False
    for k, (ax, _, az) in enumerate(poly):
        bx, _, bz = poly[k - 1]
        if (az > z) != (bz > z) and x < ax + (z - az) * (bx - ax) / (bz - az):
            inside = not inside
    if not inside:
        return None
    # Engine normal (nx, nz, -ny) of a CoD normal (nx, ny, nz); nz >= SIDE_FACE, so never zero.
    ex, ey, ez = face.normal[0], face.normal[2], -face.normal[1]
    px, py, pz = poly[0]
    return py - (ex * (x - px) + ez * (z - pz)) / ey


def landing_sides(centre, size, yaw, floors):
    """The sides across a ladder's thin axis with a walkable surface level with its top.

    Probes a few points just outside each of the two sides for a brush face
    within `LANDING_REACH` of the top. `floors` is a `Floors`. Read the answer
    as a report on the export: soup is not read.
    """
    thin = 2 if size[2] <= size[0] else 0
    wide = 2 - thin
    top = centre[1] + size[1] / 2
    c, s = math.cos(yaw), math.sin(yaw)
    found = []
    for name, (axis, sign) in SIDES.items():
        if axis != thin:
            continue
        hit = False
        for out in (2, 8, 14):
            for across in (-0.25, 0.0, 0.25):
                local = [0.0, 0.0, 0.0]
                local[thin] = sign * (size[thin] / 2 + out / UNITS_PER_M)
                local[wide] = across * size[wide]
                # Out of the box's frame (rotateY by +yaw).
                x = centre[0] + local[0] * c + local[2] * s
                z = centre[2] - local[0] * s + local[2] * c
                if floors.heights(x, z, top - LANDING_REACH, top + LANDING_REACH):
                    hit = True
                    break
            if hit:
                break
        if hit:
            found.append(name)
    return found


def read_ladders(manifest_path, placements):
    """Every ladder in one clipmap dump, as boxes, plus a report on them.

    `placements` is `brushmodels.preflight`'s. Returns (ladders, stats). A ladder
    is `{at, size, yaw, face, landing}` — `at`/`size` in engine metres, `yaw` in
    degrees, `face` a side name or None, `landing` the sides a top-level surface
    was found on.
    """
    manifest = read_json(manifest_path)
    game = manifest["_game"]
    materials = manifest.get("materials", [])
    brushes = manifest.get("brushes", [])
    owners = brush_owners(manifest)

    stats = collections.Counter()
    found = []
    for index, brush in enumerate(brushes):
        flags = face_flags(brush, materials, game)
        stats["sky faces flagged as ladders (ignored)"] += sum(1 for f, _ in flags if f & LADDER and f & SKY)
        if not any(is_ladder(f) for f, _ in flags):
            continue
        faces = hull_faces(brush)
        if not any(is_ladder(flags[f.plane][0]) for f in faces or ()):
            # A plane the hull does not have is no face anyone can touch. 3 brushes in 157.
            stats["flagged only on planes the hull does not have (ignored)"] += 1
            continue
        stats["found"] += 1
        if index in owners:
            placement = placements.get(owners[index])
            if placement is None or not placement["solid"]:
                # collision.py leaves these out too: no wall, so nothing to climb.
                stats["skipped: owned by an unplaced or non-solid brush model"] += 1
                continue
            stats["placed by a brush model"] += 1
            faces = hull_faces(brush, placement)
        flagged = [f for f in faces if is_ladder(flags[f.plane][0])]
        found.append((index, faces, flagged))

    # Every ladder is itself a player-clip box, so none may count as another's landing.
    floors = Floors(brushes, skip={index for index, _, _ in found} | set(owners))
    ladders = []
    for _, faces, flagged in found:
        centre, size, yaw = fit_box(faces)
        stats["axial faces flagged"] += sum(1 for f in flagged if f.plane < 6)
        stats["faces flagged"] += len(flagged)

        sides = [f for f in flagged if abs(f.normal[2]) < SIDE_FACE]
        face = None
        if len(sides) == 1:
            face, alignment = side_of(sides[0].normal, yaw)
            stats["flagged on one side only, so `face` is written"] += 1
            if alignment < SIDE_ALIGNMENT:
                stats["that side is tilted or turned off the box; the box keeps its yaw only"] += 1
        elif len(sides) < 4:
            stats[f"flagged on {len(sides)} sides, so no `face`"] += 1

        landing = landing_sides(centre, size, yaw, floors)
        if len(landing) != 1:
            stats[f"landing on {len(landing)} sides, not 1 (brushes only; soup not read)"] += 1
        elif face and _opposite(face) != landing[0]:
            # The 7 one-sided brushes in the data all face away from their landing.
            stats["`face` does not point away from the landing"] += 1

        ladders.append(
            {
                # `+ 0.0` so a coordinate that rounds to zero is never written `-0.0`.
                "at": tuple(round(v, 3) + 0.0 for v in centre),
                "size": tuple(round(v, 3) for v in size),
                "yaw": round(math.degrees(yaw), 2),
                "face": face,
                "landing": landing,
            }
        )
    stats["exported"] = len(ladders)
    return ladders, stats


def _opposite(side):
    axis, sign = SIDES[side]
    return next(name for name, (a, s) in SIDES.items() if a == axis and s == -sign)


def report(ladders, stats):
    """Print what came out, the way the other export stages do."""
    ignored = stats["sky faces flagged as ladders (ignored)"]
    if not stats["found"]:
        print("ladders: none in this map" + (f" ({ignored} sky faces flagged as ladders, ignored)" if ignored else ""))
        return
    print(f"ladders: {stats['exported']:,} exported of {stats['found']:,} found")
    for key in sorted(k for k in stats if k not in ("found", "exported") and stats[k]):
        print(f"  {key}: {stats[key]:,}")
    if ladders:
        heights = sorted(v["size"][1] for v in ladders)
        print(f"  height: median {heights[len(heights) // 2]:.2f} m, max {heights[-1]:.2f} m")
