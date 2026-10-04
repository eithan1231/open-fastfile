"""The nav.bin encoder (scripts/cod/nav/format.py) and its vocabularies.

The conformance fixture is the contract with the TypeScript decoder
(packages/shared/tests/navFormat.test.ts reads the same bytes): the encoder
must reproduce them exactly, and vocab.py must hold the tables they were
written with.
"""

import json
import math
import struct
import zlib

import pytest

from scripts.cod.nav import conformance, vocab
from scripts.cod.nav.format import (
    Link,
    NavData,
    NavEncodeError,
    Node,
    RawSection,
    Traversal,
    encode,
    yaw16,
)


def sections(data):
    """{tag: (version, flags, payload)} of an encoded file, read back by hand."""
    count, table = struct.unpack_from("<II", data, 16)
    out = {}
    for i in range(count):
        tag, version, flags, offset, length = struct.unpack_from("<4sHHII", data, table + 16 * i)
        out[tag.decode()] = (version, flags, data[offset : offset + length])
    return out


# ---- the conformance fixture ----------------------------------------------------------------


def test_encoder_reproduces_the_committed_fixture():
    with open(conformance.BIN_PATH, "rb") as fh:
        committed = fh.read()
    assert conformance.build() == committed


def test_vocab_equals_the_fixture_tables():
    assert conformance.load()["vocab"] == vocab.TABLES


def test_fixture_strings_and_sections_are_what_the_encoder_wrote():
    fixture = conformance.load()
    data = conformance.build()
    got = sections(data)
    assert [(t, v, bool(f & 1)) for t, (v, f, _) in got.items()] == [
        (s["tag"], s["version"], s["required"]) for s in fixture["expected"]["sections"]
    ]
    count = struct.unpack_from("<I", got["STRS"][2])[0]
    offsets = struct.unpack_from(f"<{count + 1}I", got["STRS"][2], 8)
    blob = got["STRS"][2][8 + 4 * (count + 1) :]
    assert [blob[a:b].decode("utf-8") for a, b in zip(offsets, offsets[1:], strict=False)] == fixture["expected"]["strings"]


def test_the_conformance_check_passes():
    assert conformance.main(["--check"]) == 0


# ---- the header and the table ------------------------------------------------------------------


def test_header_layout():
    data = encode(NavData(nodes=[Node((1.0, 2.0, 3.0))], flags=vocab.HEADER_FLAGS["DERIVE_WALK_LINKS"]))
    magic, major, minor, flags, length, count, table, crc, reserved = struct.unpack_from("<4sHHIIIIII", data)
    assert (magic, major, minor) == (b"3DNV", 1, 0)
    assert flags == 1 << 16
    assert length == len(data)
    assert (count, table, reserved) == (1, 32, 0)
    assert crc == zlib.crc32(data[32:])


def test_sections_are_eight_aligned_and_padded_with_zeros():
    data = encode(NavData(nodes=[Node((0, 0, 0), name="x")], meta={"a": 1}, extra=[RawSection("ABCD", 1, b"\x01\x02\x03")]))
    count, table = struct.unpack_from("<II", data, 16)
    for i in range(count):
        _, _, _, offset, length = struct.unpack_from("<4sHHII", data, table + 16 * i)
        assert offset % 8 == 0
        end = offset + length
        assert data[end : end + (-end % 8)] == bytes(-end % 8)
    assert len(data) % 8 == 0


def test_optional_sections_appear_only_when_there_is_something_to_hold():
    got = sections(encode(NavData(nodes=[Node((0, 0, 0))])))
    assert list(got) == ["NODE"]
    got = sections(encode(NavData(nodes=[Node((0, 0, 0))], links=[])))
    assert list(got) == ["NODE", "LINK"]


def test_output_is_deterministic():
    nav = conformance.nav_data(conformance.load())
    assert encode(nav) == encode(nav)


def test_meta_is_sorted_compact_json_with_the_skipped_counts():
    got = sections(encode(NavData(nodes=[], meta={"z": 1, "a": "ü"}, skipped={"dynamicNodes": 37})))
    version, flags, payload = got["META"]
    assert (version, flags) == (1, 0)
    assert payload == '{"a":"ü","skipped":{"dynamicNodes":37},"z":1}'.encode()


# ---- records -------------------------------------------------------------------------------------


