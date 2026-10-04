"""The IW5 world dumpers (scripts/cod/iw5/dumpers), and the guards that refuse a dump missing what they need.

The writers' logic is exercised on stand-ins for the walk's records, which is all a
writer reads; the real mp_dome is dumped and compared with A0's golden OAT dump
where both are installed ($COD_GOLDEN, default .cache/cod/golden).
"""

import json
import os
import struct
import zlib

import pytest

from scripts.cod import equiv
from scripts.cod.brushmodels import preflight
from scripts.cod.iw5.dumpers import DUMPERS, clipmap, gfxworld, mapents, rawfile, scriptfile
from scripts.cod.iw5.dumpers.common import corners, f32
from scripts.cod.volumes import require_axial_faces
from scripts.cod.zonecode import program

from .test_zonecode import depot_zone

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
GOLDEN = os.environ.get("COD_GOLDEN", os.path.join(REPO, ".cache", "cod", "golden"))


# -- Stand-ins for what a walk hands a writer ------------------------------------------------------


class Arr(list):
    """A loaded array: its elements, its bytes, where the loader put it."""

    def __init__(self, items=(), data=b"", elem=1, address=(3, 0)):
        super().__init__(items)
        self.data, self.elem, self.address = data, elem, address

    def bytes(self):
        return memoryview(self.data)

    def unpack(self, fmt):
        return struct.iter_unpack(fmt, self.data)

    def view(self, first, count):
        return Arr(self[first : first + count], self.data[first * self.elem : (first + count) * self.elem], self.elem)


class Rec(dict):
    """A record: members by path, and packed bytes for the ones read with `unpack`."""

    def __init__(self, members=(), packed=None):
        super().__init__(members)
        self.packed = packed or {}

    def __getitem__(self, path):
        return self.get(path)

    def unpack(self, fmt, path):
        return struct.unpack(fmt, self.packed[path])


class Named:
    def __init__(self, name, record=None):
        self.name, self.record = name, record


class Walk:
    def __init__(self, **by_type):
        self.by = by_type
        self.path = "stand-in.ff"

    def by_type(self, kind):
        return self.by.get(kind, [])


def u16s(*values):
    return Arr(values, struct.pack(f"<{len(values)}H", *values), 2)


# -- Text kinds ------------------------------------------------------------------------------------


def test_mapents_drops_the_terminating_nul(tmp_path):
    text = b'{\n"classname" "worldspawn"\n}\n\0'
    ents = Rec({"entityString": Arr(data=text), "numEntityChars": len(text)})
    mapents.write(Walk(mapents=[Named("maps/mp/mp_x.d3dbsp", ents)]), str(tmp_path))
    assert (tmp_path / "maps/mp/mp_x.d3dbsp.ents").read_bytes() == text[:-1]


def test_rawfile_inflates_and_an_uncompressed_one_is_empty(tmp_path):
    body = b"visionSetNaked mp_x\n"
    packed = zlib.compress(body)
    files = [
        Named("vision/mp_x.vision", Rec({"compressedLen": len(packed), "len": len(body), "buffer": Arr(data=packed)})),
        # mp_dome names such a one after itself: eight bytes of deflate for nothing.
        Named("mp_x", Rec({"compressedLen": 0, "len": 0, "buffer": None})),
    ]
    rawfile.write(Walk(rawfile=files), str(tmp_path))
    assert (tmp_path / "vision/mp_x.vision").read_bytes() == body
    assert (tmp_path / "mp_x").read_bytes() == b""


def test_scriptfile_is_the_gscbin_container(tmp_path):
    strings, code = zlib.compress(b"main\0"), bytes(range(7))
    script = Rec(
        {"compressedLen": len(strings), "len": 5, "bytecodeLen": 7, "buffer": Arr(data=strings), "bytecode": Arr(data=code)}
    )
    scriptfile.write(Walk(scriptfile=[Named("1443", script)]), str(tmp_path))
    data = (tmp_path / "1443.gscbin").read_bytes()
    assert data == b"1443\0" + struct.pack("<3i", len(strings), 5, 7) + strings + code


# -- gfxworld --------------------------------------------------------------------------------------


def test_bounds_corners_are_single_precision():
    box = corners((0.1, 2.0, -3.0, 0.2, 1.0, 1.0))
    assert box["mins"] == {"x": f32(0.1 - 0.2), "y": 1.0, "z": -4.0}
    assert box["maxs"]["x"] == f32(0.1 + 0.2) != 0.1 + 0.2


def test_brush_models_keep_the_world_first_and_their_local_bounds():
    world = Rec(
        {
            "models": [
                Rec({"surfaceCount": 3, "startSurfIndex": 0}, {"bounds": struct.pack("<6f", 0, 0, 0, 10, 10, 10)}),
                Rec({"surfaceCount": 0, "startSurfIndex": 65535}, {"bounds": struct.pack("<6f", 1, 0, 0, 1, 1, 1)}),
            ]
        }
    )
    models = gfxworld.brush_models(world)
    assert [m["surfaceCount"] for m in models] == [3, 0]
    assert models[1]["bounds"] == {"mins": {"x": 0.0, "y": -1.0, "z": -1.0}, "maxs": {"x": 2.0, "y": 1.0, "z": 1.0}}


