"""IW6 models, clips and scripts: the decodes the xmodel, xanim and scriptfile dumpers rest on."""

import hashlib
import math
import struct
import zlib

import pytest

from scripts.cod import xmodel_glb as glb
from scripts.cod.animations import compiled_assignments
from scripts.cod.entities import named_keys
from scripts.cod.gltf import _identity, _mul, _node_matrix, read_glb
from scripts.cod.iw6.dumpers.xanim import Pool, bone_tracks
from scripts.cod.iw6.records import Model
from scripts.cod.iw6.skeleton import blend_weights, check_blend_table, local_poses, rigid_weights, skeleton, strongest
from scripts.cod.materials import flag_parms, is_flag_technique
from scripts.cod.xanim import FULL_TRANS_SCALE, RawBone, RawClip, RawRotation, RawTranslation, decode, encode

# -- skeletons -----------------------------------------------------------------------


def quat_about_z(degrees):
    h = math.radians(degrees) / 2
    return (0.0, 0.0, math.sin(h), math.cos(h))


def packed(q):
    return tuple(round(v * 32767) for v in q)


def two_bone_model():
    """tag_origin, and j_arm 10 in along X turned 90 degrees about Z: its bytes and its records.Model."""
    local = quat_about_z(90)
    base = [(0, 0, 0, 1, 0, 0, 0, 2), (*local, 10, 0, 0, 2)]
    data = bytearray()
    at = {}
    for key, blob in (
        ("names", struct.pack("<2I", 1, 2)),
        ("parents", struct.pack("<B", 1)),
        ("angles", struct.pack("<4h", *packed(local))),
        ("positions", struct.pack("<3f", 10, 0, 0)),
        ("base", b"".join(struct.pack("<8f", *b) for b in base)),
    ):
        at[key] = len(data)
        data += blob
    model = Model("arm", [], bone_count=2, root_bone_count=1, bone_names=at["names"], parents=at["parents"])
    model.tag_angles, model.tag_positions, model.base_mat = at["angles"], at["positions"], at["base"]
    return bytes(data), model


def test_bones_read_names_parents_and_the_model_space_pose():
    data, model = two_bone_model()
    bones = skeleton(data, model, ["", "tag_origin", "j_arm"])
    assert [(b.name, b.parent) for b in bones] == [("tag_origin", None), ("j_arm", 0)]
    assert bones[1].offset == (10, 0, 0) and bones[1].rotation == pytest.approx(quat_about_z(90))


def test_tag_angles_are_xyzw_over_32767_and_compose_to_the_base_pose():
    # Settled on every rigged model of mp_prisonbreak: parent base pose x local = the bone's base pose.
    data, model = two_bone_model()
    (rotation, translation) = local_poses(data, model)[0]
    assert rotation == pytest.approx(quat_about_z(90), abs=1e-4)
    assert translation == (10, 0, 0)


def test_glb_bones_hold_the_local_pose_in_cods_frame_below_the_root():
    # OAT's layout: the root carries the Z-up -> Y-up turn; a child's node is its tagAngles/tagPositions.
    data, model = two_bone_model()
    bones = skeleton(data, model, ["", "tag_origin", "j_arm"])
    root_t, root_r = glb.local_transform(bones, 0)
    assert root_r == pytest.approx((-math.sqrt(0.5), 0, 0, math.sqrt(0.5)))
    child_t, child_r = glb.local_transform(bones, 1)
    assert child_t == pytest.approx((10, 0, 0), abs=1e-6)
    assert child_r == pytest.approx(local_poses(data, model)[0][0], abs=1e-4)


# -- weights --------------------------------------------------------------------------


def test_rigid_lists_name_bones_in_skeleton_matrix_units():
    data = struct.pack("<4H8x", 64 * 3, 5, 0, 2) + struct.pack("<4H8x", 0, 7, 2, 4)
    assert rigid_weights(data, 0, 2) == [(3, 5), (0, 7)]


def blend_stream():
    """One vertex on bone 2 alone, one on bones 1 and 4 (a quarter to bone 4)."""
    return struct.pack("<H", 2 * 64) + struct.pack("<3H", 1 * 64, 4 * 64, 16384)


def test_blend_weights_give_bone_zero_what_the_others_leave():
    weights = blend_weights(blend_stream(), 0, (1, 1, 0, 0, 0, 0, 0, 0))
    assert weights[0] == [(2, 1.0)]
    assert [b for b, _ in weights[1]] == [1, 4]
    assert weights[1][1][1] == pytest.approx(16384 / 65535) and sum(w for _, w in weights[1]) == pytest.approx(1.0)


