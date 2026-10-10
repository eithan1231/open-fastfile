"""`gfxworld`: T5's world surfaces, static models, brush models and lightmaps, plus the two blobs.

The manifest is IW5's (iw5/dumpers/gfxworld.py)
plus what T5 carries beyond it: each surface's `lightmapIndex` and `flags`, the
three lightmap pages per entry (`primary`, `secondary`, `secondaryB`), the
dpvs surface ranges with `sortedSurfIndex`, and the third blob: `vld`, a
generated (layered) material's extra layers, which each surface finds by its
byte offset `vertexLayerData` (docs/cod/reference.md#layered-materials), and
`sun`, `sunParse.sunSettings`, in T6's shape (t6/dumpers/gfxworld.py) so that
t5/lightmap.py hands the world's sun over as T6's does, and `primaryLights`, which
are the ComWorld's (scripts/cod/lights.py). T5 stores the world's
and each brush model's bounds as corners, where IW4/IW5 store a midpoint and a
half size.
"""

import struct

from ...iw5.dumpers import gfxworld as iw5
from ...iw5.dumpers.common import vec3
from ...iw6.dumpers.common import asset_path, write_json

RANGES = ("litSurfsBegin", "litSurfsEnd", "decalSurfsBegin", "decalSurfsEnd", "emissiveSurfsBegin", "emissiveSurfsEnd")


def corners(record, path):
    """A `float[2][3]` (or two `float[3]` members) as {mins, maxs}."""
    raw = record.unpack("<6f", path) if path else record.unpack("<3f", "mins") + record.unpack("<3f", "maxs")
    return {"mins": vec3(raw[:3]), "maxs": vec3(raw[3:])}


# GfxWorldSunColor, at sunParse + 72: control, angles, then five RGBA colours and the exposure.
SUN_COLOR = struct.Struct("<I3f4f4f4f4f4ff")


def sun(world):
    """`sunParse.sunSettings`: angles (pitch, yaw, roll), `sunCd` (the diffuse colour and its
    strength, which the lit shaders' `sunDiffuse` is), and the rest as it stands."""
    values = SUN_COLOR.unpack_from(bytes(world.bytes("sunParse")), 72)
    out = {"angles": list(values[1:4])}
    for k, name in enumerate(("ambientColor", "sunCd", "sunCs", "skyColor", "groundColor")):
        out[name] = list(values[4 + 4 * k : 8 + 4 * k])
    out["exposure"] = values[24]
    return out


# ComPrimaryLight.type: what a light entity's `pl#` indexes, in the map's ComWorld.
LIGHT_TYPES = {1: "sun", 2: "spot", 3: "omni"}


def primary_lights(walk):
    """ComWorld's primary lights, by index: what each light entity was compiled to.

    Read beside the GfxWorld because a light entity says only what the designer
    set: its `fov_outer` is not the cone the game draws, and it aims at a target
    the map compiler strips. `dir` points back toward the light, as IW's does.
    """
    worlds = walk.by_type("comworld")
    if not worlds:
        return []
    record = worlds[0].record
    out = []
    for light in list(record["primaryLights"] or ())[: record["primaryLightCount"]]:
        out.append(
            {
                "type": LIGHT_TYPES.get(light["type"], light["type"]),
                "origin": vec3(light.unpack("<3f", "origin")),
                "dir": vec3(light.unpack("<3f", "dir")),
                "color": vec3(light.unpack("<3f", "color")),
                "radius": light["radius"],
                "cosHalfFovOuter": light["cosHalfFovOuter"],
                "cosHalfFovInner": light["cosHalfFovInner"],
            }
        )
    return out


def surfaces(world):
    out = []
    for surface in list(world["dpvs.surfaces"] or ())[: world["surfaceCount"]]:
        entry = {key: surface[f"tris.{key}"] for key in ("firstVertex", "vertexCount", "triCount", "baseIndex")}
        material = surface["material"]
        if material is not None and material.name:
            entry["material"] = material.name
        entry["vertexLayerData"] = surface["tris.vertexLayerData"]
        entry["lightmapIndex"] = surface["lightmapIndex"]
        entry["flags"] = surface["flags"]
        out.append(entry)
    return out


def lightmaps(world):
    out = []
    for entry in list(world["draw.lightmaps"] or ())[: world["draw.lightmapCount"]]:
        pages = {}
        for key in ("primary", "secondary", "secondaryB"):
            image = entry[key]
            if image is not None and image.name:
                pages[key] = image.name
        out.append(pages)
    return out


def brush_models(world):
    return [
        {
            "surfaceCount": model["surfaceCount"],
            "startSurfIndex": model["startSurfIndex"] - (1 << 32)
            if model["startSurfIndex"] >= 1 << 31
            else model["startSurfIndex"],
            "bounds": corners(model, "bounds"),
        }
        for model in list(world["models"] or ())[: world["modelCount"]]
    ]


def manifest(asset, vertex_stride):
    world = asset.record
    data = {"_type": "gfxworld", "_version": 1, "_game": "t5", "name": asset.name}
    if world["baseName"]:
        data["baseName"] = world["baseName"]
    static = world["dpvs.staticSurfaceCount"]
    sorted_index = world["dpvs.sortedSurfIndex"]
    data.update(
        checksum=world["checksum"],
        bounds=corners(world, None),
        vertexCount=world["draw.vertexCount"],
        vertexStride=vertex_stride,
        vertexFile=f"{asset.name}.gfxworld_vertices.bin",
        indexCount=world["draw.indexCount"],
        indexStride=iw5.INDEX_STRIDE,
        indexFile=f"{asset.name}.gfxworld_indices.bin",
        layerDataSize=world["draw.vertexLayerDataSize"],
        layerFile=f"{asset.name}.gfxworld_layers.bin",
        surfaceCount=world["surfaceCount"],
        staticModelCount=world["dpvs.smodelCount"],
        surfaces=surfaces(world),
        staticModels=iw5.static_models(world),
        lightmaps=lightmaps(world),
        staticSurfaceCount=static,
        **{key: world[f"dpvs.{key}"] for key in RANGES},
        sortedSurfIndex=[v for (v,) in sorted_index.view(0, static).unpack("<H")] if sorted_index is not None else [],
        sun=sun(world),
        modelCount=world["modelCount"],
        models=brush_models(world),
    )
    return data


def write(walk, out, ctx=None):
    worlds = walk.by_type("gfxworld")
    if not worlds:
        raise SystemExit(f"{walk.path} holds no GfxWorld")
    for asset in worlds:
        world = asset.record
        vertices, indices = world["draw.vd.vertices"], world["draw.indices"]
        data = manifest(asset, walk.program.struct("GfxWorldVertex").size)
        data["primaryLights"] = primary_lights(walk)
        iw5._check_counts(asset.name, data, vertices, indices)
        write_json(asset_path(out, f"{asset.name}.gfxworld.json"), data)
        blobs = ((data["vertexFile"], vertices), (data["indexFile"], indices), (data["layerFile"], world["draw.vld.data"]))
        for filename, array in blobs:
            if array is not None and len(array):
                with open(asset_path(out, filename), "wb") as fh:
                    fh.write(array.bytes())
