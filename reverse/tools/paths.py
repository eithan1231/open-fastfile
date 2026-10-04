"""Where the tools here find their inputs: environment variables, never a default path.

- `COD_<GAME>_DIR` is a game's install directory, the folder holding its executable
  and its fastfiles. The game keys are the importer's: mw2, mw3, bo1, bo2, ghosts, aw
  and cw (`COD_BO2_DIR`, `COD_GHOSTS_DIR`, ...).
- Everything else has a name of its own (`OAT`, `X64ZT`, `IW5_EXE`, ...);
  each tool's docstring says which it reads.

A variable that is not set stops the tool with its name and what it should point at.
"""

import os
import sys

GAMES = {
    "mw2": "Modern Warfare 2",
    "mw3": "Modern Warfare 3",
    "bo1": "Black Ops",
    "bo2": "Black Ops II",
    "ghosts": "Ghosts",
    "aw": "Advanced Warfare",
    "cw": "Black Ops Cold War",
}


def require_env(name, what):
    """$name, user-expanded; exits naming the variable and `what` it points at when unset."""
    value = os.environ.get(name)
    if not value:
        sys.exit(f"${name} is not set: point it at {what}.")
    return os.path.expanduser(value)


def game_dir(game, *parts):
    """$COD_<GAME>_DIR joined with `parts`."""
    title = GAMES[game]
    root = require_env(f"COD_{game.upper()}_DIR", f"the Call of Duty {title} install directory")
    return os.path.join(root, *parts)


def oat():
    """$OAT: an OpenAssetTools checkout, read as a struct reference."""
    return require_env("OAT", "an OpenAssetTools checkout")
