"""The Advanced Warfare (S1) backend: what it claims, and that its dumps are the schema the pipeline reads.

No game files: every zone here is a handful of bytes laid out against a layout
written for the test, which is how scripts/cod/tests/test_iw6.py works too.
"""

import json
import os
import random
import struct
import tracemalloc

import pytest

from scripts.cod import backends, brushmodels, entities, export
from scripts.cod.collision import brush_planes, face_flags
from scripts.cod.iw6 import ff as iw6_ff
from scripts.cod.iw6.dumpers.material import slot_hash
from scripts.cod.iw6.records import Material, Placement, Raw
from scripts.cod.iw6.renderstate import state_bits as iw6_state_bits
from scripts.cod.iw6.zone import KIND_FLOAT, KIND_POINTER, KIND_SIGNED, KIND_UNSIGNED, Layout, Record, Zone
from scripts.cod.materials import SURFACES_BY_GAME, TECHNIQUES_BY_GAME, material_render_state
from scripts.cod.metadata import zone_listing
from scripts.cod.s1 import ff, images, walkers
from scripts.cod.s1.backend import Backend
from scripts.cod.s1.dumpers import COMPLETE, DUMPERS, PARTS, Walked
from scripts.cod.s1.dumpers import clipmap as clipmap_dump
from scripts.cod.s1.dumpers import gfxworld as gfxworld_dump
from scripts.cod.s1.dumpers import mapents as mapents_dump
from scripts.cod.s1.dumpers import material as material_dump
from scripts.cod.s1.dumpers import rawfile as rawfile_dump
from scripts.cod.s1.dumpers.zonesource import write_listing
from scripts.cod.s1.renderstate import cached_states, camera_region, state_bits
from scripts.cod.s1.walkers import World

U1 = (1, KIND_UNSIGNED, "")
U2 = (2, KIND_UNSIGNED, "")
U4 = (4, KIND_UNSIGNED, "")
I4 = (4, KIND_SIGNED, "")
F4 = (4, KIND_FLOAT, "")
PTR = (8, KIND_POINTER, "")


def layout_rows(types):
    """layout.json rows for {type: [(member, size, kind, base type or "", offset?)]}.

    Members are laid end to end unless one gives its own offset, which is how a
    union is written: both members at the offset the struct's own layout has."""
    rows = []
    for typename, members in types.items():
        offset, end = 0, 0
        for member in members:
            name, size, kind, base = member[:4]
            offset = member[4] if len(member) > 4 else offset
            rows.append([typename, name, offset, size, size, 0, kind, 0, 0, base])
            offset += size
            end = max(end, offset)
        rows.append([typename, "", 0, end, 0, 0, 0, 0, 0, ""])
    return rows


def a_layout(tmp_path, types, name="layout.json"):
    path = tmp_path / name
    path.write_text(json.dumps(layout_rows(types)))
    return Layout(str(path))


def a_zone(layout, blobs):
    """(Zone, {key: file offset}) for named blobs laid after a 72-byte XFile header."""
    data, at = bytearray(72), {}
    for key, blob in blobs:
        at[key] = len(data)
        data += blob
    return Zone(bytes(data), layout), at


# --- which backend reads which fastfile ------------------------------------


def test_only_an_s1_header_is_claimed(tmp_path):
    s1, iw6 = tmp_path / "a.ff", tmp_path / "b.ff"
    s1.write_bytes(ff.MAGIC + struct.pack("<I", ff.VERSION) + bytes(64))
    iw6.write_bytes(iw6_ff.MAGIC + struct.pack("<I", iw6_ff.VERSION) + bytes(64))
    assert Backend.claims(s1) and not Backend.claims(iw6)
    # The two Python backends must not both claim a file: for_fastfile picks one.
    assert not any(cls.claims(s1) and cls.claims(iw6) for cls in backends.BACKENDS)
    assert [cls.name for cls in backends.BACKENDS if cls.claims(s1)] == ["s1"]


def test_a_kind_with_no_writer_is_absent_rather_than_empty():
    """`export.py` skips a stage whose dump the backend does not write whole."""
    backend = Backend()
    assert backend.provides("gfxworld", "clipmap", "mapents", "rawfile", "image", "material", "xmodel", "xanim")
    # The viewmodel, effects and sound all read kinds this backend has no walker for.
    for kind in ("fx", "sound", "loadedsound", "scriptfile"):
        assert not backend.dumps(kind) and not backend.provides(kind)
    # A weapon file is written by key, and an attachment as its edits: neither whole.
    for kind in ("weapon", "attachment"):
        assert backend.dumps(kind) and not backend.provides(kind)
    assert set(DUMPERS) == COMPLETE | set(PARTS)


def test_a_companion_walk_is_dropped_before_the_next_one_starts(monkeypatch):
    """A map keeps its walk; a companion zone's goes before the next is read, not after."""
    held = []
    backend = Backend()

    def walk_zone(path):
        held.append(sorted(os.path.basename(k) for k in backend._walked))
        z = type("Z", (), {"found": {}})()
        return type("W", (), {"failed": None, "z": z, "assets": []})(), (object() if "mp_" in path else None)

    monkeypatch.setattr(walkers, "walk_zone", walk_zone)
    for zone in ("mp_x.ff", "common_core_mp.ff", "common_mp.ff", "mp_x.ff"):
        backend.walk(zone)
    assert held == [[], ["mp_x.ff"], ["mp_x.ff"]]  # the map was walked once, and never beside two others
    assert sorted(os.path.basename(k) for k in backend._walked) == ["common_mp.ff", "mp_x.ff"]


