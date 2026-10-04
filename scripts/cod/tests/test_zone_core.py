"""The zone core over each game's ZoneSpec: pointers, blocks, the XFile header, insert slots."""

import json
import os
import struct

import pytest

from scripts.cod.iw6 import zone as iw6_zone
from scripts.cod.maps import REPO_ROOT
from scripts.cod.zone import FOLLOWS, INSERT, IW4, IW5, IW6, KIND_POINTER, KIND_UNSIGNED, POINTER_TAG, T5, Layout, Zone


def reference32(spec, block, offset):
    """What a 32-bit loader writes for (block, offset): the packed pair plus one."""
    return ((block << (32 - spec.block_bits)) | offset) + 1


def zone32(spec, body=b"", blocks=None, layout=None):
    """A 32-bit zone: its XFile header, then `body`."""
    sizes = blocks or [0] * len(spec.blocks)
    header = struct.pack(spec.header_format, len(body), 0, *sizes)
    return Zone(header + body, layout, spec=spec)


# --- pointers ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("spec", "value", "expected"),
    [
        # IW4 and IW5: 4 block bits, so (v - 1) >> 28 and (v - 1) & 0x0FFFFFFF.
        (IW4, 0x30001235, (3, 0x1234)),
        (IW5, 0x80000001, (8, 0)),  # SCRIPT, IW5's ninth block
        (IW5, 0x0FFFFFFF + 1, (0, 0x0FFFFFFF)),
        # T5: 3 block bits, so (v - 1) >> 29 and (v - 1) & 0x1FFFFFFF.
        (T5, 0x80001235, (4, 0x1234)),  # VIRTUAL is T5's fifth block
        (T5, 0x3FFFFFFF + 1, (1, 0x1FFFFFFF)),
    ],
)
def test_a_32_bit_reference_splits_by_its_games_block_bits(spec, value, expected):
    assert spec.reference(value) == expected
    assert spec.reference(reference32(spec, *expected)) == expected
    assert not spec.follows(value)


def test_the_same_32_bit_value_names_different_blocks_in_iw5_and_t5():
    value = reference32(T5, 4, 0x10)  # T5's VIRTUAL
    assert T5.reference(value) == (4, 0x10)
    assert IW5.reference(value) == (8, 0x10)  # IW5 reads a fourth block bit


@pytest.mark.parametrize("spec", [IW4, IW5, T5])
def test_32_bit_follows_insert_and_null(spec):
    assert spec.follows(FOLLOWS) and spec.follows(INSERT)
    assert not spec.follows(0)
    with pytest.raises(ValueError):
        spec.reference(FOLLOWS)
    with pytest.raises(ValueError):
        spec.follows(POINTER_TAG | FOLLOWS)  # a 64-bit value is no 32-bit pointer


@pytest.mark.parametrize(("spec", "block"), [(IW4, 8), (IW5, 9), (T5, 7)])
def test_a_32_bit_reference_past_the_last_block_is_refused(spec, block):
    with pytest.raises(ValueError, match="names block"):
        spec.reference(reference32(spec, block, 0))


def test_64_bit_pointers_are_unchanged_and_are_still_iw6_zones():
    assert IW6.follows(POINTER_TAG | FOLLOWS) and IW6.follows(POINTER_TAG | INSERT)
    assert IW6.reference(POINTER_TAG | (3 << 32) | 0x11) == (3, 0x10)
    with pytest.raises(ValueError):
        IW6.follows(FOLLOWS)  # untagged
    # iw6.zone keeps its module-level names for everything downstream.
    assert iw6_zone.follows is IW6.follows and iw6_zone.reference is IW6.reference
    assert (iw6_zone.TEMP, iw6_zone.RUNTIME, iw6_zone.VIRTUAL, iw6_zone.SCRIPT) == (0, 2, 3, 6)


# --- the header and the blocks ---------------------------------------------------


@pytest.mark.parametrize(("spec", "size"), [(IW4, 40), (IW5, 44), (T5, 36), (IW6, 72)])
def test_the_xfile_header_is_two_words_and_a_size_per_block(spec, size):
    assert spec.header_size == size
    blocks = list(range(10, 10 + len(spec.blocks)))
    data = struct.pack(spec.header_format, 123, 456, *blocks)
    assert spec.header(data) == (123, 456, tuple(blocks))


def test_t5_blocks_are_not_iw6s():
    assert (T5.temp, T5.virtual, T5.insert) == (0, 4, 4)
    assert T5.runtime_blocks == {1, 2, 3}
    assert (IW5.virtual, IW5.runtime_blocks) == (3, {2})


