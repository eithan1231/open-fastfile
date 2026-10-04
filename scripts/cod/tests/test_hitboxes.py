"""Per-bone hitboxes derived from a body's own skin weights (scripts/cod/hitboxes.py).

The interesting assertions are the two that catch a wrong answer which *looks* right:
that the table has not drifted from the TypeScript copy the engine classifies with,
and that a vertex lands in the box of the bone that actually drives it rather than in
whichever bone happens to be nearest the root.
"""

import json
import os
import re
import struct

import pytest

from scripts.cod.hitboxes import FORMAT_VERSION, HIT_BONES, MIN_THICKNESS, derive, hit_bone_of, implausible
from scripts.cod.units import UNITS_PER_M

SHARED_TABLE = os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "shared", "src", "sim", "hitLocations.ts")


def test_the_table_matches_the_one_the_engine_classifies_with():
    """Two copies of one table, in two languages that cannot import from each other.

    The exporter writes a location per box and the engine reads it, so a row present
    in one and not the other is a hitbox in the wrong place with nothing to say so.
    """
    text = open(os.path.abspath(SHARED_TABLE), encoding="utf-8").read()
    body = text[text.index("export const HIT_BONES") : text.index("*/", text.index("export const HIT_BONES"))]
    found = dict(re.findall(r"^\s{2}([A-Za-z_][\w]*): \"(\w+)\",$", body, re.MULTILINE))
    assert found, "could not read HIT_BONES out of hitLocations.ts"
    assert found == HIT_BONES


def test_a_joint_folds_into_the_nearest_box_above_it():
    parents = {"j_lip_top_le": "j_jaw", "j_jaw": "j_head", "j_head": "j_neck"}
    assert hit_bone_of("j_lip_top_le", parents.get) == "j_head"
    # Its own box where it has one.
    assert hit_bone_of("j_head", parents.get) == "j_head"
    # And nothing, rather than the root, when there is none above it.
    assert hit_bone_of("tag_origin", {}.get) is None


def test_the_parent_walk_does_not_hang_on_a_cycle():
    assert hit_bone_of("a", {"a": "b", "b": "a"}.get) is None


def test_an_implausible_box_is_named():
    boxes = [
        {"bone": "j_head", "location": "head", "min": [0, 0, 0], "max": [40, 1, 1]},
        {"bone": "j_neck", "location": "neck", "min": [0, 0, 0], "max": [2, 2, 2]},
    ]
    named = implausible(boxes)
    assert [b for b, _, _ in named] == ["j_head"]
    assert named[0][2] == pytest.approx(40 / UNITS_PER_M, rel=1e-6)


# -- Against a GLB built here, so the maths is checkable ------------------------


def _glb(gltf, blob):
    gltf_bytes = json.dumps(gltf).encode()
    gltf_bytes += b" " * ((4 - len(gltf_bytes) % 4) % 4)
    blob += b"\0" * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(gltf_bytes) + 8 + len(blob)
    return (
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<I4s", len(gltf_bytes), b"JSON")
        + gltf_bytes
        + struct.pack("<I4s", len(blob), b"BIN\0")
        + blob
    )


def _two_bone_body(tmp_path, weights):
    """A skinned quad on `j_head` and `j_wrist_ri`, each vertex weighted as given.

    The two bones are metres apart in the skin's space and their inverse bind
    matrices say so, which is what makes "was this vertex put in the right bone's
    space" a question with a checkable answer.
    """
    positions = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (10.0, 0.0, 0.0)]
    blob = b"".join(struct.pack("<3f", *p) for p in positions)
    joints_off = len(blob)
    blob += b"".join(struct.pack("<4H", *j) for j, _ in weights)
    weights_off = len(blob)
    blob += b"".join(struct.pack("<4f", *w) for _, w in weights)
    ibm_off = len(blob)
    # Column-major: j_head at the origin, j_wrist_ri translated 10 along x, so its
    # inverse bind matrix subtracts that.
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    shifted = list(identity)
    shifted[12] = -10.0
    blob += struct.pack("<16f", *identity) + struct.pack("<16f", *shifted)

    gltf = {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [
            {"name": "j_head", "children": [1]},
            {"name": "j_wrist_ri"},
            {"name": "surf", "mesh": 0, "skin": 0},
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}}]}],
        "skins": [{"joints": [0, 1], "inverseBindMatrices": 3}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3"},
            {"bufferView": 1, "componentType": 5123, "count": 4, "type": "VEC4"},
            {"bufferView": 2, "componentType": 5126, "count": 4, "type": "VEC4"},
            {"bufferView": 3, "componentType": 5126, "count": 2, "type": "MAT4"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": joints_off},
            {"buffer": 0, "byteOffset": joints_off, "byteLength": weights_off - joints_off},
            {"buffer": 0, "byteOffset": weights_off, "byteLength": ibm_off - weights_off},
            {"buffer": 0, "byteOffset": ibm_off, "byteLength": len(blob) - ibm_off},
        ],
        "buffers": [{"byteLength": len(blob)}],
    }
    path = tmp_path / "body.glb"
    path.write_bytes(_glb(gltf, blob))
    return str(path)