def test_an_export_lets_every_walk_go_after_its_dumps_but_a_map_its_path_nodes_come_from(monkeypatch):
    """Stage 1 is the last to read a walk, bar Black Ops' and Black Ops II's path nodes, which are in the map zone."""
    backend = Backend()

    def walk_zone(path):
        z = type("Z", (), {"found": {}})()
        return type("W", (), {"failed": None, "z": z, "assets": []})(), (object() if "mp_" in path else None)

    monkeypatch.setattr(walkers, "walk_zone", walk_zone)
    for zone in ("mp_x.ff", "common_mp.ff"):
        backend.walk(zone)
    export._release_walks(backend, "mp_x", "mp_x.ff", "s1")  # AW's path nodes are in mp_x_path.ff
    assert backend._walked == {}

    kept = []
    held = type("B", (), {"release": lambda self, keep: kept.append([os.path.basename(k) for k in keep])})()
    export._release_walks(held, "mp_x", "/zones/mp_x.ff", "t5")
    export._release_walks(held, "mp_x", "/zones/mp_x.ff", "t6")  # and Black Ops II's
    export._release_walks(held, "mp_x", "/zones/mp_x.ff", "iw5")
    assert kept == [["mp_x.ff"], ["mp_x.ff"], []]


def test_a_zone_is_decompressed_into_one_buffer_not_grown_and_copied():
    """An AW map's zone is 800 MB: growing it and copying it to bytes held it twice."""
    rng = random.Random(3)
    chunks = [rng.randbytes(0x4000) for _ in range(64)]
    payload = a_span(chunks)
    ff.decompress("x", payload)  # warm
    tracemalloc.start()
    try:
        zone, _ = ff.decompress("x", payload)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert zone == b"".join(chunks)
    assert peak < 1.25 * len(zone), f"peak {peak} bytes for a {len(zone)}-byte zone"


# --- gfxworld ---------------------------------------------------------------


def s1_vertex(normal):
    """A GfxWorldVertex: xyz, binormalSign, colour, texCoord, lmapCoord, normal, tangent (IW6's, byte for byte)."""
    packed = 0x40000000 | (int((normal[2] + 1) / 2 * 1023) << 20) | (int((normal[1] + 1) / 2 * 1023) << 10)
    packed |= int((normal[0] + 1) / 2 * 1023)
    return struct.pack("<3f f 4s 4f I I", 0.0, 0.0, 0.0, 1.0, b"\xff" * 4, 0, 0, 0, 0, packed, packed)


WORLD_TYPES = {
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
    "Tris": [("firstVertex", *U4), ("vertexCount", *U2), ("triCount", *U2), ("baseIndex", *U4)],
    "LafFields": [("lightmapIndex", *U1)],
    "Laf": [("fields", 1, 0, "LafFields")],
    "GfxSurface": [("tris", 12, 0, "Tris"), ("laf", 1, 0, "Laf")],
    "GfxBrushModel": [("bounds", 24, 0, "Bounds"), ("startSurfIndex", *U4), ("surfaceCount", *U2)],
}


def test_gfxworld_manifest_is_the_schema_the_shell_and_brush_models_read(tmp_path):
    layout = a_layout(tmp_path, WORLD_TYPES)
    header = struct.pack("<3I6f4I", 7, 2, 2, 0, 0, 0, 1, 1, 1, 4, 6, 1, 1)
    surfaces = struct.pack("<IHHIB", 0, 4, 1, 0, 0) + struct.pack("<IHHIB", 1, 3, 1, 3, 31)
    models = struct.pack("<6fIH", 0, 0, 0, 9, 9, 9, 0, 1) + struct.pack("<6fIH", 0, 0, 0, 1, 1, 1, 1, 1)
    vertices = b"".join(s1_vertex((0, 0, 1)) for _ in range(4))
    indices = struct.pack("<6H", 0, 1, 2, 0, 1, 2)
    zone, at = a_zone(
        layout,
        (("header", header), ("surfaces", surfaces), ("models", models), ("vertices", vertices), ("indices", indices)),
    )

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

    out = tmp_path / "gw"
    manifest = json.loads((out / "maps" / "mp" / "mp_test.d3dbsp.gfxworld.json").read_text())
    # scripts/cod/shell.py reads the blobs by the names and strides the manifest gives,
    # and those names are relative to the dump root, not to the manifest.
    verts = (out / manifest["vertexFile"]).read_bytes()
    index = struct.unpack(f"<{manifest['indexCount']}H", (out / manifest["indexFile"]).read_bytes())
    assert manifest["_game"] == "s1" and verts == vertices and index == (0, 1, 2, 0, 1, 2)
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
    assert (manifest["vertexStride"], manifest["indexStride"]) == (44, 2)


def test_the_gfxworld_manifest_has_the_same_fields_as_iw6s(tmp_path):
    """One reader takes both dumps, so a field in one and not the other is a bug."""
    from scripts.cod.iw6.dumpers import gfxworld as iw6_gfxworld

    layout = a_layout(tmp_path, WORLD_TYPES)
    zone, at = a_zone(layout, (("header", struct.pack("<3I6f4I", 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0)),))
    world = World("n", "n", Record(zone, "GfxWorld", at["header"], None, None), 72, 72, [], set(), [], [], None, 72)
    mine = {**iw6_gfxworld.manifest(zone, world), "_game": "s1"}
    assert set(mine) == set(iw6_gfxworld.manifest(zone, world))


# --- clipmap ----------------------------------------------------------------

