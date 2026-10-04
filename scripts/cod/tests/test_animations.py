import math
import struct
import zlib

import pytest

from scripts.cod.animations import ClipAssignments, clip_to_gltf, compiled_assignments, embed_clips, text_assignments
from scripts.cod.gltf import read_glb, write_glb
from scripts.cod.materials import flag_parms
from scripts.cod.pack import keep_flag_weights, neutralize_vertex_colours
from scripts.cod.props import write_props_world
from scripts.cod.xanim import SMALL_TRANS_SCALE, BoneTrack, Track, XAnim, decode

# -- xanim ----------------------------------------------------------------------


def xanim_bytes(frames, fps, looped, bones, version=17, asset_type=2, notes=()):
    """A compiled xanim in OAT's layout. `bones`: (name, half, quats or None, trans or None), keyed on every loop frame."""
    loop_frames = frames + 1 if looped else frames
    out = struct.pack("<HHHBBH", version, frames, len(bones), 1 if looped else 0, asset_type, fps)
    mask = (len(bones) + 7) // 8
    half_bits = bytearray(mask)
    for i, (_, half, _, _) in enumerate(bones):
        half_bits[i // 8] |= half << (i % 8)
    out += bytes(mask) + bytes(half_bits)
    out += b"".join(name.encode() + b"\0" for name, *_ in bones)
    for _, half, quats, trans in bones:
        quats, trans = quats or [], trans or []
        out += struct.pack("<H", len(quats))
        for q in quats:
            out += struct.pack("<h", q[0]) if half else struct.pack("<3h", *q[:3])
        out += struct.pack("<H", len(trans))
        if len(trans) == 1:
            out += struct.pack("<3f", *trans[0])
        elif trans:
            assert len(trans) >= loop_frames  # every frame keyed, so no index list
            out += struct.pack("<B3f3f", 1, 0.0, 0.0, 0.0, 255.0, 255.0, 255.0)  # small, mins 0, size -> 1 per step
            out += b"".join(struct.pack("<3B", *t) for t in trans)
    out += struct.pack("<B", len(notes))
    return out + b"".join(name.encode() + b"\0" + struct.pack("<H", frame) for name, frame in notes)


def test_decode_reads_quaternions_translations_and_timing():
    q45 = round(math.sin(math.radians(22.5)) * 32767)  # 45 degrees about one axis
    data = xanim_bytes(
        frames=2,
        fps=10,
        looped=True,
        bones=[
            ("j_spin", False, [(0, 0, 0), (q45, 0, 0), (0, 0, 0)], None),
            ("j_tail", True, [(q45,)], [(0, 1, 2), (3, 4, 5), (0, 1, 2)]),
        ],
    )
    anim = decode(data, "clip")
    assert (anim.frames, anim.fps, anim.looped, anim.duration) == (2, 10.0, True, 0.2)
    spin, tail = anim.bones
    assert spin.rotation.indices == [0, 1, 2]
    x, y, z, w = spin.rotation.values[1]
    assert (y, z) == (0, 0) and math.degrees(2 * math.atan2(x, w)) == pytest.approx(45, abs=0.01)
    # A two-component track is a rotation about local Z.
    assert tail.rotation.values[0][:2] == [0.0, 0.0]
    assert math.degrees(2 * math.atan2(tail.rotation.values[0][2], tail.rotation.values[0][3])) == pytest.approx(45, abs=0.01)
    assert tail.translation.values[1] == pytest.approx([3 * 255 * SMALL_TRANS_SCALE, 4.0, 5.0], rel=1e-6)


def test_decode_keeps_the_asset_type_and_each_notetrack_frame():
    data = xanim_bytes(4, 30, False, [("j", False, [(0, 0, 0)], None)], asset_type=1, notes=[("clipout", 2), ("end_cue", 4)])
    anim = decode(data, "reload")
    assert anim.asset_type == 1
    assert anim.notetracks == [("clipout", 2), ("end_cue", 4)]


def test_decode_refuses_a_misread_layout():
    data = xanim_bytes(1, 30, False, [("j", False, [(0, 0, 0)], None)])
    with pytest.raises(ValueError, match="trailing"):
        decode(data + b"\0")
    with pytest.raises(ValueError, match="truncated"):
        decode(data[:-3])
    with pytest.raises(ValueError, match="version"):
        decode(struct.pack("<H", 20) + data[2:])


# -- which clip an entity plays ---------------------------------------------------------

IW4_SCRIPT = """
#using_animtree( "animated_props" );
main()
{
	model = "foliage_pacific_bushtree02_animated";
	if ( SP )
		level.anim_prop_models[ model ][ "sway" ] = %foliage_pacific_bushtree01_sway;
	else
		level.anim_prop_models[ model ][ "sway" ] = "foliage_pacific_bushtree01_sway";
	level.anim_prop_models[ "windmill" ][ "wind" ] = "windmill_spin";
}
"""


def test_text_scripts_name_the_clip_through_a_variable_or_a_literal():
    assert text_assignments(IW4_SCRIPT) == [
        ("foliage_pacific_bushtree02_animated", "foliage_pacific_bushtree01_sway"),
        ("windmill", "windmill_spin"),
    ]


def test_a_reassigned_variable_names_the_model_it_held_at_that_line():
    # P18: the scan used to re-read the whole prefix per assignment to find the
    # variable's last value — 39 s on an 8,000-line script. One pass has to keep
    # the same answer: the value as of *that* line, not the file's last one.
    script = """
        model = "prop_a";
        level.anim_prop_models[ model ][ "wind" ] = "clip_a";
        model = "prop_b";
        level.anim_prop_models[ model ][ "wind" ] = "clip_b";
        level.anim_prop_models[ never_set ][ "wind" ] = "clip_c";
        level.anim_prop_models[ "prop_a" ][ "wind" ] = "clip_a";
    """
    assert text_assignments(script) == [("prop_a", "clip_a"), ("prop_b", "clip_b")]


def gscbin(strings):
    body = zlib.compress(b"\0".join(s.encode() for s in strings) + b"\0")
    return b"1457\0" + struct.pack("<iii", len(body), 999, 4) + body + b"\0\0\0\0"


def test_compiled_scripts_give_the_model_before_the_animtree_its_clips():
    clips = {"fence_tarp_med_01", "fence_tarp_med_02"}
    data = gscbin(["mapname", "mp_", "fence_tarp", "animated_props", "fence_tarp_med_02", "wind", "fence_tarp_med_02", "wind"])
    assert compiled_assignments(data, clips) == [("fence_tarp", "fence_tarp_med_02")]
    assert compiled_assignments(gscbin(["maps/mp/_utility", "barrel"]), clips) == []
    assert compiled_assignments(b"garbage", clips) == []


def test_each_entity_plays_the_clip_its_own_script_names():
    by_script = {
        "maps/animated_models/tarp_01": [("fence_tarp", "tarp_01")],
        "maps/animated_models/tarp_02": [("fence_tarp", "tarp_02")],
    }
    assign = ClipAssignments("iw4", by_script, {"tarp_01", "tarp_02"})

    def entity(**keys):
        return {"classname": "script_model", "model": "fence_tarp", "targetname": "animated_model", **keys}

    assert assign.clip_for(entity(precache_script="maps animated_models tarp_02")) == "tarp_02"
    assert assign.clip_for(entity()) == "tarp_01"  # no script: the model's first clip
    assert assign.clip_for({**entity(), "targetname": "something_else"}) is None
    assert assign.clip_for({**entity(), "model": "unknown_model"}) is None
    assert assign.missing == {"unknown_model": 1}


def test_iw5_entities_use_numeric_keys_and_scripts_named_after_their_clip():
    scripts = {"#0": [("fence_tarp", "tarp_01")], "#1": [("fence_tarp", "tarp_02")]}
    assign = ClipAssignments("iw5", scripts, {"tarp_01", "tarp_02"})
    iw5 = {"1668": "script_model", "1670": "fence_tarp", "1673": "animated_model", "2818": "maps animated_models tarp_02"}
    assert assign.clip_for(iw5) == "tarp_02"


# -- writing clips into a GLB -------------------------------------------------------------

AXIS_CHANGE = [-math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)]  # OAT's Z-up -> Y-up, on the root joint