def test_a_vertex_goes_in_the_box_of_the_bone_that_drives_it(tmp_path):
    # Three vertices on the head, one on the wrist.
    path = _two_bone_body(
        tmp_path,
        [
            ((0, 1, 0, 0), (1.0, 0.0, 0.0, 0.0)),
            ((0, 1, 0, 0), (1.0, 0.0, 0.0, 0.0)),
            ((0, 1, 0, 0), (1.0, 0.0, 0.0, 0.0)),
            ((1, 0, 0, 0), (1.0, 0.0, 0.0, 0.0)),
        ],
    )
    data = derive([path])
    assert data["version"] == FORMAT_VERSION
    boxes = {b["bone"]: b for b in data["bones"]}
    assert set(boxes) == {"j_head", "j_wrist_ri"}
    assert boxes["j_head"]["location"] == "head"
    assert boxes["j_wrist_ri"]["location"] == "rightHand"

    # The head's three vertices span 0..1 on x and y.
    assert boxes["j_head"]["min"][0] == pytest.approx(0.0)
    assert boxes["j_head"]["max"][0] == pytest.approx(1.0)
    # The wrist's one vertex is at x = 10 in the skin, and its bone is *at* x = 10 —
    # so in the bone's own space it sits at the origin. A box left in skin space
    # would say 10, and would travel to the wrong place the moment the arm moved.
    assert boxes["j_wrist_ri"]["min"][0] == pytest.approx(-MIN_THICKNESS / 2, abs=1e-3)
    assert boxes["j_wrist_ri"]["max"][0] == pytest.approx(MIN_THICKNESS / 2, abs=1e-3)


def test_the_dominant_influence_decides_and_a_stray_weight_does_not(tmp_path):
    # Every vertex is mostly the head's, with a sliver on the wrist. The wrist must
    # get no box at all: splitting a vertex between two boxes puts a piece of every
    # limb inside its neighbour.
    path = _two_bone_body(tmp_path, [((0, 1, 0, 0), (0.98, 0.02, 0.0, 0.0))] * 4)
    boxes = {b["bone"] for b in derive([path])["bones"]}
    assert boxes == {"j_head"}


def test_the_strongest_influence_wins_even_when_it_is_not_listed_first(tmp_path):
    """The weights are not sorted, so the answer must be a maximum and not a first.

    Reading the first nonzero weight gives the same answer as the largest on most
    real vertices, which is exactly why this needs its own fixture: here the wrist
    is listed first and the head is the one that actually drives the vertex.
    """
    path = _two_bone_body(tmp_path, [((1, 0, 0, 0), (0.2, 0.8, 0.0, 0.0))] * 4)
    boxes = {b["bone"] for b in derive([path])["bones"]}
    assert boxes == {"j_head"}


def test_a_vertex_nothing_really_drives_is_left_out(tmp_path):
    """Below MIN_WEIGHT is exporter rounding, not an influence.

    A vertex whose every weight is a rounding artefact has no owner, and inventing
    one from the largest of several slivers puts stray geometry in whichever box wins
    a coin toss.
    """
    path = _two_bone_body(tmp_path, [((0, 1, 0, 0), (0.03, 0.02, 0.0, 0.0))] * 4)
    assert derive([path]) == {"version": FORMAT_VERSION, "bones": []}


def test_a_flat_box_is_widened_rather_than_left_paper_thin(tmp_path):
    # All four vertices coincident: a zero-thickness box is a hit volume a ray can
    # pass through edge-on.
    path = _two_bone_body(tmp_path, [((0, 1, 0, 0), (1.0, 0.0, 0.0, 0.0))] * 4)
    box = derive([path])["bones"][0]
    for axis in range(3):
        assert box["max"][axis] - box["min"][axis] >= MIN_THICKNESS - 1e-6


def test_min_thickness_is_in_the_rig_s_own_units():
    """Two centimetres of world, expressed in the inches a CoD rig measures in.

    In metres it would be half a millimetre, which is no thickness at all.
    """
    assert MIN_THICKNESS == pytest.approx(0.02 * UNITS_PER_M)
    assert MIN_THICKNESS > 0.5


def test_a_body_with_no_skin_has_no_hitboxes(tmp_path):
    path = tmp_path / "empty.glb"
    path.write_bytes(_glb({"asset": {"version": "2.0"}, "nodes": [], "scenes": [{"nodes": []}]}, b""))
    assert derive([str(path)]) is None
