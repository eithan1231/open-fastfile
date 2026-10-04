"""`clipmap`: `<map>.clipmap.json` and the triangle soup's three blobs.

The map's own collision, in IW5's schema (docs/cod/pipeline.md#the-dump-tree), which
scripts/cod/collision.py, volumes.py, mantle.py, ladder.py and props.py read.

Everything is read straight out of the zone, by file offset. IW6's writer reads
the emulated Durango loader's memory instead, because IW6 has no Python clipmap
walker; S1's console build is PowerPC and cannot be emulated, so the walk does
the whole job and records where each array landed (scripts/cod/s1/walkers.py,
`clip_info`).

Two things S1 spells differently and this translates back:

- **A brush side names a plane by index**, not by pointer, so a side's normal
  comes out of `ClipInfo.planes` -- which the clipmap does not own: it aliases
  the GfxWorld's (reverse/s1-zone/README.md#into-the-pipeline). Whether that is
  the right array is checked, because a brush that keeps no bevels exports as
  its own bounding box and looks placed.
- **A brush's `sides` is a reference into `brushSides`**, and the walk resolves
  it to a file offset. Turning that into an index is checked against the array's
  bounds and stride rather than assumed: a brush whose sides do not land on an
  element boundary means the two arrays are not the ones we think.
"""

import math
import struct

from ...iw6.dumpers.common import asset_path, plain, write_json
from ...iw6.zone import Record
from . import GAME, dumper

#: Bytes per collision vertex (vec3_t) and per soup index (unsigned short).
VERT_STRIDE = 12
TRI_STRIDE = 2

BRUSH_SIDE_STRIDE = 8  # cbrushside_t: planeIndex, materialNum, firstAdjacentSideOffset, edgeCount
PLANE_STRIDE = 20  # cplane_s: normal[3], dist, type, pad[3]

HEADER = (
    "planeCount",
    "numBrushSides",
    "numLeafBrushes",
    "numStaticModels",
    "numSubModels",
    "vertCount",
    "triCount",
    "partitionCount",
    "borderCount",
    "checksum",
)

LEAF_FIELDS = ("brushContents", "terrainContents", "leafBrushNode", "firstCollAabbIndex", "collAabbCount")


def _bounds(data, at):
    """A Bounds (midpoint then half size) at a file offset."""
    raw = struct.unpack_from("<6f", data, at)
    return {"midPoint": list(raw[:3]), "halfSize": list(raw[3:])}


def _array(zone, typename, at, count):
    """`count` records of `typename` at file offset `at`."""
    if at is None:
        return []
    size = zone.layout.size(typename)
    return [Record(zone, typename, at + size * i, None, None) for i in range(count)]


def materials(clip):
    """ClipInfo.materials: what a brush side or axial face is made of (`surfaceFlags`) and stops (`contents`).

    Flags and contents stay raw; their bit meanings are decoded downstream
    (scripts/cod/collision.py, docs/cod/reference.md#collision).
    """
    return [{"name": name or "", "surfaceFlags": flags, "contents": contents} for name, flags, contents in clip["materials"]]


def side_index(clip, at):
    """Which `brushSides` element a brush's resolved `sides` offset is, or None.

    A brush that names sides the array does not hold would silently export as its
    own bounding box, which looks placed and is not -- so this refuses rather
    than clamping.
    """
    base = clip["brushSides_at"]
    if at is None or base is None:
        return None
    delta = at - base
    if delta < 0 or delta % BRUSH_SIDE_STRIDE or delta // BRUSH_SIDE_STRIDE >= clip["numBrushSides"]:
        raise SystemExit(f"a brush's sides are at 0x{at:x}, which is not an element of the {clip['numBrushSides']} brushSides")
    return delta // BRUSH_SIDE_STRIDE


