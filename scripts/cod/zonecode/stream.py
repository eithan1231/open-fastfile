"""The zone as OAT's ZoneInputStream sees it: block cursors, and what each block's memory holds.

`zone.core.Zone` already moves the cursors the loader's way (push, pop, TEMP rewound on
pop, runtime blocks zero-filled, insert slots). What an interpreter needs on top is the
loaded memory itself, because a pointer that does not follow names an address in it:

- **Intervals.** Every read records which zone bytes landed at which block offset, merged
  while both run on together. A reference is then a lookup, and TEMP's intervals are cut
  back when TEMP is rewound, so an address in TEMP means what it means at that moment.
- **Allocations.** Every object an allocation produced (a Record, an Array), by block
  offset, so that `ConvertOffsetToPointer` gives back the very object loaded there.
- **Aliases.** `ConvertOffsetToAlias` reads the pointer *stored* at an address. Those
  addresses are asset-handle slots, insert slots and the XAsset list, and each is filed
  here with what its pointer resolved to. A slot in TEMP is not filed: its memory is
  reused, which is why the zone reserves an insert slot for anything aliased later.
"""

import bisect
from array import array

from ..zone.core import Zone
from ..zone.spec import FOLLOWS, INSERT


class WalkError(Exception):
    """The walk cannot go on: the zone disagrees with its load program at this point."""


