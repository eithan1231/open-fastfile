"""A game's files on this machine: which folders, what each one is, and what is read from them.

Where a game's folders come from is the first of these that names any; each is
the whole answer rather than merged with the next:

1. `--game-dir <game>=<dir>` (repeatable);
2. `$COD_<GAME>_DIR`, an `os.pathsep`-separated list;
3. `games.<game>` in cod.config.json (config.py), as a folder, a list, or `dirs`;
4. Steam (`detect`): the game's install under `steamapps/common`, and the depots
   `download_depot` wrote under `steamapps/content` (games.json's `depots`).

What detection picks is `use` (`--use <game>=...`, else the config's, else
`auto`): `install` the Steam install alone, `depots` the downloaded depots alone,
`auto` the install unless it is a 64-bit build of a game walked with 32-bit
layouts, then the depots. A 64-bit install is kept beside depots, for its exe only.

Every folder is then classified (`classify`). For a game walked with 32-bit layouts
(`needs_32bit`), zones, `.iwd` archives and companions come only from folders that
are not 64-bit builds, while a 64-bit folder may still supply the exe, which is read
for its wavelet tables alone. Each path games.json gives is looked up in every
such folder, in order, because the 32-bit MW2 and MW3 arrive as several depots and
`zone/dlc` is in two of them.
"""

import os
import re
from dataclasses import dataclass, field
from functools import cache

from . import config, steam
from .pe import is_pe32_plus
from .zone.spec import SPECS

BIT64, BIT32, UNKNOWN = "64-bit", "32-bit", "unknown"


@dataclass
class Install:
    """Where one game's folders are: in order, with where each came from, and the `use` in effect."""

    game: str
    roots: list = field(default_factory=list)
    source: str | None = None  # "cli", "env", "config", "steam", or None when nothing names it
    exe: str | None = None  # an explicit exe (the config's), which beats every folder's
    use: str = "auto"
    origins: dict = field(default_factory=dict)  # folder -> "cli", "env", "config", "steam" or "steam-depot"


def needs_32bit(desc):
    """Whether this game's zones are walked with 32-bit struct layouts, which a 64-bit build's zones defeat."""
    spec = SPECS.get(desc["engine"])
    return spec is not None and spec.pointer_size == 4


def classify(desc, folder):
    """BIT64, BIT32 or UNKNOWN: `steam_api64.dll`, else the game's exe (or `probe`) by its PE header,
    else `steam_api.dll`. A depot holding only zones says nothing about itself, and is UNKNOWN."""
    if os.path.exists(os.path.join(folder, "steam_api64.dll")):
        return BIT64
    for name in (desc.get("exe"), desc.get("probe")):
        path = _join(folder, name) if name else None
        if path and os.path.isfile(path):
            return BIT64 if is_pe32_plus(path) else BIT32
    if os.path.exists(os.path.join(folder, "steam_api.dll")):
        return BIT32
    return UNKNOWN


def _join(root, rel):
    return os.path.join(root, *rel.split("/")) if rel else root


def _clean(path):
    return os.path.normpath(os.path.expanduser(path))


def detect(game, use, find_install=None, find_depot=None):
    """[(folder, origin)] Steam has for `game` under `use` (module docstring); [] for none."""
    find_install = find_install or steam.find_install
    find_depot = find_depot or steam.find_depot
    desc = config.games()[game]
    retail = find_install(desc["steam"]["folder"])
    # A game whose depots must be merged into one folder is never read from them as found.
    depots = (
        [] if desc.get("merge_depots") else [p for d in desc.get("depots", []) for p in [find_depot(d["app"], d["depot"])] if p]
    )
    retail64 = bool(retail) and needs_32bit(desc) and classify(desc, retail) == BIT64
    if use == "install":
        picked = [(retail, "steam")] if retail else []
    elif use == "depots":
        picked = [(p, "steam-depot") for p in depots] + ([(retail, "steam")] if depots and retail64 else [])
    elif retail and not retail64:
        picked = [(retail, "steam")]
    elif depots:
        picked = [(p, "steam-depot") for p in depots] + ([(retail, "steam")] if retail else [])
    else:
        picked = [(retail, "steam")] if retail else []
    return [(os.path.normpath(p), origin) for p, origin in picked]


