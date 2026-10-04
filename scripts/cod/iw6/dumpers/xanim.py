"""`xanim`: `xanim/<name>`, each clip as the compiled xanim OpenAssetTools writes (scripts/cod/xanim.py).

IW6's XAnimParts is IW5's: the tracks live in flat per-type pools (bytes,
shorts, ints, random bytes and shorts, and a u16 frame-index pool), read in a
fixed order by bone-count class. This is a port of OAT's `FlatXAnimReader.cpp`,
and like it, a clip whose pools are not used up exactly is refused rather than
written: a misread field still decodes into smooth, plausible motion.
"""

import struct
from collections import Counter

from ...xanim import RawBone, RawClip, RawRotation, RawTranslation, encode
from ..zone import Record
from . import dumper
from .common import asset_path

LOOPED = 0x1  # XAnimPartsFlags ANIM_LOOP
# boneCount[] classes, in the order the pools are read (XAnimPartType).
NO_QUAT, HALF_QUAT, FULL_QUAT, HALF_QUAT_NO_SIZE, FULL_QUAT_NO_SIZE = range(5)
SMALL_TRANS, FULL_TRANS, TRANS_NO_SIZE, NO_TRANS, ALL = range(5, 10)
POOLED_INDICES = 64  # a track of 65 keys or more keeps its u16 indices in the shared pool


class Pool:
    """One flat array, consumed front to back."""

    def __init__(self, name, values):
        self.name, self.values, self.at = name, values, 0

    def take(self, count):
        if self.at + count > len(self.values):
            raise ValueError(f"{self.name} exhausted: {count} wanted, {len(self.values) - self.at} left")
        out = self.values[self.at : self.at + count]
        self.at += count
        return out

    def one(self):
        return self.take(1)[0]

    @property
    def left(self):
        return len(self.values) - self.at


def pool(data, name, at, count, code):
    return Pool(name, list(struct.unpack_from(f"<{count}{code}", data, at)) if at is not None and count else [])


