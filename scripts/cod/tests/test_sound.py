"""The alias closure, the unit conversions, and the four traps that fail as silence."""

import pytest

from scripts.cod import sound, worldfile
from scripts.cod.units import UNITS_PER_M


def clip(name, streamed=False):
    if streamed:
        head, _, tail = name.rpartition("/")
        return {"exists": 1, "type": 2, "typeName": "SAT_STREAMED", "loaded": None, "streamed": {"dir": head, "name": tail}}
    return {"exists": 1, "type": 1, "typeName": "SAT_LOADED", "loaded": {"name": name}, "streamed": None}


def entry(**over):
    """A minimal dumped alias entry; every field the converter touches, overridable."""
    out = {
        "aliasName": "a",
        "distMin": 0.0,
        "distMax": 600.0,
        "flags": 0,
        "mixerGroup": None,
        "pitchMin": 1.0,
        "pitchMax": 1.0,
        "probability": 1.0,
        "secondaryAliasName": None,
        "soundFile": clip("amb/one.wav"),
        "startDelay": 0,
        "volMin": 1.0,
        "volMax": 1.0,
    }
    out.update(over)
    return out


def alias(name, entries=None):
    entries = entries if entries is not None else [entry()]
    return {"_type": "sound_alias", "_version": 1, "_game": "iw5", "name": name, "count": len(entries), "entries": entries}


def write(tmp_path, *aliases):
    """A `sound_aliases/` dump on disk, as a backend writes one."""
    import json

    root = tmp_path / "sound_aliases"
    root.mkdir(parents=True, exist_ok=True)
    for data in aliases:
        (root / (data["name"] + ".json")).write_text(json.dumps(data))
    return str(root)


# -- the closure -----------------------------------------------------------------


def test_closure_follows_the_secondary_alias_layer():
    """A layer that is not exported plays as nothing, and nothing at run time says so."""
    defs = {
        "a": alias("a", [entry(secondaryAliasName="b")]),
        "b": alias("b", [entry(secondaryAliasName="c")]),
        "c": alias("c"),
        "unused": alias("unused"),
    }
    names, missing = sound.closure(defs, ["a"])
    assert names == {"a", "b", "c"} and missing == set()


def test_closure_names_what_it_could_not_resolve():
    names, missing = sound.closure({"a": alias("a", [entry(secondaryAliasName="gone")])}, ["a", "never"])
    assert names == {"a"} and missing == {"gone", "never"}


def test_closure_survives_an_alias_that_layers_itself():
    names, missing = sound.closure({"a": alias("a", [entry(secondaryAliasName="a")])}, ["a"])
    assert names == {"a"} and missing == set()


# -- the four traps --------------------------------------------------------------


def test_a_leading_comma_is_linkage_and_not_part_of_the_name():
    """A map zone spells a shared clip `,footsteps/foot_dirt01.wav`; left on, every lookup misses."""
    defs = {"b": alias("b")}
    assert sound.closure(defs, [",b"])[0] == {"b"}
    out = sound.convert(alias("a", [entry(soundFile=clip(",footsteps/foot_dirt01.wav"), secondaryAliasName=",layer")]))
    assert out["clips"][0]["file"] == "footsteps/foot_dirt01"
    assert out["with"] == "layer"


def test_a_placed_alias_matches_the_zone_without_case():
    """Live, not theoretical: dome places `emt_wind_grass_Ext` against a zone defining `..._ext`."""
    defs = {"emt_wind_grass_ext": alias("emt_wind_grass_ext")}
    assert sound.closure(defs, ["emt_wind_grass_Ext"]) == ({"emt_wind_grass_ext"}, set())


def test_two_aliases_differing_only_in_case_are_refused_rather_than_shadowed(tmp_path):
    root = write(tmp_path, alias("Land_plr_dirt"), alias("land_plr_dirt"))
    with pytest.raises(ValueError, match="differ only in case"):
        sound.load_dump(root)


def test_distances_become_metres():
    out = sound.convert(alias("a", [entry(distMin=787.4, distMax=1968.5)]))
    assert out["range"] == pytest.approx([20.0, 50.0])
    assert 1968.5 / UNITS_PER_M == pytest.approx(50.0)


