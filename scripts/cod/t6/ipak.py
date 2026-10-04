"""Black Ops II's `.ipak` image packs: the pixels a streamed GfxImage keeps outside its zone.

    packs = Packs(zone_dir)               # every *.ipak beside the fastfiles, indexed
    iwi = packs.iwi(name_hash, data_hash) # an Iwi, or None when no pack holds the image

A layout port of OAT's IPak reader (ObjLoading/ObjContainer/IPak, ObjCommon's
IPakTypes.h); reverse/t6-zone/README.md#images-and-ipak has what was checked:

- header `KAPI`, version 0x50000, size, section count; then sections of
  (type, offset, size, item count): 1 the index, 2 the data;
- the index: (dataHash, nameHash, offset into the data section, size) per entry,
  16 bytes. A GfxImage names its entry by `hash` (the name hash) and
  `streamedParts[0].hash` (the data hash);
- an entry is 128-byte-aligned blocks: a count-and-offset word (count in the top 8
  bits, the entry's output offset where the block starts in the low 24), then 31
  command words (size in the low 24 bits, kind in the top 8), then the commands'
  bytes. Kind 0 is stored, 1 LZO1X (t6/lzo.py), 0xCF skipped; the next block is at
  the next multiple of 128.

The output is an IWI version 27 file: `IWi`, 27, format, flags, three dimensions,
gamma, 16 gloss bytes and eight cumulative file sizes, then every mip level,
smallest first. `level` decompresses no further than the level it is asked for, and
`check` holds the file sizes the header gives to the format's own level sizes.
"""

import glob
import os
import struct
from collections import namedtuple

from . import lzo

MAGIC = b"KAPI"
VERSION = 0x50000
INDEX, DATA = 1, 2
ENTRY = struct.Struct("<IIII")  # dataHash, nameHash, offset, size
BLOCK = 128
COMMANDS = 31
STORED, LZO, SKIP = 0, 1, 0xCF

IWI27 = struct.Struct("<3sBbbHHHf16b8I")
# IWI27 format -> (DXGI format, bytes per block, block edge). OAT's GetFormat27.
FORMATS = {
    0x1: (28, 4, 1),  # BITMAP_RGBA -> R8G8B8A8_UNORM
    0x5: (65, 1, 1),  # BITMAP_ALPHA -> A8_UNORM
    0xB: (71, 8, 4),  # DXT1 -> BC1_UNORM
    0xC: (74, 16, 4),  # DXT3 -> BC2_UNORM
    0xD: (77, 16, 4),  # DXT5 -> BC3_UNORM
    0xE: (83, 16, 4),  # DXN -> BC5_UNORM
    0x12: (28, 4, 1),  # BITMAP_RGBA8
    0x13: (10, 8, 1),  # A16B16G16R16F -> R16G16B16A16_FLOAT
}
NOMIPMAPS, CUBEMAP, VOLMAP = 0x2, 0x4, 0x8

Entry = namedtuple("Entry", "path offset size")


