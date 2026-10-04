"""`image`: every image the zone names, once, as `images/<name>.dds`: from the zone, or from an `.ipak`.

A T6 GfxImage's `loadDef` is D3D11's: `format` is a DXGI_FORMAT and `flags` IWI's
(`NOMIPMAPS` 0x2, `CUBEMAP` 0x4, `VOLMAP` 0x8, as OAT's ImageToCommonConverter reads
them), and the pixels are every face's full mip chain, largest first. `levelCount`
is 0 on every image measured, so the chain's length comes from the flags: one level
under NOMIPMAPS, else down to 1x1. `resourceSize` must be exactly that, or the image
is skipped and counted.

**Most images have no pixels in the zone at all.** An image with `streaming` 1 or 2
(1223 of mp_la's 1289, every colour map among them) loads a `resourceSize` of 0 and
keeps its whole chain as an IWI in an `.ipak` pack beside the fastfile, named by the
image's `hash` and `streamedParts[0].hash` (t6/ipak.py). Of those, the largest level
no longer than MAX_EDGE is written: textures.py caps every texture at 512 px, and
the levels are stored smallest first, so the larger ones are never decompressed.
Where the zone has pixels (the lightmap, `$outdoor`, the reflection probes) the
finest level is written.
"""

import os
import struct
from collections import Counter

from ...iw5.dumpers import image as iw
from ...iw6.dumpers.common import asset_path
from ...iw6.images import BLOCK_BYTES, chain_size, dds, level_size
from .. import ipak

LOADDEF = struct.Struct("<Bb2xII")  # levelCount, flags, format (DXGI), resourceSize; then the data
NOMIPMAPS, CUBEMAP, VOLMAP = 0x2, 0x4, 0x8
STREAMED = "streamed"
MAX_EDGE = 512  # textures.py's cap: no texture reaches the web larger than this


def level_count(width, height, mips):
    return max(width, height).bit_length() if mips else 1


def from_loaddef(record, raw):
    """(DXGI format, width, height, faces, top level's pixels), or a reason there are none."""
    _levels, flags, fmt, size = LOADDEF.unpack_from(raw, 0)
    if size == 0:
        return STREAMED
    if fmt not in BLOCK_BYTES:
        return f"DXGI format {fmt}"
    if flags & VOLMAP:
        return "a volume"
    faces = 6 if flags & CUBEMAP else 1
    width, height = record["width"], record["height"]
    chain = chain_size(fmt, width, height, level_count(width, height, not flags & NOMIPMAPS))
    data = raw[LOADDEF.size : LOADDEF.size + size]
    if chain * faces != size or len(data) != size:
        return "a size that is not its chain's"
    top = level_size(fmt, width, height)
    return fmt, width, height, faces, b"".join(bytes(data[f * chain : f * chain + top]) for f in range(faces))


def from_ipak(record, packs, max_edge=MAX_EDGE):
    """The largest level of a streamed image no longer than `max_edge` (None: the full size), or a reason there is none."""
    if not record["streamedPartCount"]:
        return "no pixels in the zone and no streamed part"
    iwi = packs.iwi(record["hash"], record["streamedParts[0].hash"])
    if iwi is None:
        return "in no .ipak beside the fastfile"
    if (iwi.width, iwi.height) != (record["width"], record["height"]):
        return "an .ipak entry of another size"
    if iwi.flags & ipak.VOLMAP:
        return "a volume"
    index = 0
    while max_edge and max(iwi.width >> index, iwi.height >> index) > max_edge and index + 1 < ipak.levels(iwi):
        index += 1
    return ipak.level(iwi, index)


def write(walk, out, ctx=None):
    found = walk.by_type("image")
    stats, skipped = Counter(), Counter()
    packs = None
    for asset in found:
        if asset.name.startswith(","):
            stats["stubs"] += 1
            continue
        raw = asset.record.captured("LoadImageData")
        pixels = from_loaddef(asset.record, raw) if raw is not None and len(raw) >= LOADDEF.size else "no load definition"
        source = "zone"
        if pixels == STREAMED:
            if packs is None:
                packs = ipak.Packs(os.path.dirname(os.path.abspath(walk.path)))
            pixels, source = from_ipak(asset.record, packs), "ipak"
        if isinstance(pixels, str):
            skipped[pixels] += 1
            continue
        with open(asset_path(out, iw.file_name(asset.name, ".dds")), "wb") as fh:
            fh.write(dds(*pixels))
        stats[source] += 1
    written = stats["zone"] + stats["ipak"]
    line = f"      {written} of {len(found)} images written ({stats['zone']} from the zone, {stats['ipak']} from .ipak)"
    if skipped:
        line += "; not written: " + "; ".join(f"{n} {why}" for why, n in skipped.most_common())
    print(line)
