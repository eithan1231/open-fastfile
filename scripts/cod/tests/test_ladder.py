import json
import math

import pytest

from scripts.cod.collision import PLAYERCLIP, SOLID, blocks_player, face_flags
from scripts.cod.ladder import LADDER, SKY, is_ladder, read_ladders, side_of
from scripts.cod.units import UNITS_PER_M
from scripts.cod.worldfile import ensure_include, write_ladder_world

#: What every ladder material carries in the data: ladder, noimpact, nomarks, nodraw, nocastshadow.
LADDER_FLAGS = 0x000440B8
#: The one false positive: MW3's `sky_ny_manhattan_01`.
SKY_FLAGS = 0x3C
#: A ladder brush's contents: playerclip + detail.
LADDER_CONTENTS = 0x08010000

MATERIALS = [
    {"name": "caulk", "surfaceFlags": 0, "contents": 1},
    {"name": "ladder", "surfaceFlags": LADDER_FLAGS, "contents": 0},
    {"name": "sky_ny_manhattan_01", "surfaceFlags": SKY_FLAGS, "contents": 0},
]
CAULK, LADDER_MAT, SKY_MAT = 0, 1, 2


def box(mid, half, contents=LADDER_CONTENTS, axial=((LADDER_MAT,) * 3,) * 2, sides=()):
    """A brush from its bounds, CoD inches. `axial` is [0] the min faces, [1] the max, each x y z."""
    return {
        "contents": contents,
        "bounds": {
            "midPoint": {"x": mid[0], "y": mid[1], "z": mid[2]},
            "halfSize": {"x": half[0], "y": half[1], "z": half[2]},
        },
        "axialMaterialNum": [list(axial[0]), list(axial[1])],
        "sides": list(sides),
    }


def one_sided(mid=(0.0, 0.0, 60.0), half=(16.0, 4.0, 60.0)):
    """A ladder flagged on its min-y face only, the side a climber stands on."""
    return box(mid, half, axial=((CAULK, LADDER_MAT, CAULK), (CAULK, CAULK, CAULK)))


def landing(ladder_top=120.0):
    """A solid slab behind (+y of) `one_sided`, its top flush with the ladder's."""
    return box((0.0, 40.0, ladder_top - 8.0), (40.0, 36.0, 8.0), contents=SOLID, axial=((CAULK,) * 3,) * 2)


def dump(tmp_path, brushes, cmodels=None, game="iw5", materials=MATERIALS):
    path = tmp_path / "map.clipmap.json"
    manifest = {"_game": game, "materials": materials, "brushes": brushes, "cmodels": cmodels or [{"brushes": []}]}
    path.write_text(json.dumps(manifest))
    return str(path)


def test_the_flag_and_the_sky_false_positive():
    assert is_ladder(LADDER_FLAGS)
    assert is_ladder(0x00D440B8)  # BO1's ladder_metal
    assert not is_ladder(SKY_FLAGS)
    assert SKY_FLAGS & LADDER and SKY_FLAGS & SKY
    assert not is_ladder(0)


def test_a_ladder_brush_is_still_a_wall():
    # Which is why collision.glb keeps it and the node only grants the climb.
    assert blocks_player(LADDER_CONTENTS)
    assert LADDER_CONTENTS & PLAYERCLIP


def test_black_ops_flags_are_read_off_the_faces_themselves():
    brush = {
        "bounds": box((0, 0, 0), (1, 1, 1))["bounds"],
        "axialSurfaceFlags": [[1, 2, 3], [4, 5, 6]],
        "sides": [{"normal": [0.6, 0.8, 0.0], "dist": 0.5, "surfaceFlags": 7}],
    }
    # T5 carries no material index; the materials list is not consulted at all.
    assert face_flags(brush, [], "t5") == [(4, None), (1, None), (5, None), (2, None), (6, None), (3, None), (7, None)]