def test_an_absurd_distance_means_not_in_the_world_at_all():
    """A `_plr` alias scaled naively is a 63 km sphere, which sounds right until two players stand apart."""
    assert sound.convert(alias("a", [entry(distMax=2000.0)]))["spatial"] is True
    assert sound.convert(alias("a", [entry(distMax=22000.0)]))["spatial"] is True
    assert sound.convert(alias("a", [entry(distMax=sound.SPATIAL_MAX_UNITS)]))["spatial"] is False
    assert sound.convert(alias("a", [entry(distMax=2500000.0)]))["spatial"] is False


def test_only_bit_zero_of_flags_is_read_and_the_word_is_carried():
    out = sound.convert(alias("a", [entry(flags=6816)]))
    assert out["loop"] is False and out["flags"] == 6816
    assert sound.convert(alias("a", [entry(flags=6817)]))["loop"] is True


def test_an_alias_loops_if_any_of_its_variants_does():
    """Exported as a one-shot, a wind loop is one pass of wind and then silence."""
    assert sound.convert(alias("a", [entry(flags=0), entry(flags=1)]))["loop"] is True


# -- the rest of the row ---------------------------------------------------------


def test_probability_is_an_unnormalised_weight_left_for_the_picker():
    """The bank carries 1.3 beside 0.05; a table summing to 1 and one summing to 9 must pick alike."""
    out = sound.convert(alias("a", [entry(probability=3.0), entry(probability=0.2), entry(probability=1.0)]))
    assert [c["weight"] for c in out["clips"]] == [3.0, 0.2, 1.0]
    assert sum(c["weight"] for c in out["clips"]) != pytest.approx(1.0)


def test_a_pair_is_the_envelope_over_the_variants():
    quiet = entry(volMin=0.4, volMax=0.5, pitchMin=1.1, pitchMax=1.1)
    loud = entry(volMin=0.3, volMax=0.9, pitchMin=1.2, pitchMax=1.2)
    out = sound.convert(alias("a", [quiet, loud]))
    assert out["volume"] == pytest.approx([0.3, 0.9]) and out["pitch"] == pytest.approx([1.1, 1.2])


def test_only_the_mixer_groups_the_game_names_become_a_channel():
    assert sound.convert(alias("a", [entry(mixerGroup="ambience")]))["channel"] == "ambience"
    assert "channel" not in sound.convert(alias("a", [entry(mixerGroup="max")]))
    assert "channel" not in sound.convert(alias("a", [entry(mixerGroup=None)]))


def test_start_delay_is_milliseconds():
    assert sound.convert(alias("a", [entry(startDelay=50)]))["delay"] == pytest.approx(0.05)


def test_a_streamed_clip_keeps_the_games_own_path_without_its_extension():
    out = sound.convert(alias("a", [entry(soundFile=clip("ambient/amb_mp_parisday_lr.mp3", streamed=True))]))
    assert out["clips"] == [{"file": "ambient/amb_mp_parisday_lr", "weight": 1.0}]
    assert sound.clip_file(entry(soundFile=clip("ambient/amb.mp3", streamed=True)))[2] == "sound/ambient/amb.mp3"


def test_a_clip_that_does_not_exist_is_left_out_rather_than_named_as_nothing():
    out = sound.convert(alias("a", [entry(soundFile={"exists": 0, "typeName": "SAT_LOADED", "loaded": None, "streamed": None})]))
    assert out["clips"] == []


# -- the world file --------------------------------------------------------------


def _meta(placements):
    return {"fx": {"effects": {}, "placements": placements}}


def test_every_alias_named_in_the_world_file_was_exported(tmp_path):
    """The likeliest silent breakage: a name the table cannot resolve just never plays."""
    data = _meta(
        [
            {"create": "createLoopSound", "soundalias": "emt_wind_grass_Ext", "at": [1.0, 2.0, 3.0]},
            {"create": "createLoopSound", "soundalias": "absent", "at": [0.0, 0.0, 0.0]},
            {"create": "createOneshotEffect", "fxid": "storm", "at": [0.0, 0.0, 0.0]},
        ]
    )
    path, n_aliases, n_places, unknown = worldfile.write_sound_world(str(tmp_path), "mp_x", data, {"emt_wind_grass_ext"})
    text = open(path).read()

    assert n_places == 1 and n_aliases == 1 and unknown == {"absent"}
    assert "alias: emt_wind_grass_ext, at: 1.000 2.000 3.000" in text
    assert "absent" not in text and "storm" not in text
    assert 'sounds { source: "assets/sounds/sounds.json" }' in text


