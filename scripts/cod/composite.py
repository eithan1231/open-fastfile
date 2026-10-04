"""A composite model as one GLB: Advanced Warfare builds a gun out of parts.

`vm_ak12_loot_base` has no geometry of its own. It names four models --
`vm_ak12_base` (the receiver, which carries the skeleton), a barrel, a sight and
a stock -- that the game hangs on that skeleton, each on the bone its own
skeleton is rooted at. Each part is dumped as a model of its own, in the space
of that root bone, so the whole is those parts placed on the receiver's bones.

That placement is done here with skins rather than by moving vertices: a part
gets a skin of its own over the receiver's joints, whose inverse bind matrices
say where its space is, so it moves with those joints when a clip plays. What
the layout of each GLB is: scripts/cod/xmodel_glb.py.
"""

import json
import os

from .files import read_json
from .gltf import _identity, _mul, _node_matrix, _transform, add_view, pack, read_accessor, read_glb, skin_roots, write_glb

# A rigid part's vertices are in its root bone's space but in glTF's axes; the
# joint's own frame is CoD's. This is the axis change undone (xmodel_glb.to_gltf's
# inverse), column-major: glTF (x, y, z) -> CoD (x, -z, y).
GLTF_TO_COD = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]
FLOAT, UBYTE, USHORT = 5126, 5121, 5123


def parts_of(xmodel_dir, name):
    """The part names a composite model's dump lists, or [] for a model with geometry of its own."""
    path = os.path.join(xmodel_dir, f"{name}.json")
    return read_json(path).get("compositeModels") or [] if os.path.exists(path) else []


def root_bone_of(xmodel_dir, name):
    """The bone a rigid part hangs from, as its dump names it; None where it does not say."""
    path = os.path.join(xmodel_dir, f"{name}.json")
    return read_json(path).get("rootBoneName") if os.path.exists(path) else None


def _joint_names(gltf):
    return {gltf["nodes"][j]["name"]: j for s in gltf.get("skins", []) for j in s["joints"]}


def _append(base, buf, part, part_buf):
    """Copy a part's buffer, views, accessors, textures, materials and meshes into `base`; return the remaps."""
    while len(buf) % 4:
        buf.append(0)
    offset = len(buf)
    buf.extend(part_buf)
    remap = {}
    for kind in ("bufferViews", "accessors", "samplers", "images", "textures", "materials", "meshes"):
        remap[kind] = len(base.setdefault(kind, []))
    for view in part.get("bufferViews", []):
        base["bufferViews"].append({**view, "buffer": 0, "byteOffset": view.get("byteOffset", 0) + offset})
    for acc in part.get("accessors", []):
        base["accessors"].append({**acc, "bufferView": acc["bufferView"] + remap["bufferViews"]})
    base["samplers"] += part.get("samplers", [])
    for image in part.get("images", []):
        base["images"].append(
            {**image, **({"bufferView": image["bufferView"] + remap["bufferViews"]} if "bufferView" in image else {})}
        )
    for tex in part.get("textures", []):
        moved = {**tex, "source": tex["source"] + remap["images"]}
        if "sampler" in tex:
            moved["sampler"] = tex["sampler"] + remap["samplers"]
        base["textures"].append(moved)
    base["materials"] += [_shift_texture_indices(json.loads(json.dumps(m)), remap["textures"]) for m in part.get("materials", [])]
    for mesh in part.get("meshes", []):
        prims = []
        for prim in mesh["primitives"]:
            moved = {**prim, "attributes": {k: v + remap["accessors"] for k, v in prim["attributes"].items()}}
            if "indices" in prim:
                moved["indices"] = prim["indices"] + remap["accessors"]
            if "material" in prim:
                moved["material"] = prim["material"] + remap["materials"]
            prims.append(moved)
        base["meshes"].append({**mesh, "primitives": prims})
    return remap


def _shift_texture_indices(value, by):
    """A material with every texture reference in it (`{"index": n}`, however nested) moved by `by`."""
    if isinstance(value, dict):
        for key, child in value.items():
            value[key] = child + by if key == "index" else _shift_texture_indices(child, by)
    elif isinstance(value, list):
        return [_shift_texture_indices(child, by) for child in value]
    return value