def plane(zone, clip, index):
    """(normal x, normal y, normal z, dist) of `ClipInfo.planes[index]`.

    Every plane is a unit normal -- worst `|n| - 1` over all fourteen MP maps is
    1.6e-07 -- and that is the only cheap evidence that the array the clipmap
    aliases is the array it means. Without it a brush keeps no bevels and is
    exported as its own bounding box, which looks placed and is not.
    """
    at = clip["planes_at"]
    if at is None:
        raise SystemExit("the clipmap's planes were neither written nor resolved, so no brush has a bevel")
    if not 0 <= index < clip["planeCount"]:
        raise SystemExit(f"a brush side names plane {index} of {clip['planeCount']}")
    face = struct.unpack_from("<4f", zone.data, at + PLANE_STRIDE * index)
    if abs(math.sqrt(face[0] ** 2 + face[1] ** 2 + face[2] ** 2) - 1.0) > 1e-3:
        raise SystemExit(f"cplane_s {index} is {face[:3]}, not a unit normal: the plane array is not where the walk put it")
    return face


def bevels_bound(index, bounds, sides):
    """Refuse a brush whose bevel puts its whole bounding box outside the half-space.

    A brush is the intersection of its planes, so such a brush is empty and cannot
    exist: the plane is one the array does not hold. It is the sharpest check there
    is that `ClipInfo.planes` -- which the clipmap aliases rather than owns -- is
    the array the game reads; a plane array off by one element trips it on 5% of
    mp_prison's 63,924 sides.
    """
    mid, half = bounds["midPoint"], bounds["halfSize"]
    for side in sides:
        n = side["normal"]
        centre = sum(n[a] * mid[a] for a in range(3)) - side["dist"]
        support = sum(abs(n[a]) * half[a] for a in range(3))
        if centre - support > 1e-3:
            raise SystemExit(
                f"brush {index}'s bevel {n} @ {side['dist']} misses its own bounds by "
                f"{centre - support:.3f} units: the plane array is not the one the clipmap aliases"
            )


def brushes(zone, clip):
    """ClipInfo.brushes: one convex volume each, as the intersection of its half-spaces.

    The six axis-aligned faces are implicit in `bounds` and are not side records,
    so `axialMaterialNum` is the only material they have ([0] the min faces, [1]
    the max, each x y z). `sides` holds the bevels.
    """
    count = clip["numBrushes"]
    if not count or clip["brushes_at"] is None:
        return []
    contents_at, bounds_at = clip["brushContents_at"], clip["brushBounds_at"]
    sides_at = clip["brushSides_at"]
    out = []
    for index, brush in enumerate(_array(zone, "cbrush_t", clip["brushes_at"], count)):
        numsides = brush["numsides"]
        axial = struct.unpack("<6H", brush.bytes("axialMaterialNum"))
        entry = {"numsides": numsides, "axialMaterialNum": [list(axial[:3]), list(axial[3:])]}
        if contents_at is not None:
            entry["contents"] = struct.unpack_from("<i", zone.data, contents_at + 4 * index)[0]
        if bounds_at is not None:
            entry["bounds"] = _bounds(zone.data, bounds_at + 24 * index)
        first = side_index(clip, clip["brush_sides"][index] if index < len(clip["brush_sides"]) else None)
        sides = []
        for s in range(numsides if first is not None and sides_at is not None else 0):
            at = sides_at + BRUSH_SIDE_STRIDE * (first + s)
            plane_index, material_num = struct.unpack_from("<iH", zone.data, at)
            face = plane(zone, clip, plane_index)
            sides.append({"materialNum": material_num, "normal": list(face[:3]), "dist": face[3]})
        entry["sides"] = sides
        if "bounds" in entry:
            bevels_bound(index, entry["bounds"], sides)
        out.append(entry)
    return out


def partitions(zone, clip):
    """CollisionPartition: a run of soup triangles, and the vertex segment its 16-bit indices sit in.

    `triIndices` is `unsigned short`, so it cannot address a map with more than
    65,536 collision vertices on its own; `firstVertSegment` is the high part, in
    steps of collision.VERT_SEGMENT.
    """
    return [
        {key: part[key] for key in ("triCount", "borderCount", "firstVertSegment", "firstTri")}
        for part in _array(zone, "CollisionPartition", clip["partitions_at"], clip["partitionCount"])
    ]


