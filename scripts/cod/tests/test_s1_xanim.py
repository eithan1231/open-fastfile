"""Advanced Warfare clips: the XAnimParts walk and the xanim dump, on bytes laid out for the test.

What these pin is what reverse/s1-zone/README.md#the-animations established on
every clip of common_mp.ff and common_core_mp.ff: S1's flat pools are IW6's, in
IW6's order, so IW6's reader decodes them; S1's twelve `boneCount` classes use
only IW6's ten; and a clip whose keys are not unit quaternions, or whose key
frames do not run 0 to `numframes`, was read at the wrong place and is refused.
"""

import json
import math
import struct

from scripts.cod.iw6.zone import KIND_FLOAT, KIND_POINTER, KIND_UNSIGNED, POINTER_TAG, TEMP, Layout, Zone
from scripts.cod.s1 import walkers
from scripts.cod.s1.dumpers import COMPLETE, Walked
from scripts.cod.s1.dumpers import xanim as xanim_dump
from scripts.cod.xanim import FULL_TRANS_SCALE, RawBone, RawClip, RawRotation, RawTranslation, decode

FOLLOWS = POINTER_TAG | 0xFFFFFFFF


def u(size):
    """(size, element size, kind, pointee size, array extent, nested type) of a plain member."""
    return (size, size, KIND_UNSIGNED, 0, 0, "")


def ptr(pointee, base=""):
    return (8, 8, KIND_POINTER, pointee, 0, base)


# XAnimParts at x64-zt's s1 offsets (216 bytes), and what the walker reads through it.
PARTS = {
    "name": (0, *ptr(1)),
    "dataByteCount": (8, *u(2)),
    "dataShortCount": (10, *u(2)),
    "dataIntCount": (12, *u(2)),
    "numframes": (14, *u(2)),
    "flags": (16, *u(1)),
    "boneCount": (17, 12, 1, KIND_UNSIGNED, 0, 12, ""),
    "notifyCount": (29, *u(1)),
    "assetType": (30, *u(1)),
    "ikType": (31, *u(1)),
    "randomDataByteCount": (32, *u(4)),
    "randomDataShortCount": (36, *u(4)),
    "randomDataIntCount": (40, *u(4)),
    "indexCount": (44, *u(4)),
    "framerate": (48, 4, 4, KIND_FLOAT, 0, 0, ""),
    "frequency": (52, 4, 4, KIND_FLOAT, 0, 0, ""),
    "names": (56, *ptr(4)),
    "dataByte": (64, *ptr(1)),
    "dataShort": (72, *ptr(2)),
    "dataInt": (80, *ptr(4)),
    "randomDataShort": (88, *ptr(2)),
    "randomDataByte": (96, *ptr(1)),
    "randomDataInt": (104, *ptr(4)),
    "indices": (112, 8, 8, 0, 0, 0, "XAnimIndices"),
    "notify": (120, *ptr(8)),
    "deltaPart": (128, *ptr(24, "XAnimDeltaPart")),
    "secondaryName": (136, *ptr(1)),
    "blendShapeCount": (146, *u(2)),
    "blendShapeWeightNames": (152, *ptr(4)),
    "blendShapeCoefficientMagnitudes": (160, *ptr(3)),
    "numberOfBlendShapeKeys": (168, *ptr(2)),
    "blendShapeKeys": (176, *ptr(2)),
    "compressedBlendShapeCoefficients": (184, *ptr(2)),
    "blendShapeWeights": (192, *ptr(4)),
    "svAmimData": (208, *ptr(8)),
}


def anim_layout(tmp_path):
    out = [["XAnimParts", "", 0, 216, 0, 0, 0, 0, 0, ""], ["XAnimIndices", "", 0, 8, 0, 0, 0, 0, 0, ""]]
    for member, (offset, size, elem, kind, pointee, extent, base) in PARTS.items():
        out.append(["XAnimParts", member, offset, size, elem, pointee, kind, extent, 0, base])
    for name in ("_1", "_2", "data"):
        out.append(["XAnimIndices", name, 0, 8, 8, 1, KIND_POINTER, 0, 0, ""])
    path = tmp_path / "anim.json"
    path.write_text(json.dumps(out))
    return Layout(str(path))


def floats(*values):
    return list(struct.unpack(f"<{len(values)}i", struct.pack(f"<{len(values)}f", *values)))


def about_z(degrees):
    h = math.radians(degrees) / 2
    return (0, 0, round(math.sin(h) * 32767), round(math.cos(h) * 32767))


# Two bones over frames 0..3. `j_b` (listed first: it has no rotation) moves on byte keys at
# frames 0 and 3; `j_a` turns about Z on four full keys and sits at a constant translation.
COUNTS = [1, 0, 1, 0, 0, 1, 0, 1, 0, 2, 0, 0]
POOLS = {
    # j_a's four key frames; then j_b's bone, its two key frames; then j_a's bone.
    "dataByte": struct.pack("<8B", 0, 1, 2, 3, 0, 0, 3, 1),
    "dataShort": struct.pack("<2h", 3, 1),  # stored key counts, less one: j_a's rotation, j_b's translation
    "dataInt": struct.pack("<9i", *floats(1, 2, 3, 0.5, 0, 0, 12, 0, 0)),  # j_b's mins and step, j_a's constant
    "randomDataShort": struct.pack("<16h", *(v for a in (0, 30, 60, 90) for v in about_z(a))),
    "randomDataByte": struct.pack("<6B", 0, 0, 0, 10, 0, 0),
}


