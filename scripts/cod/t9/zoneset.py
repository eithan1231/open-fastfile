"""The zones a map loads with it, and the resolution of the map's stubs against them.

Every zone ends with a load list (type 74): XHash, u64 count, u64 -1 (the
entries, inline), then count x (u64 flags, u64 name) with the same flags in
every entry, then the names that were -1, NUL-terminated, in order (the first
entry points at a name loaded earlier, the map's own, and has none here).
The names are stream packages (`core`, `core_hd`, ...) and zones
(`core_bootstrap`, `core_ui`, `core_common` for mp_kgb); the ones with a
fastfile beside the map are the zones.

A stub is an asset whose record is its XHash with bit 63 of the name set and
zeros after it; the real asset is the record with the same name, bit 63 clear,
in one of those zones (reverse/t9-zone/types_stubs.py: 1,660 of mp_kgb's 1,682
images and 776 of its 782 materials resolve so).
"""

import os
import re
import struct

from . import ff
from .zone import IMAGE, MATERIAL, NAME_MASK, NULL, Zone

_LOAD_ENTRIES = re.compile(rb"(?s)(.{8})\xff{8}\1\xff{8}\1\xff{8}")


def load_list(zone):
    """The names a zone's load list gives, in order; [] when it has none."""
    d = zone.data
    matches = list(_LOAD_ENTRIES.finditer(d, zone.data_at))
    if not matches:
        return []
    at, flags = matches[-1].start(), matches[-1].group(1)
    while at >= 16 and d[at - 16 : at - 8] == flags and (d[at - 8 : at] == b"\xff" * 8 or d[at - 1] == 0x40):
        at -= 16
    count, array = struct.unpack_from("<QQ", d, at - 16)
    end = at + 16 * count
    if array != NULL or not 0 < count < 256 or any(d[at + 16 * i : at + 16 * i + 8] != flags for i in range(count)):
        return []
    names, p = [], end
    for i in range(count):
        if struct.unpack_from("<Q", d, at + 16 * i + 8)[0] != NULL:
            continue
        e = d.index(b"\0", p)
        names.append(d[p:e].decode("latin-1"))
        p = e + 1
    return names


class ZoneSet:
    """A map's zone and the companion zones its load list names, inflated on first use."""

    def __init__(self, zone, zone_dir):
        self.zone = zone
        self.zone_dir = zone_dir
        self.companions = [n for n in load_list(zone) if os.path.exists(os.path.join(zone_dir, n + ".ff"))]
        self._loaded = {}

    def companion(self, name):
        if name not in self._loaded:
            path = os.path.join(self.zone_dir, name + ".ff")
            print(f"      inflating {name}.ff for the stubs {self.zone.name} names")
            self._loaded[name] = Zone(ff.inflate(path), name)
        return self._loaded[name]

    def real(self, zone, h, kind):
        """(zone, record) of the asset whose record in `zone` is at `h`: itself, or a stub resolved."""
        if not zone.is_stub(h):
            return zone, h
        name = struct.unpack_from("<Q", zone.data, h)[0] & NAME_MASK
        for companion in self.companions:
            other = self.companion(companion)
            at = other.index.by_name(kind).get(name)
            if at is not None:
                return other, at
        return None, None

    def entry(self, zone, j, kind):
        """(zone, record) of list entry `j` of `zone`, a stub resolved; (None, None) when unknown."""
        if j is None or zone.types[j] != kind:
            return None, None
        h = zone.index.record(j)
        if h is None:
            return None, None
        return self.real(zone, h, kind)


__all__ = ["IMAGE", "MATERIAL", "ZoneSet", "load_list"]