def resolve_install(game, cli_dirs=None, cli_use=None, environ=None, config_data=None, detect_fn=None):
    """The `Install` for `game`, from the first source that names it (module docstring). Every argument
    defaults to the real one; tests pass their own."""
    environ = os.environ if environ is None else environ
    config_data = config.read_config() if config_data is None else config_data
    cli_dirs = config.cli_dirs() if cli_dirs is None else cli_dirs
    cli_use = config.cli_use() if cli_use is None else cli_use
    detect_fn = detect_fn or detect

    dirs, exe, use = config.game_entry(game, config_data, environ)
    use = cli_use.get(game) or use or "auto"
    exe = _clean(exe) if exe else None

    def explicit(paths, source):
        roots = [_clean(p) for p in paths if p]
        return Install(game, roots, source, exe, use, {r: source for r in roots})

    if cli_dirs.get(game):
        return explicit(cli_dirs[game], "cli")
    env = environ.get(f"COD_{game.upper()}_DIR")
    if env:
        return explicit(env.split(os.pathsep), "env")
    if dirs:
        return explicit(dirs, "config")
    picked = detect_fn(game, use)
    if picked:
        return Install(game, [p for p, _ in picked], "steam", exe, use, dict(picked))
    return Install(game, [], None, exe, use, {})


@cache
def locate(game):
    """The `Install` for `game` on this machine, resolved once per process."""
    config.warn_legacy()
    return resolve_install(game)


def data_roots(desc, install):
    """The folders zones, archives and companions may come from: all but 64-bit builds, for a 32-bit game."""
    if not needs_32bit(desc):
        return list(install.roots)
    return [r for r in install.roots if classify(desc, r) != BIT64]


def resolve(desc, install):
    """{zones, search, common, exe} for one game: absolute paths, as the export and catalogue read them.

    `zones` and `search` hold every folder that exists, path by path and then root
    by root, over `data_roots`. A `common` file is taken from the first of those
    holding it; one that none holds is still named (under the first), so that a dump
    fails on it rather than a map losing the props it borrows. `exe` is the explicit
    one, else the first copy in those roots and then in any 64-bit one, else None.
    """
    roots = data_roots(desc, install)
    zones = [p for rel in desc["zones"] for p in (_join(r, rel) for r in roots) if os.path.isdir(p)]
    search = [p for rel in desc.get("search", []) for p in (_join(r, rel) for r in roots) if os.path.isdir(p)]
    exe = install.exe
    if exe is None and desc.get("exe"):
        others = [r for r in install.roots if r not in roots]
        exe = next((p for p in (_join(r, desc["exe"]) for r in roots + others) if os.path.isfile(p)), None)
    files = {"zones": zones, "search": search, "exe": exe}
    if "common" in desc:
        fallback = roots[0] if roots else (install.roots[0] if install.roots else "")
        files["common"] = [
            next((p for p in (_join(r, rel) for r in roots) if os.path.isfile(p)), _join(fallback, rel) if fallback else rel)
            for rel in desc["common"]
        ]
    return files


def game_files(game):
    """`resolve` for `game` on this machine, with where its folders came from: (files, Install)."""
    install = locate(game)
    return resolve(config.games()[game], install), install


def roles(desc, install, files):
    """[(folder, origin, kind, role)]: what each folder is and what is read from it, for `doctor`."""
    data = set(data_roots(desc, install))
    out = []
    for root in install.roots:
        kind = classify(desc, root)
        parts = []
        if root in data:
            if any(os.path.isdir(_join(root, rel)) for rel in desc["zones"]):
                parts.append("zones")
            elif any(os.path.isdir(_join(root, rel)) for rel in desc.get("search", [])):
                parts.append("archives")
        if files["exe"] and os.path.dirname(files["exe"]) == root:
            parts.append("exe")
        role = "+".join(parts) or "unused"
        if parts == ["exe"] and root not in data:
            role = "exe only"
        out.append((root, install.origins.get(root, install.source), kind, role))
    return out


