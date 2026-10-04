"""`gfxworld`: the world's surfaces, static models and brush models, plus its vertex and index arrays.

The schema is IW5's (docs/cod/pipeline.md#the-dump-tree),
which scripts/cod/shell.py, props.py and brushmodels.py read.
"""

import struct

from ..vertices import WORLD_VERTEX
from ..zone import Record
from . import GAME, dumper
from .common import asset_path, bounds, write_json

INDEX_STRIDE = 2  # r_index_t


def _bounds(record, path):
    raw = struct.unpack("<6f", record.bytes(path))
    return bounds(raw[:3], raw[3:])


def surfaces(world):
    out = []
    for surface, material in zip(world.surfaces, world.materials, strict=True):
        entry = {name: surface[f"tris.{name}"] for name in ("firstVertex", "vertexCount", "triCount", "baseIndex")}
        if material and material[1]:
            entry["material"] = material[1]
        # Which lightmap page the surface's lightmap UVs address. OpenAssetTools'
        # dumper writes no such field, because IW4/IW5 maps ship one page; a
        # Ghosts map can ship two, and the export stacks them (scripts/cod/lightmap.py).
        # 31 is "none", which is what every unlit surface carries.
        entry["lightmapIndex"] = surface["laf.fields.lightmapIndex"]
        out.append(entry)
    return out


def static_models(world):
    out = []
    for p in world.placements:
        entry = {"origin": list(p.origin), "axis": [list(row) for row in p.axis], "scale": p.scale}
        if p.model:
            entry["model"] = p.model
        out.append(entry)
    return out


def brush_models(zone, world):
    """GfxWorld.models: models[0] is the world; each later one is placed by an entity ("*N")."""
    size = zone.layout.size("GfxBrushModel")
    out = []
    for i in range(world.header["modelCount"]):
        model = Record(zone, "GfxBrushModel", world.models + size * i, None, None)
        out.append(
            {"surfaceCount": model["surfaceCount"], "startSurfIndex": model["startSurfIndex"], "bounds": _bounds(model, "bounds")}
        )
    return out


def manifest(zone, world):
    w = world.header
    return {
        "_type": "gfxworld",
        "_version": 1,
        "_game": GAME,
        "name": world.name,
        "baseName": world.base_name,
        "checksum": w["checksum"],
        "bounds": _bounds(w, "bounds"),
        "vertexCount": w["draw.vertexCount"],
        "vertexStride": WORLD_VERTEX.size,
        "vertexFile": f"{world.name}.gfxworld_vertices.bin",
        "indexCount": w["draw.indexCount"],
        "indexStride": INDEX_STRIDE,
        "indexFile": f"{world.name}.gfxworld_indices.bin",
        "surfaceCount": w["surfaceCount"],
        "staticModelCount": w["dpvs.smodelCount"],
        "surfaces": surfaces(world),
        "staticModels": static_models(world),
        "staticSurfaceCount": w["dpvs.staticSurfaceCount"],
        "modelCount": w["modelCount"],
        "models": brush_models(zone, world),
    }


@dumper("gfxworld")
def write(walked, out):
    zone, world = walked.zone, walked.world
    if world is None:
        raise SystemExit(f"{walked.path} holds no GfxWorld")
    data = manifest(zone, world)
    write_json(asset_path(out, f"{world.name}.gfxworld.json"), data)
    blobs = (
        (data["vertexFile"], world.vertices, data["vertexCount"] * WORLD_VERTEX.size),
        (data["indexFile"], world.indices, data["indexCount"] * INDEX_STRIDE),
    )
    for filename, at, size in blobs:
        with open(asset_path(out, filename), "wb") as fh:
            fh.write(zone.data[at : at + size])
