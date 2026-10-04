"""`clipmap`: T5's `<map>.clipmap.json` and the soup's four blobs.

The dump tree's T5 schema, which scripts/cod/collision.py,
volumes.py, mantle.py, ladder.py and props.py read with IW's. T5's clipMap_t is
flat like IW4's, and differs in what a record holds:

- a material names itself inline (`char[64]`) and calls its contents `contentFlags`;
- a brush carries its own corners and contents, and a side its own `cflags` and
  `sflags` rather than a `materialNum`, so a T5 side is `{contents, surfaceFlags}`;
- the six axial faces keep flags, not a material: `axialContents` and
  `axialSurfaceFlags`, [0] the min faces and [1] the max, each x y z;
- a partition has no `firstVertSegment` (T5's maps stay under 65,536 collision
  vertices) but a window `fuind`/`nuinds` into `uinds`, written as a fourth blob;
- a submodel's, static model's and brush's boxes are corners, written as
  `midPoint`/`halfSize` in single precision, as OAT's float arithmetic leaves them.

Leaf brushes and a submodel's partitions are resolved exactly as on IW
(iw5/dumpers/clipmap.py). The AABB tree's leaves carry the soup's contents: each
names a partition and a material, the only link between the two.
"""

from ...iw5.dumpers import clipmap as iw
from ...iw5.dumpers.common import f32, vec3, vec4
from ...iw6.dumpers.common import asset_path, write_json


def mid_half(mins, maxs):
    """Corners as the midpoint and half size OAT computes from them in float."""
    return {
        "midPoint": vec3([f32(f32(a + b) * 0.5) for a, b in zip(mins, maxs, strict=True)]),
        "halfSize": vec3([f32(f32(b - a) * 0.5) for a, b in zip(mins, maxs, strict=True)]),
    }


def materials(clip):
    out = []
    for m in list(clip["materials"] or ())[: clip["numMaterials"]]:
        name = bytes(m.bytes("material")).split(b"\0", 1)[0].decode("latin-1")
        out.append({"name": name, "surfaceFlags": m["surfaceFlags"], "contents": m["contentFlags"]})
    return out


def brushes(walk, clip):
    array = clip["brushes"]
    if array is None:
        return []
    count = clip["numBrushes"]
    if len(array) < count:
        raise SystemExit(f"clipMap_t.numBrushes is {count}, but {len(array)} brushes were loaded")
    out = []
    for brush in array[:count]:
        numsides = brush["numsides"]
        entry = {
            "numsides": numsides,
            "contents": brush["contents"],
            "bounds": mid_half(brush.unpack("<3f", "mins"), brush.unpack("<3f", "maxs")),
        }
        sides = []
        first = brush["sides"]
        if first is not None and numsides:
            for side in walk.span(first, numsides):
                jside = {"contents": side["cflags"], "surfaceFlags": side["sflags"]}
                plane = side["plane"]
                if plane is not None:
                    face = plane.unpack("<4f")
                    jside["normal"] = list(face[:3])
                    jside["dist"] = face[3]
                sides.append(jside)
        entry["sides"] = sides
        for key, member in (("axialContents", "axial_cflags"), ("axialSurfaceFlags", "axial_sflags")):
            flags = brush[member]
            entry[key] = [list(flags[:3]), list(flags[3:])]
        out.append(entry)
    return out


def partitions(clip):
    return [
        {
            "triCount": part["triCount"] & 0xFF,
            "borderCount": part["borderCount"] & 0xFF,
            "firstTri": part["firstTri"],
            "nuinds": part["nuinds"],
            "fuind": part["fuind"],
        }
        for part in list(clip["partitions"] or ())[: clip["partitionCount"]]
    ]


