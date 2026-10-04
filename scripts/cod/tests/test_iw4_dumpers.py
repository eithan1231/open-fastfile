"""The IW4 backend (scripts/cod/iw4): IW5's writers over IW4's records, and what differs.

Where IW4's structs differ from IW5's, the writers are exercised on stand-ins for the
walk's records; the real mp_rust is dumped and compared with A0's golden OAT dump
where both are installed ($COD_GOLDEN, default .cache/cod/golden).
"""

import glob
import os
import struct
import zlib

import pytest

from scripts.cod import backends, equiv
from scripts.cod.iw4 import dumpers
from scripts.cod.iw4.backend import Backend
from scripts.cod.iw5.dumpers import clipmap, material, rawfile, shaders, weapon, xmodel
from scripts.cod.zonecode import program

from .test_iw5_assets import golden_subset
from .test_iw5_dumpers import GOLDEN, Arr, Named, Rec

# -- Stand-ins -------------------------------------------------------------------------------------


class Walk:
    game = "iw4"
    path = "stand-in.ff"

    def __init__(self, **by_type):
        self.by = by_type

    def by_type(self, kind):
        return self.by.get(kind, [])


# -- What differs from IW5 -------------------------------------------------------------------------


def test_a_rawfile_is_stored_deflated_or_plain(tmp_path):
    body = b"visionSetNaked mp_x\n"
    packed = zlib.compress(body)
    files = [
        Named(
            "vision/mp_x.vision", Rec({"compressedLen": len(packed), "len": len(body), "data.compressedBuffer": Arr(data=packed)})
        ),
        # IW4 may keep one plain: `len` bytes of `buffer`, then the NUL the zone loads with it.
        Named("maps/mp/mp_x.gsc", Rec({"compressedLen": 0, "len": len(body), "data.buffer": Arr(data=body + b"\0")})),
        Named("mp_x", Rec({"compressedLen": 0, "len": 0, "data.buffer": Arr(data=b"\0")})),
    ]
    rawfile.write(Walk(rawfile=files), str(tmp_path))
    assert (tmp_path / "vision/mp_x.vision").read_bytes() == body
    assert (tmp_path / "maps/mp/mp_x.gsc").read_bytes() == body
    assert (tmp_path / "mp_x").read_bytes() == b""


def test_a_clipmap_without_clipinfo_is_its_own():
    flat = Rec({"planeCount": 3, "brushes": None})
    assert clipmap.clip_info(flat) is flat
    nested = Rec({"pInfo": Rec({"planeCount": 3})})
    assert clipmap.clip_info(nested) is nested["pInfo"]


def test_partition_counts_are_bytes_read_unsigned():
    """IW4 declares them `char`: mp_rust has partitions of 166 triangles, which read signed are -90."""
    part = Rec({"triCount": -90, "borderCount": -128, "firstVertSegment": 1, "firstTri": 70000})
    [entry] = clipmap.partitions(Rec({"partitions": [part]}))
    assert entry == {"triCount": 166, "borderCount": 128, "firstVertSegment": 1, "firstTri": 70000}


def test_a_submodel_without_its_own_clipinfo_uses_the_map_s():
    nodes = Arr([Rec({"leafBrushCount": 1, "data.leaf.brushes": Arr([0], struct.pack("<H", 4), 2)})])
    clip = Rec({"cmodels": [], "aabbTrees": None, "leafbrushNodes": nodes, "leafbrushNodesCount": 1, "brushes": Arr()})
    leaf = {"brushContents": 1, "terrainContents": 0, "leafBrushNode": 0, "firstCollAabbIndex": 0, "collAabbCount": 0}
    model = Rec({"leaf": Rec(leaf), "radius": 1.0}, packed={"bounds": struct.pack("<6f", *range(6))})
    clip["cmodels"] = [model]
    [entry] = clipmap.submodels(clip, clip)
    assert entry["brushes"] == [4] and "foreignClipInfo" not in entry


def test_an_iw4_model_s_surfaces_are_the_record_the_action_kept():
    surfs = [Rec({"vertCount": 3}), Rec({"vertCount": 4}), Rec({"vertCount": 5})]
    kept = Rec({"surfs": surfs, "numsurfs": 2})
    model = Rec({"lodInfo[0].modelSurfs": kept, "lodInfo[1].modelSurfs": Rec({"surfs": None, "numsurfs": 0})})
    assert xmodel.surfaces(model, 0) == surfs[:2]
    assert xmodel.surfaces(model, 1) is None  # another zone's (`,flag2_lod000`): written with no vertices


def test_iw4_names_no_displacement_map_and_knows_fewer_textures():
    assert material.SEMANTICS_BY_GAME["iw4"][-1] == "waterMap"
    tex = Rec({"nameHash": 1, "nameStart": ord("c"), "nameEnd": ord("p"), "semantic": 12, "u": None})
    tex.bytes = lambda path: b"\0"
    assert material.texture(tex, shaders.ZoneNames(Walk()), material.SEMANTICS_BY_GAME["iw4"])["semantic"] == "2D"
    assert material.texture(tex, shaders.ZoneNames(Walk()))["semantic"] == "displacementMap"
    iw4 = set(shaders.KNOWN_TEXTURES_BY_GAME["iw4"])
    assert "oceanEnvMap" not in iw4 and "oceanEnvSampler" in iw4 and "colorMap" in iw4


