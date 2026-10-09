"""The T5 backend (scripts/cod/t5): Black Ops' writers, and what differs from IW's.

The writers are exercised on stand-ins for the walk's records; the real mp_nuked is
dumped and compared with A0's golden OAT dump where both are installed ($COD_GOLDEN,
default .cache/cod/golden).
"""

import glob
import os
import re
import struct
import zlib

import pytest

from scripts.cod import backends, equiv, xanim
from scripts.cod.files import read_json
from scripts.cod.iw5.dumpers import image as iw_image
from scripts.cod.iw5.dumpers import weapon as iw_weapon
from scripts.cod.iw5.dumpers import xmodel
from scripts.cod.iw6.dumpers.material import slot_hash
from scripts.cod.nav.from_pathdata import from_pathdata
from scripts.cod.t5 import dumpers
from scripts.cod.t5.backend import Backend
from scripts.cod.t5.dumpers import image, material, pathdata, rawfile, sound
from scripts.cod.zonecode import program

from .test_iw5_assets import golden_subset
from .test_iw5_dumpers import GOLDEN, REPO, Arr, Named, Rec

# -- Text kinds ------------------------------------------------------------------------------------


def packed_script(text):
    """A T5 script buffer: inflated size (with the NUL the loader keeps), deflated size, zlib."""
    body = zlib.compress(text + b"\0")
    return struct.pack("<II", len(text) + 1, len(body)) + body


def test_a_script_is_inflated_without_its_nul_and_other_raw_files_are_as_stored(tmp_path):
    text = b"main()\n{\n}\n" * 1000  # longer than one 0x1000 chunk, so only the last loses its NUL
    script = packed_script(text)
    files = [
        Named("maps/mp/mp_x.gsc", Rec({"len": len(script), "buffer": Arr(data=script)})),
        Named("vision/mp_x.vision", Rec({"len": 4, "buffer": Arr(data=b"abcd\0")})),
        Named("maps/mp/tiny.csc", Rec({"len": 8, "buffer": Arr(data=bytes(9))})),
    ]

    class Walk:
        def by_type(self, kind):
            return files

    rawfile.write(Walk(), str(tmp_path))
    assert (tmp_path / "maps/mp/mp_x.gsc").read_bytes() == text
    assert (tmp_path / "vision/mp_x.vision").read_bytes() == b"abcd"
    assert (tmp_path / "maps/mp/tiny.csc").read_bytes() == b""  # too short for its header: OAT writes it empty


# -- Materials -------------------------------------------------------------------------------------


def test_t5_hashes_a_slot_name_with_every_byte_or_0x20_not_lower_cased():
    """`_` | 0x20 is DEL, not `_`: lower-casing gives mp_nuked's `Color_Map` a hash no texture carries."""
    assert material.ZoneNames.hash("Color_Map") == 3053961470
    assert slot_hash("Color_Map") != 3053961470
    assert material.ZoneNames.hash("colormap") == material.ZoneNames.hash("COLORMAP") == slot_hash("colormap")