def indices(pools, stored, byte_indices):
    """ReadPackedIndices: `stored` + 1 frame numbers for one track."""
    count = stored + 1
    if byte_indices:
        return pools["byte"].take(count)
    if stored >= POOLED_INDICES:
        out = pools["indices"].take(count)
        # dataShort keeps checkpoints of the pooled list: its first entry, every 256th, and its last.
        pools["short"].take((count - 2) // 256 + 2)
        return out
    return [v & 0xFFFF for v in pools["short"].take(count)]


def as_float(bits):
    return struct.unpack("<f", struct.pack("<i", bits))[0]


def float3(pools):
    return tuple(as_float(v) for v in pools["int"].take(3))


def pairs(values, width):
    return [tuple(values[k : k + width]) for k in range(0, len(values), width)]


def bone_tracks(names, counts, pools, byte_indices):
    """[RawBone] from the flat pools (CreateBoneTracksFromFlatData)."""
    rotations = []
    rotations += [None] * counts[NO_QUAT]
    for kind, width in ((HALF_QUAT, 2), (FULL_QUAT, 4)):
        for _ in range(counts[kind]):
            stored = pools["short"].one() & 0xFFFF
            keys = indices(pools, stored, byte_indices)
            rotations.append(RawRotation(width == 2, pairs(pools["random short"].take((stored + 1) * width), width), keys))
    for kind, width in ((HALF_QUAT_NO_SIZE, 2), (FULL_QUAT_NO_SIZE, 4)):
        for _ in range(counts[kind]):
            rotations.append(RawRotation(width == 2, [tuple(pools["short"].take(width))]))

    translations = {}

    def bone():
        index = pools["byte"].one()
        if index >= len(names) or index in translations:
            raise ValueError(f"translation for bone {index} of {len(names)}, or given twice")
        return index

    for kind in (SMALL_TRANS, FULL_TRANS):
        for _ in range(counts[kind]):
            index = bone()
            stored = pools["short"].one() & 0xFFFF
            mins, size = float3(pools), float3(pools)
            keys = indices(pools, stored, byte_indices)
            if kind == SMALL_TRANS:
                frames = pairs(pools["random byte"].take(3 * (stored + 1)), 3)
            else:
                frames = pairs([v & 0xFFFF for v in pools["random short"].take(3 * (stored + 1))], 3)
            translations[index] = RawTranslation(None, kind == SMALL_TRANS, mins, size, frames, keys)
    for _ in range(counts[TRANS_NO_SIZE]):
        translations[bone()] = RawTranslation(constant=float3(pools))
    for _ in range(counts[NO_TRANS]):
        translations[bone()] = None
    if len(translations) != len(names) or len(rotations) != len(names):
        raise ValueError(f"{len(rotations)} rotations and {len(translations)} translations for {len(names)} bones")
    leftover = {name: p.left for name, p in pools.items() if p.left}
    if leftover:
        raise ValueError(f"pools not used up: {leftover}")
    return [RawBone(name, rotations[i], translations[i]) for i, name in enumerate(names)]


def delta_part(data, anim, byte_indices):
    """(RawRotation or None, RawTranslation or None) of the clip's root motion."""
    code = "B" if byte_indices else "H"
    rotation = None
    for track, width in ((anim.delta_quat2, 2), (anim.delta_quat, 4)):
        if track is None or rotation is not None:
            continue
        if track.size:
            count = track.size + 1
            keys = list(struct.unpack_from(f"<{count}{code}", data, track.indices))
            frames = pairs(struct.unpack_from(f"<{count * width}h", data, track.values), width)
            rotation = RawRotation(width == 2, frames, keys)
        else:
            rotation = RawRotation(width == 2, [struct.unpack_from(f"<{width}h", data, track.values)])
    translation = None
    track = anim.delta_trans
    if track is not None:
        if track.size:
            count = track.size + 1
            mins = struct.unpack_from("<3f", data, track.frames)
            size = struct.unpack_from("<3f", data, track.frames + 12)
            keys = list(struct.unpack_from(f"<{count}{code}", data, track.indices))
            frames = pairs(struct.unpack_from(f"<{3 * count}{'B' if track.small else 'H'}", data, track.values), 3)
            translation = RawTranslation(None, track.small, mins, size, frames, keys)
        else:
            translation = RawTranslation(constant=struct.unpack_from("<3f", data, track.values))
    return rotation, translation


def raw_clip(zone, anim):
    """The RawClip of a records.Anim."""
    parts = Record(zone, "XAnimParts", anim.at, None, None)
    data, strings = zone.data, zone.script_strings
    frames = parts["numframes"]
    byte_indices = frames < 256
    counts = [parts[f"boneCount[{k}]"] for k in range(ALL + 1)]
    names = [strings[i] for i in struct.unpack_from(f"<{counts[ALL]}I", data, anim.names)] if anim.names is not None else []
    pools = {
        "byte": pool(data, "dataByte", anim.data_byte, parts["dataByteCount"], "B"),
        "short": pool(data, "dataShort", anim.data_short, parts["dataShortCount"], "h"),
        "int": pool(data, "dataInt", anim.data_int, parts["dataIntCount"], "i"),
        "random byte": pool(data, "randomDataByte", anim.random_byte, parts["randomDataByteCount"], "B"),
        "random short": pool(data, "randomDataShort", anim.random_short, parts["randomDataShortCount"], "h"),
        "indices": pool(data, "indices", anim.indices, parts["indexCount"] if not byte_indices else 0, "H"),
    }
    notifies = []
    for k in range(parts["notifyCount"] if anim.notify is not None else 0):
        name, time = struct.unpack_from("<If", data, anim.notify + 8 * k)
        notifies.append((strings[name], time))
    has_delta = any(t is not None for t in (anim.delta_trans, anim.delta_quat2, anim.delta_quat)) or bool(parts["deltaPart"])
    return RawClip(
        frames,
        parts["framerate"],
        bool(parts["flags"] & LOOPED),
        parts["assetType"],
        bone_tracks(names, counts, pools, byte_indices),
        notifies,
        delta_part(data, anim, byte_indices) if has_delta else None,
    )


@dumper("xanim")
def write(walked, out):
    found = walked.zone.found.get("XANIMPARTS", {})
    written, refused = 0, Counter()
    for name, anim in sorted(found.items()):
        if name.startswith(","):
            refused["other zones' stubs"] += 1
            continue
        try:
            blob = encode(raw_clip(walked.zone, anim))
        except (ValueError, IndexError, struct.error) as exc:
            refused[f"{name}: {exc}"] += 1
            continue
        with open(asset_path(out, f"xanim/{name}"), "wb") as fh:
            fh.write(blob)
        written += 1
    detail = "; ".join(f"{n} {reason}" if n > 1 else reason for reason, n in refused.most_common(4))
    print(f"      {written} of {len(found)} clips written" + (f" (not written: {detail})" if detail else ""))