def test_mp_las_one_ladder_comes_out_where_its_brush_is(tmp_path):
    """mp_la's brush 4639 as the T6 dump has it: playerclip + detail, all six axial faces
    flagged `ladder` (0x440B8), 4 x 32 x 224 in. T6 tests `sflags & 8` as IW5 does
    (PM_CheckLadderMove 0x95dfbe), so every side is climbable and no `face` is written."""
    brush = {
        "contents": LADDER_CONTENTS,
        "bounds": box((-67.0, 2792.0, -130.0), (2.0, 16.0, 112.0))["bounds"],
        "axialSurfaceFlags": [[LADDER_FLAGS] * 3, [LADDER_FLAGS] * 3],
        "axialContents": [[LADDER_CONTENTS] * 3, [LADDER_CONTENTS] * 3],
        "sides": [],
    }
    ladders, stats = read_ladders(dump(tmp_path, [brush], game="t6", materials=[]), {})
    # worlds/la-bo2/ladder.world: `ladder l0 { at: -1.702 -3.302 -70.917, size: 0.102 5.69 0.813 }`.
    assert [(ladder["at"], ladder["size"], ladder["yaw"], ladder["face"]) for ladder in ladders] == [
        ((-1.702, -3.302, -70.917), (0.102, 5.69, 0.813), 0.0, None)
    ]
    assert stats["faces flagged"] == stats["axial faces flagged"] == 6


def test_an_all_axial_ladder_is_found_and_names_no_face(tmp_path):
    ladders, stats = read_ladders(dump(tmp_path, [box((10.0, 20.0, 60.0), (16.0, 4.0, 60.0))]), {})
    assert len(ladders) == 1
    ladder = ladders[0]
    assert ladder["face"] is None
    assert ladder["yaw"] == 0.0
    # CoD (x, y, z) inches -> engine (x, z, -y) metres.
    assert ladder["at"] == pytest.approx((10 / UNITS_PER_M, 60 / UNITS_PER_M, -20 / UNITS_PER_M), abs=1e-3)
    assert ladder["size"] == pytest.approx((32 / UNITS_PER_M, 120 / UNITS_PER_M, 8 / UNITS_PER_M), abs=1e-3)
    assert stats["axial faces flagged"] == 6


def test_a_ladder_flagged_on_one_face_names_it_and_faces_away_from_its_landing(tmp_path):
    ladders, stats = read_ladders(dump(tmp_path, [one_sided(), landing()]), {})
    assert len(ladders) == 1
    # The min-y face: CoD -y is engine +z, the box's local back.
    assert ladders[0]["face"] == "back"
    assert ladders[0]["landing"] == ["front"]
    assert stats["`face` does not point away from the landing"] == 0


def test_no_landing_is_reported_never_dropped(tmp_path):
    ladders, stats = read_ladders(dump(tmp_path, [one_sided()]), {})
    assert len(ladders) == 1
    assert ladders[0]["landing"] == []
    assert stats["landing on 0 sides, not 1 (brushes only; soup not read)"] == 1


def test_a_landing_out_of_reach_is_not_one(tmp_path):
    ladders, _ = read_ladders(dump(tmp_path, [one_sided(), landing(ladder_top=120.0 + 24.0)]), {})
    assert ladders[0]["landing"] == []


def test_sky_faces_are_not_ladders(tmp_path):
    sky = box((0.0, 0.0, 500.0), (400.0, 400.0, 8.0), contents=SOLID, axial=((SKY_MAT,) * 3,) * 2)
    ladders, stats = read_ladders(dump(tmp_path, [sky]), {})
    assert ladders == []
    assert stats["sky faces flagged as ladders (ignored)"] == 6


def test_a_flag_on_a_plane_the_hull_lacks_is_no_ladder(tmp_path):
    # A bevel lying outside the box never becomes a face, so nothing can touch it.
    bevel = {"normal": [1.0, 0.0, 0.0], "dist": 40.0, "materialNum": LADDER_MAT}
    brush = box((0.0, 0.0, 0.0), (16.0, 4.0, 60.0), axial=((CAULK,) * 3,) * 2, sides=[bevel])
    ladders, stats = read_ladders(dump(tmp_path, [brush]), {})
    assert ladders == []
    assert stats["flagged only on planes the hull does not have (ignored)"] == 1


