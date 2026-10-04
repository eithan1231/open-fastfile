import math

import pytest

from scripts.cod.xanim import FULL_TRANS_SCALE, RawBone, RawClip, RawRotation, RawTranslation, decode, encode


def delta_clip(version):
    """A four-frame looped clip whose root turns 90 degrees and moves (100, 10, 0) inches."""
    yaw90 = (23170, 23170)  # (z, w): 90 degrees about up
    return RawClip(
        frames=4,
        fps=30.0,
        looped=True,
        asset_type=2,
        bones=[RawBone("j_mainroot", None, RawTranslation(constant=(0.0, 0.0, 40.0)))],
        delta=(
            RawRotation(True, [(0, 32767), yaw90], [0, 4]),
            RawTranslation(None, False, (0.0, 0.0, 0.0), (FULL_TRANS_SCALE * 100,) * 3, [(0, 0, 0), (65535, 6553, 0)], [0, 4]),
        ),
        version=version,
    )


@pytest.mark.parametrize("version", [19, None])
def test_decode_keeps_the_root_motion_it_used_to_step_over(version):
    # T5's version 19 and IW's 17: both carry a 2D delta, a yaw and a translation.
    anim = decode(encode(delta_clip(version)), "walk")
    assert anim.has_root_motion
    assert anim.delta_translation.indices == [0, 4]
    assert anim.delta_translation.values[-1][:2] == pytest.approx([100.0, 10.0], rel=1e-4)
    z, w = anim.delta_rotation.values[-1][2:]
    assert math.degrees(2 * math.atan2(z, w)) == pytest.approx(90.0, abs=0.01)
    # The bone tracks after it still line up.
    assert anim.bones[0].translation.values == [[0.0, 0.0, 40.0]]


def test_a_clip_with_no_delta_has_no_root_motion():
    clip = delta_clip(19)
    clip.delta = None
    anim = decode(encode(clip), "idle")
    assert not anim.has_root_motion
    assert anim.delta_rotation is None and anim.delta_translation is None
