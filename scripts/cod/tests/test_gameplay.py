"""`gameplay.world`: the map's own spawn points and triggers, as DSL nodes.

The engine reads the world file and nothing else, so anything a match needs from
the entity lump has to survive this step. These check the shapes that would
otherwise fail silently — a spawn facing the wrong way, a radius left in inches.
"""

import os

from scripts.cod.units import UNITS_PER_M
from scripts.cod.worldfile import PLAYER_EYE, _spawn_lines, _trigger_lines, write_gameplay_world


def spawn(**kw):
    base = {"mode": "tdm", "team": None, "start": False, "at": [1.0, 2.0, 3.0], "facing": [0.0, 0.0, -1.0]}
    return {**base, **kw}


def test_spawn_carries_mode_team_and_start():
    (line,) = _spawn_lines([spawn(team="allies", start=True)])
    assert 'mode: "tdm"' in line
    assert 'team: "allies"' in line
    assert "start: on" in line


def test_spawn_omits_what_it_does_not_have():
    (line,) = _spawn_lines([spawn()])
    assert "team:" not in line
    assert "start:" not in line


def test_look_is_a_point_one_metre_along_the_facing_vector():
    """`facing` is a direction and `look:` is a point, so one must become the other."""
    (line,) = _spawn_lines([spawn(at=[10.0, 0.0, 10.0], facing=[1.0, 0.0, 0.0])])
    assert f"at: 10.0 {PLAYER_EYE} 10.0" in line
    assert f"look: 11.0 {PLAYER_EYE} 10.0" in line


def test_a_spawn_with_no_facing_looks_north():
    (line,) = _spawn_lines([spawn(at=[0.0, 0.0, 0.0], facing=None)])
    assert f"look: 0.0 {PLAYER_EYE} -1.0" in line


def test_a_spawn_point_is_written_at_the_eye_and_not_at_the_feet():
    """A `spawn` node's `at` is an eye position; a spawn entity's origin is on the floor.

    The engine subtracts its own EYE_HEIGHT to find the feet, so a point written
    at the entity's origin puts the player a body's height *underground*. This
    went unnoticed for as long as the server adopted whatever position the client
    claimed: the world's own `spawn` was lifted, these were not, and only the
    server ever used these.
    """
    (line,) = _spawn_lines([spawn(at=[0.0, 12.0, 0.0])])
    assert f"at: 0.0 {12.0 + PLAYER_EYE} 0.0" in line
    # And the two writers agree, which is the whole reason PLAYER_EYE is a name.
    assert PLAYER_EYE > 1.6, "a spawn must clear the engine's EYE_HEIGHT, or the player starts inside the floor"


def test_radius_trigger_converts_inches_to_metres():
    ent = {
        "id": 10,
        "classname": "trigger_radius",
        "at": [1.0, 2.0, 3.0],
        "radius": "64",
        "height": "128",
        "targetname": "ctf_zone",
    }
    lines, volumes, skipped = _trigger_lines([ent])
    assert (volumes, skipped) == (0, 0)
    assert f"radius: {round(64 / UNITS_PER_M, 3)}" in lines[0]
    assert f"height: {round(128 / UNITS_PER_M, 3)}" in lines[0]
    assert 'tag: "ctf_zone"' in lines[0]


def test_triggers_are_named_by_entity_id_so_a_shared_targetname_stays_distinct():
    """Three Domination flags share one targetname; `name` must still be unique."""
    ents = [
        {"id": 16, "classname": "trigger_radius", "at": [0, 0, 0], "radius": "64", "targetname": "flag_primary"},
        {"id": 18, "classname": "trigger_radius", "at": [1, 0, 0], "radius": "64", "targetname": "flag_primary"},
    ]
    lines, _, _ = _trigger_lines(ents)
    assert lines[0].startswith("trigger t16 {")
    assert lines[1].startswith("trigger t18 {")


def test_a_trigger_with_no_volume_to_read_is_counted_not_guessed_at():
    """IW's `?N` is the entity lump's own trigger table, which nothing dumps: a made-up size would be worse."""
    lines, volumes, skipped = _trigger_lines([{"id": 1, "classname": "trigger_use_touch", "at": [0, 0, 0], "model": "?0"}])
    assert (lines, volumes, skipped) == ([], 0, 1)


def test_a_brush_volume_trigger_is_left_to_volumes_world():
    lines, volumes, skipped = _trigger_lines([{"id": 1, "classname": "info_volume", "at": [0, 0, 0], "model": "*4"}])
    assert (lines, volumes, skipped) == ([], 1, 0)


def test_non_triggers_are_left_alone():
    lines, volumes, skipped = _trigger_lines([{"id": 1, "classname": "script_model", "at": [0, 0, 0]}])
    assert (lines, volumes, skipped) == ([], 0, 0)


def test_writes_a_file_and_reports_its_counts(tmp_path):
    out = str(tmp_path)
    path, spawns, triggers, _, skipped, *_ = write_gameplay_world(
        out,
        "mp_test",
        {
            "spawns": [spawn(), spawn(team="axis")],
            "entities": [{"id": 1, "classname": "trigger_radius", "at": [0, 0, 0], "radius": "64"}],
        },
    )
    assert (spawns, triggers, skipped) == (2, 1, 0)
    body = open(path).read()
    assert body.startswith("// mp_test's spawn points, triggers")
    assert body.count("spawn {") == 2


def test_a_map_with_neither_writes_nothing_and_clears_a_stale_file(tmp_path):
    out = str(tmp_path)
    stale = os.path.join(out, "gameplay.world")
    open(stale, "w").write("// left over from a previous export\n")

    path, spawns, triggers, *_ = write_gameplay_world(out, "mp_test", {"spawns": [], "entities": []})

    assert (path, spawns, triggers) == (None, 0, 0)
    assert not os.path.exists(stale)


def mode_entities():
    """A bomb-site crate, a wager barrier, a Domination trigger, an everyday wall and a trigger's brush model."""
    here = {"at": [0, 0, 0]}
    return [
        {**here, "id": 1, "classname": "script_brushmodel", "model": "*3", "script_gameobjectname": "bombzone"},
        {**here, "id": 2, "classname": "script_brushmodel", "model": "*4", "script_gameobjectname": "oic gun hlnd shrp"},
        {**here, "id": 3, "classname": "trigger_radius", "radius": "64", "script_gameobjectname": "dom onslaught"},
        {**here, "id": 4, "classname": "script_brushmodel", "model": "*5"},
        {**here, "id": 5, "classname": "trigger_use_touch", "model": "*6", "script_gameobjectname": "sd"},
    ]


def test_a_brush_model_only_some_modes_have_is_a_solid_naming_its_part(tmp_path):
    written = write_gameplay_world(str(tmp_path), "mp_test", {"game": "t5", "entities": mode_entities()})
    body = open(written.path).read()
    assert written.solids == 2 and written.triggers == 1 and written.volumes == 1
    assert 'solid { part: "*3", mode: "dem" "sd" }' in body
    assert 'solid { part: "*4", mode: "gun" "hlnd" "oic" "shrp" }' in body
    # An unrestricted wall stays base, and a trigger's brush model is not a solid at all.
    assert '"*5"' not in body and '"*6"' not in body
    assert f'trigger t3 {{ at: 0 0 0, radius: {round(64 / UNITS_PER_M, 3)}, mode: "dom" "twar" }}' in body


def test_a_world_whose_metadata_names_no_game_gets_no_modes(tmp_path):
    written = write_gameplay_world(str(tmp_path), "mp_test", {"entities": mode_entities()})
    assert written.solids == 0 and "mode:" not in open(written.path).read()
