"""`loadscreen`: the picture each `loadscreen_*` material draws, as `images/<material>.dds`, at full size.

Black Ops II names a map's loading screen by code, not by a table: when a level's
zones load, `UI_SetLoadingScreenMaterial(mapName)` registers the material
`va("loadscreen_%s", mapName)` (the zone name: `loadscreen_mp_nuketown_2020`) from
whatever is loaded. Those materials are in `code_post_gfx_mp.ff`, and a DLC map's in
its pack's `<dlc>_load_mp.ff`, which `Com_LoadLevelFastFiles` loads first
(reverse/t6-loadscreen). So the file is named after the material, not its image,
and the image is the one the material names.

Every picture is a single BC1 level streamed from an `.ipak`, 1280x720 or a square
the game stretches over the screen, so the whole level is written rather than
`image`'s 512 px one: textures.export_loadscreen scales it to the screen's shape.
"""

import os
from collections import Counter

from ...iw5.dumpers import image as iw
from ...iw5.dumpers.common import plain
from ...iw6.dumpers.common import asset_path
from ...iw6.images import dds
from .. import ipak
from .image import LOADDEF, STREAMED, from_ipak, from_loaddef

PREFIX = "loadscreen_"


def pictures(walk):
    """(material name, the name of the one image it draws) for each loading-screen material, or a reason."""
    for asset in walk.by_type("material"):
        if asset.name.startswith(",") or not asset.name.startswith(PREFIX):
            continue
        record = asset.record
        images = {plain(t["image"]) for t in list(record["textureTable"] or ())[: record["textureCount"]]} - {None}
        yield asset.name, (images.pop() if len(images) == 1 else f"{len(images)} images")


def pixels(record, packs):
    """(DXGI format, width, height, faces, top level) of an image, from the zone or its `.ipak`; or a reason."""
    raw = record.captured("LoadImageData")
    found = from_loaddef(record, raw) if raw is not None and len(raw) >= LOADDEF.size else "no load definition"
    return from_ipak(record, packs, max_edge=None) if found == STREAMED else found


def write(walk, out, ctx=None):
    images = {a.name: a for a in walk.by_type("image") if not a.name.startswith(",")}
    packs = None
    written, skipped = [], Counter()
    for material, image in pictures(walk):
        if image not in images:
            skipped[image if image.endswith(" images") else "an image in another zone"] += 1
            continue
        if packs is None:
            packs = ipak.Packs(os.path.dirname(os.path.abspath(walk.path)))
        found = pixels(images[image].record, packs)
        if isinstance(found, str):
            skipped[found] += 1
            continue
        with open(asset_path(out, iw.file_name(material, ".dds")), "wb") as fh:
            fh.write(dds(*found))
        written.append(f"{material} {found[1]}x{found[2]}")
    line = f"      {len(written)} loading screen(s): {', '.join(written) or 'none'}"
    if skipped:
        line += "; not written: " + "; ".join(f"{n} {why}" for why, n in skipped.most_common())
    print(line)