CLIP_TYPES = {
    "Bounds": [("midPoint", 12, KIND_FLOAT, ""), ("halfSize", 12, KIND_FLOAT, "")],
    "cbrush_t": [
        ("numsides", *U2),
        ("glassPieceIndex", *U2),
        ("_pad", 4, KIND_UNSIGNED, ""),
        ("sides", *PTR),
        ("baseAdjacentSide", *PTR),
        ("axialMaterialNum", 12, KIND_UNSIGNED, ""),
    ],
    "cbrushside_t": [("planeIndex", *I4), ("materialNum", *U2), ("firstAdjacentSideOffset", *U1), ("edgeCount", *U1)],
    "CollisionPartition": [("triCount", *U1), ("borderCount", *U1), ("firstVertSegment", *U1), ("_pad", *U1), ("firstTri", *U4)],
    # A union: both names read the same four bytes.
    "CollisionAabbTreeIndex": [("firstChildIndex", *U4, 0), ("partitionIndex", *U4, 0)],
    "CollisionAabbTree": [
        ("midPoint", 12, KIND_FLOAT, ""),
        ("materialIndex", *U2),
        ("childCount", *U2),
        ("halfSize", 12, KIND_FLOAT, ""),
        ("u", 4, 0, "CollisionAabbTreeIndex"),
    ],
    "cLeafBrushNodeLeaf_t": [("brushes", *PTR)],
    "cLeafBrushNodeChildren_t": [("dist", *F4), ("range", *F4), ("childOffset", 4, KIND_UNSIGNED, "")],
    "cLeafBrushNodeData_t": [("leaf", 8, 0, "cLeafBrushNodeLeaf_t", 0), ("children", 12, 0, "cLeafBrushNodeChildren_t", 0)],
    "cLeafBrushNode_s": [
        ("axis", *U1),
        ("_pad", *U1),
        ("leafBrushCount", 2, KIND_SIGNED, ""),
        ("contents", *U4),
        ("data", 16, 0, "cLeafBrushNodeData_t"),
    ],
    "cLeaf_t": [
        ("firstCollAabbIndex", *U4),
        ("collAabbCount", *U4),
        ("brushContents", *I4),
        ("terrainContents", *I4),
        ("bounds", 24, 0, "Bounds"),
        ("leafBrushNode", *U4),
    ],
    "cmodel_t": [
        ("bounds", 24, 0, "Bounds"),
        ("radius", *F4),
        ("_pad", 4, KIND_UNSIGNED, ""),
        ("info", *PTR),
        ("leaf", 44, 0, "cLeaf_t"),
    ],
    "cStaticModel_s": [
        ("xmodel", *PTR),
        ("origin", 12, KIND_FLOAT, ""),
        ("invScaledAxis", 36, KIND_FLOAT, ""),
        ("absBounds", 24, 0, "Bounds"),
        ("lightingHandle", *U4),
    ],
    "GfxPlacement": [("quat", 16, KIND_FLOAT, ""), ("origin", 12, KIND_FLOAT, "")],
    "DynEntityDef": [
        ("type", *U4),
        ("pose", 28, 0, "GfxPlacement"),
        ("baseModel", *PTR),
        ("brushModel", *U2),
        ("physicsBrushModel", *U2),
        ("scriptableIndex", *U2),
        ("health", 2, KIND_SIGNED, ""),
        ("contents", *I4),
    ],
}

SURFACE_FLAGS, CONTENTS = 0x000440A0, 0x08031640


