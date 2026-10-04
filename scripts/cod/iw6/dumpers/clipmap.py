"""`clipmap`: `<map>.clipmap.json` and the triangle soup's two blobs.

The map's own collision: the clip materials, the brushes (bounds, bevel sides and
the six axial faces' materials), the triangle soup with the partitions that index
it, the collision AABB tree, the submodels a brush model is placed from, and the
static-model and dynamic-entity lists that say which props the game collides
with. The schema is IW5's (docs/cod/pipeline.md#the-dump-tree), which
scripts/cod/collision.py, volumes.py, mantle.py, ladder.py and props.py read.

The structs are read out of the emulated loader's memory (scripts/cod/iw6/memory.py):
the clipmap has no Python walker, so the Durango loader placed it there.
"""

import struct

from ..memory import Struct
from . import GAME, dumper
from .common import asset_path, plain, write_json

HEADER = (
    ("planeCount", "info.planeCount"),
    ("numBrushSides", "info.numBrushSides"),
    ("numLeafBrushes", "info.numLeafBrushes"),
    ("numStaticModels", "numStaticModels"),
    ("numSubModels", "numSubModels"),
    ("vertCount", "vertCount"),
    ("triCount", "triCount"),
    ("partitionCount", "partitionCount"),
    ("borderCount", "borderCount"),
    ("checksum", "checksum"),
)


LEAF_FIELDS = ("brushContents", "terrainContents", "leafBrushNode", "firstCollAabbIndex", "collAabbCount")

#: Bytes per collision vertex (vec3_t) and per soup index (unsigned short), as
#: Load_clipMap_t reads them. collision.py unpacks the blobs with these.
VERT_STRIDE = 12
TRI_STRIDE = 2


def vec(record, path, n):
    return list(struct.unpack(f"<{n}f", record.bytes(path)))


def struct_bounds(record, path):
    raw = vec(record, path, 6)
    return {"midPoint": raw[:3], "halfSize": raw[3:]}


def cstring(emulator, address, limit=1024):
    """The NUL-terminated string at `address` in the loader's memory; None for a null pointer."""
    if not address:
        return None
    out = bytearray()
    while len(out) < limit:
        chunk = emulator.read(address + len(out), 64)
        end = chunk.find(b"\0")
        if end >= 0:
            return bytes(out + chunk[:end]).decode("latin-1")
        out += chunk
    return bytes(out).decode("latin-1")


def check_plane_layout(layout):
    """A plane is read as four contiguous floats, which only holds for this layout."""
    normal, dist = layout.resolve("cplane_s", "normal"), layout.resolve("cplane_s", "dist")
    if normal[0] != 0 or normal[1] != 12 or dist[0] != 12 or dist[1] != 4:
        raise SystemExit(f"cplane_s is not normal[3] then dist (normal at {normal[:2]}, dist at {dist[:2]})")


def plane(emulator, address):
    """(normal x, normal y, normal z, dist) of the cplane_s at `address`; None for a null pointer.

    A zero normal is no plane at all. A brush's bevels are aliased into a plane
    array the zone streams long before the clipmap, so memory that cannot serve
    those bytes reads every one of them as zero — and a brush that keeps none of
    its bevels is exported as its own bounding box, which looks placed and is not.
    """
    if not address:
        return None
    face = struct.unpack("<4f", emulator.read(address, 16))
    if face[0] == 0.0 and face[1] == 0.0 and face[2] == 0.0:
        raise SystemExit(f"the cplane_s at {address:#x} has a zero normal: its plane array never reached memory")
    return face


def clip_info(clip, world, pointer):
    """(the ClipInfo a `pointer` field names, whether it is the map's own).

    Load_clipMap_t fixes the map's `pInfo` to `&cm.info` — the *game's* global
    `clipMap_t`, not this asset — and every stock submodel's `info` aliases that
    same slot. So a pointer equal to `pInfo` means "the map's own ClipInfo";
    reading a ClipInfo there instead would find an empty one and report a
    submodel with no brushes at all.
    """
    if not pointer or pointer in (world.address, clip["pInfo"]):
        return world, True
    return Struct(clip.emulator, "ClipInfo", pointer), False


def materials(info):
    """ClipInfo.materials: what a brush side or axial face is made of (`surfaceFlags`) and stops (`contents`).

    Flags and contents stay raw; their bit meanings are decoded downstream
    (scripts/cod/collision.py, docs/cod/reference.md#collision).
    """
    return [
        {
            "name": cstring(info.emulator, m["name"]) or "",
            "surfaceFlags": m["surfaceFlags"],
            "contents": m["contents"],
        }
        for m in info.array("materials", "ClipMaterial", info["numMaterials"])
    ]


