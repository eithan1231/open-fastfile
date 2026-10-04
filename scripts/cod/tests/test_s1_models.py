"""Advanced Warfare models: the XSurface walk and the xmodel dump, on bytes laid out for the test.

What these pin is what reverse/s1-zone/README.md#the-models established against
mp_prison: a model vertex is IW6's 32-byte GfxPackedVertex with a float position,
`unknown0` repeats that position, and LOD 0 reproduces `XModel.bounds`. A decode
that drifts from any of those must stop the dump, not write a plausible model.
"""

import json
import re
import struct

import pytest

from scripts.cod.animations import packed_file
from scripts.cod.gltf import read_glb
from scripts.cod.iw6.records import Model, ModelLod, ModelSurfs
from scripts.cod.iw6.zone import KIND_FLOAT, KIND_POINTER, KIND_UNSIGNED, POINTER_TAG, TEMP, Layout, Zone
from scripts.cod.pack import served_path
from scripts.cod.s1 import walkers
from scripts.cod.s1.dumpers import COMPLETE, Walked
from scripts.cod.s1.dumpers import xmodel as xmodel_dump
from scripts.cod.s1.walkers import S1Surface

FOLLOWS = POINTER_TAG | 0xFFFFFFFF
U1 = (1, KIND_UNSIGNED, "")
U2 = (2, KIND_UNSIGNED, "")
U4 = (4, KIND_UNSIGNED, "")
PTR = (8, KIND_POINTER, "")

# XSurface in the order xsurface reads it; every runtime handle has to exist to be touched.
SURFACE_POINTERS = (
    "triIndices",
    "triIndices2",
    "rigidVertLists",
    "unknown0",
    "blendVerts",
    "blendVertsTable",
    "lmapUnwrap",
    "subdiv",
    "tensionData",
    "tensionAccumTable",
    "blendShapes",
    *walkers.XSURFACE_RUNTIME,
)


def rows(types):
    """layout rows for {type: [(member, size, kind, base, offset?)]}; a given offset makes a union."""
    out = []
    for typename, members in types.items():
        offset, end = 0, 0
        for member in members:
            name, size, kind, base = member[:4]
            offset = member[4] if len(member) > 4 else offset
            out.append([typename, name, offset, size, size, 0, kind, 0, 0, base])
            offset += size
            end = max(end, offset)
        out.append([typename, "", 0, end, 0, 0, 0, 0, 0, ""])
    return out


def surface_layout(tmp_path):
    types = {
        # One pointer, three names: the PC layout's GfxVertexUnion0.
        "GfxVertexUnion0": [("packedVerts0", *PTR, 0), ("packedMotionVerts0", *PTR, 0), ("verts0", *PTR, 0)],
        "XSurface": [
            ("flags", *U2),
            ("vertCount", *U2),
            ("triCount", *U2),
            ("rigidVertListCount", *U1),
            ("subdivLevelCount", *U1),
            ("blendVertCounts", 16, KIND_UNSIGNED, ""),
            ("verts0", 8, 0, "GfxVertexUnion0"),
            *((name, *PTR) for name in SURFACE_POINTERS),
            ("blendShapesCount", *U4),
        ],
    }
    path = tmp_path / "surface.json"
    path.write_text(json.dumps(rows(types)))
    return Layout(str(path))


UP = 512 | 512 << 10 | 1023 << 20  # PackedUnitVec +Z


def packed_vertex(x, y, z):
    """A GfxPackedVertex: float xyz, binormalSign, colour, half-float UV, normal +Z, tangent."""
    return struct.pack("<3ff4BIII", x, y, z, 1.0, 255, 255, 255, 255, 0, UP, UP)