class Stream(Zone):
    def __init__(self, data, spec):
        super().__init__(data, None, spec=spec)
        count = len(spec.blocks)
        self.pos = spec.header_size  # the XFile header is not part of any block
        self.normal = frozenset(i for i in range(count) if i not in self.runtime)
        self.iv_start = [array("q") for _ in range(count)]
        self.iv_at = [array("q") for _ in range(count)]
        self.iv_len = [array("q") for _ in range(count)]
        self.reg_start = [[] for _ in range(count)]
        self.reg_obj = [[] for _ in range(count)]
        self.aliases = {}
        self.virtual_starts = self.virtual_files = None  # the base class's VIRTUAL-only map; intervals replace it

    # --- cursors -----------------------------------------------------------

    def pop(self):
        leaving = self.block
        super().pop()
        if leaving == self.temp:
            self._cut(self.temp, self.blocks[self.temp])

    def align_to(self, alignment):
        """Alloc(align): round the current block's cursor up to a multiple of `alignment`."""
        if alignment > 1:
            cursor = self.blocks[self.block]
            self.blocks[self.block] = (cursor + alignment - 1) // alignment * alignment

    def take(self, size):
        """Load `size` bytes into the current block: their zone offset, or None in a runtime block."""
        block = self.block
        cursor = self.blocks[block]
        end = cursor + size
        self.blocks[block] = end
        if end > self.block_peak[block]:
            self.block_peak[block] = end
        if block in self.runtime:
            return None
        at = self.pos
        self.pos = at + size
        if self.pos > len(self.data):
            raise WalkError(f"read of {size} bytes at 0x{at:x} runs past the end of the zone (0x{len(self.data):x})")
        if size:
            self._interval(block, cursor, at, size)
        return at

    def take_cstring(self):
        """LoadNullTerminated: a NUL-terminated string from the zone into the current block.
        It reads the zone even in a runtime block. (text, zone offset)."""
        at = self.pos
        end = self.data.find(b"\0", at)
        if end < 0:
            raise WalkError(f"no NUL after the string at 0x{at:x}")
        size = end + 1 - at
        block = self.block
        cursor = self.blocks[block]
        self.blocks[block] = cursor + size
        if cursor + size > self.block_peak[block]:
            self.block_peak[block] = cursor + size
        self.pos = end + 1
        self._interval(block, cursor, at, size)
        return self.data[at:end].decode("latin-1"), at

    def insert_pointer(self):
        """InsertPointerNative: a pointer-aligned slot in the insert block, with no zone bytes."""
        slot = super().insert_pointer()
        end = slot + self.pointer_size
        if end > self.block_peak[self.insert]:
            self.block_peak[self.insert] = end
        return slot

    # --- memory ------------------------------------------------------------

    def _interval(self, block, cursor, at, size):
        starts, ats, lens = self.iv_start[block], self.iv_at[block], self.iv_len[block]
        if starts:
            last = len(starts) - 1
            if starts[last] + lens[last] == cursor and ats[last] + lens[last] == at:
                lens[last] += size
                return
        starts.append(cursor)
        ats.append(at)
        lens.append(size)

    def _cut(self, block, cursor):
        """TEMP was rewound to `cursor`: what lay beyond it is no longer there."""
        starts, lens = self.iv_start[block], self.iv_len[block]
        while starts and starts[-1] >= cursor:
            starts.pop()
            self.iv_at[block].pop()
            lens.pop()
        if starts and starts[-1] + lens[-1] > cursor:
            lens[-1] = cursor - starts[-1]
        regs, objs = self.reg_start[block], self.reg_obj[block]
        while regs and regs[-1] >= cursor:
            regs.pop()
            objs.pop()

    def file_offset(self, block, offset, size=1):
        """The zone offset of `size` bytes of memory at `block`+`offset`, if one read put them all there."""
        starts = self.iv_start[block]
        i = bisect.bisect_right(starts, offset) - 1
        if i < 0:
            return None
        start, length = starts[i], self.iv_len[block][i]
        if offset + size <= start + length:
            return self.iv_at[block][i] + offset - start
        return None

    def memory(self, block, offset, size):
        """`size` bytes of loaded memory; zeros where nothing from the zone landed (runtime blocks)."""
        out = bytearray(size)
        starts, ats, lens = self.iv_start[block], self.iv_at[block], self.iv_len[block]
        i = max(bisect.bisect_right(starts, offset) - 1, 0)
        while i < len(starts) and starts[i] < offset + size:
            lo, hi = max(starts[i], offset), min(starts[i] + lens[i], offset + size)
            if lo < hi:
                at = ats[i] + lo - starts[i]
                out[lo - offset : hi - offset] = self.data[at : at + hi - lo]
            i += 1
        return bytes(out)

    def cstring_at(self, block, offset):
        """The NUL-terminated string in memory at `block`+`offset`."""
        at = self.file_offset(block, offset)
        if at is not None:
            end = self.data.find(b"\0", at)
            if end >= 0 and self.file_offset(block, offset, end + 1 - at) is not None:
                return self.data[at:end].decode("latin-1")
        text = bytearray()
        while True:
            chunk = self.memory(block, offset + len(text), 64)
            end = chunk.find(b"\0")
            if end >= 0:
                return (text + chunk[:end]).decode("latin-1")
            text += chunk
            if len(text) > 1 << 20:
                raise WalkError(f"no NUL within 1 MB of block {block}+0x{offset:x}")

    # --- allocations and aliases -------------------------------------------

    def register(self, block, cursor, obj):
        """File what an allocation at `block`+`cursor` produced, for later pointers to it."""
        if block in self.normal:
            regs = self.reg_start[block]
            if regs and regs[-1] >= cursor:
                if regs[-1] == cursor:
                    # An empty allocation shares its address with whatever follows it,
                    # and only that can be what a later pointer means.
                    self.reg_obj[block][-1] = obj
                    return
                raise WalkError(f"allocation at block {block}+0x{cursor:x} is behind the last one (0x{regs[-1]:x})")
            regs.append(cursor)
            self.reg_obj[block].append(obj)

    def allocation(self, block, offset):
        """(start, object) of the allocation holding `block`+`offset`, or None."""
        regs = self.reg_start[block]
        i = bisect.bisect_right(regs, offset) - 1
        return (regs[i], self.reg_obj[block][i]) if i >= 0 else None

    def file_slot(self, block, offset, value):
        """File what the pointer stored at `block`+`offset` resolved to, for later aliases."""
        if block in self.normal and block != self.temp:
            self.aliases[(block, offset)] = value

    def referenced(self, value):
        """(block, offset) a reference names, checked to be memory already loaded."""
        if value in (FOLLOWS, INSERT):
            raise WalkError(f"0x{value:x} is not a reference")
        block, offset = self.reference(value)
        if offset >= self.blocks[block] and offset >= self.block_peak[block]:
            raise WalkError(
                f"reference 0x{value:x} names block {block}+0x{offset:x}, "
                f"beyond what that block has loaded (0x{self.blocks[block]:x})"
            )
        return block, offset
