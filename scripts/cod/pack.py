"""Make OpenAssetTools' exported prop models self-contained and web-ready.

OAT writes each XModel as a .glb whose textures are external .dds/.iwi paths,
in inches, with no alpha mode. This embeds the base-colour maps (as PNG/JPEG),
scales to metres, applies each material's render state, and drops surfaces the
game never draws as geometry (FX cards, shadow proxies).
"""

import os
import re
import struct

from .gltf import ARRAY_BUFFER, add_view, pack, read_glb, write_glb
from .materials import ALPHA_CUTOFFS
from .textures import alpha_mode, encode_image, texture_index, white_pixel
from .units import UNITS_PER_M

# Material-name rules for non-surfaces, for materials with no dumped JSON to read
# a techset from. `gfx_` cards are additive FX; `gobo` is Treyarch's fake-shadow
# card inside trees (black at every alpha level, so no cutoff can save it).
FX_MATERIALS = ("gfx_",)
# What `@3d/api` serves in a world path segment (protocol/routes/worlds.ts SEGMENT).
# AW names per-map variants `<model>@<map>`, which it would answer with a 404.
_UNSERVED = re.compile(r"[^A-Za-z0-9._ /-]")


def served_path(rel):
    """A model's path under props/, spelled so the api will serve it."""
    return _UNSERVED.sub("_", rel)


DROP_NAMES = ("shadowcaster",)
DROP_NAME_PARTS = ("gobo",)


def drop_fx(gltf, states):
    """Remove every non-surface primitive, then the materials and meshes it leaves empty; return how many materials went."""
    materials = gltf.get("materials", [])

    def unwanted(mat):
        name = mat.get("name", "")
        leaf = name.rsplit("/", 1)[-1]
        return (
            leaf.startswith(FX_MATERIALS)
            or leaf.startswith(DROP_NAMES)
            or any(part in leaf for part in DROP_NAME_PARTS)
            or states.get(name, {}).get("drop", False)
        )

    fx = {i for i, m in enumerate(materials) if unwanted(m)}
    if not fx:
        return 0

    mat_map, kept_materials = {}, []
    for i, mat in enumerate(materials):
        if i in fx:
            continue
        mat_map[i] = len(kept_materials)
        kept_materials.append(mat)

    mesh_map, kept_meshes = {}, []
    for i, mesh in enumerate(gltf.get("meshes", [])):
        prims = [p for p in mesh.get("primitives", []) if p.get("material") not in fx]
        if not prims:
            continue  # an empty `primitives` array is not valid glTF
        for prim in prims:
            if "material" in prim:
                prim["material"] = mat_map[prim["material"]]
        mesh["primitives"] = prims
        mesh_map[i] = len(kept_meshes)
        kept_meshes.append(mesh)

    for node in gltf.get("nodes", []):
        if "mesh" in node:
            if node["mesh"] in mesh_map:
                node["mesh"] = mesh_map[node["mesh"]]
            else:
                del node["mesh"]

    gltf["materials"] = kept_materials
    gltf["meshes"] = kept_meshes
    return len(fx)


def apply_unit_scale(gltf, scale):
    """Re-root the scene under one scaled node, leaving the accessors (and their min/max) untouched."""
    nodes = gltf.setdefault("nodes", [])
    for scene in gltf.get("scenes", []):
        roots = scene.get("nodes", [])
        if not roots:
            continue
        nodes.append({"name": "unit-scale", "scale": [scale, scale, scale], "children": list(roots)})
        scene["nodes"] = [len(nodes) - 1]


FLAG_WEIGHT = "_FLAG_WEIGHT"  # GLTFLoader names it `_flag_weight`; src/scene/flag.ts reads it


def _colour_alphas(gltf, buf, accessor):
    """Every vertex's COLOR_0 alpha in [0, 1], or None for a layout this cannot read."""
    acc = gltf["accessors"][accessor]
    if acc.get("type") != "VEC4" or "bufferView" not in acc:
        return None
    fmt, scale = {5121: ("B", 255.0), 5123: ("H", 65535.0), 5126: ("f", 1.0)}.get(acc["componentType"], (None, None))
    if fmt is None:
        return None
    bv = gltf["bufferViews"][acc["bufferView"]]
    size = struct.calcsize(fmt)
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or size * 4
    return [struct.unpack_from("<" + fmt, buf, base + i * stride + 3 * size)[0] / scale for i in range(acc["count"])]


