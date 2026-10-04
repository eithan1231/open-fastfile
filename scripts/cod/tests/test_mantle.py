import json
import math

import pytest

from scripts.cod.collision import blocks_player, face_flags
from scripts.cod.mantle import MANTLE, MANTLE_ON, MANTLE_OVER, MOUNT, kind_of, landing_check, read_mantles
from scripts.cod.units import UNITS_PER_M
from scripts.cod.volumes import box_at, box_footprint, fit_box, hull_faces, hull_points, hull_volume


def axial_brush(half=(20.0, 30.0, 12.0), mid=(0.0, 0.0, 0.0), contents=MANTLE, axial=((-1, -1, -1), (-1, -1, -1))):
    """A box brush defined by its bounds alone — no sides, as 38% of the real ones are.

    `axial` is its `axialMaterialNum`: [0] the min faces, [1] the max, each x y z.
    """
    return {
        "contents": contents,
        "axialMaterialNum": [list(axial[0]), list(axial[1])],
        "bounds": {
            "midPoint": {"x": mid[0], "y": mid[1], "z": mid[2]},
            "halfSize": {"x": half[0], "y": half[1], "z": half[2]},
        },
    }


def turned_brush(a=20.0, b=8.0, h=12.0, degrees=30.0, materials=()):
    """A box turned `degrees` about CoD's vertical (z), as a designer-rotated brush is.

    Its four vertical planes are bevel `sides`; the bounds are the axis-aligned
    box around it, which is how the clipmap stores one.
    """
    phi = math.radians(degrees)
    c, s = math.cos(phi), math.sin(phi)
    sides = [
        {"normal": [c, s, 0.0], "dist": a},
        {"normal": [-c, -s, 0.0], "dist": a},
        {"normal": [-s, c, 0.0], "dist": b},
        {"normal": [s, -c, 0.0], "dist": b},
    ]
    for i, side in enumerate(sides):
        if materials:
            side["materialNum"] = i % len(materials)
    return {
        "contents": MANTLE,
        "bounds": {
            "midPoint": {"x": 0.0, "y": 0.0, "z": 0.0},
            "halfSize": {"x": a * abs(c) + b * abs(s), "y": a * abs(s) + b * abs(c), "z": h},
        },
        "sides": sides,
        "axialMaterialNum": [[-1, -1, -1], [-1, -1, -1]],
    }


def test_a_mantle_brush_does_not_block_the_player():
    # Which is why collision.py drops it and this module exists. If this ever
    # changed, every mantle edge would become an invisible wall.
    assert blocks_player(MANTLE) is False


def test_an_axial_box_fits_exactly_with_no_yaw():
    faces = hull_faces(axial_brush(half=(20.0, 30.0, 12.0)))
    centre, size, yaw = fit_box(faces)
    assert yaw == 0.0
    # CoD (x, y, z) inches, z up -> engine (x, z, -y) metres.
    assert size == pytest.approx((40 / UNITS_PER_M, 24 / UNITS_PER_M, 60 / UNITS_PER_M), abs=1e-6)
    assert centre == pytest.approx((0.0, 0.0, 0.0), abs=1e-6)
    assert hull_volume(faces) / (size[0] * size[1] * size[2]) == pytest.approx(1.0, abs=1e-6)


def test_a_turned_box_recovers_its_own_angle_exactly():
    # The hull's own face normals are tried before the scan, so a box comes out
    # at its real angle rather than the nearest quarter degree.
    for degrees in (7.0, 30.0, 43.7, 61.25):
        faces = hull_faces(turned_brush(degrees=degrees))
        _, size, yaw = fit_box(faces)
        assert math.degrees(yaw) == pytest.approx(degrees % 90.0, abs=1e-6)
        # 2a by 2b on the ground, whichever way round the fit landed.
        assert sorted((size[0], size[2])) == pytest.approx(sorted((40 / UNITS_PER_M, 16 / UNITS_PER_M)), abs=1e-6)
        assert hull_volume(faces) / (size[0] * size[1] * size[2]) == pytest.approx(1.0, abs=1e-4)


