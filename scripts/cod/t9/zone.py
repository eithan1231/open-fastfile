"""A decoded T9 zone: its asset list, and where each listed asset's record is in the file.

The zone opens with the XAssetList: u64 string count, -1, -1, u64 asset count,
-1, then the string pointers and the strings (a 3-byte prefix whose third byte
is the length + 1, the body, NUL), then one 16-byte XAsset per asset: u64 type,
u64 header pointer (-1: loaded inline, next in the stream). The records follow
in list order.

An asset pointer inside asset data is an *alias*: `(4 << 60 | slot) + 1`, where
`slot` is that asset's XAsset in the virtual block, `slot base + 16 * j`. The
base is a few bytes past the list's file offset less its 0x28-byte header (the
strings' layout in the virtual block is not settled: 0x141d0 on mp_kgb, 0x32728
on core_common), so it is chosen among the 8-aligned candidates there as the one
that lands the zone's texture-table aliases on images, and refused under 95%.

Nothing says where each asset's record starts, so `Index` finds them by content:
the three kinds the export reads (materials, images, meshes), real or stub, each
by its own signature (`MATERIAL`, `IMAGE`, `MESH`), then pairs the n-th record
of a stretch of the file with the n-th list entry of that type over the same
stretch. The stretches are cut at *anchors*: a material whose own texture table
names the image listed just before it, and whose record follows an image's, is
that image's successor in the list. A stretch whose counts disagree (a record
the signatures missed) is left unpaired rather than guessed: an asset with no
known record is exported without it (a surface untextured), never with another's.
reverse/t9-zone/README.md.
"""

import bisect
import re
import struct

from . import models

LIST_HEADER = 0x28
ALIAS_TAG = 4 << 60
NULL = 0xFFFFFFFFFFFFFFFF
NAME_MASK = (1 << 63) - 1

# Asset types (the list's u64), as far as the export needs them.
XMODEL, BOUNDS, MESH, MATERIAL, TECHSET, IMAGE, LOAD_LIST = 6, 7, 9, 10, 15, 16, 74

# An XHash: a u64 name, then 8 zero bytes. A real asset's name has bit 63 clear;
# a stub's (an asset another zone carries) has it set, and the rest of its record
# is zero. Each pattern starts at a fixed distance into the record (MATCH_AT) so
# that the regex engine, not Python, rejects most of the file; a real record's
# match consumes one byte, so that no match can swallow the start of the next.
_REAL_MATERIAL = re.compile(rb"(?s)\x00(?=\x00{7}.{32}.{3}\x00{4}\x40)")  # the XHash's zeros, then the +0x30 alias
_REAL_IMAGE = re.compile(rb"(?s)\x00(?=\x00{7}.{32}\xff{8})")  # the XHash's zeros, then -1 at +0x30
_STUB_MATERIAL = re.compile(rb"(?s)[\x80-\xff]\x00{328}[^\x00]")  # 0x150-byte record
_STUB_IMAGE = re.compile(rb"(?s)[\x80-\xff]\x00{158}.\x00{41}[^\x00]")  # 0xd0, one byte at +0xa6
REAL_MATCH_AT, STUB_MATCH_AT = 8, 7

MATERIAL_RECORD = 0x150
MATERIAL_TECHSET = 0x30
IMAGE_RECORD = 0xD0
# A texture-table entry (T8's MaterialTextureDef, 24 bytes): u64 image alias, u32
# slot hash, f32 1.0, f32 1.0, u32 shader slot. The two 1.0s are what finds one.
TEXTURE_ONES = b"\x00\x00\x80\x3f\x00\x00\x80\x3f"


def align(n, a):
    return (n + a - 1) & ~(a - 1)


def plausible(name8):
    """A hash, not a run of padding or a float: seven or more distinct bytes."""
    return len(set(name8)) >= 7


def name_of(value):
    """The dump tree's name for a hashed asset: the hash in hex, bit 63 cleared."""
    return f"{value & NAME_MASK:016x}"


