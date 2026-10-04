"""`xanim`: `xanim/<name>`, each clip as the compiled xanim OpenAssetTools writes (scripts/cod/xanim.py).

S1's XAnimParts keeps IW6's flat pools in IW6's order and quantisation, so the
decode is IW6's, unchanged (scripts/cod/iw6/dumpers/xanim.py `raw_clip`). S1
also adds two `boneCount` classes, blend-shape weights, alternative clips and a
scripted-viewmodel blend; the compiled file has room for none of them, and only
the alternatives occur. The checks below are the ones that settled the decode on
every clip of both companion zones; a clip failing one is refused, not written.

The asset type is written as the zone has it, but on S1 it does not say what a
translation key means: that is the model's. reverse/s1-zone/README.md#the-animations.
"""

import math
import struct
from collections import Counter

from ...iw6.dumpers.common import asset_path
from ...iw6.dumpers.xanim import raw_clip
from ...iw6.zone import Record
from ...xanim import QUAT_SCALE, encode
from . import dumper

ROTATIONS, TRANSLATIONS, ALL = range(0, 5), range(5, 9), 9  # boneCount's classes, as IW6's
S1_CLASSES = (10, 11)  # S1's two extra classes: empty on every clip seen, and unread by IW6's pools
UNIT = 1e-3  # a stored rotation key's length off 1; every key in both zones is within 1e-4


def check_header(parts):
    """Why an XAnimParts header cannot be decoded as IW6's, or None."""
    counts = [parts[f"boneCount[{k}]"] for k in range(12)]
    if sum(counts[k] for k in ROTATIONS) != counts[ALL] or sum(counts[k] for k in TRANSLATIONS) != counts[ALL]:
        return f"boneCount {counts}: the rotation and translation classes do not each sum to the bone count"
    if any(counts[k] for k in S1_CLASSES):
        return f"boneCount {counts}: S1's classes 10 and 11 are in use, which IW6's pools do not read"
    if parts["randomDataIntCount"]:
        return "randomDataInt is in use, which IW6's pools do not read"
    if parts["blendShapeCount"]:
        return "blend-shape weights, which a compiled xanim cannot carry"
    return None


def check_clip(clip):
    """Why a decoded RawClip is not a clip: a rotation key off unit length, or key frames that
    do not run 0 to `numframes` in order. Either means a pool was read at the wrong place."""
    rotations = [b.rotation for b in clip.bones]
    translations = [b.translation for b in clip.bones]
    if clip.delta:
        rotations.append(clip.delta[0])
        translations.append(clip.delta[1])
    for track in filter(None, rotations):
        for key in track.frames:
            length = math.sqrt(sum(v * v for v in key)) / QUAT_SCALE
            if abs(length - 1) > UNIT:
                return f"a rotation key of length {length:.4f}"
    for track in filter(None, rotations + translations):
        keys = track.indices
        if keys and (keys[0] != 0 or keys[-1] != clip.frames or any(b <= a for a, b in zip(keys, keys[1:], strict=False))):
            return f"key frames {keys[:3]}..{keys[-3:]} in a clip of {clip.frames}"
    return None


def notes_off_frame(clip):
    """Notetracks whose time is not a whole frame of the clip: 0 on every clip of both zones."""
    return sum(1 for _, time in clip.notifies if abs(time * clip.frames - round(time * clip.frames)) > 2e-3)


@dumper("xanim")
def write(walked, out):
    zone = walked.zone
    found = zone.found.get("XANIMPARTS", {})
    written, refused, off_frame = 0, Counter(), 0
    for name, anim in sorted(found.items()):
        if name.startswith(","):
            refused["other zones' stubs"] += 1
            continue
        reason = check_header(Record(zone, "XAnimParts", anim.at, None, None))
        try:
            clip = None if reason else raw_clip(zone, anim)
        except (ValueError, IndexError, struct.error) as exc:
            reason = str(exc)
        reason = reason or check_clip(clip)
        if reason:
            refused[f"{name}: {reason}"] += 1
            continue
        off_frame += notes_off_frame(clip)
        with open(asset_path(out, f"xanim/{name}"), "wb") as fh:
            fh.write(encode(clip))
        written += 1
    detail = "; ".join(f"{n} {reason}" if n > 1 else reason for reason, n in refused.most_common(4))
    print(f"      {written} of {len(found)} clips written" + (f" (not written: {detail})" if detail else ""))
    if off_frame:
        print(f"      !! {off_frame} notetracks fall between frames: numframes may be misread")
