"""The map's rendered surfaces (the "shell") and its decal pass, as two textured .glb files.

Reads the GfxWorld dump OpenAssetTools' patched dumper writes: a JSON manifest
plus raw vertex and index arrays. Vertex layout and decoding rules are in
docs/cod/reference.md#gfxworld-vertices.
"""

import collections
import math
import os
import struct
import sys

from . import brushmodels
from .files import read_bytes, read_json
from .gltf import ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, add_view, pack, write_glb
from .iw6 import vertices as iw6_vertices
from .materials import ALPHA_CUTOFFS
from .t6 import vertices as t6_vertices
from .units import UNITS_PER_M

VERTEX_STRIDE = 44

#: One vertex of the shell: position, 4 unknown bytes, RGBA, UV, lightmap UV, a
#: PackedUnitVec normal, 4 more unknown bytes. A format that no longer spans the
#: stride would decode every field from the wrong offset and still render.
VERTEX = struct.Struct("<3f4x4B2f2fI4x")
assert VERTEX.size == VERTEX_STRIDE


# Surfaces that are not part of the world you see or touch: the skybox shell,
# and the invisible exposure-portal planes across doorways.
NON_SOLID_PREFIXES = ("sky_", "hdrportal")

# Render state for a surface whose material the dump has no JSON for. Never
# happens on the 43 imported maps; such a material is drawn plainly and named.
PLAIN_STATE = {"sortKey": None, "blend": None, "alphaTest": None, "doubleSided": True, "castsShadow": True}


def unpack_unit_vec(packed):
    """A CoD PackedUnitVec -> xyz. Byte 3 is a scale: (b[i] - 127) * (b[3] + 192) / 32385."""
    scale = ((packed >> 24 & 0xFF) + 192.0) / 32385.0
    return [((packed >> s & 0xFF) - 127.0) * scale for s in (0, 8, 16)]


# How each game packs a PackedUnitVec. IW6's is not the scale-byte packing
# (scripts/cod/iw6/vertices.py); check_unit_vectors catches a game given the wrong one.
UNIT_VEC_BY_GAME = {
    "iw4": unpack_unit_vec,
    "iw5": unpack_unit_vec,
    "t5": unpack_unit_vec,
    "iw6": iw6_vertices.unit_vec,
    # S1's GfxWorldVertex is byte-for-byte IW6's, normals included
    # (reverse/s1-zone/README.md#the-vertex-formats).
    "s1": iw6_vertices.unit_vec,
    # Cold War's world normal is IW6's 10:10:10 unsigned; its dump copies the u32 across.
    "t9": iw6_vertices.unit_vec,
    # Black Ops II's is three signed 10-bit fields. Its world vertex is not this
    # layout at all; its dump rewrites every one into it (t6/dumpers/gfxworld.py).
    "t6": t6_vertices.unit_vec,
}

# Every game here dumps GfxWorldVertex in this one layout; a game missing from the
# table would decode into geometry rather than an error, so it is refused.
SUPPORTED_GAMES = tuple(UNIT_VEC_BY_GAME)

# Where each game's world vertex colour holds layer blend weights rather than a
# tint (docs/cod/games.md). This engine draws one layer, so weights are
# neutralised to white:
# - "alpha": alpha is the weight, RGB a tint; both kept;
# - "rgb": RGB is a weight on every surface; alpha kept;
# - "generated": on generated `*` blend materials all four channels are weights
#   (a layer each); every other surface keeps its tint.
# S1 blends its layers in one pass rather than two (`b0c0_b1c1_b2c2…` in one
# techset), but keeps the weights in the same place: on mp_prison 0.7% of the
# vertices of a generated material's surfaces are white against 93% of every
# other surface's, and all four channels are spread.
# Cold War's vertex RGB is always white and its alpha a weight; its dump writes the vertex white.
# Black Ops II keeps T5's weights in RGB, but only on generated surfaces: on mp_la
# 49% of their vertices are coloured against 0.7% of every other surface's, and
# alpha is 255 on all but 5 of theirs.
LAYER_WEIGHTS_BY_GAME = {
    "iw4": "alpha",
    "iw5": "alpha",
    "t5": "rgb",
    "t6": "generated",
    "iw6": "generated",
    "s1": "generated",
    "t9": "alpha",
}


