import json
import math

import pytest

from scripts.cod.entities import named_keys
from scripts.cod.metadata import (
    dumps,
    facing,
    minimap_frame,
    parse_createfx,
    parse_script,
    spawn_kind,
    t5_sound_emitters,
    zombie_spawn_kind,
    zone_listing,
)
from scripts.cod.units import to_engine
from scripts.cod.worldfile import minimap_node


@pytest.mark.parametrize(
    "classname, kind",
    [
        ("mp_dm_spawn", {"mode": "dm", "team": None, "start": False, "variant": None}),
        ("mp_tdm_spawn_allies_start", {"mode": "tdm", "team": "allies", "start": True, "variant": None}),
        ("mp_dd_spawn_defender_a", {"mode": "dd", "team": "defender", "start": False, "variant": "a"}),
        ("mp_dom_spawn_flag_c", {"mode": "dom", "team": None, "start": False, "variant": "flag_c"}),
        ("mp_uspawn_influencer", None),
        ("mp_global_intermission", None),
    ],
)
def test_spawn_kind(classname, kind):
    assert spawn_kind(classname) == kind


def test_minimap_up_is_cod_x_by_default():
    # With no worldspawn `northyaw` the game's north is CoD +X, so image right is
    # CoD -Y. Assuming +Y (a top-down view's usual up) draws every map rotated 90°:
    # plausible, and wrong. Checked on all 43 maps by plotting spawns on the image.
    f = minimap_frame((0, 0), (100, 100), 0)
    assert f["top_left"] == (100, 100)
    assert f["top_right"] == (100, 0)
    assert f["bottom_left"] == (0, 100)
    assert f["bottom_right"] == (0, 0)
    assert f["up"] == (1, 0)


def test_minimap_frame_is_widened_to_square_about_its_centre():
    f = minimap_frame((0, 0), (200, 100), 0)
    assert f["top_left"] == (200, 150)
    assert f["bottom_right"] == (0, -50)


def test_minimap_frame_follows_northyaw():
    f = minimap_frame((0, 0), (100, 100), 90)
    assert f["top_left"] == pytest.approx((0, 100))
    assert f["top_right"] == pytest.approx((100, 100))

    # mp_estate's 144°: still a square, its top edge square to `up`.
    f = minimap_frame((-2300, -900), (1800, 2600), 144)
    top = (f["top_right"][0] - f["top_left"][0], f["top_right"][1] - f["top_left"][1])
    side = (f["top_left"][0] - f["bottom_left"][0], f["top_left"][1] - f["bottom_left"][1])
    assert math.hypot(*top) == pytest.approx(math.hypot(*side))
    assert top[0] * f["up"][0] + top[1] * f["up"][1] == pytest.approx(0, abs=1e-6)
    assert side[0] * f["up"][0] + side[1] * f["up"][1] > 0


def _engine_frame(f):
    """`image_corners` as build_metadata writes them: engine x z per corner."""
    return {k: {"xz": to_engine((p[0], p[1], 0))[::2]} for k, p in f.items() if k != "up"}


def test_minimap_node_turns_north_onto_the_image_up():
    # Image up is CoD +X, which is engine +X: rotateY(north, -90°).
    node = minimap_node(_engine_frame(minimap_frame((0, 0), (3937, 3937), 0)))
    assert node == {"source": '"assets/minimap.png"', "at": "50.000 -50.000", "size": "100.000 100.000", "rotate": "-90"}
    assert minimap_node(_engine_frame(minimap_frame((-2300, -900), (1800, 2600), 144)))["rotate"] == "54"
    assert minimap_node(None) is None


def test_minimap_node_refuses_a_mirrored_frame():
    f = _engine_frame(minimap_frame((0, 0), (100, 100), 0))
    f["top_left"], f["top_right"] = f["top_right"], f["top_left"]
    f["bottom_left"]["xz"] = (f["bottom_left"]["xz"][0], f["top_left"]["xz"][1])
    with pytest.raises(ValueError, match="mirrored"):
        minimap_node(f)


def test_facing_mirrors_cod_y_onto_engine_minus_z():
    assert facing(0) == [1.0, 0.0, -0.0]
    assert facing(90) == [0.0, 0.0, -1.0]


def test_named_keys_decodes_iw5_only():
    iw5 = [{"1668": "mp_dm_spawn", "1669": "1 2 3", "99999": "x"}]
    assert named_keys(iw5, "iw5") == [{"classname": "mp_dm_spawn", "origin": "1 2 3", "99999": "x"}]
    assert named_keys(iw5, "iw4") is iw5


