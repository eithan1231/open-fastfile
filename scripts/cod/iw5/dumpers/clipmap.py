"""`clipmap`: `<map>.clipmap.json` and the triangle soup's three blobs.

The map's own collision: the clip materials, the brushes (bounds, bevel sides and
the six axial faces' materials), the triangle soup with the partitions that index
it, the collision AABB tree, the submodels a brush model is placed from, and the
static-model and dynamic-entity lists that say which props the game collides
with. The schema is the dump tree's (docs/cod/pipeline.md#the-dump-tree),
which scripts/cod/collision.py, volumes.py, mantle.py, ladder.py and props.py
read; IW6's writer (scripts/cod/iw6/dumpers/clipmap.py) is the same thing over
emulated memory.

The brush tables are `pInfo`'s. The loader copies that ClipInfo out of TEMP
(ReallocClipInfo), and every stock submodel's `info` points at it. IW4 has no
ClipInfo: the same members, by the same names, sit flat on `clipMap_t`, and a
submodel has no `info`, so this writer is IW4's too. IW4's
single-player clipmap is another asset type over the same struct, and is written
the same way.
"""

from ...iw6.dumpers.common import asset_path, write_json
from . import dumper
from .common import mid_half, vec3, vec4

LEAF_FIELDS = ("brushContents", "terrainContents", "leafBrushNode", "firstCollAabbIndex", "collAabbCount")


def clip_info(clip):
    """The ClipInfo a clipMap_t's brush tables are in: IW5's `pInfo`, or IW4's clipMap_t itself."""
    return clip["pInfo"] if "pInfo" in clip else clip


def check_plane_layout(program):
    """A plane is read as four contiguous floats, which only holds for this layout."""
    plane = program.struct("cplane_s")
    normal, dist = plane.locate("normal"), plane.locate("dist")
    if normal[0] != 0 or dist[0] != 12:
        raise SystemExit(f"cplane_s is not normal[3] then dist (normal at {normal[0]}, dist at {dist[0]})")


def materials(info):
    """ClipInfo.materials: what a brush side or axial face is made of (`surfaceFlags`) and stops (`contents`).

    Flags and contents stay raw; their bit meanings are decoded downstream
    (scripts/cod/collision.py, docs/cod/reference.md#collision).
    """
    return [
        {"name": m["name"] or "", "surfaceFlags": m["surfaceFlags"], "contents": m["contents"]} for m in info["materials"] or ()
    ]


def brushes(walk, info):
    """ClipInfo.brushes: one convex volume each, as the intersection of its half-spaces.

    The six axis-aligned faces are implicit in `bounds` and are not side records,
    so `axialMaterialNum` is the only material they have ([0] the min faces, [1]
    the max, each x y z). `sides` holds the bevels: `cbrush_t.sides` points into
    `ClipInfo.brushsides`, `numsides` long.
    """
    array = info["brushes"]
    if array is None:
        return []
    count = info["numBrushes"]
    if len(array) != count:
        raise SystemExit(f"ClipInfo.numBrushes is {count}, but {len(array)} brushes were loaded")
    contents = info["brushContents"]
    contents = [c for (c,) in contents.unpack("<i")] if contents is not None else None
    bounds = info["brushBounds"]
    bounds = list(bounds.unpack("<6f")) if bounds is not None else None

    out = []
    for index, brush in enumerate(array):
        numsides = brush["numsides"]
        axial = brush["axialMaterialNum"]
        entry = {"numsides": numsides, "axialMaterialNum": [list(axial[:3]), list(axial[3:])]}
        if contents is not None:
            entry["contents"] = contents[index]
        if bounds is not None:
            entry["bounds"] = mid_half(bounds[index])
        sides = []
        first = brush["sides"]
        if first is not None and numsides:
            for side in walk.span(first, numsides):
                jside = {"materialNum": side["materialNum"]}
                plane = side["plane"]
                if plane is not None:
                    face = plane.unpack("<4f")
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
    steps of collision.VERT_SEGMENT. The three counts are bytes, which IW4's
    headers declare `char`: read unsigned, as the game and OAT's writer read them
    (a partition of 166 triangles is not one of -90).
    """
    return [
        {
            "triCount": part["triCount"] & 0xFF,
            "borderCount": part["borderCount"] & 0xFF,
            "firstVertSegment": part["firstVertSegment"] & 0xFF,
            "firstTri": part["firstTri"],
        }
        for part in clip["partitions"] or ()
    ]


def aabb_trees(clip):
    """CollisionAabbTree, flat: each leaf links a soup partition to a material, which is its contents."""
    out = []
    for node in clip["aabbTrees"] or ():
        children = node["childCount"]
        entry = {"materialIndex": node["materialIndex"], "childCount": children}
        if children:
            entry["firstChild"] = node["u.firstChildIndex"]
        else:
            entry["partition"] = node["u.partitionIndex"]
        out.append(entry)
    return out


def leaf_brushes(info, root):
    """Every brush a leaf-brush-node tree holds, from node `root`.

    A node with a positive count is a leaf. Any other node splits, its children
    `childOffset` nodes further on; a negative count also makes the next node a
    leaf of the brushes that straddle the split (docs/cod/reference.md)."""
    nodes = info["leafbrushNodes"]
    count = info["leafbrushNodesCount"]
    owned, visited, pending = set(), set(), [root]
    while pending:
        index = pending.pop()
        if not 0 <= index < count or index in visited:
            continue
        visited.add(index)
        node = nodes[index]
        n = node["leafBrushCount"]
        if n > 0:
            held = node["data.leaf.brushes"]
            if held is not None:
                owned.update(b for (b,) in held.view(0, n).unpack("<H"))
            continue
        if n < 0:
            pending.append(index + 1)
        pending.extend(index + offset for offset in node["data.children.childOffset"] if offset)
    return owned


def aabb_partitions(clip, first, roots):
    """The collision partitions under `roots` AABB-tree nodes from `first`."""
    nodes, count, parts = clip["aabbTrees"], clip["aabbTreeCount"], clip["partitionCount"]
    found = set()
    pending = [(first + r, 0) for r in range(roots)]
    while pending:
        index, depth = pending.pop()
        if not 0 <= index < count or depth > 64:
            continue
        node = nodes[index]
        children = node["childCount"]
        if not children:
            partition = node["u.partitionIndex"]
            if 0 <= partition < parts:
                found.add(partition)
            continue
        pending.extend((node["u.firstChildIndex"] + i, depth + 1) for i in range(children))
    return found


def _same(a, b):
    """Whether two loaded arrays are the same one (both null counts as the same)."""
    if a is None or b is None:
        return a is b
    return a.address == b.address


def submodels(clip, info):
    """cmodels[N]: the collision half of brush model N, in its placer's space.

    A submodel's brush indices mean the manifest's `brushes` only when its ClipInfo
    shares that table; one that does not gets none and `foreignClipInfo` (no stock
    map has one). A brushless submodel points `leafBrushNode` at 0, the world's
    first node, so the tree is walked only when `brushContents` is set.
    """
    out = []
    for model in clip["cmodels"] or ():
        own = (model["info"] if "info" in model else None) or info
        shared = _same(own["leafbrushNodes"], info["leafbrushNodes"]) and _same(own["brushes"], info["brushes"])
        leaf = model["leaf"]
        owned = set()
        if leaf["brushContents"] and shared and own["leafbrushNodes"] is not None:
            owned = leaf_brushes(own, leaf["leafBrushNode"])
        parts = set()
        if clip["aabbTrees"] is not None:
            parts = aabb_partitions(clip, leaf["firstCollAabbIndex"], leaf["collAabbCount"])
        entry = {
            "bounds": mid_half(model.unpack("<6f", "bounds")),
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
    """staticModelList: the props the world collides with, placed. `invScaledAxis` is the
    inverse of the placement's scaled rotation."""
    out = []
    for m in clip["staticModelList"] or ():
        axis = m["invScaledAxis"]
        entry = {"origin": vec3(m["origin"]), "absBounds": mid_half(m.unpack("<6f", "absBounds"))}
        model = m["xmodel"]
        if model is not None and model.name:
            entry["model"] = model.name
        entry["invScaledAxis"] = [list(axis[0:3]), list(axis[3:6]), list(axis[6:9])]
        out.append(entry)
    return out


