"""The IW5 asset dumpers (xmodel, material, image, xanim, weapon, attachment) and what they lean on.

Synthetic tests pin the pieces a plausible-looking wrong answer would hide in: the
wavelet bit reader and its reconstruction, the table search, IWI/DDS headers,
bone rotations as OAT builds them, the float formats of an infostring. The real
zones are dumped and compared with A0's golden OAT dump where both are installed
($COD_GOLDEN, default .cache/cod/golden).
"""

import io
import math
import os
import struct
import zipfile

import pytest
from PIL import Image

from scripts.cod import equiv, iwd, wavelet
from scripts.cod import xmodel_glb as glb
from scripts.cod.iw5.dumpers import DUMPERS, image, weapon, xmodel
from scripts.cod.textures import decode_iwi_bytes
from scripts.cod.zonecode import program

from .test_zonecode import depot_zone

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
GOLDEN = os.environ.get("COD_GOLDEN", os.path.join(REPO, ".cache", "cod", "golden"))


# -- Wavelets --------------------------------------------------------------------------------------


def toy_tables():
    """Three lookups where a 0 bit codes 0 and a 1 bit escapes to a raw value."""
    table = [(0, 1) if i % 2 == 0 else (wavelet.ESCAPE, 1) for i in range(1 << wavelet.LOOKUP_BITS)]
    return table, table, table


