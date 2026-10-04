"""`equiv`: every comparator ignores order, formatting, layout and generator, and catches real damage.

Each pair of fixtures holds the same records written differently, then one
mutation: a dropped prop, a moved vertex, a swapped texture, a missing alias, a
changed material parameter.
"""

import io
import json
import struct
import tracemalloc
import wave
from array import array

from PIL import Image

from scripts.cod import equiv
from scripts.cod.collision import export_collision
from scripts.cod.gltf import ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, add_view, pack, read_glb, write_glb
from scripts.cod.shell import export_shell
from scripts.cod.tests.test_geometry import placed, restricted_clipmap, shell_dump


def findings(golden, candidate):
    report = equiv.compare_trees(str(golden), str(candidate))
    return [(rel, s, k) for rel, items in report.files.items() for s, k, _ in items]


def failures(golden, candidate):
    return [f for f in findings(golden, candidate) if f[1] in equiv.FAILURES]


def put(root, rel, data):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data)
    elif isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(json.dumps(data))
    return path


# -- .world ----------------------------------------------------------------------------

PROPS = """// 3 placements
asset crate { source: "assets/props/crate.glb", until: 30.5 }
group {
  model { asset: crate, at: 1.000 2.000 3.000, rotate: 0 90 0 }
  model { asset: crate, at: 4 5 6 }
  model { asset: barrel, at: 7 8 9, collide: false }
}
mantle m0 { at: 1 1 1, size: 2 2 2, kind: onto }
mantle m1 { at: 5 5 5, size: 2 2 2, kind: over }
"""

# The same records: other order, other positional names, other spacing and decimals, other comments.
PROPS_REORDERED = """// GENERATED differently
mantle m7 { at: 5 5 5, size: 2 2 2, kind: over }
mantle m3 { at: 1 1 1, size: 2 2 2, kind: onto }
group {
  model { asset: barrel, at: 7.0 8.0 9.0, collide: off }
  model { asset: crate,   at: 4.0 5.0 6.0 }
  model { asset: crate, at: 1.00004 2 3, rotate: 0 90.0004 0 }
}
asset crate { until: 30.5, source: "assets/props/crate.glb" }
"""


def test_world_ignores_order_names_and_formatting(tmp_path):
    put(tmp_path / "g", "props.world", PROPS)
    put(tmp_path / "c", "props.world", PROPS_REORDERED)
    assert findings(tmp_path / "g", tmp_path / "c") == []


def test_world_catches_a_dropped_prop(tmp_path):
    put(tmp_path / "g", "props.world", PROPS)
    put(tmp_path / "c", "props.world", PROPS_REORDERED.replace("  model { asset: crate,   at: 4.0 5.0 6.0 }\n", ""))
    assert failures(tmp_path / "g", tmp_path / "c") == [("props.world", "MISSING", "model asset=['ref:crate'] in group")]


def test_world_catches_a_moved_prop_and_names_it(tmp_path):
    put(tmp_path / "g", "props.world", PROPS)
    put(tmp_path / "c", "props.world", PROPS_REORDERED.replace("at: 7.0 8.0 9.0", "at: 7.0 8.5 9.0"))
    [(rel, status, key)] = failures(tmp_path / "g", tmp_path / "c")
    assert status == "DIFFERS" and "model asset=['ref:barrel']" in key and key.endswith(".at[1]")


def test_world_rounding_in_the_last_printed_place_is_not_a_change():
    a = equiv.parse_world("spawn { at: 1.234 5 6 }")[0]["props"]["at"][0]
    b = equiv.parse_world("spawn { at: 1.235 5 6 }")[0]["props"]["at"][0]
    c = equiv.parse_world("spawn { at: 1.237 5 6 }")[0]["props"]["at"][0]
    assert equiv.equal(a, b, "", equiv.WORLD_RULES)
    assert not equiv.equal(a, c, "", equiv.WORLD_RULES)


