"""`image`: `images/<name>.dds` for every colour map a used material names: the largest level on this machine."""

from ...iw6.dumpers.common import asset_path
from .. import images
from . import dumper


@dumper("image")
def write(walked, out):
    wanted = walked.colour_images
    written, why = 0, {}
    for name, (zone, h) in sorted(wanted.items()):
        level, reason = images.largest_level(zone.data, h, walked.packages)
        if level is None:
            why[name] = reason
            continue
        images.write_dds(asset_path(out, f"images/{name}.dds"), level)
        written += 1
    print(
        f"      image: {written} of {len(wanted)} colour maps written"
        + (f"; {len(why)} not: {next(iter(why.values()))} ..." if why else "")
    )
