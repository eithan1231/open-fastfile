import collections
import json
import re
import struct
from pathlib import Path

import pytest

from scripts.cod.collision import (
    CONTENTS_BITS_BY_GAME,
    CONTENTS_BITS_IW,
    CONTENTS_BITS_IW6,
    CONTENTS_BITS_T6,
    ENGINE_SURFACES,
    SOUP_CLIPS_COLLIDE_BY_GAME,
    SOUP_STOPS_BY_GAME,
    blocks,
    blocks_player,
    brush_triangles,
    export_collision,
    group_of,
    soup_role,
    surface_of,
)
from scripts.cod.gltf import glb_bounds, pack, read_glb, write_glb
from scripts.cod.shell import (
    VERTEX,
    VERTEX_STRIDE,
    check_winding,
    decode_layers,
    decode_vertices,
    export_shell,
    layer_stride,
    measured_strides,
    neutralise_generated,
    unpack_unit_vec,
)
from scripts.cod.units import UNITS_PER_M, to_engine

ROOT = Path(__file__).resolve().parents[3]


def test_to_engine_is_a_rotation_not_a_reflection():
    # So winding is reversed for Direct3D's clockwise fronts, not for the axis change.
    x, y, z = ([c * UNITS_PER_M for c in to_engine(v)] for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    cross = (x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0])
    assert cross == pytest.approx(z)


def test_unpack_unit_vec_scale_byte():
    # Byte 3 == 63 makes the scale exactly 1/127.
    packed = (127 + 127) | (127 << 8) | (127 << 16) | (63 << 24)
    assert unpack_unit_vec(packed) == pytest.approx([1.0, 0.0, 0.0])


def test_check_winding():
    pos = [0, 0, 0, 1, 0, 0, 0, 0, 1]
    up = [0, 1, 0] * 3
    down = [0, -1, 0] * 3
    assert check_winding(pos, up, {"m": [0, 2, 1]}) == 1.0
    assert check_winding(pos, down, {"m": [0, 2, 1]}) == 0.0


def test_box_brush_has_twelve_triangles_inside_its_bounds():
    brush = {"bounds": {"midPoint": [0, 0, 0], "halfSize": [1, 2, 3]}, "sides": []}
    tris = brush_triangles(brush)
    assert len(tris) == 12
    for tri in tris:
        for x, y, z in tri:
            assert abs(x) <= 1 + 1e-9 and abs(y) <= 2 + 1e-9 and abs(z) <= 3 + 1e-9


def test_bevel_plane_cuts_a_corner():
    # A bevel across the +x+y edge adds a face and turns top and bottom into
    # pentagons: 2 (bevel) + 3 + 3 (pentagons) + 4 x 2 (the four sides) = 16.
    s = 2**-0.5
    brush = {"bounds": {"midPoint": [0, 0, 0], "halfSize": [1, 1, 1]}, "sides": [{"normal": [s, s, 0], "dist": 1.0}]}
    assert len(brush_triangles(brush)) == 16


def test_contents():
    assert group_of(0x08000001) == "solid"
    assert group_of(0x08010000) == "clip:0x08010000"
    assert blocks(0x08010000, CONTENTS_BITS_IW) == ["player", "detail"]
    assert soup_role(None) == "ground"
    assert soup_role(0x20) == "water"
    assert soup_role(0x20000) == "soup-clip"
    assert soup_role(0x2080) == "ground"


def test_glb_round_trip_and_bounds(tmp_path):
    positions = struct.pack("<6f", 0, 0, 0, 1, 2, 3)
    gltf = {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "scale": [2, 2, 2]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 2, "type": "VEC3", "min": [0, 0, 0], "max": [1, 2, 3]}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(positions)}],
        "buffers": [{"byteLength": len(positions)}],
    }
    path = tmp_path / "a.glb"
    size = write_glb(path, gltf, bytearray(positions))
    assert size == path.stat().st_size and size % 4 == 0
    back, buf = read_glb(path)
    assert back == gltf and bytes(buf[: len(positions)]) == positions
    assert glb_bounds(path) == pytest.approx([2, 4, 6])


def test_pack_matches_struct_pack_byte_for_byte():
    # P16: buffer views are built with array.tobytes() rather than a splatted
    # struct.pack, which for a 400k-triangle mesh boxed 3.6M floats twice over.
    # The bytes on disk must not move, odd floats included.
    floats = [0.0, -0.0, 1.5, -2.25e10, 1e-45, 3.4e38, float("inf"), float("-inf"), float("nan")]
    assert pack("f", floats) == struct.pack(f"<{len(floats)}f", *floats)
    assert pack("I", [0, 1, 2**32 - 1]) == struct.pack("<3I", 0, 1, 2**32 - 1)
    assert pack("H", [0, 513, 65535]) == struct.pack("<3H", 0, 513, 65535)
    assert pack("B", [0, 7, 255]) == struct.pack("<3B", 0, 7, 255)
    assert pack("f", []) == b""