def brushes(info):
    """ClipInfo.brushes: one convex volume each, as the intersection of its half-spaces.

    The six axis-aligned faces are implicit in `bounds` and are not side records,
    so `axialMaterialNum` is the only material they have ([0] the min faces, [1]
    the max, each x y z). `sides` holds the bevels.
    """
    emulator, layout = info.emulator, info.layout
    count = info["numBrushes"]
    # x64-zt declares `numBrushes` as `unsigned short`; a map with more brushes
    # than that would dump silently short, so the padding after it is checked
    # rather than trusted.
    at, width, _, _ = layout.resolve("ClipInfo", "numBrushes")
    pad = emulator.read(info.address + at + width, layout.resolve("ClipInfo", "brushes")[0] - at - width)
    if count and any(pad):
        raise SystemExit(f"ClipInfo.numBrushes ({count}) is followed by {pad.hex()}, so it is wider than 16 bits")
    if not count or not info["brushes"]:
        return []

    side_size = layout.size("cbrushside_t")
    contents = struct.unpack(f"<{count}i", info.data("brushContents", 4 * count)) if info["brushContents"] else None
    bounds = info.data("brushBounds", 24 * count) if info["brushBounds"] else None

    out = []
    for index, brush in enumerate(info.array("brushes", "cbrush_t", count)):
        numsides = brush["numsides"]
        axial = struct.unpack("<6H", brush.bytes("axialMaterialNum"))
        entry = {"numsides": numsides, "axialMaterialNum": [list(axial[:3]), list(axial[3:])]}
        if contents is not None:
            entry["contents"] = contents[index]
        if bounds is not None:
            raw = struct.unpack_from("<6f", bounds, 24 * index)
            entry["bounds"] = {"midPoint": list(raw[:3]), "halfSize": list(raw[3:])}

        sides = []
        base = brush["sides"]
        for s in range(numsides if base else 0):
            side = Struct(emulator, "cbrushside_t", base + side_size * s)
            jside = {"materialNum": side["materialNum"]}
            face = plane(emulator, side["plane"])
            if face:
                jside["normal"] = list(face[:3])
                jside["dist"] = face[3]
            sides.append(jside)
        entry["sides"] = sides
        out.append(entry)
    return out


def partitions(clip):
    """CollisionPartition: a run of soup triangles, and the vertex segment its 16-bit indices sit in.

    `triIndices` is `unsigned short`, so it cannot address a map with more than
    65,536 collision vertices on its own; `firstVertSegment` is the high part, in
    steps of collision.VERT_SEGMENT.
    """
    return [
        {key: part[key] for key in ("triCount", "borderCount", "firstVertSegment", "firstTri")}
        for part in clip.array("partitions", "CollisionPartition", clip["partitionCount"])
    ]


def aabb_trees(clip):
    """CollisionAabbTree, flat: each leaf links a soup partition to a material, which is its contents."""
    out = []
    for node in clip.array("aabbTrees", "CollisionAabbTree", clip["aabbTreeCount"]):
        children = node["childCount"]
        entry = {"materialIndex": node["materialIndex"], "childCount": children}
        entry["firstChild" if children else "partition"] = node["u.firstChildIndex" if children else "u.partitionIndex"]
        out.append(entry)
    return out


def leaf_brushes(info, root):
    """Every brush a leaf-brush-node tree holds.

    A node with a positive count is a leaf. Any other node splits, its children
    `childOffset` nodes further on; a negative count also makes the next node a
    leaf of the brushes that straddle the split."""
    count, base = info["leafbrushNodesCount"], info["leafbrushNodes"]
    size = info.layout.size("cLeafBrushNode_s")
    owned, visited, pending = set(), set(), [root]
    while pending:
        index = pending.pop()
        if index >= count or index in visited:
            continue
        visited.add(index)
        node = Struct(info.emulator, "cLeafBrushNode_s", base + size * index)
        n = node["leafBrushCount"]
        if n > 0:
            data = node.data("data.leaf.brushes", 2 * n)
            if data:
                owned.update(struct.unpack(f"<{n}H", data))
            continue
        if n < 0:
            pending.append(index + 1)
        pending.extend(index + offset for offset in (node[f"data.children.childOffset[{k}]"] for k in (0, 1)) if offset)
    return owned


def aabb_partitions(clip, first, roots):
    """The collision partitions under `roots` AABB-tree nodes from `first` (CollectAabbPartitions)."""
    count, base = clip["aabbTreeCount"], clip["aabbTrees"]
    size = clip.layout.size("CollisionAabbTree")
    found = set()
    pending = [(first + r, 0) for r in range(roots)]
    while pending:
        index, depth = pending.pop()
        if not 0 <= index < count or depth > 64:
            continue
        node = Struct(clip.emulator, "CollisionAabbTree", base + size * index)
        children = node["childCount"]
        if not children:
            partition = node["u.partitionIndex"]
            if 0 <= partition < clip["partitionCount"]:
                found.add(partition)
            continue
        pending.extend((node["u.firstChildIndex"] + i, depth + 1) for i in range(children))
    return found


