"""`zone_source/<zone>.zone`: the zone's asset listing, written beside every dump.

Not a kind: the backend writes it into each dump directory, and
`scripts/cod/metadata.py` reads it for the game the zone belongs to and for what
it holds (`metadata.zone_listing` fixes the shape). An asset named with a leading
comma is another zone's, and is listed as it is found.
"""

import os

from . import GAME

FOLDER = "zone_source"
HEADER = "// Call Of Duty: Ghosts"


def listed(kind):
    """An XAssetType name as a listing spells it: lower case, no separators (`MAP_ENTS` -> `mapents`)."""
    return kind.replace("_", "").lower()


def write_listing(walked, out):
    """Write what `walked` holds as a `.zone` listing."""
    zone = os.path.splitext(os.path.basename(walked.path))[0]
    lines = [HEADER, f">game,{GAME.upper()}", ""]
    lines += [f"{listed(kind)},{name}" for kind, name, _at in walked.assets or () if name]
    path = os.path.join(out, FOLDER, f"{zone}.zone")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="latin-1", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    return path