def check_unit_vectors(normals, label):
    """Warn if decoded normals are not unit length: a wrong decode shades wrongly and renders fine."""
    bad = sum(1 for n in normals if abs((n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) ** 0.5 - 1.0) > 0.03)
    if bad:
        print(f"  WARNING: {bad}/{len(normals)} {label} are not unit length — the PackedUnitVec decode may not suit this game")
    return bad


def read_container(manifest_path):
    """(manifest, vertex bytes, index tuple) for one `.gfxworld.json`."""
    manifest = read_json(manifest_path)
    base = os.path.dirname(os.path.abspath(manifest_path))

    def blob(key):
        return read_bytes(os.path.join(base, os.path.basename(manifest[key])))

    game = manifest["_game"]
    if game not in SUPPORTED_GAMES:
        sys.exit(f"manifest says _game={game!r}; this reader handles {', '.join(SUPPORTED_GAMES)}.")
    if manifest["vertexStride"] != VERTEX_STRIDE:
        sys.exit(f"unexpected vertex stride {manifest['vertexStride']}, expected {VERTEX_STRIDE}")

    verts, indices = blob("vertexFile"), blob("indexFile")
    n_vert, n_index = manifest["vertexCount"], manifest["indexCount"]
    if len(verts) != n_vert * VERTEX_STRIDE:
        sys.exit(f"vertex blob is {len(verts)} bytes, manifest declares {n_vert * VERTEX_STRIDE}")
    if len(indices) != n_index * manifest["indexStride"]:
        sys.exit(f"index blob is {len(indices)} bytes, manifest declares {n_index * manifest['indexStride']}")
    return manifest, verts, struct.unpack(f"<{n_index}H", indices)


def decode_vertices(verts, n_vert, game):
    """Positions, normals, UVs, lightmap UVs and RGBA colours, in the engine frame.

    RGB is neutralised to white where the game keeps layer weights there on
    every surface (LAYER_WEIGHTS_BY_GAME); `neutralise_generated` handles the rest.
    """
    drop_vertex_rgb = LAYER_WEIGHTS_BY_GAME[game] == "rgb"
    unpack_normal = UNIT_VEC_BY_GAME[game]
    pos, nrm, uv, lmp, col = [], [], [], [], []
    # One pass of the whole blob rather than five `unpack_from` calls per vertex;
    # a map's shell runs to 383k of them.
    for x, y, z, cr, cg, cb, ca, u, v, lu, lv, packed_normal in VERTEX.iter_unpack(memoryview(verts)[: n_vert * VERTEX_STRIDE]):
        if drop_vertex_rgb:
            cr = cg = cb = 255
        nx, ny, nz = unpack_normal(packed_normal)

        pos += [x / UNITS_PER_M, z / UNITS_PER_M, -y / UNITS_PER_M]
        nrm += [nx, nz, -ny]
        uv += [u, v]
        lmp += [lu, lv]
        col += [cr, cg, cb, ca]
    check_unit_vectors([nrm[i : i + 3] for i in range(0, len(nrm), 3)], "vertex normals")
    return pos, nrm, uv, lmp, col


def neutralise_generated(col, surfaces, indices, game):
    """Set every vertex of a generated (`*`) material's surface to opaque white; return how many.

    Only for games whose generated materials keep a weight per layer in RGBA
    (LAYER_WEIGHTS_BY_GAME). Left in, the weights tint the surface and, as
    alpha, cut or fade out an alpha-tested or blended one.
    """
    if LAYER_WEIGHTS_BY_GAME[game] != "generated":
        return 0
    vertices = set()
    for surface in surfaces:
        if surface.get("material", "").startswith("*"):
            base, first = surface["baseIndex"], surface["firstVertex"]
            vertices.update(indices[base + k] + first for k in range(surface["triCount"] * 3))
    for v in vertices:
        col[v * 4 : v * 4 + 4] = (255, 255, 255, 255)
    return len(vertices)