def test_a_brush_model_ladder_goes_where_its_entity_puts_it(tmp_path):
    # Stored relative to its placer, as every brush-model brush is.
    cmodels = [{"brushes": []}, {"brushes": [0]}]
    placements = {
        1: {"source": "entity", "classname": "script_brushmodel", "origin": (200.0, 0.0, 0.0), "rotation": None, "solid": True}
    }
    ladders, stats = read_ladders(dump(tmp_path, [box((0.0, 0.0, 60.0), (16.0, 4.0, 60.0))], cmodels), placements)
    assert ladders[0]["at"][0] == pytest.approx(200 / UNITS_PER_M, abs=1e-3)
    assert stats["placed by a brush model"] == 1


def test_a_ladder_in_a_non_solid_brush_model_is_skipped(tmp_path):
    cmodels = [{"brushes": []}, {"brushes": [0]}]
    trigger = {
        1: {"source": "entity", "classname": "trigger_multiple", "origin": (0.0, 0.0, 0.0), "rotation": None, "solid": False}
    }
    ladders, stats = read_ladders(dump(tmp_path, [box((0.0, 0.0, 60.0), (16.0, 4.0, 60.0))], cmodels), trigger)
    assert ladders == []
    assert stats["skipped: owned by an unplaced or non-solid brush model"] == 1


@pytest.mark.parametrize("degrees", [0.0, 25.0, 60.0])
def test_side_of_names_the_local_side_under_the_box_yaw(degrees):
    """A normal turned with the box keeps its side: the `face` convention of dsl/schema.ts.

    front -Z, back +Z, left -X, right +X, in the frame rotateY(v, -yaw) gives.
    """
    yaw = math.radians(degrees)
    c, s = math.cos(yaw), math.sin(yaw)
    for local, name in (((0, 0, -1), "front"), ((0, 0, 1), "back"), ((-1, 0, 0), "left"), ((1, 0, 0), "right")):
        # Out of the box's frame (rotateY by +yaw), then engine (x, y, z) -> CoD (x, -z, y).
        ex, ez = local[0] * c + local[2] * s, -local[0] * s + local[2] * c
        side, alignment = side_of((ex, -ez, 0.0), yaw)
        assert side == name
        assert alignment == pytest.approx(1.0)


def test_a_tilted_face_scores_a_low_alignment():
    _, alignment = side_of((0.0, -math.cos(math.radians(30)), math.sin(math.radians(30))), 0.0)
    assert alignment == pytest.approx(math.cos(math.radians(30)))


def test_ladder_world_omits_a_zero_yaw_and_writes_face(tmp_path):
    ladders = [
        {"at": (1.0, 2.0, 3.0), "size": (0.8, 3.0, 0.2), "yaw": 0.0, "face": None, "landing": []},
        {"at": (-1.5, 2.0, 0.0), "size": (0.8, 3.0, 0.2), "yaw": 25.0, "face": "back", "landing": ["front"]},
    ]
    path = write_ladder_world(str(tmp_path), "mp_test", ladders)
    lines = (tmp_path / "ladder.world").read_text().splitlines()
    assert path.endswith("ladder.world")
    assert "ladder l0 { at: 1.0 2.0 3.0, size: 0.8 3.0 0.2 }" in lines
    assert "ladder l1 { at: -1.5 2.0 0.0, size: 0.8 3.0 0.2, rotate: 25.0, face: back }" in lines
    assert lines[0].startswith("// Where mp_test lets a player climb a ladder")


def test_no_ladders_removes_a_stale_file(tmp_path):
    (tmp_path / "ladder.world").write_text("stale")
    assert write_ladder_world(str(tmp_path), "mp_test", []) is None
    assert not (tmp_path / "ladder.world").exists()


def test_ensure_include_puts_ladder_world_where_a_full_export_would(tmp_path):
    # After mantle.world and before fx.world, as write_world_file orders them,
    # so a `--climbing-only` run and a re-export write the same world.world.
    (tmp_path / "world.world").write_text(
        'include "props.world"\ninclude "gameplay.world"\ninclude "mantle.world"\ninclude "fx.world"\n'
    )
    assert ensure_include(str(tmp_path), "ladder.world")
    assert (tmp_path / "world.world").read_text().splitlines() == [
        'include "props.world"',
        'include "gameplay.world"',
        'include "mantle.world"',
        'include "ladder.world"',
        'include "fx.world"',
    ]
