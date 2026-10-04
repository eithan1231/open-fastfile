"""Inflate a Black Ops Cold War (T9) fastfile into its zone.

    python3 -m scripts.cod.t9.ff <map.ff> [out.zone]

The container is `TAFF`, version 9, then a header this reader does not need,
then Oodle blocks back to back to the end of the file. Each block opens with
four u32s: compressed size, decompressed size, the stride to the next block
(the compressed bytes plus padding) and the header's own file offset. That
last field is how the first block is found rather than assumed, and a block
whose fourth field does not name itself ends the walk. The walk must end on
the file's last byte bar under 0x80 bytes of zero padding, which is the check that
the header is read right.
reverse/t9-zone/README.md, "The container".
"""

import struct
import sys

from . import oodle

MAGIC = b"TAFF"
VERSION = 9
BLOCK_HEADER = struct.Struct("<4I")
# The header before the first block is under 8 KB on every zone seen.
FIRST_BLOCK_SEARCH = (0x40, 0x2000)
# Oodle's own stream header: a first byte whose low nibble is 0xC.
OODLE_NIBBLE = 0x0C
MAX_PADDING = 0x80


def is_fastfile(path):
    """Whether `path` starts like a T9 fastfile."""
    with open(path, "rb") as fh:
        head = fh.read(8)
    return len(head) == 8 and head[:4] == MAGIC and struct.unpack_from("<I", head, 4)[0] == VERSION


def first_block(data):
    """The first offset whose fourth u32 names itself."""
    lo, hi = FIRST_BLOCK_SEARCH
    for off in range(lo, min(hi, len(data) - BLOCK_HEADER.size)):
        if struct.unpack_from("<I", data, off + 12)[0] == off:
            csize, dsize, stride, _ = BLOCK_HEADER.unpack_from(data, off)
            if 0 < csize <= stride and dsize and data[off + 16] & 0x0F == OODLE_NIBBLE:
                return off
    raise ValueError("no self-describing block header in the first 8 KB")


def inflate(path):
    """The zone: every block of `path` decompressed and concatenated."""
    with open(path, "rb") as fh:
        data = fh.read()
    if not (data[:4] == MAGIC and struct.unpack_from("<I", data, 4)[0] == VERSION):
        raise ValueError(f"{path}: not a TAFF v{VERSION} fastfile")
    off = first_block(data)
    out = bytearray()
    while off + BLOCK_HEADER.size <= len(data):
        csize, dsize, stride, self_off = BLOCK_HEADER.unpack_from(data, off)
        if self_off != off:
            break
        body = data[off + 16 : off + 16 + csize]
        if len(body) != csize or csize > stride or not body or body[0] & 0x0F != OODLE_NIBBLE:
            raise ValueError(f"{path}: block at 0x{off:x} is not an Oodle stream ({csize} of {stride} bytes)")
        out += oodle.decompress(body, dsize)
        off += 16 + stride
    # Zero padding follows the last block, to a multiple of 0x40 (sometimes one more 0x40).
    if len(data) - off >= MAX_PADDING or data[off:].strip(b"\0"):
        raise ValueError(f"{path}: the block walk ended at 0x{off:x}, the file at 0x{len(data):x}")
    return bytes(out)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    zone = inflate(sys.argv[1])
    print(f"{sys.argv[1]}: zone of {len(zone):,} bytes")
    if len(sys.argv) > 2:
        with open(sys.argv[2], "wb") as fh:
            fh.write(zone)


if __name__ == "__main__":
    main()
