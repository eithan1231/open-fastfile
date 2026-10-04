"""The navigation stage: a map's `node_*` entities as `assets/nav.bin` and `navigation.world`.

The file is read back here by hand, from the byte layout in
docs/engine/nav-format.md, so a test checks what a reader will see rather than
what the encoder was handed. The traps it guards are the quiet ones: a node a
metre off because it went through a different conversion than the spawns, a
cover facing backwards, a traversal that lost its pair.
"""

import json
import math
import os
import struct

from scripts.cod import export, worldfile
from scripts.cod.metadata import _entity, facing
from scripts.cod.nav.from_ents import MIN_NODES, engine_yaw, from_entities
from scripts.cod.nav.vocab import HEADER_FLAGS, LINK_FLAGS, LINK_KINDS, NODE_FLAGS, NODE_TYPES, TRAVERSAL_KINDS


def decode(data):
    """The parts of a nav.bin these tests look at, read straight from the bytes."""
    assert data[:4] == b"3DNV"
    flags, length, count, table = struct.unpack_from("<IIII", data, 8)
    assert length == len(data)
    sections = {}
    for i in range(count):
        tag, _version, _flags, offset, size = struct.unpack_from("<4sHHII", data, table + 16 * i)
        sections[tag.decode()] = data[offset : offset + size]

    strings = [""]
    if "STRS" in sections:
        s = sections["STRS"]
        (n,) = struct.unpack_from("<I", s, 0)
        offsets = struct.unpack_from(f"<{n + 1}I", s, 8)
        blob = s[8 + 4 * (n + 1) :]
        strings = [blob[offsets[i] : offsets[i + 1]].decode() for i in range(n)]

    node_count, stride = struct.unpack_from("<II", sections["NODE"], 0)
    nodes = []
    for i in range(node_count):
        x, y, z, yaw, kind, nflags, _abil, source, name, _group, _stance, _ = struct.unpack_from(
            "<fffHBBIIIHBB", sections["NODE"], 8 + i * stride
        )
        nodes.append({"at": (x, y, z), "yaw": yaw, "type": kind, "flags": nflags, "source": source, "name": strings[name]})

    links = []
    if "LINK" in sections:
        s = sections["LINK"]
        link_count, stride, n, _ = struct.unpack_from("<IIII", s, 0)
        first = struct.unpack_from(f"<{n + 1}I", s, 16)
        start = 16 + 4 * (n + 1)
        start += -start % 8
        for node in range(n):
            for k in range(first[node], first[node + 1]):
                target, cost, kind, lflags, trav = struct.unpack_from("<IfBBH", s, start + k * stride)
                links.append({"from": node, "to": target, "cost": cost, "kind": kind, "flags": lflags, "traversal": trav})
        assert len(links) == link_count

    travs = []
    if "TRAV" in sections:
        trav_count, stride = struct.unpack_from("<II", sections["TRAV"], 0)
        for i in range(trav_count):
            begin, end, kind, _f, _r, anim = struct.unpack_from("<IIBBHI", sections["TRAV"], 8 + i * stride)
            travs.append({"begin": begin, "end": end, "kind": kind, "animscript": strings[anim]})

    meta = json.loads(sections["META"]) if "META" in sections else {}
    return {"flags": flags, "nodes": nodes, "links": links, "traversals": travs, "meta": meta}