class Zone:
    def __init__(self, data, name):
        self.data = data
        self.name = name
        strings, _, _, count = struct.unpack_from("<QqqQ", data, 0)
        at = LIST_HEADER + 8 * strings
        for _ in range(strings - 1):
            at += 3 + data[at + 2]
        self.list_at = at
        self.types = [struct.unpack_from("<Q", data, at + 16 * j)[0] for j in range(count)]
        self.data_at = at + 16 * count
        self.slot_base = self._find_slot_base()
        self._index = None

    def _find_slot_base(self, sample=3000):
        values = []
        at = self.data.find(TEXTURE_ONES, self.data_at)
        while at >= 0 and len(values) < sample:
            value = self.u64(at - 12)
            if value >> 56 == 0x40:
                values.append((value & ((1 << 56) - 1)) - 1)
            at = self.data.find(TEXTURE_ONES, at + 1)
        guess = align(self.list_at - LIST_HEADER, 16)
        if not values:
            return guess
        n = len(self.types)

        def hits(base):
            return sum(
                1 for v in values if (v - base) % 16 == 0 and 0 <= (v - base) // 16 < n and self.types[(v - base) // 16] == IMAGE
            )

        best = max(range(guess - 0x20, guess + 0x28, 8), key=hits)
        if hits(best) < 0.95 * len(values):
            raise SystemExit(
                f"{self.name}: no asset-list base lands its texture aliases on images ({hits(best)} of {len(values)})"
            )
        return best

    def u64(self, at):
        return struct.unpack_from("<Q", self.data, at)[0]

    def alias(self, value):
        """The list entry a u64 aliases, or None."""
        if value >> 60 != 4:
            return None
        slot = (value & ((1 << 60) - 1)) - 1 - self.slot_base
        if slot < 0 or slot % 16 or slot // 16 >= len(self.types):
            return None
        return slot // 16

    def pointer(self, value):
        """A block-4 pointer's virtual offset, or None for -1 and non-pointers."""
        if value == NULL or value >> 60 != 4:
            return None
        return (value & ((1 << 60) - 1)) - 1

    def is_stub(self, at):
        return self.data[at + 7] >= 0x80

    @property
    def index(self):
        if self._index is None:
            self._index = Index(self)
        return self._index


def find_materials(zone):
    """Every material record, real (its +0x30 aliases a technique set) or stub."""
    d, types = zone.data, zone.types
    found = []
    for m in _REAL_MATERIAL.finditer(d, zone.data_at + REAL_MATCH_AT, len(d) - MATERIAL_RECORD):
        h = m.start() - REAL_MATCH_AT
        if d[h + 7] >= 0x80 or not plausible(d[h : h + 8]):
            continue
        j = zone.alias(struct.unpack_from("<Q", d, h + MATERIAL_TECHSET)[0])
        if j is not None and types[j] == TECHSET:
            found.append(h)
    found += _stubs(d, _STUB_MATERIAL, zone.data_at)
    return sorted(found)


def _stubs(d, pattern, start):
    out = []
    for m in pattern.finditer(d, start + STUB_MATCH_AT):
        h = m.start() - STUB_MATCH_AT
        if plausible(d[h : h + 8]):
            out.append(h)
    return out


def image_header_ok(d, h):
    fmt = struct.unpack_from("<I", d, h + 0x9C)[0]
    width, height = struct.unpack_from("<2H", d, h + 0xA0)
    total = struct.unpack_from("<I", d, h + 0x98)[0]
    pixels = struct.unpack_from("<Q", d, h + 0x10)[0]
    return (
        0 < fmt < 133
        and 0 < width <= 16384
        and 0 < height <= 16384
        and 0 < total < 1 << 30
        and d[h + 0x30 : h + 0x38] == b"\xff" * 8
        and (pixels in (0, NULL) or pixels >> 60 == 4)
        and 1 <= d[h + 0xB1] <= 16
    )


def find_images(zone):
    """Every image record, real (a plausible header) or stub."""
    d = zone.data
    found = []
    for m in _REAL_IMAGE.finditer(d, zone.data_at + REAL_MATCH_AT, len(d) - IMAGE_RECORD - 0x40):
        h = m.start() - REAL_MATCH_AT
        if d[h + 7] < 0x80 and plausible(d[h : h + 8]) and image_header_ok(d, h):
            found.append(h)
    found += _stubs(d, _STUB_IMAGE, zone.data_at)
    return sorted(found)