def test_placements_of_one_alias_get_distinct_names(tmp_path):
    data = _meta([{"create": "createLoopSound", "soundalias": "emt_x", "at": [0.0, 0.0, 0.0]} for _ in range(3)])
    path, _, n_places, _ = worldfile.write_sound_world(str(tmp_path), "mp_x", data, {"emt_x"})
    names = [line.split()[1] for line in open(path).read().splitlines() if line.startswith("sound ")]
    assert n_places == 3 and names == ["emt_x_0", "emt_x_1", "emt_x_2"]


def test_a_map_that_places_no_sound_leaves_no_stale_file(tmp_path):
    stale = tmp_path / "sound.world"
    stale.write_text("sound old { alias: gone }\n")
    assert worldfile.write_sound_world(str(tmp_path), "mp_x", _meta([]), set())[0] is None
    assert not stale.exists()


# -- the shared catalogue --------------------------------------------------------


def test_the_overlap_between_two_zones_is_proved_rather_than_merged():
    """The catalogue takes the union with one map zone; a name meaning two things is a finding."""
    bank = {"a": alias("a", [entry(distMax=600.0)])}
    same = {"a": alias("a", [entry(distMax=600.0)]), "step_run_plr_dirt": alias("step_run_plr_dirt")}
    defs, shared, conflicts = sound.merge_dumps(bank, same)
    assert shared == ["a"] and conflicts == []
    assert set(defs) == {"a", "step_run_plr_dirt"}

    louder = {"a": alias("a", [entry(distMax=2000.0)])}
    _, shared, conflicts = sound.merge_dumps(bank, louder)
    assert shared == ["a"] and conflicts == ["a"]


def test_the_bank_wins_where_both_zones_define_a_name():
    bank = {"a": alias("a", [entry(volMax=1.0)])}
    defs, _, _ = sound.merge_dumps(bank, {"a": alias("a", [entry(volMax=0.1)])})
    assert sound.convert(defs["a"])["volume"][1] == pytest.approx(1.0)


def test_the_families_are_what_the_catalogue_is_the_closure_of():
    """`land*` and not `land_*`: the bank ships `Land_plr_carpet` beside `land_plr_ceramic`."""
    assert sound.family_of("step_sprint_plr_metal") == "steps"
    assert sound.family_of("land_plr_snow") == "steps"
    assert sound.family_of("gear_rattle_plr_land") == "foley"
    assert sound.family_of("bodyfall_metal_large") == "foley"
    assert sound.family_of("emt_wind_dome_flap_ext") is None
    assert sound.family_of("walla_rus_mountain_chatter") is None


def test_a_weapons_aliases_are_read_out_of_the_prose_they_hide_in():
    """`notetrackSoundMap` and `soundOverrides` are tables inside one value; `none` and `fire` are not aliases."""
    defs = {"weap_m4_fire_plr": alias("weap_m4_fire_plr"), "weap_m4_clipout_plr": alias("weap_m4_clipout_plr")}
    info = {
        "fireSoundPlayer": "weap_m4_fire_plr",
        "notetrackSoundMap": "weap_m4_clipout_plr weap_m4_clipout_plr\nmelee_knife_stab melee_knife_stab",
        "soundOverrides": "silencer none player_fire weap_m4_fire_plr none",
        "missileConeSoundHeight": "0",
        "gunModel": "viewmodel_m4",  # not a sound key, and its value is not an alias either
    }
    assert sound.weapon_roots({"m4_mp": info}, defs) == {"weap_m4_fire_plr", "weap_m4_clipout_plr"}


def test_a_map_zones_ambience_is_never_a_catalogue_root():
    """The union is with a map zone, but only for the families named -- not for the map's own emitters."""
    defs = {"step_run_plr_dirt": alias("step_run_plr_dirt"), "emt_wind_dome_flap_ext": alias("emt_wind_dome_flap_ext")}
    roots = sound.catalog_roots(defs, {})
    assert roots["steps"] == {"step_run_plr_dirt"}
    assert "emt_wind_dome_flap_ext" not in set().union(*roots.values())