def level_size(fmt, width, height, level):
    _dxgi, block, edge = FORMATS[fmt]
    w, h = max(1, width >> level), max(1, height >> level)
    return block * max(1, (w + edge - 1) // edge) * max(1, (h + edge - 1) // edge)


def read_index(path):
    """{(nameHash, dataHash): Entry} of one pack, its offsets made absolute."""
    with open(path, "rb") as fh:
        magic, version, _size, count = struct.unpack("<4sIII", fh.read(16))
        if magic != MAGIC or version != VERSION:
            raise ValueError(f"{path}: not a PC ipak ({magic!r}, version {version:#x})")
        sections = {
            kind: (offset, size, items) for kind, offset, size, items in (struct.unpack("<4I", fh.read(16)) for _ in range(count))
        }
        if INDEX not in sections or DATA not in sections:
            raise ValueError(f"{path}: no index or no data section")
        offset, size, items = sections[INDEX]
        if size != items * ENTRY.size:
            raise ValueError(f"{path}: an index of {items} entries in {size} bytes")
        fh.seek(offset)
        raw = fh.read(size)
    base = sections[DATA][0]
    return {(name, data): Entry(path, base + at, length) for data, name, at, length in ENTRY.iter_unpack(raw)}


class Entries:
    """One entry's output, inflated block by block as far as a read has needed, and kept."""

    def __init__(self, entry):
        self.entry = entry
        self.out = bytearray()
        self.pos = 0  # the next block's offset in the entry

    def _next_block(self, fh):
        """(output offset, [(kind, bytes)]) of the next block, or None past the entry's end."""
        entry = self.entry
        if self.pos >= entry.size:
            return None
        fh.seek(entry.offset + self.pos)
        word, *commands = struct.unpack(f"<{1 + COMMANDS}I", fh.read(BLOCK))
        count, start = word >> 24, word & 0xFFFFFF
        if count > COMMANDS:
            raise ValueError(f"{entry.path}: a block at {entry.offset + self.pos:#x} holds {count} commands")
        sizes = [(command >> 24, command & 0xFFFFFF) for command in commands[:count]]
        total = sum(size for _, size in sizes)
        if self.pos + BLOCK + total > entry.size:
            raise ValueError(f"{entry.path}: the block at {entry.offset + self.pos:#x} runs past its entry")
        raw = fh.read(total)
        parts, at = [], 0
        for kind, size in sizes:
            parts.append((kind, raw[at : at + size]))
            at += size
        self.pos = -(-(self.pos + BLOCK + total) // BLOCK) * BLOCK
        return start, parts

    def read(self, first, last):
        """Output bytes [first, last). Mips are stored smallest first, so reading stops at `last`
        and a level no larger than a texture needs costs a fraction of the file."""
        out = self.out
        if len(out) < last:
            with open(self.entry.path, "rb") as fh:
                while len(out) < last:
                    block = self._next_block(fh)
                    if block is None:
                        break
                    start, parts = block
                    data = [(kind, piece) for kind, piece in parts if kind != SKIP]
                    if data and start != len(out):
                        raise ValueError(
                            f"{self.entry.path}: a block starts at output {start}, the one before ended at {len(out)}"
                        )
                    for kind, piece in data:
                        if kind == STORED:
                            out += piece
                        elif kind == LZO:
                            out += lzo.decompress(piece)
                        else:
                            raise ValueError(f"{self.entry.path}: command kind {kind:#x}")
        if len(out) < last:
            raise ValueError(f"{self.entry.path}: the entry ends at output byte {len(out)}, before {last}")
        return bytes(out[first:last])


Iwi = namedtuple("Iwi", "fmt flags width height depth sizes entries")


class Packs:
    """Every `.ipak` in a folder, by the (name hash, data hash) a GfxImage names its pixels with."""

    def __init__(self, folder):
        self.index = {}
        # Patches first: a key they share with the base pack is the same data, and
        # they are small.
        paths = sorted(glob.glob(os.path.join(folder, "*.ipak")), key=lambda p: ("patch" not in os.path.basename(p), p))
        for path in paths:
            for key, entry in read_index(path).items():
                self.index.setdefault(key, entry)

    def __len__(self):
        return len(self.index)

    def iwi(self, name_hash, data_hash):
        """The IWI27 an image's pixels are, its header read and checked, or None where no pack holds it."""
        entry = self.index.get((name_hash, data_hash))
        if entry is None:
            return None
        entries = Entries(entry)
        head = entries.read(0, IWI27.size)
        tag, version, fmt, flags, width, height, depth, _gamma, *rest = IWI27.unpack(head)
        sizes = rest[16:]
        if tag != b"IWi" or version != 27:
            raise ValueError(f"{entry.path}: entry {entry.offset:#x} is not an IWI 27 ({tag!r}, {version})")
        if fmt not in FORMATS:
            raise ValueError(f"IWI format {fmt:#x}")
        iwi = Iwi(fmt, flags & 0xFF, width, height, depth, tuple(sizes), entries)
        check(iwi)
        return iwi


def faces(iwi):
    return 6 if iwi.flags & CUBEMAP else 1


def levels(iwi):
    return 1 if iwi.flags & NOMIPMAPS else max(iwi.width, iwi.height).bit_length()


def check(iwi):
    """The header's cumulative file sizes are the format's level sizes, smallest level first."""
    total = IWI27.size
    for level in range(levels(iwi) - 1, -1, -1):
        total += level_size(iwi.fmt, iwi.width, iwi.height, level) * faces(iwi)
        if level < 8 and iwi.sizes[level] != total:
            raise ValueError(
                f"IWI {iwi.width}x{iwi.height} format {iwi.fmt:#x}: level {level} ends at {iwi.sizes[level]}, not {total}"
            )


def level(iwi, index):
    """(DXGI format, width, height, faces, pixels) of mip `index`, face after face."""
    size = level_size(iwi.fmt, iwi.width, iwi.height, index) * faces(iwi)
    end = IWI27.size + sum(level_size(iwi.fmt, iwi.width, iwi.height, k) * faces(iwi) for k in range(index, levels(iwi)))
    pixels = iwi.entries.read(end - size, end)
    return FORMATS[iwi.fmt][0], max(1, iwi.width >> index), max(1, iwi.height >> index), faces(iwi), pixels
