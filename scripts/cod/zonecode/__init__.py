"""One table-driven walker for the 32-bit zones (IW4, IW5, T5), from OAT's ZoneCode as data.

    from scripts.cod.zonecode import walk_fastfile
    walk = walk_fastfile("mp_dome.ff")
    walk.check()                          # [] when it reached the end and every block's size agrees
    for asset in walk.by_type("xmodel"):
        asset.record["lodInfo[0].modelSurfs"]   # an Asset; its .record is an XModelSurfs

- `program`: the game's load program, `scripts/cod/data/<g>/zonecode.json`;
- `walker`: the interpreter and the `Walk` it returns;
- `values`: what a walk holds (Record, Array, Asset, Pointer), read lazily from the zone;
- `stream`: the zone core's cursors plus the loaded memory references resolve against;
- `actions`: OAT's hand-written custom actions;
- `listing`: the asset listing in OAT's `.zone` format;
- `companions`: what a map names under a leading comma, found in a companion zone by name.

Why and how: docs/cod/pipeline.md#the-zonecode-walker, reverse/x86-zone/README.md.
"""

from .program import Program
from .stream import WalkError
from .values import Array, Asset, Pointer, Record
from .walker import Walk, walk_fastfile, walk_zone

__all__ = ["Array", "Asset", "Pointer", "Program", "Record", "Walk", "WalkError", "walk_fastfile", "walk_zone"]
