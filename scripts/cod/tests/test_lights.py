"""A map's scripted lights as `light` nodes (scripts/cod/lights.py), from zombie_theater's own values."""

import math

import pytest

from scripts.cod import lights

# pl#24 of zombie_theater, as its entity and the ComWorld light it compiled to.
ENTITY = {
    "classname": "light",
    "pl#": "1",
    "_bakecolor": "0 0 0",
    "_color": "0.82 0.76 0.67",
    "intensity": "8",
    "script_light2_color": "0.82 0.76 0.67",
    "script_light2_intensity": "8",
    "fov_outer": "50",
    "fov_inner": "20",
}
COMPILED = {
    "type": "spot",
    "origin": {"x": -329.4, "y": -985.1, "z": 516.8},
    "dir": {"x": 0.324, "y": -0.032, "z": 0.945},
    "color": {"x": 5.106, "y": 4.306, "z": 3.252},
    "radius": 390.0,
}
OMNI = {"type": "omni", "origin": {"x": 0, "y": 0, "z": 0}, "dir": {"x": 0, "y": 0, "z": 1}, "radius": 120.0}


def test_the_on_colour_is_srgb_times_intensity_as_the_compiler_writes_it():
    assert lights.on_colour(ENTITY) == pytest.approx((5.106, 4.306, 3.252), abs=0.01)
    # A light a script turns on from black is lit in its "on" colour.
    assert lights.on_colour({**ENTITY, "_color": "0 0 0", "intensity": ".1"}) == pytest.approx((5.106, 4.306, 3.252), abs=0.01)
    assert lights.on_colour({"_color": "0 0 0", "intensity": "8"}) is None


def test_aim_turns_minus_z_onto_the_direction():
    for forward in ((0.0, -1.0, 0.0), (0.854, -0.519, 0.0), (-0.3, 0.2, -0.93)):
        n = math.sqrt(sum(c * c for c in forward))
        x, y, z = (c / n for c in forward)
        pitch, yaw = (math.radians(a) for a in lights.aim((x, y, z)))
        # The client's Euler XYZ turn of (0, 0, -1), with no roll (scene/lights.ts).
        built = (-math.sin(yaw), math.cos(yaw) * math.sin(pitch), -math.cos(yaw) * math.cos(pitch))
        assert built == pytest.approx((x, y, z), abs=1e-9)


def test_a_compiled_dir_faces_back_toward_the_light():
    """pl#24 hangs at the lobby ceiling; its `dir` points up, so it shines down."""
    [(name, props)], skipped = lights.scripted_lights([ENTITY], [OMNI, COMPILED])
    assert (name, skipped) == ("pl1", 0)
    pitch, _yaw = (float(v) for v in props["rotate"].split()[:2])
    assert pitch < -60
    assert props["cone"] == "50 20"  # the entity's beam, not the compiled diagonal
    assert props["range"] == pytest.approx(390.0 / 39.37, abs=0.01)
    assert props["intensity"] == pytest.approx(5.106 / lights.ENGINE_POINT_SPOT_SCALE, abs=1e-3)


def test_baked_and_black_lights_are_left_out():
    baked = {**ENTITY, "_bakecolor": "1 1 1"}
    unmarked = {k: v for k, v in ENTITY.items() if k != "_bakecolor"}
    black = {**ENTITY, "script_light2_color": "0 0 0", "_color": "0 0 0"}
    found, skipped = lights.scripted_lights([baked, unmarked, black], [OMNI, COMPILED])
    assert (found, skipped) == ([], 1)


def test_an_omni_is_a_ranged_point_light():
    [(_, props)], _ = lights.scripted_lights([{**ENTITY, "pl#": "0"}], [OMNI])
    assert props["type"] == "point" and "cone" not in props and "rotate" not in props
