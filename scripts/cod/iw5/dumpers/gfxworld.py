"""`gfxworld`: the world's surfaces, static models and brush models, plus its vertex and index arrays.

IW4's GfxWorld is IW5's with no reflection probe references, and every member read
here has the same name in both, so this writer is IW4's too (`_game` is the walk's).

The manifest is the dump tree's (docs/cod/pipeline.md#the-dump-tree), which
scripts/cod/shell.py, props.py and brushmodels.py read. A surface does not own
its geometry: triangle t of it is `indices[baseIndex + 3t + i] + firstVertex`
into the two blobs, which are the zone's arrays as they are.

`models[0]` is the world; `models[N]` is the render half of the entity whose
`model` key is `*N`, in that entity's space (docs/cod/pitfalls.md).
"""

from ...iw6.dumpers.common import asset_path, write_json
from . import dumper
from .common import corners, vec3

INDEX_STRIDE = 2  # r_index_t, a typedef the load program has no struct for


def surfaces(world):
    out = []
    array = world["dpvs.surfaces"]
    for surface in array or ():
        entry = {key: surface[f"tris.{key}"] for key in ("firstVertex", "vertexCount", "triCount", "baseIndex")}
        material = surface["material"]
        if material is not None and material.name:
            entry["material"] = material.name
        out.append(entry)
    return out


def static_models(world):
    out = []
    for inst in world["dpvs.smodelDrawInsts"] or ():
        axis = inst["placement.axis"]
        entry = {
            "origin": vec3(inst["placement.origin"]),
            "axis": [list(axis[0:3]), list(axis[3:6]), list(axis[6:9])],
            "scale": inst["placement.scale"],
        }
        model = inst["model"]
        if model is not None and model.name:
            entry["model"] = model.name
        out.append(entry)
    return out


def brush_models(world):
    return [
        {
            "surfaceCount": model["surfaceCount"],
            "startSurfIndex": model["startSurfIndex"],
            "bounds": corners(model.unpack("<6f", "bounds")),
        }
        for model in world["models"] or ()
    ]


def manifest(asset, vertex_stride, index_stride, game):
    world = asset.record
    data = {
        "_type": "gfxworld",
        "_version": 1,
        "_game": game,
        "name": asset.name,
    }
    if world["baseName"]:
        data["baseName"] = world["baseName"]
    data.update(
        checksum=world["checksum"],
        bounds=corners(world.unpack("<6f", "bounds")),
        vertexCount=world["draw.vertexCount"],
        vertexStride=vertex_stride,
        vertexFile=f"{asset.name}.gfxworld_vertices.bin",
        indexCount=world["draw.indexCount"],
        indexStride=index_stride,
        indexFile=f"{asset.name}.gfxworld_indices.bin",
        surfaceCount=world["surfaceCount"],
        staticModelCount=world["dpvs.smodelCount"],
        surfaces=surfaces(world),
        staticModels=static_models(world),
        staticSurfaceCount=world["dpvs.staticSurfaceCount"],
        modelCount=world["modelCount"],
        models=brush_models(world),
    )
    return data


@dumper("gfxworld")
def write(walk, out, ctx=None):
    worlds = walk.by_type("gfxworld")
    if not worlds:
        raise SystemExit(f"{walk.path} holds no GfxWorld")
    for asset in worlds:
        world = asset.record
        vertices, indices = world["draw.vd.vertices"], world["draw.indices"]
        data = manifest(asset, walk.program.struct("GfxWorldVertex").size, INDEX_STRIDE, walk.game)
        _check_counts(asset.name, data, vertices, indices)
        write_json(asset_path(out, f"{asset.name}.gfxworld.json"), data)
        for filename, array in ((data["vertexFile"], vertices), (data["indexFile"], indices)):
            if array is not None and len(array):
                with open(asset_path(out, filename), "wb") as fh:
                    fh.write(array.bytes())


def _check_counts(name, data, vertices, indices):
    """The arrays are the lengths the header says: a manifest naming more than its blob holds reads past it."""
    found = {
        "vertexCount": len(vertices or ()),
        "indexCount": len(indices or ()),
        "surfaceCount": len(data["surfaces"]),
        "staticModelCount": len(data["staticModels"]),
        "modelCount": len(data["models"]),
    }
    wrong = [f"{key} {data[key]} but {n} loaded" for key, n in found.items() if n != data[key]]
    if wrong:
        raise SystemExit(f"{name}: {'; '.join(wrong)}")
