"""IW6's zone: the shared zone core (`scripts/cod/zone`) with Ghosts' spec and struct layouts.

The reader itself -- block cursors, pointers, handles, slots, strings -- is
`scripts/cod/zone/core.py`, the same for every game; what is IW6's is the
`ZoneSpec` (seven blocks, tagged 64-bit pointers) and where its layouts come from.
The names below are what `scripts/cod/iw6` and `scripts/cod/s1` import, so neither
needed to change when the core moved. Pointer values and the loader's rules:
reverse/iw6-zone/README.md#pointers.
"""

import json
import os
import re

from .. import config
from ..zone import core
from ..zone import layout as core_layout
from ..zone.core import Record
from ..zone.layout import INTS, KIND_FLOAT, KIND_POINTER, KIND_SIGNED, KIND_UNSIGNED, Field, field_code
from ..zone.spec import FOLLOWS, INSERT, IW6, OFFSET, POINTER_TAG

# The PC layout is generated from x64-zt's headers (GPL-3) and ships in scripts/cod/data/
# (its README). $IW6_LAYOUT names another copy.
DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "iw6")
LAYOUT = os.environ.get("IW6_LAYOUT", os.path.join(DATA, "layout.json"))
# Types x64-zt does not declare, from the Durango PDB (reverse/iw6-zone/pdbtypes.py --json). Only the
# render structs differ between that build and PC (reverse/iw6-zone/README.md), so the rest carry over.
# Derived from a development build's symbols, so it is never shipped: the user names it.
DURANGO_TYPES_KEY = "iw6_durango_types"


def durango_types():
    """The Durango type table's path ($IW6_DURANGO_TYPES, else cod.config.json's `iw6_durango_types`), or None."""
    return config.data_path(DURANGO_TYPES_KEY)[0]


TEMP, PHYSICAL, RUNTIME, VIRTUAL, LARGE, CALLBACK, SCRIPT = range(7)
BLOCKS = 7
assert IW6.blocks[VIRTUAL] == "VIRTUAL" and IW6.blocks[SCRIPT] == "SCRIPT" and len(IW6.blocks) == BLOCKS

is_pointer, follows, reference = IW6.is_pointer, IW6.follows, IW6.reference

__all__ = [
    "BLOCKS",
    "CALLBACK",
    "DATA",
    "DURANGO_TYPES_KEY",
    "FOLLOWS",
    "INSERT",
    "INTS",
    "KIND_FLOAT",
    "KIND_POINTER",
    "KIND_SIGNED",
    "KIND_UNSIGNED",
    "LARGE",
    "LAYOUT",
    "OFFSET",
    "PHYSICAL",
    "POINTER_TAG",
    "RUNTIME",
    "SCRIPT",
    "TEMP",
    "VIRTUAL",
    "Field",
    "Layout",
    "Record",
    "Zone",
    "field_code",
    "follows",
    "is_pointer",
    "reference",
]


class Layout(core_layout.Layout):
    """Offsets and sizes of x64-zt's IW6 PC structs, from layout/layout.sh, plus the Durango PDB's
    types x64-zt does not declare."""

    def __init__(self, path=LAYOUT):
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"no IW6 struct layout at {path}: it ships in scripts/cod/data/ (scripts/cod/data/README.md), "
                "or point $IW6_LAYOUT at one"
            )
        super().__init__(path)
        types = durango_types()
        if types and os.path.exists(types):
            self._add_durango(types)

    def _add_durango(self, path):
        with open(path, encoding="utf-8") as fh:
            types = json.load(fh)
        for typename, info in types.items():
            if typename in self.sizes:
                continue
            self.sizes[typename] = info["size"]
            members = self.fields.setdefault(typename, {})
            for offset, size, member, text in info["members"]:
                dims = [int(d) for d in re.findall(r"\[(\d+)\]", text)]
                base = re.sub(r"\[\d+\]", "", text)
                count = 1
                for d in dims:
                    count *= d
                elem = size // count if count else size
                if base.endswith("*"):
                    kind, pointee = KIND_POINTER, types.get(base[:-1], {}).get("size", 0)
                    pointee = pointee or {
                        "char*": 1,
                        "uchar*": 1,
                        "short*": 2,
                        "ushort*": 2,
                        "int*": 4,
                        "uint*": 4,
                        "float*": 4,
                    }.get(base, 0)
                elif base in ("float", "double"):
                    kind, pointee = KIND_FLOAT, 0
                elif base in ("char", "short", "int", "int8", "int16", "int64", "long"):
                    kind, pointee = KIND_SIGNED, 0
                elif base in ("uchar", "ushort", "uint", "uint8", "uint16", "uint64", "ulong", "bool", "wchar"):
                    kind, pointee = KIND_UNSIGNED, 0
                else:
                    kind, pointee = (KIND_UNSIGNED if elem in (1, 2, 4) and base not in types else 0), 0
                e0, e1 = (dims + [0, 0])[:2]
                members[member] = Field(offset, size, elem, pointee, kind, e0, e1, base if base in types else "")


class Zone(core.Zone):
    """An IW6 (or S1) zone: IW6's spec, and IW6's layouts unless a walker brings its own."""

    spec = IW6

    def __init__(self, data, layout=None, stream_files=()):
        super().__init__(data, layout or Layout(), stream_files)