def test_parse_script_keeps_literal_settings(tmp_path):
    path = tmp_path / "mp_x.gsc"
    path.write_text(
        "main()\n{\n"
        '\tmaps\\mp\\_compass::setupMiniMap( "compass_map_mp_x" );\n'
        '\tsetdvar( "compassmaxrange", "2000" );\n'
        '\tSetDvar( "scr_spawn_enemy_influencer_radius", 1600 ); // tuned\n'
        "\tsetExpFog( 581.8, 15447.9, 0.4, 0.5, 0.6, 0.58, 0 );\n"
        '\tlevel._effect[ "smoke" ] = loadfx( "smoke/ground" );\n'
        "\tthread something( level.x );\n"
        '\tgame["attackers"] = "allies";\n'
        '\tgame["strings"]["war_callsign_a"] = &"MPUI_CALLSIGN_MAPNAME_A";\n'
        "\tent.startDist = 1274;\n"
        "}\n"
    )
    s = parse_script(str(path))
    assert s["dvars"] == {"compassmaxrange": "2000", "scr_spawn_enemy_influencer_radius": 1600}
    assert [c["call"] for c in s["calls"]] == ["setupMiniMap", "setExpFog"]
    assert s["calls"][1]["named"]["halfwayDist"] == 15447.9
    assert s["assignments"] == {
        'game["attackers"]': "allies",
        'game["strings"]["war_callsign_a"]': "&MPUI_CALLSIGN_MAPNAME_A",
        "ent.startDist": 1274,
    }


def test_parse_createfx_reads_both_spellings(tmp_path):
    path = tmp_path / "mp_x_fx.gsc"
    path.write_text(
        "main()\n{\n"
        '\tent = createOneshotEffect( "smoke" );\n'
        '\tent.v[ "origin" ] = ( 39.37, 0, 78.74 );\n'
        '\tent.v[ "fxid" ] = "smoke";\n'
        '\tent.v[ "delay" ] = -15;\n'
        "\tent = createLoopSound();\n"
        '\tent.v[ "origin" ] = ( 0, 39.37, 0 );\n'
        '\tent.v[ "soundalias" ] = "wind";\n'
        '\tent = maps\\mp\\_utility::createOneshotEffect( "flies" );\n'
        '\tent.v[ "type" ] = "oneshotfx";\n'
        "}\n"
    )
    fx = parse_createfx(str(path))
    assert [f["create"] for f in fx] == ["createOneshotEffect", "createLoopSound", "createOneshotEffect"]
    assert fx[0]["at"] == [1.0, 2.0, -0.0] and fx[0]["delay"] == -15
    assert fx[1]["soundalias"] == "wind" and "name" not in fx[1]
    assert fx[2]["name"] == "flies" and fx[2]["type"] == "oneshotfx"


def test_parse_createfx_reads_the_compact_form(tmp_path):
    """mp_village's: without it, all 574 of its one-shot effects were dropped."""
    path = tmp_path / "mp_x_fx.gsc"
    path.write_text(
        "main()\n{\n"
        'ent = createOneshotEffect( "smoke" );\n'
        "ent set_origin_and_angles( (39.37,0,78.74),(270,0,0) );\n\n"
        'ent = createOneshotEffect( "dirt" );\n'
        "ent set_origin_and_angles( (0,0,0),(0,0,0) );\n"
        'ent.v[ "delay" ] = 25;\n'
        "}\n"
    )
    fx = parse_createfx(str(path))
    assert fx[0]["fxid"] == "smoke" and fx[0]["delay"] == -15
    assert fx[0]["at"] == [1.0, 2.0, -0.0] and fx[0]["angles"] == [270, 0, 0]
    assert fx[1]["fxid"] == "dirt" and fx[1]["delay"] == 25


def test_zone_listing(tmp_path):
    path = tmp_path / "mp_x.zone"
    path.write_text("// Call Of Duty: Modern Warfare 3\n>game,IW5\n\nrawfile,vision/mp_x.vision\nimage,a\nimage,b\n")
    assert zone_listing(str(path)) == ("iw5", {"rawfile": ["vision/mp_x.vision"], "image": ["a", "b"]})


def test_dumps_is_json():
    value = {
        "a": [1, 2],
        "entities": [{"id": i, "origin": "1 2 3", "note": "x" * 50} for i in range(5)],
        "nested": {"k": {"deep": list(range(60))}},
    }
    text = dumps(value)
    assert json.loads(text) == value
    assert text.count("\n") < 20


def test_zombies_players_start_at_structs():
    start = {"classname": "script_struct", "targetname": "initial_spawn_points", "script_int": "1"}
    respawn = {"classname": "script_struct", "targetname": "player_respawn_point", "script_noteworthy": "alleyway_zone"}
    assert zombie_spawn_kind(start) == {"mode": "zombies", "team": None, "start": True, "variant": None}
    assert zombie_spawn_kind(respawn) == {"mode": "zombies", "team": None, "start": False, "variant": "alleyway_zone"}
    # A zombie's own spawner is not somewhere a player starts.
    assert zombie_spawn_kind({"classname": "actor_zombie_ger_zombie", "targetname": "foyer_spawners"}) is None
    assert zombie_spawn_kind({"classname": "script_struct", "targetname": "amb_wind"}) is None


def test_t5_looping_emitters_become_loop_placements_and_random_ones_do_not():
    at = [1.0, 2.0, 3.0]
    entities = [
        {"classname": "script_struct", "script_sound": "amb_water_pipe", "script_label": "looper", "at": at},
        {"classname": "script_struct", "script_sound": "amb_river", "script_label": "line_emitter", "at": at},
        {"classname": "script_struct", "script_sound": "amb_wind_gust", "script_label": "random", "at": at},
        {"classname": "trigger_multiple", "script_sound": "fly_bump_car", "at": at},
    ]
    placed = t5_sound_emitters(entities)
    assert [p["soundalias"] for p in placed] == ["amb_water_pipe", "amb_river"]
    assert all(p["create"] == "createLoopSound" for p in placed)