def test_node_record_layout():
    node = Node((1.5, -2.25, 3.0), type="COVER_LEFT", yaw=math.pi / 2, floor_z=True, abilities=5, stance=3, source=7, name="n")
    payload = sections(encode(NavData(nodes=[node])))["NODE"][2]
    assert struct.unpack_from("<II", payload) == (1, 32)
    assert struct.unpack_from("<fffHBBIIIHBB", payload, 8) == (
        1.5,
        -2.25,
        3.0,
        16384,
        vocab.NODE_TYPES["COVER_LEFT"],
        vocab.NODE_FLAGS["HAS_YAW"] | vocab.NODE_FLAGS["FLOOR_Z"],
        5,
        7,
        1,
        0xFFFF,
        3,
        0,
    )


def test_a_dynamic_node_carries_its_group_and_the_flag():
    payload = sections(encode(NavData(nodes=[Node((0, 0, 0), group=4)])))["NODE"][2]
    _, _, _, _, _, flags, _, source, _, group, _, _ = struct.unpack_from("<fffHBBIIIHBB", payload, 8)
    assert flags == vocab.NODE_FLAGS["DYNAMIC"]
    assert (source, group) == (0xFFFFFFFF, 4)


def test_yaw_rounds_half_up_and_wraps():
    assert yaw16(0.0) == 0
    assert yaw16(-math.pi / 2) == 49152
    assert yaw16(2 * math.pi) == 0
    assert yaw16(math.pi) == 32768


def test_links_are_grouped_by_node_stably():
    nodes = [Node((0, 0, 0)), Node((1, 0, 0)), Node((2, 0, 0))]
    links = [Link(2, 0, game_cost=1.0), Link(0, 1, game_cost=2.0), Link(2, 1, game_cost=3.0), Link(0, 2)]
    payload = sections(encode(NavData(nodes=nodes, links=links)))["LINK"][2]
    count, stride, node_count, reserved = struct.unpack_from("<IIII", payload)
    assert (count, stride, node_count, reserved) == (4, 12, 3, 0)
    assert struct.unpack_from("<4I", payload, 16) == (0, 2, 2, 4)
    start = 16 + 16  # (3 + 1) u32s is already a multiple of 8
    records = [struct.unpack_from("<IfBBH", payload, start + 12 * i) for i in range(4)]
    assert [(r[0], r[1]) for r in records[:1]] == [(1, 2.0)]
    assert records[1][0] == 2 and math.isnan(records[1][1])
    assert [(r[0], r[1]) for r in records[2:]] == [(0, 1.0), (1, 3.0)]
    assert all(r[4] == 0xFFFF for r in records)


def test_link_csr_is_padded_to_eight():
    payload = sections(encode(NavData(nodes=[Node((0, 0, 0)), Node((1, 0, 0))], links=[Link(0, 1)])))["LINK"][2]
    # 16-byte head + 3 u32s = 28, padded to 32.
    assert payload[28:32] == bytes(4)
    assert struct.unpack_from("<I", payload, 32)[0] == 1


def test_traversal_record_layout():
    nodes = [Node((0, 0, 0)), Node((0, 1, 0))]
    travs = [Traversal(0, 1, "MANTLE_OVER", "wall_over_40")]
    payload = sections(encode(NavData(nodes=nodes, traversals=travs)))["TRAV"][2]
    assert struct.unpack_from("<IIIIBBHI", payload) == (1, 16, 0, 1, vocab.TRAVERSAL_KINDS["MANTLE_OVER"], 0, 0, 1)


# ---- what the encoder refuses -----------------------------------------------------------------


def two_nodes():
    return [Node((0, 0, 0)), Node((1, 0, 0))]


@pytest.mark.parametrize(
    "nav",
    [
        NavData(nodes=[Node((0, 0, 0), type="SOFA")]),
        NavData(nodes=[Node((math.nan, 0, 0))]),
        NavData(nodes=[Node((0, 0, 0), abilities=1 << 9)]),
        NavData(nodes=[Node((0, 0, 0), stance=8)]),
        NavData(nodes=[Node((0, 0, 0), group=0xFFFF)]),
        NavData(nodes=[Node((0, 0, 0), source=0xFFFFFFFF)]),
        NavData(nodes=[], flags=1 << 17),
        NavData(nodes=two_nodes(), links=[Link(0, 2)]),
        NavData(nodes=two_nodes(), links=[Link(0, 1, kind="FLY")]),
        NavData(nodes=two_nodes(), links=[Link(0, 1, flags=1 << 6)]),
        NavData(nodes=two_nodes(), links=[Link(0, 1, kind="TRAVERSE")]),
        NavData(nodes=two_nodes(), links=[Link(0, 1, traversal=0)], traversals=[Traversal(0, 1)]),
        NavData(nodes=two_nodes(), links=[Link(1, 0, kind="TRAVERSE", traversal=0)], traversals=[Traversal(0, 1)]),
        NavData(nodes=two_nodes(), links=[Link(0, 1, flags=vocab.LINK_FLAGS["NEGOTIATION"])]),
        NavData(nodes=two_nodes(), traversals=[Traversal(0, 5)]),
        NavData(nodes=two_nodes(), traversals=[Traversal(0, 1, kind="TELEPORT")]),
        NavData(nodes=[], extra=[RawSection("NODE", 1, b"")]),
        NavData(nodes=[], extra=[RawSection("ZONE", 1, b"")]),
        NavData(nodes=[], extra=[RawSection("TOOLONG", 1, b"")]),
    ],
)
def test_encoder_refuses_what_the_format_cannot_hold(nav):
    with pytest.raises(NavEncodeError):
        encode(nav)