def test_blend_table_repeats_the_stream_per_vertex():
    weights = blend_weights(blend_stream(), 0, (1, 1, 0, 0, 0, 0, 0, 0))
    # BlendVertsUnknown: eight bones, seven weights, then the bone count.
    table = struct.pack("<16H", 2, *[0] * 7, *[0] * 7, 1) + struct.pack("<16H", 1, 4, *[0] * 6, 16384, *[0] * 6, 2)
    assert check_blend_table(table, 0, weights) == 0
    shifted = struct.pack("<16H", 2, *[0] * 7, *[0] * 7, 1) + struct.pack("<16H", 64, 256, *[0] * 6, 16384, *[0] * 6, 2)
    assert check_blend_table(shifted, 0, weights) == 1  # bone offsets left unscaled


def test_more_than_four_bones_keep_the_heaviest_four():
    influences = [(0, 0.3), (1, 0.05), (2, 0.25), (3, 0.2), (4, 0.2)]
    kept = strongest(influences)
    assert [b for b, _ in kept] == [0, 2, 3, 4] and sum(w for _, w in kept) == pytest.approx(1.0)
    assert strongest(influences[:3]) == influences[:3]


# -- the GLB layout -------------------------------------------------------------------


def one_triangle(bones=(), weights=None, colours=None):
    lod = glb.ModelLodData("thing_lod0", materials=[glb.ModelMaterial("mc/thing", "thing_col", "thing_nml")])
    lod.positions = [(0, 0, 0), (10, 0, 0), (0, 10, 0)]
    lod.normals = [(0, 0, 1)] * 3
    lod.uvs = [(0, 0), (1, 0), (0, 1)]
    lod.colours = colours or [glb.WHITE] * 3
    lod.surfaces = [glb.Surface(0, 0, [(0, 1, 2)])]
    lod.bones, lod.weights = list(bones), weights
    return lod


def test_an_unskinned_single_surface_is_its_own_scene_root():
    gltf, buf = glb.build(one_triangle())
    assert gltf["scenes"] == [{"nodes": [0]}] and gltf["nodes"] == [{"name": "surf0", "mesh": 0}]
    primitive = gltf["meshes"][0]["primitives"][0]
    assert "COLOR_0" not in primitive["attributes"] and "skins" not in gltf  # all white: no colours
    assert gltf["images"] == [{"uri": "../images/thing_col.dds"}, {"uri": "../images/thing_nml.dds"}]
    view = gltf["bufferViews"][gltf["accessors"][primitive["indices"]]["bufferView"]]
    assert struct.unpack_from("<3H", buf, view["byteOffset"]) == (2, 1, 0)  # reversed, as OAT writes them
    assert gltf["accessors"][0]["max"] == [10, 0, 0] and gltf["accessors"][0]["min"] == [0, 0, -10]  # (x, z, -y)


def test_colours_are_written_when_any_vertex_is_not_white():
    gltf, _ = glb.build(one_triangle(colours=[glb.WHITE, glb.WHITE, (1.0, 1.0, 1.0, 0.0)]))
    assert "COLOR_0" in gltf["meshes"][0]["primitives"][0]["attributes"]


def test_a_skinned_lod_binds_to_its_rest_pose():
    data, model = two_bone_model()
    bones = skeleton(data, model, ["", "tag_origin", "j_arm"])
    gltf, buf = glb.build(one_triangle(bones, [[(0, 1.0)], [(1, 0.75), (0, 0.25)], []]))
    assert gltf["nodes"][-1] == {"name": "thing_lod0_skel", "children": [2, 0]}  # surfaces, then root bones
    skin = gltf["skins"][0]
    assert skin["joints"] == [0, 1] and skin["skeleton"] == 0
    accessor = gltf["accessors"][skin["inverseBindMatrices"]]
    view = gltf["bufferViews"][accessor["bufferView"]]
    for joint in (0, 1):
        world = _node_matrix(gltf["nodes"][joint])
        if joint:
            world = _mul(_node_matrix(gltf["nodes"][0]), world)
        inverse = struct.unpack_from("<16f", buf, view["byteOffset"] + 64 * joint)
        assert _mul(world, list(inverse)) == pytest.approx(_identity(), abs=1e-5)
    weights_view = gltf["bufferViews"][
        gltf["accessors"][gltf["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_0"]]["bufferView"]
    ]
    assert struct.unpack_from("<12f", buf, weights_view["byteOffset"])[4:8] == (0.75, 0.25, 0.0, 0.0)


