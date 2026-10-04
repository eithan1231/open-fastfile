"""Reading a decompressed zone the way the game's Load_* functions do, for any game's ZoneSpec.

A zone is the asset data written depth-first, densely: alignment moves only the
destination block's cursor, never the file position, and runtime-block data is
not in the file at all. A reader walks each asset's serializer in order,
consuming exactly the bytes it wrote and moving the block cursors the same way,
so that references into earlier data (a block and an offset) can be resolved.
What differs between games is in spec.py; the loader's rules are the same in all
of them (reverse/iw6-zone/README.md#pointers, reverse/x86-zone/README.md).
"""

import bisect
import struct

from .layout import KIND_POINTER, field_code
from .spec import FOLLOWS, INSERT

INTS_BY_SIZE = {4: "I", 8: "Q"}


class Record:
    """One struct in the zone, read through the layout by field path."""

    __slots__ = ("zone", "type", "at", "block", "cursor", "used")

    def __init__(self, zone, typename, at, block, cursor):
        self.zone, self.type, self.at = zone, typename, at
        self.block, self.cursor = block, cursor  # where the loader put it
        self.used = set()

    def address(self, path):
        """(block, offset) of a field in loaded memory."""
        return self.block, self.cursor + self.zone.layout.resolve(self.type, path)[0]

    def __getitem__(self, path):
        offset, size, kind, _ = self.zone.layout.resolve(self.type, path)
        if kind == KIND_POINTER:
            self.used.add(offset)
        return struct.unpack_from("<" + field_code(kind, size), self.zone.data, self.at + offset)[0]

    def touch(self, *paths):
        """Mark pointer fields as handled without reading them (runtime handles, aliases)."""
        for path in paths:
            self.used.add(self.zone.layout.resolve(self.type, path)[0])

    def bytes(self, path):
        offset, size, _, _ = self.zone.layout.resolve(self.type, path)
        return self.zone.data[self.at + offset : self.at + offset + size]

    def pointee(self, path):
        return self.zone.layout.resolve(self.type, path)[3]