def test_decode_vertices_reads_each_field_from_its_own_offset():
    # P18: one compiled Struct over the whole blob replaced five `unpack_from`
    # calls per vertex. A format that drifted by a byte would decode plausible
    # rubbish from the neighbouring field and still render, so pin the offsets:
    # every value below is distinct.
    assert VERTEX.size == VERTEX_STRIDE
    packed_normal = (127 + 127) | (127 << 8) | (127 << 16) | (63 << 24)  # +x, scale 1/127
    vertex = (
        struct.pack("<3f", 100.0, 200.0, 300.0)  # position, CoD units
        + b"\xde\xad\xbe\xef"  # 4 bytes this exporter does not read
        + bytes([10, 20, 30, 40])  # RGBA
        + struct.pack("<2f", 0.25, 0.5)  # UV
        + struct.pack("<2f", 0.75, 0.125)  # lightmap UV
        + struct.pack("<I", packed_normal)
        + b"\x01\x02\x03\x04"  # 4 more unread bytes
    )
    pos, nrm, uv, lmp, col = decode_vertices(vertex * 2, 2, "iw5")

    assert pos == pytest.approx([100 / UNITS_PER_M, 300 / UNITS_PER_M, -200 / UNITS_PER_M] * 2)
    assert nrm == pytest.approx([1.0, 0.0, 0.0] * 2)
    assert uv == pytest.approx([0.25, 0.5] * 2)
    assert lmp == pytest.approx([0.75, 0.125] * 2)
    assert col == [10, 20, 30, 40] * 2
    # Black Ops' plain surfaces keep their tint; only a layered surface's weights are whitened.
    assert decode_vertices(vertex, 1, "t5")[4] == [10, 20, 30, 40]
    col = [10, 20, 30, 40] * 2
    layered = {"material": "*1n_2(a:b)", "baseIndex": 0, "firstVertex": 1, "triCount": 1}
    assert neutralise_generated(col, [layered], [0, 0, 0], "t5") == 1
    assert col == [10, 20, 30, 40, 255, 255, 255, 255]


def test_layer_stride_counts_uvs_and_normal_mapped_tangents():
    assert layer_stride("*10n_13(a:b)") == 8
    assert layer_stride("*16n_18n(a:b)") == 12
    assert layer_stride("*2n_18n_42(a:b:c)") == 20
    assert layer_stride("wc/concrete") is None


def test_decode_layers_reads_each_vertex_by_its_index_and_weights_from_bgra():
    # Two vertices of one `*1n_2_3n` surface: layers 1 and 2 each a UV, then layer 2's tangent.
    def vertex(colour):
        return struct.pack("<3f", 0, 0, 0) + bytes(4) + bytes(colour) + bytes(VERTEX_STRIDE - 20)

    verts = vertex([0, 0, 0, 0]) * 3 + vertex([51, 102, 0, 255]) + vertex([255, 0, 0, 0])
    assert layer_stride("*1n_2_3n(a:b:c)") == 20
    layer_data = bytes(4)  # the surface's data starts after another's
    layer_data += struct.pack("<4f", 0.5, 1.5, 2.5, 3.5) + bytes(4)
    layer_data += struct.pack("<4f", -1.0, -2.0, -3.0, -4.0) + bytes(4)
    states = {"*1n_2_3n(a:b:c)": {"layers": [{"mode": "blend"}, {"mode": "multiply"}]}}
    surface = {
        "material": "*1n_2_3n(a:b:c)",
        "firstVertex": 3,
        "vertexCount": 2,
        "triCount": 1,
        "baseIndex": 0,
        "vertexLayerData": 4,
    }

    layers = decode_layers({"vertexCount": 5, "surfaces": [surface]}, verts, layer_data, [1, 0, 1], states)

    # Layer 1's weight is byte 1 (COLOR0.y), layer 2's byte 0 (COLOR0.z): D3DCOLOR is BGRA.
    assert layers[1][9:] == pytest.approx([0.5, 1.5, 0.4, -1.0, -2.0, 0.0])
    assert layers[2][9:] == pytest.approx([2.5, 3.5, 0.2, -3.0, -4.0, 1.0])
    assert layers[1][:9] == [0.0] * 9  # vertices no layered surface uses