def test_verts0_is_one_pointer_read_through_its_union(tmp_path):
    """The three `verts0` names the zone reported unhandled are one pointer, and it is the vertices."""
    layout = surface_layout(tmp_path)
    header = bytearray(layout.size("XSurface"))
    struct.pack_into("<HHH", header, 0, 0, 3, 1)
    for path in ("verts0.verts0", "triIndices", "triIndices2", "unknown0"):
        struct.pack_into("<Q", header, layout.resolve("XSurface", path)[0], FOLLOWS)
    corners = [(0.0, 0.0, 0.0), (10.0, 0.0, 0.0), (0.0, 10.0, 0.0)]
    data = bytearray(72) + header  # alignment moves block cursors, never the file
    verts_at = len(data)
    data += b"".join(packed_vertex(*c) for c in corners)
    data += struct.pack("<3H", 0, 1, 2) * 2  # triIndices, then S1's triIndices2
    positions_at = len(data)
    data += b"".join(struct.pack("<3fI", *c, 0) for c in corners)
    zone = Zone(bytes(data), layout)
    zone.pos = 72
    zone.push(TEMP)
    surface = walkers.xsurface(zone, zone.struct("XSurface"))
    zone.check()
    assert zone.unhandled == []
    assert zone.pos == len(data)
    assert (surface.vertices, surface.positions, surface.vertex_count) == (verts_at, positions_at, 3)
    assert xmodel_dump.positions_disagree(zone.data, surface) == 0


def a_model_zone(tmp_path, positions, recorded_bounds, repeated=None):
    """A zone holding one XModel of one LOD of one surface, as the walk would have recorded it."""
    layout_rows = rows(
        {
            "Bounds": [("midPoint", 12, KIND_FLOAT, ""), ("halfSize", 12, KIND_FLOAT, "")],
            "XModelLodInfo": [("dist", 4, KIND_FLOAT, "")],
        }
    )
    layout_rows += [
        ["XModel", "numLods", 0, 1, 1, 0, KIND_UNSIGNED, 0, 0, ""],
        ["XModel", "collLod", 1, 1, 1, 0, KIND_UNSIGNED, 0, 0, ""],
        ["XModel", "flags", 2, 2, 2, 0, KIND_UNSIGNED, 0, 0, ""],
        ["XModel", "contents", 4, 4, 4, 0, KIND_UNSIGNED, 0, 0, ""],
        ["XModel", "bounds", 8, 24, 24, 0, 0, 0, 0, "Bounds"],
        ["XModel", "lodInfo", 32, 24, 4, 0, 0, 6, 0, "XModelLodInfo"],
        ["XModel", "", 0, 56, 0, 0, 0, 0, 0, ""],
    ]
    path = tmp_path / "model.json"
    path.write_text(json.dumps(layout_rows))
    mins, maxs = recorded_bounds
    mid = [(a + b) / 2 for a, b in zip(mins, maxs, strict=True)]
    half = [(b - a) / 2 for a, b in zip(mins, maxs, strict=True)]
    header = struct.pack("<BBHI6f6f", 1, 0, 0, 1, *mid, *half, *([0.0] * 6))
    data = bytearray(72) + header
    verts_at = len(data)
    data += b"".join(packed_vertex(*p) for p in positions)
    tris_at = len(data)
    data += struct.pack("<3H", 0, 1, 2)
    positions_at = len(data)
    data += b"".join(struct.pack("<3fI", *p, 0) for p in (repeated or positions))
    zone = Zone(bytes(data), Layout(str(path)))
    surface = S1Surface(verts_at, len(positions), False, tris_at, 1, positions=positions_at)
    zone.found["XMODEL_SURFS"] = {"crate_lod0": ModelSurfs("crate_lod0", [surface])}
    zone.found["XMODEL"] = {"crate": Model("crate", ["mc/crate"], [ModelLod("crate_lod0", 0, 1)], at=72)}
    return Walked("mp_x.ff", zone, None, {"materials": {}})


CORNERS = [(0.0, 0.0, 0.0), (32.0, 0.0, 0.0), (0.0, 16.0, 48.0)]


def test_a_model_is_dumped_in_iw6s_schema_as_s1s(tmp_path):
    assert "xmodel" in COMPLETE
    walked = a_model_zone(tmp_path, CORNERS, ((0, 0, 0), (32, 16, 48)))
    xmodel_dump.write(walked, str(tmp_path / "models"))
    data = json.loads((tmp_path / "models" / "xmodel" / "crate.json").read_text())
    assert data["_game"] == "s1" and data["type"] == "rigid" and data["contents"] == 1
    assert data["lods"] == [{"distance": 0.0, "file": "model_export/crate_lod0.glb"}]
    assert (tmp_path / "models" / "model_export" / "crate_lod0.glb").stat().st_size > 0