@pytest.mark.parametrize("degrees", [0.0, 7.0, 30.0, 45.0, 88.5])
def test_every_hull_vertex_lies_inside_the_fitted_box(degrees):
    """The invariant the whole module rests on: the box never cuts the volume short.

    A box that missed part of its hull would be a mantle you could not start from
    where the map said you could, which nothing else would report.
    """
    faces = hull_faces(turned_brush(degrees=degrees))
    centre, size, yaw = fit_box(faces)
    c, s = math.cos(yaw), math.sin(yaw)
    for px, py, pz in hull_points(faces):
        dx, dz = px - centre[0], pz - centre[2]
        local = (dx * c - dz * s, py - centre[1], dx * s + dz * c)
        for value, extent in zip(local, size, strict=True):
            assert abs(value) <= extent / 2 + 1e-9


def test_box_at_is_the_inverse_the_engine_must_use():
    """`box_at` maps world -> box frame by turning the other way (three.js rotateY).

    The engine's own query has to invert this the same way round or half the
    volumes — every one with a yaw — would be mirrored about their own centre.
    The shared package asserts the other half of this agreement.
    """
    yaw = math.radians(37.0)
    c, s = math.cos(yaw), math.sin(yaw)
    # A point one metre along the box's local +u, put into the world.
    world = (1.0 * c, 0.0, -1.0 * s)
    centre, size = box_at([world, (0.0, 0.0, 0.0)], yaw)
    # Its local u is 1 m, so the box spans 1 m in u and nothing in v.
    assert size[0] == pytest.approx(1.0, abs=1e-9)
    assert size[2] == pytest.approx(0.0, abs=1e-9)
    assert centre == pytest.approx((world[0] / 2, 0.0, world[2] / 2), abs=1e-9)


@pytest.mark.parametrize("degrees", [0.0, 20.0, 45.0, 75.0])
def test_box_footprint_contains_the_turned_box(degrees):
    """It is the broad phase for `landing_check`, so it must never be too small.

    Not "grows with yaw": turning a long thin box by 45 degrees *shrinks* its x
    extent, so the only claim worth asserting is that all four corners are in.
    """
    centre, size = (3.0, 0.0, -2.0), (2.0, 1.0, 0.5)
    yaw = math.radians(degrees)
    c, s = math.cos(yaw), math.sin(yaw)
    min_x, max_x, min_z, max_z = box_footprint(centre, size, yaw)
    for u in (-size[0] / 2, size[0] / 2):
        for v in (-size[2] / 2, size[2] / 2):
            # The corner out of the box's frame (rotateY by +yaw), as `box_at` does.
            x, z = centre[0] + u * c + v * s, centre[2] - u * s + v * c
            assert min_x - 1e-9 <= x <= max_x + 1e-9
            assert min_z - 1e-9 <= z <= max_z + 1e-9

    assert box_footprint((0.0, 0.0, 0.0), size, 0.0) == pytest.approx((-1.0, 1.0, -0.25, 0.25))


def test_kind_comes_off_the_side_materials_on_modern_warfare():
    mats = [{"name": "mantle_on"}, {"name": "caulk"}]
    assert kind_of(turned_brush(materials=mats), mats, "iw5") == "onto"
    over = [{"name": "mantle_over"}, {"name": "mantle_over"}]
    assert kind_of(turned_brush(materials=over), over, "iw5") == "over"


def flagged_brush(axial=((0, 0, 0), (0, 0, 0)), sides=()):
    """A Black Ops (II) box: every face carries its own surface flags, no material.

    `axial` is `axialSurfaceFlags` ([0] the min faces, [1] the max, x y z);
    `sides` extra bevel planes as (normal, dist, surfaceFlags).
    """
    brush = axial_brush()
    del brush["axialMaterialNum"]
    brush["axialSurfaceFlags"] = [list(axial[0]), list(axial[1])]
    brush["sides"] = [{"normal": list(n), "dist": d, "surfaceFlags": f} for n, d, f in sides]
    return brush