class Zone:
    """A zone being walked: the file position, each block's cursor, and what was read.

    `data` is the whole inflated zone, XFile header included; a walk starts by
    consuming that header. `spec` is the game's ZoneSpec."""

    def __init__(self, data, layout, stream_files=(), spec=None):
        self.spec = spec = spec or self.spec
        self.data = data
        self.stream_files = list(stream_files)  # the fastfile's XStreamFile table (iw6/ff.py)
        self.stream_cursor = 0
        self.layout = layout
        self.size, self.external_size, self.block_sizes = spec.header(data)
        self.temp, self.virtual, self.insert, self.runtime = spec.temp, spec.virtual, spec.insert, spec.runtime_blocks
        self.pointer_size = spec.pointer_size
        self._pointer = "<" + INTS_BY_SIZE[spec.pointer_size]
        self.follows, self.reference, self.is_pointer = spec.follows, spec.reference, spec.is_pointer
        self.pos = 0
        self.blocks = [0] * len(spec.blocks)
        self.block_peak = [0] * len(spec.blocks)  # TEMP is reused, so its header size is a high-water mark
        self.block = self.temp
        self.stack = []
        # Where virtual-block bytes came from, for resolving references.
        self.virtual_starts, self.virtual_files = [], []
        self.strings = {}  # (block, offset) -> text
        self.script_strings = []  # the zone's script strings; a scr_string_t indexes this
        self.slots = {}  # VIRTUAL offset of an asset pointer slot -> (type, name)
        self.unhandled = []  # (struct type, path) of inline pointers a walker never read
        self.checked = []  # records to check once their walker returns
        self.found = {}  # asset type -> name -> what a walker kept (iw6/records.py)

    # --- streams -----------------------------------------------------------

    def push(self, block):
        # DB_PushStreamPos; popping back out of TEMP restores TEMP's cursor (DB_PopStreamPos).
        self.stack.append((self.block, self.blocks[self.temp]))
        self.block = block

    def pop(self):
        leaving = self.block
        self.block, temp = self.stack.pop()
        if leaving == self.temp:
            self.blocks[self.temp] = temp

    def align(self, mask):
        cursor = self.blocks[self.block]
        self.blocks[self.block] = (cursor + mask) & ~mask

    def take(self, size):
        """Consume size bytes into the current block; their file offset, or None for runtime."""
        cursor = self.blocks[self.block]
        self.blocks[self.block] = cursor + size
        self.block_peak[self.block] = max(self.block_peak[self.block], cursor + size)
        if self.block in self.runtime:
            return None
        at = self.pos
        if self.block == self.virtual and size:
            self.virtual_starts.append(cursor)
            self.virtual_files.append((at, size))
        self.pos += size
        if self.pos > len(self.data):
            raise EOFError(f"read past the end of the zone at 0x{at:x}")
        return at

    def insert_pointer(self):
        """DB_InsertPointer: a pointer-sized slot, pointer-aligned, in the insert block. No file bytes."""
        size = self.pointer_size
        self.push(self.insert)
        self.align(size - 1)
        slot = self.blocks[self.insert]
        self.blocks[self.insert] += size
        self.pop()
        return slot

    # --- reading -----------------------------------------------------------

    def u64(self, at):
        return struct.unpack_from("<Q", self.data, at)[0]

    def pointer(self, at):
        """A pointer-sized value at file offset `at`."""
        return struct.unpack_from(self._pointer, self.data, at)[0]

    def struct(self, typename):
        block, cursor = self.block, self.blocks[self.block]
        at = self.take(self.layout.size(typename))
        record = Record(self, typename, at, block, cursor)
        if at is not None:
            self.checked.append(record)
        return record

    def array(self, typename, count):
        size = self.layout.size(typename)
        block, cursor = self.block, self.blocks[self.block]
        at = self.take(size * count)
        if at is None:
            return []
        records = [Record(self, typename, at + size * i, block, cursor + size * i) for i in range(count)]
        self.checked.extend(records)
        return records

    def elements(self, record, path, count, align=None, size=None):
        """An inline array of plain data behind a pointer field, if it follows.
        Returns its file offset (None if it does not follow or is runtime)."""
        value = record[path]
        if not self.follows(value):
            return None
        if value & 0xFFFFFFFF == INSERT:
            # Only loaders that call DB_InsertPointer accept -2; see aliased().
            raise ValueError(f"{record.type}.{path} is -2, which this walker does not expect")
        if align is not None:
            self.align(align)
        return self.take((size if size is not None else record.pointee(path)) * count)

    def aliased(self, record, path, size, align=None, block=None):
        """Plain data whose pointer may alias (Load_XA2Sound, Load_GfxTextureLoad):
        loaded in `block` (TEMP by default), and -2 reserves an insert-block pointer slot first."""
        value = record[path]
        if not self.follows(value):
            return None
        self.push(self.temp if block is None else block)
        if align is not None:
            self.align(align)
        if value & 0xFFFFFFFF == INSERT:
            self.insert_pointer()
        at = self.take(size)
        self.pop()
        return at

    def string(self, value, align=None):
        """Load_XString: a NUL-terminated string if it follows. Returns the text."""
        if not self.follows(value):
            return self.resolve_string(value) if value else None
        if align is not None:
            self.align(align)
        block, cursor = self.block, self.blocks[self.block]
        end = self.data.index(b"\0", self.pos)
        text = self.data[self.pos : end].decode("latin-1")
        self.take(end + 1 - self.pos)
        self.strings[(block, cursor)] = text
        return text

    def field_string(self, record, path, align=None):
        return self.string(record[path], align)

    def strings_at(self, start, count):
        """Strings behind an inline array of `count` string pointers at file offset `start`."""
        if start is None:
            return []
        size = self.pointer_size
        return [self.string(self.pointer(start + size * i)) for i in range(count)]

    def handle(self, value, walker, typename, storage=None):
        """An asset handle (Load_<T>Handle): the asset follows in TEMP, or it aliases a slot.

        DB_ConvertOffsetToAlias reads the pointer stored at the referenced address,
        so the handle's own storage, when it is in VIRTUAL memory, becomes a slot
        later handles may alias, whether the asset followed or was itself aliased."""
        if not value:
            return None
        if self.follows(value):
            self.push(self.temp)
            self.align(3)
            slot = self.insert_pointer() if value & 0xFFFFFFFF == INSERT else None
            result = (typename, walker(self))
            self.pop()
            if slot is not None:
                self.slots[slot] = result
        else:
            result = self.resolve_slot(value)
        if storage is not None and storage[0] == self.virtual:
            self.slots[storage[1]] = result
        return result

    def field_handle(self, record, path, walker, typename):
        return self.handle(record[path], walker, typename, record.address(path))

    def handles(self, record, path, count, walker, typename, align=None):
        """An inline array of asset handles, each asset following in turn."""
        if not self.follows(record[path]):
            return []
        size = self.pointer_size
        self.align(size - 1 if align is None else align)
        block, cursor = self.block, self.blocks[self.block]
        start = self.take(size * count)
        if start is None:
            return []
        return [self.handle(self.pointer(start + size * i), walker, typename, (block, cursor + size * i)) for i in range(count)]

    def check(self):
        """Note every inline pointer of the records read so far that no walker looked at."""
        for record in self.checked:
            for path in self.layout.pointer_paths(record.type):
                offset = self.layout.resolve(record.type, path)[0]
                if offset in record.used:
                    continue
                value = self.pointer(record.at + offset)
                if self.is_pointer(value) and value & 0xFFFFFFFF in (FOLLOWS, INSERT):
                    self.unhandled.append((record.type, path, record.at))
        self.checked = []

    def take_stream_files(self, count):
        """The next `count` XStreamFile entries: the table is consumed in asset order."""
        files = self.stream_files[self.stream_cursor : self.stream_cursor + count]
        if len(files) != count:
            raise ValueError(f"stream file table has {len(self.stream_files)} entries, ran out")
        self.stream_cursor += count
        return files

    def record(self, typename, name, value):
        self.found.setdefault(typename, {})[name] = value
        return value

    # --- references ----------------------------------------------------------

    def resolve_string(self, value):
        return self.strings.get(self.reference(value))

    def resolve_slot(self, value):
        block, offset = self.reference(value)
        return self.slots.get(offset) if block == self.virtual else None

    def located(self, value):
        """File offset of the data behind a pointer that does not follow: an earlier copy the
        loader aliases (DB_GetPackedOffsetStreamPos). None for null or data not from the file."""
        if not value or self.follows(value):
            return None
        block, offset = self.reference(value)
        return self.virtual_file_offset(offset) if block == self.virtual else None

    def virtual_file_offset(self, offset):
        """File offset of a VIRTUAL block offset, if those bytes came from the file."""
        i = bisect.bisect_right(self.virtual_starts, offset) - 1
        if i < 0:
            return None
        at, size = self.virtual_files[i]
        start = self.virtual_starts[i]
        return at + offset - start if offset < start + size else None

    def virtual_slice(self, offset, size):
        """`size` bytes of the VIRTUAL block at `offset`, from the file; zero where they never came from it.

        Spans however many takes it covers, so a caller needs no take boundary of
        its own. Only data already streamed is recorded, so this can never invent
        bytes an asset has not reached yet.
        """
        out = bytearray(size)
        i = max(bisect.bisect_right(self.virtual_starts, offset) - 1, 0)
        while i < len(self.virtual_starts) and self.virtual_starts[i] < offset + size:
            start, (at, taken) = self.virtual_starts[i], self.virtual_files[i]
            lo, hi = max(start, offset), min(start + taken, offset + size)
            if lo < hi:
                out[lo - offset : hi - offset] = self.data[at + lo - start : at + hi - start]
            i += 1
        return bytes(out)
