"""The props stage is skippable, and `world.world` names only what was written.

A backend with no `xmodel` dump used to end the export after the shell, which put
collision, the world file and every stage after it out of reach of a single
`export` run. Now stages 5 and 7 skip like stages 8-13 do. What these pin is that
nothing else moved: the backends that dump models take exactly the path they
took before, down to the `include "props.world"` line.
"""

import os

import pytest

from scripts.cod.export import PROPS_CLIPMAP_FIELDS, PROPS_DUMPS, _drop_props, _has_prop_dumps, _skipped
from scripts.cod.gltf import write_glb
from scripts.cod.iw5.backend import Backend as Iw5Backend
from scripts.cod.iw6.backend import Backend as Iw6Backend
from scripts.cod.s1.backend import Backend as S1Backend
from scripts.cod.worldfile import COLLISION_LINE, GAMES, ensure_include, write_world_file


class NoModels(S1Backend):
    """A backend that dumps the clipmap whole and no models, as S1 did before phase 6."""

    kinds = S1Backend.kinds - {"xmodel"}


def test_only_a_backend_with_no_model_dump_takes_the_new_path():
    """The gate itself: every game's backend runs stages 5 and 7; a model-less backend does not."""
    assert _has_prop_dumps(Iw5Backend()) is True
    assert _has_prop_dumps(Iw6Backend()) is True
    assert _has_prop_dumps(S1Backend()) is True
    assert _has_prop_dumps(NoModels()) is False
    # The two halves of the gate, so a backend gaining one of them is not mistaken
    # for gaining both.
    assert NoModels().writes("clipmap", *PROPS_CLIPMAP_FIELDS) is True
    assert NoModels().provides(*PROPS_DUMPS) is False


def test_the_skip_names_the_dump_that_is_missing():
    assert _skipped(NoModels(), PROPS_DUMPS) == "skipped: the s1 backend does not dump xmodel yet"


def a_world(tmp_path):
    """The three files `write_world_file` reads: a glb shell, an entity lump, no overrides."""
    assets = tmp_path / "assets"
    assets.mkdir()
    write_glb(
        assets / "world.glb",
        {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 2, "type": "VEC3", "min": [0, 0, 0], "max": [1, 2, 3]}
            ],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 24}],
            "buffers": [{"byteLength": 24}],
        },
        bytearray(24),
    )
    ents = tmp_path / "map.ents"
    ents.write_text('{\n171 "worldspawn"\n}\n')
    return str(ents), str(assets)


def world_file(tmp_path, **kw):
    ents, assets = a_world(tmp_path)
    path, _, _, _ = write_world_file(str(tmp_path), "mp_test", ents, assets, None, GAMES["s1"], "s1", **kw)
    return open(path).read()


def test_props_are_included_by_default(tmp_path):
    """Every currently-supported backend runs stage 7, so the default must not change."""
    assert 'include "props.world"' in world_file(tmp_path)


def test_a_skipped_props_stage_includes_no_props_world(tmp_path):
    body = world_file(tmp_path, props=False)
    assert 'include "props.world"' not in body
    # Collision is still there: it is the one file world.world cannot do without.
    assert COLLISION_LINE in body
    assert "game: s1" in body


def test_ensure_include_puts_the_first_include_where_a_full_export_would(tmp_path):
    """Against the real thing: a props-less export, then the include a later stage adds."""
    ents, assets = a_world(tmp_path)
    args = (str(tmp_path), "mp_test", ents, assets, None, GAMES["s1"], "s1")
    write_world_file(*args, props=False)
    ensure_include(str(tmp_path), "gameplay.world")
    added = (tmp_path / "world.world").read_text()
    write_world_file(*args, props=False, gameplay=True)
    assert added == (tmp_path / "world.world").read_text()


def test_ensure_include_still_anchors_on_props_world_where_there_is_one(tmp_path):
    (tmp_path / "world.world").write_text(f'{COLLISION_LINE}\n\ninclude "props.world"\ninclude "minimap.world"\n')
    assert ensure_include(str(tmp_path), "gameplay.world")
    assert (tmp_path / "world.world").read_text().splitlines()[2:] == [
        'include "props.world"',
        'include "gameplay.world"',
        'include "minimap.world"',
    ]


def test_a_world_file_with_no_collision_node_is_refused(tmp_path):
    (tmp_path / "world.world").write_text('world { name: "W" }\n')
    with pytest.raises(SystemExit):
        ensure_include(str(tmp_path), "gameplay.world")


def test_skipping_props_clears_what_an_earlier_export_left(tmp_path):
    (tmp_path / "props.world").write_text("// from an export that had models\n")
    props_dir = tmp_path / "assets" / "props"
    props_dir.mkdir(parents=True)
    (props_dir / "crate.glb").write_bytes(b"glb")

    _drop_props(str(tmp_path), str(props_dir))

    assert not os.path.exists(tmp_path / "props.world")
    assert not os.path.exists(props_dir)
