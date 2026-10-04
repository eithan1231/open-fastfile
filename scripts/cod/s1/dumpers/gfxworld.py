"""`gfxworld`: the world's surfaces, static models and brush models, plus its vertex and index arrays.

The manifest is built by IW6's writer rather than spelled again. Every field it
reads has the same name and meaning in S1 -- `GfxWorldVertex` is byte-for-byte
IW6's 44 bytes, `GfxSurface` and `GfxBrushModel` are unchanged, and the index is
still `r_index_t` -- and scripts/cod/shell.py, props.py and brushmodels.py read
one schema, so the two dumps agreeing is not something to leave to a diff.
Only `_game` differs.
"""

from ...iw6.dumpers.common import asset_path, write_json
from ...iw6.dumpers.gfxworld import INDEX_STRIDE, manifest
from ...iw6.vertices import WORLD_VERTEX
from . import GAME, dumper


@dumper("gfxworld")
def write(walked, out):
    zone, world = walked.zone, walked.world
    if world is None:
        raise SystemExit(f"{walked.path} holds no GfxWorld")
    data = {**manifest(zone, world), "_game": GAME}
    write_json(asset_path(out, f"{world.name}.gfxworld.json"), data)
    blobs = (
        (data["vertexFile"], world.vertices, data["vertexCount"] * WORLD_VERTEX.size),
        (data["indexFile"], world.indices, data["indexCount"] * INDEX_STRIDE),
    )
    for filename, at, size in blobs:
        with open(asset_path(out, filename), "wb") as fh:
            fh.write(zone.data[at : at + size])
