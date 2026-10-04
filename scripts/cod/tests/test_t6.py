"""The T6 backend (scripts/cod/t6): Black Ops II's container, its pack reader and its writers.

Everything is built here, except three tests that read the installed game when it is
there (its `zone/all`, wherever cod.config.json, $COD_BO2_DIR or Steam puts it):
a small zone decrypted and walked exactly, mp_la's world vertices checked against
what a wrong layout could not satisfy, and every map's loading screen found.
"""

import glob
import hashlib
import math
import os
import random
import struct
import tracemalloc
import zlib

import pytest
from PIL import Image

from scripts.cod import export, fastfile
from scripts.cod.collision import FACE_FLAG_GAMES, face_flags
from scripts.cod.iw5.dumpers import xmodel
from scripts.cod.t6 import ff, ipak, lzo, vertices
from scripts.cod.t6.backend import Backend as T6Backend
from scripts.cod.t6.dumpers import clipmap, gfxworld, image, loadscreen, material
from scripts.cod.textures import decode_texture, export_loadscreen
from scripts.cod.zone import SPECS

from .installed import game_path
from .test_iw5_dumpers import Arr, Named, Rec, Walk

T6 = SPECS["t6"]
BO2_ZONES = game_path("bo2", "zone", "all")


# -- Salsa20 ---------------------------------------------------------------------------------------


