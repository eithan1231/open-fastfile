"""`xanim`: `xanim/<name>`, each clip as the compiled xanim OpenAssetTools writes (scripts/cod/xanim.py).

IW5's XAnimParts is the one IW6 kept, so the bone tracks come out of the same flat
pools by scripts/cod/iw6/dumpers/xanim.py's reader; only where each pool and the
delta part are found differs. A clip whose pools are not used up exactly is
refused rather than written, as there: a misread field still decodes into
smooth, plausible motion.
"""

import struct
from collections import Counter

from ...iw6.dumpers.common import asset_path
from ...iw6.dumpers.xanim import LOOPED, Pool, bone_tracks, pairs
from ...xanim import RawClip, RawRotation, RawTranslation, encode
from . import dumper


def values(array, code):
    return [v for (v,) in array.unpack(f"<{code}")] if array is not None else []


def delta_part(delta, byte_indices):
    """(RawRotation or None, RawTranslation or None) of the clip's root motion."""
    index = "u.frames.indices._1" if byte_indices else "u.frames.indices._2"
    code = "B" if byte_indices else "H"
    rotation = None
    # IW4/IW5 have a 2D `quat2` and a 3D `quat`; T5's one `quat` is 2D (it has no 3D delta).
    tracks = (("quat2", 2), ("quat", 4)) if "quat2" in delta else (("quat", 2),)
    for key, width in tracks:
        track = delta[key]
        if track is None or rotation is not None:
            continue
        if track["size"]:
            frames = pairs([v for q in track["u.frames.frames"].unpack(f"<{width}h") for v in q], width)
            rotation = RawRotation(width == 2, frames, values(track[index], code))
        else:
            rotation = RawRotation(width == 2, [struct.unpack(f"<{width}h", bytes(track.bytes("u.frame0")[: 2 * width]))])
    translation = None
    track = delta["trans"]
    if track is not None:
        if track["size"]:
            small = bool(track["smallTrans"])
            mins = struct.unpack("<3f", bytes(track.bytes("u.frames.mins")[:12]))
            size = struct.unpack("<3f", bytes(track.bytes("u.frames.size")[:12]))
            vec = track["u.frames.frames._1" if small else "u.frames.frames._2"]
            frames = pairs(values(vec, "B" if small else "H") if vec is not None else [], 3)
            translation = RawTranslation(None, small, mins, size, frames, values(track[index], code))
        else:
            translation = RawTranslation(constant=struct.unpack("<3f", bytes(track.bytes("u.frame0")[:12])))
    return rotation, translation


def raw_clip(walk, parts):
    """The RawClip of one XAnimParts record."""
    frames = parts["numframes"]
    byte_indices = frames < 256
    counts = list(parts["boneCount"])
    names = [walk.script_string(i) for i in values(parts["names"], "H")]
    pools = {
        "byte": Pool("dataByte", values(parts["dataByte"], "B")),
        "short": Pool("dataShort", values(parts["dataShort"], "h")),
        "int": Pool("dataInt", values(parts["dataInt"], "i")),
        "random byte": Pool("randomDataByte", values(parts["randomDataByte"], "B")),
        "random short": Pool("randomDataShort", values(parts["randomDataShort"], "h")),
        "indices": Pool("indices", [] if byte_indices else values(parts["indices._2"], "H")),
    }
    notifies = (
        [(walk.script_string(name), time) for name, time in parts["notify"].unpack("<Hxxf")]
        if parts["notify"] is not None
        else []
    )
    delta = parts["deltaPart"]
    clip = RawClip(
        frames,
        parts["framerate"],
        bool(parts["bLoop"]) if "bLoop" in parts else bool(parts["flags"] & LOOPED),
        parts["assetType"],
        bone_tracks(names, counts, pools, byte_indices),
        notifies,
        delta_part(delta, byte_indices) if delta is not None else None,
    )
    if walk.game == "t5":  # version 19, with T5's own flags (OAT's XAnimDumper)
        clip.version = 19
        clip.left_hand_grip_ik = bool(parts["bLeftHandGripIK"])
        clip.streamable = bool(parts["bStreamable"])
        clip.primed_length = parts["primedLength"]
    return clip


@dumper("xanim")
def write(walk, out, ctx=None):
    found = walk.by_type("xanim")
    written, refused = 0, Counter()
    for asset in found:
        if asset.name.startswith(","):
            refused["other zones' stubs"] += 1
            continue
        try:
            blob = encode(raw_clip(walk, asset.record))
        except (ValueError, IndexError, struct.error) as exc:
            refused[f"{asset.name}: {exc}"] += 1
            continue
        with open(asset_path(out, f"xanim/{asset.name}"), "wb") as fh:
            fh.write(blob)
        written += 1
    detail = "; ".join(f"{n} {reason}" if n > 1 else reason for reason, n in refused.most_common(4))
    print(f"      {written} of {len(found)} clips written" + (f" (not written: {detail})" if detail else ""))
