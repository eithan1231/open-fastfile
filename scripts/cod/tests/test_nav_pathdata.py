"""The navigation stage from a `pathdata` dump: the compiled graphs of Ghosts, AW and Black Ops as `nav.bin`.

Synthetic dumps in the schema scripts/cod/iw6/dumpers/pathdata.py writes, read
back from the bytes (test_nav_export.decode). The traps are the quiet ones: a
zone node or a dynamic node left in and linked to, an index not remapped after
one is dropped, a missing link back not flagged, a node array that is not the
entity lump's and still produces a plausible graph.
"""

import json
import math

import pytest

from scripts.cod import export, worldfile
from scripts.cod.nav.from_pathdata import NavSourceError, from_pathdata
from scripts.cod.nav.vocab import HEADER_FLAGS, LINK_FLAGS, LINK_KINDS, NODE_FLAGS, NODE_TYPES, TRAVERSAL_KINDS
from scripts.cod.tests.test_nav_export import decode

PATH, COVER_LEFT, BEGIN, END, ZONE = 1, 7, 17, 18, 0
CLASSNAMES = {PATH: "node_pathnode", COVER_LEFT: "node_cover_left", BEGIN: "node_negotiation_begin", END: "node_negotiation_end"}
GAME, WALK, TRAVERSE = LINK_FLAGS["GAME"], LINK_KINDS["WALK"], LINK_KINDS["TRAVERSE"]


def node(index, kind, origin, links=(), spawnflags=0, angle=0.0, animscript="", targetname="", group=None):
    return {
        "index": index,
        "type": kind,
        "origin": list(origin),
        "angle": angle,
        "spawnflags": spawnflags,
        "targetname": targetname,
        "target": "",
        "animscript": animscript,
        "script_linkName": "",
        "script_noteworthy": "",
        "parent": 0 if group is None else 7,
        "dynamicGroup": group,
        "zone": 0,
        "links": [
            {"target": t, "fDist": d, "flags": 0, "negotiationLink": neg, "disconnectCount": dc}
            for t, d, neg, dc in ((*lk, 0, 0)[:4] if len(lk) < 4 else lk for lk in links)
        ],
    }


def dump(game="iw6", yaw_bit=0x8000):
    """Ten path nodes in a row (each linked both ways to the next, bar 3 -> 4), a cover, a
    begin -> end pair, a node riding a dynamic group, and two zone nodes appended."""
    nodes = []
    for i in range(10):
        links = []
        if i > 0:
            links.append((i - 1, 100.0))
        if i < 9 and i != 3:
            links.append((i + 1, 100.0))
        nodes.append(node(i, PATH, (100.0 * i, -50.0 * i, 8.0), links))
    nodes[0]["links"].append({"target": 14, "fDist": 20.0, "flags": 0, "negotiationLink": 0, "disconnectCount": 0})
    nodes[5]["links"].append({"target": 13, "fDist": 30.0, "flags": 0, "negotiationLink": 0, "disconnectCount": 0})
    nodes[2]["links"][1]["disconnectCount"] = 1
    nodes.append(node(10, COVER_LEFT, (12.5, -40.0, 16.0), [(0, 45.25)], spawnflags=yaw_bit | 0x200, angle=90.0))
    nodes.append(node(11, BEGIN, (400.0, 40.0, 0.0), [(12, 56.0, 1, 0), (9, 90.0)], yaw_bit, 180.0, "jump_down_40", "traverse"))
    nodes.append(node(12, END, (400.0, 0.0, -32.0), [(9, 50.0)], targetname="pf1_auto2"))
    nodes.append(node(13, PATH, (5.0, 5.0, 5.0), [(5, 30.0)], group=0))
    nodes.append(node(14, ZONE, (1.0, 1.0, 0.0), [(15, 900.0)]))
    nodes.append(node(15, ZONE, (2.0, 2.0, 0.0), [(14, 900.0)]))
    return {
        "_game": game,
        "_type": "pathdata",
        "_version": 1,
        "name": "maps/mp/mp_test.d3dbsp",
        "version": 21,
        "nodeCount": 16,
        "zoneCount": 2,
        "nodes": nodes,
        "dynamicNodeGroups": [{"parentIndex": 7, "nodes": [13]}],
        "counts": {"entityNodes": 14, "zoneNodes": 2, "dynamicNodes": 1, "links": 0},
    }