def test_world_units_and_colours_are_normalised():
    [a] = equiv.parse_world("light l { at: 100cm 0 0, rotate: 3.14159265rad, color: #FFAA00 }")
    [b] = equiv.parse_world("light l { at: 1 0 0, rotate: 180, color: #ffaa00 }")
    assert equiv.equal(a, b, "", equiv.WORLD_RULES)


# -- export_metadata.json -------------------------------------------------------------------


def metadata(order, drop=None):
    ents = {
        0: {"classname": "worldspawn", "id": 0},
        1: {"classname": "mp_tdm_spawn", "origin": "1 2 3", "id": 1},
        2: {"classname": "script_model", "origin": "4 5 6", "model": "crate", "targetname": "box", "id": 2},
        3: {"classname": "script_model", "origin": "7 8 9", "model": "crate", "targetname": "box", "id": 3},
    }
    ids = {old: new for new, old in enumerate(order)}
    entities = []
    for old in order:
        if old != drop:
            entities.append({**ents[old], "id": ids[old]})
    return {
        "entities": entities,
        "spawns": [{"id": ids[1], "mode": "tdm", "origin": [1.0, 2.0, 3.0], "at": [0.0254, 0.0762, -0.0508]}],
        "targetnames": {"box": sorted(ids[k] for k in (2, 3) if k != drop)},
    }


def test_metadata_ignores_entity_order_and_indices(tmp_path):
    put(tmp_path / "g", "export_metadata.json", metadata([0, 1, 2, 3]))
    put(tmp_path / "c", "export_metadata.json", metadata([3, 0, 2, 1]))
    assert findings(tmp_path / "g", tmp_path / "c") == []


def test_metadata_catches_a_missing_entity(tmp_path):
    put(tmp_path / "g", "export_metadata.json", metadata([0, 1, 2, 3]))
    put(tmp_path / "c", "export_metadata.json", metadata([3, 0, 2, 1], drop=3))
    found = failures(tmp_path / "g", tmp_path / "c")
    assert ("export_metadata.json", "MISSING", "entities[classname=script_model origin=7 8 9 targetname=box]") in found
    assert any(k.startswith("targetnames.box") for _, _, k in found)


def test_metadata_catches_a_moved_spawn(tmp_path):
    put(tmp_path / "g", "export_metadata.json", metadata([0, 1, 2, 3]))
    moved = metadata([0, 1, 2, 3])
    moved["spawns"][0]["at"][1] += 0.01
    put(tmp_path / "c", "export_metadata.json", moved)
    assert failures(tmp_path / "g", tmp_path / "c")


def test_json_float_noise_is_ignored_and_ints_are_exact(tmp_path):
    put(tmp_path / "g", "a.json", {"_type": "xmodel", "scale": 1.0, "flags": 4, "origin": [60308.0, 1.5]})
    put(tmp_path / "c", "a.json", {"_type": "xmodel", "scale": 1.0000001, "flags": 4, "origin": [60308.004, 1.5]})
    assert findings(tmp_path / "g", tmp_path / "c") == []
    put(tmp_path / "c", "a.json", {"_type": "xmodel", "scale": 1.0, "flags": 5, "origin": [60308.0, 1.5]})
    assert failures(tmp_path / "g", tmp_path / "c") == [("a.json", "DIFFERS", "flags")]


# -- Materials -----------------------------------------------------------------------------------


def material(textures, blend="one"):
    return {"_type": "material", "name": "wc/wall", "stateBits": [{"srcBlendRgb": blend}], "textures": textures}


TEXTURES = [
    {"name": "colorMap", "semantic": 2, "image": "wall_col"},
    {"name": "normalMap", "semantic": 5, "image": "wall_nml"},
]


