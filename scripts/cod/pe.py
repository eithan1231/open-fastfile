"""Section table and file-offset/virtual-address mapping for a PE (PE32 or PE32+).

    exe = PE(path)
    exe.read(va, size)

Read only: nothing here runs or loads the executable.
"""

import struct
from dataclasses import dataclass


@dataclass
class Section:
    name: str
    va: int
    virtual_size: int
    raw_offset: int
    raw_size: int


class PE:
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as fh:
            self.data = fh.read()
        d = self.data
        pe = struct.unpack_from("<I", d, 0x3C)[0]
        count = struct.unpack_from("<H", d, pe + 6)[0]
        opt_size = struct.unpack_from("<H", d, pe + 20)[0]
        # The optional header's magic says where ImageBase is and how wide: 0x20b is PE32+ (x64).
        self.is64 = struct.unpack_from("<H", d, pe + 24)[0] == 0x20B
        self.image_base = struct.unpack_from("<Q" if self.is64 else "<I", d, pe + 24 + (24 if self.is64 else 28))[0]
        self.sections = []
        for i in range(count):
            o = pe + 24 + opt_size + i * 40
            name = d[o : o + 8].rstrip(b"\0").decode()
            vsize, va, rsize, rptr = struct.unpack_from("<IIII", d, o + 8)
            self.sections.append(Section(name, self.image_base + va, vsize, rptr, rsize))

    def va_to_offset(self, va):
        for s in self.sections:
            if s.va <= va < s.va + s.raw_size:
                return s.raw_offset + va - s.va
        raise ValueError(f"0x{va:x} is not backed by the file")

    def offset_to_va(self, offset):
        for s in self.sections:
            if s.raw_offset <= offset < s.raw_offset + s.raw_size:
                return s.va + offset - s.raw_offset
        raise ValueError(f"offset 0x{offset:x} is in no section")

    def read(self, va, size):
        o = self.va_to_offset(va)
        return self.data[o : o + size]


def is_pe32_plus(path):
    """Whether `path` is a 64-bit (PE32+) executable, from its first page alone; False for anything that is not a PE."""
    with open(path, "rb") as fh:
        head = fh.read(4096)
    if len(head) < 0x40 or head[:2] != b"MZ":
        return False
    pe = struct.unpack_from("<I", head, 0x3C)[0]
    if pe + 26 > len(head) or head[pe : pe + 4] != b"PE\0\0":
        return False
    return struct.unpack_from("<H", head, pe + 24)[0] == 0x20B
