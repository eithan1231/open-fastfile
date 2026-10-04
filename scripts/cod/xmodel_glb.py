"""An XModel LOD as OpenAssetTools' `--model-format GLB` writes it, from plain data.

For a backend that reads a game OpenAssetTools cannot (scripts/cod/iw6). The
layout follows OAT's `XModel/Gltf/GltfWriter.cpp` node for node, because
pack.py, animations.py, characters.py and viewmodel.py rely on it:

- bone nodes first, each holding its local transform; a root bone carries the
  Z-up -> Y-up rotation, every other bone stays in CoD's frame
  (docs/cod/reference.md#xmodels);
- then one node `surf<i>` per surface, each with a mesh of one primitive;
- then, unless the model is one unskinned surface, a `<name>_skel` root over
  the surface nodes and the root bones;
- one vertex buffer every primitive shares, indexed per surface; COLOR_0 only
  when some vertex is not white; a skin only when there are bones;
- u16 indices, or u32 for a LOD of more than 65,535 vertices (OAT has no such case);
- positions in inches, Y-up; triangles reversed; images as `../images/<name>.dds`.
"""

import math
from dataclasses import dataclass, field

from .gltf import ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, pack, write_glb

GENERATOR = "scripts/cod (OpenAssetTools GLB layout)"
WHITE = (1.0, 1.0, 1.0, 1.0)
MAX_INFLUENCES = 4  # JOINTS_0 / WEIGHTS_0 hold four
# The most vertices u16 indices address: 65,535 is glTF's primitive restart value,
# so a LOD with more takes u32 (5125). Only then, so every smaller LOD keeps OAT's bytes.
U16_VERTICES = 65535


@dataclass
class Bone:
    name: str
    parent: int | None  # index of an earlier bone; None for a root
    offset: tuple  # model-space position (CoD frame, inches)
    rotation: tuple  # model-space rotation, (x, y, z, w)


@dataclass
class ModelMaterial:
    name: str
    colour_map: str | None = None
    normal_map: str | None = None


@dataclass
class Surface:
    material: int  # index into ModelLodData.materials
    first_vertex: int  # where this surface's vertices start in the shared buffer
    triangles: list  # (a, b, c) indices local to the surface


@dataclass
class ModelLodData:
    """What OAT's XModelCommon holds for one LOD. Vertex lists run in parallel."""

    name: str  # "<model>_lod<N>"
    materials: list[ModelMaterial] = field(default_factory=list)
    surfaces: list[Surface] = field(default_factory=list)
    positions: list = field(default_factory=list)  # (x, y, z), CoD frame
    normals: list = field(default_factory=list)
    uvs: list = field(default_factory=list)
    colours: list = field(default_factory=list)  # (r, g, b, a) in 0..1
    bones: list[Bone] = field(default_factory=list)
    # Per vertex, [(bone, weight)] with at most four entries; None writes no weights.
    weights: list | None = None
    # Bone rotations as the zone stores them, not quite unit length, turned into
    # transforms with the unit-quaternion formulas, as OAT does for IW4/IW5
    # (docs/cod/reference.md#xmodels). False: each is normalised first.
    stored_rotations: bool = False


def to_gltf(v):
    """CoD's Z-up left-handed axes to glTF's (OAT LhcToRhcCoordinates)."""
    return (v[0], v[2], -v[1])


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def qnormalize(q):
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return tuple(c / n for c in q)


def qinverse(q):
    n = sum(c * c for c in q) or 1.0
    return (-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n)


def qrotate(q, v):
    x, y, z, _ = qmul(qmul(q, (v[0], v[1], v[2], 0.0)), qinverse(q))
    return (x, y, z)


# OAT LhcToRhcQuaternion: a -90 degree turn about X, applied before the rotation.
Z_UP_TO_Y_UP = (-math.sin(math.pi / 4), 0.0, 0.0, math.cos(math.pi / 4))


def to_gltf_rotation(q):
    return qmul(Z_UP_TO_Y_UP, q)


def unit_rotate(q, v):
    """`v` turned by `q` with the formula that assumes |q| = 1 (Eigen's `q * v`)."""
    x, y, z, w = q
    uv = (2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0]))
    return (
        v[0] + w * uv[0] + y * uv[2] - z * uv[1],
        v[1] + w * uv[1] + z * uv[0] - x * uv[2],
        v[2] + w * uv[2] + x * uv[1] - y * uv[0],
    )