def ctab_shader(name, at_word):
    """A D3D9 pixel shader whose CTAB comment, declaring one sampler, starts at DWORD `at_word`."""
    header = struct.calcsize("<7I")
    info = header
    name_at = info + struct.calcsize("<IHHHHII")
    table = struct.pack("<7I", header, 0, 0x0300, 1, info, 0, 0) + struct.pack("<IHHHHII", name_at, 3, 0, 1, 0, 0, 0)
    table += name.encode() + b"\0"
    table += bytes(-len(table) % 4)
    comment = struct.pack("<I", 0x42415443) + table  # "CTAB"
    padding = [struct.pack("<I", 0)] * (at_word - 1)  # nops before the comment
    words = struct.pack("<I", 0xFFFF0300) + b"".join(padding)
    words += struct.pack("<I", 0xFFFE | ((len(comment) // 4) << 16)) + comment + struct.pack("<I", 0xFFFF)
    return words


def test_a_constant_table_is_read_only_within_the_size_oat_hands_its_analyser():
    """OAT's T5 lookup passes `programSize` (DWORDs) as bytes, so a table past the first quarter is not read."""
    program_ = ctab_shader("colorMapSampler", 1)
    words = len(program_) // 4
    assert material.constant_table(program_, len(program_)) == [("colorMapSampler", 3)]
    assert material.constant_table(program_, words) == []
    late = ctab_shader("colorMapSampler", 40)
    assert material.constant_table(late, len(late)) == [("colorMapSampler", 3)]
    assert material.constant_table(late, len(late) // 4) == []


def test_a_model_s_normal_map_is_picked_by_its_slot_name_as_spelled():
    """OAT compares `n`..`p` without folding case, so T5's `Normal_Map` loses to the `Detail_Map` before it."""

    def slot(name, image_name):
        return Rec(
            {
                "semantic": xmodel.TS_NORMAL_MAP,
                "nameStart": ord(name[0]),
                "nameEnd": ord(name[-1]),
                "u": Rec({"image": Named(image_name)}),
            }
        )

    mtl = Named("mc/mtl_x", Rec({"textureTable": [slot("Detail_Map", "fabric_n"), slot("Normal_Map", "x_n")], "textureCount": 2}))
    assert xmodel.texture_of(mtl, {xmodel.TS_NORMAL_MAP}, xmodel.NORMAL_PREFERENCE, fold=False) == "fabric_n"
    iw = Named("mc/mtl_y", Rec({"textureTable": [slot("detailMap", "fabric_n"), slot("normalMap", "y_n")], "textureCount": 2}))
    assert xmodel.texture_of(iw, {xmodel.TS_NORMAL_MAP}, xmodel.NORMAL_PREFERENCE, fold=False) == "y_n"


# -- Images ----------------------------------------------------------------------------------------


def test_iwi13_round_trips_and_24_bit_colour_goes_to_dds():
    levels = [bytes(range(16)), bytes(8), bytes(8), bytes(8)]  # DXT1 8x4, 4x2, 2x1, 1x1: a 4x4 block each below the top
    tex = iw_image.Texture("DXT1", 0, 8, 4, 1, True, levels)
    ext, data = image.encode(tex)
    assert ext == ".iwi" and data[:4] == b"IWi\x0d"
    back = image.from_iwi(data, None)
    assert back.fmt == "DXT1" and back.levels == levels and back.mips
    ext, _ = image.encode(iw_image.Texture("BGR8", 0, 1, 1, 1, False, [b"\1\2\3"]))
    assert ext == ".dds"  # IWI v13 holds no padded 24-bit colour, as OAT writes it


def test_iwi13_flags_are_a_byte_of_mip_cube_and_volume():
    assert image.maptype(image.CUBEMAP) == iw_image.CUBE
    assert image.maptype(image.VOLMAP) == iw_image.VOLUME
    assert image.maptype(image.CUBEMAP | image.VOLMAP) == iw_image.CUBE
    assert image.from_iwi(b"IWi\x08" + bytes(40), None) == "not an IWI v13"


# -- Animations ------------------------------------------------------------------------------------


def test_a_version_19_clip_carries_t5_s_flags_and_a_primed_length_when_streamable():
    clip = xanim.RawClip(
        frames=3, fps=30.0, looped=True, asset_type=0, version=19, left_hand_grip_ik=True, streamable=True, primed_length=0.5
    )
    data = xanim.encode(clip)
    version, _frames, _bones, flags = struct.unpack_from("<HHHB", data)
    assert version == 19 and flags == 1 | 4 | 8  # looped, left-hand grip IK, streamable
    assert struct.unpack_from("<f", data, 10) == (0.5,)
    decoded = xanim.decode(data, "clip")
    assert decoded.looped and decoded.frames == 3


# -- Sound -----------------------------------------------------------------------------------------


def test_xwma_packets_are_the_data_over_the_seek_table():
    snd = {"data_size": 8192, "seek_table_count": 2, "frame_rate": 44100, "channel_count": 2}
    riff = sound.xwma(snd, bytes(8192), struct.pack("<2I", 4096, 8192))
    assert riff[8:12] == b"XWMA"
    tag, _size, fmt_tag, channels, rate, avg, align = struct.unpack_from("<4sIHHIIH", riff, 12)
    assert (tag, fmt_tag, channels, rate, align) == (b"fmt ", 0x161, 2, 44100, 4096)
    assert avg == (4096 * 44100 + 8192) // 16384
    assert b"dpds" in riff


def test_ms_adpcm_is_written_only_as_whole_512_frame_blocks():
    snd = {"channel_count": 1, "frame_rate": 22050, "frame_count": 512, "data_size": 262}
    assert sound.adpcm_block_align(snd) == 262 and sound.whole_adpcm_blocks(snd)
    assert not sound.whole_adpcm_blocks({**snd, "data_size": 200})


# -- Weapons ---------------------------------------------------------------------------------------


def test_a_shared_run_of_zeros_read_as_model_pointers_is_no_model():
    """T5's linker points a null XModel*[16] into another array's zeros: the walk gives integers."""
    walk = type("W", (), {"game": "t5"})()
    w = iw_weapon.Weapon(walk, {"weapDef": {"worldModel": [0] * 32}}, {})
    assert iw_weapon.value(w, "worldModel2", "worldModel[1]", "CSPFT_XMODEL", {}) == ""
    w = iw_weapon.Weapon(walk, {"weapDef": {"worldModel": [7] * 32}}, {})
    with pytest.raises(ValueError):
        iw_weapon.value(w, "worldModel2", "worldModel[1]", "CSPFT_XMODEL", {})


# -- The registry ----------------------------------------------------------------------------------


def test_sound_is_one_asset_and_effects_are_dumped():
    backend = Backend()
    assert backend.provides("gfxworld", "clipmap", "xmodel", "material", "image", "xanim", "weapon", "sound", "fx")
    assert dumpers.NOTHING_AT_ALL == {"loadedsound"}


# -- Path nodes ------------------------------------------------------------------------------------


class Node(Rec):
    """A pathnode_t stand-in: its members by path, and its whole bytes (zeros for an empty slot)."""

    def __init__(self, members=(), packed=None, raw=b""):
        super().__init__(members, packed)
        self.raw = raw

    def bytes(self, path=None):
        return self.raw


def path_node(kind, origin, links=(), animscript=0, spawnflags=0, angle=0.0):
    """`links` [(target, fDist, disconnectCount, negotiationLink, badplace0)]."""
    data = b"".join(pathdata.LINK.pack(dist, target, dc, neg, bad, 0, 0, 0) for target, dist, dc, neg, bad in links)
    members = {
        "constant.type": kind,
        "constant.spawnflags": spawnflags,
        "constant.fAngle": angle,
        "constant.totalLinkCount": len(links),
        "constant.Links": Arr(range(len(links)), data=data, elem=pathdata.LINK.size) if links else None,
        **{f"constant.{k}": 0 for k in ("targetname", "target", "script_linkName", "script_noteworthy")},
        "constant.animscript": animscript,
    }
    return Node(members, {"constant.vOrigin": struct.pack("<3f", *origin)}, raw=b"\1")


def game_world(nodes, count=None, slots=pathdata.RUNTIME_SLOTS):
    path = Rec({"nodeCount": len(nodes) if count is None else count, "nodes": Arr(nodes + [Node(raw=bytes(128))] * slots)})
    return Rec({"path": path})


class PathWalk:
    game = "t5"

    def __init__(self, **by_type):
        self.by = by_type

    def by_type(self, kind):
        return self.by.get(kind, [])

    def script_string(self, index):
        return {7: "jump_down_40"}.get(index)


def test_a_black_ops_graph_is_read_from_the_game_world_with_its_links_and_bad_place_counts(tmp_path):
    nodes = [
        path_node(17, (0.0, 0.0, 40.0), [(1, 15.0, 0, 1, 0), (2, 90.0, 1, 0, 2)], animscript=7, spawnflags=0x8002, angle=90.0),
        path_node(18, (0.0, -40.0, 0.0), [(2, 50.0, 0, 0, 0)]),
        path_node(1, (80.0, 0.0, 0.0), [(0, 90.0, 0, 0, 0)]),
    ]
    # The zombies maps hold theirs in a GameWorldSp; the MP maps in a GameWorldMp.
    pathdata.write(PathWalk(gameworldsp=[Named("maps/zm.d3dbsp", game_world(nodes))]), str(tmp_path))
    dump = read_json(tmp_path / "maps/zm.d3dbsp.pathdata.json")
    assert (dump["_game"], dump["_type"], dump["nodeCount"], dump["zoneCount"], dump["version"]) == ("t5", "pathdata", 3, 0, None)
    begin = dump["nodes"][0]
    assert (begin["type"], begin["origin"], begin["angle"], begin["animscript"]) == (17, [0, 0, 40], 90, "jump_down_40")
    assert begin["parent"] is None
    link = {"target": 2, "fDist": 90.0, "negotiationLink": 0, "disconnectCount": 1, "ubBadPlaceCount": [2, 0, 0, 0]}
    assert begin["links"][1] == link
    assert dump["counts"] == {"entityNodes": 3, "zoneNodes": 0, "dynamicNodes": 0, "links": 4}


def test_a_black_ops_node_count_that_does_not_fit_its_array_is_refused(tmp_path):
    nodes = [path_node(1, (0.0, 0.0, 0.0))] * 3
    world = game_world(nodes, count=2, slots=127)  # a real node where the first empty runtime slot should be
    with pytest.raises(SystemExit, match="slot 2 is not empty"):
        pathdata.write(PathWalk(gameworldmp=[Named("maps/mp/mp_x.d3dbsp", world)]), str(tmp_path))
    with pytest.raises(SystemExit, match="expected 3 \\+ 128"):
        pathdata.write(PathWalk(gameworldmp=[Named("maps/mp/mp_x.d3dbsp", game_world(nodes, slots=0))]), str(tmp_path))
    past = [path_node(1, (0.0, 0.0, 0.0), [(5, 10.0, 0, 0, 0)])]
    with pytest.raises(SystemExit, match="links to node 5"):
        pathdata.write(PathWalk(gameworldmp=[Named("maps/mp/mp_x.d3dbsp", game_world(past))]), str(tmp_path))


def test_bo1_is_claimed_by_the_t5_backend(tmp_path, monkeypatch):
    bo1 = tmp_path / "mp_x.ff"
    bo1.write_bytes(b"IWffu100" + (0x1D9).to_bytes(4, "little") + bytes(64))
    monkeypatch.setattr(Backend, "check", lambda self: None)
    assert isinstance(backends.for_fastfile(str(bo1)), Backend)


# -- The real mp_nuked -----------------------------------------------------------------------------


def bo1_zone(name):
    from scripts.cod.maps import load_maps

    try:
        games, _maps = load_maps()
    except (OSError, ValueError, KeyError):
        return None
    for folder in games["bo1"]["zones"]:
        for path in glob.glob(os.path.join(folder, name + ".ff")):
            return path
    return None


WORLD = {"gfxworld": "gw", "clipmap": "clip", "mapents": "ents", "rawfile": "raw"}
ASSETS = {"xmodel": "models", "material": "mat", "sound": "snd"}


@pytest.fixture(scope="module")
def nuked_dump(tmp_path_factory):
    if not os.path.exists(program.path_for("t5")):
        pytest.skip("no T5 zonecode.json (reverse/x86-zone/build.sh t5)")
    path = bo1_zone("mp_nuked")
    if path is None:
        pytest.skip("Black Ops' mp_nuked.ff is not installed")
    from scripts.cod.maps import load_maps

    search = ";".join(load_maps()[0]["bo1"]["search"])
    out = tmp_path_factory.mktemp("nuked")
    backend = Backend(search)
    for kind, sub in {**WORLD, **ASSETS}.items():
        backend.dump(path, str(out / sub), kind)
    return out


# What this backend writes that OAT's golden dump never held: the layer data of
# Black Ops' generated materials (docs/cod/reference.md#layered-materials).
BEYOND_OAT = re.compile(r"(^|\.)(vertexLayerData|layerDataSize|layerFile)$|\.gfxworld_layers\.bin$")


@pytest.mark.parametrize("sub", sorted(WORLD.values()))
def test_nuked_s_world_loses_nothing_the_golden_dump_holds(nuked_dump, sub):
    golden = os.path.join(GOLDEN, "work", "nuked-bo1", sub)
    if not os.path.isdir(golden):
        pytest.skip(f"no golden dump at {golden}")
    report = equiv.compare_trees(golden, str(nuked_dump / sub))
    assert not report.failed, report.files
    extra = [
        (rel, key)
        for rel, items in report.files.items()
        for status, key, _ in items
        if status == equiv.EXTRA and not BEYOND_OAT.search(rel if key == "(file)" else key)
    ]
    assert report.compared and extra == []


# Where this backend departs from OAT on purpose: a model coloured by its `colorMap`, not by the
# numbered colour slot OAT picks first (xmodel.colour_map_of). On mp_nuked that is one material,
# on every LOD: `global_burn_mask` before, `p_jun_wood_stack_c` now.
NOT_OAT = ("materials[name=mc/mtl_p_jun_wood_stack].pbrMetallicRoughness.baseColorTexture.",)


@pytest.mark.parametrize("sub", sorted(ASSETS.values()))
def test_nuked_s_own_assets_lose_nothing_the_golden_dump_holds(nuked_dump, sub, tmp_path):
    golden = os.path.join(GOLDEN, "work", "nuked-bo1", sub)
    if not os.path.isdir(golden):
        pytest.skip(f"no golden dump at {golden}")
    report = equiv.compare_trees(golden_subset(golden, str(nuked_dump / sub), str(tmp_path / "golden")), str(nuked_dump / sub))
    failed = [
        (rel, key, detail)
        for rel, items in report.files.items()
        for status, key, detail in items
        if status in equiv.FAILURES and not key.startswith(NOT_OAT)
    ]
    assert failed == []
    assert report.compared


def test_nuked_s_path_nodes_are_its_node_entities_with_the_game_s_own_links(tmp_path):
    """The dump against the world's committed entity lump: every node, in x, y, z and type."""
    if not os.path.exists(program.path_for("t5")):
        pytest.skip("no T5 zonecode.json (reverse/x86-zone/build.sh t5)")
    path = bo1_zone("mp_nuked")
    if path is None:
        pytest.skip("Black Ops' mp_nuked.ff is not installed")
    Backend().dump(path, str(tmp_path), "pathdata")
    dump = read_json(tmp_path / "maps/mp/mp_nuked.d3dbsp.pathdata.json")
    assert (dump["nodeCount"], dump["counts"]["links"]) == (316, 1516)
    metadata = read_json(os.path.join(REPO, "worlds", "nuked-bo1", "export_metadata.json"))
    nav, why = from_pathdata(dump, metadata["entities"], "t5", "mp_nuked")
    assert nav is not None, why
    assert nav.meta["entityMatch"]["compared"] == "x y z type" and nav.meta["entityMatch"]["worst"] < 0.001
    assert nav.meta["links"] == {"traverse": 10, "walk": 1506, "walkOneWay": 20}
    assert nav.meta["traversals"] == {"JUMP_DOWN": 4, "MANTLE_ON": 4, "MANTLE_OVER": 2}


def test_a_model_is_coloured_by_its_color_map_not_a_numbered_slot_before_it():
    """T5's `clothcharr` and `wpn_clrdtl` techsets put a char mask or env map in `color0Map`, first."""

    def slot(semantic, name, image_name):
        return Rec(
            {"semantic": semantic, "nameStart": ord(name[0]), "nameEnd": ord(name[-1]), "u": Rec({"image": Named(image_name)})}
        )

    table = [slot(0xC, "color0Map", "char_burning_mask"), slot(xmodel.TS_COLOR_MAP, "colorMap", "couch_c")]
    couch = Named("mc/mtl_couch", Rec({"textureTable": table, "textureCount": 2}))
    assert xmodel.colour_map_of(couch, "t5") == "couch_c"
    # With no `colorMap` at all, a numbered slot is still better than nothing.
    glow = Named("mc/mtl_glow", Rec({"textureTable": table[:1], "textureCount": 1}))
    assert xmodel.colour_map_of(glow, "t5") == "char_burning_mask"