def golden_lod(n_vertices, surfaces, bones=False, coloured=False):
    """A LOD of `n_vertices` in a strip per surface, deterministic to the bit."""
    lod = glb.ModelLodData(
        "golden_lod0", materials=[glb.ModelMaterial("mc/a", "a_col", "a_nml"), glb.ModelMaterial("mc/b", "b_col")]
    )
    for k in range(n_vertices):
        a = k * 0.37
        lod.positions.append((math.cos(a) * k, math.sin(a) * k, k * 0.5))
        lod.normals.append((0.0, 0.0, 1.0))
        lod.uvs.append((k / n_vertices, 1 - k / n_vertices))
        lod.colours.append((1.0, 0.5, 0.25, 1.0) if coloured and k % 7 == 0 else glb.WHITE)
    per = n_vertices // surfaces
    for s in range(surfaces):
        count = n_vertices - s * per if s == surfaces - 1 else per
        lod.surfaces.append(glb.Surface(s % 2, s * per, [(t, t + 1, t + 2) for t in range(count - 2)]))
    if bones:
        lod.bones = [
            glb.Bone("tag_origin", None, (0.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0)),
            glb.Bone("j_arm", 0, (1.0, 2.0, 3.0), (0.0, 0.0, math.sin(0.3), math.cos(0.3))),
        ]
        lod.weights = [[(0, 1.0)] if k % 3 else [(1, 0.75), (0, 0.25)] for k in range(n_vertices)]
    return lod


# SHA-256 of each GLB as the writer produced it before it had a u32 path. Ghosts'
# models and every S1 model under 65,536 vertices are written through here.
GOLDEN = [
    ((3, 1), {}, "ffd8295c6bf1f47084450e02c64e98988b876281662ac307b4ff6f1e816e8fb3"),
    ((500, 2), {"bones": True, "coloured": True}, "8c9c275d0e83cb830da8616a3594fb8a45a0b61d909745ac7f2bda6ed2d567b4"),
    ((65535, 3), {}, "c4f504267fd0b8781e54b9d9099a37d38800e4f6ff5be897cdab28371dcbc174"),
]


@pytest.mark.parametrize(("args", "kwargs", "digest"), GOLDEN)
def test_a_lod_u16_can_index_is_written_byte_for_byte_as_before(tmp_path, args, kwargs, digest):
    path = tmp_path / "golden.glb"
    glb.write(str(path), golden_lod(*args, **kwargs))
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest


@pytest.mark.parametrize("bones", [False, True])
def test_a_lod_of_more_than_65535_vertices_takes_u32_indices(tmp_path, bones):
    lod = golden_lod(70000, 3, bones=bones)
    path = tmp_path / "wide.glb"
    glb.write(str(path), lod)
    gltf, buf = read_glb(str(path))
    for mesh, surface in zip(gltf["meshes"], lod.surfaces, strict=True):
        accessor = gltf["accessors"][mesh["primitives"][0]["indices"]]
        view = gltf["bufferViews"][accessor["bufferView"]]
        assert accessor["componentType"] == 5125 and view["byteOffset"] % 4 == 0
        indices = struct.unpack_from(f"<{accessor['count']}I", buf, view["byteOffset"])
        base = surface.first_vertex
        assert indices[:3] == (base + 2, base + 1, base)  # reversed, as the u16 path writes them
    last = gltf["accessors"][gltf["meshes"][-1]["primitives"][0]["indices"]]
    view = gltf["bufferViews"][last["bufferView"]]
    assert max(struct.unpack_from(f"<{last['count']}I", buf, view["byteOffset"])) == 69999


# -- clips ------------------------------------------------------------------------------


def test_encoded_clips_decode_to_the_same_keys():
    turn = [packed(quat_about_z(a)) for a in (0, 45, 90, 135, 180)]
    clip = RawClip(
        frames=4,
        fps=30.0,
        looped=False,
        asset_type=2,
        bones=[
            RawBone("j_spin", RawRotation(False, turn, [0, 1, 2, 3, 4]), RawTranslation(constant=(1.0, 2.0, 3.0))),
            RawBone("j_nod", RawRotation(True, [(0, 32767), (23170, 23170)], [0, 4]), None),
            RawBone(
                "j_slide",
                None,
                RawTranslation(None, False, (0.0, 0.0, 0.0), (FULL_TRANS_SCALE * 10,) * 3, [(0, 0, 0), (65535, 0, 0)], [0, 3]),
            ),
        ],
        notifies=[("sound", 0.5), ("end", 1.0)],
        delta=(RawRotation(True, [(0, 32767)]), None),
    )
    anim = decode(encode(clip), "test")  # decode refuses anything it does not read to the end
    assert (anim.frames, anim.fps, anim.looped, anim.asset_type) == (4, 30.0, False, 2)
    spin, nod, slide = anim.bones
    assert spin.rotation.indices == [0, 1, 2, 3, 4]
    assert [math.degrees(2 * math.atan2(q[2], q[3])) for q in spin.rotation.values] == pytest.approx(
        [0, 45, 90, 135, 180], abs=0.01
    )
    assert spin.translation.values == [[1.0, 2.0, 3.0]]
    assert nod.rotation.indices == [0, 4] and nod.translation is None
    assert slide.rotation is None and slide.translation.indices == [0, 3]
    assert slide.translation.values[1][0] == pytest.approx(10.0, rel=1e-4)
    assert anim.notetracks == [("sound", 2)]  # the linker's own `end` is not in the file


