"""`gfxworld`: T6's world surfaces, static models and brush models, with its vertices rewritten into IW's 44-byte layout.

T6 does not keep one GfxWorldVertex array. `GfxWorldDraw` holds two byte buffers,
`vd0` (`vertexDataSize0` bytes) and `vd1`, and a surface finds its vertices by a
byte offset into each (`srfTriangles_t.vertexDataOffset0`/`1`); its indices count
from there. Surfaces that share an offset share a vertex group. What was
established on mp_la (reverse/t6-zone/README.md#the-world-vertices):

- `vd0` is a run of vertex groups, each **36 bytes** a vertex and padded to 16
  bytes: xyz (3 floats), binormalSign (float), GfxColor, PackedTexCoords, normal,
  tangent (t6/vertices.py), then the lightmap coordinate as two unorm16s. That is
  the model's GfxPackedVertex with the lightmap coordinate after it.
- `vd1` holds a generated material's extra layers, 0 to 16 bytes a vertex; one
  layer is drawn, so it is not read.

The dump keeps IW's schema, which every later stage reads: each group's vertices
are written as 44-byte `GfxWorldVertex`es (floats for the texture and lightmap
coordinates, the packed normal and tangent as the zone has them, decoded per
game by shell.UNIT_VEC_BY_GAME), one after another, and a surface's `firstVertex`
is its group's first. `write` refuses a world whose groups do not account for
exactly `vertexCount` vertices, or whose indices leave their group.

The manifest also carries `sun`, `sunParse.initWorldSun[0]`, which is what the game
builds its sun light from; t6/lightmap.py lights the world with it.
"""

import struct

from ...iw5.dumpers import gfxworld as iw5
from ...iw5.dumpers.common import vec3
from ...iw6.dumpers.common import asset_path, write_json
from ...t5.dumpers.gfxworld import corners
from ..vertices import tex_coords

VD0_STRIDE = 36
GROUP_ALIGN = 16
VD0 = struct.Struct("<3ff4sIII2H")  # xyz, binormalSign, rgba, texCoord, normal, tangent, lightmap u, v (unorm16)
IW_VERTEX = struct.Struct("<3ff4s2f2fII")  # GfxWorldVertex as IW4/IW5/T5 lay it out (docs/cod/reference.md)
assert VD0.size == VD0_STRIDE and IW_VERTEX.size == 44
UNORM16 = 65535.0
# T6's dpvs names the translucent and emissive ranges its own way (GfxWorldDpvsStatic).
RANGES = ("litSurfsBegin", "litSurfsEnd", "litTransSurfsBegin", "litTransSurfsEnd")
RANGES += ("emissiveOpaqueSurfsBegin", "emissiveOpaqueSurfsEnd", "emissiveTransSurfsBegin", "emissiveTransSurfsEnd")


class VertexLayoutError(SystemExit):
    """The vertex buffers are not laid out as this writer reads them."""


def groups(surfaces, size):
    """{vd0 byte offset: (first vertex, vertex count)} of every vertex group the surfaces name.

    A group runs from its offset to the next one's (the last to `size`), which is its
    vertices at 36 bytes each and at most 15 bytes of padding."""
    offsets = sorted({s["offset0"] for s in surfaces})
    if offsets and offsets[0] != 0:
        raise VertexLayoutError(f"the first vertex group starts at vd0 byte {offsets[0]}, not 0")
    out, first = {}, 0
    for at, end in zip(offsets, [*offsets[1:], size], strict=True):
        count, padding = divmod(end - at, VD0_STRIDE)
        if at % GROUP_ALIGN or padding >= GROUP_ALIGN:
            raise VertexLayoutError(f"vd0 group at {at}: {end - at} bytes is not 36-byte vertices padded to 16")
        out[at] = (first, count)
        first += count
    return out


def surface_records(world):
    out = []
    for surface in list(world["dpvs.surfaces"] or ())[: world["surfaceCount"]]:
        entry = {key: surface[f"tris.{key}"] for key in ("firstVertex", "vertexCount", "triCount", "baseIndex")}
        entry["offset0"] = surface["tris.vertexDataOffset0"]
        material = surface["material"]
        if material is not None and material.name:
            entry["material"] = material.name
        entry["lightmapIndex"] = surface["lightmapIndex"]
        entry["flags"] = surface["flags"] & 0xFF
        out.append(entry)
    return out


def rebase(surfaces, table, indices):
    """Point each surface at its group, in IW's terms: `firstVertex` the group's first vertex
    in the rewritten array, `vertexCount` how many of the group its indices reach."""
    for s in surfaces:
        first, count = table[s.pop("offset0")]
        used = indices[s["baseIndex"] : s["baseIndex"] + 3 * s["triCount"]]
        reach = max(used) + 1 if used else 0
        if reach > count:
            raise VertexLayoutError(f"a surface at index {s['baseIndex']} reaches vertex {reach - 1} of a {count}-vertex group")
        s["firstVertex"], s["vertexCount"] = first, reach


