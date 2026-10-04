"""Advanced Warfare's numbered entity keys, and the one spawn entity its maps have.

No game files: the snippets here are the shapes the fourteen AW zones write, cut
down to what each claim rests on. How the numbers were derived is in
`scripts/cod/entities.py` and reverse/s1-zone/README.md#the-entity-keys.
"""

from scripts.cod.entities import KEY_NAMES_BY_GAME, named_keys, parse_ents
from scripts.cod.gltf import write_glb
from scripts.cod.worldfile import GAMES, PLAYER_EYE, write_world_file

# mp_prison's first three entities verbatim, plus the two trigger_radius entities
# every AW map carries: a CTF flag (radius 64, height 128) and a Domination one
# (160, 128), which is the pair that tells `radius` from `height` apart.
PRISON = """
{
58 ".116"
171 "worldspawn"
1048 "-38 -122 0"
1047 "1 0.894118 0.682353"
1049 "1"
}
{
31215 "bombzone"
171 "trigger_use_touch"
1191 "bombtrigger"
742 "-8256 9088 24"
672 "?5"
}
{
1189 "pf1_auto1"
1191 "airdrop_crate"
742 "-8256 9088 2"
171 "script_model"
672 "com_plasticcase_green_big_us_dirt"
987 "4"
65 "90 180 -180"
}
{
31215 "ctf"
171 "trigger_radius"
742 "965.1 1910.2 656"
852 "64"
489 "128"
919 "_a"
}
{
31215 "dom onslaught"
171 "trigger_radius"
742 "117 3617 -9.8"
852 "160"
489 "128"
}
"""


def test_the_numbers_become_the_names_the_pipeline_reads(tmp_path):
    path = tmp_path / "mp_prison.ents"
    path.write_text(PRISON)
    ws, bomb, crate, ctf, dom = named_keys(parse_ents(str(path)), "s1")

    assert ws == {
        "ambient": ".116",
        "classname": "worldspawn",
        "sundirection": "-38 -122 0",
        "suncolor": "1 0.894118 0.682353",
        "sunlight": "1",
    }
    assert bomb["classname"] == "trigger_use_touch" and bomb["script_gameobjectname"] == "bombzone"
    assert bomb["targetname"] == "bombtrigger" and bomb["model"] == "?5"
    assert crate["target"] == "pf1_auto1" and crate["origin"] == "-8256 9088 2"
    assert crate["spawnflags"] == "4" and crate["angles"] == "90 180 -180"
    # The pair: a CTF flag trigger is 64 wide and 128 tall, a Domination one 160
    # and 128 -- which is what every IW map writes, and reading them the other way
    # round gives two plausible cylinders of the wrong shape.
    assert (ctf["radius"], ctf["height"], ctf["script_label"]) == ("64", "128", "_a")
    assert (dom["radius"], dom["height"]) == ("160", "128")


def test_an_unnamed_key_stays_a_number(tmp_path):
    path = tmp_path / "a.ents"
    path.write_text('{\n171 "worldspawn"\n36816 "13.4"\n1395 "0 0 0"\n}\n')
    (only,) = named_keys(parse_ents(str(path)), "s1")
    # 36816 is shaped like `northyaw` and 1395 like `_color`; naming either from
    # its shape alone would silently rotate the HUD map or black out the ambient.
    assert set(only) == {"classname", "36816", "1395"}
    assert "36816" not in KEY_NAMES_BY_GAME["s1"] and "1395" not in KEY_NAMES_BY_GAME["s1"]


def a_shell(assets):
    assets.mkdir()
    write_glb(
        assets / "world.glb",
        {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 2, "type": "VEC3", "min": [0, 0, 0], "max": [1, 2, 3]}
            ],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 24}],
            "buffers": [{"byteLength": 24}],
        },
        bytearray(24),
    )


def test_the_one_spawn_entity_is_found_even_close_to_the_world_origin(tmp_path):
    """mp_laser2's `info_player_start` is at 0 -264 264, and no AW map has another.

    Picking the origin by its magnitude alone (the rule for a game with no key
    table) reads that entity as having none, and the map comes out with a
    placeholder spawn two metres above 0 0 0 -- in the sky, or inside a wall.
    """
    ents = tmp_path / "a.ents"
    ents.write_text('{\n171 "worldspawn"\n}\n{\n171 "info_player_start"\n742 "0 -264 264"\n65 "0 90 0"\n}\n')
    a_shell(tmp_path / "assets")
    path, had_spawn, _, _ = write_world_file(
        str(tmp_path), "mp_laser2", str(ents), str(tmp_path / "assets"), None, GAMES["s1"], "s1", props=False
    )
    assert had_spawn
    # 264 units up is 6.706 m, plus the eye height a spawn node's `at` carries.
    assert f"spawn {{ at: 0.0 {round(6.71 + PLAYER_EYE, 2)} 6.71" in open(path).read()
