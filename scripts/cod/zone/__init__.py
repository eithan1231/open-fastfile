"""The zone core every Python backend reads with: a decompressed zone, walked as the game loads it.

`spec` holds what differs between games (blocks, runtime blocks, pointer width and
encoding, the XFile header) as one `ZoneSpec` per game; `layout` reads a game's
generated struct layouts; `core` is the `Zone` a walker consumes and the `Record`
it reads a struct through. Getting a zone out of its fastfile is the container's
job: `scripts/cod/fastfile.py` for IW4, IW5 and T5, `iw6/ff.py` and `s1/ff.py`.

Why these are one mechanism: docs/cod/pipeline.md#the-zone-core.
"""

from .core import Record, Zone
from .layout import INTS, KIND_FLOAT, KIND_POINTER, KIND_SIGNED, KIND_UNSIGNED, Field, Layout, field_code
from .spec import FOLLOWS, INSERT, IW4, IW5, IW6, OFFSET, POINTER_TAG, SPECS, T5, ZoneSpec

__all__ = [
    "FOLLOWS",
    "INSERT",
    "INTS",
    "IW4",
    "IW5",
    "IW6",
    "KIND_FLOAT",
    "KIND_POINTER",
    "KIND_SIGNED",
    "KIND_UNSIGNED",
    "OFFSET",
    "POINTER_TAG",
    "SPECS",
    "T5",
    "Field",
    "Layout",
    "Record",
    "Zone",
    "ZoneSpec",
    "field_code",
]