def keep_flag_weights(gltf, buf, states):
    """Copy COLOR_0 alpha into `_FLAG_WEIGHT` on primitives drawn with the flag technique; return how many.

    The flag shader reads vertex alpha as how far a vertex may move, so it must
    survive `neutralize_vertex_colours`, which runs next.
    """
    materials = gltf.get("materials", [])
    made, kept = {}, 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            mat = prim.get("material")
            name = materials[mat].get("name", "") if mat is not None and mat < len(materials) else ""
            colour = prim.get("attributes", {}).get("COLOR_0")
            if colour is None or not (states.get(name) or {}).get("flag"):
                continue
            if colour not in made:
                alphas = _colour_alphas(gltf, buf, colour)
                if alphas is None:
                    continue
                view = add_view(buf, gltf.setdefault("bufferViews", []), pack("f", alphas), ARRAY_BUFFER)
                gltf["accessors"].append({"bufferView": view, "componentType": 5126, "count": len(alphas), "type": "SCALAR"})
                made[colour] = len(gltf["accessors"]) - 1
            prim["attributes"][FLAG_WEIGHT] = made[colour]
            kept += 1
    return kept


# Whether a game's prop vertex RGB holds layer weights rather than a tint. IW6's is
# grey on every non-foliage vertex of mp_prisonbreak's models, as on IW4 and IW5.
# Black Ops II's is white on 94.5% of mp_la's model vertices and grey on most of the rest.
RGB_IS_LAYER_WEIGHTS_BY_GAME = {"iw4": False, "iw5": False, "t5": True, "t6": False, "iw6": False, "s1": False, "t9": False}


def neutralize_vertex_colours(gltf, buf, also_rgb=False):
    """Force every COLOR_0 alpha to 1 (and RGB to white with `also_rgb`); return accessors rewritten.

    On props, vertex alpha is a wind/sway weight, not opacity; multiplied into a
    MASK material it discards whole plants. Black Ops also puts layer weights in
    RGB, which would tint its foliage magenta and green.
    """
    fixed = 0
    seen = set()
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            ai = prim.get("attributes", {}).get("COLOR_0")
            if ai is None or ai in seen:
                continue
            seen.add(ai)
            acc = gltf["accessors"][ai]
            if acc.get("type") != "VEC4" or "bufferView" not in acc:
                continue
            bv = gltf["bufferViews"][acc["bufferView"]]
            ct = acc["componentType"]
            size = {5121: 1, 5123: 2, 5126: 4}.get(ct)
            if size is None:
                continue
            base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
            stride = bv.get("byteStride") or size * 4
            one = {5121: b"\xff", 5123: b"\xff\xff", 5126: struct.pack("<f", 1.0)}[ct]
            channels = range(4) if also_rgb else (3,)
            for i in range(acc["count"]):
                for k in channels:
                    o = base + i * stride + k * size
                    buf[o : o + size] = one
            fixed += 1
    return fixed


def apply_state(mat, state):
    """Set one glTF material up from the game's own render state (the same mapping the shell uses)."""
    mat["doubleSided"] = state["doubleSided"]
    if state["blend"]:
        mat["alphaMode"] = "BLEND"
        mat.pop("alphaCutoff", None)
    elif state["alphaTest"]:
        mat["alphaMode"] = "MASK"
        mat["alphaCutoff"] = ALPHA_CUTOFFS.get(state["alphaTest"], 1.0 / 255.0)
    else:
        mat.pop("alphaMode", None)
        mat.pop("alphaCutoff", None)

    extras = mat.setdefault("extras", {})
    if state["sortKey"] is not None:
        extras["sortKey"] = state["sortKey"]
    if state["blend"] and state["blend"] != "alpha":
        extras["blend"] = state["blend"]
    extras["castsShadow"] = state["castsShadow"]
    if state.get("flag"):
        speed, offset = state["flag"]
        extras["flag"] = {"speed": speed, "offset": offset}


def add_colour_maps(gltf, colours):
    """Give a material with no colour texture the one its dumped record names; return how many.

    A model whose zone names its material under a leading comma was written with the
    material's name and nothing else. The image goes in as a URI, which pack_one
    embeds from the image dump like any other."""
    added = 0
    for mat in gltf.get("materials", []):
        pbr = mat.setdefault("pbrMetallicRoughness", {})
        image = colours.get(mat.get("name", ""))
        if "baseColorTexture" in pbr or image is None:
            continue
        gltf.setdefault("images", []).append({"uri": f"../images/{image}.dds"})  # as xmodel_glb names one
        gltf.setdefault("textures", []).append({"source": len(gltf["images"]) - 1})
        pbr["baseColorTexture"] = {"index": len(gltf["textures"]) - 1}
        pbr["metallicFactor"] = 0.0
        added += 1
    return added


