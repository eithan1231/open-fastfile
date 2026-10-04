"""`gfxworld`: the world's surfaces and static models, and its vertices re-laid as IW's 44-byte GfxWorldVertex.

T9's vertex is two streams (float3 positions, then 20 bytes: colour, f32 uv,
normal, tangent), and its normal is already IW6's 10:10:10 unsigned packing,
so the u32 is copied as it is. The colour's RGB is always white and its alpha a
layer weight this engine does not blend, so the vertex is written white. There
is no lightmap UV.
"""

import struct

from ...iw6.dumpers.common import asset_path, write_json
from ...iw6.vertices import WORLD_VERTEX
from .. import world
from . import GAME, dumper

INDEX_STRIDE = 2
WHITE = (255, 255, 255, 255)


def vertices(d, gfx):
    n = gfx.vertex_count
    out = bytearray(WORLD_VERTEX.size * n)
    pos = struct.unpack_from(f"<{3 * n}f", d, gfx.positions)
    second = struct.iter_unpack("<IffII", d[gfx.stream2 : gfx.stream2 + world.WORLD_VERTEX_2 * n])
    for i, (_colour, u, v, normal, _tangent) in enumerate(second):
        WORLD_VERTEX.pack_into(out, WORLD_VERTEX.size * i, *pos[3 * i : 3 * i + 3], *WHITE, u, v, 0.0, 0.0, normal)
    return out


def static_models(walked):
    out = []
    for name, origin, quat, scale in walked.placements[0]:
        out.append({"origin": list(origin), "axis": world.quat_axis(quat), "scale": scale, "model": f"{name:016x}"})
    return out


@dumper("gfxworld")
def write(walked, out):
    d, gfx = walked.zone.data, walked.gfx
    surfaces = []
    for s in walked.world_surfaces:
        entry = {k: s[k] for k in ("firstVertex", "vertexCount", "triCount", "baseIndex")}
        if s["material"]:
            entry["material"] = s["material"].name
        surfaces.append(entry)
    mins, maxs = gfx.bounds[:3], gfx.bounds[3:]
    world_model = gfx.models[0]
    name = walked.bsp
    data = {
        "_type": "gfxworld",
        "_version": 1,
        "_game": GAME,
        "name": name,
        "baseName": gfx.base_name,
        "bounds": {"mins": list(mins), "maxs": list(maxs)},
        "vertexCount": gfx.vertex_count,
        "vertexStride": WORLD_VERTEX.size,
        "vertexFile": f"{name}.gfxworld_vertices.bin",
        "indexCount": gfx.index_count,
        "indexStride": INDEX_STRIDE,
        "indexFile": f"{name}.gfxworld_indices.bin",
        "surfaceCount": len(surfaces),
        "staticModelCount": len(walked.placements[0]),
        "surfaces": surfaces,
        "staticModels": static_models(walked),
        "modelCount": 1,
        "models": [
            {
                "surfaceCount": len(surfaces),
                "startSurfIndex": 0,
                "bounds": {"mins": list(world_model[:3]), "maxs": list(world_model[3:6])},
            }
        ],
    }
    write_json(asset_path(out, f"{name}.gfxworld.json"), data)
    with open(asset_path(out, data["vertexFile"]), "wb") as fh:
        fh.write(vertices(d, gfx))
    with open(asset_path(out, data["indexFile"]), "wb") as fh:
        fh.write(d[gfx.indices : gfx.indices + INDEX_STRIDE * gfx.index_count])
    print(
        f"      gfxworld: {len(surfaces)} world surfaces, {sum(1 for s in surfaces if 'material' in s)} with a material; "
        f"{gfx.model_count - 1} brush models left out"
    )
