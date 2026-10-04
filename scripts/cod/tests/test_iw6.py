import json
import struct
import types
import zlib

import pytest

from scripts.cod import brushmodels
from scripts.cod.collision import brush_planes, face_flags
from scripts.cod.iw6 import ff
from scripts.cod.iw6.dumpers import Walked
from scripts.cod.iw6.dumpers import clipmap as clipmap_dump
from scripts.cod.iw6.dumpers import gfxworld as gfxworld_dump
from scripts.cod.iw6.dumpers import material as material_dump
from scripts.cod.iw6.dumpers import rawfile as rawfile_dump
from scripts.cod.iw6.dumpers import weapon as weapon_dump
from scripts.cod.iw6.dumpers.material import SLOTS_BY_HASH, constant, slot_hash
from scripts.cod.iw6.dumpers.zonesource import write_listing
from scripts.cod.iw6.gfxworld import World
from scripts.cod.iw6.memory import Struct
from scripts.cod.iw6.records import Material, Placement, Raw, TextureDef
from scripts.cod.iw6.renderstate import camera_region, game_flags, sampler_state, state_bits
from scripts.cod.iw6.zone import KIND_FLOAT, KIND_POINTER, KIND_SIGNED, KIND_UNSIGNED, VIRTUAL, Layout, Record, Zone
from scripts.cod.materials import classify_materials
from scripts.cod.metadata import zone_listing
from scripts.cod.shell import check_unit_vectors, decode_vertices, neutralise_generated, read_container, unpack_unit_vec
from scripts.cod.viewmodel import LOCATIONS, WEAPON_KEYS


def packed_iw6(x, y, z):
    """Three 10-bit fields, low bits first, each v / 1023 * 2 - 1."""
    return round((x + 1) / 2 * 1023) | round((y + 1) / 2 * 1023) << 10 | round((z + 1) / 2 * 1023) << 20


def iw6_vertex(normal):
    return struct.pack("<3f4x4B2f2fI4x", 1.0, 2.0, 3.0, 1, 2, 3, 4, 0.5, 0.25, 0.0, 0.0, packed_iw6(*normal))


def test_iw6_normals_are_ten_bit_fields_not_a_scale_byte():
    normals = [(1, 0, 0), (0, -1, 0), (0, 0, 1), (0.6, 0.8, 0)]
    blob = b"".join(iw6_vertex(n) for n in normals)
    _, nrm, uv, _, col = decode_vertices(blob, len(normals), "iw6")
    # The engine frame is (x, z, -y), as for every game.
    expected = [c for x, y, z in normals for c in (x, z, -y)]
    assert nrm == pytest.approx(expected, abs=2e-3)
    assert uv[:2] == [0.5, 0.25] and col[:4] == [1, 2, 3, 4]
    # The same bits read the IW5 way are not unit vectors, which check_unit_vectors reports.
    assert check_unit_vectors([unpack_unit_vec(packed_iw6(*n)) for n in normals], "iw5-decoded") == len(normals)


def test_texture_slot_hash_matches_the_zones():
    # MaterialTextureDef.nameHash of mp_prisonbreak's `colorMap` slots (nameStart 'c', nameEnd 'p').
    assert slot_hash("colorMap") == 2695565377
    assert SLOTS_BY_HASH[3054311504] == "colorMap1"


def test_only_an_iw6_header_is_claimed(tmp_path):
    iw6, t5 = tmp_path / "a.ff", tmp_path / "b.ff"
    iw6.write_bytes(ff.MAGIC + struct.pack("<I", ff.VERSION) + bytes(64))
    t5.write_bytes(ff.MAGIC + struct.pack("<I", 0x1D9) + bytes(64))  # Black Ops shares the magic
    assert ff.is_fastfile(iw6) and not ff.is_fastfile(t5)


def layout_rows(types):
    """layout.json rows for {type: [(member, size, kind, base type or "")]}, members laid end to end."""
    rows = []
    for typename, members in types.items():
        offset = 0
        for member, size, kind, base in members:
            rows.append([typename, member, offset, size, size, 0, kind, 0, 0, base])
            offset += size
        rows.append([typename, "", 0, offset, 0, 0, 0, 0, 0, ""])
    return rows


U4 = (4, KIND_UNSIGNED, "")
TYPES = {
    "Bounds": [("midPoint", 12, KIND_FLOAT, ""), ("halfSize", 12, KIND_FLOAT, "")],
    "Draw": [("vertexCount", *U4), ("indexCount", *U4)],
    "Dpvs": [("smodelCount", *U4), ("staticSurfaceCount", *U4)],
    "GfxWorld": [
        ("checksum", *U4),
        ("surfaceCount", *U4),
        ("modelCount", *U4),
        ("bounds", 24, 0, "Bounds"),
        ("draw", 8, 0, "Draw"),
        ("dpvs", 8, 0, "Dpvs"),
    ],
    "Tris": [("firstVertex", *U4), ("vertexCount", 2, KIND_UNSIGNED, ""), ("triCount", 2, KIND_UNSIGNED, ""), ("baseIndex", *U4)],
    "LafFields": [("lightmapIndex", 1, KIND_UNSIGNED, "")],
    "Laf": [("fields", 1, 0, "LafFields")],
    "GfxSurface": [("tris", 12, 0, "Tris"), ("laf", 1, 0, "Laf")],
    "GfxBrushModel": [("bounds", 24, 0, "Bounds"), ("startSurfIndex", *U4), ("surfaceCount", 2, KIND_UNSIGNED, "")],
}


