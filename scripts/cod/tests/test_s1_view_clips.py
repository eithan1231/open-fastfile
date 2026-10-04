"""What a translation key means on Advanced Warfare, and that no other game's reading moved.

S1 adds a key to the model's own tagPositions, and the view arms store zeros there:
so a view clip is absolute on the arms and an offset on the gun, and a body clip
is an offset whatever its asset type (reverse/s1-zone/README.md#the-animations).
`clip_to_gltf` carries that as `absolute_bones`; left out, it reads the asset type
as it always has, which the last test holds against the built catalogue itself.
"""

import os
import struct

import pytest

from scripts.cod.animations import ZERO_TAG_POSITIONS, absolute_joints, clip_to_gltf
from scripts.cod.catalog import s1_absolute_bones, s1_akimbo, s1_without_still_clips
from scripts.cod.files import read_bytes, read_json
from scripts.cod.gltf import read_glb, write_glb
from scripts.cod.iw6.records import Model
from scripts.cod.s1.dumpers.xmodel import zero_tag_positions
from scripts.cod.xanim import BoneTrack, Track, XAnim, decode
from scripts.cod.xmodel_glb import Bone

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")


def view_rig():
    """An arm (the hands' joint) and a magazine (the gun's), each some inches from its parent."""
    return {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [3]}],
        "nodes": [
            {"name": "tag_origin", "children": [1, 2]},
            {"name": "j_elbow_le", "translation": [12.094, 0.0, 0.0]},
            {"name": "tag_clip", "translation": [4.3, 0.0, 1.3]},
            {"name": "skel", "children": [0]},
        ],
        "skins": [{"joints": [0, 1, 2]}],
        "buffers": [{"byteLength": 0}],
    }


def translations(gltf, buf):
    """{joint: its first translation key} of the one animation written."""
    (anim,) = gltf["animations"]
    out = {}
    for channel in anim["channels"]:
        if channel["target"]["path"] == "translation":
            accessor = gltf["accessors"][anim["samplers"][channel["sampler"]]["output"]]
            view = gltf["bufferViews"][accessor["bufferView"]]
            out[gltf["nodes"][channel["target"]["node"]]["name"]] = list(struct.unpack_from("<3f", buf, view["byteOffset"]))
    return out


def clip(asset_type, elbow=(12.094, 0.0, 0.0), mag=(0.0, 0.0, -2.0)):
    bones = [BoneTrack("j_elbow_le", None, Track([0], [list(elbow)])), BoneTrack("tag_clip", None, Track([0], [list(mag)]))]
    return XAnim("vm_gun_reload", 1, 30.0, False, bones, asset_type=asset_type)


@pytest.mark.parametrize("asset_type", [1, 2])
def test_on_s1_the_arms_are_absolute_and_the_gun_an_offset_whatever_the_asset_type(asset_type):
    gltf, buf = view_rig(), bytearray()
    clip_to_gltf(gltf, buf, clip(asset_type), absolute_bones={"tag_origin", "j_elbow_le"})
    out = translations(gltf, buf)
    assert out["j_elbow_le"] == pytest.approx([12.094, 0.0, 0.0])  # its bind length, not twice it
    assert out["tag_clip"] == pytest.approx([4.3, 0.0, -0.7])  # two inches down from the magwell


def test_on_s1_a_body_clip_of_type_1_is_an_offset():
    # 340 body clips are type 1; read as absolute, a neck key of 0.001 in sinks the head.
    gltf, buf = view_rig(), bytearray()
    clip_to_gltf(gltf, buf, clip(1, elbow=(0.001, 0.0, 0.0)), absolute_bones=set())
    assert translations(gltf, buf)["j_elbow_le"] == pytest.approx([12.095, 0.0, 0.0])


def test_on_s1_an_additive_clip_is_refused_rather_than_baked_as_a_pose():
    with pytest.raises(ValueError, match="additive"):
        clip_to_gltf(view_rig(), bytearray(), clip(6), absolute_bones=set())


def test_elsewhere_the_asset_type_decides_as_before():
    gltf, buf = view_rig(), bytearray()
    clip_to_gltf(gltf, buf, clip(1))
    assert translations(gltf, buf) == {"j_elbow_le": pytest.approx([12.094, 0, 0]), "tag_clip": pytest.approx([4.3, 0, -0.7])}
    gltf, buf = view_rig(), bytearray()
    clip_to_gltf(gltf, buf, clip(2))
    assert translations(gltf, buf)["j_elbow_le"] == pytest.approx([24.188, 0, 0])


def test_the_absolute_joints_are_the_models_only_where_its_dump_says_so(tmp_path):
    (tmp_path / "arms.json").write_text(f'{{"{ZERO_TAG_POSITIONS}": true}}')
    (tmp_path / "gun.json").write_text("{}")
    assert absolute_joints(str(tmp_path), "arms", view_rig()) == {"tag_origin", "j_elbow_le", "tag_clip"}
    assert absolute_joints(str(tmp_path), "gun", view_rig()) == set()
    assert absolute_joints(str(tmp_path), "never_dumped", view_rig()) == set()