def test_gfxworld_refuses_counts_its_arrays_do_not_hold():
    data = {"vertexCount": 4, "indexCount": 6, "surfaceCount": 1, "surfaces": [{}], "staticModelCount": 0}
    data |= {"staticModels": [], "modelCount": 1, "models": [{}]}
    gfxworld._check_counts("w", data, Arr([0] * 4), Arr([0] * 6))
    with pytest.raises(SystemExit, match="vertexCount 4 but 3 loaded"):
        gfxworld._check_counts("w", data, Arr([0] * 3), Arr([0] * 6))


# -- clipmap ---------------------------------------------------------------------------------------


def leaf(count, brushes=(), offsets=(0, 0)):
    return Rec(
        {"leafBrushCount": count, "data.leaf.brushes": u16s(*brushes) if brushes else None, "data.children.childOffset": offsets}
    )


def test_the_leaf_brush_tree_takes_straddlers_after_a_negative_count():
    nodes = [
        leaf(-1, offsets=(2, 3)),  # a split whose next node holds the brushes straddling it
        leaf(2, (7, 8)),
        leaf(1, (4,)),
        leaf(0, offsets=(1, 0)),  # a split with one child
        leaf(1, (5,)),
    ]
    info = Rec({"leafbrushNodes": nodes, "leafbrushNodesCount": len(nodes)})
    assert clipmap.leaf_brushes(info, 0) == {4, 5, 7, 8}
    assert clipmap.leaf_brushes(info, 3) == {5}
    assert clipmap.leaf_brushes(info, 9) == set()  # past the table: nothing, not an error


def test_aabb_partitions_are_the_leaves_under_the_roots():
    nodes = [
        Rec({"childCount": 2, "u.firstChildIndex": 1}),
        Rec({"childCount": 0, "u.partitionIndex": 3}),
        Rec({"childCount": 0, "u.partitionIndex": 99}),  # no such partition
        Rec({"childCount": 0, "u.partitionIndex": 0}),
    ]
    clip = Rec({"aabbTrees": nodes, "aabbTreeCount": len(nodes), "partitionCount": 4})
    assert clipmap.aabb_partitions(clip, 0, 1) == {3}
    assert clipmap.aabb_partitions(clip, 2, 2) == {0}


def submodel(info, brush_contents, node):
    fields = {"brushContents": brush_contents, "terrainContents": 0, "leafBrushNode": node}
    fields |= {"firstCollAabbIndex": 0, "collAabbCount": 0}
    return Rec({"info": info, "leaf": Rec(fields), "radius": 1.0}, {"bounds": struct.pack("<6f", 0, 0, 0, 1, 1, 1)})


def test_submodels_resolve_brushes_only_from_the_maps_own_clip_info():
    nodes = Arr([leaf(1, (6,))], address=(3, 0x100))
    brushes = Arr([], address=(3, 0x200))
    info = Rec({"leafbrushNodes": nodes, "leafbrushNodesCount": 1, "brushes": brushes})
    foreign = Rec({"leafbrushNodes": Arr([leaf(1, (6,))], address=(3, 0x900)), "leafbrushNodesCount": 1, "brushes": brushes})
    cmodels = [submodel(None, 0, 0), submodel(info, 1, 0), submodel(foreign, 1, 0)]
    clip = Rec({"cmodels": cmodels, "aabbTrees": None})
    world, own, other = clipmap.submodels(clip, info)
    # A brushless submodel points at node 0, the world's first node: not walked.
    assert world["brushes"] == [] and "foreignClipInfo" not in world
    assert own["brushes"] == [6] and "foreignClipInfo" not in own
    assert other["brushes"] == [] and other["foreignClipInfo"] is True


def test_dynamic_entities_name_the_brush_model_they_place():
    pose = {"pose.origin": (1.0, 2.0, 3.0), "pose.quat": (0.0, 0.0, 0.0, 1.0)}
    base = {"type": 1, "contents": 1, "health": 0, "physicsBrushModel": 0} | pose
    lists = {
        "dynEntDefList[0]": [Rec(base | {"xModel": Named("crate"), "brushModel": 0})],
        "dynEntDefList[1]": [Rec(base | {"xModel": None, "brushModel": 12})],
    }
    [[crate], [panel]] = clipmap.dynamic_entities(Rec(lists))
    assert crate["model"] == "crate" and "brushModel" not in crate
    assert panel == {"type": 1, "contents": 1, "health": 0, "origin": {"x": 1.0, "y": 2.0, "z": 3.0},
                     "quat": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}, "brushModel": 12}  # fmt: skip


