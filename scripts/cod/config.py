"""What the user said about this machine: `cod.config.json`, the environment and the command line.

`cod.config.json` sits at the repo root (or wherever `$COD_CONFIG` points) and is
gitignored. Its `games.<game>` is one of:

- a folder, or a list of folders: used as given;
- `{"dirs": [...], "exe": "<file>", "use": "auto" | "depots" | "install"}`, every
  key optional: `dirs` as above, `exe` an executable to read for wavelet tables,
  and `use` which kind of Steam folder detection may pick (installs.py).

The other top-level keys are the files a user supplies themselves (`DATA_KEYS`).
How these combine with `--game-dir`, `--use`, `$COD_<GAME>_DIR` and Steam is
installs.py's. Every key, with an example: cod.config.example.json.
"""

import json
import os
import sys
from functools import cache

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONFIG_FILE = os.path.join(REPO_ROOT, "cod.config.json")
GAMES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "games.json")

# Files nobody can ship, and the environment variable that already named each one.
# The variable wins over the config, as a game's does.
DATA_KEYS = {
    "iw6_durango": "IW6_DURANGO",
    "iw6_durango_types": "IW6_DURANGO_TYPES",
    "s1_layout_x360": "S1_LAYOUT_X360",
    "ooz": "OOZ_LIB",
}
# Which Steam folders detection may pick: installs.py.
USES = ("auto", "depots", "install")
# Replaced by per-game folders; kept only to say so.
LEGACY_ENV = ("STEAM_CONTENT", "STEAM_COMMON")

_cli_dirs = {}
_cli_use = {}


@cache
def games():
    """games.json, without its comments: {game: description}, in file order."""
    with open(GAMES_FILE, encoding="utf-8") as fh:
        return {k: v for k, v in json.load(fh).items() if not k.startswith("_")}


def config_path(environ=None):
    environ = os.environ if environ is None else environ
    return os.path.expanduser(environ.get("COD_CONFIG") or CONFIG_FILE)


def read_config(path=None):
    """The user config as a dict; {} when there is none. Exits on a file that is not JSON."""
    path = path or config_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except ValueError as error:
        sys.exit(f"{path} is not valid JSON: {error}")
    if not isinstance(data, dict):
        sys.exit(f"{path} must hold a JSON object (see cod.config.example.json)")
    return data


def _pairs(flag, pairs, check):
    out = {}
    for pair in pairs or ():
        game, sep, value = pair.partition("=")
        if not sep or not value:
            sys.exit(f"{flag} takes <game>=<value>, not {pair!r}")
        if game not in games():
            sys.exit(f"{flag} {pair}: no game {game!r} (one of: {', '.join(games())})")
        check(value)
        out.setdefault(game, []).append(value)
    return out


def set_cli(dirs=None, use=None):
    """Record `--game-dir game=dir` and `--use game=depots|install|auto`; they win over every other source."""

    def check_use(value):
        if value not in USES:
            sys.exit(f"--use takes one of {', '.join(USES)}, not {value!r}")

    _cli_dirs.clear()
    _cli_dirs.update(_pairs("--game-dir", dirs, lambda v: None))
    _cli_use.clear()
    _cli_use.update({g: v[-1] for g, v in _pairs("--use", use, check_use).items()})
    from . import installs  # late: installs imports this module

    installs.locate.cache_clear()


def cli_dirs():
    return _cli_dirs


def cli_use():
    return _cli_use


def game_entry(game, config, environ=None):
    """(dirs or None, exe or None, use or None) from the config's `games.<game>`; exits on a malformed one."""
    entry = (config.get("games") or {}).get(game)
    if entry is None:
        return None, None, None
    if isinstance(entry, str):
        return [entry], None, None
    if isinstance(entry, list) and all(isinstance(v, str) for v in entry):
        return entry, None, None
    if isinstance(entry, dict):
        dirs = entry.get("dirs")
        dirs = [dirs] if isinstance(dirs, str) else dirs
        use = entry.get("use")
        if (dirs is None or (isinstance(dirs, list) and all(isinstance(v, str) for v in dirs))) and use in (None, *USES):
            return dirs or None, entry.get("exe"), use
    sys.exit(
        f"{config_path(environ)}: games.{game} must be a folder, a list of folders, "
        f'or {{"dirs": [...], "exe": "...", "use": "auto|depots|install"}}'
    )


def data_path(key, environ=None, config=None):
    """(path, source) of a user-supplied file (`DATA_KEYS`), or (None, None) when nothing names it."""
    environ = os.environ if environ is None else environ
    value = environ.get(DATA_KEYS[key])
    if value:
        return os.path.expanduser(value), "env"
    config = read_config() if config is None else config
    value = config.get(key)
    if value:
        return os.path.expanduser(value), "config"
    return None, None


_warned = []


def warn_legacy():
    """Say once that the old Steam variables are no longer read, if either is set."""
    if _warned:
        return
    _warned.append(True)
    for var in LEGACY_ENV:
        if os.environ.get(var):
            print(
                f"note: ${var} is no longer read; name each game's folders in cod.config.json, "
                "$COD_<GAME>_DIR or --game-dir (docs/cod/README.md)",
                file=sys.stderr,
            )
            return