def test_s1_hands_dumped_without_the_flag_stop_the_build(tmp_path):
    # Read as offsets, every forearm doubles and nothing fails.
    (tmp_path / "xmodel").mkdir()
    (tmp_path / "xmodel" / "hands.json").write_text("{}")
    write_glb(tmp_path / "hands.glb", view_rig(), bytearray())
    with pytest.raises(SystemExit, match="tagPositions"):
        s1_absolute_bones(str(tmp_path), "hands", str(tmp_path / "hands.glb"))


def a_skeleton(tag_positions):
    """A root and two children 10 in apart in baseMat, with the tagPositions given, as zone bytes."""
    data = struct.pack("<8h", 0, 0, 0, 32767, 0, 0, 0, 32767) + b"".join(struct.pack("<3f", *t) for t in tag_positions)
    model = Model("m", [], bone_count=3, root_bone_count=1, tag_angles=0, tag_positions=16)
    one = (0.0, 0.0, 0.0, 1.0)
    bones = [Bone("tag_origin", None, (0, 0, 0), one), Bone("a", 0, (10, 0, 0), one), Bone("b", 1, (20, 0, 0), one)]
    return data, model, bones


def test_the_dump_flags_a_model_whose_tag_positions_are_zeros_and_its_bind_pose_is_not():
    assert zero_tag_positions(*a_skeleton([(0, 0, 0), (0, 0, 0)]))
    assert not zero_tag_positions(*a_skeleton([(10, 0, 0), (10, 0, 0)]))
    assert not zero_tag_positions(*a_skeleton([(10, 0, 0), (0, 0, 0)]))
    data, model, bones = a_skeleton([(0, 0, 0), (0, 0, 0)])
    at_the_origin = [bones[0], Bone("a", 0, (0, 0, 0), bones[0].rotation), Bone("b", 1, (0, 0, 0), bones[0].rotation)]
    assert not zero_tag_positions(data, model, at_the_origin)  # both readings agree, so nothing to say


def test_a_clip_that_moves_nothing_loses_its_role_rather_than_naming_a_clip_the_glb_lacks():
    # The combat knife's `ads_up` has no track; written as no animation, the engine
    # would refuse the whole weapon over a role it cannot find.
    still = XAnim("knife_ads_up", 1, 30.0, False, [BoneTrack("j_gun", None, None)], asset_type=1)
    idle = XAnim("knife_idle", 1, 30.0, True, [BoneTrack("j_gun", Track([0], [[0, 0, 0, 1]]), None)], asset_type=1)
    info = {"idleAnim": "Knife_Idle", "adsUpAnim": "knife_ads_up", "clipSize": "0"}
    kept = s1_without_still_clips(info, {"knife_ads_up": still, "knife_idle": idle})
    assert kept == {"idleAnim": "Knife_Idle", "clipSize": "0"}


def test_a_weapon_whose_akimbo_is_automatic_is_akimbo():
    akimbo = {"automaticAttachment": True, "displayName": "WEAPON_AKIMBO_ATTACHMENT"}
    optional = {"automaticAttachment": False, "displayName": "WEAPON_AKIMBO_ATTACHMENT"}
    assert s1_akimbo({"attachments": "akimbosac3\nxmags"}, {"akimbosac3": akimbo})
    assert not s1_akimbo({"attachments": "akimbo"}, {"akimbo": optional})


# One built weapon per game and where its clips were dumped; skipped where either is absent.
BUILT = {"iw4": "catalog-mw2", "iw5": "catalog-mw3", "iw6": "catalog-ghosts", "t5": "catalog-bo1"}


@pytest.mark.parametrize("game", sorted(BUILT))
def test_the_other_games_catalogued_clips_come_out_the_same(game):
    """Every translation and rotation a built weapon carries, rewritten from its clips by today's code."""
    weapons = os.path.join(ROOT, "worlds", "catalog", "weapons", game)
    clips_dir = os.path.join(ROOT, ".cache", "cod", BUILT[game], "view_anim", "xanim")
    if not (os.path.isdir(weapons) and os.path.isdir(clips_dir)):
        pytest.skip(f"no built {game} catalogue or no clip dump beside it")
    for weapon in sorted(os.listdir(weapons))[:3]:
        glb = os.path.join(weapons, weapon, f"{weapon}.glb")
        if not os.path.exists(glb) or not read_json(os.path.join(weapons, weapon, f"{weapon}.json")):
            continue
        built, buf = read_glb(glb)
        fresh, fresh_buf = {**built, "animations": []}, bytearray(buf)
        fresh["accessors"], fresh["bufferViews"] = list(built["accessors"]), list(built["bufferViews"])
        for anim in built.get("animations", []):
            clip_to_gltf(fresh, fresh_buf, decode(read_bytes(os.path.join(clips_dir, anim["name"])), anim["name"]))
        assert [a["name"] for a in fresh["animations"]] == [a["name"] for a in built.get("animations", [])]
        for old, new in zip(built.get("animations", []), fresh["animations"], strict=True):
            assert [c["target"] for c in old["channels"]] == [c["target"] for c in new["channels"]]
            for a, b in zip(old["samplers"], new["samplers"], strict=True):
                assert samples(built, buf, a["output"]) == samples(fresh, fresh_buf, b["output"]), f"{weapon}/{old['name']}"


def samples(gltf, buf, accessor):
    acc = gltf["accessors"][accessor]
    view = gltf["bufferViews"][acc["bufferView"]]
    return bytes(buf[view["byteOffset"] : view["byteOffset"] + view["byteLength"]])