def lump(pathnodes=8, extra=()):
    """An MW3-shaped entity list, as export_metadata.json holds it: keys named, `at` beside `origin`."""
    ents = [{"classname": "worldspawn"}, {"classname": "mp_tdm_spawn", "origin": "0 0 0", "angles": "0 45 0"}]
    ents += [{"classname": "node_pathnode", "origin": f"{100 * i} {-37.5 * i} {8 + i}"} for i in range(pathnodes)]
    ents += [
        {"classname": "node_cover_left", "origin": "12.5 -40 16", "angles": "0 90 0"},
        {"classname": "node_cover_stand", "origin": "-3 7 0", "angles": "0 0 0", "targetname": "stand1"},
        {"classname": "node_negotiation_end", "origin": "400 0 -32", "angles": "0 180 0", "targetname": "pf1_auto2"},
        {
            "classname": "node_negotiation_begin",
            "origin": "400 40 0",
            "angles": "0 180 0",
            "targetname": "traverse",
            "target": "pf1_auto2",
            "1983": "jumpdown_40",
        },
        *extra,
    ]
    return [_entity(i, e) for i, e in enumerate(ents)]


def build(entities, game="iw5"):
    nav, why = from_entities(entities, game, "mp_test")
    assert nav is not None, why
    return decode(export.encode_nav(nav))


def test_nodes_are_the_node_entities_in_lump_order_with_standard_types():
    out = build(lump())
    types = {v: k for k, v in NODE_TYPES.items()}
    assert [types[n["type"]] for n in out["nodes"]] == ["PATH"] * 8 + [
        "COVER_LEFT",
        "COVER_STAND",
        "TRAVERSE_END",
        "TRAVERSE_BEGIN",
    ]
    assert [n["source"] for n in out["nodes"]] == list(range(12))
    assert out["nodes"][9]["name"] == "stand1"


def test_positions_are_the_same_conversion_gameplay_world_uses():
    """`at` is what gameplay.world writes for an entity; a node must land exactly there (to f32)."""
    ents = lump()
    nodes = build(ents)["nodes"]
    for node, ent in zip(nodes, [e for e in ents if e["classname"].startswith("node_")], strict=True):
        assert node["at"] == tuple(struct.unpack("<3f", struct.pack("<3f", *ent["at"])))


def test_a_node_is_not_on_the_floor_and_has_a_yaw_only_with_angles():
    nodes = build(lump())["nodes"]
    assert all(not n["flags"] & NODE_FLAGS["FLOOR_Z"] for n in nodes)
    assert [bool(n["flags"] & NODE_FLAGS["HAS_YAW"]) for n in nodes] == [False] * 8 + [True] * 4


def test_yaw_faces_where_a_spawn_built_from_the_same_angles_would_look():
    """CoD yaw 90 faces engine -Z, which is the player's yaw 0; CoD 0 faces +X, a quarter turn the other way."""
    nodes = build(lump())["nodes"]
    assert nodes[8]["yaw"] == 0
    assert nodes[9]["yaw"] == 49152
    for cod in (0.0, 37.0, 90.0, 180.0, 265.8, -45.0):
        phi = engine_yaw(cod)
        fx, _, fz = facing(cod)
        assert math.isclose(-math.sin(phi), fx, abs_tol=1e-4)
        assert math.isclose(-math.cos(phi), fz, abs_tol=1e-4)


def test_a_negotiation_pair_is_a_traversal_and_its_one_link():
    out = build(lump())
    assert out["flags"] == HEADER_FLAGS["DERIVE_WALK_LINKS"]
    assert out["traversals"] == [
        {"begin": 11, "end": 10, "kind": TRAVERSAL_KINDS["JUMP_DOWN"], "animscript": "jumpdown_40"},
    ]
    (link,) = out["links"]
    assert (link["from"], link["to"], link["traversal"]) == (11, 10, 0)
    assert link["kind"] == LINK_KINDS["TRAVERSE"]
    assert link["flags"] == LINK_FLAGS["NEGOTIATION"]  # no GAME: the zone compiled no link
    assert math.isnan(link["cost"])


def test_meta_says_where_the_graph_came_from():
    meta = build(lump())["meta"]
    assert meta["source"] == "ents"
    assert meta["game"] == "mw3"
    assert meta["nodes"]["PATH"] == 8
    assert meta["traversals"] == {"JUMP_DOWN": 1}
    assert "unpaired" not in meta and "unknownAnimscripts" not in meta


