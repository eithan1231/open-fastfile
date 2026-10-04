"""`material`: `materials/<name>.json` for every material the world or a placed model draws with."""

from ...iw6.dumpers.common import asset_path, write_json
from ..materials import COLOUR_SLOT
from . import GAME, dumper


@dumper("material")
def write(walked, out):
    used = walked.used_materials
    shared = 0
    for name, material in sorted(used.items()):
        write_json(asset_path(out, f"materials/{name}.json"), material.json(GAME))
        shared += material.shared_table
    coloured = sum(1 for m in used.values() if m.image_name(COLOUR_SLOT))
    print(
        f"      material: {len(used)} written, {coloured} with a colour map; "
        f"{shared} share another's texture table (not followed yet)"
    )