def rigged_gltf():
    return {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [2]}],
        "nodes": [
            {"name": "tag_origin", "rotation": AXIS_CHANGE, "children": [1]},
            {"name": "j_arm", "translation": [10.0, 0.0, 5.0], "rotation": [0.0, 0.0, 0.5, math.sqrt(0.75)]},
            {"name": "skel", "children": [0]},
        ],
        "skins": [{"joints": [0, 1]}],
        "buffers": [{"byteLength": 0}],
    }


def floats(gltf, buf, accessor):
    acc = gltf["accessors"][accessor]
    width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[acc["type"]]
    view = gltf["bufferViews"][acc["bufferView"]]
    flat = struct.unpack_from(f"<{acc['count'] * width}f", buf, view["byteOffset"])
    return [list(flat[i : i + width]) for i in range(0, len(flat), width)]


def test_clip_rotations_replace_the_bind_pose_and_translations_add_to_it():
    gltf, buf = rigged_gltf(), bytearray()
    clip = XAnim(
        "wave",
        2,
        4.0,
        True,
        [
            BoneTrack("j_arm", Track([0, 2], [[0, 0, 0, 1], [0, 0, 0, 1]]), Track([0, 1], [[0, 0, 0], [0, 0, 2]])),
            BoneTrack("tag_origin", Track([0], [[0, 0, 0, 1]]), Track([0], [[0, 0, 3]])),
            BoneTrack("j_not_here", Track([0], [[0, 0, 0, 1]]), None),
        ],
    )
    assert clip_to_gltf(gltf, buf, clip) == (2, 1)
    (anim,) = gltf["animations"]
    assert anim["name"] == "wave"
    out = {}
    for c in anim["channels"]:
        out[(gltf["nodes"][c["target"]["node"]]["name"], c["target"]["path"])] = anim["samplers"][c["sampler"]]

    arm_rot = out[("j_arm", "rotation")]
    assert floats(gltf, buf, arm_rot["input"]) == [[0.0], [0.5]]  # frame index / fps
    assert gltf["accessors"][arm_rot["input"]]["max"] == [0.5]
    assert floats(gltf, buf, arm_rot["output"])[0] == pytest.approx([0, 0, 0, 1])  # not the bind rotation
    assert floats(gltf, buf, out[("j_arm", "translation")]["output"])[1] == pytest.approx([10, 0, 7])

    # On the root joint the axis change stays applied: identity in CoD's frame is the axis change here.
    assert floats(gltf, buf, out[("tag_origin", "rotation")]["output"])[0] == pytest.approx(AXIS_CHANGE)
    assert floats(gltf, buf, out[("tag_origin", "translation")]["output"])[0] == pytest.approx([0, 3, 0], abs=1e-6)