def pack_bits(prefix, bits):
    """Raw bytes, then `bits` ([(value, width)]) least-significant bit first."""
    acc = pos = 0
    for value, width in bits:
        acc |= value << pos
        pos += width
    return prefix + acc.to_bytes((pos + 7) // 8, "little")


def test_a_luminance_wavelet_refines_its_parent_by_the_coded_details():
    # 1x1 raw 100, then 2x2: no parent correction, parity 1, details h=0, v=10 (escaped), d=0.
    payload = pack_bits(bytes([100]), [(0, 1), (1, 1), (0, 1), (1, 1), (10 + 255, 9), (0, 1)])
    levels = wavelet.decode(payload, 2, 2, 1, 1, toy_tables())
    base, v = 200, 10
    assert levels[1] == bytes([100])
    assert levels[0] == bytes([1 + ((base + v) >> 1), (base - v) >> 1, (base + v) >> 1, (base - v) >> 1])


def test_a_colour_wavelet_pads_its_fourth_byte_and_raw_levels_come_first():
    levels = wavelet.decode(bytes([1, 2, 3]), 1, 1, 1, 3, toy_tables())
    assert levels == [bytes([1, 2, 3, 0xFF])]
    with pytest.raises(ValueError, match="powers of two"):
        wavelet.decode(b"", 3, 2, 1, 1, toy_tables())


def escaping(bits):
    """A lookup whose odd codes escape, `bits` long: the escape's length is what names its role."""
    return [(0, 1) if i % 2 == 0 else (wavelet.ESCAPE, bits) for i in range(1 << wavelet.LOOKUP_BITS)]


def packed(table):
    return b"".join(struct.pack("<hh", v, b) for v, b in table)


def test_the_code_tables_are_found_by_their_shape_and_named_by_their_escapes(tmp_path):
    first, colour, alpha = (escaping(bits) for bits in wavelet.ESCAPE_BITS)
    exe = tmp_path / "game.exe"
    exe.write_bytes(os.urandom(1001) + packed(first) + packed(colour) + packed(alpha) + os.urandom(64))
    wavelet.tables_from_exe.cache_clear()
    assert wavelet.tables_from_exe(str(exe)) == (first, colour, alpha)
    # iw4mp.exe holds the same three the other way round.
    reverse = tmp_path / "reverse.exe"
    reverse.write_bytes(os.urandom(999) + packed(alpha) + packed(colour) + packed(first))
    assert wavelet.tables_from_exe(str(reverse)) == (first, colour, alpha)
    broken = tmp_path / "broken.exe"
    raw = packed(first)
    broken.write_bytes(raw[:-4] + struct.pack("<hh", 5, 1) + packed(colour) + packed(alpha))  # one entry disagrees
    with pytest.raises(ValueError, match="no wavelet code tables"):
        wavelet.tables_from_exe(str(broken))
    same = tmp_path / "same.exe"
    same.write_bytes(raw * 3)  # three lookups, but not the three roles
    with pytest.raises(ValueError, match="no wavelet code tables"):
        wavelet.tables_from_exe(str(same))


# -- Images ---------------------------------------------------------------------------------------


def mips(fmt, width, height, faces=1):
    return [
        bytes((level * 7 + i) & 0xFF for i in range(image.level_size(fmt, width, height, 1, level) * faces))
        for level in range(image.level_count(width, height, 1, True))
    ]


def test_an_iwi_round_trips_with_oat_s_header_and_decodes_its_largest_level():
    texture = image.Texture("BGRA8", 0, 4, 2, 1, True, mips("BGRA8", 4, 2))
    data = image.iwi_bytes(texture)
    assert data[:4] == b"IWi\x08" and data[8] == 1
    picmip = struct.unpack_from("<4I", data, 16)
    assert picmip[0] == len(data)  # the file size down to each level, smallest level first in the file
    assert image.from_iwi(data, None) == texture
    img = decode_iwi_bytes(data)[0]
    b, g, r, a = texture.levels[0][:4]
    assert img.getpixel((0, 0)) == (r, g, b, a)


def test_an_iwi_whose_sizes_disagree_with_its_header_is_refused():
    data = bytearray(image.iwi_bytes(image.Texture("L8", 0, 4, 4, 1, True, mips("L8", 4, 4))))
    struct.pack_into("<I", data, 16, 999)
    assert image.from_iwi(bytes(data), None) == "sizes that do not match its header"


def test_24_bit_colour_is_padded_and_written_as_dds():
    rgb = bytes([10, 20, 30] * 4)  # B, G, R
    ext, data = image.encode(image.Texture("BGR8", 0, 2, 2, 1, False, [rgb]))
    assert ext == ".dds"
    img = Image.open(io.BytesIO(data))
    assert img.size == (2, 2) and img.convert("RGB").getpixel((1, 1)) == (30, 20, 10)


def test_a_cube_load_definition_keeps_its_faces_inside_each_level():
    levels = mips("BGRA8", 2, 2, faces=6)
    raw = struct.pack("<B3xiii", 2, image.CUBE, 21, sum(map(len, levels))) + b"".join(levels)
    record = {"width": 2, "height": 2, "depth": 1}
    texture = image.from_loaddef(record, raw)
    assert texture.maptype == image.CUBE and texture.levels == levels
    data = image.iwi_bytes(texture)
    assert struct.unpack_from("<I", data, 4)[0] == image.CUBE
    assert data.endswith(levels[0]) and data[32:].startswith(levels[1])


def test_a_later_archive_in_a_folder_wins_when_asked_for_the_game_s_order(tmp_path):
    for name, body in (("iw_02.iwd", b"old"), ("iw_23.iwd", b"new")):
        with zipfile.ZipFile(tmp_path / name, "w") as z:
            z.writestr("images/x.iwi", body)
    iwd.entries.cache_clear()
    iwd.index.cache_clear()
    assert iwd.read(str(tmp_path), "images/X.iwi") == b"old"
    assert iwd.read(str(tmp_path), "images/X.iwi", newest=True) == b"new"


# -- Models ---------------------------------------------------------------------------------------


class Names:
    def __init__(self, indices):
        self.indices = indices

    def unpack(self, fmt):
        return [(i,) for i in self.indices]


class Walk:
    script_strings = [None, "tag_origin", "j_gun"]

    def script_string(self, i):
        return self.script_strings[i] if 0 <= i < len(self.script_strings) else None


def test_script_string_zero_is_the_empty_default_root_bone():
    assert xmodel.bone_names(Walk(), {"boneNames": Names([0, 2, 9])}) == ["", "j_gun", "INVALID_BONE_NAME"]


def test_stored_rotations_invert_the_bind_pose_they_are_built_with():
    """A base matrix's quaternion is a little longer than 1; OAT uses it as stored."""
    q = tuple(c * 1.00003 for c in (0.2, 0.4, 0.1, math.sqrt(1 - 0.21)))
    bone = glb.Bone("j", None, (120.0, -40.0, 900.0), q)
    ibm = glb.inverse_bind_matrix(bone, stored=True)
    translation, _rotation = glb.local_transform([bone], 0, stored=True)
    x, y, z, w = q
    r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    bind = [r[0], r[2], [-v for v in r[1]]]  # the axis change, then the rotation as stored
    for i in range(3):
        for j in range(3):
            product = sum(ibm[4 * k + i] * bind[k][j] for k in range(3))
            assert abs(product - (i == j)) < 1e-9
    assert translation == pytest.approx(glb.to_gltf(bone.offset))
    assert glb.inverse_bind_matrix(bone) != pytest.approx(ibm, abs=1e-6)  # the normalised pose is not OAT's


def test_a_matrix_far_from_the_origin_is_allowed_float32_noise_in_every_component():
    far = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 1848.13, 0.1036, 5931.1, 1.0]
    noisy = list(far)
    noisy[13] += 2e-4
    rules = equiv.GLB_RULES
    found = []
    equiv.diff(
        {"nodes": [{"name": "t", "world": far}]},
        {"nodes": [{"name": "t", "world": noisy}]},
        "",
        "",
        rules,
        lambda *a: found.append(a),
    )
    assert not found
    near = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 1.0, 0.1036, 1.0, 1.0]
    moved = list(near)
    moved[13] += 2e-4
    equiv.diff(
        {"nodes": [{"name": "t", "world": near}]},
        {"nodes": [{"name": "t", "world": moved}]},
        "",
        "",
        rules,
        lambda *a: found.append(a),
    )
    assert found and found[0][0] == equiv.DIFFERS