def _bind_rigid(base, buf, meshes, joint):
    """Give a rigid part's meshes one skin of one joint, every vertex wholly on it; return the skin's index.

    A part's surfaces share one vertex buffer, so their weights are shared too."""
    views, accessors, weighted = base["bufferViews"], base["accessors"], {}
    for mesh in meshes:
        for prim in base["meshes"][mesh]["primitives"]:
            position = prim["attributes"]["POSITION"]
            if position not in weighted:
                count = accessors[position]["count"]
                joints = add_view(buf, views, bytes(4 * count))
                weights = add_view(buf, views, pack("f", [1.0, 0.0, 0.0, 0.0] * count))
                accessors.append({"bufferView": joints, "componentType": UBYTE, "count": count, "type": "VEC4"})
                accessors.append({"bufferView": weights, "componentType": FLOAT, "count": count, "type": "VEC4"})
                weighted[position] = (len(accessors) - 2, len(accessors) - 1)
            prim["attributes"]["JOINTS_0"], prim["attributes"]["WEIGHTS_0"] = weighted[position]
    matrix = add_view(buf, views, pack("f", GLTF_TO_COD))
    accessors.append({"bufferView": matrix, "componentType": FLOAT, "count": 1, "type": "MAT4"})
    base.setdefault("skins", []).append({"joints": [joint], "inverseBindMatrices": len(accessors) - 1})
    return len(base["skins"]) - 1


def _graft_joints(base, part, joints, names):
    """Map a skinned part's joints onto `base`: its root onto the bone of that name, the rest copied under it."""
    parent = {c: i for i, n in enumerate(part["nodes"]) for c in n.get("children", [])}
    mapped = {}
    for j in joints:  # a skin lists parents before children, as OAT writes it
        node = part["nodes"][j]
        if node["name"] in names:
            mapped[j] = names[node["name"]]
            continue
        if parent.get(j) not in mapped:
            raise ValueError(f"part joint {node['name']} hangs from no bone of the model it joins")
        copy = {k: node[k] for k in ("name", "translation", "rotation", "scale") if k in node}
        base["nodes"].append(copy)
        mapped[j] = names[node["name"]] = len(base["nodes"]) - 1
        base["nodes"][mapped[parent[j]]].setdefault("children", []).append(mapped[j])
    return mapped


def compose(base_path, parts, out_path):
    """Write the model `parts` make on `base_path`'s skeleton to `out_path`; return the parts placed.

    `parts` is [(GLB path, root bone or None)]. A skinned part is rooted where its
    own skeleton is; a rigid one on the bone its dump names, which it must.
    """
    base, buf = read_glb(base_path)
    names = _joint_names(base)
    if not names:
        raise ValueError(f"{os.path.basename(base_path)} carries no skeleton for parts to hang on")
    scene_root = base["nodes"][base["scenes"][0]["nodes"][0]]
    placed = 0
    for path, root in parts:
        part, part_buf = read_glb(path)
        remap = _append(base, buf, part, part_buf)
        skin = None
        if part.get("skins"):
            roots, _ = skin_roots(part)
            if len(roots) != 1 or part["nodes"][roots[0]]["name"] not in names:
                raise ValueError(f"{os.path.basename(path)} is rooted at no bone of {os.path.basename(base_path)}")
            joints = _graft_joints(base, part, part["skins"][0]["joints"], names)
            inverse = part["skins"][0]["inverseBindMatrices"] + remap["accessors"]
            base.setdefault("skins", []).append(
                {"joints": [joints[j] for j in part["skins"][0]["joints"]], "inverseBindMatrices": inverse}
            )
            skin = len(base["skins"]) - 1
        elif root not in names:
            raise ValueError(f"{os.path.basename(path)} is rigid and names no bone of the model it joins ({root})")
        surfaces = [node for node in part["nodes"] if "mesh" in node]
        if skin is None:
            skin = _bind_rigid(base, buf, [node["mesh"] + remap["meshes"] for node in surfaces], names[root])
        for node in surfaces:
            base["nodes"].append({"name": node.get("name", "surf"), "mesh": node["mesh"] + remap["meshes"], "skin": skin})
            scene_root.setdefault("children", []).append(len(base["nodes"]) - 1)
        placed += 1
    base["buffers"] = [{"byteLength": len(buf)}]
    write_glb(out_path, base, buf)
    return placed


def _world_matrices(gltf):
    """Every node's world matrix (column-major), parents first."""
    parent = {c: i for i, n in enumerate(gltf["nodes"]) for c in n.get("children", [])}
    out = {}

    def world(i):
        if i not in out:
            local = _node_matrix(gltf["nodes"][i])
            out[i] = _mul(world(parent[i]), local) if i in parent else local
        return out[i]

    for i in range(len(gltf["nodes"])):
        world(i)
    return out


def _inverse(m):
    """The inverse of an affine column-major 4x4."""
    a, b, c = m[0:3], m[4:7], m[8:11]
    det = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1])
    rows = [  # the inverse's rows are the cross products of the columns, over the determinant
        [(b[1] * c[2] - b[2] * c[1]) / det, (b[2] * c[0] - b[0] * c[2]) / det, (b[0] * c[1] - b[1] * c[0]) / det],
        [(c[1] * a[2] - c[2] * a[1]) / det, (c[2] * a[0] - c[0] * a[2]) / det, (c[0] * a[1] - c[1] * a[0]) / det],
        [(a[1] * b[2] - a[2] * b[1]) / det, (a[2] * b[0] - a[0] * b[2]) / det, (a[0] * b[1] - a[1] * b[0]) / det],
    ]
    t = [-sum(rows[r][k] * m[12 + k] for k in range(3)) for r in range(3)]
    return [rows[0][0], rows[1][0], rows[2][0], 0.0, rows[0][1], rows[1][1], rows[2][1], 0.0,
            rows[0][2], rows[1][2], rows[2][2], 0.0, t[0], t[1], t[2], 1.0]  # fmt: skip


