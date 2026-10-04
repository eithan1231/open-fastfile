"""What a compiled Black Ops II script says, without an opcode table.

A T6 script (`\\x80GSC\\r\\n\\0\\x06`) keeps its names outside the bytecode: the header
points at an export table (every function, by name and address), an import table
(every call to another function, by namespace and name, with each call site's
address) and a string fixup table (every string literal, with each use's address).
So what a function calls, and which strings it pushes, in address order, are
exact. Numbers, locals and control flow are not: they are in the bytecode, whose
opcode table is the VM's. T6 pushes a call's arguments last first, so the strings
a call is handed come before it, reversed — an order read that way is inferred.

The pipeline's copy of reverse/t6-zombies/gsc.py's table reader, which is where the
layout was worked out and checked on all 417 zombies scripts.
"""

import struct
from dataclasses import dataclass

MAGIC = b"\x80GSC\r\n\x00\x06"
_HEADER = struct.Struct("<8sI9IHHHHHHBBBB")
_FIELDS = (
    "magic crc include animtree cseg strfix exports imports fixup profile csegsize name "
    "strfixcount expcount impcount fixupcount profcount inccount atcount flags pad"
).split()


@dataclass(frozen=True)
class Event:
    """One call site or string use: its address, the function it is in, and what it is."""

    site: int
    function: str | None
    kind: str  # "call" or "str"
    text: str  # a string's text, or a call's `namespace::name` (just `name` for a builtin)


class Script:
    """One compiled script's tables. Raises ValueError on anything but a T6 PC script whose tables fit."""

    def __init__(self, data, path=""):
        if data[:8] != MAGIC:
            raise ValueError(f"{path}: not a T6 compiled script")
        try:
            self._read(data, path)
        except (struct.error, IndexError, UnicodeDecodeError) as exc:
            raise ValueError(f"{path}: a table runs past the file") from exc

    def _read(self, data, path):
        h = dict(zip(_FIELDS, _HEADER.unpack_from(data, 0), strict=True))
        self.data, self.path = data, path
        self.includes = [self._string(o) for o in struct.unpack_from(f"<{h['inccount']}I", data, h["include"])]
        functions, calls, strings = [], [], []
        at = h["exports"]
        for _ in range(h["expcount"]):
            _crc, addr, name, _params, _flags = struct.unpack_from("<IIHBB", data, at)
            functions.append((addr, self._string(name)))
            at += 12
        if at != h["imports"]:
            raise ValueError(f"{path}: the exports end at {at:#x}, not where the imports begin")
        at = h["imports"]
        for _ in range(h["impcount"]):
            name, ns, n, _params, _flags = struct.unpack_from("<HHHBB", data, at)
            space = self._string(ns)
            text = f"{space}::{self._string(name)}" if space else self._string(name)
            calls += [(site, text) for site in struct.unpack_from(f"<{n}I", data, at + 8)]
            at += 8 + 4 * n
        at = h["strfix"]
        for _ in range(h["strfixcount"]):
            s, n, _kind = struct.unpack_from("<HBB", data, at)
            strings += [(site, self._string(s)) for site in struct.unpack_from(f"<{n}I", data, at + 4)]
            at += 4 + 4 * n
        if at != h["fixup"]:
            raise ValueError(f"{path}: the string fixups end at {at:#x}, not where the fixups begin")
        lo, hi = h["cseg"], h["cseg"] + h["csegsize"]
        if any(not lo <= site < hi for site, _ in calls + strings + functions):
            raise ValueError(f"{path}: a reference outside the code segment")
        self.functions = sorted(functions)
        rows = [(site, "call", text) for site, text in calls] + [(site, "str", text) for site, text in strings]
        self.events = [Event(site, self._owner(site), kind, text) for site, kind, text in sorted(rows)]

    def _string(self, offset):
        return self.data[offset : self.data.index(b"\0", offset)].decode("latin-1")

    def _owner(self, site):
        best = None
        for addr, name in self.functions:
            if addr > site:
                break
            best = name
        return best

    def of(self, function):
        """The events inside one function, in address order."""
        return [e for e in self.events if e.function == function]


def strings_before(events, index):
    """The strings pushed since the previous call, before `events[index]`, in address order."""
    out = []
    for e in reversed(events[:index]):
        if e.kind == "call":
            break
        out.append(e.text)
    return out[::-1]