# -- Weapons --------------------------------------------------------------------------------------


def test_infostring_numbers_print_as_a_cpp_stream_prints_them():
    assert [weapon.number(v) for v in (0.0, 1.0, 0.5, 1e6, 1234567.0, 1e-5, -0.0)] == [
        "0",
        "1",
        "0.5",
        "1e+06",
        "1.23457e+06",
        "1e-05",
        "-0",
    ]
    assert weapon.number(weapon.f32(weapon.f32(3350) / 1000.0)) == "3.35"  # milliseconds, as seconds


class Attachment:
    def __init__(self, name):
        self.name = name


def test_an_attachment_combination_names_one_slot():
    complete = {
        "scopes": [Attachment("acog"), Attachment("thermal")],
        "underBarrels": [Attachment("gl")],
        "others": [None, Attachment("silencer")],
    }
    w = weapon.Weapon.__new__(weapon.Weapon)
    w.complete = complete
    assert w.combination(0) == "none"
    assert w.combination(2) == "thermal"  # scope 2, 1-based, in the low three bits
    assert w.combination(1 << 3) == "gl"  # under-barrel 1, the next two bits
    assert w.combination(2 << 5) == "silencer"  # others are a bit each
    assert w.combination(1 << 5) == ""  # a slot with nothing in it


# -- The real zones -------------------------------------------------------------------------------


def zone_or_skip(name):
    if not os.path.exists(program.path_for("iw5")):
        pytest.skip("no IW5 zonecode.json (reverse/x86-zone/build.sh iw5)")
    path = depot_zone(name)
    if path is None:
        pytest.skip(f"MW3's {name}.ff is not installed")
    return path


def search_path():
    from scripts.cod.maps import load_maps

    return ";".join(load_maps()[0]["mw3"]["search"])


def golden_subset(golden, ours, tmp):
    """The golden files our dump has a partner for: the golden trees hold the companion zones too."""
    mine = equiv.list_tree(ours)
    for key, rels in equiv.list_tree(golden).items():
        if key in mine:
            os.makedirs(os.path.dirname(os.path.join(tmp, rels[0])), exist_ok=True)
            os.symlink(os.path.join(golden, rels[0]), os.path.join(tmp, rels[0]))
    return tmp


DOME = {"xmodel": "models", "material": "mat", "image": "img", "xanim": "anim"}
COMMON = {"weapon": "weapons", "attachment": "attach"}
GOLDEN_OF = {"attach": os.path.join("catalog-mw3", "work", "attach")}


@pytest.fixture(scope="module")
def dumps(tmp_path_factory):
    from scripts.cod.iw5.backend import Backend

    dome, common = zone_or_skip("mp_dome"), zone_or_skip("common_mp")
    out = tmp_path_factory.mktemp("iw5")
    backend = Backend(search_path())
    for kind, sub in DOME.items():
        backend.dump(dome, str(out / sub), kind)
    for kind, sub in COMMON.items():
        backend.dump(common, str(out / sub), kind)
    return out


def test_every_asset_kind_is_registered():
    assert set(DOME) | set(COMMON) <= set(DUMPERS)


@pytest.mark.parametrize("sub", sorted({*DOME.values(), *COMMON.values()}))
def test_the_real_zones_lose_nothing_the_golden_dump_holds(dumps, sub, tmp_path):
    golden = os.path.join(GOLDEN, GOLDEN_OF.get(sub, os.path.join("work", "dome-mw3", sub)))
    if not os.path.isdir(golden):
        pytest.skip(f"no golden dump at {golden}")
    report = equiv.compare_trees(golden_subset(golden, str(dumps / sub), str(tmp_path / "golden")), str(dumps / sub))
    assert not report.failed, report.files
    assert report.compared > 10 and report.count(equiv.EXTRA) == 0


def test_the_dome_s_one_wavelet_image_decodes_to_colour(dumps):
    if not os.path.exists(dumps / "img" / "images" / "floodlight_beam.dds"):
        pytest.skip("no iw5mp.exe to read the wavelet tables from")
    img = Image.open(dumps / "img" / "images" / "floodlight_beam.dds")
    assert img.size == (256, 256) and img.convert("RGB").getextrema() != ((0, 0), (0, 0), (0, 0))