def test_material_ignores_texture_order_and_catches_a_swap_and_a_param(tmp_path):
    put(tmp_path / "g", "mat/wall.json", material(TEXTURES))
    put(tmp_path / "c", "mat/wall.json", material(list(reversed(TEXTURES))))
    assert findings(tmp_path / "g", tmp_path / "c") == []

    swapped = [{**TEXTURES[0], "image": "wall_nml"}, {**TEXTURES[1], "image": "wall_col"}]
    put(tmp_path / "c", "mat/wall.json", material(swapped))
    keys = {k for _, s, k in failures(tmp_path / "g", tmp_path / "c")}
    assert keys == {"textures[name=colorMap semantic=2].image", "textures[name=normalMap semantic=5].image"}

    put(tmp_path / "c", "mat/wall.json", material(TEXTURES, blend="srcAlpha"))
    assert failures(tmp_path / "g", tmp_path / "c") == [("mat/wall.json", "DIFFERS", "stateBits[0].srcBlendRgb")]


# -- GLB ----------------------------------------------------------------------------------------------

QUADS = [
    ((0, 0, 0), (1, 0, 0), (1, 1, 0)),
    ((0, 0, 0), (1, 1, 0), (0, 1, 0)),
    ((2, 0, 0), (3, 0, 0), (3, 1, 0)),
]


def png(colour):
    out = io.BytesIO()
    Image.new("RGB", (4, 4), colour).save(out, "PNG")
    return out.getvalue()


def build_glb(path, tris=QUADS, reverse=False, generator="a", colour=(200, 10, 10), roughness=0.5, translate=(0.0, 0.0, 0.0)):
    """One textured primitive; `reverse` writes the same triangles in the other order, from another vertex, unwelded."""
    tris = list(tris)
    if reverse:
        tris = [t[1:] + t[:1] for t in reversed(tris)]
    positions = [c - o for tri in tris for v in tri for c, o in zip(v, translate, strict=True)]
    normals = [0.0, 0.0, 1.0] * (len(tris) * 3)
    uvs = [c for tri in tris for v in tri for c in v[:2]]
    buf, views = bytearray(), []
    image = png(colour)
    add_view(buf, views, image)
    add_view(buf, views, pack("f", positions), ARRAY_BUFFER)
    add_view(buf, views, pack("f", normals), ARRAY_BUFFER)
    add_view(buf, views, pack("f", uvs), ARRAY_BUFFER)
    add_view(buf, views, pack("I", list(range(len(tris) * 3))), ELEMENT_ARRAY_BUFFER)
    n = len(tris) * 3
    accessors = [
        {"bufferView": 1, "componentType": 5126, "count": n, "type": "VEC3"},
        {"bufferView": 2, "componentType": 5126, "count": n, "type": "VEC3"},
        {"bufferView": 3, "componentType": 5126, "count": n, "type": "VEC2"},
        {"bufferView": 4, "componentType": 5125, "count": n, "type": "SCALAR"},
    ]
    gltf = {
        "asset": {"version": "2.0", "generator": generator},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "root", "children": [1], "translation": list(translate)}, {"name": "mesh", "mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"name": "wall", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "roughnessFactor": roughness}}],
        "textures": [{"source": 0}],
        "images": [{"bufferView": 0, "mimeType": "image/png"}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(buf)}],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    write_glb(str(path), gltf, buf)


def test_glb_ignores_layout_order_generator_and_node_split(tmp_path):
    build_glb(tmp_path / "g/m.glb")
    # Reordered, rotated, another generator, and the geometry moved into a parent's translation.
    build_glb(tmp_path / "c/m.glb", reverse=True, generator="b", translate=(0.0, 0.0, 0.0))
    assert findings(tmp_path / "g", tmp_path / "c") == []


def test_glb_world_space_sees_through_a_parent_transform(tmp_path):
    build_glb(tmp_path / "g/m.glb")
    build_glb(tmp_path / "c/m.glb", translate=(5.0, 0.0, 0.0))
    world = equiv.flatten_glb((tmp_path / "c/m.glb").read_bytes())
    golden = equiv.flatten_glb((tmp_path / "g/m.glb").read_bytes())
    assert world["primitives"]["mesh | wall | mode 4"].digests() == golden["primitives"]["mesh | wall | mode 4"].digests()