def move_lightmap_uvs(lmp, surfaces, indices, transforms):
    """Move each surface's lightmap UVs into its own page of the stacked atlas.

    A lightmap page is a texture of its own in the game, and `lightmap.py`
    stacks a map's pages into one image, so each surface's UVs are scaled and
    offset into the rectangle its page landed in. A surface whose page index is
    outside the atlas (31, "no lightmap") is left alone. Returns (vertices
    moved, vertices two pages disagree over).

    Through the index buffer, not `firstVertex + vertexCount`: that range
    overlaps its neighbours' (three of mp_frag's surfaces declare the same 29
    vertices, and one declares 891 for nine triangles), so a range walk moves
    vertices that belong to another page.
    """
    page_of, conflicts = {}, 0
    for surface in surfaces:
        page = surface.get("lightmapIndex")
        if page is None or page >= len(transforms):
            continue
        scale_u, offset_u, scale_v, offset_v = transforms[page]
        base, first = surface["baseIndex"], surface["firstVertex"]
        for k in range(surface["triCount"] * 3):
            v = indices[base + k] + first
            if v in page_of:
                conflicts += page_of[v] != page
                continue
            page_of[v] = page
            lmp[v * 2] = lmp[v * 2] * scale_u + offset_u
            lmp[v * 2 + 1] = lmp[v * 2 + 1] * scale_v + offset_v
    return len(page_of), conflicts


def export_shell(
    manifest_path, out_path, decal_out, tex_dir, mat_map, decal_materials, drop_materials, states, placements, lightmap_uv=None
):
    """Write `out_path` (the shell) and `decal_out` (decals: rendered, never collided)."""
    manifest, verts, indices = read_container(manifest_path)
    n_vert = manifest["vertexCount"]
    decal_materials = set(decal_materials)
    drop_materials = set(drop_materials)

    game = manifest["_game"]
    pos, nrm, uv, lmp, col = decode_vertices(verts, n_vert, game)
    neutralised = neutralise_generated(col, manifest["surfaces"], indices, game)
    if neutralised:
        print(f"  {neutralised} vertices of generated blend materials: layer weights neutralised to white")
    if lightmap_uv:
        # Before the brush-model copies below, which copy each vertex's UVs as they stand.
        moved, conflicts = move_lightmap_uvs(lmp, manifest["surfaces"], indices, lightmap_uv)
        print(f"  lightmap: {len(lightmap_uv)} pages stacked, {moved:,} vertices moved into their own")
        if conflicts:
            print(f"  WARNING: {conflicts} vertices are shared by surfaces on different lightmap pages")

    # Brush-model surfaces share the vertex buffer with everything else, so their
    # vertices are copied and each copy moved, never moved in place.
    owner = brushmodels.owners(manifest["models"])
    copies = {}

    def placed_vertex(n, v):
        key = (n, v)
        if key not in copies:
            where = placements[n]
            x, y, z = brushmodels.place(where, struct.unpack_from("<3f", verts, v * VERTEX_STRIDE))
            nx, ny, nz = brushmodels.orient(where, (nrm[v * 3], -nrm[v * 3 + 2], nrm[v * 3 + 1]))
            copies[key] = len(pos) // 3
            pos.extend((x / UNITS_PER_M, z / UNITS_PER_M, -y / UNITS_PER_M))
            nrm.extend((nx, nz, -ny))
            uv.extend(uv[v * 2 : v * 2 + 2])
            lmp.extend(lmp[v * 2 : v * 2 + 2])
            col.extend(col[v * 4 : v * 4 + 4])
        return copies[key]

    by_mat, by_decal, skipped, placed_surfaces = {}, {}, 0, 0
    # A brush model that can be absent (brushmodels.part_of) is drawn in meshes of its
    # own, so it goes when its collision part does: {"*N": {material: indices}}.
    part_mat, part_decal = collections.defaultdict(dict), collections.defaultdict(dict)
    placed = set()
    collected = 0
    for surface_index, surface in enumerate(manifest["surfaces"]):
        material = surface.get("material", "")
        leaf = material.rsplit("/", 1)[-1]  # material names are pathed, `wc/sky_af_chase`
        if leaf.startswith(NON_SOLID_PREFIXES) or material in drop_materials:
            skipped += 1
            continue
        model = owner.get(surface_index)
        base_index, first_vertex = surface["baseIndex"], surface["firstVertex"]
        tris = []
        for k in range(0, surface["triCount"] * 3, 3):
            a, b, c = (indices[base_index + k + n] + first_vertex for n in range(3))
            if model is not None:
                a, b, c = (placed_vertex(model, v) for v in (a, b, c))
            # Reversed: Direct3D fronts are clockwise, glTF's counter-clockwise.
            # check_winding confirms it against the stored normals.
            tris += [c, b, a]
        if not tris:
            continue
        if model is not None:
            placed.add(model)
            placed_surfaces += 1
        decal = material in decal_materials
        target = by_decal if decal else by_mat
        part = brushmodels.part_of(placements[model]) if model is not None else None
        if part is not None:
            target = (part_decal if decal else part_mat)[part]
        target.setdefault(material, []).extend(tris)
        collected += len(tris) // 3

    n_surf = len(manifest["surfaces"])
    print(f"  {n_vert} vertices, {n_surf} surfaces, {skipped} skipped ({', '.join(NON_SOLID_PREFIXES)})")
    if owner:
        by_source = {s: sum(1 for n in placed if placements[n]["source"] == s) for s in ("entity", "dynEnt")}
        print(
            f"  brush models: {placed_surfaces} surfaces of {len(placed)} models placed "
            f"({by_source['entity']} by entity, {by_source['dynEnt']} by dynamic entity)"
        )
    written = build_glb(out_path, pos, nrm, uv, lmp, by_mat, n_surf, skipped, tex_dir, mat_map, col, states, part_mat)
    if by_decal or part_decal:
        print("  --- decals (rendered, not collidable) ---")
        written += build_glb(decal_out, pos, nrm, uv, lmp, by_decal, n_surf, 0, tex_dir, mat_map, col, states, part_decal)
    # Splitting parts out moves triangles between meshes and must never lose one.
    if written != collected:
        sys.exit(f"shell: {written:,} triangles written of {collected:,} drawn")
    return bool(by_decal or part_decal)


