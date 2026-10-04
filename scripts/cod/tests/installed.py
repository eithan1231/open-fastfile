"""Where an installed game's files are, for the tests that read them when they are there.

Through the importer's own configuration (scripts/cod/installs.py: --game-dir is not
available here, so $COD_<GAME>_DIR, cod.config.json, then Steam), so that a test
reads the same files an export would. A game nothing names gives a path that does
not exist, so every `os.path.exists` guard skips rather than errors.
"""

import os

from scripts.cod import installs
from scripts.cod.maps import CACHE_DIR


def game_path(game, *rel):
    """`rel` under the first of `game`'s install roots that holds it; else a path that does not exist."""
    roots = installs.locate(game).roots
    for root in roots:
        path = os.path.join(root, *rel)
        if os.path.exists(path):
            return path
    return os.path.join(roots[0] if roots else os.path.join(CACHE_DIR, "not-installed", game), *rel)
