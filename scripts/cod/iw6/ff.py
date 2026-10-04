"""Decompress a Ghosts (IW6) PC fastfile into its zone.

    python3 -m scripts.cod.iw6.ff <map.ff> [out.zone]

Prints the zone size and the streamed-image count, and writes the zone if asked.
Every data block is checked against its master block's SHA-256, so a wrong
layout fails loudly rather than inflating garbage. Layout: reverse/iw6-zone/README.md#the-fastfile.
"""

import hashlib
import struct
import sys
import zlib
from collections import namedtuple

MAGIC = b"IWff0100"
AUTH_MAGIC = b"IWffs100"
VERSION = 0x235
BLOCK = 0x2000  # DBX_AuthLoad_InflateCopyBuffer's unit
HASHES_PER_MASTER = BLOCK // 32
ZONE_HEADER = 72  # XZoneMemory: size, externalsize, 7 block sizes
SELF_PAK = 69  # XStreamFile.fileIndex naming <zone>.pak rather than imagefile<N>.pak

# One span of a pak file; offset == 0 means the span is absent.
StreamFile = namedtuple("StreamFile", "localized file_index offset end")


def is_fastfile(path):
    """Whether `path` starts like an IW6 PC fastfile. Black Ops shares the magic, not the version."""
    with open(path, "rb") as fh:
        head = fh.read(12)
    return len(head) == 12 and head[:8] == MAGIC and struct.unpack_from("<I", head, 8)[0] == VERSION


def read_ff(path):
    """Return (streamed image table, zone bytes)."""
    with open(path, "rb") as fh:
        d = fh.read()
    if d[:8] != MAGIC:
        raise ValueError(f"{path}: magic {d[:8]!r}, expected {MAGIC!r}")
    version, compress, compress_type, pointer_size = struct.unpack_from("<IBBB", d, 8)
    if (version, compress, compress_type, pointer_size) != (VERSION, 1, 0, 8):
        raise ValueError(f"{path}: header {(hex(version), compress, compress_type, pointer_size)}")

    # XStreamFile[imageCount]: isLocalized, fileIndex, pad, offset, offsetEnd into imagefile<N>.pak
    count = struct.unpack_from("<I", d, 0x18)[0]
    streams = [StreamFile(*struct.unpack_from("<HH4xQQ", d, 0x1C + 24 * i)) for i in range(count)]
    auth = 0x1C + 24 * count + 16  # then baseFileLen, totalFileLen
    if d[auth : auth + 8] != AUTH_MAGIC:
        raise ValueError(f"{path}: no {AUTH_MAGIC!r} at 0x{auth:x}")

    # One header block, then [master block, up to 256 data blocks] repeated.
    data = bytearray()
    at = auth + BLOCK
    while at < len(d):
        master = d[at : at + BLOCK]
        at += BLOCK
        for k in range(HASHES_PER_MASTER):
            if at >= len(d):
                break
            block = d[at : at + BLOCK]
            if len(block) == BLOCK and hashlib.sha256(block).digest() != master[32 * k : 32 * k + 32]:
                raise ValueError(f"{path}: block at 0x{at:x} fails its hash")
            data += block
            at += BLOCK

    del d  # the file, the payload and the zone are never all held at once
    inflater = zlib.decompressobj()
    zone = inflater.decompress(data)
    del data
    if not inflater.eof or struct.unpack_from("<Q", zone)[0] + ZONE_HEADER != len(zone):
        raise ValueError(f"{path}: zone is truncated or its size field disagrees")
    return streams, zone


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    streams, zone = read_ff(sys.argv[1])
    print(f"{len(zone)} bytes of zone, {len(streams)} streamed images")
    if len(sys.argv) > 2:
        with open(sys.argv[2], "wb") as fh:
            fh.write(zone)
