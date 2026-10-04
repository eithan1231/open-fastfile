"""`xmodel`: `xmodel/<name>.json` and `model_export/<name>_lod<N>.glb`, as OpenAssetTools'
`--model-format GLB` writes them (scripts/cod/xmodel_glb.py has the GLB layout).

The JSON carries what pack.py, props.py, viewmodel.py and characters.py read:
the LOD files and their distances, `collLod`, `contents`, the physics preset
and collmap, `rootBoneName`, and `type` (rigid, animated or viewhands), which
OAT infers from the skinning data.

Three per-game rules live here, because only this backend meets them
(reverse/iw6-zone/README.md#skeletons-and-skinning):

- A reactive-motion surface keeps a piece index where the colour would be, and a
  `VERTCOL_NONE` one keeps no colour at all. Both are written white. Neither
  holds a flag-wind weight, so on a flag material their alpha is 0: still,
  rather than waving at full strength.
- Up to eight bones weigh a vertex; the GLB keeps the four heaviest.
- Subdivision data is not decoded; the base cage is written as it is.

A model named with a leading comma is another zone's, and is not written.
"""

import struct
from collections import Counter

from ... import xmodel_glb as glb
from ...materials import is_flag_technique
from ..records import Model
from ..skeleton import blend_weights, check_blend_table, rigid_weights, skeleton, strongest
from ..vertices import model_vertices
from ..zone import Record
from . import GAME, dumper
from .common import asset_path, plain, write_json
from .material import summaries

SCHEMA = "http://openassettools.dev/schema/xmodel.v1.json"
FOLDER = "model_export"
DEFAULT_ROOT_BONE = ""  # OAT xmodel::DEFAULT_XMODEL_ROOT_BONE_NAME

SURF_FLAG_NO_COLOUR = 0x2  # x64-zt SURF_FLAG_VERTCOL_NONE
SURF_FLAG_MOTION = 0x8  # SURF_FLAG_REACTIVE_MOTION: GfxPackedMotionVertex
STILL = (1.0, 1.0, 1.0, 0.0)


def lod_file(name, lod):
    return f"{FOLDER}/{name}_lod{lod}.glb"


def is_skinned(surface):
    return any(surface.blend_counts)


def has_default_armature(data, model, lods):
    """One bone, and every surface one rigid list over all of it (OAT HasDefaultArmatureForLod):
    OAT then writes no skeleton, only the bone's name."""
    if model.bone_count != 1 or model.root_bone_count != 1:
        return False
    for surfs in lods:
        for s in surfs.surfaces if surfs else ():
            if s.rigid_list_count != 1 or is_skinned(s) or s.rigid_lists is None:
                return False
            offset, vertices, first_tri, triangles = struct.unpack_from("<4H", data, s.rigid_lists)
            if (offset, first_tri, vertices, triangles) != (0, 0, s.vertex_count, s.triangle_count):
                return False
    return True


def model_type(data, model, lods):
    """OAT GetType: rigid unless some surface is skinned; viewhands when, besides, every local
    translation is zero and some bone's bounds are not centred on it."""
    if not any(is_skinned(s) for surfs in lods if surfs for s in surfs.surfaces):
        return "rigid"
    children = model.bone_count - model.root_bone_count
    nulled = model.tag_positions is None or not any(struct.unpack_from(f"<{3 * children}f", data, model.tag_positions))
    offset = model.bone_info is not None and any(
        any(struct.unpack_from("<3f", data, model.bone_info + 28 * i)) for i in range(model.bone_count)
    )
    return "viewhands" if nulled and offset else "animated"


class Stats(Counter):
    """What the dump did, for its one line in the log."""

    def line(self, found):
        parts = [f"{self['models']} of {found} models written ({self['glbs']} LOD files)"]
        for key, label in (
            ("stubs", "other zones' stubs skipped"),
            ("lod without surfaces", "LODs with no surfaces in this zone"),
            ("lod with unread vertices", "LODs with unread vertices"),
            ("subdivided", "subdivision surfaces written as their cage"),
            ("capped", "vertices with more than four bones capped"),
            ("still", "surfaces with no wind weight on a flag material"),
            ("table mismatches", "blended vertices disagreeing with blendVertsTable"),
            ("skinned without a skeleton", "skinned models whose bones were not read"),
        ):
            if self[key]:
                parts.append(f"{self[key]} {label}")
        return "; ".join(parts)


