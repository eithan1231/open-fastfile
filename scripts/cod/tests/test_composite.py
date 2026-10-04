"""An AW gun is parts on one skeleton: each lands on the bone it names, and moves with it."""

import pytest

from scripts.cod import composite
from scripts.cod import xmodel_glb as glb
from scripts.cod.gltf import _mul, _node_matrix, _transform, parents_of, read_accessor, read_glb

IDENTITY = (0.0, 0.0, 0.0, 1.0)
# The receiver: `j_gun` at the origin, `tag_range` where a barrel goes (CoD axes, inches).
RANGE = (10.0, 0.0, 2.0)
FLASH = (5.0, 0.0, 0.0)


def _model(path, bones, point, weights=None):
    """One triangle at `point` (CoD axes), on `bones`."""
    lod = glb.ModelLodData(
        name="m_lod0",
        materials=[glb.ModelMaterial("m")],
        surfaces=[glb.Surface(0, 0, [(0, 1, 2)])],
        positions=[point, point, point],
        normals=[(0.0, 0.0, 1.0)] * 3,
        uvs=[(0.0, 0.0)] * 3,
        colours=[glb.WHITE] * 3,
        bones=bones,
        weights=weights,
    )
    glb.write(path, lod)
    return str(path)


@pytest.fixture
def receiver(tmp_path):
    bones = [glb.Bone("j_gun", None, (0.0, 0.0, 0.0), IDENTITY), glb.Bone("tag_range", 0, RANGE, IDENTITY)]
    return _model(tmp_path / "base.glb", bones, (0.0, 0.0, 0.0), [[(0, 1.0)]] * 3)


def _placed(path):
    """Every mesh vertex where its skin puts it at rest, in glTF axes, by node name."""
    gltf, buf = read_glb(path)
    parent = parents_of(gltf)

    def world(i):
        m = _node_matrix(gltf["nodes"][i])
        while i in parent:
            i = parent[i]
            m = _mul(_node_matrix(gltf["nodes"][i]), m)
        return m

    out = []
    for node in gltf["nodes"]:
        if "mesh" not in node:
            continue
        skin = gltf["skins"][node["skin"]]
        binds = read_accessor(gltf, buf, skin["inverseBindMatrices"])
        prim = gltf["meshes"][node["mesh"]]["primitives"][0]
        joints = read_accessor(gltf, buf, prim["attributes"]["JOINTS_0"])
        for p, j in zip(read_accessor(gltf, buf, prim["attributes"]["POSITION"]), joints, strict=True):
            m = _mul(world(skin["joints"][j[0]]), list(binds[j[0]]))
            out.append(tuple(round(v, 4) for v in _transform(m, p)))
    return gltf, out


def test_a_rigid_part_lands_on_the_bone_it_names(tmp_path, receiver):
    # One unit forward of its root bone, in the root bone's own space.
    barrel = _model(tmp_path / "barrel.glb", [], (1.0, 0.0, 0.0))
    out = str(tmp_path / "gun.glb")
    assert composite.compose(receiver, [(barrel, "tag_range")], out) == 1
    _, placed = _placed(out)
    assert glb.to_gltf((RANGE[0] + 1.0, RANGE[1], RANGE[2])) in placed


def test_a_skinned_part_brings_the_bones_the_receiver_lacks(tmp_path, receiver):
    bones = [glb.Bone("tag_range", None, (0.0, 0.0, 0.0), IDENTITY), glb.Bone("tag_flash", 0, FLASH, IDENTITY)]
    barrel = _model(tmp_path / "barrel.glb", bones, FLASH, [[(1, 1.0)]] * 3)
    out = str(tmp_path / "gun.glb")
    composite.compose(receiver, [(barrel, None)], out)
    gltf, placed = _placed(out)
    names = [n.get("name") for n in gltf["nodes"]]
    assert names.count("tag_flash") == 1 and names.count("tag_range") == 1
    # At the muzzle: the barrel's own tag_flash, carried to where tag_range is.
    assert glb.to_gltf(tuple(r + f for r, f in zip(RANGE, FLASH, strict=True))) in placed


def test_a_part_on_no_bone_of_the_receiver_is_refused(tmp_path, receiver):
    stray = _model(tmp_path / "stray.glb", [], (0.0, 0.0, 0.0))
    with pytest.raises(ValueError):
        composite.compose(receiver, [(stray, "tag_nowhere")], str(tmp_path / "gun.glb"))


def test_single_skin_binds_every_part_to_one_skin_without_moving_it(tmp_path, receiver):
    bones = [glb.Bone("tag_range", None, (0.0, 0.0, 0.0), IDENTITY), glb.Bone("tag_flash", 0, FLASH, IDENTITY)]
    skinned = _model(tmp_path / "barrel.glb", bones, FLASH, [[(1, 1.0)]] * 3)
    rigid = _model(tmp_path / "sight.glb", [], (1.0, 0.0, 0.0))
    out = str(tmp_path / "gun.glb")
    composite.compose(receiver, [(skinned, None), (rigid, "tag_range")], out)
    before = sorted(_placed(out)[1])

    gltf, buf = read_glb(out)
    assert len(gltf["skins"]) == 3
    composite.single_skin(gltf, buf)
    gltf["buffers"] = [{"byteLength": len(buf)}]
    one = str(tmp_path / "one.glb")
    composite.write_glb(one, gltf, buf)

    after_gltf, after = _placed(one)
    assert len(after_gltf["skins"]) == 1
    assert {n["skin"] for n in after_gltf["nodes"] if "mesh" in n} == {0}
    assert sorted(after) == before