def test_glb_catches_a_moved_vertex(tmp_path):
    build_glb(tmp_path / "g/m.glb")
    moved = list(QUADS)
    moved[2] = ((2, 0, 0), (3, 0, 0.001), (3, 1, 0))
    build_glb(tmp_path / "c/m.glb", tris=moved, reverse=True)
    found = failures(tmp_path / "g", tmp_path / "c")
    assert [s for _, s, _ in found] == ["MISSING"]
    assert "mesh | wall" in found[0][2] and "(2.0000, 0.0000, 0.0000)" in found[0][2]


def test_an_inverse_bind_matrix_is_compared_at_its_own_scale():
    """mp_estate's wire: t 3646 units out, so float32's -R^T t is 2e-4 from exact in its small component."""

    def skin(m):
        return {"skins": [{"name": None, "skeleton": "root", "joints": {"ropejoint53": m}}]}

    def found(g, c):
        out = []
        equiv.diff(skin(g), skin(c), "", "", equiv.GLB_RULES, lambda *row: out.append(row))
        return out

    golden = [0.0] * 12 + [-3646.6167, -0.21575215, 374.08566, 1.0]
    noise = golden[:13] + [-0.2155576] + golden[14:]
    moved = golden[:13] + [-0.2257576] + golden[14:]
    assert found(golden, noise) == []
    assert [s for s, _, _ in found(golden, moved)] == ["DIFFERS"]


def test_glb_catches_a_swapped_texture_and_a_changed_material(tmp_path):
    build_glb(tmp_path / "g/m.glb")
    build_glb(tmp_path / "c/m.glb", colour=(10, 200, 10))
    assert failures(tmp_path / "g", tmp_path / "c") == [
        ("m.glb", "DIFFERS", "materials[name=wall].pbrMetallicRoughness.baseColorTexture.image")
    ]
    build_glb(tmp_path / "c/m.glb", roughness=0.9)
    assert failures(tmp_path / "g", tmp_path / "c") == [
        ("m.glb", "DIFFERS", "materials[name=wall].pbrMetallicRoughness.roughnessFactor")
    ]


def drop_triangle(path, node_name):
    """Rewrite a GLB with the last triangle of one node's first primitive gone."""
    gltf, buf = read_glb(path)
    node = next(n for n in gltf["nodes"] if n["name"] == node_name)
    gltf["accessors"][gltf["meshes"][node["mesh"]]["primitives"][0]["indices"]]["count"] -= 3
    write_glb(path, gltf, buf)


def test_collision_moved_into_a_mode_only_part_is_not_a_loss_and_a_dropped_one_is(tmp_path):
    for side in ("g", "c", "dump/g", "dump/c"):
        (tmp_path / side).mkdir(parents=True)
    export_collision(restricted_clipmap(tmp_path / "dump/g"), str(tmp_path / "g/collision.glb"), placed(None))
    export_collision(restricted_clipmap(tmp_path / "dump/c"), str(tmp_path / "c/collision.glb"), placed(["sd"]))
    found = findings(tmp_path / "g", tmp_path / "c")
    assert [f for f in found if f[1] in equiv.FAILURES] == []
    # The part list is news, not a difference.
    assert found == [("collision.glb", "EXTRA", "parts")]

    drop_triangle(tmp_path / "c/collision.glb", "part:*1/solid")
    lost = failures(tmp_path / "g", tmp_path / "c")
    assert ("collision.glb", "MISSING") in {(rel, s) for rel, s, _ in lost}
    assert any(s == "MISSING" and key.startswith("primitives.solid |") for _, s, key in lost)