def test_edge_walkable_is_the_zones_own_length(tmp_path):
    bits = bytes(8)
    clip = Rec(
        {
            "vertCount": 3,
            "verts": Arr(data=bytes(36), elem=12),
            "triCount": 50,
            "triIndices": Arr(data=bytes(300), elem=2),
            "triEdgeIsWalkable": Arr(data=bits),
        }
    )
    data = {}
    clipmap.soup(clip, str(tmp_path), "m", data)
    assert (tmp_path / "m.clipmap_edgewalkable.bin").read_bytes() == bits
    assert equiv.edge_walkable_size(50) == 20  # 150 bits in whole words; the zone rounds the same way
    assert data["vertStride"] == 12 and data["triStride"] == 2


def test_equiv_reads_only_the_meaningful_edge_bits(tmp_path):
    # OAT's writer takes `triCount` bytes, running on into whatever follows the array.
    for side, blob in (("g", bytes(4) + b"junk" * 3), ("c", bytes(4))):
        folder = tmp_path / side
        folder.mkdir()
        (folder / "m.clipmap.json").write_text(
            json.dumps({"_type": "clipmap", "triCount": 10, "edgeWalkableFile": "m.clipmap_edgewalkable.bin"})
        )
        (folder / "m.clipmap_edgewalkable.bin").write_bytes(blob)
    report = equiv.compare_trees(str(tmp_path / "g"), str(tmp_path / "c"))
    assert not report.failed
    (tmp_path / "c" / "m.clipmap_edgewalkable.bin").write_bytes(b"\1" + bytes(3))
    assert equiv.compare_trees(str(tmp_path / "g"), str(tmp_path / "c")).failed


# -- The guards a dump must satisfy ----------------------------------------------------------------


def test_preflight_refuses_a_gfxworld_without_models(tmp_path):
    with pytest.raises(SystemExit, match="no `models` table"):
        preflight({"surfaces": []}, {"cmodels": []}, True, str(tmp_path / "x.ents"))


def test_preflight_refuses_a_clipmap_without_cmodels(tmp_path):
    with pytest.raises(SystemExit, match="no `cmodels`"):
        preflight({"models": []}, {"brushes": []}, True, str(tmp_path / "x.ents"))


def test_require_axial_faces_refuses_brushes_without_them():
    bounds = {"midPoint": [0, 0, 0], "halfSize": [1, 1, 1]}
    require_axial_faces({"_game": "iw5", "brushes": [{"bounds": bounds, "axialMaterialNum": [[0] * 3] * 2}]})
    with pytest.raises(SystemExit, match="axialMaterialNum"):
        require_axial_faces({"_game": "iw5", "brushes": [{"bounds": bounds, "sides": []}]})


# -- The real mp_dome ------------------------------------------------------------------------------


KINDS = {"gfxworld": "gw", "clipmap": "clip", "mapents": "ents", "rawfile": "raw", "scriptfile": "scripts"}


@pytest.fixture(scope="module")
def dome_dump(tmp_path_factory):
    if not os.path.exists(program.path_for("iw5")):
        pytest.skip("no IW5 zonecode.json (reverse/x86-zone/build.sh iw5)")
    path = depot_zone("mp_dome")
    if path is None:
        pytest.skip("MW3's mp_dome.ff is not installed")
    from scripts.cod.iw5.backend import Backend

    out = tmp_path_factory.mktemp("dome")
    backend = Backend()
    for kind, sub in KINDS.items():
        backend.dump(path, str(out / sub), kind)
    return out


def test_every_world_kind_is_registered():
    assert set(KINDS) <= set(DUMPERS)


@pytest.mark.parametrize("sub", sorted(KINDS.values()))
def test_dome_loses_nothing_the_golden_dump_holds(dome_dump, sub):
    golden = os.path.join(GOLDEN, "work", "dome-mw3", sub)
    if not os.path.isdir(golden):
        pytest.skip(f"no golden dump at {golden}")
    report = equiv.compare_trees(golden, str(dome_dump / sub))
    assert not report.failed, report.files
    assert report.compared and report.count(equiv.EXTRA) == 0


def test_dome_passes_both_guards_and_fails_them_without_their_fields(dome_dump, tmp_path):
    gw = json.loads((dome_dump / "gw/maps/mp/mp_dome.d3dbsp.gfxworld.json").read_text())
    clip = json.loads((dome_dump / "clip/maps/mp/mp_dome.d3dbsp.clipmap.json").read_text())
    ents = str(dome_dump / "ents/maps/mp/mp_dome.d3dbsp.ents")
    placements = preflight(gw, clip, True, ents)
    assert len(placements) == 36  # every brush model but the world
    require_axial_faces(clip)

    with pytest.raises(SystemExit, match="no `models` table"):
        preflight({k: v for k, v in gw.items() if k != "models"}, clip, True, ents)
    with pytest.raises(SystemExit, match="no `cmodels`"):
        preflight(gw, {k: v for k, v in clip.items() if k != "cmodels"}, True, ents)
    stripped = {**clip, "brushes": [{k: v for k, v in b.items() if k != "axialMaterialNum"} for b in clip["brushes"]]}
    with pytest.raises(SystemExit, match="axialMaterialNum"):
        require_axial_faces(stripped)