def a_clipmap(tmp_path):
    """A one-brush, one-submodel clipmap: a 64-unit cube with a single bevel, and its soup."""
    layout = a_layout(tmp_path, CLIP_TYPES, "clip-layout.json")
    planes = struct.pack("<3ffB3x", 0.0, 0.0, 1.0, 32.0, 0)
    sides = struct.pack("<iHBB", 0, 0, 0, 0)
    brushes = struct.pack("<HH4xQQ6H", 1, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    bounds = struct.pack("<6f", 1.0, 2.0, 3.0, 32.0, 32.0, 32.0)
    contents = struct.pack("<i", CONTENTS)
    leafbrush_nodes = struct.pack("<BxhI16x", 0, 1, CONTENTS)
    leafbrushes = struct.pack("<H", 0)
    aabb = struct.pack("<3fHH3fI", 0, 0, 0, 0, 0, 1, 1, 1, 0)
    partitions = struct.pack("<BBBxI", 2, 0, 0, 0)
    verts = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    tris = struct.pack("<6H", 0, 1, 2, 0, 1, 2)
    edges = struct.pack("<I", 0)
    cmodels = struct.pack("<6ff4xQ", 1, 2, 3, 32, 32, 32, 4.0, 0) + struct.pack("<IIii6fI", 0, 1, CONTENTS, 0, *([0.0] * 6), 0)
    smodels = struct.pack("<Q3f9f6fI4x", 0, 1, 2, 3, *([1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0]), 1, 2, 3, 4, 4, 4, 0)
    dynents = struct.pack("<I4f3fQHHHhi", 0, 0, 0, 0, 1, 5, 6, 7, 0, 3, 0, 0, 100, CONTENTS)
    zone, at = a_zone(
        layout,
        (
            ("planes", planes),
            ("brushSides", sides),
            ("brushes", brushes),
            ("brushBounds", bounds),
            ("brushContents", contents),
            ("leafbrushNodes", leafbrush_nodes),
            ("leafbrushes", leafbrushes),
            ("aabbTrees", aabb),
            ("partitions", partitions),
            ("verts", verts),
            ("triIndices", tris),
            ("triEdgeIsWalkable", edges),
            ("cmodels", cmodels),
            ("staticModelList", smodels),
            ("dynEntDefList", dynents),
        ),
    )
    clip = {
        "planes_at": at["planes"],
        "planeCount": 1,
        "materials": [("clip_nosight_rock", SURFACE_FLAGS, CONTENTS)],
        "numMaterials": 1,
        "brushSides_at": at["brushSides"],
        "numBrushSides": 1,
        "brushes_at": at["brushes"],
        "numBrushes": 1,
        "brush_sides": [at["brushSides"]],
        "brushBounds_at": at["brushBounds"],
        "brushContents_at": at["brushContents"],
        "leafbrushNodes_at": at["leafbrushNodes"],
        "leafbrushNodesCount": 1,
        "leafbrush_nodes": [at["leafbrushes"]],
        "leafbrushes_at": at["leafbrushes"],
        "numLeafBrushes": 1,
        "aabbTrees_at": at["aabbTrees"],
        "aabbTreeCount": 1,
        "partitions_at": at["partitions"],
        "partitionCount": 1,
        "borders_at": None,
        "borderCount": 0,
        "verts_at": at["verts"],
        "vertCount": 3,
        "triIndices_at": at["triIndices"],
        "triCount": 2,
        "triEdgeIsWalkable_at": at["triEdgeIsWalkable"],
        "cmodels_at": at["cmodels"],
        "numSubModels": 1,
        "foreignClipInfo": [False],
        "staticModelList_at": at["staticModelList"],
        "numStaticModels": 1,
        "staticModels": [",prop_crate"],
        "dynEntDefList_at": [at["dynEntDefList"], None],
        "dynEntCount": [1, 0],
        "dynEntModels": [["prop_door"], []],
        "checksum": 1234,
    }
    zone.found["CLIPMAP"] = {"maps/mp/mp_test.d3dbsp": clip}
    return zone, clip


def test_a_clipmap_brush_is_its_bounds_its_axial_materials_and_its_bevels(tmp_path):
    zone, clip = a_clipmap(tmp_path)
    assert clipmap_dump.materials(clip) == [{"name": "clip_nosight_rock", "surfaceFlags": SURFACE_FLAGS, "contents": CONTENTS}]
    (brush,) = clipmap_dump.brushes(zone, clip)
    assert brush["numsides"] == 1
    assert brush["contents"] == CONTENTS
    assert brush["bounds"] == {"midPoint": [1.0, 2.0, 3.0], "halfSize": [32.0, 32.0, 32.0]}
    assert brush["axialMaterialNum"] == [[0, 0, 0], [0, 0, 0]]
    # S1's cbrushside_t names its plane by index; the normal comes from ClipInfo.planes.
    assert brush["sides"] == [{"materialNum": 0, "normal": [0.0, 0.0, 1.0], "dist": 32.0}]
    assert face_flags(brush, clipmap_dump.materials(clip), "s1") == [(SURFACE_FLAGS, "clip_nosight_rock")] * 7
    assert len(brush_planes(brush)) == 7


def test_a_clipmap_dump_is_what_the_collision_and_prop_stages_read(tmp_path):
    zone, clip = a_clipmap(tmp_path)
    clipmap_dump.write(Walked("mp_test.ff", zone, None), str(tmp_path / "clip"))
    data = json.loads((tmp_path / "clip" / "maps" / "mp" / "mp_test.d3dbsp.clipmap.json").read_text())
    assert data["_game"] == "s1" and data["_type"] == "clipmap"
    assert (data["vertStride"], data["triStride"]) == (12, 2)
    assert data["cmodels"] == [
        {
            "bounds": {"midPoint": [1.0, 2.0, 3.0], "halfSize": [32.0, 32.0, 32.0]},
            "radius": 4.0,
            "brushContents": CONTENTS,
            "terrainContents": 0,
            "leafBrushNode": 0,
            "firstCollAabbIndex": 0,
            "collAabbCount": 1,
            "brushes": [0],
            "partitions": [0],
        }
    ]
    # A leading comma marks another zone's asset; the pipeline wants the plain name.
    assert data["staticModels"][0]["model"] == "prop_crate"
    assert data["staticModels"][0]["origin"] == [1.0, 2.0, 3.0]
    assert data["dynEnts"][0] == [
        {
            "type": 0,
            "contents": CONTENTS,
            "health": 100,
            "origin": [5.0, 6.0, 7.0],
            "quat": [0.0, 0.0, 0.0, 1.0],
            "model": "prop_door",
            "brushModel": 3,
        }
    ]
    assert data["dynEnts"][1] == [] and data["dynEntCount"] == [1, 0]
    assert data["aabbTrees"] == [{"materialIndex": 0, "childCount": 0, "partition": 0}]
    assert data["partitions"] == [{"triCount": 2, "borderCount": 0, "firstVertSegment": 0, "firstTri": 0}]
    verts = (tmp_path / "clip" / "maps" / "mp" / "mp_test.d3dbsp.clipmap_verts.bin").read_bytes()
    assert len(verts) == 3 * 12
    # brushmodels.preflight refuses a pair of dumps that do not describe the same map.
    gfxworld = {"models": [{"surfaceCount": 0, "startSurfIndex": 0}]}
    assert len(gfxworld["models"]) == len(data["cmodels"])


def test_a_brush_whose_sides_miss_the_array_is_refused_not_clamped(tmp_path):
    zone, clip = a_clipmap(tmp_path)
    clip["brush_sides"] = [clip["brushSides_at"] + 3]
    with pytest.raises(SystemExit, match="not an element"):
        clipmap_dump.brushes(zone, clip)
    clip["brush_sides"] = [clip["brushSides_at"] + 8]  # past the one side there is
    with pytest.raises(SystemExit, match="not an element"):
        clipmap_dump.brushes(zone, clip)


def test_a_plane_a_side_names_must_exist_and_be_a_unit_normal(tmp_path):
    zone, clip = a_clipmap(tmp_path)
    # The planes are aliased from another asset, so "is this the right array" is a
    # real question and the normals are the only cheap answer to it.
    with pytest.raises(SystemExit, match="not a unit normal"):
        clipmap_dump.plane(_zeroed(zone, clip["planes_at"], 12), clip, 0)
    with pytest.raises(SystemExit, match="names plane"):
        clipmap_dump.plane(zone, clip, 1)
    with pytest.raises(SystemExit, match="neither written nor resolved"):
        clipmap_dump.plane(zone, {**clip, "planes_at": None}, 0)


def test_a_bevel_that_misses_its_own_brush_is_refused(tmp_path):
    # The sharpest evidence that the aliased plane array is the right one: a brush
    # is the intersection of its planes, so a plane that puts the whole bounding
    # box outside its half-space describes an empty brush, which cannot exist.
    zone, clip = a_clipmap(tmp_path)
    assert clipmap_dump.brushes(zone, clip)[0]["sides"][0]["dist"] == 32.0
    moved = bytearray(zone.data)
    struct.pack_into("<f", moved, clip["planes_at"] + 12, -100.0)  # the cube's z runs -29..35
    with pytest.raises(SystemExit, match="misses its own bounds"):
        clipmap_dump.brushes(Zone(bytes(moved), zone.layout), clip)


def _zeroed(zone, at, size):
    data = bytearray(zone.data)
    data[at : at + size] = bytes(size)
    zeroed = Zone(bytes(data), zone.layout)
    return zeroed


# --- material ---------------------------------------------------------------

MATERIAL_TYPES = {
    "MaterialInfo": [
        ("name", *PTR),
        ("gameFlags", *U1),
        ("sortKey", *U1),
        ("textureAtlasRowCount", *U1),
        ("textureAtlasColumnCount", *U1),
        ("_pad", 4, KIND_UNSIGNED, ""),
        ("surfaceTypeBits", 8, KIND_UNSIGNED, ""),
    ],
    "Material": [
        ("info", 24, 0, "MaterialInfo"),
        ("stateBitsEntry", 180, KIND_UNSIGNED, ""),
        ("textureCount", *U1),
        ("constantCount", *U1),
        ("stateBitsCount", *U1),
        ("stateFlags", *U1),
        ("cameraRegion", *U1),
        ("materialType", *U1),
        ("layerCount", *U1),
        ("assetFlags", *U1),
    ],
}


# --- the small dumps --------------------------------------------------------


def test_rawfile_dump_is_the_text_metadata_reads(tmp_path):
    text = b"mp_test vision\n"
    zone, at = a_zone(a_layout(tmp_path, {"x": [("y", *U1)]}), (("raw", text + b"\0"),))
    zone.found["RAWFILE"] = {
        "vision/mp_test.vision": Raw("vision/mp_test.vision", at["raw"], 0, len(text)),
        ",vision/shared.vision": Raw(",vision/shared.vision", at["raw"], 0, len(text)),
    }
    rawfile_dump.write(Walked("mp_test.ff", zone, None), str(tmp_path / "raw"))
    assert (tmp_path / "raw" / "vision" / "mp_test.vision").read_bytes() == text
    # Another zone's rawfile is a stub here; writing it would overwrite the real one.
    assert not (tmp_path / "raw" / "vision" / "shared.vision").exists()


def test_mapents_dump_is_the_entity_lump_without_its_terminator(tmp_path):
    text = b'{\n"classname" "worldspawn"\n}\n'
    zone, at = a_zone(a_layout(tmp_path, {"x": [("y", *U1)]}), (("ents", text + b"\0"),))
    zone.found["MAPENTS"] = {"maps/mp/mp_test.d3dbsp": {"entity_string_at": at["ents"], "numEntityChars": len(text) + 1}}
    mapents_dump.write(Walked("mp_test.ff", zone, None), str(tmp_path / "ents"))
    assert (tmp_path / "ents" / "maps" / "mp" / "mp_test.d3dbsp.ents").read_bytes() == text


def test_the_spawn_table_is_appended_as_the_spawn_entities_it_was(tmp_path):
    """No AW lump holds a spawn: the linker moves them to MapEnts.spawnList."""
    text = b'{\n171 "worldspawn"\n}\n'
    records = mapents_dump.SPAWN_RECORD.pack(0, 1, 0, 0, 0, -4610.1, 363.5, 510.4, 0.0, 45.0, 0.0)
    records += mapents_dump.SPAWN_RECORD.pack(1, 2, 0, 0, 3, 12.0, -8.25, 0.0, 0.0, 0.0, 0.0)
    zone, at = a_zone(a_layout(tmp_path, {"x": [("y", *U1)]}), (("ents", text + b"\0"), ("spawns", records)))
    zone.script_strings = [None, "mp_tdm_spawn_allies_start", "mp_dm_spawn", "dm_spot"]
    zone.found["MAPENTS"] = {
        "maps/mp/mp_test.d3dbsp": {
            "entity_string_at": at["ents"],
            "numEntityChars": len(text) + 1,
            "spawns_at": at["spawns"],
            "spawnsCount": 2,
        }
    }
    mapents_dump.write(Walked("mp_test.ff", zone, None), str(tmp_path / "ents"))
    ents = entities.named_keys(entities.parse_ents(tmp_path / "ents" / "maps" / "mp" / "mp_test.d3dbsp.ents"), "s1")
    assert ents == [
        {"classname": "worldspawn"},
        {"classname": "mp_tdm_spawn_allies_start", "origin": "-4610.1 363.5 510.4", "angles": "0 45 0"},
        {"classname": "mp_dm_spawn", "origin": "12 -8.25 0", "angles": "0 0 0", "targetname": "dm_spot"},
    ]
    zone.script_strings[2] = "script_origin"  # a misread table names something that is not a spawn
    with pytest.raises(SystemExit, match="spawn table is misread"):
        mapents_dump.write(Walked("mp_test.ff", zone, None), str(tmp_path / "ents"))


def test_the_zone_listing_names_s1_and_metadata_reads_it_back(tmp_path):
    walked = Walked("mp_test.ff", None, None, None, [("GFXWORLD", "maps/mp/mp_test.d3dbsp", 0), ("MAP_ENTS", "x", 0)])
    path = write_listing(walked, str(tmp_path))
    game, listed = zone_listing(path)
    assert game == "s1"
    assert listed == {"gfxworld": ["maps/mp/mp_test.d3dbsp"], "mapents": ["x"]}


def test_the_material_dump_declares_exactly_the_fields_it_writes(tmp_path):
    """`Backend.writes` answers from FIELDS, so a field added and not declared is a lie."""
    layout = a_layout(tmp_path, MATERIAL_TYPES, "mat-layout.json")
    entries = bytes([0, 0xFF, 13]) + b"\xff" * 177  # ZPREPASS 0, nothing at 1, LIT 13
    info = struct.pack("<Q4B4xQ", 0, 0, 2, 3, 4, 0xABCD)  # name, gameFlags, sortKey, atlas rows/columns, surfaceTypeBits
    header = info + entries + struct.pack("<8B", 0, 0, 0, 0, 2, 0, 0, 0)  # counts, stateFlags, cameraRegion 2
    zone, at = a_zone(layout, (("material", header),))
    data = material_dump.material_json(zone, Material("wc/x", at["material"], "wc_y", [], None, None))
    assert set(data) - {"_type", "_version", "_game"} == set(material_dump.FIELDS)
    assert data["_game"] == "s1" and data["techniqueSet"] == "wc_y"
    # S1 has 180 techniques, not IW6's 412, and 0xFF is "this set has no such technique".
    assert len(data["stateBitsEntry"]) == 180
    assert data["stateBitsEntry"][:3] == [0, -1, 13]
    assert data["cameraRegion"] == "litDecal" and data["sortKey"] == 2
    assert data["textureAtlas"] == {"rows": 3, "columns": 4}
    # S1's surfaceTypeBits is 64 bits where IW6's is 32.
    assert data["surfaceTypeBits"] == 0xABCD


def test_a_camera_region_is_s1s_numbering_not_iw6s():
    # S1 numbers "none" 13 and names three regions; IW6 numbers it 8 and names eight.
    assert camera_region(13) == "none"
    assert (camera_region(0), camera_region(2), camera_region(3)) == ("litOpaque", "litDecal", "litTrans")
    assert camera_region(8) == 8  # a region S1 does not name keeps its number


# --- the streamed-image spans ----------------------------------------------


def a_span(chunks, total=None, flags=images.SPAN_FLAGS):
    """A pak span: the fastfile payload's framing over literal-only LZ4 blocks."""
    body = b""
    for chunk in chunks:
        block = _lz4_literals(chunk)
        body += images.CHUNK_HEADER.pack(len(block), len(chunk)) + block
        body += b"\0" * (-len(body) % 4)
    return images.SPAN_HEADER.pack(sum(len(c) for c in chunks) if total is None else total, flags) + body


def _lz4_literals(data):
    """An LZ4 block that is one literal run: the shortest encoding that needs no matches."""
    out = bytearray()
    length = len(data)
    out.append(min(length, 15) << 4)
    if length >= 15:
        length -= 15
        while length >= 255:
            out.append(255)
            length -= 255
        out.append(length)
    return bytes(out + data)


def test_a_pak_span_is_consumed_exactly_or_refused():
    pixels = bytes(range(256)) * 4
    assert images.decompress_span(a_span([pixels[:512], pixels[512:]])) == pixels
    with pytest.raises(ValueError, match="span flags"):
        images.decompress_span(a_span([pixels], flags=0))
    with pytest.raises(ValueError, match="the span header said"):
        images.decompress_span(a_span([pixels], total=len(pixels) - 1))
    with pytest.raises(ValueError, match="ran out"):
        images.decompress_span(a_span([pixels], total=len(pixels) + 1))
    with pytest.raises(ValueError, match="went unread"):
        images.decompress_span(a_span([pixels]) + b"\0\0\0\0")


def test_the_dds_writing_is_iw6s():
    """GfxImage is byte-for-byte IW6's, so a second block table would be a second answer."""
    from scripts.cod.iw6 import images as iw6_images

    assert images.BLOCK_BYTES is iw6_images.BLOCK_BYTES
    assert images.dds is iw6_images.dds


# --- the struct layout ------------------------------------------------------


def test_the_layout_is_s1s_alone(tmp_path, monkeypatch):
    """IW6's Layout merges the Durango types in; S1's must not inherit that."""
    monkeypatch.setattr(walkers, "fallback", lambda: str(tmp_path / "nothing.json"))
    path = tmp_path / "s1.json"
    path.write_text(json.dumps(layout_rows({"cbrush_t": [("numsides", *U2)]})))
    layout = walkers.Layout(str(path))
    assert layout.size("cbrush_t") == 2
    assert "GfxWorld" not in layout.sizes
    with pytest.raises(FileNotFoundError, match="no S1 struct layout"):
        walkers.Layout(str(tmp_path / "absent.json"))


def test_a_struct_only_the_x360_layout_has_names_that_file_when_it_is_absent(tmp_path, monkeypatch):
    """A walk records the KeyError as the asset it stopped at; its message says what to supply."""
    path = tmp_path / "s1.json"
    path.write_text(json.dumps(layout_rows({"cbrush_t": [("numsides", *U2)]})))
    monkeypatch.setattr(walkers, "fallback", lambda: None)
    with pytest.raises(KeyError, match="s1_layout_x360") as caught:
        walkers.Layout(str(path)).size("SndSubmixList")
    assert str(caught.value).startswith("SndSubmixList is declared only by the X360-derived layout")
    x360 = tmp_path / "x360.json"
    x360.write_text(json.dumps(layout_rows({"SndSubmixList": [("count", *U2)]})))
    monkeypatch.setattr(walkers, "fallback", lambda: str(x360))
    assert walkers.Layout(str(path)).size("SndSubmixList") == 2


# --- the six state-bit words ------------------------------------------------


def a_state_bits_layout(tmp_path):
    """MATERIAL_TYPES plus GfxStateBits, whose loadBits is an array the helper cannot spell."""
    rows = layout_rows(MATERIAL_TYPES) + [
        ["GfxStateBits", "loadBits", 0, 24, 4, 0, KIND_UNSIGNED, 6, 0, ""],
        ["GfxStateBits", "zone", 24, 2, 2, 0, KIND_UNSIGNED, 0, 0, ""],
        ["GfxStateBits", "depthStencilState", 26, 10, 1, 0, KIND_UNSIGNED, 10, 0, ""],
        ["GfxStateBits", "blendState", 36, 1, 1, 0, KIND_UNSIGNED, 0, 0, ""],
        ["GfxStateBits", "rasterizerState", 37, 1, 1, 0, KIND_UNSIGNED, 0, 0, ""],
        ["GfxStateBits", "", 0, 40, 0, 0, 0, 0, 0, ""],
    ]
    path = tmp_path / "mat-states.json"
    path.write_text(json.dumps(rows))
    return Layout(str(path))


# Real `GfxStateBits` from mp_prison, each with the three D3D11 states the zone
# cached from the same six words: the `rasterizerState` byte in the same struct,
# the `XGfxGlobals.depthStencilStateBits` entry its `depthStencilState[9]` names,
# and the `blendStateBits` triple its `blendState` names. 160,064 entries across
# the 14 MP zones and the lobby rebuild all three; these are one of each shape.
STATE_BITS = (
    # (technique, loadBits[6], rasterizerState, depthStencilStateBits, blendStateBits)
    ("wc/asphalt_light_02 zprepass", (0x11, 0xE49E4907, 0xFFFF, 0x12012, 0, 0), 0x02, 0xFFFFE49E4907, [0x12012, 0, 0]),
    ("wc/asphalt_light_02 lit", (0x51, 0x6, 0xFFFF, 0x1F012012, 0, 0), 0x82, 0xFFFF00000006, [0xF012012, 0, 0]),
    ("wc/asphalt_light_02 shadowmap", (0x9, 0x37, 0xFFFF, 0x12012, 0, 0), 0x0D, 0xFFFF00000007, [0x12012, 0, 0]),
    (
        "mtl_prison_security_laser mrt",
        (0x11, 0xE00E1247, 0x4FFFF, 0x7012012, 0x3012012, 0),
        0x02,
        0xFFFFE00E1247,
        [0x7012012, 0x3012012, 0],
    ),
    ("mtl_prison_security_laser add", (0x51, 0x26, 0xFFFF, 0xF012122, 0, 0), 0x8A, 0xFFFF00000006, [0xF012122, 0, 0]),
    # common_mp.ff: a stencil word with masks other than 0xFF, cached as 0xFF all the same.
    ("m/mtl_gm6_lens", (0x4A, 0xE0646, 0xF0F, 0xF012165, 0, 0), 0xA1, 0xFFFF000E0646, [0xF012165, 0, 0]),
    ("mc/mtl_optics_target_enhancer_glass", (0x52, 0xC0646, 0x80109, 0xF012165, 0, 0), 0xA2, 0xFFFF000C0646, [0xF012165, 0, 0]),
    ("motiontracker3d_bg", (0x4A, 0x4004C, 0x1FF01, 0xF012165, 0, 0), 0xA1, 0xFFFF0004004C, [0xF012165, 0, 0]),
)


@pytest.mark.parametrize(("label", "load", "rasterizer", "depth_stencil", "blend"), STATE_BITS)
def test_six_load_bits_rebuild_the_states_the_zone_cached_from_them(label, load, rasterizer, depth_stencil, blend):
    """The check that makes the decode a measurement: three fields the reader does not choose."""
    assert cached_states(load) == (rasterizer, depth_stencil, blend)


def test_the_depth_test_field_is_s1s_three_bits_not_iw6s_two():
    """Reading loadBits[1] under IW6's rules swaps `less_equal` and `disabled` in silence."""
    zprepass, lit, hud = 0xE49E4907, 0x6, 0xE00E000C
    # A depth prepass writes depth and must test it; a lit pass tests without writing.
    assert state_bits((0, zprepass, 0, 0, 0, 0))["depthTest"] == "less_equal"
    assert state_bits((0, zprepass, 0, 0, 0, 0))["depthWrite"] is True
    entry = state_bits((0, lit, 0, 0, 0, 0))
    assert (entry["depthWrite"], entry["depthTest"]) == (False, "less_equal")
    # mp_prison_load's 2D HUD materials, which must not be depth tested at all.
    assert state_bits((0, hud, 0, 0, 0, 0))["depthTest"] == "disabled"
    # IW6's reader would call the same two words the other way round.
    assert iw6_state_bits((0, zprepass, 0))["depthTest"] == "disabled"
    assert iw6_state_bits((0, hud, 0))["depthTest"] == "less_equal"


def test_the_shadowmap_pass_carries_the_shadowmap_depth_bias():
    """polygonOffset lives in loadBits[1] and is a *rasterizer* state, which is why
    the rasterizerState byte above ties the two words together."""
    entry = state_bits((0x9, 0x37, 0xFFFF, 0x12012, 0, 0))
    assert entry["polygonOffset"] == "offsetShadowmap" and entry["cullFace"] == "none"
    assert entry["depthWrite"] is True and entry["colorWriteRgb"] is False


def test_the_extra_render_targets_are_written_only_when_the_zone_has_them():
    plain = state_bits((0x11, 0x6, 0xFFFF, 0x7012012, 0, 0))
    assert "blendTargets" not in plain
    mrt = state_bits((0x11, 0x6, 0xFFFF, 0x7012012, 0x3012012, 0))
    assert [t["colorWriteRgb"] for t in mrt["blendTargets"]] == [True, False]


def test_the_lit_technique_is_what_the_shell_draws_a_world_material_with():
    """TECHNIQUES_BY_GAME and the blend decode, through the reader the shell uses."""
    lit = state_bits((0x51, 0x6, 0xFFFF, 0x1F012012, 0, 0))
    decal = state_bits((0x51, 0x26, 0xFFFF, 0xF012122, 0, 0))
    entries = [-1] * 180
    entries[TECHNIQUES_BY_GAME["s1"].lit] = 0
    entries[TECHNIQUES_BY_GAME["s1"].unlit] = 1
    data = {"stateBits": [lit, decal], "stateBitsEntry": entries, "techniqueSet": "wc_l_sm_lmpb_r0c0n0sd0_nfwpf"}
    state = material_render_state(data, "s1")
    assert state["blend"] is None and state["doubleSided"] is False and state["drop"] is False
    # Drop the lit row and the unlit one is drawn instead, blended.
    entries[TECHNIQUES_BY_GAME["s1"].lit] = -1
    assert material_render_state(data, "s1")["blend"] == "add"


def test_a_wrong_decode_stops_the_dump_rather_than_being_written(tmp_path):
    """check_state_bits is the guard: the zone's own tables have to come back out."""
    layout = a_state_bits_layout(tmp_path)
    load = STATE_BITS[1][1]
    states = struct.pack("<6I", *load) + struct.pack("<H", 0) + bytes([0] * 9 + [0]) + bytes([0, 0x82])
    info = struct.pack("<Q4B4xQ", 0, 0, 0, 0, 0, 0)
    header = info + b"\xff" * 180 + struct.pack("<8B", 0, 0, 1, 0, 13, 0, 0, 0)
    zone, at = a_zone(layout, (("material", header), ("states", states)))
    zone.found["MATERIAL"] = {"wc/x": Material("wc/x", at["material"], "wc_y", [], at["states"], None)}
    zone.found["GFXSTATE"] = {"depthStencil": [STATE_BITS[1][3]], "blend": [STATE_BITS[1][4]]}
    walked = Walked("mp_test.ff", zone, None)
    material_dump.check_state_bits(walked)  # the right tables: no complaint
    zone.found["GFXSTATE"]["blend"] = [[0, 0, 0]]
    with pytest.raises(SystemExit, match="disagrees with the D3D11 states"):
        material_dump.check_state_bits(walked)


def test_s1_slot_names_are_matched_by_hash_and_by_the_characters_beside_them():
    """Each name is R_HashString'd to a hash the zones use, and its first and last
    characters are the `nameStart`/`nameEnd` bytes the zone stores."""
    observed = {
        "occlusionMap": (0x6001F931, "o", "p"),
        "occlusionMap1": (0x60411F60, "o", "1"),
        "emissiveMap": (0x34614347, "e", "p"),
        "maskMap": (0x9E7BA008, "m", "p"),
        "flowMap": (0x06592A6E, "f", "p"),
        "secondarySpecularMap": (0x6F4200C9, "s", "p"),
    }
    for name, (hashed, start, end) in observed.items():
        assert slot_hash(name) == hashed, name
        assert (name[0].lower(), name[-1].lower()) == (start, end), name
        assert material_dump.SLOTS_BY_HASH[hashed] == name


def test_s1_surface_rules():
    """What the 15 zones say: no two-pass layer blend, no `onlycast`, `distortion` and the
    gametype overlays kept out."""
    rules = SURFACES_BY_GAME["s1"]
    assert rules.colour_map == "colorMap" and rules.drop_prefixes == ()
    dropped = (
        "wc_tools_r0c0ct0",
        "wc_unlit_cso_hss_falloff_blend_lin_ndw_ua_nfwpf",
        "distortion_scale_zf",
        # The Horde dome and the Hardpoint outlines: script_brushmodels a gametype shows.
        "wc_unlit_cso_hss_add_slf_lin_nofog_ndw_flow_uvd_cltrans_hilite_z_edges",
        "wc_effect_zf_cso_hss_add_slf_ct_ndw_hilite_z_edges",
    )
    for techset in dropped:
        assert material_render_state({"techniqueSet": techset}, "s1")["drop"] is True
    # A generated material is one pass with every layer in it, and is a surface.
    assert material_render_state({"techniqueSet": "l_sm_lmpb_r0c0nl0sld0_b1c1nl1sl1_nfwpf"}, "s1")["drop"] is False
