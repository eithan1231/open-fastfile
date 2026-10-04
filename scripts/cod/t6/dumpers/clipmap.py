"""`clipmap`: T6's `<map>.clipmap.json` and the soup's four blobs, in T5's schema.

T6's clipMap_t is T5's records inside IW5's shape. The brush tables sit in an
embedded ClipInfo (`clipMap_t.info`; `pInfo` is a runtime pointer the zone leaves
null, and a submodel's `info` is null too, meaning the map's), and every record in
them is T5's: a brush carries its own corners and contents, a side its `cflags` and
`sflags` (no material), the six axial faces `axial_cflags`/`axial_sflags`, and the
soup's partitions a `fuind`/`nuinds` window into `uinds` (which is in the ClipInfo).
So the manifest is T5's (t5/dumpers/clipmap.py) and collision.py reads it as it
reads Black Ops' (`collision.FACE_FLAG_GAMES`). What differs from T5 besides:

- a clip material names itself through a pointer, not an inline `char[64]`;
- a partition has no `borderCount`, and there are no borders;
- a brush's `contents` and bounds are on the brush (`brushContents` and
  `brushBounds` in the ClipInfo are null).

mp_la's soup has 18,207 vertices, so its 16-bit indices address it globally, as
T5's do; collision.py refuses one past 65,536.
"""

from ...iw5.dumpers import clipmap as iw
from ...iw5.dumpers.common import vec3, vec4
from ...iw6.dumpers.common import asset_path, write_json
from ...t5.dumpers import clipmap as t5


def clip_info(clip):
    """The ClipInfo the brush tables are in: `pInfo` where the zone set it, else the embedded `info`."""
    return clip["pInfo"] or clip["info"]


def materials(info):
    return [
        {"name": m["name"] or "", "surfaceFlags": m["surfaceFlags"], "contents": m["contentFlags"]}
        for m in list(info["materials"] or ())[: info["numMaterials"]]
    ]


def partitions(clip):
    return [
        {"triCount": part["triCount"] & 0xFF, "firstTri": part["firstTri"], "nuinds": part["nuinds"], "fuind": part["fuind"]}
        for part in list(clip["partitions"] or ())[: clip["partitionCount"]]
    ]


def submodels(clip, info):
    """cmodels[N]: the collision half of brush model N, in its placer's space (iw5 `submodels`).
    A submodel whose `info` is another ClipInfo would index other brush tables; none does."""
    out = []
    for n, model in enumerate(list(clip["cmodels"] or ())[: clip["numSubModels"]]):
        own = model["info"]
        if own is not None and own.address != info.address:
            raise SystemExit(f"cmodels[{n}] has a ClipInfo of its own, which this writer cannot place")
        leaf = model["leaf"]
        owned = set()
        if leaf["brushContents"] and info["leafbrushNodes"] is not None:
            owned = iw.leaf_brushes(info, leaf["leafBrushNode"])
        parts = set()
        if clip["aabbTrees"] is not None:
            parts = iw.aabb_partitions(clip, leaf["firstCollAabbIndex"], leaf["collAabbCount"])
        out.append(
            {
                "bounds": t5.mid_half(model.unpack("<3f", "mins"), model.unpack("<3f", "maxs")),
                "radius": model["radius"],
                **{key: leaf[key] for key in iw.LEAF_FIELDS},
                "brushes": sorted(owned),
                "partitions": sorted(parts),
            }
        )
    return out


def static_models(clip):
    """t5 `static_models`, reading T6's vec3_t (a struct, not a float[3]) as its floats."""
    out = []
    for m in list(clip["staticModelList"] or ())[: clip["numStaticModels"]]:
        axis = m.unpack("<9f", "invScaledAxis")
        entry = {
            "origin": vec3(m.unpack("<3f", "origin")),
            "absBounds": t5.mid_half(m.unpack("<3f", "absmin"), m.unpack("<3f", "absmax")),
        }
        model = m["xmodel"]
        if model is not None and model.name:
            entry["model"] = model.name
        entry["invScaledAxis"] = [list(axis[0:3]), list(axis[3:6]), list(axis[6:9])]
        out.append(entry)
    return out


def dynamic_entities(clip):
    """t5 `dynamic_entities`: the first two of the four counts index `dynEntDefList`."""
    lists = []
    for k in (0, 1):
        entries = []
        for d in list(clip[f"dynEntDefList[{k}]"] or ())[: clip["dynEntCount"][k]]:
            entry = {
                "type": d["type"],
                "contents": d["contents"],
                "health": d["health"],
                "origin": vec3(d.unpack("<3f", "pose.origin")),
                "quat": vec4(d.unpack("<4f", "pose.quat")),
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


def soup(clip, info, out, name, data):
    """Vertices, triangles, the `uinds` gather list and the edge-walkable bits (t5 `soup`)."""
    blobs = (
        (clip["verts"], "vertFile", "clipmap_verts", clip["vertCount"], "vertStride"),
        (clip["triIndices"], "triFile", "clipmap_tris", clip["triCount"], "triStride"),
        (info["uinds"], "uindFile", "clipmap_uinds", info["nuinds"], "uindStride"),
        (clip["triEdgeIsWalkable"], "edgeWalkableFile", "clipmap_edgewalkable", clip["triCount"], None),
    )
    for array, key, suffix, count, stride in blobs:
        if array is None or count <= 0:
            continue
        filename = f"{name}.{suffix}.bin"
        with open(asset_path(out, filename), "wb") as fh:
            fh.write(array.bytes())
        data[key] = filename
        if stride:
            data[stride] = array.elem


def manifest(walk, asset, out):
    clip = asset.record
    info = clip_info(clip)
    data = {"_game": walk.game, "_type": "clipmap", "_version": 1, "name": asset.name}
    for key in ("planeCount", "numBrushSides", "numLeafBrushes"):
        data[key] = info[key]
    data["numStaticModels"] = clip["numStaticModels"]
    data["dynEntCount"] = list(clip["dynEntCount"][:2])
    data["numSubModels"] = clip["numSubModels"]
    for key in ("numBrushes", "numBrushVerts"):
        data[key] = info[key]
    for key in ("vertCount", "triCount", "partitionCount"):
        data[key] = clip[key]
    data["nuinds"] = info["nuinds"]
    data["aabbTreeCount"] = clip["aabbTreeCount"]
    data["checksum"] = clip["checksum"]
    soup(clip, info, out, asset.name, data)
    data["materials"] = materials(info)
    data["brushes"] = t5.brushes(walk, info)
    data["partitions"] = partitions(clip)
    data["aabbTrees"] = iw.aabb_trees(clip)
    data["cmodels"] = submodels(clip, info)
    data["staticModels"] = static_models(clip)
    data["dynEnts"] = dynamic_entities(clip)
    return data


def write(walk, out, ctx=None):
    iw.check_plane_layout(walk.program)
    for asset in walk.by_type("clipmap"):
        write_json(asset_path(out, f"{asset.name}.clipmap.json"), manifest(walk, asset, out))