def submodels(clip):
    """cmodels[N]: the collision half of brush model N, in its placer's space (iw5 `submodels`)."""
    out = []
    for model in list(clip["cmodels"] or ())[: clip["numSubModels"]]:
        leaf = model["leaf"]
        owned = set()
        if leaf["brushContents"] and clip["leafbrushNodes"] is not None:
            owned = iw.leaf_brushes(clip, leaf["leafBrushNode"])
        parts = set()
        if clip["aabbTrees"] is not None:
            parts = iw.aabb_partitions(clip, leaf["firstCollAabbIndex"], leaf["collAabbCount"])
        out.append(
            {
                "bounds": mid_half(model.unpack("<3f", "mins"), model.unpack("<3f", "maxs")),
                "radius": model["radius"],
                **{key: leaf[key] for key in iw.LEAF_FIELDS},
                "brushes": sorted(owned),
                "partitions": sorted(parts),
            }
        )
    return out


def static_models(clip):
    out = []
    for m in list(clip["staticModelList"] or ())[: clip["numStaticModels"]]:
        axis = m["invScaledAxis"]
        entry = {"origin": vec3(m["origin"]), "absBounds": mid_half(m["absmin"], m["absmax"])}
        model = m["xmodel"]
        if model is not None and model.name:
            entry["model"] = model.name
        entry["invScaledAxis"] = [list(axis[0:3]), list(axis[3:6]), list(axis[6:9])]
        out.append(entry)
    return out


def dynamic_entities(clip):
    """Only the first two of T5's four counts index `dynEntDefList` (the rest count client
    and collision entries against the same lists)."""
    lists = []
    for k in (0, 1):
        entries = []
        for d in list(clip[f"dynEntDefList[{k}]"] or ())[: clip["dynEntCount"][k]]:
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
    """The soup's blobs: vertices, triangles, the `uinds` gather list, and the edge-walkable bits
    (a bit per edge in whole words; OAT's blob runs on for `triCount` bytes, which equiv allows)."""
    blobs = (
        ("verts", "vertFile", "clipmap_verts", clip["vertCount"], "vertStride"),
        ("triIndices", "triFile", "clipmap_tris", clip["triCount"], "triStride"),
        ("uinds", "uindFile", "clipmap_uinds", clip["nuinds"], "uindStride"),
        ("triEdgeIsWalkable", "edgeWalkableFile", "clipmap_edgewalkable", clip["triCount"], None),
    )
    for member, key, suffix, count, stride in blobs:
        array = clip[member]
        if array is None or count <= 0:
            continue
        filename = f"{name}.{suffix}.bin"
        with open(asset_path(out, filename), "wb") as fh:
            fh.write(array.bytes())
        data[key] = filename
        if stride:
            data[stride] = 2 if member != "verts" else array.elem


def manifest(walk, asset, out):
    clip = asset.record
    data = {"_game": walk.game, "_type": "clipmap", "_version": 1, "name": asset.name}
    for key in ("planeCount", "numBrushSides", "numLeafBrushes", "numStaticModels"):
        data[key] = clip[key]
    data["dynEntCount"] = list(clip["dynEntCount"][:2])
    for key in ("numSubModels", "numBrushes", "numBrushVerts", "vertCount", "triCount", "partitionCount"):
        data[key] = clip[key]
    for key in ("borderCount", "nuinds", "aabbTreeCount", "checksum"):
        data[key] = clip[key]
    soup(clip, out, asset.name, data)
    data["materials"] = materials(clip)
    data["brushes"] = brushes(walk, clip)
    data["partitions"] = partitions(clip)
    data["aabbTrees"] = iw.aabb_trees(clip)
    data["cmodels"] = submodels(clip)
    data["staticModels"] = static_models(clip)
    data["dynEnts"] = dynamic_entities(clip)
    return data


def write(walk, out, ctx=None):
    iw.check_plane_layout(walk.program)
    for asset in walk.by_type("clipmap"):  # both of IW4's and T5's types: OAT registers them as one
        write_json(asset_path(out, f"{asset.name}.clipmap.json"), manifest(walk, asset, out))