def test_gfxworld_manifest_is_what_the_shell_and_brush_models_read(tmp_path):
    layout_path = tmp_path / "layout.json"
    layout_path.write_text(json.dumps(layout_rows(TYPES)))
    layout = Layout(str(layout_path))

    # Two surfaces over four vertices: the world's, and brush model 1's.
    header = struct.pack("<3I6f4I", 7, 2, 2, 0, 0, 0, 1, 1, 1, 4, 6, 1, 1)
    # The second is on no lightmap page (31), as every unlit Ghosts surface is.
    surfaces = struct.pack("<IHHIB", 0, 4, 1, 0, 0) + struct.pack("<IHHIB", 1, 3, 1, 3, 31)
    models = struct.pack("<6fIH", 0, 0, 0, 9, 9, 9, 0, 1) + struct.pack("<6fIH", 0, 0, 0, 1, 1, 1, 1, 1)
    vertices = b"".join(iw6_vertex((0, 0, 1)) for _ in range(4))
    indices = struct.pack("<6H", 0, 1, 2, 0, 1, 2)
    data = bytearray(72)
    at = {}
    for key, blob in (
        ("header", header),
        ("surfaces", surfaces),
        ("models", models),
        ("vertices", vertices),
        ("indices", indices),
    ):
        at[key] = len(data)
        data += blob
    zone = Zone(bytes(data), layout)

    size = layout.size("GfxSurface")
    world = World(
        name="maps/mp/mp_test.d3dbsp",
        base_name="mp_test",
        header=Record(zone, "GfxWorld", at["header"], None, None),
        vertices=at["vertices"],
        indices=at["indices"],
        surfaces=[Record(zone, "GfxSurface", at["surfaces"] + size * i, None, None) for i in range(2)],
        sky_surfaces=set(),
        materials=[("MATERIAL", "wc/ground"), ("MATERIAL", None)],
        placements=[Placement("tree", (1.0, 2.0, 3.0), ((1, 0, 0), (0, 1, 0), (0, 0, 1)), 1.0)],
        instances=None,
        models=at["models"],
    )
    gfxworld_dump.write(Walked("mp_test.ff", zone, world), str(tmp_path / "gw"))

    path = tmp_path / "gw" / "maps" / "mp" / "mp_test.d3dbsp.gfxworld.json"
    manifest, verts, index = read_container(str(path))  # checks _game, stride and blob sizes
    assert manifest["_game"] == "iw6" and verts == vertices and index == (0, 1, 2, 0, 1, 2)
    assert manifest["surfaces"] == [
        {"firstVertex": 0, "vertexCount": 4, "triCount": 1, "baseIndex": 0, "material": "wc/ground", "lightmapIndex": 0},
        {"firstVertex": 1, "vertexCount": 3, "triCount": 1, "baseIndex": 3, "lightmapIndex": 31},
    ]
    assert manifest["staticModels"] == [
        {"origin": [1.0, 2.0, 3.0], "axis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "scale": 1.0, "model": "tree"}
    ]
    assert manifest["bounds"] == {"mins": [-1.0, -1.0, -1.0], "maxs": [1.0, 1.0, 1.0]}
    assert manifest["models"][1] == {"surfaceCount": 1, "startSurfIndex": 1, "bounds": {"mins": [-1, -1, -1], "maxs": [1, 1, 1]}}
    assert brushmodels.owners(manifest["models"]) == {1: 1}
    assert (manifest["staticSurfaceCount"], manifest["staticModelCount"], manifest["modelCount"]) == (1, 1, 2)


# mp_prisonbreak's `patch_001`, a `2d` material: its GfxStateBits.loadBits as stored.
PATCH_2D = (0x12, 0xE00E0002, 0x0F012165)


def test_state_bits_decode_like_iw5s_2d_material():
    # What OpenAssetTools writes for IW5's `2d` materials, but for the cull face:
    # IW6's 2d technique set culls back faces, and its stateFlags byte (0x1) agrees.
    assert state_bits(PATCH_2D) == {
        "srcBlendRgb": "srcalpha",
        "dstBlendRgb": "invsrcalpha",
        "blendOpRgb": "add",
        "alphaTest": "gt0",
        "cullFace": "back",
        "srcBlendAlpha": "one",
        "dstBlendAlpha": "zero",
        "blendOpAlpha": "disabled",
        "colorWriteRgb": True,
        "colorWriteAlpha": True,
        "gammaWrite": False,
        "polymodeLine": False,
        "depthWrite": False,
        "depthTest": "disabled",
        "polygonOffset": "offset0",
    }


def test_state_bits_fields():
    raster = 0x4 | 0x18 | 0x40  # alpha test lt128, cull front, gamma write
    depth = 0x1 | 0xC | 0x20 | 0x40 | 0x80 | 2 << 8 | 7 << 17 | 3 << 20 | 5 << 29
    blend = 0x2 | 14 << 4 | 1 << 8 | 0x7000000  # one / invsrcalpha1 / add, RGB written
    state = state_bits((raster, depth, blend))
    assert (state["alphaTest"], state["cullFace"], state["gammaWrite"]) == ("lt128", "front", True)
    assert (state["depthWrite"], state["depthTest"], state["polygonOffset"]) == (True, "less_equal", "offset2")
    assert state["stencilFront"] == {"pass": "replace", "fail": "keep", "zfail": "keep", "func": "always"}
    assert state["stencilBack"] == {"pass": "incrsat", "fail": "keep", "zfail": "keep", "func": "notequal"}
    assert (state["srcBlendRgb"], state["dstBlendRgb"], state["blendOpRgb"]) == ("one", "invsrcalpha1", "add")
    assert (state["colorWriteRgb"], state["colorWriteAlpha"]) == (True, False)
    assert state_bits((0x1 | 0x6 | 0x8, 0x2, 0))["alphaTest"] == "disabled"  # the function bits are stale then


def test_sampler_camera_region_and_game_flags():
    assert sampler_state(0xE2) == {"filter": "linear", "mipMap": "disabled", "clampU": True, "clampV": True, "clampW": True}
    assert sampler_state(0x0B) == {"filter": "aniso2x", "mipMap": "nearest", "clampU": False, "clampV": False, "clampW": False}
    assert [camera_region(n) for n in (0, 1, 2, 8)] == ["litOpaque", "litDecal", "litTrans", "none"]
    assert game_flags(0x52) == ["2", "10", "40"]


def test_constant_names():
    literal = (1.0, 2.0, 3.0, 4.0)
    assert constant(slot_hash("colorTint"), b"colorTint\0\0\0", literal) == {"name": "colorTint", "literal": list(literal)}
    assert constant(slot_hash("featherParms"), b"featherParms", literal)["name"] == "featherParms"
    assert constant(slot_hash("flagWave0Parms"), b"flagWave0Par", literal)["name"] == "flagWave0Parms"
    assert constant(123, b"reflectionRa", literal) == {"nameHash": 123, "nameFragment": "reflectionRa", "literal": list(literal)}


MATERIAL_TYPES = [
    # type, member, offset, size, element size, extent
    ("MaterialInfo", "name", 0, 8, 8, 0),
    ("MaterialInfo", "gameFlags", 8, 1, 1, 0),
    ("MaterialInfo", "sortKey", 9, 1, 1, 0),
    ("MaterialInfo", "textureAtlasRowCount", 10, 1, 1, 0),
    ("MaterialInfo", "textureAtlasColumnCount", 11, 1, 1, 0),
    ("MaterialInfo", "surfaceTypeBits", 32, 4, 4, 0),
    ("MaterialInfo", "", 0, 40, 0, 0),
    ("Material", "stateBitsEntry", 40, 412, 1, 412),
    ("Material", "constantCount", 453, 1, 1, 0),
    ("Material", "stateBitsCount", 454, 1, 1, 0),
    ("Material", "stateFlags", 455, 1, 1, 0),
    ("Material", "cameraRegion", 456, 1, 1, 0),
    ("Material", "", 0, 464, 0, 0),
    ("GfxStateBits", "loadBits", 0, 12, 4, 3),
    ("GfxStateBits", "", 0, 28, 0, 0),
    ("MaterialConstantDef", "nameHash", 0, 4, 4, 0),
    ("MaterialConstantDef", "name", 4, 12, 1, 12),
    ("MaterialConstantDef", "literal", 16, 16, 4, 4),
    ("MaterialConstantDef", "", 0, 32, 0, 0),
]


def material_layout(tmp_path):
    rows = [[t, m, o, size, elem, 0, KIND_UNSIGNED if m else 0, extent, 0, ""] for t, m, o, size, elem, extent in MATERIAL_TYPES]
    rows.append(["Material", "info", 0, 40, 40, 0, 0, 0, 0, "MaterialInfo"])
    path = tmp_path / "layout.json"
    path.write_text(json.dumps(rows))
    return Layout(str(path))


def test_material_dump_is_what_materials_py_reads(tmp_path):
    header = bytearray(464)
    header[8], header[9], header[10], header[11] = 0x52, 1, 1, 1
    entries = [0xFF] * 412
    entries[0x0], entries[0x7] = 0, 1
    header[40:452] = bytes(entries)
    header[453], header[454], header[455], header[456] = 1, 2, 0x39, 0
    depth_prepass = (0x10 | 0x1, 0x1 | 0x4 | 0x40, 0x0F012012)
    lit = (0x10 | 0x1, 0x8 | 0x40, 0x07012012)
    states = b"".join(struct.pack("<3I16x", *bits) for bits in (depth_prepass, lit))
    constants = struct.pack("<I12s4f", slot_hash("colorTint"), b"colorTint", 1, 1, 1, 1)
    data = bytearray(72) + header + states + constants
    zone = Zone(bytes(data), material_layout(tmp_path))
    textures = [TextureDef(slot_hash("colorMap"), "c", "p", 0x0B, 2, ",pbk_dirt_col")]
    found = {
        "*r101dn_101z": Material("*r101dn_101z", 72, ",w_l_sm_r0c0_z1", textures, 72 + 464, 72 + 464 + 56),
        ",wc/elsewhere": Material(",wc/elsewhere", 72, None, [], None, None),
    }
    zone.found["MATERIAL"] = found
    material_dump.write(Walked("mp_test.ff", zone, None), str(tmp_path / "mat"))

    written = sorted(str(p.relative_to(tmp_path / "mat")) for p in (tmp_path / "mat").rglob("*.json"))
    assert written == ["materials/generated/_r101dn_101z.json"]  # the comma stub belongs to another zone
    dumped = json.loads((tmp_path / "mat" / written[0]).read_text())
    assert dumped["techniqueSet"] == "w_l_sm_r0c0_z1" and dumped["_game"] == "iw6"
    assert dumped["gameFlags"] == ["2", "10", "40"] and dumped["sortKey"] == 1
    assert dumped["stateBitsEntry"][:8] == [0, -1, -1, -1, -1, -1, -1, 1] and len(dumped["stateBitsEntry"]) == 412
    assert dumped["constants"] == [{"name": "colorTint", "literal": [1.0, 1.0, 1.0, 1.0]}]
    assert dumped["textures"][0]["image"] == "pbk_dirt_col"

    colours, decals, drop, states = classify_materials(str(tmp_path / "mat" / "materials"), {"*r101dn_101z"}, "iw6")
    assert colours == {"*r101dn_101z": "pbk_dirt_col"} and not decals and not drop
    state = states["generated/_r101dn_101z"]
    assert (state["blend"], state["doubleSided"], state["castsShadow"]) == (None, False, True)


def test_generated_surfaces_lose_their_layer_weights():
    col = [10, 20, 30, 0] * 4
    surfaces = [
        {"material": "*108_11", "firstVertex": 0, "triCount": 1, "baseIndex": 0},
        {"material": "wc/painted_blue", "firstVertex": 2, "triCount": 1, "baseIndex": 3},
    ]
    indices = (0, 1, 0, 0, 1, 0)  # the first surface uses vertices 0-1, the second 2-3
    assert neutralise_generated(col, surfaces, indices, "iw6") == 2
    assert col == [255, 255, 255, 255] * 2 + [10, 20, 30, 0] * 2
    assert neutralise_generated(col, surfaces, indices, "iw5") == 0


# -- the clipmap dumper ---------------------------------------------------------
#
# Its structs are read out of the emulated loader's memory, so a test needs only a
# flat address space and a layout: `FakeMemory` is all of `emulate.Emulator` that
# `memory.Struct` touches.

PTR = (8, KIND_POINTER, "")
U2 = (2, KIND_UNSIGNED, "")
I4 = (4, KIND_SIGNED, "")
F4 = (4, KIND_FLOAT, "")

CLIP_TYPES = {
    "cplane_s": [("normal", 12, KIND_FLOAT, ""), ("dist", *F4), ("type", 1, KIND_UNSIGNED, "")],
    "ClipMaterial": [("name", *PTR), ("surfaceFlags", *U4), ("contents", *U4)],
    "cbrushside_t": [
        ("plane", *PTR),
        ("materialNum", *U2),
        ("firstAdjacentSideOffset", 1, KIND_UNSIGNED, ""),
        ("edgeCount", 1, KIND_UNSIGNED, ""),
    ],
    "cbrush_t": [("numsides", *U2), ("glassPieceIndex", *U2), ("sides", *PTR), ("axialMaterialNum", 12, KIND_UNSIGNED, "")],
    "ClipInfo": [
        ("numMaterials", *U4),
        ("materials", *PTR),
        ("numBrushes", *U2),
        ("_pad", 6, KIND_UNSIGNED, ""),
        ("brushes", *PTR),
        ("brushBounds", *PTR),
        ("brushContents", *PTR),
    ],
}


class FakeMemory:
    """A flat address space with a layout: what `memory.Struct` reads through."""

    def __init__(self, layout, base=0x10000):
        self.z = types.SimpleNamespace(layout=layout)
        self.base, self.data = base, bytearray()

    def place(self, blob):
        """Append `blob` and return its address."""
        at = self.base + len(self.data)
        self.data += blob
        return at

    def read(self, address, size):
        return bytes(self.data[address - self.base : address - self.base + size])


def clip_layout(tmp_path, types_=CLIP_TYPES):
    path = tmp_path / "clip-layout.json"
    path.write_text(json.dumps(layout_rows(types_)))
    return Layout(str(path))


def one_brush_info(memory, layout, *, num_brushes=None, pad=b"\0" * 6):
    """A ClipInfo holding one material and one 64-unit cube with a single bevel side."""
    name = memory.place(b"clip_nosight_rock\0")
    materials = memory.place(struct.pack("<QII", name, 0x000440A0, 0x08031640))
    plane = memory.place(struct.pack("<3ffB", 0.0, 0.0, 1.0, 32.0, 0))
    sides = memory.place(struct.pack("<QHBB", plane, 0, 0, 0))
    # axialMaterialNum is [0] the min faces then [1] the max, each x y z.
    brushes = memory.place(struct.pack("<HHQ6H", 1, 0, sides, 0, 0, 0, 0, 0, 0))
    bounds = memory.place(struct.pack("<6f", 1.0, 2.0, 3.0, 32.0, 32.0, 32.0))
    contents = memory.place(struct.pack("<i", 0x08031640))
    at = memory.place(
        struct.pack("<IQH6sQQQ", 1, materials, 1 if num_brushes is None else num_brushes, pad, brushes, bounds, contents)
    )
    return Struct(memory, "ClipInfo", at)


def test_a_clipmap_brush_is_its_bounds_its_axial_materials_and_its_bevels(tmp_path):
    layout = clip_layout(tmp_path)
    memory = FakeMemory(layout)
    info = one_brush_info(memory, layout)

    assert clipmap_dump.materials(info) == [{"name": "clip_nosight_rock", "surfaceFlags": 0x000440A0, "contents": 0x08031640}]
    (brush,) = clipmap_dump.brushes(info)
    assert brush["numsides"] == 1
    assert brush["contents"] == 0x08031640
    assert brush["bounds"] == {"midPoint": [1.0, 2.0, 3.0], "halfSize": [32.0, 32.0, 32.0]}
    assert brush["axialMaterialNum"] == [[0, 0, 0], [0, 0, 0]]
    assert brush["sides"] == [{"materialNum": 0, "normal": [0.0, 0.0, 1.0], "dist": 32.0}]
    # Downstream reads it as an IW brush: six axial faces then the bevels, each
    # naming a material (T5's would carry the flags themselves and no name).
    assert face_flags(brush, clipmap_dump.materials(info), "iw6") == [(0x000440A0, "clip_nosight_rock")] * 7
    assert len(brush_planes(brush)) == 7


def test_a_brush_count_wider_than_sixteen_bits_is_refused_not_truncated(tmp_path):
    memory = FakeMemory(clip_layout(tmp_path))
    info = one_brush_info(memory, clip_layout(tmp_path), pad=b"\x01\0\0\0\0\0")
    with pytest.raises(SystemExit, match="wider than 16 bits"):
        clipmap_dump.brushes(info)


def test_a_plane_is_only_read_as_four_floats_when_the_layout_says_so(tmp_path):
    clipmap_dump.check_plane_layout(clip_layout(tmp_path))
    moved = {**CLIP_TYPES, "cplane_s": [("dist", *F4), ("normal", 12, KIND_FLOAT, "")]}
    with pytest.raises(SystemExit, match="cplane_s is not"):
        clipmap_dump.check_plane_layout(clip_layout(tmp_path, moved))


def test_a_string_is_read_past_the_chunk_the_reader_asks_for(tmp_path):
    memory = FakeMemory(clip_layout(tmp_path))
    long = "clip_" + "x" * 200
    at = memory.place(long.encode() + b"\0")
    assert clipmap_dump.cstring(memory, at) == long
    assert clipmap_dump.cstring(memory, 0) is None


class FakeClip:
    """Just enough of the clipMap_t Struct for `clip_info`: its own `pInfo` value."""

    def __init__(self, pinfo, emulator=None):
        self.pinfo, self.emulator = pinfo, emulator

    def __getitem__(self, path):
        assert path == "pInfo"
        return self.pinfo


def test_a_submodel_pointing_at_the_games_global_clipinfo_is_the_maps_own(tmp_path):
    memory = FakeMemory(clip_layout(tmp_path))
    world = Struct(memory, "ClipInfo", 0x5000_0000_4010)
    cm_info = 0x1_41AB_3210  # &cm.info, what Load_clipMap_t's fixup writes
    clip = FakeClip(cm_info, memory)
    # Every stock submodel's `info` aliases the slot holding `pInfo`. Read as a
    # ClipInfo of its own it would be an empty struct, and the submodel would
    # come out with no brushes at all.
    assert clipmap_dump.clip_info(clip, world, cm_info) == (world, True)
    assert clipmap_dump.clip_info(clip, world, 0) == (world, True)
    assert clipmap_dump.clip_info(clip, world, world.address) == (world, True)
    own, shared = clipmap_dump.clip_info(clip, world, 0x5000_0000_9000)
    assert not shared and own.address == 0x5000_0000_9000


def test_a_bevel_plane_the_zone_streamed_before_the_clipmap_is_still_read(tmp_path):
    """A brush's bevels are aliased data: the emulator's memory has to serve them from the zone.

    A clipmap's plane array is streamed long before the clipmap, so nothing ever
    writes it into the emulated loader's memory and the page is untouched. Read as
    zeros, every brush loses its bevels and is exported as its bounding box.
    """
    planes = struct.pack("<3ffB3x", 0.6, 0.8, 0.0, 12.0, 3) * 2
    data = bytearray(bytes(16) + struct.pack("<7Q", *([0] * 7)))
    at = len(data)
    data += planes
    zone = Zone(bytes(data), clip_layout(tmp_path))
    zone.push(VIRTUAL)
    zone.pos = at
    offset = zone.blocks[VIRTUAL]
    assert zone.take(len(planes)) == at
    assert zone.virtual_slice(offset, len(planes)) == planes
    # Past what the zone streamed reads as zero rather than as the next take's bytes.
    assert zone.virtual_slice(offset + len(planes), 16) == bytes(16)


def test_a_plane_that_never_reached_memory_is_refused_not_read_as_a_zero_normal(tmp_path):
    memory = FakeMemory(clip_layout(tmp_path))
    at = memory.place(struct.pack("<3ffB3x", 0.0, 0.0, 0.0, 0.0, 0))
    with pytest.raises(SystemExit, match="zero normal"):
        clipmap_dump.plane(memory, at)
    real = memory.place(struct.pack("<3ffB3x", 0.0, 0.0, 1.0, 32.0, 0))
    assert clipmap_dump.plane(memory, real) == (0.0, 0.0, 1.0, 32.0)


def test_rawfile_dump_is_the_text_metadata_reads(tmp_path):
    """A rawfile is deflated when compressedLen is set and stored plain, with a NUL, when it is not."""
    text = b'r_filmEnable "1"\n'
    deflated = zlib.compress(text)
    data = bytearray(72) + deflated + text + b"\0"
    zone = Zone(bytes(data))
    zone.found["RAWFILE"] = {
        "vision/mp_x.vision": Raw("vision/mp_x.vision", 72, len(deflated), len(text)),
        "sun/mp_x.sun": Raw("sun/mp_x.sun", 72 + len(deflated), 0, len(text)),
        ",vision/elsewhere.vision": Raw(",vision/elsewhere.vision", 72, len(deflated), len(text)),
    }
    rawfile_dump.write(Walked("mp_x.ff", zone, None), str(tmp_path / "raw"))

    written = sorted(str(p.relative_to(tmp_path / "raw")) for p in (tmp_path / "raw").rglob("*") if p.is_file())
    assert written == ["sun/mp_x.sun", "vision/mp_x.vision"]  # the comma stub belongs to another zone
    assert (tmp_path / "raw" / "vision" / "mp_x.vision").read_bytes() == text
    assert (tmp_path / "raw" / "sun" / "mp_x.sun").read_bytes() == text  # the terminator is not part of the text


def test_the_zone_listing_is_what_metadata_reads_back(tmp_path):
    """The listing is read by name: an XAssetType is `mapents`, not `MAP_ENTS`, and the game key `IW6`."""
    assets = [("MAP_ENTS", "maps/mp/mp_x.d3dbsp", 0), ("RAWFILE", "vision/mp_x.vision", 0), ("IMAGE", None, 0)]
    path = write_listing(Walked("/zones/mp_x.ff", Zone(bytes(72)), None, None, assets), str(tmp_path))

    assert path == str(tmp_path / "zone_source" / "mp_x.zone")
    assert zone_listing(path) == ("iw6", {"mapents": ["maps/mp/mp_x.d3dbsp"], "rawfile": ["vision/mp_x.vision"]})


# --- weapons and attachments --------------------------------------------------

WEAPON_TYPES = {
    "Timers": [("iReloadTime", *U4), ("sprintInTime", *U4)],
    "Def": [
        ("weapClass", *U4),
        ("fAdsZoomFov", 4, KIND_FLOAT, ""),
        ("bBoltAction", 1, KIND_UNSIGNED, "bool"),
        ("pad", 3, KIND_UNSIGNED, ""),
        ("stateTimers", 8, 0, "Timers"),
    ],
}


def test_a_weapon_files_keys_are_openassettools_spellings():
    """The consumers were written against IW4 and IW5 dumps, so a key is OAT's name, not the member's."""
    assert weapon_dump.key_of("fHipSpreadStandMin") == "hipSpreadStandMin"
    assert weapon_dump.key_of("iClipSize") == "clipSize"
    assert weapon_dump.key_of("szDisplayName") == "displayName"
    assert weapon_dump.key_of("weapClass") == "weaponClass"  # a rename, not the prefix rule
    assert weapon_dump.key_of("adsIdleSpeed") == "adsIdleSpeed"  # no prefix to strip
    # A partial dump is judged by the keys stages 8 and 9 read (scripts/cod/export.py).
    assert set(WEAPON_KEYS) <= weapon_dump.KEYS
    assert "fireSound" not in weapon_dump.KEYS  # the emulated loader cannot resolve one


def test_a_clip_role_names_iw6s_slot_not_iw5s():
    """IW5's `weapAnimFiles_t` is not IW6's — its RELOAD is 9 and IW6's is 16 — and the
    clip a weapon plays is read by index, so IW5's enum here would name the wrong clip."""
    assert weapon_dump.ANIMS["fireAnim"] == 3 and weapon_dump.ANIM_SLOTS[3] == "fire"
    assert weapon_dump.ANIMS["reloadAnim"] == 16 and weapon_dump.ANIM_SLOTS[16] == "reload"
    assert weapon_dump.ANIMS["adsUpAnim"] == 90 and weapon_dump.ANIM_SLOTS[90] == "ads_up"
    # IW6 splits melee into four slots; `meleeAnim` is the swipe, which is what IW5's is.
    assert weapon_dump.ANIMS["meleeAnim"] == 9 and weapon_dump.ANIM_SLOTS[9] == "melee_swipe"
    assert len(set(weapon_dump.ANIMS.values())) == len(weapon_dump.ANIMS)
    assert max(weapon_dump.ANIMS.values()) < len(weapon_dump.ANIM_SLOTS) == 124


def test_an_override_row_names_exactly_one_attachment():
    """The sixteen bits are `scope:3, underBarrel:2, other:8`; a width read wrongly would
    name a real attachment of the wrong kind rather than fail, so every row is checked."""
    accepted = {"scopes": ["acog", "reflex", None], "underBarrels": ["gl", None], "others": ["silencer", "xmags"]}
    assert weapon_dump.combination(0, accepted, "x") == "none"
    assert weapon_dump.combination(1, accepted, "x") == "acog"
    assert weapon_dump.combination(2, accepted, "x") == "reflex"
    assert weapon_dump.combination(1 << 3, accepted, "x") == "gl"
    assert weapon_dump.combination(1 << 5, accepted, "x") == "silencer"
    assert weapon_dump.combination(1 << 6, accepted, "x") == "xmags"
    with pytest.raises(SystemExit):
        weapon_dump.combination(1 | 1 << 3, accepted, "x")  # two at once
    with pytest.raises(SystemExit):
        weapon_dump.combination(1 << 7, accepted, "x")  # an `other` this weapon does not carry


def test_a_weapons_numbers_are_written_as_openassettools_writes_them(tmp_path):
    """Times are milliseconds in the struct and seconds in the file, at C++'s six significant digits."""
    layout = clip_layout(tmp_path, WEAPON_TYPES)
    memory = FakeMemory(layout)
    timers = struct.pack("<2I", 2029, 230)
    at = memory.place(struct.pack("<If4B", 3, 50.0, 1, 0, 0, 0) + timers)
    weapon = Struct(memory, "Def", at)

    assert weapon_dump.value(weapon, "ms", "stateTimers.iReloadTime", []) == "2.029"
    assert weapon_dump.value(weapon, "ms", "stateTimers.sprintInTime", []) == "0.23"
    assert weapon_dump.value(weapon, "float", "fAdsZoomFov", []) == "50"
    assert weapon_dump.value(weapon, "bool", "bBoltAction", []) == "1"
    assert weapon_dump.value(weapon, "weapClass_t", "weapClass", []) == "smg"


# IW4 and IW5's `hitLocation_t`: nineteen, every right-hand location then every
# left. `locationDamageMultipliers` read under this is the plausible wrong answer
# the test below exists to catch.
IW5_HIT_LOCATIONS = (
    "none helmet head neck torso_upper torso_lower right_arm_upper right_arm_lower right_hand left_arm_upper "
    "left_arm_lower left_hand right_leg_upper right_leg_lower right_foot left_leg_upper left_leg_lower left_foot gun"
).split()
# The one member `location_damage` follows.
LOCATION_TYPES = {"Def": [("locationDamageMultipliers", 8, KIND_POINTER, "")]}


def a_weapon_with_multipliers(tmp_path, values):
    """A WeaponDef whose `locationDamageMultipliers` points at `values`; none for []."""
    memory = FakeMemory(clip_layout(tmp_path, LOCATION_TYPES))
    array = memory.place(struct.pack(f"<{len(values)}f", *values)) if values else 0
    return Struct(memory, "Def", memory.place(struct.pack("<Q", array)))


def test_a_hit_location_multiplier_is_read_by_iw6s_order_not_iw5s(tmp_path):
    """IW6 keeps 22 locations and interleaves the sides where IW5 groups them, so an
    index means a different place in each. A table read under IW5's order is a
    whole weapon with its arms and legs on the wrong side, and nothing downstream
    can tell: every multiplier is still a number in the right range.

    The array here is one distinct value per index, so every key moves under any
    other reading. Not one of Ghosts' 130 real tables tells its left side from
    its right, so most of them pass under either order; the two below are the
    ones that do not.
    """
    values = [round(0.1 * i, 2) for i in range(weapon_dump.NUM_HIT_LOCATIONS)]
    assert len(values) == 22
    got = dict(weapon_dump.location_damage(a_weapon_with_multipliers(tmp_path, values)))

    assert got["locHead"] == "0.2" and got["locTorsoUpper"] == "0.4"  # an off-by-one moves both
    assert got["locRightArmUpper"] == "0.6" and got["locLeftArmUpper"] == "0.7"
    assert got["locRightArmLower"] == "0.8" and got["locLeftArmLower"] == "0.9"
    assert got["locRightLegUpper"] == "1.2" and got["locLeftLegUpper"] == "1.3"
    assert got["locGun"] == "1.8"

    # The same array read as IW4 and IW5 spell it, which is what this pipeline was
    # about to do: eight of the nineteen land on the wrong limb.
    grouped = zip(IW5_HIT_LOCATIONS, values[: len(IW5_HIT_LOCATIONS)], strict=True)
    iw5 = {weapon_dump.location_key(loc): weapon_dump.number(v) for loc, v in grouped}
    assert {key for key in got if iw5[key] != got[key]} == {
        "locLeftArmUpper",
        "locRightArmLower",
        "locLeftArmLower",
        "locRightHand",
        "locLeftLegUpper",
        "locRightLegLower",
        "locLeftLegLower",
        "locRightFoot",
    }


# Two real `locationDamageMultipliers` arrays, read out of Ghosts' own zones:
# `defaultweapon_mp` in common_mp.ff and the L115 in common_core_mp.ff. Both are
# mirrored left to right, so both are only sane under one of the two orders.
DEFAULT_WEAPON = (1.0, 1.4, 1.4, 1.4, 1.2, 0.9, 0.8, 0.8, 0.6, 0.6, 0.1, 0.1, 0.5, 0.5, 0.4, 0.4, 0.1, 0.1, 0.0, 0.0, 1.0, 1.0)
L115A3 = (1.0, 1.5, 1.5, 1.1, 1.1, 1.1, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.1, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0)


def test_a_real_ghosts_table_is_only_symmetric_under_iw6s_order(tmp_path):
    """The evidence the order is right, in the game's own numbers.

    `defaultweapon_mp` falls off down a limb, and the L115 boosts the thighs with
    the torso because it is meant to kill in one shot to the upper body. Read as
    IW5 spells it, the first gives a hand the forearm's 0.6 and the second boosts
    one leg and not the other — an asymmetry no shipped weapon has.
    """
    graded = dict(weapon_dump.location_damage(a_weapon_with_multipliers(tmp_path, DEFAULT_WEAPON)))
    assert graded["locRightArmLower"] == graded["locLeftArmLower"] == "0.6"
    assert graded["locRightHand"] == graded["locLeftHand"] == "0.1"

    sniper = dict(weapon_dump.location_damage(a_weapon_with_multipliers(tmp_path, L115A3)))
    assert sniper["locHead"] == "1.5" and sniper["locTorsoUpper"] == "1.1"
    assert sniper["locRightLegUpper"] == sniper["locLeftLegUpper"] == "1.1"
    assert sniper["locRightLegLower"] == sniper["locLeftLegLower"] == "1"


def test_the_locations_written_are_the_nineteen_the_engine_classifies_a_bone_to(tmp_path):
    """IW6's `shield`, `armor` and `soft` are dropped: `HIT_LOCATIONS` in
    @3d/shared/sim/hitLocations.ts is nineteen and is a wire format, so a key for
    one of the three would be a multiplier nothing ever looks up."""
    assert set(weapon_dump.WRITTEN_LOCATIONS) == set(weapon_dump.HIT_LOCATIONS) - {"shield", "armor", "soft"}
    written = [key for key, _ in weapon_dump.location_damage(a_weapon_with_multipliers(tmp_path, [1.0] * 22))]
    assert written == [weapon_dump.location_key(loc) for loc in weapon_dump.WRITTEN_LOCATIONS]
    # The spellings are `viewmodel.LOCATIONS`', which is what `ballistics` reads.
    assert set(written) == set(LOCATIONS.values()) and len(written) == 19
    assert set(written) <= weapon_dump.KEYS


def test_a_weapon_the_zone_gave_no_multipliers_says_nothing_rather_than_one(tmp_path):
    """A null `locationDamageMultipliers` writes the keys empty, so the file keeps
    its shape and `viewmodel.ballistics` leaves the location out. Written as 1 it
    would claim the game said a head shot does body damage."""
    got = dict(weapon_dump.location_damage(a_weapon_with_multipliers(tmp_path, [])))
    assert set(got) == set(LOCATIONS.values())
    assert set(got.values()) == {""}
