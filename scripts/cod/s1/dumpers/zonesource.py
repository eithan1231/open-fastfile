"""`zone_source/<zone>.zone`: the zone's asset listing, written beside every dump.

Not a kind: the backend writes it into each dump directory, and
`scripts/cod/metadata.py` reads it for the game the zone belongs to and for what
it holds. `listed` is IW6's, because a listing's spelling of an XAssetType name
is the dump tree's and not a game's.
"""

import os

from ...iw6.dumpers.zonesource import listed
from . import GAME

FOLDER = "zone_source"
HEADER = "// Call Of Duty: Advanced Warfare"


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