def t5_dump():
    """The same graph as Black Ops ships one: no zone nodes, no dynamic group, no version,
    and bad-place counts where IW has link flags."""
    pd = dump("t5")
    nodes = pd["nodes"][:13]
    for n in nodes:
        n.update(parent=None, dynamicGroup=None, zone=255)
        n["links"] = [lk for lk in n["links"] if lk["target"] < 13]
        for lk in n["links"]:
            del lk["flags"]
            lk["ubBadPlaceCount"] = [0, 0, 0, 0]
    pd.update(nodes=nodes, version=None, nodeCount=13, zoneCount=0, dynamicNodeGroups=[])
    pd["counts"] = {"entityNodes": 13, "zoneNodes": 0, "dynamicNodes": 0, "links": 0}
    return pd


def lump(pathdata, drop=30):
    """The entity lump the dump's entity nodes came from, with other entities around them.
    Each entity sits `drop` inches above its node, as a compiler that floors its nodes leaves them."""
    ents = [{"classname": "worldspawn"}, {"classname": "mp_tdm_spawn", "origin": "0 0 0"}]
    for n in pathdata["nodes"][: pathdata["nodeCount"] - pathdata["zoneCount"]]:
        x, y, z = n["origin"]
        ents.append({"classname": CLASSNAMES[n["type"]], "origin": f"{x:g} {y:g} {z + drop:g}"})
    return ents


def build(pathdata=None, game_key="iw6"):
    pathdata = pathdata or dump(game_key)
    nav, why = from_pathdata(pathdata, lump(pathdata), game_key, "mp_test")
    assert nav is not None, why
    return nav, decode(export.encode_nav(nav))


def test_nodes_are_the_entity_nodes_less_zone_and_dynamic_ones_with_their_source_index():
    nav, out = build()
    types = {v: k for k, v in NODE_TYPES.items()}
    assert [types[n["type"]] for n in out["nodes"]] == ["PATH"] * 10 + ["COVER_LEFT", "TRAVERSE_BEGIN", "TRAVERSE_END"]
    assert [n["source"] for n in out["nodes"]] == list(range(13))
    assert nav.skipped == {"dynamicNodes": 1, "zoneNodes": 2}
    assert out["meta"]["skipped"] == {"dynamicNodes": 1, "zoneNodes": 2}
    assert out["nodes"][11]["name"] == "traverse"


def test_positions_are_on_the_floor_and_converted_as_gameplay_world_converts():
    _, out = build()
    assert all(n["flags"] & NODE_FLAGS["FLOOR_Z"] for n in out["nodes"])
    x, y, z = out["nodes"][1]["at"]
    assert (round(x, 3), round(y, 3), round(z, 3)) == (round(100 / 39.37, 3), round(8 / 39.37, 3), round(50 / 39.37, 3))


@pytest.mark.parametrize(("game_key", "bit"), [("iw6", 0x8000), ("s1", 0x80000)])
def test_a_yaw_comes_from_the_games_own_angles_given_bit(game_key, bit):
    _, out = build(dump(game_key, bit), game_key)
    assert [i for i, n in enumerate(out["nodes"]) if n["flags"] & NODE_FLAGS["HAS_YAW"]] == [10, 11]
    assert out["nodes"][10]["yaw"] == 0  # CoD 90 faces engine -Z, the player's yaw 0
    # AW's cover-stance bits sit where IW's "angles given" does: 0x8000 alone is no yaw there.
    _, other = build(dump(game_key, 0x8000 if bit != 0x8000 else 0x80000), game_key)
    assert not any(n["flags"] & NODE_FLAGS["HAS_YAW"] for n in other["nodes"])