def test_a_drawn_mode_only_part_counts_as_the_shell_it_was_split_from(tmp_path):
    for side in ("g", "c", "dump/g", "dump/c"):
        (tmp_path / side).mkdir(parents=True)

    def shell(side, placements):
        export_shell(shell_dump(tmp_path / f"dump/{side}"), str(tmp_path / f"{side}/world.glb"), str(tmp_path / f"{side}/d"),
                     None, {}, set(), set(), {}, placements)  # fmt: skip

    shell("g", {**placed(None), **placed(None, n=2)})
    shell("c", {**placed(["gun"]), **placed(None, n=2)})
    assert findings(tmp_path / "g", tmp_path / "c") == [("world.glb", "EXTRA", "parts")]
    drop_triangle(tmp_path / "c/world.glb", "part:*1")
    assert [s for _, s, _ in failures(tmp_path / "g", tmp_path / "c")] == ["MISSING"]


def triangles(verts, tris):
    store = equiv.VertexStore(("x", "y", "z"), (1e-4,) * 3, len(verts), lambda i: verts[i])
    return equiv.TriangleSet(store, array("I", [i for t in tris for i in t]))


def test_triangle_near_misses_across_a_rounding_boundary_match():
    a = triangles([(0.00004999, 0, 0), (1, 0, 0), (0, 1, 0)], [(0, 1, 2)])
    b = triangles([(0.00005001, 0, 0), (1, 0, 0), (0, 1, 0)], [(0, 1, 2)])
    out = []
    a.diff(b, "t", lambda *f: out.append(f))
    assert out == []


def shared_buffer_glb(primitives, verts=6000, generator="a"):
    """One vertex buffer, and `primitives` primitives each indexing its own run of it: a shell's shape."""
    positions = [float(c) for v in range(verts) for c in (v % 97, v // 97, (v * 7) % 13)]
    per = verts // primitives // 3 * 3
    buf, views = bytearray(), []
    add_view(buf, views, pack("f", positions), ARRAY_BUFFER)
    accessors = [{"bufferView": 0, "componentType": 5126, "count": verts, "type": "VEC3"}]
    prims = []
    for p in range(primitives):
        add_view(buf, views, pack("I", list(range(p * per, (p + 1) * per))), ELEMENT_ARRAY_BUFFER)
        accessors.append({"bufferView": len(views) - 1, "componentType": 5125, "count": per, "type": "SCALAR"})
        prims.append({"attributes": {"POSITION": 0}, "indices": len(accessors) - 1, "material": p})
    gltf = {
        "asset": {"version": "2.0", "generator": generator},
        "nodes": [{"name": "shell", "mesh": 0}],
        "meshes": [{"primitives": prims}],
        "materials": [{"name": f"m{p}"} for p in range(primitives)],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(buf)}],
    }
    out = io.BytesIO()
    js = json.dumps(gltf).encode()
    js += b" " * (-len(js) % 4)
    bn = bytes(buf) + b"\0" * (-len(buf) % 4)
    out.write(b"glTF" + struct.pack("<II", 2, 28 + len(js) + len(bn)))
    out.write(struct.pack("<I", len(js)) + b"JSON" + js + struct.pack("<I", len(bn)) + b"BIN\0" + bn)
    return out.getvalue()


def comparison_peak(primitives):
    golden, candidate = shared_buffer_glb(primitives), shared_buffer_glb(primitives, generator="b")
    tracemalloc.start()
    out = []
    equiv.diff(equiv.flatten_glb(golden), equiv.flatten_glb(candidate), "", "", equiv.GLB_RULES, lambda *f: out.append(f))
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert out == []
    return peak


def test_glb_memory_grows_with_the_buffer_not_with_primitives_times_buffer():
    # 200 primitives over one buffer once cost 200 copies of it (23 GB on a real shell).
    # Bounded in copies of the buffer rather than as a ratio of two peaks: whichever
    # call runs first fills equiv's and the interpreter's caches, a few hundred KB of
    # noise against a 72 KB buffer, so a ratio failed or passed on test order.
    comparison_peak(200)  # warm
    one, many = comparison_peak(1), comparison_peak(200)
    buffer = 6000 * 12
    assert many < one + 20 * buffer, f"peak {many} bytes over 200 primitives against {one} over one"


# -- Images and audio -----------------------------------------------------------------------------------


