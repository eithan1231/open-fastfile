"""Removable parts, `volumes.world` and the points and links of `gameplay.world`.

What a scripted mode reads off a map: a zone is every trigger box sharing a tag,
a door is a trigger whose `target` names the solids it removes, and a spawner is a
`point` its zone targets. Each of these fails plausibly: a box left in model space
lands at the origin, a dangling target is only a warning, and a door merged into
the base can never open.
"""

import math

import pytest

from scripts.cod import gameplay
from scripts.cod.brushmodels import dynamic_path, load, part_of
from scripts.cod.collision import export_collision
from scripts.cod.gltf import read_glb
from scripts.cod.metadata import to_engine as at_of
from scripts.cod.shell import export_shell
from scripts.cod.tests.test_geometry import mesh_triangles, placed, restricted_clipmap, shell_dump
from scripts.cod.tests.test_mantle import axial_brush, turned_brush
from scripts.cod.tests.test_props_gate import a_world
from scripts.cod.triggers import read_triggers
from scripts.cod.units import UNITS_PER_M, to_engine
from scripts.cod.worldfile import (
    GAMES,
    _point_lines,
    _solid_lines,
    ensure_include,
    write_gameplay_world,
    write_volumes_world,
    write_world_file,
)

# -- Removable parts ---------------------------------------------------------------------------------


def test_dynamicpath_is_spawnflags_bit_one_on_a_script_brushmodel_only():
    brush = {"classname": "script_brushmodel"}
    assert dynamic_path({**brush, "spawnflags": "1"}) and dynamic_path({**brush, "spawnflags": "3"})
    assert not dynamic_path({**brush, "spawnflags": "2"}) and not dynamic_path(brush)
    assert not dynamic_path({**brush, "spawnflags": "x"})
    # A trigger's brush model is a volume, never a wall, whatever its flags say.
    assert not dynamic_path({"classname": "trigger_use", "spawnflags": "1"})


def test_a_dynamicpath_brush_model_is_a_part_in_every_mode():
    where = {"n": 37, "solid": True, "modes": None}
    assert part_of({**where, "dynamic_path": True}) == "*37"
    assert part_of({**where, "modes": ["sd"]}) == "*37"
    assert part_of(where) is None
    assert part_of({**where, "dynamic_path": True, "solid": False}) is None


def test_load_reads_dynamicpath_off_the_entity_lump(tmp_path):
    ents = tmp_path / "m.ents"
    ents.write_text(
        '{\n"classname" "worldspawn"\n}\n'
        '{\n"classname" "script_brushmodel"\n"model" "*1"\n"origin" "8 0 0"\n"spawnflags" "1"\n}\n'
        '{\n"classname" "script_brushmodel"\n"model" "*2"\n"origin" "16 0 0"\n}\n'
        '{\n"classname" "trigger_use"\n"model" "*3"\n"origin" "24 0 0"\n"spawnflags" "1"\n}\n'
    )
    placements = load(str(ents), {"_game": "t5"})
    assert [placements[n]["dynamic_path"] for n in (1, 2, 3)] == [True, False, False]
    assert [part_of(placements[n]) for n in (1, 2, 3)] == ["*1", None, None]


def dynamic(n=1, entity=7):
    return {n: {**placed(None, n, entity)[n], "dynamic_path": True}}


def test_a_dynamicpath_brush_model_is_split_out_of_the_collision_and_loses_no_triangle(tmp_path):
    merged, split = str(tmp_path / "merged.glb"), str(tmp_path / "split.glb")
    export_collision(restricted_clipmap(tmp_path), merged, placed(None))
    export_collision(restricted_clipmap(tmp_path), split, dynamic())
    before, _, _ = mesh_triangles(merged)
    after, scene, extras = mesh_triangles(split)
    assert sorted(t for ts in before.values() for t in ts) == sorted(t for ts in after.values() for t in ts)
    assert list(after) == ["solid", "soup", "part:*1/solid", "part:*1/soup", "part:*1/clip:0x00010000"]
    assert extras["part:*1/solid"]["part"] == "*1" and extras["part:*1/solid"]["entity"] == 7
    assert scene == {"parts": [{"part": "*1", "triangles": sum(len(after[n]) for n in after if n.startswith("part:"))}]}


def test_a_dynamicpath_brush_model_is_drawn_as_a_part_of_its_own(tmp_path):
    world, decals = str(tmp_path / "world.glb"), str(tmp_path / "decals.glb")
    export_shell(shell_dump(tmp_path), world, decals, None, {}, set(), set(), {}, {**dynamic(), **placed(None, n=2)})
    gltf, _ = read_glb(world)
    assert [n["name"] for n in gltf["nodes"]] == ["world", "part:*1"]
    assert gltf["scenes"][0]["extras"] == {"parts": [{"part": "*1", "triangles": 1}]}