@pytest.mark.parametrize("name", ["RUNTIME", "LARGE_RUNTIME", "PHYSICAL_RUNTIME"])
def test_a_runtime_block_moves_its_cursor_but_reads_no_bytes(name):
    z = zone32(T5, bytes(range(16)))
    z.pos = T5.header_size
    z.push(T5.index(name))
    assert z.take(100) is None
    z.pop()
    assert z.pos == T5.header_size and z.blocks[T5.index(name)] == 100
    z.push(T5.index("PHYSICAL"))
    assert z.take(4) == T5.header_size  # a normal block reads the file
    assert z.pos == T5.header_size + 4


def test_temp_is_rewound_on_pop_and_only_temp():
    z = zone32(IW5, bytes(64))
    z.pos = IW5.header_size
    z.take(8)  # the zone starts in TEMP
    z.push(IW5.temp)
    z.take(16)
    z.push(IW5.virtual)
    z.take(4)
    z.pop()  # leaving VIRTUAL rewinds nothing
    assert z.blocks[IW5.temp] == 24
    z.pop()  # leaving the pushed TEMP restores its cursor
    assert z.blocks[IW5.temp] == 8 and z.block_peak[IW5.temp] == 24
    assert z.blocks[IW5.virtual] == 4


# --- insert slots and handles ------------------------------------------------------

ROWS = [
    ["Asset", "name", 0, 4, 4, 1, KIND_POINTER, 0, 0, ""],
    ["Asset", "count", 4, 4, 4, 0, KIND_UNSIGNED, 0, 0, ""],
    ["Asset", "", 0, 8, 0, 0, 0, 0, 0, "", 4],
]


@pytest.mark.parametrize("spec", [IW4, IW5, T5])
def test_an_insert_reserves_a_4_byte_slot_in_virtual_and_an_alias_finds_it(spec):
    body = struct.pack("<II", FOLLOWS, 7) + b"gun\0"
    z = zone32(spec, body, layout=Layout.from_rows(ROWS))
    z.pos = spec.header_size
    z.push(spec.virtual)
    z.blocks[spec.virtual] = 1  # an odd cursor: the slot is aligned to 4

    def walker(zone):
        record = zone.struct("Asset")
        return zone.field_string(record, "name"), record["count"]

    first = z.handle(INSERT, walker, "WEAPON")
    assert first == ("WEAPON", ("gun", 7))
    # The slot took 4 bytes at offset 4 of VIRTUAL, and no file bytes.
    assert z.blocks[spec.virtual] == 8 and z.slots[4] == first
    assert z.pos == len(z.data)
    # A later handle naming that slot is the same asset.
    assert z.handle(reference32(spec, spec.virtual, 4), walker, "WEAPON") == first
    # The asset (8 bytes and its 4-byte name) loaded in TEMP, rewound when the handle returned.
    assert z.blocks[spec.temp] == 0 and z.block_peak[spec.temp] == 12


def test_32_bit_pointer_arrays_are_4_bytes_a_pointer():
    body = struct.pack("<3I", FOLLOWS, 0, FOLLOWS) + b"a\0" + b"bc\0"
    z = zone32(IW5, body)
    z.pos = IW5.header_size
    z.push(IW5.virtual)
    assert z.strings_at(z.take(12), 3) == ["a", None, "bc"]
    assert z.pos == len(z.data)


def test_an_unread_32_bit_pointer_is_reported():
    z = zone32(IW4, struct.pack("<II", FOLLOWS, 3), layout=Layout.from_rows(ROWS))
    z.pos = IW4.header_size
    z.push(IW4.virtual)
    z.struct("Asset")
    z.check()
    assert [(t, p) for t, p, _ in z.unhandled] == [("Asset", "name")]
    assert Layout.from_rows(ROWS).aligns == {"Asset": 4}


@pytest.mark.parametrize("spec", [IW4, IW5, T5])
def test_the_32_bit_specs_are_the_blocks_zonecode_declares(spec):
    """The specs against reverse/x86-zone's zonecode.json, which is generated and never committed."""
    path = os.path.join(REPO_ROOT, "reverse", "x86-zone", "out", spec.game, "zonecode.json")
    if not os.path.exists(path):
        pytest.skip(f"no {path}: build it with reverse/x86-zone/build.sh")
    with open(path) as fh:
        blocks = sorted(json.load(fh)["blocks"], key=lambda block: block["index"])
    assert tuple(block["name"].removeprefix("XFILE_BLOCK_") for block in blocks) == spec.blocks
    assert {block["index"] for block in blocks if block["type"] == "runtime"} == spec.runtime_blocks
    assert [block["index"] for block in blocks if block["type"] == "temp"] == [spec.temp]