def test_unknown_animscripts_and_unpaired_nodes_are_reported(tmp_path):
    extra = [
        {"classname": "node_negotiation_end", "origin": "0 0 0", "targetname": "lonely"},
        {"classname": "node_negotiation_begin", "origin": "0 0 0", "target": "nowhere", "1983": "wall_over_40"},
        {"classname": "node_negotiation_end", "origin": "9 9 9", "targetname": "e2"},
        {"classname": "node_negotiation_begin", "origin": "9 9 0", "target": "e2", "1983": "cartwheel_64"},
        {"classname": "node_ghost", "origin": "1 1 1"},
    ]
    nav, _ = from_entities(lump(extra=extra), "iw5", "mp_test")
    assert nav.meta["unknownAnimscripts"] == {"cartwheel_64": 1}
    assert nav.meta["unpaired"] == {"begin": [13], "end": [12]}
    assert nav.skipped == {"node_ghost": 1}
    kinds = [t.kind for t in nav.traversals]
    assert kinds == ["JUMP_DOWN", "UNKNOWN"]  # still written: whether it is usable is decided at load
    _, report = export.export_navigation("mp_test", str(tmp_path), {"game": "iw5", "entities": lump(extra=extra)})
    assert "UNKNOWN animscript(s)" in report and "cartwheel_64 x1" in report
    assert "in no traversal" in report


WORLD = """collision { source: "assets/collision.glb" }

include "props.world"
include "ladder.world"
include "fx.world"
"""


def test_nav_only_writes_the_graph_and_includes_it_after_the_ladders(tmp_path):
    with open(tmp_path / "world.world", "w") as fh:
        fh.write(WORLD)
    with open(tmp_path / "export_metadata.json", "w") as fh:
        json.dump({"game": "iw5", "entities": lump()}, fh)
    assert export.rewrite_navigation("mp_test", str(tmp_path))
    text = (tmp_path / "world.world").read_text()
    assert 'include "ladder.world"\ninclude "navigation.world"\ninclude "fx.world"' in text
    assert 'navigation { source: "assets/nav.bin" }' in (tmp_path / "navigation.world").read_text()
    assert len(decode((tmp_path / worldfile.NAV_FILE).read_bytes())["nodes"]) == 12

    # Idempotent, and a map that loses its graph loses all three.
    assert export.rewrite_navigation("mp_test", str(tmp_path))
    assert text == (tmp_path / "world.world").read_text()
    with open(tmp_path / "export_metadata.json", "w") as fh:
        json.dump({"game": "iw5", "entities": lump(pathnodes=0)[:5]}, fh)
    assert not export.rewrite_navigation("mp_test", str(tmp_path))
    assert "navigation.world" not in (tmp_path / "world.world").read_text()
    assert not os.path.exists(tmp_path / "navigation.world")
    assert not os.path.exists(tmp_path / worldfile.NAV_FILE)


def test_fewer_than_ten_nodes_write_nothing(tmp_path):
    few = lump(pathnodes=MIN_NODES - 5)
    assert len([e for e in few if e["classname"].startswith("node_")]) == MIN_NODES - 1
    nav, why = from_entities(few, "iw5", "mp_test")
    assert nav is None and "fewer than 10" in why
    written, _ = export.export_navigation("mp_test", str(tmp_path), {"game": "iw5", "entities": few})
    assert written is False
    assert os.listdir(tmp_path) == []


def test_mw2_writes_nothing_and_an_unwired_game_is_left_alone(tmp_path):
    written, report = export.export_navigation("mp_rust", str(tmp_path), {"game": "iw4", "entities": lump()})
    assert written is False and "MW2" in report
    (tmp_path / "navigation.world").write_text("kept")
    written, report = export.export_navigation("mp_x", str(tmp_path), {"game": "t9", "entities": lump()})
    assert written is None and "not wired yet" in report
    assert (tmp_path / "navigation.world").read_text() == "kept"