def test_the_player_own_steps_are_what_makes_a_map_zone_worth_reading():
    mixed = {"step_run_plr_dirt": 1, "step_run_dirt": 1, "land_metal": 1, "emt_x": 1}
    assert sound.own_steps(mixed) == {"step_run_plr_dirt", "land_metal"}
    assert sound.own_steps({"emt_wind_grass_ext": 1}) == set()


# --- Black Ops ------------------------------------------------------------------


def t5_entry(**over):
    """A dumped T5 entry, in the game's own fixed point."""
    out = {
        "name": "a",
        "secondaryname": None,
        "soundFile": {
            "type": 1,
            "typeName": "SAT_LOADED",
            "exists": 1,
            "loaded": {"name": "sound\\fly\\step.wav"},
            "streamed": None,
        },
        "flags": 0,
        "distMin": 50,
        "distMax": 1000,
        "startDelay": 100,
        "volMin": 46395,
        "volMax": 65535,
        "pitchMin": 27553,
        "pitchMax": 32767,
        "probability": 102,
    }
    out.update(over)
    return out


def t5_alias(name, entries):
    return {"_type": "sound_alias", "_version": 1, "_game": "t5", "name": name, "count": len(entries), "entries": entries}


def test_t5_fixed_point_lands_on_the_grid_it_was_authored_on():
    e = sound.t5_entry(t5_entry())
    assert e["volMin"] == pytest.approx(10 ** (-3 / 20), abs=1e-4)  # -3 dB
    assert e["volMax"] == 1.0
    assert e["pitchMin"] == pytest.approx(2 ** (-3 / 12), abs=1e-4)  # three semitones down
    assert e["pitchMax"] == 1.0
    assert e["probability"] == pytest.approx(0.4)


def test_t5_paths_are_relative_to_sound():
    """A loaded name and a streamed path both come as whole Windows paths; IW5 names a clip from inside `sound/`."""
    loaded = sound.t5_entry(t5_entry())
    assert sound.clip_file(loaded) == (sound.LOADED, "fly/step", "fly/step.wav")
    streamed = t5_entry(
        soundFile={
            "type": 2,
            "typeName": "SAT_STREAMED",
            "exists": 1,
            "loaded": None,
            "streamed": {"filename": "sound\\mpl\\ctf\\return_flag.wav"},
        }
    )
    assert sound.clip_file(sound.t5_entry(streamed)) == (sound.STREAMED, "mpl/ctf/return_flag", "sound/mpl/ctf/return_flag.wav")


def test_t5_spatial_is_the_flag_and_not_the_distance():
    """T5 spells "not in the world" as a distMax of 0 with bit 1 clear, where IW5 uses an absurd distance."""
    flat = sound.convert(t5_alias("plr", [sound.t5_entry(t5_entry(distMin=0, distMax=0, flags=0x80))]))
    placed = sound.convert(t5_alias("npc", [sound.t5_entry(t5_entry(flags=0x82))]))
    assert flat["spatial"] is False
    assert placed["spatial"] is True
    assert placed["range"] == pytest.approx([50 / UNITS_PER_M, 1000 / UNITS_PER_M])


def test_t5_names_are_added_under_the_engines_spelling(tmp_path):
    for name in (
        "fly_step_run_plr_concrete",
        "fly_step_crouch_walk_npc_dirt",
        "fly_land_npc_metal",
        "prj_bullet_impact_large_wood",
        "mpl_hit_alert",
        "fly_qstep_run_plr_dirt",
    ):
        (tmp_path / f"{name}.json").write_text(__import__("json").dumps(t5_alias(name, [t5_entry()])))
    defs = sound.load_dump(str(tmp_path))
    assert {"step_run_plr_concrete", "step_crouch_walk_dirt", "land_metal", "bullet_large_wood", "mp_hit_alert"} <= set(defs)
    # The game's own names stay, and the quiet-perk set is not a footstep the engine asks for.
    assert "fly_step_run_plr_concrete" in defs
    assert not any(n.startswith("step_") and "qstep" in n for n in defs)
    assert "step_run_plr_dirt" not in defs
