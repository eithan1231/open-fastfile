"""Reading and writing binary glTF (.glb), and measuring one without decoding it."""

import array
import json
import struct
import sys

from .files import read_bytes

ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

#: glTF component sizes, to check against this platform's array typecodes.
_ITEM_SIZES = {"f": 4, "I": 4, "H": 2, "B": 1}


def pack(typecode, values):
    """
    `values` as little-endian bytes for a bufferView: "f" float32, "I" uint32,
    "H" uint16, "B" uint8.

    Not `struct.pack(f"<{n}{typecode}", *values)`: that boxes every element and
    builds an n-element argument tuple beside it, which for a 400k-triangle
    collision mesh is 3.6M of each, over 100 MB.
    """
    if _ITEM_SIZES[typecode] != array.array(typecode).itemsize:
        return struct.pack(f"<{len(values)}{typecode}", *values)  # this platform's widths are not glTF's
    buf = array.array(typecode, values)
    if sys.byteorder != "little":
        buf.byteswap()
    return buf.tobytes()


def add_view(buf, views, payload, target=None):
    """Append `payload` to `buf` (4-byte aligned) as a new bufferView; return its index."""
    while len(buf) % 4:
        buf.append(0)
    off = len(buf)
    buf.extend(payload)
    view = {"buffer": 0, "byteOffset": off, "byteLength": len(payload)}
    if target is not None:
        view["target"] = target
    views.append(view)
    return len(views) - 1


def read_glb(path):
    """(gltf dict, BIN chunk as a bytearray)."""
    data = read_bytes(path)
    if data[:4] != b"glTF":
        raise ValueError(f"{path} is not a GLB")
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20 : 20 + json_len])
    rest = data[20 + json_len :]
    bin_len, tag = struct.unpack("<I4s", rest[:8])
    if tag != b"BIN\0":
        raise ValueError(f"{path}: expected a BIN chunk, found {tag!r}")
    return gltf, bytearray(rest[8 : 8 + bin_len])


def write_glb(path, gltf, buf):
    """Write `gltf` + `buf` as one .glb; return its size in bytes."""
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bn = bytes(buf) + b"\0" * (-len(buf) % 4)
    out = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(bn))
    out += struct.pack("<I", len(js)) + b"JSON" + js
    out += struct.pack("<I", len(bn)) + b"BIN\0" + bn
    with open(path, "wb") as fh:
        fh.write(out)
    return len(out)


def _identity():
    return [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def _mul(a, b):
    """Column-major 4x4 multiply, glTF's convention."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def _node_matrix(node):
    if "matrix" in node:
        return list(node["matrix"])
    t = node.get("translation", [0, 0, 0])
    q = node.get("rotation", [0, 0, 0, 1])
    s = node.get("scale", [1, 1, 1])
    x, y, z, w = q
    return [
        (1 - 2 * (y * y + z * z)) * s[0],
        (2 * (x * y + z * w)) * s[0],
        (2 * (x * z - y * w)) * s[0],
        0,
        (2 * (x * y - z * w)) * s[1],
        (1 - 2 * (x * x + z * z)) * s[1],
        (2 * (y * z + x * w)) * s[1],
        0,
        (2 * (x * z + y * w)) * s[2],
        (2 * (y * z - x * w)) * s[2],
        (1 - 2 * (x * x + y * y)) * s[2],
        0,
        t[0],
        t[1],
        t[2],
        1.0,
    ]


def _transform(m, p):
    x, y, z = p
    return (
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    )


def glb_bounds(path):
    """Scene-space bounding-box size [x, y, z], or None for an empty file.

    Reads only the JSON chunk: every POSITION accessor carries min/max, so the
    corners of that box, pushed through the node transforms, bound the mesh. The
    BIN chunk is left on disk — it is the other 24-38 MB of an imported map's
    asset, and `write_props_world` measures every one of them.
    """
    with open(path, "rb") as f:
        header = f.read(20)
        if len(header) < 20:
            return None
        json_len = struct.unpack("<I", header[12:16])[0]
        gltf = json.loads(f.read(json_len))
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3

    def visit(index, parent):
        node = gltf["nodes"][index]
        m = _mul(parent, _node_matrix(node))
        mesh = node.get("mesh")
        if mesh is not None:
            for prim in gltf["meshes"][mesh]["primitives"]:
                acc = gltf["accessors"][prim["attributes"]["POSITION"]]
                if "min" not in acc:
                    continue
                mn, mx = acc["min"], acc["max"]
                for cx in (mn[0], mx[0]):
                    for cy in (mn[1], mx[1]):
                        for cz in (mn[2], mx[2]):
                            p = _transform(m, (cx, cy, cz))
                            for i in range(3):
                                lo[i] = min(lo[i], p[i])
                                hi[i] = max(hi[i], p[i])
        for child in node.get("children", []):
            visit(child, m)

    for scene in gltf.get("scenes", []):
        for root in scene.get("nodes", []):
            visit(root, _identity())
    if lo[0] == float("inf"):
        return None
    return [hi[i] - lo[i] for i in range(3)]


# glTF component types, as the spec numbers them, with the struct code and byte
# width of each. Only the ones an exported body actually uses.
_COMPONENTS = {
    5120: ("b", 1),  # byte
    5121: ("B", 1),  # unsigned byte
    5122: ("h", 2),  # short
    5123: ("H", 2),  # unsigned short
    5125: ("I", 4),  # unsigned int
    5126: ("f", 4),  # float
}
_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_accessor(gltf, buf, index):
    """One accessor's values as a list of tuples (or scalars for SCALAR).

    The pipeline has only ever *written* GLBs, so this is the first reader in it.
    Honours `byteStride`, because an interleaved buffer view is what
    `xmodel_glb.py` writes for positions and normals — reading it as tight rows
    silently returns normals where positions were asked for.
    """
    acc = gltf["accessors"][index]
    code, width = _COMPONENTS[acc["componentType"]]
    per = _COUNTS[acc["type"]]
    view = gltf["bufferViews"][acc["bufferView"]]
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride") or per * width
    out = []
    for i in range(acc["count"]):
        row = struct.unpack_from("<" + code * per, buf, base + i * stride)
        out.append(row[0] if per == 1 else row)
    return out


def parents_of(gltf):
    """{child node index: parent node index} over the whole node list."""
    out = {}
    for index, node in enumerate(gltf.get("nodes", [])):
        for child in node.get("children", []):
            out[child] = index
    return out


def joint_subtree(gltf, root):
    """Node indices under (and including) `root`, parents before children."""
    order, stack = [], [root]
    while stack:
        i = stack.pop()
        order.append(i)
        stack.extend(reversed(gltf["nodes"][i].get("children", [])))
    return order


def skin_roots(gltf):
    """The joints of `gltf`'s skins that have no joint parent, and the set of every joint index."""
    joints = {j for s in gltf.get("skins", []) for j in s["joints"]}
    parent = {c: i for i, n in enumerate(gltf.get("nodes", [])) for c in n.get("children", [])}
    return [j for j in joints if parent.get(j) not in joints], joints
