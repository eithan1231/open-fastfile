"""`rawfile`: each raw file at its own name, as OpenAssetTools' dumper writes it.

A rawfile is text — the map's `.vision` and `.sun`, its plain-text scripts —
held deflated when `compressedLen` is set and plain otherwise. Both are written
out decompressed, which is what scripts/cod/metadata.py reads.
"""

import zlib

from . import dumper
from .common import asset_path


@dumper("rawfile")
def write(walked, out):
    zone = walked.zone
    for name, raw in zone.found.get("RAWFILE", {}).items():
        if name.startswith(",") or raw.buffer is None:
            continue
        data = zone.data[raw.buffer : raw.buffer + (raw.compressed or raw.length + 1)]
        if raw.compressed:
            data = zlib.decompress(data)
        # `len` is the text either way: a deflated rawfile inflates to exactly
        # that many bytes, and a plain one is stored with a NUL after them.
        with open(asset_path(out, name), "wb") as fh:
            fh.write(data[: raw.length])