def test_walk_links_are_the_games_with_fdist_as_given_and_one_way_where_no_link_comes_back():
    _, out = build()
    assert out["flags"] == HEADER_FLAGS["HAS_GAME_WALK_LINKS"]
    walks = {(lk["from"], lk["to"]): lk for lk in out["links"] if lk["kind"] == WALK}
    assert all(lk["flags"] & GAME for lk in walks.values())
    assert walks[(10, 0)]["cost"] == 45.25
    one_way = {k for k, lk in walks.items() if lk["flags"] & LINK_FLAGS["ONE_WAY_IN_GAME"]}
    # 4 -> 3 has no 3 -> 4; the cover and the pair's end link to nodes that do not link back.
    assert one_way == {(4, 3), (10, 0), (11, 9), (12, 9)}
    assert walks[(2, 3)]["flags"] & LINK_FLAGS["START_DISCONNECTED"]
    assert not walks[(3, 2)]["flags"] & LINK_FLAGS["START_DISCONNECTED"]


def test_links_touching_a_skipped_node_are_dropped_and_counted():
    nav, out = build()
    ends = {lk["to"] for lk in out["links"]} | {lk["from"] for lk in out["links"]}
    assert max(ends) < 13
    assert nav.meta["links"]["droppedToSkippedNodes"] == 2  # 0 -> zone node, 5 -> dynamic node
    assert nav.meta["links"]["walk"] == len([lk for lk in out["links"] if lk["kind"] == WALK])


def test_a_negotiation_link_is_the_traversal_and_its_kind_comes_from_the_animscript():
    _, out = build()
    assert out["traversals"] == [{"begin": 11, "end": 12, "kind": TRAVERSAL_KINDS["JUMP_DOWN"], "animscript": "jump_down_40"}]
    (link,) = [lk for lk in out["links"] if lk["kind"] == TRAVERSE]
    assert (link["from"], link["to"], link["traversal"]) == (11, 12, 0)
    assert link["flags"] == GAME | LINK_FLAGS["NEGOTIATION"] | LINK_FLAGS["ONE_WAY_IN_GAME"]
    assert link["cost"] == 56.0  # kept, though on a traversal it is a cost and not a length


def test_unknown_animscripts_and_unpaired_nodes_are_reported():
    pd = dump()
    pd["nodes"][11]["animscript"] = "cartwheel_64"
    nav, _ = build(pd)
    assert nav.meta["unknownAnimscripts"] == {"cartwheel_64": 1}
    assert [t.kind for t in nav.traversals] == ["UNKNOWN"]
    pd["nodes"][11]["links"] = pd["nodes"][11]["links"][1:]  # the begin loses its negotiation link
    nav, _ = build(pd)
    assert nav.traversals == [] and nav.meta["unpaired"] == {"begin": [11], "end": [12]}


def test_a_node_array_that_is_not_the_entity_lumps_is_refused():
    pd = dump()
    ents = lump(pd)
    with pytest.raises(NavSourceError, match="node_\\* entities"):
        from_pathdata(pd, ents[:-1], "iw6", "mp_test")
    moved = [dict(e) for e in ents]
    moved[5]["origin"] = "300.5 -150 38"  # node 3, half an inch off in x
    with pytest.raises(NavSourceError, match="#3"):
        from_pathdata(pd, moved, "iw6", "mp_test")
    swapped = [dict(e) for e in ents]
    swapped[12]["classname"] = "node_cover_right"  # node 10 is a cover_left
    with pytest.raises(NavSourceError, match="#10"):
        from_pathdata(pd, swapped, "iw6", "mp_test")


def test_data_this_mapping_does_not_expect_is_refused():
    pd = dump()
    pd["nodes"][15]["type"] = PATH  # zone nodes are type 0, and last
    with pytest.raises(NavSourceError, match="zone node"):
        from_pathdata(pd, lump(pd), "iw6", "mp_test")
    pd = dump()
    pd["nodes"][0]["links"][0]["negotiationLink"] = 1  # a negotiation link between two path nodes
    with pytest.raises(NavSourceError, match="negotiation link 0 -> 1"):
        from_pathdata(pd, lump(pd), "iw6", "mp_test")
    pd = dump()
    ents = lump(pd)
    pd["nodes"][4]["type"] = 22  # COVER_UP_3D: numbered, and never shipped
    with pytest.raises(NavSourceError, match="type 22"):
        from_pathdata(pd, ents, "iw6", "mp_test")
    with pytest.raises(NavSourceError, match="s1 pathdata"):
        from_pathdata(dump("iw6"), lump(dump()), "s1", "mp_test")


