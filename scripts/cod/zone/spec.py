"""What differs between games' zones, as data: the blocks, the pointer encoding, the XFile header.

A zone is read the same way in every game this pipeline imports (core.py). What a
game changes is only this: how many blocks there are and which of them hold no
file bytes, how wide a pointer is and how a pointer names earlier data, and so how
long the XFile header in front of the zone is. Sources: reverse/iw6-zone/README.md#pointers
for the 64-bit games, reverse/x86-zone/README.md for the 32-bit ones.
"""

import struct
from dataclasses import dataclass, field

# The pointer codes, in the low 32 bits of a pointer of either width.
FOLLOWS = 0xFFFFFFFF  # the data comes next in the stream
INSERT = 0xFFFFFFFE  # it follows too, and the loader first reserves a pointer slot in the insert block
OFFSET = 0xFFFFFFFD  # IW6's -3, which no walker has met
# A 64-bit zone tags every pointer; a reference carries its block in bits 32-35.
POINTER_TAG = 0xFDFDFDF0_00000000


def _pointers64():
    """IW6 and S1: a tagged 64-bit value whose low dword is the code or offset + 1."""

    def is_pointer(value):
        return value & 0xFFFFFFF0_00000000 == POINTER_TAG

    def follows(value):
        if value == 0:
            return False
        if not is_pointer(value):
            raise ValueError(f"not a zone pointer: 0x{value:x}")
        low = value & 0xFFFFFFFF
        if low == OFFSET:
            raise NotImplementedError("pointer kind -3 is not handled yet")
        return low in (FOLLOWS, INSERT)

    def reference(value):
        # DB_GetPackedOffsetStreamPos
        return (value >> 32) & 0xF, (value & 0xFFFFFFFF) - 1

    return is_pointer, follows, reference


def _pointers32(block_bits, block_count):
    """IW4, IW5 and T5: `value - 1` is the block in its top `block_bits` bits and the offset
    below them (OAT's blockBitCount, ZoneInputStream's m_block_shift and m_offset_mask)."""
    shift = 32 - block_bits
    mask = (1 << shift) - 1

    def is_pointer(value):
        return 0 <= value <= 0xFFFFFFFF

    def follows(value):
        if not is_pointer(value):
            raise ValueError(f"not a 32-bit zone pointer: 0x{value:x}")
        return value in (FOLLOWS, INSERT)

    def reference(value):
        if not value or value in (FOLLOWS, INSERT):
            raise ValueError(f"0x{value:x} is not a reference")
        packed = value - 1
        block = packed >> shift
        if block >= block_count:
            raise ValueError(f"0x{value:x} names block {block}; the zone has {block_count}")
        return block, packed & mask

    return is_pointer, follows, reference


@dataclass(frozen=True)
class ZoneSpec:
    """One game's zone: its blocks in index order, which of them are runtime, and its pointers.

    `block_bits` is the 32-bit games' block field width; 64-bit pointers carry the
    block in a field of their own. The XFile header is `size`, `externalSize` and one
    size per block, each a word of `header_word` bytes, and the zone's length is the
    header plus `size`."""

    game: str
    blocks: tuple
    runtime: frozenset  # block names whose bytes are zero-filled, not read: the cursor still moves
    pointer_size: int
    block_bits: int = 0
    insert_block: str = "VIRTUAL"
    temp_block: str = "TEMP"  # rewound on pop
    header_word: int = 0  # defaults to the pointer size
    depends: bool = False  # T6's XAssetList names the zones it depends on, after the script strings
    # Filled in from the above.
    temp: int = field(init=False)
    virtual: int = field(init=False)
    insert: int = field(init=False)
    runtime_blocks: frozenset = field(init=False)
    header_format: str = field(init=False)
    header_size: int = field(init=False)

    def __post_init__(self):
        if self.pointer_size not in (4, 8):
            raise ValueError(f"{self.game}: a pointer is 4 or 8 bytes, not {self.pointer_size}")
        if self.pointer_size == 4 and not self.block_bits:
            raise ValueError(f"{self.game}: a 32-bit zone needs its block_bits")
        word = self.header_word or self.pointer_size
        fmt = "<" + ("Q" if word == 8 else "I") * (2 + len(self.blocks))
        values = {
            "header_word": word,
            "temp": self.blocks.index(self.temp_block),
            "virtual": self.blocks.index("VIRTUAL"),
            "insert": self.blocks.index(self.insert_block),
            "runtime_blocks": frozenset(self.blocks.index(name) for name in self.runtime),
            "header_format": fmt,
            "header_size": struct.calcsize(fmt),
        }
        for name, value in values.items():
            object.__setattr__(self, name, value)
        rules = _pointers64() if self.pointer_size == 8 else _pointers32(self.block_bits, len(self.blocks))
        # Plain functions rather than methods: the walkers call these per pointer.
        for name, fn in zip(("is_pointer", "follows", "reference"), rules, strict=True):
            object.__setattr__(self, name, fn)

    def index(self, name):
        return self.blocks.index(name)

    def header(self, data):
        """(size, externalSize, block sizes) from the XFile header at the zone's start."""
        words = struct.unpack_from(self.header_format, data, 0)
        return words[0], words[1], words[2:]


# reverse/iw6-zone/README.md: DB_LoadXFileData's seven blocks, XFile as 64-bit words.
# AW reads with it too: its block model is IW6's (reverse/s1-zone/README.md).
IW6 = ZoneSpec("iw6", ("TEMP", "PHYSICAL", "RUNTIME", "VIRTUAL", "LARGE", "CALLBACK", "SCRIPT"), frozenset({"RUNTIME"}), 8)
# reverse/x86-zone/README.md#blocks: each ZoneLoaderFactory's SetupBlock, and blockBitCount.
IW4 = ZoneSpec(
    "iw4",
    ("TEMP", "PHYSICAL", "RUNTIME", "VIRTUAL", "LARGE", "CALLBACK", "VERTEX", "INDEX"),
    frozenset({"RUNTIME"}),
    4,
    block_bits=4,
)
IW5 = ZoneSpec("iw5", (*IW4.blocks, "SCRIPT"), frozenset({"RUNTIME"}), 4, block_bits=4)
T5 = ZoneSpec(
    "t5",
    ("TEMP", "RUNTIME", "LARGE_RUNTIME", "PHYSICAL_RUNTIME", "VIRTUAL", "LARGE", "PHYSICAL"),
    frozenset({"RUNTIME", "LARGE_RUNTIME", "PHYSICAL_RUNTIME"}),
    4,
    block_bits=3,
)
# reverse/t6-zone/README.md: ZoneLoaderFactoryT6's SetupBlock. The two DELAY blocks are
# never loaded into (OAT asserts), and every retail PC zone's header gives them size 0.
T6 = ZoneSpec(
    "t6",
    (
        "TEMP",
        "RUNTIME_VIRTUAL",
        "RUNTIME_PHYSICAL",
        "DELAY_VIRTUAL",
        "DELAY_PHYSICAL",
        "VIRTUAL",
        "PHYSICAL",
        "STREAMER_RESERVE",
    ),
    frozenset({"RUNTIME_VIRTUAL", "RUNTIME_PHYSICAL"}),
    4,
    block_bits=3,
    depends=True,
)
SPECS = {spec.game: spec for spec in (IW4, IW5, T5, T6, IW6)}