def pack_one(path, out_path, iwi_index, max_size, states, neutralize_rgb, colours=None):
    """Pack one model; return (bytes written, textures missing, FX materials dropped)."""
    gltf, buf = read_glb(path)
    apply_unit_scale(gltf, 1.0 / UNITS_PER_M)
    keep_flag_weights(gltf, buf, states)
    neutralize_vertex_colours(gltf, buf, also_rgb=neutralize_rgb)
    dropped_fx = drop_fx(gltf, states)
    for mat in gltf.get("materials", []):
        state = states.get(mat.get("name", ""))
        if state:
            apply_state(mat, state)
    add_colour_maps(gltf, colours or {})
    images = gltf.get("images", [])
    textures = gltf.get("textures", [])
    if not images:
        gltf["buffers"] = [{"byteLength": len(buf)}]
        return write_glb(out_path, gltf, buf), 0, dropped_fx

    # Only base-colour maps are kept.
    keep_tex = set()
    for mat in gltf.get("materials", []):
        base = mat.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if base:
            keep_tex.add(base["index"])

    new_images, new_textures, remap, missing = [], [], {}, 0
    modes = {}  # new texture index -> guessed alphaMode
    for ti in sorted(keep_tex):
        src = textures[ti].get("source")
        if src is None:
            continue
        img = images[src]
        if "bufferView" in img:  # already embedded
            new_images.append(img)
            view = gltf["bufferViews"][img["bufferView"]]
            off = view.get("byteOffset", 0)
            payload = bytes(buf[off : off + view["byteLength"]])
        else:
            name = os.path.splitext(os.path.basename(img.get("uri", "")))[0]
            iwi = iwi_index.get(name)
            if iwi:
                payload, mime = encode_image(iwi, max_size)
            else:
                payload, mime = white_pixel(), "image/png"
                missing += 1
            while len(buf) % 4:
                buf.append(0)
            offset = len(buf)
            buf.extend(payload)
            gltf.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": offset, "byteLength": len(payload)})
            new_images.append({"bufferView": len(gltf["bufferViews"]) - 1, "mimeType": mime, "name": name})
        new_textures.append({"source": len(new_images) - 1})
        remap[ti] = len(new_textures) - 1
        mode = alpha_mode(payload)
        if mode:
            modes[remap[ti]] = mode

    for mat in gltf.get("materials", []):
        pbr = mat.get("pbrMetallicRoughness", {})
        base = pbr.get("baseColorTexture")
        if base:
            if base["index"] in remap:
                base["index"] = remap[base["index"]]
                # Fallback for materials with no dumped JSON; state bits win otherwise.
                mode = modes.get(base["index"])
                if mode and mat.get("name", "") not in states:
                    mat["alphaMode"] = mode
                    if mode == "MASK":
                        mat["alphaCutoff"] = 0.5
            else:
                pbr.pop("baseColorTexture")
        mat.pop("normalTexture", None)
        for slot in ("emissiveTexture", "occlusionTexture"):
            mat.pop(slot, None)
        pbr.pop("metallicRoughnessTexture", None)

    gltf["images"] = new_images
    gltf["textures"] = new_textures
    gltf["buffers"] = [{"byteLength": len(buf)}]
    return write_glb(out_path, gltf, buf), missing, dropped_fx


def pack_models(out_dir, glbs, images_dir, states, neutralize_rgb=False, max_size=512, root=None, colours=None):
    """Pack every model in `glbs` into `out_dir`, at its path under `root` (its file name
    without one: a model name can hold a folder, IW6's `mv/`). One bad asset never stops the batch.
    `colours` ({material: image}, materials.colour_maps) textures a material its model's own
    zone held only by name."""
    iwi_index = texture_index(images_dir)
    os.makedirs(out_dir, exist_ok=True)
    total, missing_total, fx_total, failed = 0, 0, 0, 0
    for path in glbs:
        name = served_path(os.path.relpath(path, root) if root else os.path.basename(path))
        os.makedirs(os.path.dirname(os.path.join(out_dir, name)), exist_ok=True)
        try:
            size, missing, fx = pack_one(path, os.path.join(out_dir, name), iwi_index, max_size, states, neutralize_rgb, colours)
        except Exception as exc:
            print(f"      FAIL {name}: {exc}")
            failed += 1
            continue
        total += size
        missing_total += missing
        fx_total += fx
    print(
        f"      packed {len(glbs) - failed} models, {total / 1e6:.1f} MB"
        f"{f', {failed} failed' if failed else ''}"
        f"{f', {missing_total} textures unresolved (white)' if missing_total else ''}"
        f"{f', {fx_total} FX materials dropped' if fx_total else ''}"
    )