def test_the_layer_stride_is_measured_where_the_name_misspells_it():
    # `*30_166n` names a tangent its data does not hold: 8 bytes a vertex, not 12.
    surfaces = [
        {"material": "*30_166n(a:b)", "firstVertex": 10, "vertexCount": 4, "vertexLayerData": 100},
        {"material": "*16n_18n(a:b)", "firstVertex": 20, "vertexCount": 2, "vertexLayerData": 132},
        {"material": "wc/plain", "firstVertex": 0, "vertexCount": 9, "vertexLayerData": 0},
    ]
    assert measured_strides(surfaces, 156) == {100: 8, 132: 12}


# -- Ghosts (IW6) ---------------------------------------------------------------


def test_ghosts_contents_bits_are_the_engines_own_infoparms():
    # From `infoParms[]` in the Durango server build: four of IW's guessed
    # labels are wrong, and the two the pipeline decides on are the same.
    assert blocks(0x08031640, CONTENTS_BITS_IW6) == ["canshoot", "vehicle", "item", "nosight", "player", "ai", "detail"]
    assert blocks(0x08031640, CONTENTS_BITS_IW) == ["projectile", "vehicle", "sight", "sight2", "player", "ai", "detail"]
    assert blocks(0x09000000, CONTENTS_BITS_IW6) == ["mantle", "detail"]
    assert blocks(0x00000020, CONTENTS_BITS_IW6) == ["water"]
    assert group_of(0x08031640) == "clip:0x08031640"
    assert not blocks_player(0x00002080)  # clipshot + clipmissile: a bullet shell, not a wall


def test_ghosts_advanced_warfare_and_black_ops_ii_collide_with_a_soup_surface_that_blocks_the_player():
    assert SOUP_CLIPS_COLLIDE_BY_GAME == {
        "iw4": False,
        "iw5": False,
        "t5": False,
        "t6": True,
        "iw6": True,
        "s1": True,
        "t9": False,
    }
    assert soup_role(0x00031640, clips_collide=True) == "clip"  # a curved invisible wall
    assert soup_role(0x00031640) == "soup-clip"
    # Stopping only AI or vehicles is still not a wall, whatever the game.
    assert soup_role(0x00020000, clips_collide=True) == "soup-clip"
    assert soup_role(0x00000200, clips_collide=True) == "soup-clip"
    assert soup_role(0x00010020, clips_collide=True) == "water"  # water wins, as it does everywhere


def test_black_ops_ii_soup_is_what_its_players_and_bullets_are_stopped_by():
    """T6's player mask 0x2818011 (ClientThink_real 0x5bf69a) and bullet mask 0x280e833
    (Bullet_Trace 0x5aca50), reverse/t6-traversal/verify.py."""
    stops = SOUP_STOPS_BY_GAME["t6"]
    assert stops == (0x02818011, 0x0280E833)
    assert soup_role(0x00000001, True, stops) == "ground"
    assert soup_role(0x00000010, True, stops) == "ground"  # glass stops both
    assert soup_role(0x00030200, True, stops) == "clip"  # the nodraw player clip round a map
    assert soup_role(0x00030200, False, stops) == "soup-clip"
    # A wet floor that is player clip is a floor: mp_raid's `_dripping` tiles.
    assert soup_role(0x000322A0, True, stops) == "ground"
    assert soup_role(0x00000020, True, stops) == "water"
    assert soup_role(0x000020A0, True, stops) == "water"
    # Neither: clip_physics (itemclip), missile-only, AI-only, vehicle-only.
    for contents in (0x00000400, 0x00000080, 0x00020000, 0x00000200):
        assert soup_role(contents, True, stops) == "soup-clip"
    # Bullets only: the engine has no tree for that, so it stays ground.
    assert soup_role(0x00002080, True, stops) == "ground"
    assert soup_role(None, True, stops) == "ground"
    # No other game's masks have been read, so none of their soup changes.
    assert set(SOUP_STOPS_BY_GAME) == {"t6"}


def test_black_ops_ii_contents_are_its_own_infoparms():
    # infoParms[] in the T6 dedicated server, 0xdd62c0.
    assert blocks(0x00002080, CONTENTS_BITS_T6) == ["missile", "clipshot"]
    assert blocks(0x00000400, CONTENTS_BITS_T6) == ["item"]
    assert blocks(0x09000000, CONTENTS_BITS_T6) == ["mantle", "detail"]
    assert blocks(0x00030600, CONTENTS_BITS_T6) == ["vehicle", "item", "player", "ai"]


#: Two soup triangles: one in vertex segment 0 and one in segment 1, whose
#: 16-bit indices only reach their vertices once the segment is added back.
SEGMENTED_TRIS = ((0, 1, 2), (3, 4, 5))
SEGMENTS = (0, 1)


