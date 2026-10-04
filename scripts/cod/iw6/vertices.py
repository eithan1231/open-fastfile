"""IW6 vertex decoding: world vertices and model (packed) vertices.

Both carry a PackedUnitVec normal, 10:10:10 unsigned, each axis v / 1023 * 2 - 1.
That is not IW5's byte-and-scale packing (scripts/cod/shell.py): decoded that
way, IW6 normals come out with a mean length of 1.68 instead of 1. Model
vertices pack their texture coordinates as two IEEE half floats, u in the low
word and v in the high one (x64-zt Vec2PackTexCoords); world vertices store
them as floats.
"""

import struct

WORLD_VERTEX = struct.Struct("<3f4x4B2f2fI4x")  # xyz, binormalSign, rgba, uv, lightmap uv, normal, tangent
MODEL_VERTEX = struct.Struct("<3f4x4BIII")  # xyz, binormalSign, rgba, texCoord, normal, tangent
assert WORLD_VERTEX.size == 44 and MODEL_VERTEX.size == 32
WORD = struct.Struct("<H")
HALF = struct.Struct("<e")


def unit_vec(packed):
    return tuple(((packed >> shift) & 0x3FF) / 1023.0 * 2.0 - 1.0 for shift in (0, 10, 20))


def half(word):
    return HALF.unpack(WORD.pack(word))[0]


def tex_coords(packed):
    return half(packed & 0xFFFF), half(packed >> 16)


def world_vertices(data, at, count):
    """[(xyz, normal, uv, lightmap uv, rgba)] for `count` GfxWorldVertex at file offset `at`."""
    out = []
    for x, y, z, r, g, b, a, u, v, lu, lv, normal in WORLD_VERTEX.iter_unpack(
        memoryview(data)[at : at + count * WORLD_VERTEX.size]
    ):
        out.append(((x, y, z), unit_vec(normal), (u, v), (lu, lv), (r, g, b, a)))
    return out


def model_vertices(data, at, count):
    """[(xyz, normal, uv, rgba)] for `count` GfxPackedVertex (or GfxPackedMotionVertex) at `at`.

    The motion variant keeps the same offsets; its colour bytes are a piece index."""
    out = []
    for x, y, z, r, g, b, a, uv, normal, _ in MODEL_VERTEX.iter_unpack(memoryview(data)[at : at + count * MODEL_VERTEX.size]):
        out.append(((x, y, z), unit_vec(normal), tex_coords(uv), (r, g, b, a)))
    return out