def not_found(game, install=None):
    """What to do when nothing names `game`'s folders: one line."""
    desc = config.games()[game]
    use = install.use if install else "auto"
    where = {
        "install": f"its Steam install (steamapps/common/{desc['steam']['folder']})",
        "depots": "its downloaded Steam depots"
        + (" (which this game cannot read apart: copy them into one folder)" if desc.get("merge_depots") else ""),
        "auto": f"its Steam install (steamapps/common/{desc['steam']['folder']}) or depots",
    }[use]
    return (
        f"{desc['title']} ({game}) was not found: looked for {where}. Name its folder with --game-dir {game}=<dir>, "
        f"${'COD_' + game.upper() + '_DIR'} or games.{game} in cod.config.json; run `python3 -m scripts.cod doctor`"
    )


def sixty_four_bit(desc, install):
    """The 64-bit folder holding this game's zones when no other folder does, else None.

    The 32-bit struct layouts cannot walk a 64-bit build's zones (their pointers are
    8 bytes), and the walk fails deep inside a zone rather than at the start. So a
    32-bit game whose only zones are a 64-bit build's is refused before anything runs.
    """
    if not needs_32bit(desc):
        return None
    if any(os.path.isdir(_join(r, rel)) for r in data_roots(desc, install) for rel in desc["zones"]):
        return None
    for root in install.roots:
        if any(os.path.isdir(_join(root, rel)) for rel in desc["zones"]):
            return root
    return None


def depot_commands(game):
    """The Steam console `download_depot` lines for a game's 32-bit build, one per depot."""
    return [f"download_depot {d['app']} {d['depot']} {d['manifest']}" for d in config.games()[game].get("depots", [])]


def depot_instructions(game):
    """How to get a game's 32-bit build: a full 32-bit install, or the Steam console commands."""
    desc = config.games()[game]
    lines = [
        f"{desc['title']} ({game}) must be read from a 32-bit build, and this one is 64-bit.",
        f"Either name a full 32-bit install (any folder) with games.{game} in cod.config.json or --game-dir {game}=<dir>,",
        "or download the 32-bit depots.",
        "For the depots, open the Steam console (steam://open/console) and run:",
    ]
    lines += [f"    {cmd}    # {d['holds']}" for cmd, d in zip(depot_commands(game), desc.get("depots", []), strict=True)]
    if desc.get("merge_depots"):
        lines.append(f'then copy the depot folders into one folder and name it: "games": {{"{game}": "<folder>"}}.')
    else:
        lines.append("Steam writes them under steamapps/content/app_<app>/depot_<depot>, where detection finds them.")
    lines.append("docs/cod/README.md#32-bit-builds has the details.")
    return "\n".join(lines)


def require_32bit(game, install=None):
    """Exit with `depot_instructions` if `game`'s only zones are a 64-bit build's."""
    install = install or locate(game)
    root = sixty_four_bit(config.games()[game], install)
    if root:
        raise SystemExit(f"{root} is a 64-bit build.\n{depot_instructions(game)}")


def map_zones(desc, zone_dirs):
    """{map name: zone folder} for every multiplayer or zombies map zone in `zone_dirs`, by games.json's `maps` rule.

    A rule's `match` and `exclude` are regexes over the file's stem; `beside` names a
    file a map zone always has next to it (`{map}_load.ff`), which tells a map from
    the hundreds of other zones some games keep in the same folder.
    """
    rule = desc.get("maps") or {}
    match = re.compile(rule.get("match", "^mp_"))
    exclude = re.compile(rule["exclude"]) if rule.get("exclude") else None
    found = {}
    for zone_dir in zone_dirs:
        try:
            names = sorted(os.listdir(zone_dir))
        except OSError:
            continue
        present = set(names)
        for name in names:
            if not name.endswith(".ff"):
                continue
            stem = name[:-3]
            if not match.search(stem) or (exclude and exclude.search(stem)) or stem.endswith(("_load", "_path")):
                continue
            if rule.get("beside") and rule["beside"].format(map=stem) not in present:
                continue
            found.setdefault(stem, zone_dir)
    return found


_MODE_PREFIX = re.compile(r"^(mp|zm|zombie|so)_")


def default_world(map_name, game):
    """The world folder a map is exported to unless one is named: `mp_rust` in mw2 is `rust-mw2`."""
    return _MODE_PREFIX.sub("", map_name).replace("_", "-").lower() + "-" + game
