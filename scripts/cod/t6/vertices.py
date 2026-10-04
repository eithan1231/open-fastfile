"""Black Ops II's packed vertex members: a normal as three signed 10-bit fields, texture coordinates as two halves.

Both are OAT's (`Common::Vec3UnpackUnitVec` and `Vec2UnpackTexCoords` in CommonT6.cpp,
which call `pack32::Vec3UnpackUnitVecThirdBased` and `Vec2UnpackTexCoordsUV`):

- a PackedUnitVec is x, y, z in bits 0-9, 10-19 and 20-29, each a two's-complement
  10-bit value scaled so that 511 is 1.0 (the game builds a float from the bits, as
  `3.0 + v * 2^-22`, subtracts 3 and scales by 8208.0312). Neither IW's scale byte
  nor IW6's unsigned 10:10:10: read either way, T6 normals come out far from unit length;
- a PackedTexCoords is u in the low half float and v in the high one (IW4/IW5 are the
  other way round).

The world vertex (GfxWorld `vd0`) is the model's GfxPackedVertex plus a lightmap
coordinate; its layout is in t6/dumpers/gfxworld.py.
"""

import struct

from ..iw6.vertices import half

# 8208.0312 * 2^-22, and the game's float arithmetic rounds each step to single precision.
_F32 = struct.Struct("<f")
_SCALE = 8208.0312


def _axis(bits):
    """One 10-bit field as the game decodes it (pack32::Vec3UnpackUnitVecThirdBased)."""
    word = bits - 2 * (bits & 0x200) + 0x40400000
    value = _F32.unpack(struct.pack("<I", word & 0xFFFFFFFF))[0]
    return (value - 3.0) * _SCALE


def unit_vec(packed):
    """A T6 PackedUnitVec -> (x, y, z)."""
    return (_axis(packed & 0x3FF), _axis((packed >> 10) & 0x3FF), _axis((packed >> 20) & 0x3FF))


def tex_coords(packed):
    """A T6 PackedTexCoords -> (u, v): u is the low half float."""
    return half(packed & 0xFFFF), half(packed >> 16)
