"""The Black Ops Cold War (T9) backend: what it claims, and the pieces of its readers that need no game files.

A real zone is hundreds of megabytes of Oodle-compressed data, so each reader
here is handed a few bytes laid out the way the zone lays them out.
"""

import math
import struct

import pytest

from scripts.cod import backends
from scripts.cod.collision import VERT_SEGMENT
from scripts.cod.t9 import ff, images, models, world
from scripts.cod.t9.backend import Backend
from scripts.cod.t9.dumpers import COMPLETE, DUMPERS
from scripts.cod.t9.zone import IMAGE, MATERIAL, TECHSET, TEXTURE_ONES, Zone, name_of, texture_table
from scripts.cod.t9.zoneset import load_list

NULL = 0xFFFFFFFFFFFFFFFF


def fake_fastfile(path, magic=b"TAFF", version=9):
    path.write_bytes(magic + struct.pack("<I", version) + bytes(0x100))
    return str(path)


def test_claims_taff_v9_and_no_other_backend_does(tmp_path):
    t9 = fake_fastfile(tmp_path / "mp_x.ff")
    other = fake_fastfile(tmp_path / "old.ff", version=8)
    assert Backend.claims(t9) and not Backend.claims(other)
    assert [cls.name for cls in backends.BACKENDS if cls.claims(t9)] == ["t9"]


def test_backend_writes_the_kinds_an_export_stops_without():
    assert {"gfxworld", "clipmap", "mapents", "material", "image", "xmodel"} <= COMPLETE
    assert set(COMPLETE) == set(DUMPERS)


def test_inflate_refuses_a_block_that_is_not_oodle(tmp_path):
    body = b"\x00" * 16  # an Oodle stream opens with a byte whose low nibble is 0xC
    off = 0x40
    data = b"TAFF" + struct.pack("<I", 9) + bytes(off - 8) + struct.pack("<4I", 16, 64, 16, off) + body
    path = tmp_path / "bad.ff"
    path.write_bytes(data)
    with pytest.raises(ValueError):
        ff.inflate(str(path))


def zone_bytes(types, strings=(b"x",), body=b""):
    """An XAssetList (header, string pointers and strings), `types` as XAssets, then `body`."""
    out = struct.pack("<QqqQq", len(strings), -1, -1, len(types), -1)
    out += struct.pack("<Q", NULL) * len(strings)
    for s in strings[1:]:
        out += b"\0\0" + bytes([len(s) + 1]) + s + b"\0"
    out += b"".join(struct.pack("<QQ", t, NULL) for t in types)
    return out + body


def alias(zone, j):
    return (4 << 60 | (zone.slot_base + 16 * j)) + 1


def test_alias_names_a_list_entry_and_nothing_else():
    zone = Zone(zone_bytes([TECHSET, IMAGE, MATERIAL]), "z")
    assert zone.slot_base % 8 == 0
    assert [zone.alias(alias(zone, j)) for j in range(3)] == [0, 1, 2]
    assert zone.alias(alias(zone, 3)) is None  # past the list
    assert zone.alias(alias(zone, 1) + 8) is None  # not on a slot
    assert zone.alias(NULL) is None


def test_name_of_clears_the_stub_bit():
    assert name_of(0x80000000000000AB) == name_of(0xAB) == "00000000000000ab"


def test_texture_table_is_found_by_its_ones_and_must_hold_the_texture_count():
    zone = Zone(zone_bytes([IMAGE, IMAGE, MATERIAL]), "z")
    record = bytearray(0x150)
    record[0x140] = 2
    entries = b"".join(struct.pack("<QI", alias(zone, j), 0xA0AB1041 + j) + TEXTURE_ONES + struct.pack("<I", 0) for j in (0, 1))
    zone.data = bytes(record) + bytes(24) + entries + bytes(64)
    start, found = texture_table(zone, 0, len(zone.data))
    assert start == 0x150 + 24
    assert [(zone.alias(image), slot) for image, slot in found] == [(0, 0xA0AB1041), (1, 0xA0AB1042)]
    record[0x140] = 3  # the record says three: a table of two is someone else's
    zone.data = bytes(record) + bytes(24) + entries + bytes(64)
    assert texture_table(zone, 0, len(zone.data)) is None


def test_load_list_reads_the_names_that_were_inline():
    flags = struct.pack("<Q", 0x1C4D6)
    entries = flags + struct.pack("<Q", (4 << 60) + 0x1234) + b"".join(flags + struct.pack("<Q", NULL) for _ in range(3))
    body = bytes(8) + struct.pack("<QQQQ", 0x3A966C557B53E20F, 0, 4, NULL) + entries + b"core\0core_hd\0core_common\0" + bytes(16)
    zone = Zone(zone_bytes([74], body=body), "mp_x")
    assert load_list(zone) == ["core", "core_hd", "core_common"]


def test_unit10_is_unsigned():
    packed = 1023 | (0 << 10) | (512 << 20)
    x, y, z = models.unit10(packed)
    assert x == 1.0 and y == -1.0 and abs(z) < 0.002