def find_texture(tex_dir, image_name):
    """The converted colour map for `image_name`: .jpg when opaque, .png with alpha."""
    if not (tex_dir and image_name):
        return None, None
    for ext, mime in ((".jpg", "image/jpeg"), (".png", "image/png")):
        path = os.path.join(tex_dir, image_name + ext)
        if os.path.exists(path):
            return path, mime
    return None, None


def check_winding(pos, nrm, by_mat, sample=20000):
    """Warn if triangle winding disagrees with the stored normals; return the fraction that agrees.

    Inside-out geometry still renders (and looks plausible), so this is checked
    on every export rather than documented.
    """
    agree = total = 0
    for tris in by_mat.values():
        for t in range(0, len(tris) - 2, 3):
            if total >= sample:
                break
            a, b, c = tris[t], tris[t + 1], tris[t + 2]
            ax, ay, az = pos[a * 3 : a * 3 + 3]
            e1 = [pos[b * 3 + i] - (ax, ay, az)[i] for i in range(3)]
            e2 = [pos[c * 3 + i] - (ax, ay, az)[i] for i in range(3)]
            gx = e1[1] * e2[2] - e1[2] * e2[1]
            gy = e1[2] * e2[0] - e1[0] * e2[2]
            gz = e1[0] * e2[1] - e1[1] * e2[0]
            gl = math.sqrt(gx * gx + gy * gy + gz * gz)
            if gl < 1e-12:
                continue
            sx = sum(nrm[v * 3 + 0] for v in (a, b, c)) / 3
            sy = sum(nrm[v * 3 + 1] for v in (a, b, c)) / 3
            sz = sum(nrm[v * 3 + 2] for v in (a, b, c)) / 3
            sl = math.sqrt(sx * sx + sy * sy + sz * sz)
            if sl < 1e-6:
                continue
            total += 1
            if (gx * sx + gy * sy + gz * sz) / (gl * sl) > 0:
                agree += 1
    if not total:
        return 1.0
    frac = agree / total
    if frac < 0.9:
        print(f"  !! WINDING: only {frac * 100:.1f}% of sampled triangles wind to match their")
        print("  !! normals. Faces are inside-out: nothing looks missing, but lighting and")
        print("  !! shadows come out wrong. See docs/cod/pitfalls.md.")
    return frac