def segmented_clipmap(tmp_path, game="iw6"):
    """A clipmap dump of 1030 collision vertices in two partitions, the second rebased."""
    vert_count = 1024 + 6
    verts = []
    for v in range(vert_count):
        verts += [float(v), 0.0, float(v % 7)]  # distinct per vertex, so a mis-index shows
    (tmp_path / "m.clipmap_verts.bin").write_bytes(struct.pack(f"<{vert_count * 3}f", *verts))
    (tmp_path / "m.clipmap_tris.bin").write_bytes(struct.pack("<6H", *SEGMENTED_TRIS[0], *SEGMENTED_TRIS[1]))
    manifest = {
        "_game": game,
        "name": "m",
        "vertCount": vert_count,
        "triCount": 2,
        "vertFile": "m.clipmap_verts.bin",
        "triFile": "m.clipmap_tris.bin",
        "materials": [
            {"name": "ground", "surfaceFlags": 0, "contents": 0x1},
            {"name": "clip_nosight_rock", "surfaceFlags": 0x000440A0, "contents": 0x00031640},
        ],
        "brushes": [],
        "cmodels": [{"brushes": [], "partitions": []}],
        "partitions": [
            {"triCount": 1, "borderCount": 0, "firstVertSegment": SEGMENTS[0], "firstTri": 0},
            {"triCount": 1, "borderCount": 0, "firstVertSegment": SEGMENTS[1], "firstTri": 1},
        ],
        "aabbTrees": [
            {"materialIndex": 0, "childCount": 0, "partition": 0},
            {"materialIndex": 1, "childCount": 0, "partition": 1},
        ],
    }
    path = tmp_path / "m.clipmap.json"
    path.write_text(json.dumps(manifest))
    return str(path)


def read_groups(path):
    gltf, _ = read_glb(path)
    return {node["name"]: node["extras"] for node in gltf["nodes"]}


