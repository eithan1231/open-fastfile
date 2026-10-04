"""`scriptfile`: `<name>.gscbin`, each compiled script in the `.gscbin` container.

The name and a NUL, the three int32 lengths (compressed string section, its
inflated size, bytecode), the zlib string section, then the bytecode — the
layout gsc-tool reads, and OAT's `ScriptDumperIW5` writes. Most are named by
number; scripts/cod/animations.py reads the animated-model ones.
"""

import struct

from ...iw6.dumpers.common import asset_path
from . import dumper

LENGTHS = struct.Struct("<3i")


@dumper("scriptfile")
def write(walk, out, ctx=None):
    for asset in walk.by_type("scriptfile"):
        script = asset.record
        lengths = script["compressedLen"], script["len"], script["bytecodeLen"]
        with open(asset_path(out, f"{asset.name}.gscbin"), "wb") as fh:
            fh.write(asset.name.encode("latin-1") + b"\0" + LENGTHS.pack(*lengths))
            for member in ("buffer", "bytecode"):
                if script[member] is not None:
                    fh.write(script[member].bytes())
