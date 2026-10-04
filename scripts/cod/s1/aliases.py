"""Check a walk against the zone's own aliases, which fail at the asset that is wrong.

    python3 -m scripts.cod.s1.aliases <zone.ff> [...] [--show N]

A pointer that does not follow names a block and an offset: where the game's
cursor was when it wrote what the pointer means. So each is a check on our
cursors, and unlike a block total it fails locally (reverse/s1-zone/README.md,
"What the walk is checked against"). Three forms of it:

- a string reference must name an address a string was written to;
- a handle reference must name an address a handle was stored at;
- a reference an array field makes must land on an element boundary -- of an
  array read through the same (struct, field) if there is one, else of whichever
  recorded array holds that address.

`CheckedZone` is a drop-in `Zone`; `walkers.report` prints what it found.
"""

import bisect
import collections
import sys

from ..iw6.zone import INSERT, VIRTUAL, Zone, follows, reference
from . import walkers


class CheckedZone(Zone):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.alias_hits = collections.Counter()
        self.alias_misses = []  # (kind, file offset when it was read, detail)
        self._by_field = collections.defaultdict(list)  # (struct, field) -> [(block, start, stride, count)]
        self._starts = collections.defaultdict(list)  # block -> sorted array starts
        self._arrays = collections.defaultdict(list)  # block -> [(start, stride, count)], parallel to _starts

    def _miss(self, kind, detail):
        self.alias_misses.append((kind, self.pos, detail))

    def _record_array(self, key, stride, count):
        block, start = self.block, self.blocks[self.block]
        self._by_field[key].append((block, start, stride, count))
        i = bisect.bisect_right(self._starts[block], start)
        self._starts[block].insert(i, start)
        self._arrays[block].insert(i, (start, stride, count))

    def _containing(self, block, offset):
        """(start, stride) of the recorded array in `block` that holds `offset`, or None."""
        i = bisect.bisect_right(self._starts[block], offset) - 1
        if i < 0:
            return None
        start, stride, count = self._arrays[block][i]
        return (start, stride) if offset < start + stride * count else None

    def string(self, value, align=None):
        if value and not follows(value):
            if reference(value) in self.strings:
                self.alias_hits["string"] += 1
            else:
                self._miss("string", reference(value))
        return super().string(value, align)

    def handle(self, value, walker, typename, storage=None):
        if value and not follows(value):
            block, offset = reference(value)
            if block == VIRTUAL and offset in self.slots:
                self.alias_hits["handle"] += 1
            else:
                self._miss("handle", (typename, block, offset))
        return super().handle(value, walker, typename, storage)

    def array(self, typename, count):
        self._record_array(("array", typename), self.layout.size(typename), count)
        return super().array(typename, count)

    def elements(self, record, path, count, align=None, size=None):
        value = record[path]
        key = (record.type, path.split("[")[0])
        if value and not follows(value):
            self._check_element(key, *reference(value))
        elif follows(value) and value & 0xFFFFFFFF != INSERT:
            if align is not None:
                self.align(align)
            self._record_array(key, size if size is not None else record.pointee(path), count)
        return super().elements(record, path, count, align, size)

    def _check_element(self, key, block, offset):
        for b, start, stride, count in self._by_field.get(key, ()):
            if b == block and start <= offset < start + max(stride * count, 1):
                break
        else:
            found = self._containing(block, offset)
            if found is None:
                self.alias_hits["element, no array recorded there"] += 1
                return
            start, stride = found
        if stride and (offset - start) % stride:
            self._miss("element", (key, block, offset, (offset - start) % stride))
        else:
            self.alias_hits["element"] += 1

    def alias_report(self, assets):
        """Lines for walkers.report: the hits, and each miss against the asset it was read in."""
        lines = [f"      aliases: {', '.join(f'{n:,} {kind}' for kind, n in self.alias_hits.items())}"]
        headers = [at for _, _, at in assets]
        for kind, count in collections.Counter(kind for kind, _, _ in self.alias_misses).items():
            first = next(m for m in self.alias_misses if m[0] == kind)
            i = bisect.bisect_right(headers, first[1]) - 1
            where = f"asset {i} ({assets[i][0]} {assets[i][1]})" if i >= 0 else "the zone header"
            lines.append(f"      ALIAS MISS {kind} x{count}: first in {where}: {first[2]}")
        return lines


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    show = int(sys.argv[sys.argv.index("--show") + 1]) if "--show" in sys.argv else 24
    ok = True
    for arg in sys.argv[1:]:
        if arg.startswith("--") or arg.isdigit():
            continue
        ok = walkers.report(arg, show, zone_type=CheckedZone) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
