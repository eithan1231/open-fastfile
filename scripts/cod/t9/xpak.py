"""Cold War's stream packages: an `.xpak` index and its `.xsub` parts.

Model vertex data and every image's larger mips are not in a zone: the zone
names an item by a u64 key, and the item is in whichever package's index holds
that key. `Packages(zone_dir)` indexes every `.xpak` beside the fastfiles and
reads an item by key. Layout (reverse/t9-zone/xpak.py, README "Stream packages"):

  header, 0x30 bytes: "KAPI", ..., +0x28 u64 part count (index only)
  +0x7a0  index section: u64 count, u64 offset, u64 byte size (16 per entry)
  +0x800  one 11-byte record per part: u64 part id, ...
  entry:  u64 key, u64 slot << (64 - slot bits) | offset/128 << 32 | size << 1 | compressed

A compressed item is a run of chunks, one per MB of output: u32 command count,
u32 output offset, the commands (codec << 24 | length), each an Oodle stream
(codec 9, u32 size first) or stored bytes (codec 0).
"""

import os
import struct

from . import oodle

MAGIC = b"KAPI"
PART_TABLE = 0x800
PART_RECORD = 11
INDEX_SECTION = 0x7A0
CHUNK_HEADER = 128
CHUNK_BLOCK = 0x100000
OFFSET_UNIT = 128
CODEC_OODLE = 9
CODEC_STORED = 0


class XPak:
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as fh:
            data = fh.read()
        if data[:4] != MAGIC:
            raise ValueError(f"{path}: not a KAPI index")
        (nparts,) = struct.unpack_from("<Q", data, 0x28)
        count, offset, size = struct.unpack_from("<QQQ", data, INDEX_SECTION)
        if size != count * 16:
            raise ValueError(f"{path}: index section of {size:#x} bytes for {count} entries")
        folder, stem = os.path.dirname(path), os.path.splitext(os.path.basename(path))[0]
        by_id = {}
        for name in sorted(os.listdir(folder)):
            if name.startswith(stem + "-") and name.endswith(".xsub"):
                with open(os.path.join(folder, name), "rb") as fh:
                    by_id[fh.read(0x30)[0x20:0x28]] = os.path.join(folder, name)
        self.parts = [by_id.get(data[PART_TABLE + PART_RECORD * i : PART_TABLE + PART_RECORD * i + 8]) for i in range(nparts)]
        # The slot field is as wide as the part count needs; the offset takes the rest of the high word.
        slot_bits = max(1, (nparts - 1).bit_length())
        off_mask = (1 << (32 - slot_bits)) - 1
        self.entries = {}
        for key, packed in struct.iter_unpack("<QQ", data[offset : offset + size]):
            raw = packed & 0xFFFFFFFF
            self.entries[key] = (packed >> (64 - slot_bits), ((packed >> 32) & off_mask) * OFFSET_UNIT, raw >> 1, raw & 1)
        self._files = {}

    def raw(self, key):
        slot, off, size, _ = self.entries[key]
        part = self.parts[slot]
        if part is None:
            raise FileNotFoundError(f"{self.path}: part {slot} is not on disk")
        if slot not in self._files:
            self._files[slot] = open(part, "rb")  # noqa: SIM115 -- kept open for the export's lifetime
        fh = self._files[slot]
        fh.seek(off)
        return fh.read(size)

    def read(self, key):
        """The item's bytes, decompressed chunk by chunk."""
        chunk = self.raw(key)
        if not self.entries[key][3]:
            return chunk
        out = bytearray()
        pos = 0
        while pos < len(chunk):
            count, start = struct.unpack_from("<II", chunk, pos)
            if start != len(out) or count < 1:
                raise ValueError(f"{key:016x}: chunk at {pos} says {count} commands from {start}, have {len(out)}")
            commands = struct.unpack_from(f"<{count}I", chunk, pos + 8)
            # 30 commands fill the 128-byte header; more run on, and the data follows the last.
            pos += max(CHUNK_HEADER, 8 + 4 * count)
            for cmd in commands:
                codec, length = cmd >> 24, cmd & 0xFFFFFF
                if codec == CODEC_OODLE:
                    (dsize,) = struct.unpack_from("<I", chunk, pos)
                    out += oodle.decompress(chunk[pos + 4 : pos + length], dsize)
                elif codec == CODEC_STORED:
                    out += chunk[pos : pos + length]
                else:
                    raise ValueError(f"{key:016x}: codec {codec}")
                pos += length
            pos = -(-pos // CHUNK_BLOCK) * CHUNK_BLOCK
        return bytes(out)

    def close(self):
        for fh in self._files.values():
            fh.close()
        self._files = {}


class Packages:
    """Every stream package in a zone folder, searched by item key."""

    def __init__(self, zone_dir):
        names = sorted(n for n in os.listdir(zone_dir) if n.endswith(".xpak"))
        self.paks = [XPak(os.path.join(zone_dir, n)) for n in names]

    def has(self, key):
        return any(key in pak.entries for pak in self.paks)

    def read(self, key):
        """The item, or None when no installed package holds it (an uninstalled `_hd` pack)."""
        for pak in self.paks:
            if key in pak.entries:
                try:
                    return pak.read(key)
                except FileNotFoundError:
                    return None
        return None

    def close(self):
        for pak in self.paks:
            pak.close()