def local_transform(bones, index, stored=False):
    """(translation, rotation) of a bone node, relative to its parent's node (CreateSkeletonNodes)."""
    bone = bones[index]
    translation = to_gltf(bone.offset)
    rotation = to_gltf_rotation(bone.rotation)
    if bone.parent is not None:
        parent = bones[bone.parent]
        inverse = qinverse(to_gltf_rotation(parent.rotation))
        delta = tuple(t - p for t, p in zip(translation, to_gltf(parent.offset), strict=True))
        translation = unit_rotate(inverse, delta) if stored else qrotate(inverse, delta)
        rotation = qmul(inverse, rotation)
    return translation, qnormalize(rotation)


def inverse_3x3(m):
    (a, b, c), (d, e, f), (g, h, i) = m
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    return [
        [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ]


def inverse_bind_matrix(bone, stored=False):
    """Column-major inverse of C . T(offset) . R(rotation), C the axis change (OAT FillBufferData).

    `stored`: R from the rotation as stored, with the unit-quaternion formula, and
    inverted as the general matrix that makes it; otherwise R is a true rotation."""
    x, y, z, w = bone.rotation if stored else qnormalize(bone.rotation)
    r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    rows = [r[0], r[2], [-v for v in r[1]]]  # C . R: rows (x, z, -y)
    t = to_gltf(bone.offset)
    if stored:
        inv = inverse_3x3(rows)
        inv_t = [-sum(inv[i][j] * t[j] for j in range(3)) for i in range(3)]
        columns = [[inv[i][j] for i in range(3)] for j in range(3)]
        return [*columns[0], 0.0, *columns[1], 0.0, *columns[2], 0.0, *inv_t, 1.0]
    # The inverse of [M | t] with M a rotation is [M^T | -M^T t].
    inv_t = [-sum(rows[j][i] * t[j] for j in range(3)) for i in range(3)]
    return [*rows[0], 0.0, *rows[1], 0.0, *rows[2], 0.0, *inv_t, 1.0]


def build(lod: ModelLodData):
    """(gltf dict, buffer bytearray) laid out as OAT lays them out."""
    gltf = {"asset": {"version": "2.0", "generator": GENERATOR}, "scene": 0, "nodes": []}
    nodes = gltf["nodes"]
    has_bones = bool(lod.bones)

    root_bones = [i for i, b in enumerate(lod.bones) if b.parent is None]
    for i, _ in enumerate(lod.bones):
        translation, rotation = local_transform(lod.bones, i, lod.stored_rotations)
        node = {"name": lod.bones[i].name, "translation": list(translation), "rotation": list(rotation)}
        children = [c for c, b in enumerate(lod.bones) if b.parent == i]
        if children:
            node["children"] = children
        nodes.append(node)

    first_mesh = len(nodes)
    for i, _ in enumerate(lod.surfaces):
        node = {"name": f"surf{i}", "mesh": i}
        if has_bones:
            node["skin"] = 0
        nodes.append(node)
    root = first_mesh
    if has_bones or len(lod.surfaces) > 1:
        root = len(nodes)
        nodes.append({"name": f"{lod.name}_skel", "children": [first_mesh + i for i in range(len(lod.surfaces))] + root_bones})
    gltf["scenes"] = [{"nodes": [root]}]

    images, textures = [], []

    def texture(image):
        uri = f"../images/{image}.dds"
        for index, tex in enumerate(textures):
            if images[tex["source"]]["uri"] == uri:
                return index
        images.append({"uri": uri})
        textures.append({"source": len(images) - 1})
        return len(textures) - 1

    materials = []
    for m in lod.materials:
        entry = {"name": m.name}
        if m.colour_map:
            entry["pbrMetallicRoughness"] = {"baseColorTexture": {"index": texture(m.colour_map)}, "metallicFactor": 0.0}
        if m.normal_map:
            entry["normalTexture"] = {"index": texture(m.normal_map)}
        entry["doubleSided"] = True
        materials.append(entry)
    gltf["materials"] = materials

    count = len(lod.positions)
    coloured = any(tuple(c) != WHITE for c in lod.colours)
    skinned = has_bones and lod.weights is not None
    buf, views, accessors = bytearray(), [], []

    def view(payload, target=None, stride=None):
        entry = {"buffer": 0, "byteLength": len(payload), "byteOffset": len(buf)}
        if stride:
            entry["byteStride"] = stride
        if target:
            entry["target"] = target
        buf.extend(payload)
        views.append(entry)
        return len(views) - 1

    positions = [to_gltf(p) for p in lod.positions]
    interleaved = [c for p, n, uv in zip(positions, lod.normals, lod.uvs, strict=True) for c in (*p, *to_gltf(n), uv[0], uv[1])]
    vertex_view = view(pack("f", interleaved), ARRAY_BUFFER, 32)
    position = {"bufferView": vertex_view, "byteOffset": 0, "componentType": 5126, "count": count, "type": "VEC3"}
    if positions:
        position["min"] = [min(p[i] for p in positions) for i in range(3)]
        position["max"] = [max(p[i] for p in positions) for i in range(3)]
    accessors.append(position)
    accessors.append({"bufferView": vertex_view, "byteOffset": 12, "componentType": 5126, "count": count, "type": "VEC3"})
    attributes = {"POSITION": 0, "NORMAL": 1}
    if coloured:
        colour_view = view(pack("f", [c for rgba in lod.colours for c in rgba]), ARRAY_BUFFER)
        accessors.append({"bufferView": colour_view, "componentType": 5126, "count": count, "type": "VEC4"})
        attributes["COLOR_0"] = len(accessors) - 1
    accessors.append({"bufferView": vertex_view, "byteOffset": 24, "componentType": 5126, "count": count, "type": "VEC2"})
    attributes["TEXCOORD_0"] = len(accessors) - 1

    if skinned:
        joints, weights = [], []
        for influences in lod.weights:
            padded = list(influences[:MAX_INFLUENCES]) + [(0, 0.0)] * (MAX_INFLUENCES - len(influences))
            joints.extend(b for b, _ in padded)
            weights.extend(w for _, w in padded)
        joints_view = view(pack("B", joints), ARRAY_BUFFER)
        weights_view = view(pack("f", weights), ARRAY_BUFFER)
        bind_view = view(pack("f", [v for b in lod.bones for v in inverse_bind_matrix(b, lod.stored_rotations)]))
        accessors.append({"bufferView": joints_view, "componentType": 5121, "count": count, "type": "VEC4"})
        attributes["JOINTS_0"] = len(accessors) - 1
        accessors.append({"bufferView": weights_view, "componentType": 5126, "count": count, "type": "VEC4"})
        attributes["WEIGHTS_0"] = len(accessors) - 1
        accessors.append({"bufferView": bind_view, "componentType": 5126, "count": len(lod.bones), "type": "MAT4"})
        bind_accessor = len(accessors) - 1

    meshes = []
    first_index = len(accessors)
    wide = count > U16_VERTICES
    typecode, component = ("I", 5125) if wide else ("H", 5123)
    # Every view before the indices is a multiple of four bytes long, as u32 needs.
    assert not wide or len(buf) % 4 == 0, len(buf)
    for i, surface in enumerate(lod.surfaces):
        base = surface.first_vertex
        # Reversed, as OAT's LhcToRhcIndices reverses them.
        flat = [base + v for a, b, c in surface.triangles for v in (c, b, a)]
        index_view = view(pack(typecode, flat), ELEMENT_ARRAY_BUFFER)
        accessors.append({"bufferView": index_view, "componentType": component, "count": len(flat), "type": "SCALAR"})
        primitive = {"attributes": dict(attributes), "indices": first_index + i, "material": surface.material, "mode": 4}
        meshes.append({"primitives": [primitive]})
    gltf["meshes"] = meshes
    if textures:
        gltf["textures"] = textures
        gltf["images"] = images
    if has_bones:
        skin = {"skeleton": 0, "joints": list(range(len(lod.bones)))}
        if skinned:
            skin["inverseBindMatrices"] = bind_accessor
        gltf["skins"] = [skin]
    gltf["accessors"] = accessors
    gltf["bufferViews"] = views
    gltf["buffers"] = [{"byteLength": len(buf)}]
    return gltf, buf


def write(path, lod: ModelLodData):
    """Write one LOD as a GLB; returns its size in bytes."""
    gltf, buf = build(lod)
    return write_glb(path, gltf, buf)