def test_export_writes_the_graph_from_a_dump_and_exits_on_a_mismatch(tmp_path):
    pd = dump()
    path = tmp_path / "mp_test.d3dbsp.pathdata.json"
    path.write_text(json.dumps(pd))
    out = tmp_path / "world"
    out.mkdir()
    written, report = export.export_navigation("mp_test", str(out), {"game": "iw6", "entities": lump(pd)}, str(path))
    assert written is True
    assert "13 node(s), 1 traversal(s)" in report and "one-way" in report and "zoneNodes x2" in report
    assert decode((out / worldfile.NAV_FILE).read_bytes())["flags"] == HEADER_FLAGS["HAS_GAME_WALK_LINKS"]
    assert "from the map's path data" in (out / "navigation.world").read_text()
    with pytest.raises(SystemExit, match="navigation: .*node_"):
        export.export_navigation("mp_test", str(out), {"game": "iw6", "entities": lump(pd)[:-2]}, str(path))


def test_without_its_path_zone_a_ghosts_or_aw_graph_is_left_as_it_is(tmp_path, capsys):
    (tmp_path / "navigation.world").write_text("kept")
    written, report = export.export_navigation("mp_test", str(tmp_path), {"game": "iw6", "entities": []})
    assert written is None and "_path.ff" in report
    (tmp_path / "export_metadata.json").write_text(json.dumps({"game": "iw6", "entities": []}))
    (tmp_path / "world.world").write_text('include "navigation.world"\n')
    assert export.rewrite_navigation("mp_test", str(tmp_path), [str(tmp_path / "no-game-here")]) is None
    assert "Is the game installed?" in capsys.readouterr().out
    assert (tmp_path / "navigation.world").read_text() == "kept"
    assert 'include "navigation.world"' in (tmp_path / "world.world").read_text()


def test_black_ops_keeps_the_authored_height_and_is_checked_against_it():
    pd = t5_dump()
    nav, why = from_pathdata(pd, lump(pd, drop=0), "t5", "mp_test")
    assert nav is not None, why
    out = decode(export.encode_nav(nav))
    assert not any(n["flags"] & NODE_FLAGS["FLOOR_Z"] for n in out["nodes"])
    assert out["flags"] == HEADER_FLAGS["HAS_GAME_WALK_LINKS"]
    assert nav.meta["entityMatch"] == {"nodes": 13, "compared": "x y z type", "worst": 0.0}
    assert nav.skipped == {}
    walks = {(lk["from"], lk["to"]): lk for lk in out["links"] if lk["kind"] == WALK}
    assert walks[(2, 3)]["flags"] & LINK_FLAGS["START_DISCONNECTED"]
    assert out["traversals"][0]["kind"] == TRAVERSAL_KINDS["JUMP_DOWN"]
    # A node whose z is not its entity's is another node: refused, where a floored source is not.
    with pytest.raises(NavSourceError, match="x/y/z"):
        from_pathdata(pd, lump(pd, drop=30), "t5", "mp_test")
    assert from_pathdata(dump(), lump(dump()), "iw6", "mp_test")[0].meta["entityMatch"]["compared"] == "x y type"


def test_black_ops_reads_its_graph_from_the_map_zone_itself(tmp_path, capsys):
    (tmp_path / "export_metadata.json").write_text(json.dumps({"game": "t5", "entities": []}))
    (tmp_path / "world.world").write_text('include "navigation.world"\n')
    assert export.rewrite_navigation("mp_test", str(tmp_path), [str(tmp_path / "no-game-here")]) is None
    printed = capsys.readouterr().out
    assert "own mp_test.ff" in printed and "_path.ff" not in printed


def test_yaw_and_costs_survive_the_round_trip_to_f32():
    nav, out = build()
    assert math.isclose(nav.nodes[11].yaw, math.radians(90.0))
    assert [lk["cost"] for lk in out["links"] if lk["from"] == 0] == [100.0]


