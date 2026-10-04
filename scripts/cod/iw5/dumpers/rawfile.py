"""`rawfile`: each raw file at its own name, inflated.

IW5 stores every rawfile deflated: the zone loads `compressedLen` bytes of
`buffer` and nothing else, so one with no compressed bytes is an empty file
(`mp_dome` names such a one after itself). IW4's `data` is a union: the deflated
`compressedBuffer` when `compressedLen` is set, else `len` plain bytes of `buffer`
(and a NUL). The map's `.vision`, `.sun` and plain-text scripts are what
scripts/cod/metadata.py reads.
"""

import zlib

from ...iw6.dumpers.common import asset_path
from . import dumper


def contents(raw):
    """A RawFile's bytes, inflated where the zone deflated them."""
    if raw["compressedLen"] > 0:
        packed = raw["buffer"] if "buffer" in raw else raw["data.compressedBuffer"]
        return zlib.decompressobj().decompress(bytes(packed.bytes())) if packed is not None else b""
    plain = raw["data.buffer"] if "data.buffer" in raw else None
    return bytes(plain.bytes()[: raw["len"]]) if plain is not None and raw["len"] > 0 else b""


@dumper("rawfile")
def write(walk, out, ctx=None):
    for asset in walk.by_type("rawfile"):
        with open(asset_path(out, asset.name), "wb") as fh:
            fh.write(contents(asset.record))