def test_images_compare_pixels_not_encodings(tmp_path):
    img = Image.new("RGBA", (8, 8), (1, 2, 3, 255))
    a, b = io.BytesIO(), io.BytesIO()
    img.save(a, "PNG", compress_level=1)
    img.save(b, "PNG", compress_level=9, optimize=True)
    put(tmp_path / "g", "t/lightmap.png", a.getvalue())
    put(tmp_path / "c", "t/lightmap.png", b.getvalue())
    assert findings(tmp_path / "g", tmp_path / "c") == []
    img.putpixel((3, 3), (1, 2, 4, 255))
    c = io.BytesIO()
    img.save(c, "PNG")
    put(tmp_path / "c", "t/lightmap.png", c.getvalue())
    assert failures(tmp_path / "g", tmp_path / "c") == [("t/lightmap.png", "DIFFERS", "pixels")]


def test_an_image_pairs_across_formats_by_name(tmp_path):
    img = Image.new("RGB", (4, 4), (9, 9, 9))
    a, b = io.BytesIO(), io.BytesIO()
    img.save(a, "PNG")
    img.save(b, "BMP")
    put(tmp_path / "g", "images/wall.png", a.getvalue())
    put(tmp_path / "c", "images/wall.bmp", b.getvalue())
    assert failures(tmp_path / "g", tmp_path / "c") == []


def wav(samples, extra_chunk=False):
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    data = out.getvalue()
    if extra_chunk:  # a LIST chunk before `data` is layout, not sound
        info = b"LIST" + struct.pack("<I", 4) + b"INFO"
        data = data[:36] + info + data[36:]
        data = data[:4] + struct.pack("<I", len(data) - 8) + data[8:]
    return data


def test_audio_compares_pcm_not_chunks(tmp_path):
    put(tmp_path / "g", "snd/a.wav", wav([0, 100, -100, 5]))
    put(tmp_path / "c", "snd/a.wav", wav([0, 100, -100, 5], extra_chunk=True))
    assert findings(tmp_path / "g", tmp_path / "c") == []
    put(tmp_path / "c", "snd/a.wav", wav([0, 100, -101, 5]))
    assert failures(tmp_path / "g", tmp_path / "c") == [("snd/a.wav", "DIFFERS", "audio")]


def test_audio_reads_past_a_wrong_riff_size(tmp_path):
    # OpenAssetTools' WavWriter writes a constant 36 as the RIFF size, whatever the data.
    oat = wav([0, 100, -100, 5])
    oat = oat[:4] + struct.pack("<I", 36) + oat[8:]
    put(tmp_path / "g", "snd/a.wav", oat)
    put(tmp_path / "c", "snd/a.wav", wav([0, 100, -100, 5]))
    assert findings(tmp_path / "g", tmp_path / "c") == []
    put(tmp_path / "c", "snd/a.wav", wav([0, 100, -100, 6]))
    assert failures(tmp_path / "g", tmp_path / "c") == [("snd/a.wav", "DIFFERS", "audio")]


def test_sounds_catch_a_missing_alias(tmp_path):
    aliases = {"a": {"clips": [{"file": "a.webm", "weight": 1}]}, "b": {"clips": [{"file": "b.webm", "weight": 1}]}}
    put(tmp_path / "g", "sounds/sounds.json", {"_version": 1, "aliases": aliases})
    put(tmp_path / "c", "sounds/sounds.json", {"aliases": {"b": aliases["b"], "a": aliases["a"]}, "_version": 1})
    assert findings(tmp_path / "g", tmp_path / "c") == []
    put(tmp_path / "c", "sounds/sounds.json", {"_version": 1, "aliases": {"b": aliases["b"]}})
    assert failures(tmp_path / "g", tmp_path / "c") == [("sounds/sounds.json", "MISSING", "aliases.a")]


# -- Dumps ----------------------------------------------------------------------------------------------