def iw_vertices(vd0, table):
    """The vertex groups of `vd0` as IW's 44-byte GfxWorldVertex, in group order."""
    out = bytearray()
    for at, (_first, count) in sorted(table.items()):
        for x, y, z, sign, rgba, uv, normal, tangent, lu, lv in VD0.iter_unpack(vd0[at : at + count * VD0_STRIDE]):
            u, v = tex_coords(uv)
            out += IW_VERTEX.pack(x, y, z, sign, rgba, u, v, lu / UNORM16, lv / UNORM16, normal, tangent)
    return bytes(out)


def lightmaps(world):
    out = []
    for entry in list(world["draw.lightmaps"] or ())[: world["draw.lightmapCount"]]:
        pages = {}
        for key in ("primary", "secondary"):
            image = entry[key]
            if image is not None and image.name:
                pages[key] = image.name
        out.append(pages)
    return out


def sun(world):
    """`sunParse.initWorldSun[0]`, which the game builds its sun light from (reverse/t6-lightmap):
    angles (pitch, yaw, roll), `sunCd` (a colour and its strength), and the rest as it stands."""
    parse = world["sunParse"]
    key = "initWorldSun[0]."
    out = {
        name: list(parse.unpack(f"<{n}f", key + name))
        for name, n in (("angles", 3), ("ambientColor", 4), ("sunCd", 4), ("sunCs", 4), ("skyColor", 4))
    }
    out["exposure"] = parse[key + "exposure"]
    return out


def static_models(world):
    """iw5 `static_models`, reading T6's vec3_t (a struct, not IW's float[3]) as its floats."""
    out = []
    for inst in list(world["dpvs.smodelDrawInsts"] or ())[: world["dpvs.smodelCount"]]:
        axis = inst.unpack("<9f", "placement.axis")
        entry = {
            "origin": vec3(inst.unpack("<3f", "placement.origin")),
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
            "startSurfIndex": model["startSurfIndex"] - (1 << 32)
            if model["startSurfIndex"] >= 1 << 31
            else model["startSurfIndex"],
            "bounds": corners(model, "bounds"),
        }
        for model in list(world["models"] or ())[: world["modelCount"]]
    ]


def manifest(asset, surfaces, vertex_count):
    world = asset.record
    data = {"_type": "gfxworld", "_version": 1, "_game": "t6", "name": asset.name}
    if world["baseName"]:
        data["baseName"] = world["baseName"]
    static = world["dpvs.staticSurfaceCount"]
    sorted_index = world["dpvs.sortedSurfIndex"]
    data.update(
        checksum=world["checksum"],
        bounds=corners(world, None),
        vertexCount=vertex_count,
        vertexStride=IW_VERTEX.size,
        vertexFile=f"{asset.name}.gfxworld_vertices.bin",
        indexCount=world["draw.indexCount"],
        indexStride=iw5.INDEX_STRIDE,
        indexFile=f"{asset.name}.gfxworld_indices.bin",
        surfaceCount=world["surfaceCount"],
        staticModelCount=world["dpvs.smodelCount"],
        surfaces=surfaces,
        staticModels=static_models(world),
        lightmaps=lightmaps(world),
        sun=sun(world),
        staticSurfaceCount=static,
        **{key: world[f"dpvs.{key}"] for key in RANGES},
        sortedSurfIndex=[v for (v,) in sorted_index.view(0, static).unpack("<H")] if sorted_index is not None else [],
        modelCount=world["modelCount"],
        models=brush_models(world),
    )
    return data


def convert(world):
    """(surfaces, IW vertex bytes, index bytes) of one GfxWorld, checked (see the module doc)."""
    vd0 = world["draw.vd0.data"]
    vd0 = bytes(vd0.bytes()) if vd0 is not None else b""
    size = world["draw.vertexDataSize0"]
    if len(vd0) != size:
        raise VertexLayoutError(f"vd0 holds {len(vd0)} bytes, vertexDataSize0 says {size}")
    indices_array = world["draw.indices"]
    index_bytes = bytes(indices_array.bytes()) if indices_array is not None else b""
    indices = struct.unpack(f"<{len(index_bytes) // 2}H", index_bytes)
    surfaces = surface_records(world)
    table = groups(surfaces, size)
    total = sum(count for _, count in table.values())
    if total != world["draw.vertexCount"]:
        raise VertexLayoutError(f"the vertex groups hold {total} vertices, vertexCount is {world['draw.vertexCount']}")
    rebase(surfaces, table, indices)
    return surfaces, iw_vertices(vd0, table), index_bytes


def write(walk, out, ctx=None):
    worlds = walk.by_type("gfxworld")
    if not worlds:
        raise SystemExit(f"{walk.path} holds no GfxWorld")
    for asset in worlds:
        world = asset.record
        surfaces, vertices, indices = convert(world)
        data = manifest(asset, surfaces, world["draw.vertexCount"])
        if len(surfaces) != data["surfaceCount"] or len(data["models"]) != data["modelCount"]:
            raise SystemExit(f"{asset.name}: the surface or brush model count disagrees with what was loaded")
        if len(indices) != 2 * data["indexCount"] or len(data["staticModels"]) != data["staticModelCount"]:
            raise SystemExit(f"{asset.name}: the index or static model count disagrees with what was loaded")
        write_json(asset_path(out, f"{asset.name}.gfxworld.json"), data)
        for filename, blob in ((data["vertexFile"], vertices), (data["indexFile"], indices)):
            with open(asset_path(out, filename), "wb") as fh:
                fh.write(blob)