def dynamic_entities(clip):
    """dynEntDefList[list][i]; `brushModel`, when set, is the brush model the pose places.

    Destructibles are not in staticModelList: they live in these two lists, with
    contents of their own. A brush model index of 0 (the world) means none."""
    lists = []
    for k in (0, 1):
        entries = []
        for d in clip[f"dynEntDefList[{k}]"] or ():
            entry = {
                "type": d["type"],
                "contents": d["contents"],
                "health": d["health"],
                "origin": vec3(d["pose.origin"]),
                "quat": vec4(d["pose.quat"]),
            }
            model = d["xModel"]
            if model is not None and model.name:
                entry["model"] = model.name
            for key in ("brushModel", "physicsBrushModel"):
                if d[key]:
                    entry[key] = d[key]
            entries.append(entry)
        lists.append(entries)
    return lists


def soup(clip, out, name, data):
    """Write the soup blobs beside the manifest and name them in it.

    `triEdgeIsWalkable` is one bit per triangle edge, rounded up to whole 4-byte
    words (the zone's own count); OAT's writer takes `triCount` bytes, so its
    blob runs on into the borders that follow (scripts/cod/equiv.py compares the
    bits only)."""
    blobs = (
        ("verts", "vertFile", "clipmap_verts", clip["vertCount"]),
        ("triIndices", "triFile", "clipmap_tris", clip["triCount"]),
        ("triEdgeIsWalkable", "edgeWalkableFile", "clipmap_edgewalkable", clip["triCount"]),
    )
    for member, key, suffix, count in blobs:
        array = clip[member]
        if array is None or count <= 0:
            continue
        filename = f"{name}.{suffix}.bin"
        with open(asset_path(out, filename), "wb") as fh:
            fh.write(array.bytes())
        data[key] = filename
        if member == "verts":
            data["vertStride"] = array.elem
        elif member == "triIndices":
            data["triStride"] = array.elem


def manifest(walk, asset, out):
    clip = asset.record
    info = clip_info(clip)
    data = {"_game": walk.game, "_type": "clipmap", "_version": 1, "name": asset.name}
    data.update((key, info[key]) for key in ("planeCount", "numBrushSides", "numLeafBrushes"))
    data.update((key, clip[key]) for key in ("numStaticModels", "numSubModels", "vertCount", "triCount"))
    data.update((key, clip[key]) for key in ("partitionCount", "borderCount", "checksum"))
    data["dynEntCount"] = list(clip["dynEntCount"])
    soup(clip, out, asset.name, data)
    data["materials"] = materials(info)
    data["brushes"] = brushes(walk, info)
    data["partitions"] = partitions(clip)
    data["aabbTrees"] = aabb_trees(clip)
    data["cmodels"] = submodels(clip, info)
    data["staticModels"] = static_models(clip)
    data["dynEnts"] = dynamic_entities(clip)
    return data


@dumper("clipmap")
def write(walk, out, ctx=None):
    check_plane_layout(walk.program)
    for asset in walk.by_type("clipmap"):  # both of IW4's and T5's types: OAT registers them as one
        data = manifest(walk, asset, out)
        write_json(asset_path(out, f"{asset.name}.clipmap.json"), data)
