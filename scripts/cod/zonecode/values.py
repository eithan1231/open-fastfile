"""What a walk hands a dumper: records, arrays and assets, read lazily from the zone's bytes.

Nothing here copies the zone. A `Record` is one struct instance: where the loader put
it (block and cursor), where its bytes are in the zone (`at`, None for a runtime
block, whose bytes are zeros), and `kids`, what its pointers and loaded members
resolved to. Scalars are read from the zone when asked for, so a walk costs one
Python object per struct instance that has pointers, and nothing per float.

Reading by member path: `record["lodInfo[0].dist"]`, `record["info.name"]`. A pointer
member gives what it resolved to (a Record, an Array, an Asset, a str, or None when
null); a scalar gives a number; a scalar array a tuple; an embedded struct a Record.
"""

import struct

FORMATS = {
    (1, False): "B",
    (1, True): "b",
    (2, False): "H",
    (2, True): "h",
    (4, False): "I",
    (4, True): "i",
    (8, False): "Q",
    (8, True): "q",
}


def scalar_format(scalar):
    """The struct format of a zonecode `scalar` ({size, signed, float})."""
    if scalar["float"]:
        return "<" + ("f" if scalar["size"] == 4 else "d")
    return "<" + FORMATS[(scalar["size"], scalar["signed"])]


def mods_size(type_size, mods, pointer_size=4):
    """Bytes of a type after `mods` (outermost first): a pointer is a pointer, an array multiplies."""
    size = type_size
    for mod in reversed(mods):
        size = pointer_size if "ptr" in mod else size * array_count(mod)
    return size


def array_count(mod):
    count = mod["array"]
    return count if isinstance(count, int) else count.get("value", count.get("int", 0))


def _split(path):
    """`a[1][2].b` -> [("a", (1, 2)), ("b", ())]."""
    steps = []
    for part in path.split("."):
        name, _, rest = part.partition("[")
        indices = tuple(int(i) for i in ("[" + rest).strip("[]").split("][")) if rest else ()
        steps.append((name, indices))
    return steps


class StructInfo:
    """One struct or union of zonecode.json, with its members by name."""

    __slots__ = ("name", "size", "leaf", "load", "members", "defn", "program", "_paths")

    def __init__(self, program, defn):
        self.program, self.defn = program, defn
        self.name, self.size, self.leaf = defn["name"], defn["size"], defn["leaf"]
        self.load = defn.get("load")
        self.members = {m["name"]: m for m in defn["members"]}
        self._paths = {}

    def __repr__(self):
        return f"<struct {self.name}>"

    def locate(self, path):
        """(offset, member, remaining mods, struct info of the member) of a member path,
        through embedded structs only."""
        found = self._paths.get(path)
        if found is None:
            found = self._locate(path)
            self._paths[path] = found
        return found

    def _locate(self, path):
        info, offset, member, mods = self, 0, None, ()
        for depth, (name, indices) in enumerate(_split(path)):
            if depth and (member is None or mods):
                raise KeyError(f"{self.name}.{path}: {name} is not inside an embedded struct")
            if info is None:
                raise KeyError(f"{self.name}.{path}: not a struct")
            member = info.members.get(name)
            if member is None:
                raise KeyError(f"{info.name} has no member {name!r}")
            offset += member["offset"]
            mods = member["mods"]
            for i in indices:
                if not mods or "array" not in mods[0]:
                    raise KeyError(f"{info.name}.{name} is not an array")
                mods = mods[1:]
                offset += i * mods_size(member["type_size"], mods)
            info = info.program.struct(member["struct"]) if member["struct"] else None
        return offset, member, tuple(mods), info


class Record:
    """One struct instance in the zone."""

    __slots__ = ("walk", "info", "at", "block", "cursor", "kids")

    def __init__(self, walk, info, at, block, cursor):
        self.walk, self.info, self.at, self.block, self.cursor = walk, info, at, block, cursor
        self.kids = None

    def __repr__(self):
        where = "runtime" if self.at is None else f"0x{self.at:x}"
        return f"<{self.info.name} @{where} block {self.block}+0x{self.cursor:x}>"

    @property
    def type(self):
        return self.info.name

    @property
    def address(self):
        """(block, offset) where the loader put it."""
        return self.block, self.cursor

    def set(self, key, value):
        if self.kids is None:
            self.kids = {}
        self.kids[key] = value

    def __contains__(self, path):
        try:
            self.info.locate(path)
        except KeyError:
            return False
        return True

    def get(self, path, default=None):
        value = self[path]
        return default if value is None else value

    def __getitem__(self, path):
        kids = self.kids
        if kids is not None and path in kids:
            return kids[path]
        # A kid named by a prefix of the path (`lodInfo`, then `[0].dist` inside it).
        head, dot, rest = path.partition(".")
        if kids is not None and dot and head in kids:
            return _descend(kids[head], rest)
        name, bracket, index = head.partition("[")
        if kids is not None and bracket and name in kids:
            value = kids[name]
            for i in (int(i) for i in ("[" + index).strip("[]").split("][")):
                value = value[i]
            return _descend(value, rest) if dot else value
        return self._memory(path)

    def _memory(self, path):
        offset, member, mods, info = self.info.locate(path)
        if mods and "ptr" in mods[0]:
            return None  # a pointer the load program never followed, or null
        at = None if self.at is None else self.at + offset
        if info is not None:
            view = Record(self.walk, info, at, self.block, self.cursor + offset)
            if mods:
                size = mods_size(member["type_size"], mods[1:])
                return Array(self.walk, info.name, size, at, self.block, self.cursor + offset, _count(mods), info=info)
            return view
        scalar = member.get("scalar") if not mods else member.get("element")
        if scalar is None:  # a typedef of an array (`raw_byte16`): its bytes
            return self.bytes(path)
        fmt = scalar_format(scalar)
        if not mods:
            return 0 if at is None else struct.unpack_from(fmt, self.walk.data, at)[0]
        count = mods_size(member["type_size"], mods) // scalar["size"]
        if at is None:
            return (0,) * count
        return struct.unpack_from("<" + fmt[1] * count, self.walk.data, at)

    def pointer(self, path):
        """The raw pointer value of a member as the zone stores it (-1 following, -2 insert,
        otherwise block and offset + 1); 0 in a runtime block."""
        offset = self.info.locate(path)[0]
        return 0 if self.at is None else struct.unpack_from("<I", self.walk.data, self.at + offset)[0]

    def bytes(self, path=None):
        """The member's bytes (the whole struct's without a path), zeros in a runtime block."""
        if path is None:
            offset, size = 0, self.info.size
        else:
            offset, member, mods, _ = self.info.locate(path)
            size = mods_size(member["type_size"], mods)
        if self.at is None:
            return bytes(size)
        return self.walk.data[self.at + offset : self.at + offset + size]

    def unpack(self, fmt, path=None):
        """`struct.unpack` of a member's leading bytes (`"<3f"` for a vec3)."""
        return struct.unpack_from(fmt, self.bytes(path))

    def script_string(self, path):
        """A scr_string_t member, resolved against the zone's script strings."""
        return self.walk.script_string(self[path])

    def captured(self, action):
        """What a custom action kept of this record (actions.py), or None."""
        return (self.kids or {}).get("@" + action)