def test_a_clip_whose_rotation_ends_negative_keeps_its_sign_through_the_flip_bit():
    frames = [(0, 0, 23170, -23170), (0, 0, 32767, 0)]
    clip = RawClip(1, 30.0, False, 2, [RawBone("j", RawRotation(False, frames, [0, 1]), None)])
    rotation = decode(encode(clip)).bones[0].rotation.values
    assert rotation[0] == pytest.approx([0, 0, 23170 / 32767, -23170 / 32767], abs=1e-4)


def pools(**values):
    names = ("byte", "short", "int", "random byte", "random short", "indices")
    return {name: Pool(name, list(values.get(name.replace(" ", "_"), []))) for name in names}


def test_flat_pools_read_in_bone_class_order():
    # counts: no quat, half, full, half no size, full no size, small, full trans, trans no size, no trans, all
    counts = [0, 1, 0, 1, 0, 0, 0, 1, 1, 2]
    p = pools(
        byte=[0, 1, 1, 0],  # the half quat's two key frames, then the bone of each translation class
        short=[1, 5, 32767],  # the half quat's stored size, then the constant one's (z, w)
        int=[struct.unpack("<i", struct.pack("<f", v))[0] for v in (1.0, 2.0, 3.0)],
        random_short=[0, 32767, 23170, 23170],
    )
    first, second = bone_tracks(["a", "b"], counts, p, byte_indices=True)
    assert first.rotation.half and first.rotation.indices == [0, 1]
    assert first.rotation.frames == [(0, 32767), (23170, 23170)] and first.translation is None
    assert second.rotation.frames == [(5, 32767)] and not second.rotation.indices
    assert second.translation.constant == (1.0, 2.0, 3.0)


def test_long_tracks_keep_their_indices_in_the_pool_and_checkpoints_in_the_shorts():
    counts = [0, 1, 0, 0, 0, 0, 0, 0, 1, 1]
    keys = list(range(0, 130, 2))  # 65 keys: stored size 64
    p = pools(
        short=[64, keys[0], keys[-1]],  # size, then the checkpoints: the first entry and the last
        indices=keys,
        byte=[0],
        random_short=[0, 32767] * 65,
    )
    track = bone_tracks(["a"], counts, p, byte_indices=False)[0]
    assert track.rotation.indices == keys and len(track.rotation.frames) == 65


def test_a_pool_left_over_is_refused():
    counts = [1, 0, 0, 0, 0, 0, 0, 0, 1, 1]
    with pytest.raises(ValueError, match="not used up"):
        bone_tracks(["a"], counts, pools(byte=[0, 7]), byte_indices=True)


# -- scripts and entities ---------------------------------------------------------------


def gscbin(strings):
    section = zlib.compress(strings)
    return b"1201\0" + struct.pack("<3i", len(section), len(strings), 0) + section


def test_a_compiled_ghosts_script_names_its_model_after_printable_reference_bytes():
    # mp_dart's roof vents: IW6 puts `|` before the model, which is not part of its name.
    strings = b"c\0\0\0\xddOmapname\0mp_\0\x9f\x03\xe1|com_roofvent2_animated\0animated_props\0roofvent_rotate\0rotate\0"
    assert compiled_assignments(gscbin(strings), {"roofvent_rotate"}) == [("com_roofvent2_animated", "roofvent_rotate")]


def test_ghosts_entity_keys_are_named():
    entity = {"97": "script_model", "642": "animated_model", "24841": "maps animated_models com_roofvent2", "392": "m"}
    assert named_keys([entity], "iw6")[0] == {
        "classname": "script_model",
        "targetname": "animated_model",
        "precache_script": "maps animated_models com_roofvent2",
        "model": "m",
    }


def test_only_ghosts_flag_sets_take_iw5s_flag_shader():
    constants = [{"name": "flagParms", "literal": [0.5, 1.0, 0, 0]}]
    assert flag_parms({"techniqueSet": "mc_l_sm_flag_t0c0n0l0_nfwpf", "constants": constants}, "iw6") == [0.5, 1.0]
    # flagext sets draw material-defined waves (flagWave0Parms...), which the ported shader does not.
    assert not is_flag_technique("mc_l_sm_flagext_wv0_t0c0l0_nfwpf", "iw6")
    assert is_flag_technique("mc_l_sm_flagext_wv0_t0c0l0_nfwpf", "iw5")  # IW5's rule is unchanged