def gfxworld(root, verts, surfaces_tris, reverse=False):
    """A GfxWorld dump: 44-byte vertices, 16-bit indices, one surface per list of triangles."""
    order = list(range(len(verts)))
    if reverse:
        order.reverse()
    where = {v: i for i, v in enumerate(order)}
    vblob = b"".join(equiv.GFX_VERTEX.pack(*verts[v], 0, 255, 255, 255, 255, 0.5, 0.5, 0.1, 0.1, 0x7F7F7F7F, 0) for v in order)
    indices, surfaces = [], []
    for material, tris in surfaces_tris:
        if reverse:
            tris = [t[1:] + t[:1] for t in reversed(tris)]
        surfaces.append({"material": material, "baseIndex": len(indices), "firstVertex": 0, "triCount": len(tris)})
        indices += [where[v] for t in tris for v in t]
    put(root, "gw/m.gfxworld_vertices.bin", vblob)
    put(root, "gw/m.gfxworld_indices.bin", struct.pack(f"<{len(indices)}H", *indices))
    manifest = {
        "_type": "gfxworld",
        "_game": "iw5",
        "vertexStride": 44,
        "vertexCount": len(verts),
        "vertexFile": "m.gfxworld_vertices.bin",
        "indexFile": "m.gfxworld_indices.bin",
        "surfaces": surfaces,
    }
    put(root, "gw/m.gfxworld.json", manifest)


VERTS = [(0.0, 0.0, 0.0), (10.0, 0.0, 0.0), (10.0, 10.0, 0.0), (0.0, 10.0, 0.0)]
SURFACES = [("wall", [(0, 1, 2), (0, 2, 3)]), ("floor", [(0, 1, 3)])]


def test_gfxworld_ignores_blob_layout_and_catches_a_moved_vertex(tmp_path):
    gfxworld(tmp_path / "g", VERTS, SURFACES)
    gfxworld(tmp_path / "c", VERTS, SURFACES, reverse=True)
    assert findings(tmp_path / "g", tmp_path / "c") == []
    moved = list(VERTS)
    moved[2] = (10.0, 10.0, 0.5)
    gfxworld(tmp_path / "c", moved, SURFACES, reverse=True)
    found = failures(tmp_path / "g", tmp_path / "c")
    assert {s for _, s, _ in found} == {"MISSING"}
    assert all(k.startswith("surfaces[0].triangles") for _, _, k in found)


def test_infostrings_are_key_value_records(tmp_path):
    put(tmp_path / "g", "weapons/m4_mp", b"WEAPONFILE\\displayName\\M4\\fireTime\\0.1\\clip\\30")
    put(tmp_path / "c", "weapons/m4_mp", b"WEAPONFILE\\clip\\30\\displayName\\M4\\fireTime\\0.10")
    assert findings(tmp_path / "g", tmp_path / "c") == []
    put(tmp_path / "c", "weapons/m4_mp", b"WEAPONFILE\\clip\\31\\displayName\\M4\\fireTime\\0.1")
    assert failures(tmp_path / "g", tmp_path / "c") == [("weapons/m4_mp", "DIFFERS", "clip")]


def test_zone_listing_is_a_multiset(tmp_path):
    put(tmp_path / "g", "zone_source/m.zone", ">game,IW5\n\nxmodel,a\nimage,b\n")
    put(tmp_path / "c", "zone_source/m.zone", ">game,IW5\nimage,b\nxmodel,a\n")
    assert findings(tmp_path / "g", tmp_path / "c") == []


def test_tree_reports_missing_and_extra_files(tmp_path):
    put(tmp_path / "g", "a.gsc", "main() {}\n")
    put(tmp_path / "g", "b.gsc", "x\n")
    put(tmp_path / "c", "a.gsc", "main() {}\r\n")
    put(tmp_path / "c", "c.gsc", "y\n")
    report = equiv.compare_trees(str(tmp_path / "g"), str(tmp_path / "c"))
    assert report.files == {"b.gsc": [("MISSING", "(file)", "")], "c.gsc": [("EXTRA", "(file)", "")]}
    assert report.failed
