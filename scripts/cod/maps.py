"""Where the game files are, and where scratch goes: the repo's maps, each game's files, and the cache dir.

Its own module because two commands need it and neither is the other's: an export
reads it to find a fastfile, and `catalog` reads it to find a companion zone.
`maps.json` is the record of the repo's own worlds; where a game is installed is
this machine's business (config.py), and what an install holds is games.json's
(installs.py).
"""

import os
import sys

from . import config, installs
from .files import read_json

REPO_ROOT = config.REPO_ROOT
# Scratch: the backends' dumps and intermediate JSON. Gitignored.
CACHE_DIR = os.path.join(REPO_ROOT, ".cache", "cod")
MAPS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "maps.json")


def load_maps(path=MAPS_FILE):
    """(games, maps): each game's files on this machine (installs.resolve), and maps.json's map list.

    A game nothing names has empty `zones` and `search`; `require_game` says what to do about it.
    """
    games = {name: installs.game_files(name)[0] for name in config.games()}
    return games, read_json(path)["maps"]


def game_names():
    """games.json's games, in file order: what `export --game` accepts."""
    return tuple(config.games())


def require_game(game):
    """Exit, saying how to fix it, unless `game`'s zone folders are found and readable by this pipeline."""
    files, install = installs.game_files(game)
    if not install.roots:
        sys.exit(installs.not_found(game, install))
    installs.require_32bit(game, install)
    if not files["zones"]:
        rels = ", ".join(config.games()[game]["zones"]) or "."
        sys.exit(
            f"{game}: none of {', '.join(install.roots)} (from {install.source}) holds its zone folder ({rels}); "
            "run `python3 -m scripts.cod doctor`"
        )
    return files