def build_glb(out_path, pos, nrm, uv, lmp, by_mat, n_surf, skipped, tex_dir, mat_map, col, states, parts=None):
    """One glTF primitive per material, colour maps embedded, render state from `states`; the triangles written.

    `col` is RGBA bytes per vertex; its alpha is a layer blend weight.
    `states` maps material -> `materials.material_render_state`. `parts` is
    {"*N": {material: indices}}: each becomes a node and mesh `part:*N` of its
    own with `extras.part`, listed with its triangle count in the scene's
    `extras.parts` (docs/cod/reference.md#game-mode-objects).
    """
    parts = {p: mats for p, mats in (parts or {}).items() if any(mats.values())}
    every = [by_mat, *parts.values()]
    unstated = sorted({m for mats in every for m in mats if m not in states})
    if unstated:
        print(f"  WARNING: {len(unstated)} material(s) have no dumped JSON and are drawn opaque: {', '.join(unstated[:6])}")

    # Keep only the vertices these primitives use: the buffer is shared by every
    # surface in the map, and the decal pass uses a small part of it.
    used = sorted({i for mats in every for tris in mats.values() for i in tris})
    remap = {old: new for new, old in enumerate(used)}
    # Indexed rather than sliced: a slice per vertex is a throwaway list per vertex.
    pos = [pos[i * 3 + c] for i in used for c in (0, 1, 2)]
    nrm = [nrm[i * 3 + c] for i in used for c in (0, 1, 2)]
    uv = [uv[i * 2 + c] for i in used for c in (0, 1)]
    lmp = [lmp[i * 2 + c] for i in used for c in (0, 1)]
    col = [col[i * 4 + c] for i in used for c in (0, 1, 2, 3)]
    by_mat = {m: [remap[i] for i in tris] for m, tris in by_mat.items()}
    parts = {p: {m: [remap[i] for i in tris] for m, tris in mats.items()} for p, mats in parts.items()}
    n_vert = len(used)

    check_winding(pos, nrm, by_mat)

    buf = bytearray()
    views, accs, materials = [], [], []
    images, textures, tex_cache = [], [], {}

    v_pos = add_view(buf, views, pack("f", pos), ARRAY_BUFFER)
    v_nrm = add_view(buf, views, pack("f", nrm), ARRAY_BUFFER)
    v_uv = add_view(buf, views, pack("f", uv), ARRAY_BUFFER)
    v_lmp = add_view(buf, views, pack("f", lmp), ARRAY_BUFFER)

    mins = [min(pos[i::3]) for i in range(3)]
    maxs = [max(pos[i::3]) for i in range(3)]
    accs.append({"bufferView": v_pos, "componentType": 5126, "count": n_vert, "type": "VEC3", "min": mins, "max": maxs})
    accs.append({"bufferView": v_nrm, "componentType": 5126, "count": n_vert, "type": "VEC3"})
    accs.append({"bufferView": v_uv, "componentType": 5126, "count": n_vert, "type": "VEC2"})
    accs.append({"bufferView": v_lmp, "componentType": 5126, "count": n_vert, "type": "VEC2"})

    v_col = add_view(buf, views, pack("B", col), ARRAY_BUFFER)
    accs.append({"bufferView": v_col, "componentType": 5121, "count": n_vert, "type": "VEC4", "normalized": True})
    a_col = len(accs) - 1

    material_of = {}

    def material(name):
        if name in material_of:
            return material_of[name]
        image_name = mat_map.get(name)
        path, mime = find_texture(tex_dir, image_name)
        pbr = {"baseColorFactor": [1.0, 1.0, 1.0, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.9}
        state = states.get(name, PLAIN_STATE)
        mat = {"name": name, "pbrMetallicRoughness": pbr, "doubleSided": state["doubleSided"]}
        # Draw order, blend equation and shadow casting have no glTF field; they
        # ride in `extras`, which three.js copies onto material.userData.
        extras = {}
        if state["sortKey"] is not None:
            extras["sortKey"] = state["sortKey"]
        if state["blend"] and state["blend"] != "alpha":
            extras["blend"] = state["blend"]
        extras["castsShadow"] = state["castsShadow"]
        mat["extras"] = extras
        if state["blend"]:
            mat["alphaMode"] = "BLEND"
        elif state["alphaTest"]:
            mat["alphaMode"] = "MASK"
            mat["alphaCutoff"] = ALPHA_CUTOFFS.get(state["alphaTest"], 1.0 / 255.0)
        if path:
            if image_name not in tex_cache:
                iv = add_view(buf, views, read_bytes(path))
                images.append({"bufferView": iv, "mimeType": mime, "name": image_name})
                textures.append({"source": len(images) - 1})
                tex_cache[image_name] = len(textures) - 1
            pbr["baseColorTexture"] = {"index": tex_cache[image_name]}
        else:
            pbr["baseColorFactor"] = [0.75, 0.74, 0.71, 1.0]
        materials.append(mat)
        material_of[name] = len(materials) - 1
        return material_of[name]

    def primitives(mats):
        prims = []
        for name, tris in sorted(mats.items()):
            vi = add_view(buf, views, pack("I", tris), ELEMENT_ARRAY_BUFFER)
            accs.append({"bufferView": vi, "componentType": 5125, "count": len(tris), "type": "SCALAR"})
            attrs = {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2, "TEXCOORD_1": 3, "COLOR_0": a_col}
            prims.append({"attributes": attrs, "indices": len(accs) - 1, "material": material(name)})
        return prims

    nodes, meshes = [], []
    if by_mat:
        meshes.append({"name": "world", "primitives": primitives(by_mat)})
        nodes.append({"mesh": 0, "name": "world"})
    part_list = []
    for part in sorted(parts, key=lambda p: int(p[1:])):
        meshes.append({"name": f"part:{part}", "primitives": primitives(parts[part])})
        # `group`, as a collision part's: the base node these triangles would otherwise be in.
        nodes.append({"mesh": len(meshes) - 1, "name": f"part:{part}", "extras": {"part": part, "group": "world"}})
        part_list.append({"part": part, "triangles": sum(len(t) for t in parts[part].values()) // 3})
    scene = {"nodes": list(range(len(nodes)))}
    if part_list:
        scene["extras"] = {"parts": part_list}

    gltf = {
        "asset": {"version": "2.0", "generator": "scripts/cod/shell.py"},
        "scene": 0,
        "scenes": [scene],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "images": images,
        "textures": textures,
        "accessors": accs,
        "bufferViews": views,
        "buffers": [{"byteLength": len(buf)}],
    }
    size = write_glb(out_path, gltf, buf)
    tri = sum(len(t) for t in by_mat.values()) // 3
    in_parts = sum(p["triangles"] for p in part_list)
    textured = sum(1 for m in materials if "baseColorTexture" in m["pbrMetallicRoughness"])
    print(f"  textures  {len(images)} embedded, {textured}/{len(materials)} materials textured")
    print(f"  vertices  {n_vert:,}")
    print(f"  surfaces  {n_surf:,} ({skipped:,} skipped)")
    print(f"  triangles {tri:,}  across {len(by_mat)} materials")
    if part_list:
        print(f"  parts     {in_parts:,} triangles in {len(part_list)} removable brush model(s):")
        for p in part_list:
            print(f"    {p['part']:<6} {p['triangles']:6,} tris")
    print(f"  extent    x {mins[0]:.1f}..{maxs[0]:.1f}  y {mins[1]:.1f}..{maxs[1]:.1f}  z {mins[2]:.1f}..{maxs[2]:.1f} m")
    print(f"  -> {out_path}  ({size / 1e6:.1f} MB)")
    return tri + in_parts
