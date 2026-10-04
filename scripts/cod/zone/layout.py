"""A game's struct layouts: offsets, sizes and kinds of every member, read by dotted path.

The rows come from a generated `layout.json` (reverse/iw6-zone/layout/gen.py writes the
program that prints them): `[type, member, offset, size, elem, pointee, kind, e0, e1, base]`,
where a row with no member is the struct's size. The 32-bit games' rows carry an eleventh
column, `alignof` (reverse/x86-zone/README.md#struct-layouts-outlayoutjson), kept in `aligns`.
"""

import json
import os

KIND_UNSIGNED, KIND_SIGNED, KIND_FLOAT, KIND_POINTER = 1, 2, 3, 4
INTS = {1: "B", 2: "H", 4: "I", 8: "Q"}


def field_code(kind, size):
    """The struct format character of a scalar field of `kind` and `size` bytes."""
    if kind == KIND_FLOAT:
        return "f" if size == 4 else "d"
    return INTS[size].lower() if kind == KIND_SIGNED else INTS[size]


class Field:
    __slots__ = ("offset", "size", "elem", "pointee", "kind", "extents", "base")

    def __init__(self, offset, size, elem, pointee, kind, e0, e1, base):
        self.offset, self.size, self.elem, self.pointee, self.kind = offset, size, elem, pointee, kind
        self.extents = [e for e in (e0, e1) if e]
        self.base = base


class Layout:
    """The layout rows of one game, from `path`."""

    def __init__(self, path):
        if not os.path.exists(path):
            raise FileNotFoundError(f"no struct layout at {path}")
        with open(path, encoding="utf-8") as fh:
            self._add_rows(json.load(fh))
        self._cache = {}

    @classmethod
    def from_rows(cls, rows):
        """A layout from rows already in memory: a test's, or a caller that merges several files."""
        layout = cls.__new__(cls)
        layout._add_rows(rows)
        layout._cache = {}
        return layout

    def _add_rows(self, rows):
        self.sizes, self.fields, self.aligns = {}, {}, {}
        for row in rows:
            typename, member, offset, size, elem, pointee, kind, e0, e1, base = row[:10]
            if not typename:
                continue
            members = self.fields.setdefault(typename, {})
            if member:
                members[member] = Field(offset, size, elem, pointee, kind, e0, e1, base)
            else:
                self.sizes[typename] = size
                if len(row) > 10:
                    self.aligns[typename] = row[10]

    def size(self, typename):
        return self.sizes[typename]

    def resolve(self, typename, path):
        """(offset, size, kind, pointee) of a dotted, optionally indexed, member path."""
        key = (typename, path)
        cached = self._cache.get(key)
        if cached:
            return cached
        offset, current, field, size = 0, typename, None, 0
        for part in path.split("."):
            name, _, rest = part.partition("[")
            field = self.fields[current][name]
            offset += field.offset
            size = field.size
            if rest:
                indices = [int(i) for i in ("[" + rest).strip("[]").split("][")]
                for depth, index in enumerate(indices):
                    inner = field.elem
                    for extent in field.extents[depth + 1 :]:
                        inner *= extent
                    offset += index * inner
                size = field.elem
                for extent in field.extents[len(indices) :]:
                    size *= extent
            current = field.base
        result = (offset, size, field.kind, field.pointee)
        self._cache[key] = result
        return result

    def pointer_paths(self, typename, prefix="", depth=0):
        """Every pointer member of a struct, nested structs and small arrays included."""
        key = ("paths", typename, prefix)
        if key in self._cache:
            return self._cache[key]
        out = []
        for name, field in self.fields.get(typename, {}).items():
            count = 1
            for extent in field.extents:
                count *= extent
            if count > 64:
                continue
            if not field.extents:
                paths = [f"{prefix}{name}"]
            elif len(field.extents) == 1:
                paths = [f"{prefix}{name}[{i}]" for i in range(field.extents[0])]
            else:
                paths = [f"{prefix}{name}[{i}][{j}]" for i in range(field.extents[0]) for j in range(field.extents[1])]
            for path in paths:
                if field.kind == KIND_POINTER:
                    out.append(path)
                elif field.base in self.fields and depth < 6:
                    out.extend(self.pointer_paths(field.base, path + ".", depth + 1))
        self._cache[key] = out
        return out
