"""Which game modes an entity exists in: each game's `_gameobjects.gsc` rule as data.

No game files: the entities are the shapes the stock maps carry, and the lists
are the ones docs/cod/reference.md#game-mode-objects cites line by line.
"""

import pytest

from scripts.cod.brushmodels import preflight
from scripts.cod.gameobjects import MapFacts, allowed_names, mode_clause, modes_of


def ent(names, classname="script_brushmodel"):
    return {"classname": classname, "script_gameobjectname": names}


FACTS = MapFacts(map="mp_test")


def test_mw2_keeps_a_bomb_site_in_its_bomb_modes_and_calls_war_tdm():
    assert modes_of("iw4", ent("bombzone"), FACTS) == ["dd", "sd"]
    assert modes_of("iw4", ent("hq"), FACTS) == ["koth"]
    assert modes_of("iw4", ent("ctf"), FACTS) == ["ctf", "oneflag"]
    assert modes_of("iw4", ent("sd"), FACTS) == ["sd", "vip"]
    assert modes_of("iw4", ent("war"), FACTS) == ["tdm"]
    assert "war" not in allowed_names("iw4", FACTS)


def test_mw3s_demolition_has_its_own_bomb_sites():
    assert modes_of("iw5", ent("bombzone"), FACTS) == ["sd"]
    assert modes_of("iw5", ent("dd_bombzone"), FACTS) == ["dd"]
    assert modes_of("iw5", ent("dom dd sd"), FACTS) == ["arena", "dd", "dom", "sd", "vip"]


def test_aw_reads_as_mw3_with_its_own_two_modes():
    assert modes_of("s1", ent("dd_bombzone"), FACTS) == ["dd"]
    assert modes_of("s1", ent("hp"), FACTS) == ["hp"]
    assert modes_of("s1", ent("horde"), FACTS) == ["horde"]


def test_black_ops_tags_a_wager_barrier_with_exactly_the_four_wager_modes():
    assert modes_of("t5", ent("oic gun hlnd shrp"), FACTS) == ["gun", "hlnd", "oic", "shrp"]
    assert modes_of("t5", ent("tdm"), FACTS) == ["tdm"]
    assert modes_of("t5", ent("hq"), FACTS) == ["koth"]


def test_ghosts_has_no_list_so_anything_carrying_the_key_stays(capsys):
    assert modes_of("iw6", ent("dom"), MapFacts(map="mp_x")) is None
    assert "'dom' is in no iw6 gametype's list" in capsys.readouterr().out


def test_black_ops_demolition_falls_back_to_the_sd_bomb_sites_on_a_map_without_its_own():
    assert modes_of("t5", ent("bombzone"), FACTS) == ["dem", "sd"]
    own = MapFacts(map="mp_test", targetnames=frozenset({"bombzone_dem"}))
    assert modes_of("t5", ent("bombzone"), own) == ["sd"]
    assert modes_of("t5", ent("bombzone_dem"), own) == ["dem"]


def test_black_ops_war_keeps_domination_objects_only_on_a_map_without_its_spawns():
    assert modes_of("t5", ent("dom"), FACTS) == ["dom", "twar"]
    spawns = frozenset({"mp_twar_spawn_axis_start", "mp_twar_spawn_allies_start", "mp_twar_spawn"})
    assert modes_of("t5", ent("dom"), MapFacts(map="mp_test", classnames=spawns)) == ["dom"]
    # Any one missing is enough: twar.gsc checks both start sides, then the respawns.
    assert modes_of("t5", ent("dom"), MapFacts(map="mp_test", classnames=spawns - {"mp_twar_spawn"})) == ["dom", "twar"]


def test_black_ops_headquarters_allows_koth_on_kowloon_only():
    assert modes_of("t5", ent("koth dm"), FACTS) == ["dm"]
    assert modes_of("t5", ent("koth dm"), MapFacts(map="mp_kowloon")) == ["dm", "koth"]


def test_what_every_mode_keeps_is_untagged():
    assert modes_of("iw5", ent("airdrop_pallet"), FACTS) is None
    assert modes_of("iw4", ent("airdrop_pallet sd"), FACTS) is None
    assert modes_of("t5", ent("[all_modes]"), FACTS) is None
    assert modes_of("iw5", {"classname": "script_brushmodel"}, FACTS) is None


def test_an_unknown_name_is_untagged_and_printed_once(capsys):
    facts = MapFacts(map="mp_prison")
    assert modes_of("s1", ent("drop_obj"), facts) is None
    assert modes_of("s1", ent("drop_obj", "script_model"), facts) is None
    out = capsys.readouterr().out
    assert out.count("'drop_obj'") == 1 and "left in every mode" in out


def test_an_unknown_name_beside_known_ones_is_ignored():
    assert modes_of("iw5", ent("dom onslaught", "trigger_radius"), MapFacts(map="mp_dome")) == ["arena", "dom"]


def test_the_clause_lists_each_mode_as_a_string():
    assert mode_clause(["gun", "hlnd"]) == 'mode: "gun" "hlnd"'


def test_a_placed_brush_model_carries_its_entity_and_its_modes(tmp_path):
    ents = tmp_path / "map.ents"
    ents.write_text(
        '{\n"classname" "worldspawn"\n"origin" "0 0 0"\n}\n'
        '{\n"classname" "script_brushmodel"\n"origin" "100 0 0"\n"model" "*1"\n'
        '"script_gameobjectname" "oic gun hlnd shrp"\n}\n'
        '{\n"classname" "script_brushmodel"\n"origin" "200 0 0"\n"model" "*2"\n}\n'
    )
    gfxworld = {"models": [{"surfaceCount": 0, "startSurfIndex": 0}] * 3}
    cmodels = [{"brushes": brushes, "partitions": []} for brushes in ([], [0], [1])]
    clip = {"_game": "t5", "cmodels": cmodels, "dynEnts": [[], []]}
    placements = preflight(gfxworld, clip, True, str(ents), MapFacts(map="mp_test"))
    assert (placements[1]["entity"], placements[1]["modes"]) == (1, ["gun", "hlnd", "oic", "shrp"])
    assert (placements[2]["entity"], placements[2]["modes"]) == (2, None)
    # Without facts nothing is restricted: the placement is what it always was.
    assert preflight(gfxworld, clip, True, str(ents))[1]["modes"] is None


@pytest.mark.parametrize("game", ["iw4", "iw5", "s1", "t5"])
def test_every_mode_key_is_the_games_own_name_bar_war(game):
    keys = set(allowed_names(game, FACTS))
    assert "war" not in keys and "tdm" in keys
