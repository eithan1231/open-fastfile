"""`scriptfile`: `<name>.gscbin`, each compiled script as OpenAssetTools' IW5 dumper writes it.

The name and a NUL, the three int32 lengths (compressed string section, its
inflated size, bytecode), the zlib string section, then the bytecode
(OAT `ScriptDumperIW5.cpp`). IW6 compiles its scripts the same way and, as IW5
does, names most of them by number; scripts/cod/animations.py reads the
animated-model ones.
"""

import struct

from ..zone import Record
from . import dumper
from .common import asset_path

LENGTHS = struct.Struct("<3i")


@dumper("scriptfile")
def write(walked, out):
    zone = walked.zone
    for name, script in zone.found.get("SCRIPTFILE", {}).items():
        if name.startswith(",") or script.buffer is None:
            continue
        header = Record(zone, "ScriptFile", script.at, None, None)
        compressed, inflated, bytecode = header["compressedLen"], header["len"], header["bytecodeLen"]
        with open(asset_path(out, f"{name}.gscbin"), "wb") as fh:
            fh.write(name.encode("latin-1") + b"\0" + LENGTHS.pack(compressed, inflated, bytecode))
            fh.write(zone.data[script.buffer : script.buffer + compressed])
            if script.bytecode is not None:
                fh.write(zone.data[script.bytecode : script.bytecode + bytecode])
