"""Decompress an Advanced Warfare (S1) PC fastfile into its zone.

    python3 -m scripts.cod.s1.ff <map.ff> [out.zone]

Prints the zone size and the streamed-image count, and writes the zone if
asked. Every data block is checked against its master block's SHA-256, so a
wrong layout fails loudly rather than decoding garbage.

The container is IW6's with two changes: the block is 0x4000 rather than
0x2000, and the payload is a run of LZ4 chunks rather than one zlib stream.
Layout: reverse/s1-zone/README.md#the-fastfile.
"""

import hashlib
import struct
import sys
from collections import namedtuple

from . import lz4

MAGIC = b"S1ff0100"
AUTH_MAGIC = b"S1ffs100"
VERSION = 0x72E
BLOCK = 0x4000  # IW6's is 0x2000
HASHES_PER_MASTER = BLOCK // 32  # 512
ZONE_HEADER = 72  # XFile: size, externalSize, 7 block sizes -- 64-bit here, 32-bit on X360

# One span of a pak file; offset == 0 means the span is absent.
StreamFile = namedtuple("StreamFile", "localized file_index offset end")


def is_fastfile(path):
    """Whether `path` starts like an S1 PC fastfile."""
    with open(path, "rb") as fh:
        head = fh.read(12)
    return len(head) == 12 and head[:8] == MAGIC and struct.unpack_from("<I", head, 8)[0] == VERSION


def read_blocks(path, data, verify=True):
    """The streamed-image table, and the authenticated payload concatenated."""
    if data[:8] != MAGIC:
        raise ValueError(f"{path}: magic {data[:8]!r}, expected {MAGIC!r}")
    version, compress, compress_type, pointer_size = struct.unpack_from("<IBBB", data, 8)
    if (version, compress, compress_type, pointer_size) != (VERSION, 1, 4, 8):
        raise ValueError(f"{path}: header {(hex(version), compress, compress_type, pointer_size)}")

    # XAssetStreamFile[imageCount], widened from the X360 build's three uints.
    count = struct.unpack_from("<I", data, 0x18)[0]
    streams = [StreamFile(*struct.unpack_from("<HH4xQQ", data, 0x1C + 24 * i)) for i in range(count)]
    base_len = struct.unpack_from("<Q", data, 0x1C + 24 * count)[0]
    auth = 0x1C + 24 * count + 16  # then baseFileLen, totalFileLen
    if data[auth : auth + 8] != AUTH_MAGIC:
        raise ValueError(f"{path}: no {AUTH_MAGIC!r} at 0x{auth:x}")

    # One header block, then [master block, up to 512 data blocks] repeated, up
    # to `baseFileLen`: a zone whose stream entries name file 0 carries its
    # images after that, in this same file (README.md#the-companion-zone).
    end = min(base_len, len(data))
    payload = bytearray()
    at = auth + BLOCK
    while at < end:
        master = data[at : at + BLOCK]
        at += BLOCK
        for k in range(HASHES_PER_MASTER):
            if at >= end:
                break
            block = data[at : min(at + BLOCK, end)]
            if verify:
                # The last block is short in the file but hashed at full length.
                whole = block if len(block) == BLOCK else block + b"\0" * (BLOCK - len(block))
                if hashlib.sha256(whole).digest() != master[32 * k : 32 * k + 32]:
                    raise ValueError(f"{path}: block at 0x{at:x} fails its hash")
            payload += block
            at += BLOCK
    return streams, payload


def decompress(path, payload):
    """u64 total, u32 flags, then [u32 compressed, u32 uncompressed, LZ4 block]."""
    total, flags = struct.unpack_from("<QI", payload, 0)
    # Allocated once and returned as it is: a map's zone is most of a gigabyte, and
    # growing it and then copying it to `bytes` held it twice (docs/cod/pipeline.md#memory).
    zone, filled = bytearray(total), 0
    at = 12
    while at < len(payload) and filled < total:
        compressed, uncompressed = struct.unpack_from("<II", payload, at)
        at += 8
        chunk = lz4.decompress(payload, at, at + compressed)
        if len(chunk) != uncompressed:
            raise ValueError(f"{path}: a chunk gave {len(chunk)} bytes, its header said {uncompressed}")
        if filled + len(chunk) > total:
            raise ValueError(f"{path}: {filled + len(chunk)} bytes of zone, the header said {total}")
        zone[filled : filled + len(chunk)] = chunk
        filled += len(chunk)
        at = (at + compressed + 3) & ~3  # chunks start on a 4-byte boundary
    if filled != total:
        raise ValueError(f"{path}: {filled} bytes of zone, the header said {total}")
    return zone, flags


def read_ff(path, verify=True):
    """Return (streamed image table, zone bytes). The zone is a bytearray, as fastfile.inflate's is."""
    with open(path, "rb") as fh:
        head = fh.read(0x1C)
        count = struct.unpack_from("<I", head, 0x18)[0] if len(head) == 0x1C else 0
        fh.seek(0x1C + 24 * count)
        base_len = struct.unpack("<Q", fh.read(8) or bytes(8))[0]
        fh.seek(0)
        # Only the fastfile itself; what follows `baseFileLen` is its own streamed images.
        data = fh.read(base_len or -1)
    streams, payload = read_blocks(path, data, verify)
    del data  # the file, the payload and the zone are never all held at once
    zone, _flags = decompress(path, payload)
    del payload
    if struct.unpack_from("<Q", zone)[0] + ZONE_HEADER != len(zone):
        raise ValueError(f"{path}: the zone's own size field disagrees with its length")
    return streams, zone


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    streams, zone = read_ff(sys.argv[1])
    print(f"{len(zone)} bytes of zone, {len(streams)} streamed images")
    if len(sys.argv) > 2:
        with open(sys.argv[2], "wb") as fh:
            fh.write(zone)
