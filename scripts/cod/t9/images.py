"""A T9 image (asset type 16): its header, and the largest mip that is on this machine.

The record, offsets from its XHash (reverse/t9-zone/types_image.py):

  +0x10  u64 resident pixels: -1 (inline, after the part records), 0 (none), or
         a pointer to an identical image's
  +0x98  u32 size of the whole chain, +0x9c u32 DXGI format, +0xa0 u16 width, height
  +0xb1  u8 n: n - 1 streamed parts, then the resident one
  +0xe8  n records of 0x20: u32 start << 4 | level, u16 2 * width, u16 height,
         u64 stream key. The chain is laid out smallest mip first; part i is
         [start[i], start[i+1]) and its largest mip, the last in it, is record
         i + 1's size. The last record has no key: the resident mips [0, start[0])
         begin in its key slot. Its size fields describe the resident part's largest mip.

The top part of most images is in an optional `_hd` package that is usually not
installed, so the largest part an installed package holds is taken: about
half the resolution (reverse/t9-zone/README.md).
"""

import struct

from ..iw6.images import BLOCK_BYTES, dds, level_size

PARTS = 0xE8
PART = 0x20
NULL = 0xFFFFFFFFFFFFFFFF


def parse(data, h):
    fmt = struct.unpack_from("<I", data, h + 0x9C)[0]
    width, height = struct.unpack_from("<2H", data, h + 0xA0)
    n = data[h + 0xB1]
    parts = []
    for i in range(n):
        info, w2, hh = struct.unpack_from("<IHH", data, h + PARTS + PART * i)
        key = struct.unpack_from("<Q", data, h + PARTS + PART * i + 8)[0] if i < n - 1 else None
        parts.append((info >> 4, (w2 // 2) & 0x7FFF, hh & 0x7FFF, key))
    return {
        "format": fmt,
        "width": width,
        "height": height,
        "pixels": struct.unpack_from("<Q", data, h + 0x10)[0],
        "parts": parts,
        "resident": h + PARTS + PART * (n - 1) + 8 if n else None,
    }


def largest_level(data, h, packages):
    """(format, width, height, bytes of one level) of the largest mip available, or (None, why)."""
    image = parse(data, h)
    fmt, parts = image["format"], image["parts"]
    if fmt not in BLOCK_BYTES:
        return None, f"format {fmt}"
    # parts[i] for i < n-1 is streamed: its extent is [start_i, start_{i+1}), its top mip parts[i+1]'s size.
    for i in range(len(parts) - 2, -1, -1):
        item = packages.read(parts[i][3])
        if item is None:
            continue
        _, w, hgt, _ = parts[i + 1]
        size = level_size(fmt, w, hgt)
        if len(item) != parts[i + 1][0] - parts[i][0] or size > len(item):
            return None, f"part {i} is {len(item)} bytes, its records say {parts[i + 1][0] - parts[i][0]}"
        return (fmt, w, hgt, item[len(item) - size :]), None
    if image["pixels"] != NULL or not parts:
        return None, "no installed part, and its resident mips are another image's"
    total, w, hgt, _ = parts[0]
    size = level_size(fmt, w, hgt)
    if size > total:
        return None, f"resident mips of {total} bytes cannot hold a {w}x{hgt} level"
    at = image["resident"]
    return (fmt, w, hgt, data[at + total - size : at + total]), None


def write_dds(path, level):
    fmt, width, height, pixels = level
    with open(path, "wb") as fh:
        fh.write(dds(fmt, width, height, 1, pixels))
