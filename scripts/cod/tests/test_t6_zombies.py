"""Black Ops II zombies (TranZit): what the export needs beyond the MP maps.

The research is reverse/t6-zombies. The data tests read the retail zones and skip
where zombies is not installed (as test_t6.py finds it).
"""

import os
import re

import pytest

from scripts.cod.maps import load_maps
from scripts.cod.nav import vocab
from scripts.cod.pack import add_colour_maps

from .test_t6 import BO2_ZONES

TRANSIT = os.path.join(BO2_ZONES, "zm_transit.ff")


def test_a_material_named_by_another_zone_gets_its_colour_map_from_the_dump():
    """A gump model names the map zone's material under a comma, so its writer saw no textures."""
    gltf = {
        "materials": [
            {"name": "mc/metal_wall_brushed"},
            {"name": "mc/own", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}},
            {"name": "mc/no_colour"},
        ],
        "images": [{"uri": "../images/own_col.dds"}],
        "textures": [{"source": 0}],
    }
    colours = {"mc/metal_wall_brushed": "metal_wall_brushed_col", "mc/own": "other_col"}
    assert add_colour_maps(gltf, colours) == 1
    first, own, none = gltf["materials"]
    assert gltf["images"][gltf["textures"][first["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"]] == {
        "uri": "../images/metal_wall_brushed_col.dds"
    }
    assert own["pbrMetallicRoughness"]["baseColorTexture"] == {"index": 0}  # its own pick stands
    assert "baseColorTexture" not in none["pbrMetallicRoughness"]


def test_every_transit_traversal_has_a_kind():
    """The zombies' animscripts are exact rows: a new one would come out UNKNOWN."""
    names = [n for n in vocab.ANIMSCRIPT_KINDS["bo2"] if n.startswith("zm_")]
    assert len(names) == 19
    assert all(vocab.traversal_kind("bo2", n) not in ("UNKNOWN", "SPECIAL") for n in names)


def _entities(walk):
    (ents,) = [a.record for a in walk.by_type("mapents") if not a.name.startswith(",")]
    text = bytes(ents["entityString"].bytes())[: ents["numEntityChars"] - 1].decode("latin-1")
    return [dict(re.findall(r'"([^"]*)" "([^"]*)"', block)) for block in re.findall(r"\{(.*?)\}", text, re.S)]


@pytest.mark.skipif(not os.path.exists(TRANSIT), reason="Black Ops II zombies is not installed")
def test_transit_companions_hold_every_model_the_map_only_names():
    """Every xmodel zm_transit names under a comma is held by exactly one of maps.json's
    companions, the gumps holding 454 and no two gumps the same one; and every traversal
    the map's path nodes use has a kind."""
    from scripts.cod.zonecode import walk_fastfile

    (entry,) = [m for m in load_maps()[1] if m["map"] == "zm_transit"]
    walk = walk_fastfile(TRANSIT)
    named = {a.name[1:] for a in walk.by_type("xmodel") if a.name.startswith(",")}
    scripts = {e["animscript"] for e in _entities(walk) if e.get("classname") == "node_negotiation_begin"}
    del walk
    holders = {}
    for zone in entry["common"]:
        own = {a.name for a in walk_fastfile(os.path.join(BO2_ZONES, zone)).by_type("xmodel") if not a.name.startswith(",")}
        for name in own & named:
            holders.setdefault(name, []).append(zone)
    gumps = [name for name, zones in holders.items() if any("_gump_" in z for z in zones)]
    assert len(gumps) == 454
    assert all(len([z for z in zones if "_gump_" in z]) <= 1 for zones in holders.values())
    # berlin_wood_table is named and held by no zone at all: nothing places it.
    assert named - set(holders) == {"berlin_wood_table"}
    assert all(vocab.traversal_kind("bo2", s) not in ("UNKNOWN", "SPECIAL") for s in scripts), scripts
