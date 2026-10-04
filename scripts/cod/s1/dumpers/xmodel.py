"""`xmodel`: `xmodel/<name>.json` and `model_export/<name>_lod<N>.glb`, in IW6's schema with `_game: "s1"`.

IW6's writer (scripts/cod/iw6/dumpers/xmodel.py) is shared where the struct is:
S1's model vertex is IW6's 32-byte GfxPackedVertex -- float xyz, half-float UVs,
10:10:10 normals -- and the skeleton and skinning arrays are IW6's. What is
forked is the per-LOD loop, for the game key and for the two checks below, which
are the independent evidence that the vertices decode (README.md#the-models):

- `unknown0`, S1's own per-vertex array, repeats each vertex's float position.
  A decode that moved the position would stop agreeing with it.
- A model's LOD 0 lies inside the `XModel.bounds` the zone records, and nearly
  every model's reaches them exactly. The exception is a moving part: a ceiling
  fan's bounds hold its blades' sweep (`me_fanceil1`, `mp_comeback`).

`XSurface.quantizeScale` is the X360 build's: its `GfxQuantized*Vertex` is 24
bytes of int16 positions. The PC zones never write that kind, and
`XModel.quantization` is 0 on every model they hold.
"""

import math
import struct
from dataclasses import dataclass

from ... import xmodel_glb as glb
from ...animations import ZERO_TAG_POSITIONS
from ...iw6.dumpers.common import asset_path, plain, write_json
from ...iw6.dumpers.xmodel import (
    STILL,
    SURF_FLAG_MOTION,
    SURF_FLAG_NO_COLOUR,
    Stats,
    has_default_armature,
    is_skinned,
    lod_file,
    model_json,
    model_type,
    surface_weights,
)
from ...iw6.skeleton import local_poses, skeleton
from ...iw6.vertices import model_vertices
from ...iw6.zone import Record
from ...materials import is_flag_technique
from . import GAME, dumper
from .material import summaries

BOUNDS_SLACK = 0.01  # inches; every model on the 14 maps but one fan agrees to 1e-3
SHORT_OF_BOUNDS = 0.05  # the share of models whose LOD 0 may fall short of their bounds
POSITION = 12  # bytes of float xyz at the start of both a packed vertex and an unknown0 entry


def positions_disagree(data, surface):
    """How many of a surface's vertices have a position unknown0 does not repeat."""
    if surface.positions is None or surface.vertices is None:
        return 0
    v, p = surface.vertices, surface.positions
    return sum(
        data[v + 32 * k : v + 32 * k + POSITION] != data[p + 16 * k : p + 16 * k + POSITION] for k in range(surface.vertex_count)
    )


def recorded_bounds(header):
    """XModel.bounds (a midpoint and a half size) as (mins, maxs)."""
    raw = struct.unpack("<6f", header.bytes("bounds"))
    return [m - h for m, h in zip(raw[:3], raw[3:], strict=True)], [m + h for m, h in zip(raw[:3], raw[3:], strict=True)]


def against_bounds(lod, header):
    """(how far a LOD's vertices poke outside the recorded bounds, how far short of them they stop)."""
    mins, maxs = recorded_bounds(header)
    low = [min(p[a] for p in lod.positions) for a in range(3)]
    high = [max(p[a] for p in lod.positions) for a in range(3)]
    outside = max(max(mins[a] - low[a], high[a] - maxs[a]) for a in range(3))
    short = max(max(low[a] - mins[a], maxs[a] - high[a]) for a in range(3))
    return outside, short


def zero_tag_positions(data, model, bones):
    """Whether a model stores zeros for every tagPosition while its bind pose (baseMat) is
    not all at its parents' origins: the view arms. A clip's translation keys are then
    absolute on it (animations.ZERO_TAG_POSITIONS). No model in either companion zone
    has some of its tagPositions zero and others not, bar bones that lie on their parent."""
    poses = local_poses(data, model)
    if not bones or not poses or any(any(t) for _, t in poses):
        return False
    roots = model.root_bone_count
    return any(math.dist(bones[roots + i].offset, bones[bones[roots + i].parent].offset) > 1e-3 for i in range(len(poses)))