def test_the_kind_bits_are_black_ops_iis_own_infoparms():
    # infoParms[] in the T6 dedicated server (0xdd62c0) and T5's (0xe0f610) agree:
    # mantleOn, mantleOver and mount, each with contents MANTLE. reverse/t6-traversal.
    assert (MANTLE_ON, MANTLE_OVER, MOUNT) == (0x04000000, 0x08000000, 0x10000000)


@pytest.mark.parametrize("game", ["t5", "t6"])
def test_black_ops_reads_the_kind_off_its_face_flags(game):
    # mp_la's own `mantle_on` material is 0x040440B0 and `mantle_over` 0x080440B0.
    on = flagged_brush(axial=((0x040440B0,) * 3, (0x040440B0,) * 3))
    over = flagged_brush(axial=((0x080440B0,) * 3, (0x080440B0,) * 3))
    assert kind_of(on, [], game) == "onto"
    assert kind_of(over, [], game) == "over"
    # A material name means nothing on these games: the faces name none.
    mats = [{"name": "mantle_over"}]
    named = {**turned_brush(materials=mats), "axialSurfaceFlags": [[0, 0, 0], [0, 0, 0]]}
    assert kind_of(named, mats, game) is None


def test_black_ops_over_wins_on_a_face_that_says_both_and_mount_is_no_kind():
    # Mantle_Check tests over first (T6 0x94a314) and `mount` sets a flag of its own.
    # mp_nuked's 15 over volumes carry mount beside it (0x18000000).
    both = flagged_brush(axial=((0x0C0440B0,) * 3, (0x0C0440B0,) * 3))
    assert kind_of(both, [], "t6") == "mixed"
    over_mount = flagged_brush(axial=((0x180440B0,) * 3, (0x180440B0,) * 3))
    assert kind_of(over_mount, [], "t5") == "over"
    mount = flagged_brush(axial=((0x100440B0,) * 3, (0x100440B0,) * 3))
    assert kind_of(mount, [], "t6") is None


def test_black_ops_ignores_a_kind_on_a_plane_the_hull_does_not_have():
    # 5 of Black Ops II's 7 two-kind brushes name `on` only on a redundant plane.
    over = (0x080440B0,) * 3
    brush = flagged_brush(axial=(over, over), sides=[((1.0, 0.0, 0.0), 50.0, 0x040440B0)])
    planes = {face.plane for face in hull_faces(brush)}
    assert 6 not in planes  # x <= 50 lies outside a box whose +x face is at 20
    assert kind_of(brush, [], "t6") == "mixed"
    assert kind_of(brush, [], "t6", planes) == "over"


def test_a_black_ops_volume_with_no_kind_is_no_mantle(tmp_path):
    # The game mantles only off a face flagged on or over (T6 0x9486f6, 0x949c2a).
    flags = [((0x040440B0,) * 3, (0x040440B0,) * 3), ((0x000440B0,) * 3, (0x000440B0,) * 3)]
    brushes = [flagged_brush(axial=a) for a in flags]
    path = tmp_path / "m.clipmap.json"
    path.write_text(json.dumps({"_game": "t6", "materials": [], "brushes": brushes, "cmodels": [{}]}))
    volumes, stats = read_mantles(str(path), {})
    assert [v["kind"] for v in volumes] == ["onto"]
    assert stats["skipped: no face flagged mantleOn or mantleOver"] == 1


def test_kind_of_an_axial_box_comes_off_its_axial_faces():
    # An all-axial box has no side records, so this is the only place its
    # material is: 2,234 of 5,825 Modern Warfare volumes.
    mats = [{"name": "caulk"}, {"name": "mantle_over"}]
    brush = axial_brush(axial=((0, 0, 0), (0, 0, 1)))
    assert brush.get("sides") is None
    assert kind_of(brush, mats, "iw4") == "over"
    assert kind_of(axial_brush(axial=((0, 0, 0), (0, 0, 0))), mats, "iw4") is None