def test_asset_type_1_translations_are_the_translation_itself_not_an_offset():
    # A view clip keys every bone's local translation outright: its idle's elbow key equals the
    # bind translation. Added to the bind as a prop's offset would be, every forearm doubles.
    gltf, buf = rigged_gltf(), bytearray()
    clip = XAnim("view_idle", 1, 30.0, True, [BoneTrack("j_arm", None, Track([0], [[10.0, 0.0, 5.0]]))], asset_type=1)
    clip_to_gltf(gltf, buf, clip)
    (channel,) = gltf["animations"][0]["channels"]
    sampler = gltf["animations"][0]["samplers"][channel["sampler"]]
    assert floats(gltf, buf, sampler["output"])[0] == pytest.approx([10, 0, 5])


def test_embed_clips_writes_only_the_clips_placements_play(tmp_path):
    gltf = rigged_gltf()
    write_glb(tmp_path / "arm_lod0.glb", gltf, bytearray())
    write_glb(tmp_path / "rock_lod0.glb", {**rigged_gltf(), "skins": []}, bytearray())
    wave = XAnim("wave", 1, 30.0, True, [BoneTrack("j_arm", Track([0], [[0, 0, 0, 1]]), None)])
    unused = XAnim("unused", 1, 30.0, True, [BoneTrack("j_arm", Track([0], [[0, 0, 0, 1]]), None)])
    placements = [{"model": "arm", "anim": "wave"}, {"model": "rock", "anim": "wave"}, {"model": "arm", "anim": None}]

    assert embed_clips(str(tmp_path), placements, {"wave": wave, "unused": unused}) == {"arm": {"wave"}}
    back, buf = read_glb(tmp_path / "arm_lod0.glb")
    assert [a["name"] for a in back["animations"]] == ["wave"]
    assert back["buffers"][0]["byteLength"] == len(buf)


