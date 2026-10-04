import json
import math
import os

import pytest

from scripts.cod.brushmodels import preflight
from scripts.cod.entities import detect_keys, triple
from scripts.cod.props import asset_name, axis_to_angles, cod_rotation, engine_euler, lod_chain, num


def test_triple():
    assert triple("1 2.5 -3") == [1.0, 2.5, -3.0]
    assert triple("1 2") is None
    assert triple("a b c") is None


def test_detect_keys_prefers_the_key_most_entities_carry():
    # Key "9" is a second map-scale vector on a few entities and "8" a stray
    # rotation-sized key on one entity with a wider span than the real angles.
    entities = [{"1": "worldspawn"}]
    for i in range(20):
        entities.append({"1": "script_model", "2": f"{1000 + i} {-2000 + i} 30", "3": f"0 {i * 10} 0", "4": f"model_{i % 5}"})
    entities[1]["9"] = "5000 5000 5000"
    entities[2]["9"] = "-5000 -5000 -5000"
    entities[3]["8"] = "-300 0 300"
    entities.append({"1": "script_brushmodel", "2": "0 0 0", "4": "*3"})
    assert detect_keys(entities) == ("1", "2", "3", "4")


def test_axis_to_angles_inverts_cod_rotation():
    for pitch, yaw, roll in [(0, 90, 0), (-63.7, 120, 6.1), (4.7, -30, -4.8)]:
        r = cod_rotation(pitch, yaw, roll)
        axis = [[r[j][i] for j in range(3)] for i in range(3)]  # rows are the basis vectors
        assert axis_to_angles(axis) == pytest.approx((pitch, yaw, roll), abs=1e-9)


def test_engine_euler_matches_the_typescript_golden_values():
    # The same rows tests/props-orientation.test.ts checks against three.js.
    assert engine_euler(0, 180, 0) == pytest.approx([-180, 0, -180], abs=1e-6)
    assert engine_euler(-90, 0, 0) == pytest.approx([0, 0, 90], abs=1e-6)
    assert engine_euler(1, 2, 3) == pytest.approx([3.001273, 1.944926, -1.103325], abs=1e-5)


def test_num_never_writes_negative_zero_or_exponents():
    assert num(-0.0001, 2) == "0.00"
    assert num(1e-7, 3) == "0.000"
    assert num(math.pi, 1) == "3.1"


def test_asset_name():
    taken = {"crate"}
    assert asset_name("crate", taken) == "crate_2"
    assert asset_name("3d.box", set()) == "m_3d_box"


def test_lod_chain_uses_the_models_cull_distance(tmp_path):
    xmodels, assets = tmp_path / "xmodel", tmp_path / "props"
    xmodels.mkdir()
    assets.mkdir()
    lods = [{"file": f"pole_lod{i}.glb", "distance": d} for i, d in enumerate((300.0, 800.0, 8500.0))]
    (xmodels / "pole.json").write_text(json.dumps({"lods": lods}))
    (assets / "pole_lod0.glb").write_bytes(b"")
    [(source, until)] = lod_chain("pole", str(assets), str(xmodels))
    assert source == "assets/props/pole_lod0.glb"
    assert until == pytest.approx(8500.0 / 39.37)  # not lod0's 300" switch distance

    (assets / "pole_lod2.glb").write_bytes(b"")
    chain = lod_chain("pole", str(assets), str(xmodels))
    assert [round(u, 3) for _, u in chain] == [round(800.0 / 39.37, 3), round(8500.0 / 39.37, 3)]


def test_lod_chain_never_culls_past_1e5():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        os.mkdir(os.path.join(d, "x"))
        json.dump({"lods": [{"file": "a_lod0.glb", "distance": 1e6}]}, open(os.path.join(d, "x", "a.json"), "w"))
        open(os.path.join(d, "a_lod0.glb"), "wb").close()
        assert lod_chain("a", d, os.path.join(d, "x")) == [("assets/props/a_lod0.glb", None)]


def brushmodel_dump(tmp_path, *, surface_counts, cmodel_brushes, placed):
    """A GfxWorld/clipmap pair of `len(surface_counts)` brush models, with `placed` named by entities."""
    ents = tmp_path / "map.ents"
    blocks = ['{\n"1" "worldspawn"\n"2" "0 0 0"\n}\n']
    blocks += [f'{{\n"1" "script_brushmodel"\n"2" "{100 * n} 0 0"\n"3" "0 0 0"\n"4" "*{n}"\n}}\n' for n in placed]
    ents.write_text("".join(blocks))
    gfxworld = {"models": [{"surfaceCount": n, "startSurfIndex": 0} for n in surface_counts]}
    clip = {"cmodels": [{"brushes": list(b), "partitions": []} for b in cmodel_brushes], "dynEnts": [[], []]}
    return gfxworld, clip, str(ents)


def test_a_rendered_brush_model_nothing_places_is_refused(tmp_path):
    # It would draw its walls at the world origin, and it is also what a dump
    # whose dynamic entities carry no `brushModel` looks like.
    gfxworld, clip, ents = brushmodel_dump(tmp_path, surface_counts=[0, 4, 4], cmodel_brushes=[[], [1], [2]], placed=[1])
    with pytest.raises(SystemExit, match=r"rendered brush model\(s\) have nothing placing them \(\*2\)"):
        preflight(gfxworld, clip, True, ents)


def test_a_collision_only_brush_model_nothing_places_is_skipped(tmp_path, capsys):
    # mp_frag's *69: one brush of clip, no surfaces, no entity. Invisible either
    # way, so it is counted and left out rather than stopping the export.
    gfxworld, clip, ents = brushmodel_dump(tmp_path, surface_counts=[0, 4, 0], cmodel_brushes=[[], [1], [2]], placed=[1])
    placements = preflight(gfxworld, clip, True, ents)
    assert 2 not in placements
    assert "1 collision-only with nothing placing them, skipped" in capsys.readouterr().out