# ---- the Call of Duty mappings ------------------------------------------------------------------


def test_every_mapping_names_a_standard_value():
    assert set(vocab.CLASSNAME_TYPES.values()) <= set(vocab.NODE_TYPES)
    for table in vocab.GAME_TYPES.values():
        assert set(table.values()) <= set(vocab.NODE_TYPES)
    for table in vocab.ANIMSCRIPT_KINDS.values():
        assert set(table.values()) <= set(vocab.TRAVERSAL_KINDS)
    assert set(vocab.ANIMSCRIPT_KINDS) == set(vocab.SPECIAL_PREFIXES) == set(vocab.ANIMSCRIPT_KEYS)


def test_game_type_numbers_match_their_enums():
    # IW5/IW6/T5 agree up to COVER_LEFT (7) and part ways after it.
    for game in vocab.GAME_TYPES:
        assert vocab.GAME_TYPES[game][1] == "PATH"
        assert vocab.GAME_TYPES[game][7] == "COVER_LEFT"
    assert vocab.GAME_TYPES["mw3"][16] == "TRAVERSE_BEGIN"
    assert vocab.GAME_TYPES["bo1"][17] == "TRAVERSE_BEGIN"
    assert vocab.GAME_TYPES["ghosts"][17] == "TRAVERSE_BEGIN"
    assert vocab.GAME_TYPES["aw"] == vocab.GAME_TYPES["ghosts"]
    assert 21 not in vocab.GAME_TYPES["ghosts"]  # PATHNODE_3D never ships


@pytest.mark.parametrize(
    ("game", "animscript", "kind"),
    [
        ("mw3", "stepup_52", "STEP_UP"),
        ("mw3", "jumpdown_96", "JUMP_DOWN"),
        ("mw3", "ladder_up", "LADDER_UP"),
        ("bo1", "mantle_on_56", "MANTLE_ON"),
        ("bo1", "zombie_mantle_over_40", "MANTLE_OVER"),
        ("bo1", "zombie_jump_down_190", "JUMP_DOWN"),
        ("bo1", "zombie_wall_crawl_drop_quick", "JUMP_DOWN"),
        ("bo1", "zombie_quad_vent_jump_down", "JUMP_DOWN"),
        ("bo1", "zombie_jump_up_222", "UNKNOWN"),  # in common_zombie.ff, named by no shipped node
        ("ghosts", "step_down", "JUMP_DOWN"),
        ("ghosts", "alien_climb_up", "SPECIAL"),
        ("aw", "boost_jump_up", "SPECIAL"),
        ("aw", "bot_walk_forward", "SPECIAL"),
        ("aw", "ladder_down", "LADDER_DOWN"),
        ("mw3", "mantle_on_40", "UNKNOWN"),  # a Black Ops name MW3 never ships
        ("aw", "", "UNKNOWN"),
    ],
)
def test_traversal_kind(game, animscript, kind):
    assert vocab.traversal_kind(game, animscript) == kind


def test_mask_and_names_round_trip():
    value = vocab.mask(vocab.LINK_FLAGS, ["GAME", "NEGOTIATION"])
    assert value == 9
    assert vocab.names(vocab.LINK_FLAGS, value) == ["GAME", "NEGOTIATION"]


def test_fixture_json_is_valid_and_readable():
    # The fixture is hand-edited; a stray NaN or a duplicate key would pass json.load silently.
    with open(conformance.JSON_PATH, encoding="utf-8") as fh:
        text = fh.read()

    def no_duplicates(pairs):
        keys = [k for k, _ in pairs]
        assert len(keys) == len(set(keys)), keys
        return dict(pairs)

    json.loads(text, object_pairs_hook=no_duplicates, parse_constant=lambda c: pytest.fail(f"{c} in the fixture"))