def test_props_world_animates_only_placements_whose_clip_was_embedded(tmp_path):
    positions = struct.pack("<6f", 0, 0, 0, 1, 1, 1)
    mesh = {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 2, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 1]}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 24}],
        "buffers": [{"byteLength": 24}],
    }
    props = tmp_path / "props"
    props.mkdir()
    write_glb(props / "arm_lod0.glb", mesh, bytearray(positions))
    (tmp_path / "clip.json").write_text("{}")
    base = {"x": 0.0, "y": 0.0, "z": 0.0, "pitch": 0.0, "yaw": 0.0, "roll": 0.0, "scale": 1.0}
    placements = [{**base, "model": "arm", "anim": "wave"}, {**base, "x": 1.0, "model": "arm", "anim": "gone"}]

    out = tmp_path / "props.world"
    write_props_world(placements, str(props), str(out), str(tmp_path), str(tmp_path / "clip.json"), {"arm": {"wave"}})
    lines = [line for line in out.read_text().splitlines() if "model {" in line]
    assert lines[0].endswith('collide: false, animate: "wave" }')
    assert "animate" not in lines[1]
    assert "// 1 animate, playing 1 clip(s)" in out.read_text()


# -- flag wind ----------------------------------------------------------------------------


def test_flag_parms_only_for_the_flag_technique():
    constants = [{"name": "flagParms", "literal": [1.22, 0.5, 0, 0]}]
    assert flag_parms({"techniqueSet": "mc_l_sm_flag_t0c0s0_sat", "constants": constants}, "iw5") == [1.22, 0.5]
    assert flag_parms({"techniqueSet": "mc_l_sm_r0c0_sat", "constants": constants}, "iw5") is None
    assert flag_parms({"techniqueSet": "mc_l_flag_t0c0_sat"}, "iw5") is None


def test_flag_weights_survive_the_vertex_colour_neutralising():
    colours = bytes([255, 255, 255, 0, 255, 255, 255, 51])  # two vertices, alpha 0 and 0.2
    gltf = {
        "materials": [{"name": "mc/grass_flag"}, {"name": "mc/rock"}],
        "meshes": [
            {"primitives": [{"attributes": {"COLOR_0": 0}, "material": 0}]},
            {"primitives": [{"attributes": {"COLOR_0": 0}, "material": 1}]},
        ],
        "accessors": [{"bufferView": 0, "componentType": 5121, "normalized": True, "count": 2, "type": "VEC4"}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 8}],
    }
    buf = bytearray(colours)
    assert keep_flag_weights(gltf, buf, {"mc/grass_flag": {"flag": [1.0, 0.0]}, "mc/rock": {"flag": None}}) == 1
    neutralize_vertex_colours(gltf, buf)

    weight = gltf["meshes"][0]["primitives"][0]["attributes"]["_FLAG_WEIGHT"]
    view = gltf["bufferViews"][gltf["accessors"][weight]["bufferView"]]
    assert struct.unpack_from("<2f", buf, view["byteOffset"]) == pytest.approx((0.0, 0.2))
    assert "_FLAG_WEIGHT" not in gltf["meshes"][1]["primitives"][0]["attributes"]
    assert buf[3] == buf[7] == 255  # and the colours themselves no longer carry it