def a_clip_zone(tmp_path, counts=COUNTS, framerate=30.0, asset_type=1):
    """A zone holding one XAnimParts whose arrays follow, as common_mp.ff writes one."""
    layout = anim_layout(tmp_path)
    header = bytearray(216)
    pools = POOLS
    struct.pack_into("<HHHH", header, 8, len(pools["dataByte"]), 2, 9, 3)
    struct.pack_into("<B12BBBB", header, 16, 0, *counts, 2, asset_type, 0)
    struct.pack_into("<IIIIff", header, 32, 6, 16, 0, 0, framerate, 0.0)
    for member in ("name", "names", "dataByte", "dataShort", "dataInt", "randomDataShort", "randomDataByte", "notify"):
        struct.pack_into("<Q", header, PARTS[member][0], FOLLOWS)
    data = bytearray(72) + header + b"clip\0"
    data += struct.pack("<2I", 1, 2)  # names: script strings 1 and 2
    data += struct.pack("<IfIf", 3, 1 / 3, 4, 1.0)  # notetracks: `fire` on frame 1, and the linker's `end`
    for member in ("dataByte", "dataShort", "dataInt", "randomDataShort", "randomDataByte"):
        data += pools[member]
    zone = Zone(bytes(data), layout)
    zone.script_strings = ["", "j_b", "j_a", "fire", "end"]
    zone.pos = 72
    zone.push(TEMP)
    assert walkers.xanim_parts(zone) == "clip"
    assert zone.pos == len(data), "the walk consumed the clip exactly"
    return Walked("common_mp.ff", zone, None, {"materials": {}})


def test_a_clip_is_walked_dumped_and_decoded(tmp_path):
    assert "xanim" in COMPLETE
    walked = a_clip_zone(tmp_path)
    xanim_dump.write(walked, str(tmp_path / "out"))
    clip = decode((tmp_path / "out" / "xanim" / "clip").read_bytes(), "clip")
    assert (clip.frames, clip.fps, clip.asset_type, clip.notetracks) == (3, 30.0, 1, [("fire", 1)])
    j_b, j_a = clip.bones
    assert (j_b.name, j_b.rotation) == ("j_b", None)
    assert j_b.translation.indices == [0, 3]
    assert [[round(v, 4) for v in key] for key in j_b.translation.values] == [[1, 2, 3], [6, 2, 3]]
    assert j_a.translation.values == [[12.0, 0.0, 0.0]]
    assert j_a.rotation.indices == [0, 1, 2, 3]
    turned = [math.degrees(2 * math.atan2(q[2], q[3])) for q in j_a.rotation.values]
    assert [round(a) for a in turned] == [0, 30, 60, 90]


def test_s1s_extra_bone_classes_are_refused(tmp_path):
    counts = [*COUNTS[:10], 1, 0]
    walked = a_clip_zone(tmp_path, counts=counts)
    xanim_dump.write(walked, str(tmp_path / "out"))
    assert not (tmp_path / "out" / "xanim" / "clip").exists()


def header(**values):
    parts = {f"boneCount[{k}]": v for k, v in enumerate(COUNTS)}
    parts.update(randomDataIntCount=0, blendShapeCount=0)
    parts.update(values)
    return parts


def test_a_header_is_checked_against_iw6s_classes():
    assert xanim_dump.check_header(header()) is None
    assert "sum" in xanim_dump.check_header(header(**{"boneCount[2]": 0}))
    assert "10 and 11" in xanim_dump.check_header(header(**{"boneCount[11]": 1}))
    assert "randomDataInt" in xanim_dump.check_header(header(randomDataIntCount=3))
    assert "blend-shape" in xanim_dump.check_header(header(blendShapeCount=1))


def raw(rotation=None, translation=None, frames=3):
    return RawClip(frames, 30.0, False, 1, [RawBone("j", rotation, translation)])


def test_a_rotation_key_off_unit_length_is_refused():
    """Pools read one short out of step still decode into smooth motion; they stop being unit quaternions."""
    good = RawRotation(False, [about_z(0), about_z(90)], [0, 3])
    assert xanim_dump.check_clip(raw(good)) is None
    skewed = RawRotation(False, [about_z(0), (0, 23170, 23170, 23170)], [0, 3])
    assert "length" in xanim_dump.check_clip(raw(skewed))


def test_key_frames_must_run_from_zero_to_the_last_frame():
    track = RawTranslation(None, False, (0, 0, 0), (FULL_TRANS_SCALE,) * 3, [(0, 0, 0), (1, 1, 1)], [0, 2])
    assert "key frames" in xanim_dump.check_clip(raw(translation=track))
    track.indices = [0, 3]
    assert xanim_dump.check_clip(raw(translation=track)) is None


def test_a_notetrack_between_frames_is_counted():
    clip = raw(RawRotation(False, [about_z(0)]))
    clip.notifies = [("fire", 1 / 3), ("reload", 0.5), ("end", 1.0)]
    assert xanim_dump.notes_off_frame(clip) == 1
