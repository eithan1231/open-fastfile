"""OpenAssetTools' compiled xanim files (`xanim/<name>`, no extension): decoding and writing.

`decode` is a port of OAT's `CompiledXAnimLoader.cpp`; `encode` of its
`CompiledXAnimWriter.cpp`, for a backend that writes the files itself
(scripts/cod/iw6). What the decoded values mean (which bone space, what replaces
and what adds to the bind pose) is in docs/cod/reference.md#animations.
"""

import math
import struct
from dataclasses import dataclass, field

# The linker's own float literals for 1/255 and 1/65535.
SMALL_TRANS_SCALE = 0.003921568859368563
FULL_TRANS_SCALE = 0.00001525902189314365
QUAT_SCALE = 32767.0

# Version 17: IW3/T4, and what OAT writes for IW4/IW5 clips without a 3D delta.
# 18: IW4/IW5 with one. 19: T5/T6, whose flags differ.
VERSIONS = (17, 18, 19)
T6_COMPATIBILITY = 0x80


@dataclass
class Track:
    """Keyframes at frame `indices`; `values` are xyzw quaternions or xyz inches."""

    indices: list
    values: list


@dataclass
class BoneTrack:
    name: str
    rotation: Track | None  # local rotation, replacing the bind pose
    translation: Track | None  # offset added to the bind pose's local translation


@dataclass
class XAnim:
    name: str
    frames: int  # a looped clip stores frames + 1 keys, the last repeating the first
    fps: float
    looped: bool
    bones: list = field(default_factory=list)
    has_root_motion: bool = False  # a non-empty delta track; placed props never apply it
    # The delta track itself: where the model's origin is, frame by frame, in its
    # own frame at the clip's start (x forward, y left, z up; inches). T5's rotation
    # is a yaw only, a (0, 0, z, w) quaternion. None where the clip has none.
    delta_rotation: Track | None = None
    delta_translation: Track | None = None
    # The header's asset type decides what a translation key means (animations.TRANSLATION_BY_ASSET_TYPE).
    # 2 is what every animated prop measured uses.
    asset_type: int = 2
    notetracks: list = field(default_factory=list)  # (name, frame): sound, rumble and event cues

    @property
    def duration(self):
        return self.frames / self.fps if self.fps else 0.0


class _Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def take(self, fmt):
        values = struct.unpack_from("<" + fmt, self.data, self.pos)
        self.pos += struct.calcsize("<" + fmt)
        return values

    def one(self, fmt):
        return self.take(fmt)[0]

    def raw(self, n):
        out = self.data[self.pos : self.pos + n]
        self.pos += n
        return out

    def cstr(self):
        end = self.data.index(0, self.pos)
        s = self.data[self.pos : end].decode("latin-1")
        self.pos = end + 1
        return s


def _w(squared):
    """The dropped quaternion component, rebuilt the way the game does (integer domain, rounded)."""
    t = 0x3FFF0001 - squared
    return 0 if t <= 0 else int(math.floor(math.sqrt(float(t)) + 0.5))


def _quat(r):
    x, y, z = r.take("3h")
    return [x, y, z, _w(x * x + y * y + z * z)]


def _quat2(r):
    """A rotation about local Z only: (z, w)."""
    z = r.one("h")
    return [z, _w(z * z)]


def _indices(r, count, byte_indices, loop_frames):
    # Omitted when the track has a key on every frame.
    if count >= loop_frames:
        return list(range(count))
    return list(r.take(f"{count}B" if byte_indices else f"{count}H"))


def _continuous(frames, flip_first):
    """Negate keys as needed so neighbours lie in one hemisphere (and the first as the file says)."""
    out = []
    for i, q in enumerate(frames):
        if (i == 0 and flip_first) or (i > 0 and sum(a * b for a, b in zip(out[-1], q, strict=True)) < 0):
            q = [-v for v in q]
        out.append(q)
    return out


def _as_float(q, half):
    if half:
        return [0.0, 0.0, q[0] / QUAT_SCALE, q[1] / QUAT_SCALE]
    return [v / QUAT_SCALE for v in q]


def _rotation(r, loop_frames, byte_indices, flip, half):
    count = r.one("H")
    if count == 0:
        return None
    read = _quat2 if half else _quat
    if count == 1:
        return Track([0], [_as_float(q, half) for q in _continuous([read(r)], flip)])
    indices = _indices(r, count, byte_indices, loop_frames)
    frames = _continuous([read(r) for _ in range(count)], flip)
    return Track(indices, [_as_float(q, half) for q in frames])


def _translation(r, loop_frames, byte_indices):
    count = r.one("H")
    if count == 0:
        return None
    if count == 1:
        return Track([0], [list(r.take("3f"))])
    indices = _indices(r, count, byte_indices, loop_frames)
    small = r.one("B") != 0
    mins = r.take("3f")
    size = [v * (SMALL_TRANS_SCALE if small else FULL_TRANS_SCALE) for v in r.take("3f")]
    raw = [r.take("3B") for _ in range(count)] if small else [r.take("3H") for _ in range(count)]
    return Track(indices, [[mins[k] + size[k] * q[k] for k in range(3)] for q in raw])


