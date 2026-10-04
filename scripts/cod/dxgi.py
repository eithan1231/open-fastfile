"""The DDS payloads Pillow cannot read: BC4 blocks and half-float RGBA.

Pillow 10.2, which `textures.py` decodes with, reads a DDS only through its
DXT1/3/5 FourCC headers and has no float decoder, so the two DX10 formats
Ghosts keeps its lightmaps in are unpacked here: `BC4_UNORM` (the sun
visibility mask) and `R16G16B16A16_FLOAT` (the baked colour). Plain Python:
this pipeline has no numpy, and a lightmap page is decoded once per export.
See docs/cod/reference.md#lightmaps.
"""

import struct

BC4_UNORM = 80
R16G16B16A16_FLOAT = 10

_DDS_MAGIC = b"DDS "
_HEADER_SIZE = 128
_DX10_HEADER_SIZE = 20
_DX10 = b"DX10"


def read_dds(path):
    """(format, width, height, payload) for a DDS holding one level.

    The format is the `DXGI_FORMAT` number of a DX10 header, and the FourCC
    bytes otherwise. `scripts/cod/iw6/images.py` writes both shapes.
    """
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != _DDS_MAGIC:
        raise ValueError(f"{path}: not a DDS file")
    height, width = struct.unpack_from("<2I", data, 12)
    fourcc = data[84:88]
    if fourcc != _DX10:
        return fourcc, width, height, data[_HEADER_SIZE:]
    fmt = struct.unpack_from("<I", data, _HEADER_SIZE)[0]
    return fmt, width, height, data[_HEADER_SIZE + _DX10_HEADER_SIZE :]


def bc4(payload, width, height):
    """A BC4_UNORM payload as one byte a texel, row major.

    Each 8-byte block holds two endpoints and sixteen 3-bit selectors, in
    4x4 texel order. The endpoints' order picks the palette: six interpolated
    values between them, or four plus an explicit 0 and 255.
    """
    out = bytearray(width * height)
    at = 0
    for by in range(0, height, 4):
        for bx in range(0, width, 4):
            r0, r1 = payload[at], payload[at + 1]
            bits = int.from_bytes(payload[at + 2 : at + 8], "little")
            at += 8
            if r0 > r1:
                palette = (r0, r1, *(round((k * r0 + (7 - k) * r1) / 7) for k in range(6, 0, -1)))
            else:
                palette = (r0, r1, *(round((k * r0 + (5 - k) * r1) / 5) for k in range(4, 0, -1)), 0, 255)
            for i in range(16):
                x, y = bx + (i & 3), by + (i >> 2)
                if x < width and y < height:
                    out[y * width + x] = palette[(bits >> (3 * i)) & 7]
    return out


def rgba16f_row(payload, width, y):
    """One row of an R16G16B16A16_FLOAT payload, as `width * 4` floats.

    A row at a time on purpose: a 1024x4096 lightmap page holds 16.8 M
    components, and one Python list of those is hundreds of megabytes.
    """
    stride = width * 8
    return struct.unpack_from(f"<{width * 4}e", payload, y * stride)