def test_a_ghosts_soup_triangle_is_rebased_by_its_partitions_vertex_segment(tmp_path, capsys):
    out = str(tmp_path / "collision.glb")
    export_collision(segmented_clipmap(tmp_path), out, {})
    gltf, buf = read_glb(out)
    view = gltf["bufferViews"][0]
    positions = struct.unpack_from(f"<{view['byteLength'] // 4}f", buf, view.get("byteOffset", 0))
    # The second triangle's indices are 3, 4, 5 in segment 1, so vertices 1027-1029.
    # Read without the segment they would be vertices 3-5, which are elsewhere.
    xs = {round(positions[i * 3] * UNITS_PER_M) for i in range(len(positions) // 3)}
    assert xs == {0, 1, 2, 1027, 1028, 1029}
    assert "1 past the 16-bit index range" in capsys.readouterr().out.replace(",", "")


def test_a_ghosts_soup_clip_is_a_wall_and_a_black_ops_one_is_not(tmp_path):
    ghosts = str(tmp_path / "ghosts.glb")
    export_collision(segmented_clipmap(tmp_path), ghosts, {})
    groups = read_groups(ghosts)
    assert groups["soup"]["collides"] is True
    assert groups["clip:soup:0x00031640"]["collides"] is True
    assert groups["clip:soup:0x00031640"]["blocks"] == ["canshoot", "vehicle", "item", "nosight", "player", "ai"]

    black_ops = tmp_path / "t5"
    black_ops.mkdir()
    for name in ("m.clipmap_verts.bin", "m.clipmap_tris.bin"):
        (black_ops / name).write_bytes((tmp_path / name).read_bytes())
    out = str(tmp_path / "t5.glb")
    export_collision(segmented_clipmap(black_ops, game="t5"), out, {})
    assert read_groups(out)["clip:soup:0x00031640"]["collides"] is False


# -- Surface types --------------------------------------------------------------


def test_surface_type_is_the_flags_five_bit_field_at_bit_20():
    # Round-tripped against OpenAssetTools' IW4 `infoParms[]`, whose surfaceFlags
    # for each surface keyword is exactly `index << 20`.
    for flags, name in ((0x100000, "bark"), (0xB00000, "gravel"), (0x1C00000, "paintedmetal"), (0x1D00000, "riotshield")):
        assert ENGINE_SURFACES[surface_of(flags, "iw5")] == name
    # The rest of a face's flags is other infoparms and must not disturb it:
    # 0x000440b8 is a ladder material (ladder + noimpact + nomarks + nodraw + nocastshadow).
    assert ENGINE_SURFACES[surface_of(0x000440B8, "iw5")] == "default"
    assert ENGINE_SURFACES[surface_of(0xD40000, "iw5")] == "metal"
    # Black Ops reads the same field against a different table at its last two
    # entries: 29 is `player` there and `riotshield` on IW.
    assert ENGINE_SURFACES[surface_of(0x1D00000, "t5")] == "player"
    assert ENGINE_SURFACES[surface_of(0x1E00000, "t5")] == "tallgrass"
    assert surface_of(0x1D00000, "nosuchgame") == 0


def test_advanced_warfares_surface_type_field_is_six_bits_against_its_own_table():
    # Its `infoParms[]` (the X360 server build, reverse/s1-zone/README.md) names 52
    # surface keywords, the last `cushion` at 0x03400000, so the field runs to bit
    # 25. Read at five bits against IW's table, none of these is the surface it is.
    for flags, name, as_iw in (
        (0x00E00000, "metal", "mud"),  # metal_grate, inserted at 14
        (0x01500000, "water", "wood"),  # water_waist
        (0x01700000, "asphalt", "ceramic"),
        (0x02D00000, "rock", "metal"),  # rock_wet: past IW's table, and its five bits wrap
        (0x03400000, "cushion", "water"),  # cushion, which five bits cannot reach
    ):
        assert ENGINE_SURFACES[surface_of(flags, "s1")] == name
        assert ENGINE_SURFACES[surface_of(flags, "iw5")] == as_iw
    # A ladder material's other flags still leave the type alone (ladder is 0x8 there too).
    assert ENGINE_SURFACES[surface_of(0x000440B8, "s1")] == "default"


def test_advanced_warfares_contents_bits_are_ghostss_own():
    # The same `infoParms[]` names every contents bit, and names each one Ghosts
    # does. mp_prison's own `clip_nosight` material carries exactly this.
    assert CONTENTS_BITS_BY_GAME["s1"] is CONTENTS_BITS_IW6
    assert blocks(0x08031640, CONTENTS_BITS_BY_GAME["s1"]) == [
        "canshoot",
        "vehicle",
        "item",
        "nosight",
        "player",
        "ai",
        "detail",
    ]
    # `clip_block_spawn_traces` is 0x4, which IW4/IW5 guessed as `camera`.
    assert blocks(0x00000004, CONTENTS_BITS_BY_GAME["s1"]) == ["aideath"]


def test_an_advanced_warfare_soup_clip_is_a_wall(tmp_path):
    # As on Ghosts: 5,336 of mp_prison's 65,739 soup triangles are clip, most of
    # them `clip_nosight_metal` and `clip_nosight_rock` over railings and rock.
    assert SOUP_CLIPS_COLLIDE_BY_GAME["s1"] is True
    out = str(tmp_path / "s1.glb")
    export_collision(segmented_clipmap(tmp_path, game="s1"), out, {})
    assert read_groups(out)["clip:soup:0x00031640"]["collides"] is True


def test_the_engine_surface_list_is_the_one_the_engine_has():
    # The .glb stores an index into this list, so a shift on either side renames
    # every surface on every map. Read the TypeScript rather than restating it.
    src = (ROOT / "packages/shared/src/sim/surfaces.ts").read_text()
    body = src.split("export const SURFACE_TYPES = [", 1)[1].split("] as const", 1)[0]
    assert tuple(re.findall(r'"([a-z]+)"', body)) == ENGINE_SURFACES


def surfaced_clipmap(tmp_path, game="iw5"):
    """A clipmap of one box brush whose six axial faces are three different materials."""
    manifest = {
        "_game": game,
        "name": "s",
        "vertCount": 0,
        "triCount": 0,
        "materials": [
            {"name": "caulk", "surfaceFlags": 0, "contents": 0x1},
            {"name": "floor_metal", "surfaceFlags": 0xD00000, "contents": 0x1},
            {"name": "wall_wood", "surfaceFlags": 0x1500000, "contents": 0x1},
        ],
        # axialMaterialNum is [min faces, max faces], each x y z.
        "brushes": [
            {
                "contents": 0x1,
                "bounds": {"midPoint": [0, 0, 0], "halfSize": [64, 64, 64]},
                "axialMaterialNum": [[2, 2, 0], [2, 2, 1]],
                "sides": [],
            }
        ],
        "cmodels": [{"brushes": [0], "partitions": []}],
        "partitions": [],
        "aabbTrees": [],
    }
    path = tmp_path / "s.clipmap.json"
    path.write_text(json.dumps(manifest))
    return str(path)


def test_a_brush_carries_a_surface_per_face_and_every_triangle_agrees_with_itself(tmp_path, capsys):
    out = str(tmp_path / "s.glb")
    export_collision(surfaced_clipmap(tmp_path), out, {})
    gltf, buf = read_glb(out)
    primitive = gltf["meshes"][0]["primitives"][0]
    surface_acc = gltf["accessors"][primitive["attributes"]["_SURFACE"]]
    assert surface_acc["componentType"] == 5121 and surface_acc["type"] == "SCALAR"
    view = gltf["bufferViews"][surface_acc["bufferView"]]
    surfaces = struct.unpack_from(f"<{surface_acc['count']}B", buf, view.get("byteOffset", 0))
    index_acc = gltf["accessors"][primitive["indices"]]
    iview = gltf["bufferViews"][index_acc["bufferView"]]
    indices = struct.unpack_from(f"<{index_acc['count']}I", buf, iview.get("byteOffset", 0))

    seen = collections.Counter()
    for t in range(len(indices) // 3):
        a, b, c = indices[t * 3 : t * 3 + 3]
        # The weld keeps a vertex's surface part of its identity, so a triangle
        # never straddles two. The engine reads only the first vertex.
        assert surfaces[a] == surfaces[b] == surfaces[c]
        seen[ENGINE_SURFACES[surfaces[a]]] += 1
    # +y is the metal top (2 triangles); -y and the four sides are caulk and wood.
    assert seen == {"wood": 8, "default": 2, "metal": 2}
    assert "surfaces: 3 type(s)" in capsys.readouterr().out


# -- Mode-restricted brush models -------------------------------------------------


def restricted_clipmap(tmp_path, extra_cmodels=0):
    """A world box, a solid and a clip brush of brush model *1, and a soup triangle each side."""
    verts = [0.0, 0.0, 0.0, 64.0, 0.0, 0.0, 0.0, 64.0, 0.0, 0.0, 0.0, 128.0, 64.0, 0.0, 128.0, 0.0, 64.0, 128.0]
    (tmp_path / "r.clipmap_verts.bin").write_bytes(struct.pack("<18f", *verts))
    (tmp_path / "r.clipmap_tris.bin").write_bytes(struct.pack("<6H", 0, 1, 2, 3, 4, 5))
    box = {"contents": 0x1, "axialMaterialNum": [[0, 0, 0], [0, 0, 0]], "sides": []}
    manifest = {
        "_game": "iw5",
        "name": "r",
        "vertCount": 6,
        "triCount": 2,
        "vertFile": "r.clipmap_verts.bin",
        "triFile": "r.clipmap_tris.bin",
        "materials": [{"name": "caulk", "surfaceFlags": 0, "contents": 0x1}],
        "brushes": [
            {**box, "bounds": {"midPoint": [0, 0, 0], "halfSize": [64, 64, 64]}},
            {**box, "bounds": {"midPoint": [0, 0, 0], "halfSize": [32, 32, 32]}},
            {**box, "contents": 0x00010000, "bounds": {"midPoint": [0, 0, 64], "halfSize": [8, 8, 8]}},
        ],
        "cmodels": [{"brushes": [], "partitions": []}, {"brushes": [1, 2], "partitions": [1]}]
        + [{"brushes": [], "partitions": []}] * extra_cmodels,
        "partitions": [{"triCount": 1, "firstTri": 0}, {"triCount": 1, "firstTri": 1}],
        "aabbTrees": [],
    }
    path = tmp_path / "r.clipmap.json"
    path.write_text(json.dumps(manifest))
    return str(path)


def placed(modes, n=1, entity=7):
    where = {"n": n, "source": "entity", "classname": "script_brushmodel", "origin": (512.0, 0.0, 0.0)}
    return {n: {**where, "rotation": None, "solid": True, "entity": entity, "modes": modes}}


def mesh_triangles(path):
    """({node name: sorted world-space triangles}, the scene's extras, {node name: its extras})."""
    gltf, buf = read_glb(path)
    acc = gltf["accessors"][0]
    pos = struct.unpack_from(f"<{acc['count'] * 3}f", buf, gltf["bufferViews"][acc["bufferView"]].get("byteOffset", 0))
    out = {}
    for node in gltf["nodes"]:
        index_acc = gltf["accessors"][gltf["meshes"][node["mesh"]]["primitives"][0]["indices"]]
        view = gltf["bufferViews"][index_acc["bufferView"]]
        idx = struct.unpack_from(f"<{index_acc['count']}I", buf, view.get("byteOffset", 0))
        tris = [tuple(round(pos[i * 3 + k], 4) for i in idx[t : t + 3] for k in range(3)) for t in range(0, len(idx), 3)]
        out[node["name"]] = sorted(tris)
    return out, gltf["scenes"][0].get("extras"), {n["name"]: n["extras"] for n in gltf["nodes"]}


def test_a_brush_model_only_some_modes_have_is_its_own_part_and_loses_no_triangle(tmp_path):
    merged, split = str(tmp_path / "merged.glb"), str(tmp_path / "split.glb")
    export_collision(restricted_clipmap(tmp_path), merged, placed(None))
    export_collision(restricted_clipmap(tmp_path), split, placed(["gun", "hlnd", "oic", "shrp"]))
    before, before_scene, _ = mesh_triangles(merged)
    after, scene, extras = mesh_triangles(split)

    # Every triangle is still there, in the same place: only the meshes moved.
    assert sorted(t for ts in before.values() for t in ts) == sorted(t for ts in after.values() for t in ts)
    assert before_scene is None and list(before) == ["solid", "soup", "clip:0x00010000"]
    assert list(after) == ["solid", "soup", "part:*1/solid", "part:*1/soup", "part:*1/clip:0x00010000"]
    for name in ("part:*1/solid", "part:*1/soup", "part:*1/clip:0x00010000"):
        assert extras[name]["part"] == "*1" and extras[name]["entity"] == 7
        assert extras[name]["group"] == name.split("/", 1)[1]
    assert extras["part:*1/clip:0x00010000"]["brushStarts"] == [0]
    assert "part" not in extras["solid"]
    parts_total = sum(len(after[n]) for n in after if n.startswith("part:"))
    assert scene == {"parts": [{"part": "*1", "triangles": parts_total}]}
    assert len(after["solid"]) + len(after["soup"]) + parts_total == sum(len(ts) for ts in before.values())


def test_a_restricted_brush_model_with_nothing_that_blocks_is_still_listed(tmp_path):
    out = str(tmp_path / "c.glb")
    export_collision(restricted_clipmap(tmp_path, extra_cmodels=1), out, {**placed(["sd"]), **placed(["dd"], n=2, entity=8)})
    _, scene, _ = mesh_triangles(out)
    assert scene["parts"][1] == {"part": "*2", "triangles": 0}


def monsterclip_clipmap(tmp_path, ai_only=True):
    """Black Ops: a world solid, a world player clip, and monsterclip in the world and in brush model *1.

    With `ai_only` False the monsterclip brushes are a bullet shell (0x2080) instead,
    which stops neither, so the export is what it was before AI-only clip was written.
    """
    box = {"axialSurfaceFlags": [[0, 0, 0], [0, 0, 0]], "sides": []}
    monster = 0x08020000 if ai_only else 0x2080
    manifest = {
        "_game": "t5",
        "name": "z",
        "vertCount": 0,
        "triCount": 0,
        "materials": [],
        "brushes": [
            {**box, "contents": 0x1, "bounds": {"midPoint": [0, 0, 0], "halfSize": [64, 64, 8]}},
            {**box, "contents": 0x08030200, "bounds": {"midPoint": [0, 0, 64], "halfSize": [8, 8, 8]}},
            {**box, "contents": monster, "bounds": {"midPoint": [128, 0, 64], "halfSize": [8, 8, 8]}},
            {**box, "contents": monster, "bounds": {"midPoint": [0, 0, 0], "halfSize": [4, 20, 36]}},
        ],
        "cmodels": [{"brushes": [], "partitions": []}, {"brushes": [3], "partitions": []}],
        "partitions": [],
        "aabbTrees": [],
    }
    path = tmp_path / f"z{int(ai_only)}.clipmap.json"
    path.write_text(json.dumps(manifest))
    return str(path)


def test_monsterclip_is_written_as_its_own_group_that_no_player_collides_with(tmp_path):
    before, after = str(tmp_path / "before.glb"), str(tmp_path / "after.glb")
    window = {1: {**placed(None)[1], "dynamic_path": True}}  # a DYNAMICPATH script_brushmodel
    export_collision(monsterclip_clipmap(tmp_path, ai_only=False), before, window)
    export_collision(monsterclip_clipmap(tmp_path), after, window)
    old, old_scene, _ = mesh_triangles(before)
    new, scene, extras = mesh_triangles(after)

    # A window's climb-in clip is a part now, with triangles, in a group the AI channel reads.
    assert list(new) == ["solid", "clip:0x08030200", "clip:0x08020000", "part:*1/clip:0x08020000"]
    for name in ("clip:0x08020000", "part:*1/clip:0x08020000"):
        assert extras[name]["collides"] is False
        assert extras[name]["blocks"] == ["ai", "detail"]
        assert len(new[name]) == 12 and extras[name]["brushes"] == 1
    assert extras["part:*1/clip:0x08020000"]["part"] == "*1"
    assert scene == {"parts": [{"part": "*1", "triangles": 12}]}
    # What stops a player is exactly what it was.
    assert extras["clip:0x08030200"]["collides"] is True and "ai" in extras["clip:0x08030200"]["blocks"]
    assert {k: v for k, v in new.items() if extras[k]["collides"]} == old
    assert old_scene == {"parts": [{"part": "*1", "triangles": 0}]}


def shell_dump(tmp_path):
    """A GfxWorld of three one-triangle surfaces: the world's, brush model *1's and *2's (a decal)."""
    normal = 0x3DFF7F7F  # +z: (255 - 127) * (0x3d + 192) / 32385 = 1
    tri = [(0.0, 0.0, 0.0), (64.0, 0.0, 0.0), (0.0, 64.0, 0.0)]
    verts = b"".join(VERTEX.pack(*p, 255, 255, 255, 255, 0.0, 0.0, 0.0, 0.0, normal) for _ in range(3) for p in tri)
    (tmp_path / "w.gfxworld_vertices.bin").write_bytes(verts)
    (tmp_path / "w.gfxworld_indices.bin").write_bytes(struct.pack("<9H", 0, 1, 2, 3, 4, 5, 6, 7, 8))
    surface = {"triCount": 1, "firstVertex": 0}
    manifest = {
        "_game": "iw5",
        "vertexCount": 9,
        "vertexStride": VERTEX_STRIDE,
        "indexCount": 9,
        "indexStride": 2,
        "vertexFile": "w.gfxworld_vertices.bin",
        "indexFile": "w.gfxworld_indices.bin",
        "surfaces": [
            {**surface, "baseIndex": 0, "material": "wall"},
            {**surface, "baseIndex": 3, "material": "door"},
            {**surface, "baseIndex": 6, "material": "stain"},
        ],
        "models": [{"surfaceCount": 0, "startSurfIndex": 0}] + [{"surfaceCount": 1, "startSurfIndex": n} for n in (1, 2)],
    }
    path = tmp_path / "w.gfxworld.json"
    path.write_text(json.dumps(manifest))
    return str(path)


def test_a_drawn_brush_model_only_some_modes_have_is_a_render_part_of_its_own(tmp_path):
    placements = {**placed(["gun", "oic"]), **placed(["gun", "oic"], n=2, entity=8)}
    world, decals = str(tmp_path / "world.glb"), str(tmp_path / "decals.glb")
    export_shell(shell_dump(tmp_path), world, decals, None, {}, {"stain"}, set(), {}, placements)

    gltf, _ = read_glb(world)
    assert [n["name"] for n in gltf["nodes"]] == ["world", "part:*1"]
    assert gltf["nodes"][1]["extras"] == {"part": "*1", "group": "world"} and "extras" not in gltf["nodes"][0]
    assert gltf["scenes"][0]["extras"] == {"parts": [{"part": "*1", "triangles": 1}]}
    assert [m["name"] for m in gltf["materials"]] == ["wall", "door"]
    assert sum(gltf["accessors"][p["indices"]]["count"] for m in gltf["meshes"] for p in m["primitives"]) == 6
    # A part that is only a decal is in decals.glb alone, with no empty base mesh beside it.
    gltf, _ = read_glb(decals)
    assert [n["name"] for n in gltf["nodes"]] == ["part:*2"]
    assert gltf["scenes"][0]["extras"] == {"parts": [{"part": "*2", "triangles": 1}]}


def test_the_shell_refuses_to_lose_a_drawn_triangle(tmp_path, monkeypatch):
    import scripts.cod.shell as shell

    real = shell.build_glb
    monkeypatch.setattr(shell, "build_glb", lambda *a, **k: real(*a, **k) - 1)
    placements = {**placed(["sd"]), **placed(None, n=2)}
    with pytest.raises(SystemExit, match="triangles written of"):
        export_shell(shell_dump(tmp_path), str(tmp_path / "w.glb"), str(tmp_path / "d"), None, {}, set(), set(), {}, placements)


def test_an_unrestricted_brush_model_is_drawn_in_the_base_as_before(tmp_path):
    world, decals = str(tmp_path / "world.glb"), str(tmp_path / "decals.glb")
    export_shell(shell_dump(tmp_path), world, decals, None, {}, set(), set(), {}, {**placed(None), **placed(None, n=2)})
    gltf, _ = read_glb(world)
    assert [n["name"] for n in gltf["nodes"]] == ["world"] and "extras" not in gltf["scenes"][0]
    assert sum(gltf["accessors"][p["indices"]]["count"] for p in gltf["meshes"][0]["primitives"]) == 9