def test_a_position_unknown0_does_not_repeat_stops_the_dump(tmp_path):
    moved = [CORNERS[0], CORNERS[1], (0.0, 16.0, 47.0)]
    walked = a_model_zone(tmp_path, CORNERS, ((0, 0, 0), (32, 16, 48)), repeated=moved)
    with pytest.raises(SystemExit, match="unknown0"):
        xmodel_dump.write(walked, str(tmp_path / "models"))


def test_a_lod_that_leaves_the_recorded_bounds_stops_the_dump(tmp_path):
    """Quantised positions read as floats would still make a mesh; they would not fit these bounds."""
    walked = a_model_zone(tmp_path, CORNERS, ((0, 0, 0), (32, 16, 40)))
    with pytest.raises(SystemExit, match="leaves XModel.bounds"):
        xmodel_dump.write(walked, str(tmp_path / "models"))


def test_a_lod_short_of_the_recorded_bounds_is_a_moving_part_unless_most_are(tmp_path):
    """A fan's bounds hold its blades' sweep. Every model short of its bounds is a scaled decode."""
    walked = a_model_zone(tmp_path, CORNERS, ((0, 0, 0), (32, 16, 96)))
    with pytest.raises(SystemExit, match="falls short of XModel.bounds"):
        xmodel_dump.write(walked, str(tmp_path / "models"))


def test_a_lod_another_zone_holds_is_borrowed_from_it(tmp_path):
    """mp_prison's `_burn` and `mv/` debris name common_mp.ff's geometry under their own materials."""
    library = {"materials": {}, "wanted surfs": {"crate_lod0"}}
    (tmp_path / "companion").mkdir()
    companion = a_model_zone(tmp_path / "companion", CORNERS, ((0, 0, 0), (32, 16, 48)))._replace(library=library)
    xmodel_dump.write(companion, str(tmp_path / "models"))
    assert [len(d.vertices) for d in library["surfs"]["crate_lod0"]] == [3]

    (tmp_path / "map").mkdir()
    walked = a_model_zone(tmp_path / "map", CORNERS, ((0, 0, 0), (32, 16, 48)))._replace(library=library)
    zone = walked.zone
    zone.found["XMODEL_SURFS"] = {}
    zone.found["XMODEL"] = {"mv/crate_burn": Model("mv/crate_burn", ["mc/crate_burn"], [ModelLod(",crate_lod0", 0, 1)], at=72)}
    xmodel_dump.write(walked, str(tmp_path / "models"))
    gltf, _ = read_glb(str(tmp_path / "models" / "model_export" / "mv" / "crate_burn_lod0.glb"))
    assert gltf["accessors"][0]["count"] == 3 and gltf["materials"][0]["name"] == "mc/crate_burn"
    # Without the companion's geometry the LOD is left out, as before.
    library["surfs"].clear()
    xmodel_dump.write(walked._replace(library={"materials": {}}), str(tmp_path / "none"))
    assert not (tmp_path / "none" / "model_export" / "mv" / "crate_burn_lod0.glb").exists()


# What @3d/api serves in one path segment: packages/shared/src/protocol/routes/worlds.ts SEGMENT.
API_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]*$")


def test_a_per_map_variant_is_packed_under_a_path_the_api_serves(tmp_path):
    """AW names a map's own copy `<model>@<map>`; `pnpm check` and the browser both 404 on `@`."""
    rel = served_path("mv/ref_fluorescent_light_01@prison_lod0.glb")
    assert all(API_SEGMENT.match(segment) for segment in rel.split("/"))
    assert served_path("mv/pn_vista_building_06_lod0.glb") == "mv/pn_vista_building_06_lod0.glb"
    # The name a placement carries still finds the file it was packed as.
    (tmp_path / "ref_fluorescent_light_01_prison_lod0.glb").write_bytes(b"glb")
    assert packed_file(str(tmp_path), "ref_fluorescent_light_01@prison").endswith("_prison_lod0.glb")