def salsa20_reference(key, iv, length):
    """Salsa20/20 one 64-byte block at a time, as the specification writes it."""
    mask = 0xFFFFFFFF
    k, v = struct.unpack("<8I", key), struct.unpack("<2I", iv)
    out = bytearray()
    for counter in range((length + 63) // 64):
        s = [ff.SIGMA[0], *k[:4], ff.SIGMA[1], *v, counter & mask, counter >> 32, ff.SIGMA[2], *k[4:], ff.SIGMA[3]]
        x = list(s)

        def rotl(value, n):
            return ((value << n) | (value >> (32 - n))) & mask

        for _ in range(10):
            for a, b, c, d in ((0, 4, 8, 12), (5, 9, 13, 1), (10, 14, 2, 6), (15, 3, 7, 11),
                               (0, 1, 2, 3), (5, 6, 7, 4), (10, 11, 8, 9), (15, 12, 13, 14)):  # fmt: skip
                x[b] ^= rotl((x[a] + x[d]) & mask, 7)
                x[c] ^= rotl((x[b] + x[a]) & mask, 9)
                x[d] ^= rotl((x[c] + x[b]) & mask, 13)
                x[a] ^= rotl((x[d] + x[c]) & mask, 18)
        out += struct.pack("<16I", *((a + b) & mask for a, b in zip(x, s, strict=True)))
    return bytes(out[:length])


@pytest.mark.parametrize("length", [1, 63, 64, 65, 1000, 0x8000])
def test_the_many_block_keystream_is_the_block_at_a_time_one(length):
    rng = random.Random(length)
    key, iv = rng.randbytes(32), rng.randbytes(8)
    assert ff.keystream(key, iv, length) == salsa20_reference(key, iv, length)


# -- The container ---------------------------------------------------------------------------------


def encrypted_fastfile(zone, name, key, chunk=0x7000, signed=True):
    """A T6 fastfile holding `zone`: deflated per chunk, each encrypted under its stream's hash chain,
    the chunks dealt to four streams, a size word never straddling a 0x80000 boundary."""
    head = b"TAff0100" if signed else b"TAffu100"
    head += struct.pack("<I", ff.VERSION)
    if signed:
        head += ff.AUTH_MAGIC + struct.pack("<I", 0) + name.encode().ljust(32, b"\0") + bytes(256)
    blocks = bytearray()
    letters = name.encode()
    for i in range(0, ff.HASH_BLOCKS * ff.STREAMS * 20, 4):
        blocks += bytes([letters[(i // 4) % len(letters)]]) * 4
    index = [0] * ff.STREAMS
    body, pos = bytearray(), len(head)
    for n, at in enumerate(range(0, len(zone), chunk)):
        stream = n % ff.STREAMS
        packer = zlib.compressobj(level=1, wbits=-15)
        plain = packer.compress(zone[at : at + chunk]) + packer.flush()
        slot = (index[stream] * ff.STREAMS + stream) * 20
        cipher = bytes(a ^ b for a, b in zip(plain, ff.keystream(key, bytes(blocks[slot : slot + 8]), len(plain)), strict=True))
        index[stream] = (index[stream] + 1) % ff.HASH_BLOCKS
        slot = (index[stream] * ff.STREAMS + stream) * 20
        for i, byte in enumerate(hashlib.sha1(plain).digest()):
            blocks[slot + i] ^= byte
        if pos % ff.VANILLA_BUFFER + 4 > ff.VANILLA_BUFFER:
            pad = ff.VANILLA_BUFFER - pos % ff.VANILLA_BUFFER
            body += bytes(pad)
            pos += pad
        body += struct.pack("<I", len(cipher)) + cipher
        pos += 4 + len(cipher)
    if pos % ff.VANILLA_BUFFER + 4 > ff.VANILLA_BUFFER:
        body += bytes(ff.VANILLA_BUFFER - pos % ff.VANILLA_BUFFER)
    return head + bytes(body) + bytes(4) + bytes(100)


def xfile(payload):
    return struct.pack(T6.header_format, len(payload), 0, *range(len(T6.blocks))) + payload


@pytest.mark.parametrize("signed", [True, False])
def test_a_zone_decrypts_across_all_four_streams_and_past_a_size_word_boundary(tmp_path, signed):
    key = random.Random(1).randbytes(32)
    zone = xfile(random.Random(2).randbytes(0x90000))  # incompressible: the file passes 0x80000
    path = tmp_path / "mp_test.ff"
    path.write_bytes(encrypted_fastfile(zone, "mp_test", key, signed=signed))
    assert ff.is_fastfile(path)
    assert ff.read_zone(path, key) == zone


def test_a_zone_is_inflated_into_one_buffer_not_joined_from_its_pieces(tmp_path):
    # Joining the inflated pieces held a map's zone twice (docs/cod/pipeline.md#memory).
    key = random.Random(1).randbytes(32)
    zone = xfile(random.Random(2).randbytes(0x90000))
    path = tmp_path / "mp_test.ff"
    path.write_bytes(encrypted_fastfile(zone, "mp_test", key))
    ff.read_zone(path, key)  # warm
    tracemalloc.start()
    try:
        inflated = ff.read_zone(path, key)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert inflated == zone
    assert peak < 2 * len(zone), f"peak {peak} bytes for a {len(zone)}-byte zone"


def test_the_wrong_key_does_not_inflate(tmp_path):
    zone = xfile(bytes(5000))
    path = tmp_path / "mp_test.ff"
    path.write_bytes(encrypted_fastfile(zone, "mp_test", bytes(32)))
    with pytest.raises(ValueError, match="does not inflate"):
        ff.read_zone(path, bytes([1]) * 32)


def test_a_zone_shorter_than_its_header_says_is_refused(tmp_path):
    zone = xfile(bytes(5000))
    path = tmp_path / "mp_test.ff"
    path.write_bytes(encrypted_fastfile(zone[:-1], "mp_test", bytes(32)))
    with pytest.raises(ValueError, match="its header states"):
        ff.read_zone(path, bytes(32))


def test_fastfile_claims_t6_by_magic_and_version(tmp_path):
    path = tmp_path / "a.ff"
    path.write_bytes(b"TAff0100" + struct.pack("<I", ff.VERSION) + bytes(400))
    assert fastfile.claim(path).spec is T6
    path.write_bytes(b"TAff0100" + struct.pack("<I", 146) + bytes(400))
    assert fastfile.claim(path) is None


@pytest.mark.skipif(not os.path.exists(os.path.join(BO2_ZONES, "code_pre_gfx_mp.ff")), reason="Black Ops II is not installed")
def test_an_installed_zone_decrypts_and_walks_exactly():
    from scripts.cod.zonecode import walk_fastfile

    walk = walk_fastfile(os.path.join(BO2_ZONES, "code_pre_gfx_mp.ff"))
    assert walk.check() == []
    assert walk.game == "t6" and walk.assets


# -- LZO1X -----------------------------------------------------------------------------------------

END = bytes((0x11, 0, 0))


def test_lzo_literals_then_the_end_marker():
    assert lzo.decompress(bytes([17 + 5]) + b"hello" + END) == b"hello"


def test_lzo_an_m2_match_overlapping_itself():
    # 3 literals, then M2: length (0xA8 >> 5) + 1 = 6 from 1 + ((0xA8 >> 2) & 7) = 3 back.
    assert lzo.decompress(bytes([17 + 3]) + b"abc" + bytes((0xA8, 0)) + END) == b"abcabcabc"


def test_lzo_an_m3_match_with_trailing_literals_then_an_m1():
    # M3 0x22: length 2 + 2 from ((0x0A | 0 << 8) >> 2) + 1 = 3 back; the offset's low bits
    # (2) say two literals follow; then M1 0x00: two bytes from 1 back.
    stream = bytes([17 + 3]) + b"abc" + bytes((0x22, 0x0A, 0)) + b"XY" + bytes((0x00, 0x00)) + END
    assert lzo.decompress(stream) == b"abcabcaXYYY"


def test_lzo_a_long_literal_run_an_after_literal_copy_and_an_m4():
    run = random.Random(3).randbytes(16400)
    # 16400 = 3 + 15 + 255 * 64 + 62 literals, then (t < 16 after a run) three bytes from
    # 0x801 back with one literal after them, then M4 0x12: four bytes from 0x4000 + 5 back.
    stream = bytes(1 + 64) + bytes([62]) + run + bytes((0x01, 0x00)) + b"Z" + bytes((0x12, 0x14, 0x00)) + END
    out = bytearray(run)
    out += out[-0x801 : -0x801 + 3]
    out += b"Z"
    start = len(out) - 0x4005
    out += out[start : start + 4]
    assert lzo.decompress(stream) == bytes(out)


@pytest.mark.parametrize(
    ("stream", "error"),
    [
        (bytes([17 + 5]) + b"hello", "input overrun"),  # no end marker
        (bytes([17 + 5]) + b"hello" + END + b"x", "before the end"),
        (bytes([17 + 3]) + b"abc" + bytes((0xA8, 1)) + END, "before the output"),  # 11 back, 3 written
    ],
)
def test_lzo_refuses_a_malformed_stream(stream, error):
    with pytest.raises(lzo.LzoError, match=error):
        lzo.decompress(stream)


# -- .ipak -----------------------------------------------------------------------------------------


def lzo_literals(data):
    assert len(data) <= 238
    return bytes([17 + len(data)]) + data + END


def iwi27(width, height, levels):
    """A DXT1 IWI 27 with mips, and its level bytes (largest first), each level a distinct byte."""
    sizes = [ipak.level_size(0xB, width, height, k) for k in range(levels)]
    pixels = [bytes([k + 1]) * size for k, size in enumerate(sizes)]
    ends, total = [0] * 8, ipak.IWI27.size
    for k in range(levels - 1, -1, -1):
        total += sizes[k]
        ends[k] = total
    header = ipak.IWI27.pack(b"IWi", 27, 0xB, 0, width, height, 1, 1.0, *bytes(16), *ends)
    return header + b"".join(reversed(pixels)), pixels


def pack_file(entries):
    """An ipak of (nameHash, dataHash, [block commands]) entries; a command is (kind, bytes)."""
    data = bytearray()
    index = []
    for name_hash, data_hash, blocks in entries:
        start, head = len(data), 0
        for commands in blocks:
            words = [len(commands) << 24 | head] + [kind << 24 | len(raw) for kind, raw in commands]
            data += struct.pack(f"<{1 + ipak.COMMANDS}I", *words, *[0] * (ipak.COMMANDS + 1 - len(words)))
            for kind, raw in commands:
                data += raw
                head += len(lzo.decompress(raw)) if kind == ipak.LZO else 0 if kind == ipak.SKIP else len(raw)
            data += bytes(-len(data) % ipak.BLOCK)
        index.append(ipak.ENTRY.pack(data_hash, name_hash, start, len(data) - start))
    data_at = 16 + 32
    index_at = data_at + len(data)
    header = struct.pack("<4sIII", ipak.MAGIC, ipak.VERSION, 0, 2)
    header += struct.pack("<4I", ipak.DATA, data_at, len(data), len(entries))
    header += struct.pack("<4I", ipak.INDEX, index_at, 16 * len(entries), len(entries))
    return header + bytes(data) + b"".join(index)


def test_an_ipak_image_reads_its_levels_through_stored_lzo_and_skipped_commands(tmp_path):
    iwi, pixels = iwi27(16, 8, 5)
    first, rest = iwi[:100], iwi[100:]
    blocks = [
        [(ipak.STORED, first[:40]), (ipak.LZO, lzo_literals(first[40:])), (ipak.SKIP, bytes(7))],
        [(ipak.STORED, rest)],
    ]
    (tmp_path / "base.ipak").write_bytes(pack_file([(0x1234, 0x5678, blocks)]))
    packs = ipak.Packs(str(tmp_path))
    assert packs.iwi(0x1234, 0x9999) is None
    image = packs.iwi(0x1234, 0x5678)
    assert (image.width, image.height, ipak.levels(image)) == (16, 8, 5)
    assert ipak.level(image, 0) == (71, 16, 8, 1, pixels[0])
    assert ipak.level(image, 2) == (71, 4, 2, 1, pixels[2])


def test_an_ipak_iwi_whose_sizes_are_not_its_format_is_refused(tmp_path):
    iwi, _ = iwi27(16, 8, 5)
    wrong = bytearray(iwi)
    struct.pack_into("<I", wrong, ipak.IWI27.size - 32, 999)  # level 0's end
    (tmp_path / "base.ipak").write_bytes(pack_file([(1, 2, [[(ipak.STORED, bytes(wrong))]])]))
    with pytest.raises(ValueError, match="level 0 ends at 999"):
        ipak.Packs(str(tmp_path)).iwi(1, 2)


def test_an_ipak_block_that_does_not_continue_the_last_one_is_refused(tmp_path):
    iwi, _ = iwi27(16, 8, 5)
    raw = bytearray(pack_file([(1, 2, [[(ipak.STORED, iwi[:64])], [(ipak.STORED, iwi[64:])]])]))
    second = raw.index(iwi[64:]) - ipak.BLOCK
    struct.pack_into("<I", raw, second, 1 << 24 | 70)  # says it starts at output 70, not 64
    (tmp_path / "base.ipak").write_bytes(bytes(raw))
    image = ipak.Packs(str(tmp_path)).iwi(1, 2)
    with pytest.raises(ValueError, match="starts at output 70"):
        ipak.level(image, 0)


# -- Vertices --------------------------------------------------------------------------------------


def packed_unit_vec(x, y, z):
    return (x & 0x3FF) | (y & 0x3FF) << 10 | (z & 0x3FF) << 20


def test_a_t6_normal_is_three_signed_ten_bit_fields():
    assert vertices.unit_vec(packed_unit_vec(511, 0, 0)) == pytest.approx((1.0, 0.0, 0.0), abs=1e-3)
    assert vertices.unit_vec(packed_unit_vec(0, -511, 0)) == pytest.approx((0.0, -1.0, 0.0), abs=1e-3)
    n = vertices.unit_vec(packed_unit_vec(-295, 295, 295))
    assert math.sqrt(sum(c * c for c in n)) == pytest.approx(1.0, abs=2e-3)


def test_a_t6_texture_coordinate_keeps_u_in_the_low_half():
    assert vertices.tex_coords(0x3800 << 16 | 0x3C00) == (1.0, 0.5)


# -- gfxworld --------------------------------------------------------------------------------------


def vd0_vertex(x, u, v):
    uv = struct.unpack("<H", struct.pack("<e", v))[0] << 16 | struct.unpack("<H", struct.pack("<e", u))[0]
    return gfxworld.VD0.pack(x, 2.0, 3.0, -1.0, b"\xff\x80\x00\xff", uv, packed_unit_vec(511, 0, 0), 0, 0xFFFF, 0)


def world(groups, size, surfaces, vertex_count):
    """A GfxWorld stand-in: `groups` of vertices at their vd0 offsets; `surfaces` (offset, indices)."""
    vd0 = bytearray(size)
    for at, verts in groups:
        for n, vertex in enumerate(verts):
            vd0[at + n * gfxworld.VD0_STRIDE : at + (n + 1) * gfxworld.VD0_STRIDE] = vertex
    indices, records = [], []
    for offset, tris in surfaces:
        records.append(
            Rec(
                {
                    "tris.vertexDataOffset0": offset,
                    "tris.firstVertex": 12345,
                    "tris.vertexCount": 0,
                    "tris.triCount": len(tris) // 3,
                    "tris.baseIndex": len(indices),
                    "material": Named("wpc/test"),
                    "lightmapIndex": 0,
                    "flags": 16,
                }
            )
        )
        indices += tris
    return Rec(
        {
            "draw.vd0.data": Arr(data=bytes(vd0)),
            "draw.vertexDataSize0": size,
            "draw.indices": Arr(data=struct.pack(f"<{len(indices)}H", *indices)),
            "dpvs.surfaces": records,
            "surfaceCount": len(records),
            "draw.vertexCount": vertex_count,
        }
    )


def test_world_vertex_groups_become_one_iw_array_and_surfaces_point_at_their_group():
    a = [vd0_vertex(1.0, 0.5, 0.25), vd0_vertex(2.0, 1.0, 2.0)]
    b = [vd0_vertex(3.0, 0, 0), vd0_vertex(4.0, 0, 0), vd0_vertex(5.0, 0, 0)]
    # Group a is 72 bytes, padded to 80; group b ends the buffer.
    w = world([(0, a), (80, b)], 80 + 108, [(0, [0, 1, 1]), (80, [2, 0, 1]), (80, [0, 1, 0])], 5)
    surfaces, blob, _ = gfxworld.convert(w)
    assert [(s["firstVertex"], s["vertexCount"]) for s in surfaces] == [(0, 2), (2, 3), (2, 2)]
    rows = list(gfxworld.IW_VERTEX.iter_unpack(blob))
    assert [r[0] for r in rows] == [1.0, 2.0, 3.0, 4.0, 5.0]
    x, y, z, sign, rgba, u, v, lu, lv, normal, _ = rows[0]
    assert (y, z, sign, rgba, u, v, lu, lv) == (2.0, 3.0, -1.0, b"\xff\x80\x00\xff", 0.5, 0.25, 1.0, 0.0)
    assert normal == packed_unit_vec(511, 0, 0)


@pytest.mark.parametrize(
    ("groups", "size", "surfaces", "count", "error"),
    [
        ([(0, [vd0_vertex(0, 0, 0)])], 36, [(0, [0, 0, 0])], 2, "vertexCount is 2"),
        ([(0, [vd0_vertex(0, 0, 0)])], 36 + 16, [(0, [0, 0, 0])], 1, "not 36-byte vertices"),
        ([(0, [vd0_vertex(0, 0, 0)])], 36, [(0, [0, 1, 0])], 1, "reaches vertex 1 of a 1-vertex group"),
        ([(16, [vd0_vertex(0, 0, 0)])], 52, [(16, [0, 0, 0])], 1, "starts at vd0 byte 16"),
    ],
)
def test_a_world_whose_vertex_groups_do_not_add_up_is_refused(groups, size, surfaces, count, error):
    with pytest.raises(SystemExit, match=error):
        gfxworld.convert(world(groups, size, surfaces, count))


@pytest.fixture(scope="module")
def mp_la():
    if not os.path.exists(os.path.join(BO2_ZONES, "mp_la.ff")):
        pytest.skip("Black Ops II is not installed")
    from scripts.cod.zonecode import walk_fastfile

    return walk_fastfile(os.path.join(BO2_ZONES, "mp_la.ff"))


def test_mp_las_world_vertices_are_where_the_world_is_and_face_where_their_normals_do(mp_la):
    """What a wrong stride or field order could not satisfy: every position inside the world's
    bounds, every normal and tangent unit length and the two perpendicular, and every triangle
    wound against its vertex normal (CoD's winding, which shell.py reverses)."""
    record = mp_la.by_type("gfxworld")[0].record
    surfaces, blob, index_bytes = gfxworld.convert(record)
    lo, hi = record.unpack("<3f", "mins"), record.unpack("<3f", "maxs")
    rows = list(gfxworld.IW_VERTEX.iter_unpack(blob))
    assert len(rows) == record["draw.vertexCount"] == 151125
    for x, y, z, sign, _rgba, u, v, lu, lv, normal, tangent in rows:
        assert all(a - 1 <= c <= b + 1 for a, c, b in zip(lo, (x, y, z), hi, strict=True))
        n, t = vertices.unit_vec(normal), vertices.unit_vec(tangent)
        assert math.sqrt(sum(c * c for c in n)) == pytest.approx(1.0, abs=0.01)
        assert abs(sum(a * b for a, b in zip(n, t, strict=True))) < 0.01
        assert sign in (-1.0, 1.0) and 0.0 <= lu <= 1.0 and 0.0 <= lv <= 1.0 and abs(u) < 4096 and abs(v) < 4096
    indices = struct.unpack(f"<{len(index_bytes) // 2}H", index_bytes)
    against = 0
    for s in surfaces:
        for k in range(s["triCount"]):
            a, b, c = (rows[indices[s["baseIndex"] + 3 * k + i] + s["firstVertex"]] for i in range(3))
            e1, e2 = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
            cross = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
            against += sum(p * q for p, q in zip(cross, vertices.unit_vec(a[9]), strict=True)) < 0
    assert against == sum(s["triCount"] for s in surfaces)


def test_mp_las_model_vertices_are_inside_their_models_and_their_normals_unit_length(mp_la):
    """LOD 0 of every model the map defines: IW's normal packing read here would give lengths far from 1."""
    count = 0
    for asset in mp_la.by_type("xmodel"):
        model = asset.record
        if asset.name.startswith(",") or model["surfs"] is None:
            continue
        lo, hi = model.unpack("<3f", "mins"), model.unpack("<3f", "maxs")
        first, n = model["lodInfo[0].surfIndex"], model["lodInfo[0].numsurfs"]
        for surface in list(model["surfs"])[first : first + n]:
            for position, normal, _uv, _rgba in xmodel.vertices(surface, "t6"):
                assert all(a - 2 <= c <= b + 2 for a, c, b in zip(lo, position, hi, strict=True)), asset.name
                assert math.sqrt(sum(c * c for c in normal)) == pytest.approx(1.0, abs=0.01), asset.name
                count += 1
    assert count > 500_000


# -- material --------------------------------------------------------------------------------------


def test_a_t6_alpha_test_is_one_bit_and_there_is_no_gamma_write():
    tested = material.state_bits(1 << 12, 0)
    assert tested["alphaTest"] == "ge128" and "gammaWrite" not in tested
    assert material.state_bits(0, 0)["alphaTest"] == "gt0"
    assert material.state_bits(1 << 11 | 1 << 12, 0)["alphaTest"] == "disabled"


def test_t6_texture_semantics_put_the_occlusion_map_at_ten():
    assert material.SEMANTICS[2] == "colorMap" and material.SEMANTICS[10] == "occlusionMap"
    assert material.SEMANTICS[12] == "color0Map" and material.SEMANTICS[-1] == "throwMap"


def test_a_colour_map_is_named_by_its_slot_hash():
    tex = Rec(
        {"nameHash": material.ZoneNames.hash("colorMap1"), "semantic": 2, "image": Named("wpc_c"), "isMatureContent": 0},
    )
    tex.bytes = lambda path: b"\x00"
    names = material.ZoneNames.__new__(material.ZoneNames)
    names.textures, names.constants = {material.ZoneNames.hash("colorMap1"): "colorMap1"}, {}
    assert material.texture(tex, names)["name"] == "colorMap1"
    assert material.texture(tex, names)["image"] == "wpc_c"


# -- clipmap ---------------------------------------------------------------------------------------


def test_a_t6_clip_material_names_itself_through_a_pointer_and_a_partition_has_no_borders():
    info = Rec(
        {
            "materials": [Rec({"name": "clip_player", "surfaceFlags": 0x440A0, "contentFlags": 0x10000})],
            "numMaterials": 1,
        }
    )
    assert clipmap.materials(info) == [{"name": "clip_player", "surfaceFlags": 0x440A0, "contents": 0x10000}]
    clip = Rec({"partitions": [Rec({"triCount": 200, "firstTri": 16, "nuinds": 12, "fuind": 30})], "partitionCount": 1})
    assert clipmap.partitions(clip) == [{"triCount": 200, "firstTri": 16, "nuinds": 12, "fuind": 30}]


def test_a_t6_brush_face_carries_its_own_surface_flags():
    brush = {
        "bounds": {"midPoint": {"x": 0, "y": 0, "z": 0}, "halfSize": {"x": 1, "y": 1, "z": 1}},
        "axialSurfaceFlags": [[1, 2, 3], [4, 5, 6]],
        "sides": [{"normal": [0.6, 0.8, 0], "dist": 1.0, "surfaceFlags": 0x900000}],
    }
    # Each axis max face first, then its min face, then the bevels: T5's reading.
    assert face_flags(brush, [], "t6") == [(4, None), (1, None), (5, None), (2, None), (6, None), (3, None), (0x900000, None)]
    assert "t6" in FACE_FLAG_GAMES


# -- loading screen --------------------------------------------------------------------------------


class Loaded(Rec):
    """An image record whose pixels the zone holds, as `LoadImageData` captures them."""

    def __init__(self, members, raw):
        super().__init__(members)
        self.raw = raw

    def captured(self, name):
        return self.raw if name == "LoadImageData" else None


def screen_material(name, *images):
    return Named(name, Rec({"textureCount": len(images), "textureTable": [Rec({"image": Named(i)}) for i in images]}))


def test_a_loading_screen_is_its_materials_one_image_written_under_the_materials_name(tmp_path):
    block = bytes(8)  # one BC1 block: a 4x4 level
    raw = image.LOADDEF.pack(0, image.NOMIPMAPS, 71, len(block)) + block
    walk = Walk(
        material=[
            screen_material("loadscreen_mp_x", "ls_x"),
            screen_material("mtl_wall", "wall"),
            screen_material("loadscreen_mp_two", "a", "b"),
            screen_material("loadscreen_mp_away", ",elsewhere"),
        ],
        image=[Named("ls_x", Loaded({"width": 4, "height": 4}, raw))],
    )
    assert dict(loadscreen.pictures(walk)) == {
        "loadscreen_mp_x": "ls_x",
        "loadscreen_mp_two": "2 images",
        "loadscreen_mp_away": "elsewhere",
    }
    loadscreen.write(walk, str(tmp_path))
    assert os.listdir(tmp_path / "images") == ["loadscreen_mp_x.dds"]
    assert decode_texture(str(tmp_path / "images" / "loadscreen_mp_x.dds"))[0].size == (4, 4)


class StageTenBackend:
    """What stage 10 asks of a backend, recording the zones it dumps."""

    pictures = "zone"

    def __init__(self, kinds, **attrs):
        self.kinds, self.dumped = kinds, []
        self.__dict__.update(attrs)

    def dumps(self, kind):
        return kind in self.kinds

    def dump(self, path, out, kind):
        self.dumped.append((os.path.basename(path), kind))


def test_stage_ten_reads_every_zone_a_backend_names_and_ghosts_own_load_zone_otherwise(tmp_path):
    for name in ("mp_x.ff", "mp_x_load.ff", "code_post_gfx_mp.ff", "dlc3_load_mp.ff", "dlc0_load_mp.ff", "code_post_gfx_zm.ff"):
        (tmp_path / name).write_bytes(b"")
    t6 = StageTenBackend({"image", "loadscreen"}, loadscreen_zones=T6Backend.loadscreen_zones)
    assert export._load_zone_images(t6, "mp_x", str(tmp_path), str(tmp_path / "work")) == str(tmp_path / "work" / "load")
    assert t6.dumped == [
        ("code_post_gfx_mp.ff", "loadscreen"),
        ("dlc0_load_mp.ff", "loadscreen"),
        ("dlc3_load_mp.ff", "loadscreen"),
    ]
    # A zombies map's session loads the zombies' zone, and no MP one.
    zm = StageTenBackend({"image", "loadscreen"}, loadscreen_zones=T6Backend.loadscreen_zones)
    export._load_zone_images(zm, "zm_x", str(tmp_path), str(tmp_path / "work"))
    assert zm.dumped == [("code_post_gfx_zm.ff", "loadscreen")]
    ghosts = StageTenBackend({"image"})
    export._load_zone_images(ghosts, "mp_x", str(tmp_path), str(tmp_path / "work"))
    assert ghosts.dumped == [("mp_x_load.ff", "image")]
    assert export._load_zone_images(StageTenBackend({"image"}), "mp_y", str(tmp_path), str(tmp_path / "work")) is None


def test_a_square_loading_screen_is_stretched_over_the_screen_it_is_drawn_on(tmp_path):
    dump = tmp_path / "load" / "images"
    dump.mkdir(parents=True)
    Image.new("RGB", (64, 64), (10, 200, 10)).save(dump / "loadscreen_mp_x.dds")
    path, _ = export_loadscreen(
        str(tmp_path / "none"), "mp_x", str(tmp_path), str(tmp_path / "load"), size=T6Backend.loadscreen_size
    )
    assert Image.open(path).size == (640, 360)


def _gametype_rows():
    """The first eight columns of every row of zombies' `zm/gametypestable.csv` (patch_zm.ff)."""
    from scripts.cod.zonecode import walk_fastfile

    (table,) = [
        a.record
        for a in walk_fastfile(os.path.join(BO2_ZONES, "patch_zm.ff")).by_type("stringtable")
        if a.name == "zm/gametypestable.csv"
    ]
    width = table["columnCount"]
    return [[table["values"][row * width + c]["string"] for c in range(8)] for row in range(table["rowCount"])]


@pytest.mark.skipif(not os.path.exists(os.path.join(BO2_ZONES, "patch_mp.ff")), reason="Black Ops II is not installed")
def test_every_bo2_map_is_in_the_games_map_table_and_has_its_loading_screen(tmp_path):
    """The maps are the game's (`mp/mapstable.csv`), and each one's `loadscreen_<map>`,
    which the game builds from the map's name, draws a whole 16:9 or square picture; so
    does each zombies map's `loadscreen_<map>_<gametype>_<location>`."""
    from scripts.cod.maps import load_maps
    from scripts.cod.zonecode import walk_fastfile

    (table,) = [
        a.record
        for a in walk_fastfile(os.path.join(BO2_ZONES, "patch_mp.ff")).by_type("stringtable")
        if a.name == "mp/mapstable.csv"
    ]
    listed = {table["values"][row * table["columnCount"]]["string"] for row in range(table["rowCount"])}
    entries = [m for m in load_maps()[1] if m["game"] == "bo2"]
    ours = [m["map"] for m in entries if m["map"].startswith("mp_")]
    assert len(ours) == 15 and set(ours) <= listed
    # A zombies map names its picture `<map>_<gametype>_<location>`, the session the game
    # starts it in by default: zm/gametypestable.csv's first `YES` row for the map.
    zombies = {m["map"]: m["loadscreen"] for m in entries if m["map"].startswith("zm_")}
    if not os.path.exists(os.path.join(BO2_ZONES, "patch_zm.ff")):
        zombies = {}  # zombies not installed: the MP half still stands
    for zm, name in zombies.items():
        default = next(r for r in _gametype_rows() if r[0] == "6" and r[2] == zm and r[7] == "YES")
        assert name == f"{zm}_{default[4]}_{default[3]}", (zm, default)

    backend = T6Backend()
    for pattern in T6Backend.loadscreen_zones:
        for mode in ("mp", "zm"):
            for path in sorted(glob.glob(os.path.join(glob.escape(BO2_ZONES), pattern.format(mode=mode)))):
                backend.dump(path, str(tmp_path), "loadscreen")
    for name in ours + list(zombies.values()):
        img = decode_texture(str(tmp_path / "images" / f"loadscreen_{name}.dds"))[0]
        assert img.width in (img.height, img.height * 16 // 9), (name, img.size)
        assert max(hi - lo for lo, hi in img.convert("RGB").getextrema()) > 128, name  # a picture, not a fill