def texture_table(zone, h, end):
    """(file offset, entries) of a material's inline texture table, or None.

    The table follows the record, after the other inline children; it is found
    by its 1.0 pair before `end` (the next record) and must hold exactly the
    material's texture count (the byte at +0x140)."""
    d = zone.data
    at = d.find(TEXTURE_ONES, h + MATERIAL_RECORD, end)
    if at < 0:
        return None
    start = at - 12
    entries = []
    at = start
    while d[at + 12 : at + 20] == TEXTURE_ONES:
        image, slot = struct.unpack_from("<QI", d, at)
        entries.append((image, slot))
        at += 24
    return (start, entries) if len(entries) == d[h + 0x140] else None


def _longest_increasing(pairs):
    """The longest run of (file, index) pairs whose indices increase with the file offset."""
    tails, tail_at, prev = [], [], [-1] * len(pairs)
    for k, (_, x) in enumerate(pairs):
        p = bisect.bisect_left(tails, x)
        if p == len(tails):
            tails.append(x)
            tail_at.append(k)
        else:
            tails[p] = x
            tail_at[p] = k
        prev[k] = tail_at[p - 1] if p else -1
    out = []
    k = tail_at[-1] if tail_at else -1
    while k >= 0:
        out.append(pairs[k])
        k = prev[k]
    return out[::-1]


class Index:
    """List entry <-> record offset, for materials, images and meshes."""

    def __init__(self, zone):
        self.zone = zone
        types = zone.types
        self.records = {
            MATERIAL: find_materials(zone),
            IMAGE: find_images(zone),
            MESH: [k - models.MESH_NAME for k in models.scan_meshes(zone.data, zone.data_at)],
        }
        self.entries = {t: [j for j, u in enumerate(types) if u == t] for t in self.records}
        both = sorted([(h, MATERIAL) for h in self.records[MATERIAL]] + [(h, IMAGE) for h in self.records[IMAGE]])
        self._both = [h for h, _ in both]
        materials = self.records[MATERIAL]
        # Anchors: a real material whose record follows an image's and whose table
        # names, as its last image, the entry right before a material entry.
        anchors = []
        for k, h in enumerate(materials):
            if zone.is_stub(h) or zone.u64(h + 0x38) != NULL:
                continue
            q = bisect.bisect_left(self._both, h)
            if q == 0 or both[q - 1][1] != IMAGE:
                continue
            end = materials[k + 1] if k + 1 < len(materials) else len(zone.data)
            table = texture_table(zone, h, end)
            if not table:
                continue
            js = [zone.alias(image) for image, _ in table[1]]
            if None in js or not js:
                continue
            j = max(js)
            if types[j] == IMAGE and j + 1 < len(types) and types[j + 1] == MATERIAL:
                anchors.append((h, j + 1))
        self.at = {}  # entry -> record offset
        for h, j in _longest_increasing(sorted(anchors)):
            self.at[j] = h
        # Pair records to entries between anchors, per type, where the counts agree;
        # every pairing made is an anchor for the next pass.
        for _ in range(8):
            before = len(self.at)
            chain = _longest_increasing(sorted((h, j) for j, h in self.at.items()))
            self.at = {j: h for h, j in chain}
            for (f1, i1), (f2, i2) in zip(chain, chain[1:], strict=False):
                for t, recs in self.records.items():
                    ents = self.entries[t]
                    a, b = bisect.bisect_right(ents, i1), bisect.bisect_left(ents, i2)
                    x, y = bisect.bisect_right(recs, f1), bisect.bisect_left(recs, f2)
                    if b - a == y - x:
                        for q in range(b - a):
                            self.at[ents[a + q]] = recs[x + q]
            if len(self.at) == before:
                break
        self.entry_of = {h: j for j, h in self.at.items()}
        self._by_name = None

    def record(self, j):
        return self.at.get(j)

    def material_end(self, h):
        """Where the record after material `h` starts: its inline data ends there at the latest."""
        q = bisect.bisect_right(self._both, h)
        return self._both[q] if q < len(self._both) else len(self.zone.data)

    def by_name(self, kind):
        """{name hash: record offset} of this zone's real records of `kind`."""
        if self._by_name is None:
            self._by_name = {}
        if kind not in self._by_name:
            d = self.zone.data
            self._by_name[kind] = {struct.unpack_from("<Q", d, h)[0]: h for h in self.records[kind] if not self.zone.is_stub(h)}
        return self._by_name[kind]

    def coverage(self):
        return {t: (sum(1 for j in self.entries[t] if j in self.at), len(self.entries[t])) for t in self.records}