def test_mesh_decode_reads_positions_uvs_normals_and_local_triangles():
    k = 0x28
    vc, ic = 3, 3
    po = models.align16(2 * ic)
    vo = po + models.align16(12 * vc)
    size = vo + models.VERTEX * vc
    item = bytearray(size)
    struct.pack_into("<3H", item, 0, 0, 1, 2)
    struct.pack_into("<9f", item, po, 0, 0, 0, 1, 0, 0, 0, 1, 0)
    up = 511 | (511 << 10) | (1023 << 20)
    for i in range(vc):
        u = struct.unpack("<H", struct.pack("<e", 0.5 * i))[0]
        struct.pack_into("<IHHII", item, vo + models.VERTEX * i, 0xFFFFFFFF, u, 0, up, 0)
    record = bytearray(k + models.SURFACES + models.SURFACE + 0x10)
    struct.pack_into("<H", record, k + 0x1C, 1)
    struct.pack_into("<4I", record, k + 0x20, 9, vc, 0, ic)
    struct.pack_into("<Q", record, k + 0x40, NULL)
    struct.pack_into("<4I", record, k + 0x48, size, po, vo, 0)
    struct.pack_into("<4H2I", record, k + models.SURFACES, 0, vc, 1, 0, 0, 0)
    struct.pack_into("<Q", record, k, 0x1234)  # streamed: its data is not inline
    mesh = models.Mesh(bytes(record), k)
    positions, normals, uvs, _colours, surfaces = models.decode(bytes(item), mesh)
    assert positions[1] == (1.0, 0.0, 0.0)
    assert uvs[2] == (1.0, 0.0)
    assert all(abs(n[2] - 1.0) < 1e-9 for n in normals)
    assert surfaces == [(0, [(0, 1, 2)])]


def test_quat_axis_is_the_rotation_the_placements_apply():
    half = math.radians(90) / 2
    q = (0.0, 0.0, math.sin(half), math.cos(half))  # 90 degrees about z
    axis = world.quat_axis(q)
    assert [round(c, 6) for c in axis[0]] == [0.0, 1.0, 0.0]  # local x goes to world y
    assert [round(c, 6) for c in axis[2]] == [0.0, 0.0, 1.0]


def test_hull_planes_of_a_cube_are_its_six_faces_facing_out():
    pts = [(x, y, z) for x in (0, 2) for y in (0, 2) for z in (0, 2)]
    planes = world.hull_planes(pts)
    assert len(planes) == 6
    for normal, dist in planes:
        assert all(sum(n * p for n, p in zip(normal, pt, strict=True)) <= dist + 1e-6 for pt in pts)


def test_soup_indices_move_onto_1024_vertex_segments():
    base, index = 2 * VERT_SEGMENT + 1000, 200  # a partition's 23-bit base and a u8 index
    segment, low = divmod(base, VERT_SEGMENT)
    assert segment * VERT_SEGMENT + low + index == base + index
    assert low + 255 <= 0xFFFF


class FakePackages:
    def __init__(self, items):
        self.items = items

    def read(self, key):
        return self.items.get(key)


def image_record(parts, fmt=71, width=16, height=16):
    """An image header with `parts` [(start, width, height, key)], the last one resident."""
    h = bytearray(0xE8 + 0x20 * len(parts))
    struct.pack_into("<QQQ", h, 0, 0x11, 0, NULL)
    h[0x30:0x38] = b"\xff" * 8
    struct.pack_into("<II", h, 0x98, parts[-1][0], fmt)
    struct.pack_into("<2H", h, 0xA0, width, height)
    h[0xB1] = len(parts)
    for i, (start, w, hh, key) in enumerate(parts):
        struct.pack_into("<IHH", h, 0xE8 + 0x20 * i, start << 4, 2 * w, hh)
        if key is not None:
            struct.pack_into("<Q", h, 0xE8 + 0x20 * i + 8, key)
    return h


def test_largest_level_takes_the_largest_installed_part():
    # resident: 4x4 and smaller (8 + 8 bytes of BC1); part 0: the 8x8 mip; part 1: the 16x16 mip (missing)
    parts = [(16, 4, 4, 0xA), (16 + 32, 8, 8, 0xB), (16 + 32 + 128, 16, 16, None)]
    record = image_record(parts)
    packages = FakePackages({0xA: bytes(range(32))})
    fmt, w, h, pixels = images.largest_level(bytes(record), 0, packages)[0]
    assert (fmt, w, h, pixels) == (71, 8, 8, bytes(range(32)))


def test_largest_level_falls_back_to_the_resident_mips():
    parts = [(16, 4, 4, 0xA), (48, 8, 8, None)]
    record = image_record(parts) + bytes(range(16))
    record[0xE8 + 0x20 * 1 + 8 :] = bytes(range(16))  # the resident mips start in the last record's key slot
    fmt, w, h, pixels = images.largest_level(bytes(record), 0, FakePackages({}))[0]
    assert (w, h) == (4, 4) and pixels == bytes(range(8, 16))  # smallest first: the 4x4 is the last 8 bytes
