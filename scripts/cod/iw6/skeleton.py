"""An IW6 XModel's skeleton and its surfaces' vertex weights, from the zone's bytes.

Pure decoding, no zone walk: every function takes the bytes and offsets a walk
recorded (records.Model, records.Surface). How each layout was established:
reverse/iw6-zone/README.md#skeletons-and-skinning.

- **Bones.** `boneNames` are script-string indices (u32). Bone i >= numRootBones
  has its parent `parentList[i - roots]` bones back, a local rotation
  `tagAngles` (four int16 over 32767, x y z w) and a local translation
  `tagPositions`, both in the parent's frame. `baseMat` is the model-space pose
  those compose to, which is what OpenAssetTools' GLB takes.
- **Rigid surfaces.** `XRigidVertList`s cover the vertices in order; each list's
  `boneOffset` is the bone index times 64 (the size of a DObjSkelMat).
- **Skinned surfaces.** `blendVertCounts[k]` vertices take k + 1 bones. Each is
  a u16 stream entry: bone 0, then (bone, weight) pairs, bones times 64 and
  weights over 65535; bone 0 takes what the others leave. `blendVertsTable`
  repeats the same per vertex (eight bones, seven weights, the bone count),
  which `check_blend_table` holds the stream to.
"""

import struct

from ..xmodel_glb import Bone

QUAT_SCALE = 32767.0
SKEL_MAT = 64  # sizeof(DObjSkelMat): the unit of a bone offset
WEIGHT_SCALE = 65535.0
MAX_BONES = 8  # blendVertCounts has one count per bone count, 1..8
TABLE = struct.Struct("<16H")  # BlendVertsUnknown: bones[8], weights[7], bone count


def bone_names(data, at, count, script_strings):
    names = struct.unpack_from(f"<{count}I", data, at) if at is not None and count else ()
    return [script_strings[i] if i < len(script_strings) else f"INVALID_BONE_NAME_{i}" for i in names]


def local_rotation(packed):
    """An XModelAngle (x, y, z, w as int16) as a float quaternion."""
    return tuple(v / QUAT_SCALE for v in packed)


def skeleton(data, model, script_strings):
    """[xmodel_glb.Bone] for a records.Model, in model space, CoD frame."""
    count, roots = model.bone_count, model.root_bone_count
    if not count or model.base_mat is None:
        return []
    names = bone_names(data, model.bone_names, count, script_strings)
    parents = struct.unpack_from(f"<{count - roots}B", data, model.parents) if model.parents is not None else ()
    out = []
    for i in range(count):
        quat = struct.unpack_from("<4f", data, model.base_mat + 32 * i)
        trans = struct.unpack_from("<3f", data, model.base_mat + 32 * i + 16)
        parent = i - parents[i - roots] if i >= roots and parents else None
        out.append(Bone(names[i], parent, trans, quat))
    return out


def local_poses(data, model):
    """[(rotation, translation)] of each non-root bone in its parent's frame (tagAngles, tagPositions)."""
    children = model.bone_count - model.root_bone_count
    if not children or model.tag_angles is None:
        return []
    return [
        (
            local_rotation(struct.unpack_from("<4h", data, model.tag_angles + 8 * i)),
            struct.unpack_from("<3f", data, model.tag_positions + 12 * i) if model.tag_positions is not None else (0.0, 0.0, 0.0),
        )
        for i in range(children)
    ]


def rigid_weights(data, at, list_count):
    """[(bone, vertex count)] of a surface's XRigidVertLists, in vertex order."""
    lists = []
    for k in range(list_count):
        bone_offset, vertex_count, _, _ = struct.unpack_from("<4H", data, at + 16 * k)
        lists.append((bone_offset // SKEL_MAT, vertex_count))
    return lists


def blend_weights(data, at, counts):
    """[[(bone, weight)]] per blended vertex, in vertex order; the weights sum to 1."""
    out = []
    for extra, count in enumerate(counts):
        size = 1 + 2 * extra
        for _ in range(count):
            values = struct.unpack_from(f"<{size}H", data, at)
            at += 2 * size
            others = [(values[1 + 2 * k] // SKEL_MAT, values[2 + 2 * k] / WEIGHT_SCALE) for k in range(extra)]
            out.append([(values[0] // SKEL_MAT, 1.0 - sum(w for _, w in others)), *others])
    return out


def check_blend_table(data, at, weights):
    """How many blended vertices disagree with their `blendVertsTable` row (0 when the stream reads right)."""
    bad = 0
    for v, influences in enumerate(weights):
        row = TABLE.unpack_from(data, at + TABLE.size * v)
        bones = [b for b, _ in influences]
        stored = [round(w * WEIGHT_SCALE) for _, w in influences[1:]]
        n = len(influences)
        expected = (*bones, *[0] * (MAX_BONES - n), *stored, *[0] * (MAX_BONES - 1 - len(stored)), n)
        bad += row != expected
    return bad


def strongest(influences, limit=4):
    """The `limit` heaviest influences, renormalised to sum to 1 (glTF's JOINTS_0 holds four)."""
    if len(influences) <= limit:
        return influences
    kept = sorted(influences, key=lambda bw: -bw[1])[:limit]
    total = sum(w for _, w in kept) or 1.0
    return [(b, w / total) for b, w in kept]