def lod_data(zone, model, name, index, surfs, bones, weighted, library, stats):
    """xmodel_glb.ModelLodData for one LOD, or None when its geometry is not in this zone."""
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
    for i, surface in enumerate(surfs.surfaces):
        if surface.vertices is None or surface.triangles is None:
            stats["lod with unread vertices"] += 1
            return None
        material = plain(model.materials[info.surface_index + i]) or ""
        stats["subdivided"] += surface.subdivided
        still = bool(surface.flags & (SURF_FLAG_MOTION | SURF_FLAG_NO_COLOUR))
        flag = material in library and is_flag_technique(library[material].technique_set, GAME)
        if still and flag:
            stats["still"] += 1
        first = len(lod.positions)
        for position, normal, uv, rgba in model_vertices(data, surface.vertices, surface.vertex_count):
            lod.positions.append(position)
            lod.normals.append(normal)
            lod.uvs.append(uv)
            lod.colours.append((STILL if flag else glb.WHITE) if still else tuple(c / 255.0 for c in rgba))
        flat = struct.unpack_from(f"<{3 * surface.triangle_count}H", data, surface.triangles)
        triangles = [flat[k : k + 3] for k in range(0, len(flat), 3)]
        lod.surfaces.append(glb.Surface(distinct[material], first, triangles))
        if weighted:
            lod.weights.extend(surface_weights(data, surface, stats))
    lod.bones = bones
    if weighted and not any(lod.weights):
        lod.weights = None
    return lod


def surface_weights(data, surface, stats):
    """[(bone, weight)] per vertex of one surface, as OAT orders them: rigid lists, then blends, then none."""
    out = []
    if surface.rigid_lists is not None:
        for bone, count in rigid_weights(data, surface.rigid_lists, surface.rigid_list_count):
            out.extend([[(bone, 1.0)]] * count)
    if is_skinned(surface) and surface.blend_verts is not None:
        blended = blend_weights(data, surface.blend_verts, surface.blend_counts)
        if surface.blend_table is not None:
            stats["table mismatches"] += check_blend_table(data, surface.blend_table, blended)
        for influences in blended:
            stats["capped"] += len(influences) > glb.MAX_INFLUENCES
            out.append(strongest(influences, glb.MAX_INFLUENCES))
    out.extend([[]] * (surface.vertex_count - len(out)))
    return out


def model_json(zone, model: Model, kind, bones_written):
    header = Record(zone, "XModel", model.at, None, None)
    data = {"$schema": SCHEMA, "_game": GAME, "_type": "xmodel", "_version": 2}
    if header["collLod"] >= 0:
        data["collLod"] = header["collLod"]
    if header["contents"]:
        data["contents"] = header["contents"]
    data["flags"] = header["flags"]
    data["lods"] = [{"distance": header[f"lodInfo[{i}].dist"], "file": lod_file(model.name, i)} for i in range(header["numLods"])]
    if model.phys_collmap:
        data["physCollmap"] = plain(model.phys_collmap)
    if model.phys_preset:
        data["physPreset"] = plain(model.phys_preset)
    bones = [] if bones_written else skeleton(zone.data, model, zone.script_strings)
    if bones and bones[0].name != DEFAULT_ROOT_BONE:
        data["rootBoneName"] = bones[0].name
    data["type"] = kind
    return data


@dumper("xmodel")
def write(walked, out):
    zone = walked.zone
    library = summaries(walked)
    found = zone.found.get("XMODEL", {})
    all_surfs = zone.found.get("XMODEL_SURFS", {})
    stats = Stats()
    for name, model in sorted(found.items()):
        if name.startswith(",") or model.at is None:
            stats["stubs"] += 1
            continue
        header = Record(zone, "XModel", model.at, None, None)
        lods = [all_surfs.get(info.surfs) if info.surfs and not info.surfs.startswith(",") else None for info in model.lods]
        lods = lods[: header["numLods"]]  # the walk keeps every LOD up to numLods, so index i is lodInfo[i]
        bones = [] if has_default_armature(zone.data, model, lods) else skeleton(zone.data, model, zone.script_strings)
        kind = model_type(zone.data, model, lods)
        # Skinned surfaces and no skeleton to bind them to. The GLB would carry
        # meshes and no joints, which packs and renders and can never be posed —
        # so it is counted rather than left to be noticed in game.
        stats["skinned without a skeleton"] += kind != "rigid" and not bones
        write_json(asset_path(out, f"xmodel/{name}.json"), model_json(zone, model, kind, bool(bones)))
        stats["models"] += 1
        for index, surfs in enumerate(lods):
            if surfs is None or not surfs.surfaces:
                stats["lod without surfaces"] += 1
                continue
            lod = lod_data(zone, model, name, index, surfs, bones, bool(bones), library, stats)
            if lod is not None:
                glb.write(asset_path(out, lod_file(name, index)), lod)
                stats["glbs"] += 1
    print(f"      {stats.line(len(found))}")
    if stats["table mismatches"]:
        print("      !! the blend-weight stream and blendVertsTable disagree: scripts/cod/iw6/skeleton.py misreads one")
    if stats["skinned without a skeleton"]:
        print("      !! a skinned model came out with no joints: no clip can pose it (scripts/cod/iw6/walkers.py `shared`)")
