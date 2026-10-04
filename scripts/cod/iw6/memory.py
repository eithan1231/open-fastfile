"""Reading what the Durango loaders loaded (emulated.py): structs in the emulator's memory.

Kept apart from the emulator so that reading needs no capstone.
"""

import struct

from .zone import field_code


class Struct:
    """A struct in the emulator's memory, read by field path as `zone.Record` reads the file.

    Pointers read as addresses in that memory: `array` and `data` follow them. A
    pointer to an asset a Python walker loaded is a stand-in (`asset` names it)."""

    def __init__(self, emulator, typename, address):
        self.emulator, self.type, self.address = emulator, typename, address
        self.layout = emulator.z.layout

    @classmethod
    def of(cls, zone, loaded):
        return cls(zone.emulator, loaded.struct, loaded.address)

    def __getitem__(self, path):
        offset, size, kind, _ = self.layout.resolve(self.type, path)
        return struct.unpack("<" + field_code(kind, size), self.emulator.read(self.address + offset, size))[0]

    def bytes(self, path):
        offset, size, _, _ = self.layout.resolve(self.type, path)
        return self.emulator.read(self.address + offset, size)

    def field(self, path, typename):
        """The struct embedded at `path`."""
        return Struct(self.emulator, typename, self.address + self.layout.resolve(self.type, path)[0])

    def array(self, path, typename, count):
        """The `count` structs `path` points at; [] for a null pointer."""
        base, size = self[path], self.layout.size(typename)
        return [Struct(self.emulator, typename, base + size * i) for i in range(count)] if base else []

    def data(self, path, size):
        """`size` bytes where `path` points; None for a null pointer."""
        base = self[path]
        return self.emulator.read(base, size) if base else None

    def asset(self, path):
        """(type, name) of the Python-walked asset a pointer field stands in for, or None."""
        return self.emulator.foreign_asset(self[path])