# -- Tags and targets --------------------------------------------------------------------------------


def test_tags_are_targetname_noteworthy_and_string_each_once():
    e = {"targetname": "a", "script_noteworthy": "a", "script_string": "riser"}
    assert gameplay.tags_of(e) == ["a", "riser"]
    assert gameplay.tags_of({}) == []


def test_a_tag_is_quoted_as_a_dsl_string():
    assert gameplay.strings(["a", 'b"c']) == '"a" "b\\"c"'


def zombies_entities():
    """A two-brush zone, a door trigger, the zone's spawner, the door's piece and a wall buy's chalk."""
    return [
        {
            "id": 5,
            "classname": "info_volume",
            "model": "*1",
            "origin": "1000 2000 50",
            "at": at_of((1000, 2000, 50)),
            "targetname": "foyer_zone",
            "script_noteworthy": "player_volume",
            "target": "foyer_zone_spawners",
        },
        {
            "id": 6,
            "classname": "trigger_use",
            "model": "*2",
            "origin": "-500 0 0",
            "at": at_of((-500, 0, 0)),
            "targetname": "zombie_door",
            "target": "backstage_door",
        },
        {
            "id": 7,
            "classname": "actor_zombie_ger_zombie",
            "origin": "40 0 8",
            "angles": "0 90 0",
            "at": at_of((40, 0, 8)),
            "targetname": "foyer_zone_spawners",
            "script_noteworthy": "zombie_spawner",
            "target": "auto1",
        },
        {
            "id": 8,
            "classname": "script_brushmodel",
            "model": "*9",
            "spawnflags": "1",
            "targetname": "backstage_door",
            "at": [0, 0, 0],
        },
        {
            "id": 9,
            "classname": "trigger_use_touch",
            "model": "*3",
            "origin": "0 0 0",
            "at": [0, 0, 0],
            "targetname": "weapon_upgrade",
            "target": "chalk",
        },
        {"id": 10, "classname": "script_model", "targetname": "chalk", "at": [0, 0, 0]},
        {"id": 11, "classname": "script_struct", "targetname": "auto1", "origin": "0 0 0", "at": [0, 0, 0]},
    ]


def zombies_clip():
    return {
        "brushes": [
            axial_brush(half=(20.0, 30.0, 12.0), mid=(0.0, 0.0, 0.0)),
            axial_brush(half=(10.0, 10.0, 12.0), mid=(100.0, 0.0, 0.0)),
            turned_brush(degrees=30.0),
            axial_brush(half=(4.0, 4.0, 4.0)),
        ],
        "cmodels": [{"brushes": []}, {"brushes": [0, 1]}, {"brushes": [2]}, {"brushes": [3]}],
    }


def by_name(found):
    return {t["name"]: t for t in found}


def test_a_zone_is_a_box_per_brush_placed_at_its_entity_origin():
    found, stats, _ = read_triggers(zombies_clip(), zombies_entities(), lambda e: None)
    zone = by_name(found)
    # Two brushes, two boxes, both named for the entity; model space + origin, in engine metres.
    assert zone["t5_0"]["at"] == pytest.approx(to_engine((1000, 2000, 50)), abs=1e-3)
    assert zone["t5_1"]["at"] == pytest.approx(to_engine((1100, 2000, 50)), abs=1e-3)
    assert zone["t5_0"]["size"] == pytest.approx((40 / UNITS_PER_M, 24 / UNITS_PER_M, 60 / UNITS_PER_M), abs=1e-3)
    assert zone["t5_0"]["yaw"] == 0 and zone["t5_0"]["use"] is None
    assert zone["t5_0"]["tags"] == ["foyer_zone", "player_volume"] and zone["t5_0"]["target"] == "foyer_zone_spawners"
    assert stats["entities"] == 3 and stats["boxes"] == 4 and stats["of several brushes"] == 1


def test_a_turned_trigger_keeps_its_yaw_and_a_use_trigger_is_used_from_near():
    door = by_name(read_triggers(zombies_clip(), zombies_entities(), lambda e: None)[0])["t6"]
    assert door["yaw"] == pytest.approx(30.0, abs=0.01)
    assert door["at"] == pytest.approx(to_engine((-500, 0, 0)), abs=1e-3)
    assert door["use"] == "near"
    # The door's piece is a DYNAMICPATH solid carrying the tag, so the link resolves.
    assert door["target"] == "backstage_door"


def test_a_target_nothing_carries_is_dropped_and_counted_by_what_it_named():
    found, _, targets = read_triggers(zombies_clip(), zombies_entities(), lambda e: None)
    buy = by_name(found)["t9"]
    assert buy["use"] == "touch" and buy["target"] is None
    assert targets.dropped == {"script_model": 1}
    assert "1 naming a script_model" in targets.report()