def aabb_trees(zone, clip):
    """CollisionAabbTree, flat: each leaf links a soup partition to a material, which is its contents."""
    out = []
    for node in _array(zone, "CollisionAabbTree", clip["aabbTrees_at"], clip["aabbTreeCount"]):
        children = node["childCount"]
        entry = {"materialIndex": node["materialIndex"], "childCount": children}
        entry["firstChild" if children else "partition"] = node["u.firstChildIndex" if children else "u.partitionIndex"]
        out.append(entry)
    return out


def leaf_brushes(zone, clip, root):
    """Every brush a leaf-brush-node tree holds.

    A node with a positive count is a leaf. Any other node splits, its children
    `childOffset` nodes further on; a negative count also makes the next node a
    leaf of the brushes that straddle the split."""
    count = clip["leafbrushNodesCount"]
    nodes = _array(zone, "cLeafBrushNode_s", clip["leafbrushNodes_at"], count)
    owned, visited, pending = set(), set(), [root]
    while pending:
        index = pending.pop()
        if not 0 <= index < len(nodes) or index in visited:
            continue
        visited.add(index)
        node = nodes[index]
        n = node["leafBrushCount"]
        if n > 0:
            at = clip["leafbrush_nodes"][index]
            if at is not None:
                owned.update(struct.unpack_from(f"<{n}H", zone.data, at))
            continue
        if n < 0:
            pending.append(index + 1)
        pending.extend(index + offset for offset in (node[f"data.children.childOffset[{k}]"] for k in (0, 1)) if offset)
    return owned


def aabb_partitions(zone, clip, first, roots):
    """The collision partitions under `roots` AABB-tree nodes from `first` (CollectAabbPartitions)."""
    nodes = _array(zone, "CollisionAabbTree", clip["aabbTrees_at"], clip["aabbTreeCount"])
    found = set()
    pending = [(first + r, 0) for r in range(roots)]
    while pending:
        index, depth = pending.pop()
        if not 0 <= index < len(nodes) or depth > 64:
            continue
        node = nodes[index]
        children = node["childCount"]
        if not children:
            partition = node["u.partitionIndex"]
            if 0 <= partition < clip["partitionCount"]:
                found.add(partition)
            continue
        pending.extend((node["u.firstChildIndex"] + i, depth + 1) for i in range(children))
    return found


def submodels(zone, clip):
    """cmodels[N]: the collision half of brush model N, in its placer's space.

    Every stock submodel shares the map's own ClipInfo -- S1 writes `pInfo` as a
    pointer slot the loader fills with `&cm.info` -- so a submodel's brushes and
    partitions are looked up in the map's arrays. `foreignClipInfo` is the walk
    saying one did not, which no map has yet done.
    """
    out = []
    models = _array(zone, "cmodel_t", clip["cmodels_at"], clip["numSubModels"])
    for index, model in enumerate(models):
        leaf_at = model.at + zone.layout.resolve("cmodel_t", "leaf")[0]
        leaf = _array(zone, "cLeaf_t", leaf_at, 1)[0]
        foreign = clip["foreignClipInfo"][index] if index < len(clip["foreignClipInfo"]) else False
        owned = set()
        if leaf["brushContents"] and not foreign and clip["leafbrushNodes_at"] is not None:
            owned = leaf_brushes(zone, clip, leaf["leafBrushNode"])
        parts = set()
        if clip["aabbTrees_at"] is not None:
            parts = aabb_partitions(zone, clip, leaf["firstCollAabbIndex"], leaf["collAabbCount"])
        entry = {
            "bounds": _bounds(zone.data, model.at),
            "radius": model["radius"],
            **{key: leaf[key] for key in LEAF_FIELDS},
            "brushes": sorted(owned),
            "partitions": sorted(parts),
        }
        if foreign:
            entry["foreignClipInfo"] = True
        out.append(entry)
    return out