def _count(mods):
    count = 1
    for mod in mods:
        if "ptr" in mod:
            break
        count *= array_count(mod)
    return count


def _descend(value, rest):
    if not rest:
        return value
    if isinstance(value, (Record, Asset)):
        return value[rest]
    raise KeyError(f"cannot read {rest!r} inside {value!r}")


class Array:
    """`count` elements of `elem` bytes each, at `at` in the zone (None: a runtime block).

    `items` holds the elements when the loader resolved something per element (structs it
    loaded, pointers, strings); otherwise an element is read from the zone when asked for."""

    __slots__ = ("walk", "type", "elem", "at", "block", "cursor", "count", "items", "info", "scalar", "first")

    def __init__(self, walk, type_, elem, at, block, cursor, count, items=None, info=None, scalar=None, first=0):
        self.walk, self.type, self.elem, self.at = walk, type_, elem, at
        self.block, self.cursor, self.count = block, cursor, count
        self.items, self.info, self.scalar = items, info, scalar
        self.first = first  # where this view starts in `items`, which it shares

    def view(self, first, count=None):
        """Elements `first`.. (`count` of them, or to the end), sharing this array's."""
        count = self.count - first if count is None else count
        if not 0 <= first <= self.count or count < 0 or first + count > self.count:
            raise IndexError(f"{self!r} has no elements {first}..{first + count}")
        at = None if self.at is None else self.at + first * self.elem
        cursor = self.cursor + first * self.elem
        return Array(
            self.walk, self.type, self.elem, at, self.block, cursor, count, self.items, self.info, self.scalar, self.first + first
        )

    def __repr__(self):
        where = "runtime" if self.at is None else f"0x{self.at:x}"
        return f"<{self.type}[{self.count}] @{where} block {self.block}+0x{self.cursor:x}>"

    @property
    def address(self):
        return self.block, self.cursor

    def __len__(self):
        return self.count

    def __iter__(self):
        for i in range(self.count):
            yield self[i]

    def __getitem__(self, i):
        if isinstance(i, slice):
            return [self[k] for k in range(*i.indices(self.count))]
        if i < 0:
            i += self.count
        if not 0 <= i < self.count:
            raise IndexError(f"{self.type}[{self.count}] has no element {i}")
        if self.items is not None:
            return self.items[self.first + i]
        at = None if self.at is None else self.at + i * self.elem
        if self.info is not None:
            return Record(self.walk, self.info, at, self.block, self.cursor + i * self.elem)
        if self.scalar is not None:
            return 0 if at is None else struct.unpack_from(self.scalar, self.walk.data, at)[0]
        return self.walk.data[at : at + self.elem] if at is not None else bytes(self.elem)

    def bytes(self):
        """All of it, as a memoryview of the zone (zeros for a runtime block)."""
        size = self.elem * self.count
        if self.at is None:
            return memoryview(bytes(size))
        return memoryview(self.walk.data)[self.at : self.at + size]

    def unpack(self, fmt):
        """`struct.iter_unpack(fmt)` over the elements' bytes: `fmt` is one element."""
        return struct.iter_unpack(fmt, self.bytes())


class Asset:
    """One asset the zone loads: its XAssetType (`type`, the enum; `listed`, OAT's name for
    it), its name and its header Record. Every handle to it resolves to this object."""

    __slots__ = ("type", "listed", "name", "record", "index")

    def __init__(self, type_, listed, name, record, index):
        self.type, self.listed, self.name, self.record, self.index = type_, listed, name, record, index

    def __repr__(self):
        return f"<{self.listed} {self.name!r}>"

    def __getitem__(self, path):
        return self.record[path]


class Pointer:
    """A reference to earlier data that no allocation starts at: the block and offset it names,
    readable through the walk's memory. Rare; the walk counts them (`Walk.loose`)."""

    __slots__ = ("walk", "block", "offset")

    def __init__(self, walk, block, offset):
        self.walk, self.block, self.offset = walk, block, offset

    def __repr__(self):
        return f"<pointer block {self.block}+0x{self.offset:x}>"

    @property
    def address(self):
        return self.block, self.offset

    def bytes(self, size):
        return self.walk.memory(self.block, self.offset, size)