def t6_dump():
    """The same graph as Black Ops II ships one: Black Ops' shape, with T6's link `flags` and
    five bad-place counts."""
    pd = t5_dump()
    pd["_game"] = "t6"
    for n in pd["nodes"]:
        for lk in n["links"]:
            lk["flags"] = 0x08  # wide enough for a double-width AI: a walk link like any other
            lk["ubBadPlaceCount"] = [0] * 5
    return pd


def test_black_ops_ii_leaves_out_the_links_its_search_never_takes():
    pd = t6_dump()
    # 4 -> 5 and 5 -> 4 are redundant (flag 0x10), and 7 -> 6 alone is: 6 -> 7 stays, one way.
    for i, target in ((4, 5), (5, 4), (7, 6)):
        next(lk for lk in pd["nodes"][i]["links"] if lk["target"] == target)["flags"] |= 0x10
    nav, why = from_pathdata(pd, lump(pd, drop=0), "t6", "mp_test")
    assert nav is not None, why
    out = decode(export.encode_nav(nav))
    walks = {(lk["from"], lk["to"]): lk for lk in out["links"] if lk["kind"] == WALK}
    assert (4, 5) not in walks and (5, 4) not in walks and (7, 6) not in walks
    assert walks[(6, 7)]["flags"] & LINK_FLAGS["ONE_WAY_IN_GAME"]
    assert not walks[(5, 6)]["flags"] & LINK_FLAGS["ONE_WAY_IN_GAME"]
    assert nav.meta["links"]["unsearched"] == 3
    # The bit is Black Ops II's alone: in another game's dump it drops nothing.
    pd = t5_dump()
    pd["nodes"][4]["links"][1]["flags"] = 0x10
    nav = from_pathdata(pd, lump(pd, drop=0), "t5", "mp_test")[0]
    assert nav.meta["links"] == from_pathdata(t5_dump(), lump(pd, drop=0), "t5", "mp_test")[0].meta["links"]


def test_a_black_ops_ii_hint_names_the_move_where_the_animscript_is_empty():
    for spawnflags, kind, name in (
        (0x800000, "MANTLE_ON", "MANTLE"),
        (0x2000000, "JUMP_DOWN", "FALL"),
        (0x400000, "LADDER_UP", "LADDER"),
        (0x1000000, "UNKNOWN", "JUMP"),  # ships on no map: up or across is not known
        (0x800000 | 0x2000000, "UNKNOWN", ""),
    ):
        pd = t6_dump()
        pd["nodes"][11].update(animscript="", spawnflags=spawnflags)
        nav, why = from_pathdata(pd, lump(pd, drop=0), "t6", "mp_test")
        assert nav is not None, why
        (trav,) = nav.traversals
        assert (trav.kind, trav.animscript) == (kind, name), spawnflags
        assert nav.meta.get("unknownAnimscripts", {}) == ({name: 1} if kind == "UNKNOWN" else {})
    # An animscript wins, as it does in the game's own choice of script.
    pd = t6_dump()
    pd["nodes"][11]["spawnflags"] |= 0x2000000
    assert from_pathdata(pd, lump(pd, drop=0), "t6", "mp_test")[0].traversals[0].kind == "JUMP_DOWN"


def test_the_t6_link_is_sixteen_bytes_with_flags_after_the_negotiation_byte():
    from scripts.cod.t6.dumpers import pathdata as t6

    raw = t6.LINK.pack(56.0, 12, 1, 0, 0x28, 1, 2, 3, 4, 5) + t6.LINK.pack(15.0, 3, 0, 1, 0, 0, 0, 0, 0, 0)

    class Links:
        elem = 16

        def __len__(self):
            return 2

        def unpack(self, fmt):
            import struct

            return struct.iter_unpack(fmt, raw)

    assert t6.LINK.size == 16
    first, second = t6.links({"constant.Links": Links()}, 2)
    assert first == {
        "target": 12,
        "fDist": 56.0,
        "flags": 0x28,
        "negotiationLink": 0,
        "disconnectCount": 1,
        "ubBadPlaceCount": [1, 2, 3, 4, 5],
    }
    assert (second["target"], second["negotiationLink"], second["fDist"]) == (3, 1, 15.0)