def test_a_volume_only_some_modes_have_says_so():
    ents = [{**zombies_entities()[0], "script_gameobjectname": "sd"}]
    modes_of = gameplay.modes_function("t5", "mp_test", ents)
    (first, _) = read_triggers(zombies_clip(), ents, modes_of)[0]
    assert first["modes"] == ["dem", "sd"]


def test_volumes_world_writes_each_box_and_clears_a_stale_file(tmp_path):
    found, _, _ = read_triggers(zombies_clip(), zombies_entities(), lambda e: None)
    path = write_volumes_world(str(tmp_path), "zombie_test", found)
    body = open(path).read()
    assert "4 box(es) of 3 entities" in body
    assert "trigger t5_0 { at: " in body and 'tag: "foyer_zone" "player_volume", target: "foyer_zone_spawners" }' in body
    assert 'rotate: 30.0, tag: "zombie_door", target: "backstage_door", use: near }' in body
    assert 'tag: "weapon_upgrade", use: touch }' in body
    assert "zombie_cost" not in body
    assert write_volumes_world(str(tmp_path), "zombie_test", []) is None
    assert not (tmp_path / "volumes.world").exists()


# -- Points and solids -------------------------------------------------------------------------------


def test_a_spawner_is_a_point_facing_its_angles_with_its_tags_and_target():
    ents = zombies_entities()
    targets = gameplay.Targets(ents, lambda e: None)
    lines = _point_lines(ents, lambda e: None, targets)
    spawner = next(line for line in lines if line.startswith("point p7 "))
    at = at_of((40, 0, 8))
    # Yaw 90 faces CoD +y, which is engine -z.
    assert f"look: {at[0]} {at[1]} {round(at[2] - 1, 3)}" in spawner
    assert 'tag: "foyer_zone_spawners" "zombie_spawner", target: "auto1" }' in spawner
    assert any(line.startswith("point p11 ") for line in lines)


def test_only_named_structs_that_are_not_audio_emitters_are_points():
    here = {"at": [0, 0, 0]}
    ents = [
        {**here, "id": 1, "classname": "script_struct"},
        {
            **here,
            "id": 2,
            "classname": "script_struct",
            "targetname": "amb_fire",
            "script_sound": "fire",
            "script_label": "looper",
        },
        {**here, "id": 3, "classname": "script_struct", "targetname": "player_respawn_point", "script_noteworthy": "foyer_zone"},
        {**here, "id": 4, "classname": "script_origin", "targetname": "teleporter_poi1"},
        {**here, "id": 5, "classname": "script_model", "targetname": "chalk"},
    ]
    lines = _point_lines(ents, lambda e: None, gameplay.Targets(ents, lambda e: None))
    assert [line.split()[1] for line in lines] == ["p3", "p4"]
    # A respawn point keeps the zone it serves as a tag.
    assert 'tag: "player_respawn_point" "foyer_zone"' in lines[0]


def test_a_dynamicpath_solid_is_tagged_and_in_every_mode():
    assert _solid_lines(zombies_entities(), lambda e: None) == ['solid { part: "*9", tag: "backstage_door" }']


def test_gameplay_world_links_across_files_and_counts_what_volumes_world_holds(tmp_path):
    written = write_gameplay_world(str(tmp_path), "zombie_test", {"game": "t5", "entities": zombies_entities()})
    body = open(written.path).read()
    assert (written.points, written.solids, written.volumes, written.skipped) == (2, 1, 3, 0)
    assert "3 brush-volume trigger(s) are in volumes.world" in body
    # The trigger that named the chalk is volumes.world's, so gameplay.world drops nothing of its own.
    assert "dropped" not in body


# -- Includes ----------------------------------------------------------------------------------------


def test_volumes_world_is_included_after_gameplay_world(tmp_path):
    ents, assets = a_world(tmp_path)
    args = (str(tmp_path), "mp_test", ents, assets, None, GAMES["t5"], "t5")
    write_world_file(*args, gameplay=True, mantle=True)
    assert ensure_include(str(tmp_path), "volumes.world")
    added = (tmp_path / "world.world").read_text()
    write_world_file(*args, gameplay=True, volumes=True, mantle=True)
    assert added == (tmp_path / "world.world").read_text()
    lines = [line for line in added.splitlines() if line.startswith("include")]
    assert lines.index('include "volumes.world"') == lines.index('include "gameplay.world"') + 1


def test_look_with_no_angles_faces_cod_x():
    assert gameplay.look_at({"at": [1.0, 2.0, 3.0]}) == [2.0, 2.0, 3.0]
    assert gameplay.look_at({"at": [0.0, 0.0, 0.0], "angles": "90 0 0"}) == pytest.approx([0.0, -1.0, 0.0], abs=1e-3)
    assert math.isfinite(gameplay.look_at({"at": [0.0, 0.0, 0.0], "angles": "bad"})[0])