def single_skin(gltf, buf):
    """Rebind every skinned mesh of a composed model to one skin over one skeleton.

    `compose` leaves a skin a part, each with the inverse bind matrices of the file it came from.
    A body's grafts (characters.graft_head, graft_weapon) and the hitboxes read `skins[0]` alone,
    so every vertex is baked to where its own skin puts it at bind, and bound again to the joints'
    bind: where the model is drawn at rest does not change.
    """
    worlds = _world_matrices(gltf)
    meshes = [(i, n) for i, n in enumerate(gltf["nodes"]) if "mesh" in n and "skin" in n]
    for i, _ in meshes:
        if max(abs(x - y) for x, y in zip(worlds[i], _identity(), strict=True)) > 1e-6:
            raise ValueError(f"mesh node {gltf['nodes'][i].get('name')} is not at the origin; its skin cannot be rebound")
    joints = []
    for skin in gltf["skins"]:
        joints += [j for j in skin["joints"] if j not in joints]
    slot = {j: k for k, j in enumerate(joints)}
    skin_mats = []
    for skin in gltf["skins"]:
        inverse = read_accessor(gltf, buf, skin["inverseBindMatrices"])
        skin_mats.append([_mul(worlds[j], list(inverse[k])) for k, j in enumerate(skin["joints"])])

    done = {}
    for _, node in meshes:
        s = node["skin"]
        for prim in gltf["meshes"][node["mesh"]]["primitives"]:
            attrs = prim["attributes"]
            key = (attrs["POSITION"], attrs["JOINTS_0"], s)
            if key not in done:
                done[key] = _rebake(gltf, buf, attrs, gltf["skins"][s]["joints"], skin_mats[s], slot)
            attrs["POSITION"], normal, attrs["JOINTS_0"] = done[key]
            if normal is not None:
                attrs["NORMAL"] = normal
            node["skin"] = 0
    inverse = [x for j in joints for x in _inverse(worlds[j])]
    gltf["skins"] = [{"joints": joints, "inverseBindMatrices": _accessor(gltf, buf, "f", inverse, FLOAT, len(joints), "MAT4")}]


def _rebake(gltf, buf, attrs, skin_joints, mats, slot):
    """New POSITION, NORMAL and JOINTS_0 accessors for one vertex buffer under `mats`, one skin's joint matrices."""
    positions = read_accessor(gltf, buf, attrs["POSITION"])
    normals = read_accessor(gltf, buf, attrs["NORMAL"]) if "NORMAL" in attrs else None
    joint_ids = read_accessor(gltf, buf, attrs["JOINTS_0"])
    weights = read_accessor(gltf, buf, attrs["WEIGHTS_0"])
    out_p, out_n, out_j = [], [], []
    for v, p in enumerate(positions):
        m = [0.0] * 16
        for k in range(4):
            if weights[v][k]:
                m = [a + weights[v][k] * b for a, b in zip(m, mats[joint_ids[v][k]], strict=True)]
        q = _transform(m, p)
        out_p += q
        if normals is not None:
            n = normals[v]
            r = [m[a] * n[0] + m[4 + a] * n[1] + m[8 + a] * n[2] for a in range(3)]
            length = sum(x * x for x in r) ** 0.5 or 1.0
            out_n += [x / length for x in r]
        out_j += [slot[skin_joints[j]] if weights[v][k] else 0 for k, j in enumerate(joint_ids[v])]
    count = len(positions)
    bounds = {"min": [min(out_p[a::3]) for a in range(3)], "max": [max(out_p[a::3]) for a in range(3)]}
    position = _accessor(gltf, buf, "f", out_p, FLOAT, count, "VEC3", bounds)
    normal = _accessor(gltf, buf, "f", out_n, FLOAT, count, "VEC3") if normals is not None else attrs.get("NORMAL")
    return position, normal, _accessor(gltf, buf, "H", out_j, USHORT, count, "VEC4")


def _accessor(gltf, buf, typecode, values, component, count, kind, extra=None):
    view = add_view(buf, gltf["bufferViews"], pack(typecode, values))
    gltf["accessors"].append({"bufferView": view, "componentType": component, "count": count, "type": kind, **(extra or {})})
    return len(gltf["accessors"]) - 1