def _flags(version, flags):
    """(looped, delta, delta3d, streamable) for this file version."""
    if version == 19:
        t6 = bool(flags & T6_COMPATIBILITY)
        return bool(flags & 1), bool(flags & 2), t6 and bool(flags & 4), not t6 and bool(flags & 8)
    return bool(flags & 1), bool(flags & 2), version == 18 and bool(flags & 4), False


def _read_delta(r, delta3d, loop_frames, byte_indices):
    """The root-motion track: (rotation Track or None, translation Track or None)."""
    rotation = None
    count = r.one("H")
    read = _quat if delta3d else _quat2
    if count == 1:
        rotation = Track([0], [_as_float(q, not delta3d) for q in _continuous([read(r)], False)])
    elif count > 1:
        indices = _indices(r, count, byte_indices, loop_frames)
        frames = _continuous([read(r) for _ in range(count)], False)
        rotation = Track(indices, [_as_float(q, not delta3d) for q in frames])
    return rotation, _translation(r, loop_frames, byte_indices)


def _skip_delta(r, delta3d, loop_frames, byte_indices):
    """Read past the root-motion track; return whether it held any motion."""
    rotation, translation = _read_delta(r, delta3d, loop_frames, byte_indices)
    return rotation is not None or translation is not None


def decode(data, name=""):
    """One compiled xanim file's bytes -> XAnim. Raises ValueError on anything it cannot read to the end."""
    r = _Reader(data)
    try:
        version = r.one("H")
        if version not in VERSIONS:
            raise ValueError(f"xanim version {version} is not one of {VERSIONS}")
        frames, bone_count, flags, asset_type, fps = r.take("HHBBH")
        looped, delta, delta3d, streamable = _flags(version, flags)
        loop_frames = frames + 1 if looped else frames
        byte_indices = (loop_frames - 1) < 256
        if streamable:
            r.one("f")  # primed length
        anim = XAnim(name, loop_frames - 1, float(fps), looped, asset_type=asset_type)
        if delta or delta3d:
            anim.delta_rotation, anim.delta_translation = _read_delta(r, delta3d, loop_frames, byte_indices)
            anim.has_root_motion = anim.delta_rotation is not None or anim.delta_translation is not None
        if bone_count:
            mask = (bone_count + 7) // 8
            flip_bits, half_bits = r.raw(mask), r.raw(mask)
            names = [r.cstr() for _ in range(bone_count)]
            for i, bone in enumerate(names):
                flip = bool(flip_bits[i // 8] & (1 << (i % 8)))
                half = bool(half_bits[i // 8] & (1 << (i % 8)))
                rotation = _rotation(r, loop_frames, byte_indices, flip, half)
                anim.bones.append(BoneTrack(bone, rotation, _translation(r, loop_frames, byte_indices)))
        for _ in range(r.one("B")):  # the frame each cue fires on; OAT divides by the frame count
            anim.notetracks.append((r.cstr(), r.one("H")))
    except (struct.error, IndexError) as exc:
        raise ValueError(f"xanim {name or '?'} is truncated") from exc
    if r.pos != len(data):
        raise ValueError(f"xanim {name or '?'}: {len(data) - r.pos} trailing bytes; the layout was misread")
    return anim


# -- Writing ---------------------------------------------------------------------------
# The stored form, as OAT's XAnimCommon holds it: quaternion keys as int16 tuples
# (x, y, z, w, or z, w for a rotation about Z) and translation keys as raw bytes or
# u16s over `mins` and a `size` already scaled.


@dataclass
class RawRotation:
    half: bool  # (z, w) keys rather than (x, y, z, w)
    frames: list  # int16 tuples; one frame and no indices is a constant
    indices: list = field(default_factory=list)


@dataclass
class RawTranslation:
    constant: tuple | None = None  # one xyz, in inches
    small: bool = False  # byte keys rather than u16
    mins: tuple = (0.0, 0.0, 0.0)
    size: tuple = (0.0, 0.0, 0.0)  # per unit of a key
    frames: list = field(default_factory=list)  # integer xyz tuples
    indices: list = field(default_factory=list)


@dataclass
class RawBone:
    name: str
    rotation: RawRotation | None  # None: no rotation track
    translation: RawTranslation | None


@dataclass
class RawClip:
    frames: int  # XAnimParts.numframes
    fps: float
    looped: bool
    asset_type: int
    bones: list = field(default_factory=list)
    notifies: list = field(default_factory=list)  # (name, time 0..1)
    delta: tuple | None = None  # (RawRotation or None, RawTranslation or None) when the clip has a delta part
    version: int | None = None  # 19 for T5; otherwise 18 or 17, by whether the delta rotates in 3D
    left_hand_grip_ik: bool = False  # T5 only, like the two below
    streamable: bool = False
    primed_length: float = 0.0


def _lround(value):
    """C's lround: halves away from zero (Python's round() takes them to even)."""
    return int(math.copysign(math.floor(abs(value) + 0.5), value))


class _Writer:
    def __init__(self):
        self.out = bytearray()

    def put(self, fmt, *values):
        self.out += struct.pack("<" + fmt, *values)


def _encode_quats(frames, allow_flip):
    """(flip bit, the stored components): the last one is dropped and rebuilt by the loader
    as positive, so frames are negated to match, keeping neighbours continuous (EncodeQuatFrames)."""
    if not frames:
        return False, []
    flip = allow_flip and frames[0][-1] < 0
    stored = []
    for i, frame in enumerate(frames):
        continuity = False
        if i and (frame[-1] < 0) != flip:
            continuity = sum(a * b for a, b in zip(frames[i - 1], frame, strict=True)) > 0
        sign = -1 if flip != continuity else 1
        stored.extend(v * sign for v in frame[:-1])
    return flip, stored


def _put_indices(w, indices, loop_frames, byte_indices):
    if not indices or len(indices) >= loop_frames:
        return  # a track keyed on every frame omits them
    w.put(f"{len(indices)}{'B' if byte_indices else 'H'}", *indices)


def _put_translation(w, track, loop_frames, byte_indices):
    if track is None:
        w.put("H", 0)
    elif track.constant is not None:
        w.put("H3f", 1, *track.constant)
    else:
        w.put("H", len(track.frames))
        _put_indices(w, track.indices, loop_frames, byte_indices)
        scale = SMALL_TRANS_SCALE if track.small else FULL_TRANS_SCALE
        w.put("B3f3f", int(track.small), *track.mins, *(v / scale for v in track.size))
        w.put(f"{3 * len(track.frames)}{'B' if track.small else 'H'}", *(v for f in track.frames for v in f))


def _put_rotation(w, track, stored, loop_frames, byte_indices):
    if track is None:
        w.put("H", 0)
        return
    w.put("H", len(track.frames))
    if len(track.frames) > 1 or track.indices:
        _put_indices(w, track.indices, loop_frames, byte_indices)
    w.put(f"{len(stored)}h", *stored)


def _flags_19(clip, delta3d):
    """Version 19's flags (OAT GetFlagsForVersion): T5's, unless a 3D delta asks for T6's layout."""
    t6 = delta3d
    flags = (T6_COMPATIBILITY if t6 else 0) | (1 if clip.looped else 0)
    if clip.delta:
        flags |= 4 if delta3d else 2
    if clip.left_hand_grip_ik:
        flags |= 8 if t6 else 4
    if clip.streamable and not t6:
        flags |= 8
    return flags


def encode(clip: RawClip):
    """A RawClip as the bytes of a compiled xanim: `clip.version` when set (19, T5), else
    version 18 when its root motion rotates in 3D, else 17."""
    loop_frames = clip.frames + 1
    byte_indices = clip.frames < 256
    delta_rotation, delta_translation = clip.delta or (None, None)
    delta3d = bool(delta_rotation and not delta_rotation.half)
    if clip.version == 19:
        version, flags = 19, _flags_19(clip, delta3d)
    else:
        version = 18 if delta3d else 17
        flags = (1 if clip.looped else 0) | ((4 if delta3d else 2) if clip.delta else 0)
    w = _Writer()
    w.put(
        "HHHBBH",
        version,
        clip.frames if clip.looped else loop_frames,
        len(clip.bones),
        flags,
        clip.asset_type,
        _lround(clip.fps),
    )
    if version == 19 and clip.streamable and not flags & T6_COMPATIBILITY:
        w.put("f", clip.primed_length)
    if clip.delta:
        if delta_rotation is None:
            w.put("H", 0)
        else:
            _, stored = _encode_quats(delta_rotation.frames, False)
            _put_rotation(w, delta_rotation, stored, loop_frames, byte_indices)
        _put_translation(w, delta_translation, loop_frames, byte_indices)
    if clip.bones:
        encoded = [_encode_quats(b.rotation.frames, True) if b.rotation else (False, []) for b in clip.bones]
        mask = (len(clip.bones) + 7) // 8
        flip, half = bytearray(mask), bytearray(mask)
        for i, bone in enumerate(clip.bones):
            if encoded[i][0]:
                flip[i // 8] |= 1 << (i % 8)
            if bone.rotation is None or bone.rotation.half:
                half[i // 8] |= 1 << (i % 8)
        w.out += flip + half
        for bone in clip.bones:
            w.out += bone.name.encode("latin-1") + b"\0"
        for bone, (_, stored) in zip(clip.bones, encoded, strict=True):
            _put_rotation(w, bone.rotation, stored, loop_frames, byte_indices)
            _put_translation(w, bone.translation, loop_frames, byte_indices)
    notifies = list(clip.notifies)
    if notifies and notifies[-1][0] == "end" and abs(notifies[-1][1] - 1.0) < 0.0001:
        notifies.pop()  # the linker appends it; the file does not hold it
    w.put("B", len(notifies))
    for name, time in notifies:
        w.out += name.encode("latin-1") + b"\0"
        w.put("H", _lround(time * clip.frames) if clip.frames else 0)
    return bytes(w.out)