class Sound:
    def __init__(self, name):
        self.name = name

    def __getitem__(self, path):
        return {"name": True, "name.soundName": self.name}[path]


def test_an_iw4_weapon_reads_its_arrays_and_bounce_sounds():
    walk = Walk()
    walk.script_string = lambda i: {0: "", 1: "tag_clip", 2: "fire", 3: "weap_fire"}.get(i)
    complete = {"weapDef": {"bounceSound": [Sound("grenade_bounce_default"), Sound("x")]}, "hideTags": [1] + [0] * 31}
    w = weapon.Weapon(walk, complete, {})
    assert weapon.value(w, "hideTags", "hideTags", "WFT_HIDETAGS", {}) == "tag_clip"  # the complete def's on IW4 too
    assert weapon.value(w, "bounceSound", "bounceSound", "WFT_BOUNCE_SOUND", {}) == "grenade_bounce"
    keys, values = [2] + [0] * 15, [3] + [0] * 15
    complete["weapDef"].update(notetrackSoundMapKeys=keys, notetrackSoundMapValues=values)
    assert weapon.value(w, "notetrackSoundMap", "notetrackSoundMapKeys", "WFT_NOTETRACKSOUNDMAP", {}) == "fire weap_fire"


# -- The registry ----------------------------------------------------------------------------------


def test_effects_and_sound_aliases_are_dumped_empty_and_their_stages_skip():
    """OAT had no IW4 dumper for either: a dump writes the listing alone, and nothing claims them whole."""
    backend = Backend()
    assert backend.dumps("fx") and backend.dumps("sound") and not backend.provides("fx") and not backend.provides("sound")
    assert backend.provides("gfxworld", "clipmap", "xmodel", "material", "image", "xanim", "weapon", "loadedsound")
    assert not backend.dumps("scriptfile") and not backend.dumps("attachment")  # IW4 has neither asset
    for kind in ("gfxworld", "clipmap", "xmodel", "material", "image", "xanim", "weapon"):
        assert dumpers.DUMPERS[kind].__module__.startswith("scripts.cod.iw5.dumpers")


def test_mw2_is_claimed_by_the_iw4_backend(tmp_path, monkeypatch):
    mw2 = tmp_path / "mp_x.ff"
    mw2.write_bytes(b"IWff0100" + (0x114).to_bytes(4, "little") + bytes(64))
    monkeypatch.setattr(Backend, "check", lambda self: None)
    assert Backend.claims(str(mw2))
    assert isinstance(backends.for_fastfile(str(mw2)), Backend)


# -- The real mp_rust ------------------------------------------------------------------------------


def mw2_zone(name):
    """A retail MW2 zone from the Steam depot scripts/cod/maps.json names, if installed."""
    from scripts.cod.maps import load_maps

    try:
        games, _maps = load_maps()
    except (OSError, ValueError, KeyError):
        return None
    for folder in games["mw2"]["zones"]:
        for path in glob.glob(os.path.join(folder, name + ".ff")):
            return path
    return None


WORLD = {"gfxworld": "gw", "clipmap": "clip", "mapents": "ents", "rawfile": "raw"}
ASSETS = {"xmodel": "models", "material": "mat", "image": "img", "loadedsound": "snd"}


@pytest.fixture(scope="module")
def rust_dump(tmp_path_factory):
    if not os.path.exists(program.path_for("iw4")):
        pytest.skip("no IW4 zonecode.json (reverse/x86-zone/build.sh iw4)")
    path = mw2_zone("mp_rust")
    if path is None:
        pytest.skip("MW2's mp_rust.ff is not installed")
    from scripts.cod.maps import load_maps

    search = ";".join(load_maps()[0]["mw2"]["search"])
    out = tmp_path_factory.mktemp("rust")
    backend = Backend(search)
    for kind, sub in {**WORLD, **ASSETS}.items():
        backend.dump(path, str(out / sub), kind)
    return out


@pytest.mark.parametrize("sub", sorted(WORLD.values()))
def test_rust_s_world_loses_nothing_the_golden_dump_holds(rust_dump, sub):
    golden = os.path.join(GOLDEN, "work", "rust-mw2", sub)
    if not os.path.isdir(golden):
        pytest.skip(f"no golden dump at {golden}")
    report = equiv.compare_trees(golden, str(rust_dump / sub))
    assert not report.failed, report.files
    assert report.compared and report.count(equiv.EXTRA) == 0


@pytest.mark.parametrize("sub", sorted(ASSETS.values()))
def test_rust_s_own_assets_lose_nothing_the_golden_dump_holds(rust_dump, sub, tmp_path):
    golden = os.path.join(GOLDEN, "work", "rust-mw2", sub)
    if not os.path.isdir(golden):
        pytest.skip(f"no golden dump at {golden}")
    report = equiv.compare_trees(golden_subset(golden, str(rust_dump / sub), str(tmp_path / "golden")), str(rust_dump / sub))
    assert not report.failed, report.files
    assert report.compared