@dataclass
class Detached:
    """One surface's geometry, decoded while its zone is walked, for a model in a later one."""

    flags: int
    subdivided: bool
    vertices: list  # (position, normal, uv, rgba) per vertex
    triangles: tuple  # flat, local to the surface
    weights: list  # surface_weights'
    disagree: int  # positions_disagree's


def detach(data, surfs):
    """A zone's XModelSurfs as [Detached], or None when it cannot be: a skinned surface's
    weights need the model's own skeleton, and no borrowed LOD has needed one."""
    if any(s.vertices is None or s.triangles is None or is_skinned(s) for s in surfs.surfaces):
        return None
    return [
        Detached(
            s.flags,
            s.subdivided,
            list(model_vertices(data, s.vertices, s.vertex_count)),
            struct.unpack_from(f"<{3 * s.triangle_count}H", data, s.triangles),
            surface_weights(data, s, Stats()),
            positions_disagree(data, s),
        )
        for s in surfs.surfaces
    ]


def geometry(data, surface):
    """The Detached form of a surface this zone holds, read in place."""
    if isinstance(surface, Detached):
        return surface
    return Detached(
        surface.flags,
        surface.subdivided,
        model_vertices(data, surface.vertices, surface.vertex_count),
        struct.unpack_from(f"<{3 * surface.triangle_count}H", data, surface.triangles),
        None,
        positions_disagree(data, surface),
    )


def lod_data(zone, model, name, index, surfs, bones, weighted, library, stats):
    """xmodel_glb.ModelLodData for one LOD, or None when its geometry is not in this zone.
    `surfs` is an XModelSurfs of this zone, or a [Detached] another zone left in the library."""
    info = model.lods[index]
    lod = glb.ModelLodData(f"{name}_lod{index}")
    distinct = {}
    for material in model.materials:
        key = plain(material) or ""
        if key not in distinct:
            distinct[key] = len(lod.materials)
            known = library.get(key)
            lod.materials.append(glb.ModelMaterial(key, known and known.colour_map, known and known.normal_map))
    if weighted:
        lod.weights = []
    data = zone.data
    surfaces = surfs if isinstance(surfs, list) else surfs.surfaces
    for i, surface in enumerate(surfaces):
        if not isinstance(surface, Detached) and (surface.vertices is None or surface.triangles is None):
            stats["lod with unread vertices"] += 1
            return None
        read = geometry(data, surface)
        stats["positions unknown0 disagrees with"] += read.disagree
        material = plain(model.materials[info.surface_index + i]) or ""
        stats["subdivided"] += read.subdivided
        still = bool(read.flags & (SURF_FLAG_MOTION | SURF_FLAG_NO_COLOUR))
        flag = material in library and is_flag_technique(library[material].technique_set, GAME)
        if still and flag:
            stats["still"] += 1
        first = len(lod.positions)
        for position, normal, uv, rgba in read.vertices:
            lod.positions.append(position)
            lod.normals.append(normal)
            lod.uvs.append(uv)
            lod.colours.append((STILL if flag else glb.WHITE) if still else tuple(c / 255.0 for c in rgba))
        flat = read.triangles
        lod.surfaces.append(glb.Surface(distinct[material], first, [flat[k : k + 3] for k in range(0, len(flat), 3)]))
        if weighted:
            lod.weights.extend(read.weights if read.weights is not None else surface_weights(data, surface, stats))
    lod.bones = bones
    if weighted and not any(lod.weights):
        lod.weights = None
    return lod


