"""The AW cast's own steps, without game files: which zones hold a part, and what is drawn."""

import math

import pytest

from scripts.cod import aw_cast

AXIS = [-math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)]


def test_find_zones_walks_each_family_until_it_has_what_it_wants(tmp_path):
    zones = tmp_path / "zones"
    zones.mkdir()
    for name in ("mp_shirt_001_tr", "mp_shirt_002_tr", "mp_shirt_003_tr", "mp_shirt_vl_001_tr"):
        (zones / f"{name}.ff").write_bytes(b"")
    holds = {
        "mp_shirt_001_tr.ff": ["mp_top_a"],
        "mp_shirt_002_tr.ff": ["mp_top_b", "mp_top_c"],
        "mp_shirt_003_tr.ff": ["mp_top_d"],
    }
    walked = []

    def walk(ff):
        walked.append(ff.rsplit("/", 1)[-1])
        return holds[walked[-1]]

    found = aw_cast.find_zones(str(zones), {"mp_shirt": {"mp_top_c"}}, str(tmp_path), walk)
    assert found == {"mp_top_c": str(zones / "mp_shirt_002_tr.ff")}
    # Stops once it has them, never walks the lobby's copies, and remembers what it saw.
    assert walked == ["mp_shirt_001_tr.ff", "mp_shirt_002_tr.ff"]
    assert aw_cast.find_zones(str(zones), {"mp_shirt": {"mp_top_a"}}, str(tmp_path), walk) == {
        "mp_top_a": str(zones / "mp_shirt_001_tr.ff")
    }
    assert len(walked) == 2
    with pytest.raises(ValueError, match="mp_top_z"):
        aw_cast.find_zones(str(zones), {"mp_shirt": {"mp_top_z"}}, str(tmp_path), walk)


def model(uri, material):
    return {
        "nodes": [{"name": "tag_origin"}, {"name": "surf0", "mesh": 0, "skin": 0}, {"name": "surf1", "mesh": 1, "skin": 0}],
        "meshes": [{"primitives": [{"material": 0}]}, {"primitives": [{"material": 1}]}],
        "materials": [
            {"name": "m/mtl_vest", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}},
            {"name": material, "pbrMetallicRoughness": {"baseColorTexture": {"index": 1}}},
        ],
        "textures": [{"source": 0}, {"source": 1}],
        "images": [{"uri": "../images/vest_col.dds"}, {"uri": f"../images/{uri}"}],
    }


def test_an_additive_black_surface_is_dropped_and_its_mesh_with_it():
    gltf = model("$black.dds", "m/mtl_heat")
    aw_cast.drop_unseen(gltf, {"m/mtl_heat": {"blend": "add"}})
    # A mesh left with no primitives is invalid glTF; the loader throws on it.
    assert "mesh" not in gltf["nodes"][2] and "skin" not in gltf["nodes"][2]
    assert gltf["nodes"][1]["mesh"] == 0
    assert "baseColorTexture" not in gltf["materials"][1]["pbrMetallicRoughness"]


@pytest.mark.parametrize(("uri", "blend"), [("$black.dds", None), ("heat_col.dds", "add")])
def test_anything_else_is_drawn(uri, blend):
    gltf = model(uri, "m/mtl_heat")
    aw_cast.drop_unseen(gltf, {"m/mtl_heat": {"blend": blend}})
    assert gltf["nodes"][2]["mesh"] == 1


def skeleton(knee):
    """A root, a hip and a knee `knee` inches below it, as a part or a body is rooted."""
    return {
        "nodes": [
            {"name": "tag_origin", "rotation": AXIS, "children": [1]},
            {"name": "j_mainroot", "translation": [0.0, 0.0, 37.0], "children": [2, 4]},
            {"name": "j_hip_le", "translation": [0.0, 4.0, 0.0], "children": [3]},
            {"name": "j_knee_le", "translation": [knee, 0.0, 0.0]},
            {"name": "tag_stowed_back", "translation": [-9.0, 0.0, 0.0]},
        ],
        "skins": [{"joints": [0, 1, 2, 3, 4]}],
    }


def test_a_seam_is_measured_from_the_parts_own_root():
    body = skeleton(17.0)
    pants = skeleton(17.0)
    # A part rooted at `j_mainroot` sits at its own origin; it is the offsets that must agree.
    pants["nodes"] = pants["nodes"][1:]
    pants["nodes"][0] = {"name": "j_mainroot", "children": [1, 3]}
    pants["nodes"][1]["children"] = [2]
    pants["nodes"][3]["translation"] = [5.0, 0.0, 0.0]  # a tag nothing is weighted to
    pants["skins"] = [{"joints": [0, 1, 2, 3]}]
    assert aw_cast.seam(body, pants) == pytest.approx(0.0, abs=1e-9)
    pants["nodes"][2]["translation"] = [17.5, 0.0, 0.0]
    assert aw_cast.seam(body, pants) == pytest.approx(0.5)
