#!/usr/bin/env python3
"""Print an IW4, IW5 or T5 fastfile's container facts: magic, version, and the XFile sizes.

    header.py <file.ff> ...

Reads the first 0x6000 bytes only. Where the zlib stream starts is the README's
container table: 12 for T5 (IWffu100, version 0x1D9), 21 for an unsigned IW4/IW5,
and past the auth chunk and the first master block for a signed one. The words
printed are size, externalSize, one blockSize per block, then the zone's first
words (the script-string count comes first).
"""

import struct
import sys
import zlib

T5_VERSION = 0x1D9
CHUNK = 0x2000


def probe(path):
    with open(path, "rb") as fh:
        head = fh.read(3 * CHUNK)
    magic, version = head[:8], struct.unpack_from("<I", head, 8)[0]
    if magic == b"IWffu100":
        start = 12 if version == T5_VERSION else 21
    else:
        start = 21 + CHUNK + CHUNK
    data = zlib.decompressobj().decompress(head[start:], 48)
    words = struct.unpack_from(f"<{len(data) // 4}I", data)
    auth = head[21:29] if magic == b"IWff0100" else b""
    return magic, version, auth, start, words


def main():
    for path in sys.argv[1:]:
        magic, version, auth, start, words = probe(path)
        print(path, magic.decode(), hex(version), auth.decode(errors="replace"), f"zlib@{start}", " ".join(hex(w) for w in words))


if __name__ == "__main__":
    main()