@dumper("xmodel")
def write(walked, out):
    zone = walked.zone
    library = summaries(walked)
    found = zone.found.get("XMODEL", {})
    all_surfs = zone.found.get("XMODEL_SURFS", {})
    composites = zone.found.get("XMODEL_COMPOSITE", {})
    # A model can name another zone's LOD geometry: mp_prison's `_burn` and `mv/` debris
    # borrow common_mp.ff's. Backend.walk lists what the zones walked so far want, and
    # the zone holding it leaves it here for the dump that follows.
    shared = walked.library if walked.library is not None else {}
    borrowed = shared.setdefault("surfs", {})
    for surfs_name in shared.get("wanted surfs", ()):
        if surfs_name not in borrowed and surfs_name in all_surfs:
            borrowed[surfs_name] = detach(zone.data, all_surfs[surfs_name])
    stats = Stats()
    off_bounds, short_of_bounds, measured = [], [], 0
    for name, model in sorted(found.items()):
        if name.startswith(",") or model.at is None:
            stats["stubs"] += 1
            continue
        header = Record(zone, "XModel", model.at, None, None)
        lods = [all_surfs.get(info.surfs) if info.surfs and not info.surfs.startswith(",") else None for info in model.lods]
        lods = lods[: header["numLods"]]
        geometries = [
            surfs or (borrowed.get(info.surfs[1:]) if info.surfs and info.surfs.startswith(",") else None)
            for surfs, info in zip(lods, model.lods, strict=False)
        ]
        bones = [] if has_default_armature(zone.data, model, lods) else skeleton(zone.data, model, zone.script_strings)
        kind = model_type(zone.data, model, lods)
        stats["skinned without a skeleton"] += kind != "rigid" and not bones
        record = {**model_json(zone, model, kind, bool(bones)), "_game": GAME}
        if zero_tag_positions(zone.data, model, bones):
            record[ZERO_TAG_POSITIONS] = True
            stats["with zero tagPositions"] += 1
        # A composite has no geometry: its parts, each another zone's model, are
        # the gun (scripts/cod/composite.py).
        if parts := [plain(p) for p in composites.get(name, ()) if p]:
            record["compositeModels"] = parts
        write_json(asset_path(out, f"xmodel/{name}.json"), record)
        stats["models"] += 1
        for index, surfs in enumerate(geometries):
            if not (surfs if isinstance(surfs, list) else surfs and surfs.surfaces):
                stats["lod without surfaces"] += 1
                continue
            stats["borrowed"] += isinstance(surfs, list)
            lod = lod_data(zone, model, name, index, surfs, bones, bool(bones), library, stats)
            if lod is None:
                continue
            if index == 0 and lod.positions:
                outside, short = against_bounds(lod, header)
                measured += 1
                if outside > BOUNDS_SLACK:
                    off_bounds.append(name)
                elif short > BOUNDS_SLACK:
                    short_of_bounds.append(name)
            glb.write(asset_path(out, lod_file(name, index)), lod)
            stats["glbs"] += 1
    print(
        f"      {stats.line(len(found))}"
        + (f"; {stats['borrowed']} LODs from another zone's geometry" if stats["borrowed"] else "")
        + (f"; {n} with zero tagPositions" if (n := stats["with zero tagPositions"]) else "")
    )
    if short_of_bounds:
        names = ", ".join(short_of_bounds[:6])
        print(f"      {len(short_of_bounds)} models' LOD 0 inside XModel.bounds but short of them (moving parts): {names}")
    # Each is a vertex decode that has drifted -- moved, or scaled -- and would still pack and render.
    if stats["positions unknown0 disagrees with"]:
        raise SystemExit(f"{stats['positions unknown0 disagrees with']} model vertices disagree with XSurface.unknown0")
    if off_bounds:
        raise SystemExit(f"{len(off_bounds)} models' LOD 0 leaves XModel.bounds: {', '.join(off_bounds[:6])}")
    if len(short_of_bounds) > SHORT_OF_BOUNDS * measured:
        raise SystemExit(f"{len(short_of_bounds)} of {measured} models' LOD 0 falls short of XModel.bounds")