def submodels(clip):
    """cmodels[N]: the collision half of brush model N, in its placer's space."""
    info = clip.field("info", "ClipInfo")
    out = []
    for model in clip.array("cmodels", "cmodel_t", clip["numSubModels"]):
        leaf = model.field("leaf", "cLeaf_t")
        own, shared = clip_info(clip, info, model["info"])
        owned = set()
        if leaf["brushContents"] and shared and own["leafbrushNodes"]:
            owned = leaf_brushes(own, leaf["leafBrushNode"])
        parts = set()
        if clip["aabbTrees"]:
            parts = aabb_partitions(clip, leaf["firstCollAabbIndex"], leaf["collAabbCount"])
        entry = {
            "bounds": struct_bounds(model, "bounds"),
            "radius": model["radius"],
            **{key: leaf[key] for key in LEAF_FIELDS},
            "brushes": sorted(owned),
            "partitions": sorted(parts),
        }
        if not shared:
            entry["foreignClipInfo"] = True
        out.append(entry)
    return out


def static_models(clip):
    """staticModelList: the props the world collides with, placed (CreateJsonStaticModels)."""
    out = []
    for m in clip.array("staticModelList", "cStaticModel_s", clip["numStaticModels"]):
        raw = vec(m, "invScaledAxis", 9)
        entry = {"origin": vec(m, "origin", 3), "absBounds": struct_bounds(m, "absBounds")}
        model = m.asset("xmodel")
        if model and model[1]:
            entry["model"] = plain(model[1])
        entry["invScaledAxis"] = [raw[0:3], raw[3:6], raw[6:9]]
        out.append(entry)
    return out


def dynamic_entities(clip):
    """dynEnts[list][i]; `brushModel`, when set, is the brush model the pose places."""
    lists = []
    for k in (0, 1):
        entries = []
        for d in clip.array(f"dynEntDefList[{k}]", "DynEntityDef", clip[f"dynEntCount[{k}]"]):
            entry = {
                "type": d["type"],
                "contents": d["contents"],
                "health": d["health"],
                "origin": vec(d, "pose.origin", 3),
                "quat": vec(d, "pose.quat", 4),
            }
            model = d.asset("baseModel")
            if model and model[1]:
                entry["model"] = plain(model[1])
            for key in ("brushModel", "physicsBrushModel"):
                if d[key]:
                    entry[key] = d[key]
            entries.append(entry)
        lists.append(entries)
    return lists


def soup(clip, out, name, data):
    """Write the soup blobs beside the manifest and name them in it, as OAT's dumper does."""
    vert_count, tri_count = clip["vertCount"], clip["triCount"]
    if clip["verts"] and vert_count > 0:
        write_blob(asset_path(out, f"{name}.clipmap_verts.bin"), clip.data("verts", VERT_STRIDE * vert_count))
        data["vertFile"] = f"{name}.clipmap_verts.bin"
        data["vertStride"] = VERT_STRIDE
    if clip["triIndices"] and tri_count > 0:
        write_blob(asset_path(out, f"{name}.clipmap_tris.bin"), clip.data("triIndices", TRI_STRIDE * 3 * tri_count))
        data["triFile"] = f"{name}.clipmap_tris.bin"
        data["triStride"] = TRI_STRIDE
    if clip["triEdgeIsWalkable"] and tri_count > 0:
        # One bit per triangle edge, rounded up to whole 4-byte words (Load_clipMap_t).
        size = (tri_count * 3 + 31) >> 3 & ~3
        write_blob(asset_path(out, f"{name}.clipmap_edgewalkable.bin"), clip.data("triEdgeIsWalkable", size))
        data["edgeWalkableFile"] = f"{name}.clipmap_edgewalkable.bin"


def write_blob(path, data):
    with open(path, "wb") as fh:
        fh.write(data)


@dumper("clipmap")
def write(walked, out):
    for name, loaded in walked.zone.found.get("CLIPMAP", {}).items():
        clip = Struct.of(walked.zone, loaded)
        check_plane_layout(clip.layout)
        info = clip.field("info", "ClipInfo")
        data = {"_game": GAME, "_type": "clipmap", "_version": 1, "name": name}
        data.update((key, clip[path]) for key, path in HEADER)
        data["dynEntCount"] = [clip["dynEntCount[0]"], clip["dynEntCount[1]"]]
        soup(clip, out, name, data)
        data["materials"] = materials(info)
        data["brushes"] = brushes(info)
        data["partitions"] = partitions(clip)
        data["aabbTrees"] = aabb_trees(clip)
        data["cmodels"] = submodels(clip)
        data["staticModels"] = static_models(clip)
        data["dynEnts"] = dynamic_entities(clip)
        write_json(asset_path(out, f"{name}.clipmap.json"), data)
