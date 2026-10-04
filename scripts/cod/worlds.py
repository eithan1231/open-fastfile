"""The worlds tree as it sits on disk: which folders are worlds, and what game each came from.

Two facts, in one place because two build steps need them and a second copy of
"what counts as a world" is how the exporter and the api would drift apart. The
rule is the api's own (`listWorldFolders`): a folder is a world when it holds a
`world.world`, which is also why `catalog/` is invisible to both.
"""

import os
import sys

from .files import read_json

ENTRY_FILE = "world.world"
# Reference data the exporter writes and **the engine may never read**
# (docs/cod/pipeline.md). A build step may: that is the whole point of the file,
# and why a migration or a harvest can run with no game files at all.
METADATA_FILE = "export_metadata.json"


def world_dirs(worlds_root):
    """Every world folder under `worlds_root`, in name order."""
    if not os.path.isdir(worlds_root):
        sys.exit(f"{worlds_root} is not a directory")
    return [
        os.path.join(worlds_root, name)
        for name in sorted(os.listdir(worlds_root))
        if os.path.isfile(os.path.join(worlds_root, name, ENTRY_FILE))
    ]


def game_of(world_dir):
    """The zone key a world was imported from, or None for a world no export wrote."""
    path = os.path.join(world_dir, METADATA_FILE)
    return read_json(path).get("game") if os.path.isfile(path) else None


def imported_worlds(worlds_root):
    """Every world that came from a game, as (dir, slug, game key). A hand-written one has no cast."""
    out = []
    for world_dir in world_dirs(worlds_root):
        game = game_of(world_dir)
        if game:
            out.append((world_dir, os.path.basename(world_dir), game))
    return out
