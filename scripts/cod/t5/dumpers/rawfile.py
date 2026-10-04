"""`rawfile`: each raw file at its own name; a script (`.gsc`, `.csc`) inflated.

T5's RawFile is `len` bytes of `buffer`, stored as they are, except a script: that
buffer is `u32 inflated size, u32 deflated size`, then a zlib stream whose output
ends in a NUL, which is not written (OAT's RawFileDumperT5). The map's `.vision`,
`.sun` and scripts, and the create-a-class `mpbody/` and `mphead/` scripts cac.py
reads, are among them.
"""

import os
import struct
import zlib

from ...iw6.dumpers.common import asset_path

SCRIPTS = (".gsc", ".csc")
CHUNK = 0x1000  # OAT inflates into a buffer of this size and drops the NUL from the chunk that ends it


def script(buffer, length):
    """A deflated script's text, or b"" for one too short to hold its header (OAT writes an empty file)."""
    if length <= 8:
        return b""
    out_len, in_len = struct.unpack_from("<II", buffer, 0)
    if in_len > length - 8 + 1:
        return b""
    inflated = zlib.decompressobj().decompress(bytes(buffer[8 : 8 + in_len]))
    text, written = bytearray(), 0
    for at in range(0, len(inflated), CHUNK):
        chunk = inflated[at : at + CHUNK]
        text += chunk[:-1] if written + len(chunk) >= out_len else chunk
        written += len(chunk)
    return bytes(text)


def contents(asset):
    raw = asset.record
    length = raw["len"]
    buffer = raw["buffer"]
    data = bytes(buffer.bytes()) if buffer is not None else b""
    if os.path.splitext(asset.name)[1].lower() in SCRIPTS:
        return script(data, length)
    return data[: max(length, 0)]


def write(walk, out, ctx=None):
    for asset in walk.by_type("rawfile"):
        with open(asset_path(out, asset.name), "wb") as fh:
            fh.write(contents(asset))