def static_models(zone, clip):
    """staticModelList: the props the world collides with, placed (CreateJsonStaticModels)."""
    out = []
    names = clip["staticModels"]
    for index, m in enumerate(_array(zone, "cStaticModel_s", clip["staticModelList_at"], clip["numStaticModels"])):
        raw = struct.unpack("<9f", m.bytes("invScaledAxis"))
        entry = {
            "origin": list(struct.unpack("<3f", m.bytes("origin"))),
            "absBounds": _bounds(zone.data, m.at + zone.layout.resolve("cStaticModel_s", "absBounds")[0]),
        }
        if index < len(names) and names[index]:
            entry["model"] = plain(names[index])
        entry["invScaledAxis"] = [list(raw[0:3]), list(raw[3:6]), list(raw[6:9])]
        out.append(entry)
    return out


def dynamic_entities(zone, clip):
    """dynEnts[list][i]; `brushModel`, when set, is the brush model the pose places."""
    lists = []
    for k in (0, 1):
        entries = []
        names = clip["dynEntModels"][k]
        for index, d in enumerate(_array(zone, "DynEntityDef", clip["dynEntDefList_at"][k], clip["dynEntCount"][k])):
            entry = {
                "type": d["type"],
                "contents": d["contents"],
                "health": d["health"],
                "origin": list(struct.unpack("<3f", d.bytes("pose.origin"))),
                "quat": list(struct.unpack("<4f", d.bytes("pose.quat"))),
            }
            if index < len(names) and names[index]:
                entry["model"] = plain(names[index])
            for key in ("brushModel", "physicsBrushModel"):
                if d[key]:
                    entry[key] = d[key]
            entries.append(entry)
        lists.append(entries)
    return lists


def soup(zone, clip, out, name, data):
    """Write the soup blobs beside the manifest and name them in it, as OAT's dumper does."""
    vert_count, tri_count = clip["vertCount"], clip["triCount"]
    blobs = (
        ("verts_at", VERT_STRIDE * vert_count, "clipmap_verts", "vertFile", "vertStride", VERT_STRIDE, vert_count),
        ("triIndices_at", TRI_STRIDE * 3 * tri_count, "clipmap_tris", "triFile", "triStride", TRI_STRIDE, tri_count),
        # One bit per triangle edge, rounded up to whole 4-byte words (Load_clipMap_t).
        ("triEdgeIsWalkable_at", (tri_count * 3 + 31) >> 3 & ~3, "clipmap_edgewalkable", "edgeWalkableFile", None, 0, tri_count),
    )
    for key, size, suffix, file_key, stride_key, stride, count in blobs:
        at = clip[key]
        if at is None or count <= 0:
            continue
        with open(asset_path(out, f"{name}.{suffix}.bin"), "wb") as fh:
            fh.write(zone.data[at : at + size])
        data[file_key] = f"{name}.{suffix}.bin"
        if stride_key:
            data[stride_key] = stride


@dumper("clipmap")
def write(walked, out):
    zone = walked.zone
    for name, clip in zone.found.get("CLIPMAP", {}).items():
        data = {"_game": GAME, "_type": "clipmap", "_version": 1, "name": name}
        data.update((key, clip[key]) for key in HEADER)
        data["dynEntCount"] = list(clip["dynEntCount"])
        soup(zone, clip, out, name, data)
        data["materials"] = materials(clip)
        data["brushes"] = brushes(zone, clip)
        data["partitions"] = partitions(zone, clip)
        data["aabbTrees"] = aabb_trees(zone, clip)
        data["cmodels"] = submodels(zone, clip)
        data["staticModels"] = static_models(zone, clip)
        data["dynEnts"] = dynamic_entities(zone, clip)
        write_json(asset_path(out, f"{name}.clipmap.json"), data)
