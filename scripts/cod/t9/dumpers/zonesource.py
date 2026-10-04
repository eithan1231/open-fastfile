"""`zone_source/<zone>.zone`: the zone's listing, beside every dump; `metadata.zone_listing` reads the game from it."""

import os

from . import GAME

FOLDER = "zone_source"
HEADER = "// Call Of Duty: Black Ops Cold War"


def write_listing(walked, out):
    """The game line, and the map's world assets under the names the dumps give them."""
    lines = [HEADER, f">game,{GAME.upper()}", "", f"gfxworld,{walked.bsp}", f"clipmap,{walked.bsp}", f"mapents,{walked.bsp}"]
    path = os.path.join(out, FOLDER, f"{walked.map}.zone")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="latin-1", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    return path