def test_axial_materials_follow_brush_planes_order():
    """`brush_planes` lists each axis max first; the dump lists min faces first.

    Read the other way round, every one-sided ladder would name the wrong side.
    """
    mats = [{"name": f"m{i}", "surfaceFlags": i} for i in range(6)]
    brush = axial_brush(axial=((0, 1, 2), (3, 4, 5)))
    # +x (max), -x (min), +y, -y, +z, -z.
    assert [name for _, name in face_flags(brush, mats, "iw5")] == ["m3", "m0", "m4", "m1", "m5", "m2"]


def test_a_brush_naming_both_kinds_is_reported_not_guessed():
    mats = [{"name": "mantle_on"}, {"name": "mantle_over"}]
    assert kind_of(turned_brush(materials=mats), mats, "iw5") == "mixed"


def test_landing_check_finds_the_surface_at_the_top():
    # One brush top flush with the volume's top, and one well below it.
    tops = [(-1.0, 1.0, -1.0, 1.0, 2.0), (-1.0, 1.0, -1.0, 1.0, 1.4)]
    assert landing_check(2.0, (-0.5, 0.5, -0.5, 0.5), tops) == pytest.approx(0.0)


def test_landing_check_ignores_a_surface_out_of_reach_or_beside_it():
    far_below = [(-1.0, 1.0, -1.0, 1.0, 0.2)]
    assert landing_check(2.0, (-0.5, 0.5, -0.5, 0.5), far_below) is None
    beside = [(5.0, 6.0, -1.0, 1.0, 2.0)]
    assert landing_check(2.0, (-0.5, 0.5, -0.5, 0.5), beside) is None


def test_ghosts_names_its_kind_off_the_materials_as_modern_warfare_does(tmp_path):
    # Ghosts brush sides carry a material index, not T5's flags, so the kind is
    # recoverable. Every one of 1,391 volumes across five stock maps is `mantle_on`.
    materials = [{"name": "mantle_on", "surfaceFlags": 0x020440B0, "contents": 0x09000000}]
    brush = axial_brush(axial=((0, 0, 0), (0, 0, 0)))
    assert kind_of(brush, materials, "iw6") == "onto"


def test_a_mantle_volume_owned_by_a_brush_model_goes_where_its_entity_puts_it(tmp_path):
    # None of Modern Warfare's or Black Ops' 3,006 volumes is; 8 of
    # mp_prisonbreak's 176 are, and an unplaced one is left out rather than
    # exported at the world origin.
    brush = axial_brush(mid=(10.0, 0.0, 0.0), half=(8.0, 8.0, 8.0), axial=((0, 0, 0), (0, 0, 0)))
    manifest = {
        "_game": "iw6",
        "materials": [{"name": "mantle_on", "surfaceFlags": 0x020440B0, "contents": 0x09000000}],
        "brushes": [brush],
        "cmodels": [{"brushes": []}, {"brushes": [0]}],
    }
    path = tmp_path / "map.clipmap.json"
    path.write_text(json.dumps(manifest))

    placed = {1: {"origin": (0.0, 0.0, 100.0), "rotation": None, "solid": True, "classname": "script_brushmodel"}}
    volumes, stats = read_mantles(str(path), placed)
    assert stats["placed by a brush model"] == 1
    # CoD z is engine y: the volume sits 100 inches up, not at the origin.
    assert volumes[0]["at"] == pytest.approx([10 / UNITS_PER_M, 100 / UNITS_PER_M, 0.0], abs=1e-3)

    unplaced = {1: {"origin": (0.0, 0.0, 0.0), "rotation": None, "solid": False, "classname": "trigger_use"}}
    volumes, stats = read_mantles(str(path), unplaced)
    assert volumes == [] and stats["skipped: owned by an unplaced or non-solid brush model"] == 1
