"""`python3 -m scripts.cod doctor [--game g]`: where each game was found, and what an export still lacks.

Each problem is one line with its fix. A game nothing names is reported and not
counted against the exit status, since nobody has to own every game; with
`--game` it is, because that game was asked for. Exits 0 only when every game
found (or asked for) can be exported, and the tools every export needs are there.
"""

import importlib.util
import os
import shutil
import subprocess

from . import config, installs, zones
from .maps import REPO_ROOT
from .zonecode import program

# The shipped tables each engine's walk reads (scripts/cod/data/README.md).
X86_DATA = {
    "iw4": ("zonecode.json", "weapon_fields.json"),
    "iw5": ("zonecode.json", "weapon_fields.json", "attachment_enums.json"),
    "t5": ("zonecode.json", "weapon_fields.json", "material_names.json"),
    "t6": ("zonecode.json", "weapon_fields.json", "material_names.json"),
}
OK, NOTE, BAD = "ok", "--", "!!"


def _short(path):
    """A path as the user would type it: repo-relative inside the repo, `~` for home."""
    if path.startswith(REPO_ROOT + os.sep):
        return os.path.relpath(path, REPO_ROOT)
    home = os.path.expanduser("~")
    return "~" + path[len(home) :] if path.startswith(home + os.sep) else path


def data_files(engine):
    """[(label, path)] of the shipped tables `engine` reads."""
    if engine in X86_DATA:
        folder = os.path.dirname(program.path_for(engine))
        return [(name, os.path.join(folder, name)) for name in X86_DATA[engine]]
    if engine == "iw6":
        from .iw6 import zone

        return [("layout.json", zone.LAYOUT)]
    if engine == "s1":
        from .s1 import walkers

        return [("layout_pc.json", walkers.LAYOUT)]
    return []


def check_game(game):
    """(lines, found, ready): what is known about one game, as (status, label, text) rows."""
    desc = config.games()[game]
    files, install = installs.game_files(game)
    rows = []
    rows += [row for row in [_use_row(game, install)] if row]
    if not install.roots:
        rows.append((BAD, "install", installs.not_found(game, install)))
        return rows, False, False
    labels = {root: _label(root, origin) for root, origin, _, _ in installs.roles(desc, install, files)}
    width = max(len(label) for label in labels.values())
    for root, origin, kind, role in installs.roles(desc, install, files):
        if not os.path.isdir(root):
            rows.append((BAD, "folder", f"{_short(root)}  (missing)"))
            continue
        status = NOTE if role == "unused" else OK
        rows.append((status, "folder", f"{labels[root]:<{width}}  {origin:<11}  {role} ({kind})"))

    refused = installs.sixty_four_bit(desc, install)
    if refused:
        fix = "; ".join(installs.depot_commands(game)) or "a 32-bit copy of the game"
        rows.append(
            (BAD, "32-bit", f"only {labels[refused]} holds zones, a 64-bit build: {fix} (docs/cod/README.md#32-bit-builds)")
        )
    elif files["zones"]:
        maps = installs.map_zones(desc, files["zones"])
        rows.append((OK, "zones", f"{len(files['zones'])} folder(s), {len(maps)} map zone(s)"))
    else:
        rels = ", ".join(r or "." for r in desc["zones"])
        rows.append((BAD, "zones", f"no root holds {rels}: point games.{game} at the install folder itself"))

    if refused:
        pass
    elif "common" in desc:
        missing = [p for p in files["common"] if not os.path.isfile(p)]
        names = ", ".join(os.path.basename(p) for p in files["common"]) or "none (the zones name their own)"
        rows.append((BAD, "common", f"missing {', '.join(map(_short, missing))}") if missing else (OK, "common", names))
    elif files["zones"]:
        found = [n for n in zones.COMMON_ZONES if any(os.path.isfile(os.path.join(z, n)) for z in files["zones"])]
        rows.append((OK, "common", ", ".join(found)) if found else (BAD, "common", f"no {' or '.join(zones.COMMON_ZONES)}"))

    if desc.get("exe"):
        if files["exe"] and os.path.isfile(files["exe"]):
            rows.append((OK, "exe", _short(files["exe"])))
        else:
            rows.append((NOTE, "exe", f"no {desc['exe']} (optional: without it wavelet-compressed images are skipped)"))

    if installs.needs_32bit(desc) and files["zones"]:
        rows.append((OK, "32-bit", "zones read from folders that are not 64-bit builds"))

    data = data_files(desc["engine"])
    if data:
        missing = [label for label, path in data if not os.path.isfile(path)]
        folder = _short(os.path.dirname(data[0][1]))
        if missing:
            rows.append((BAD, "data", f"no {', '.join(missing)} in {folder} (scripts/cod/data/README.md)"))
        else:
            rows.append((OK, "data", folder))

    rows += _extras(desc["engine"])
    return rows, True, not any(status == BAD for status, _, _ in rows)


def _label(root, origin):
    """A Steam folder by its last parts (`app_42680/depot_42683`, `common/Call of Duty Black Ops`), others in full."""
    if origin in ("steam", "steam-depot"):
        return os.path.join(os.path.basename(os.path.dirname(root)), os.path.basename(root))
    return _short(root)


def _use_row(game, install):
    """Which choice is in effect, and how to switch it, as one line; None for a game with no 32-bit depots."""
    desc = config.games()[game]
    if not desc.get("depots"):
        return None
    switch = f"switch with --use {game}=auto|depots|install or games.{game}.use"
    if install.source in ("cli", "env", "config"):
        return (NOTE, "use", f"folders named in {install.source}; drop them to let Steam detection choose ({switch})")
    if desc.get("merge_depots"):
        picked = {
            "auto": "the Steam install (depots only once copied into one folder and named)",
            "depots": "nothing: copy the depots into one folder and name it",
            "install": "the Steam install only",
        }
    else:
        picked = {
            "auto": "the Steam install, else its depots",
            "depots": "the depots only (a 64-bit install still lends its exe)",
            "install": "the Steam install only",
        }
    return (NOTE, "use", f"{install.use}: {picked[install.use]}; {switch}")


def _user_file(key, label, kind, required, why):
    path, source = config.data_path(key)
    env = config.DATA_KEYS[key]
    present = path and (os.path.isdir(path) if kind == "dir" else os.path.isfile(path))
    if present:
        return (OK, label, f"{_short(path)} [{source}]")
    status = BAD if required else NOTE
    where = f"{_short(path)} does not exist" if path else "not set"
    return (status, label, f"{where}: set `{key}` in cod.config.json or ${env} ({why})")


def _extras(engine):
    if engine == "iw6":
        from .iw6 import durango

        rows = [
            _user_file("iw6_durango", "durango", "dir", True, "the Xbox One server build's folder: .exe and .map"),
            _user_file("iw6_durango_types", "types", "file", True, "durango_types.json, from that build's .pdb"),
        ]
        folder, _ = config.data_path("iw6_durango")
        if rows[0][0] == OK and not os.path.isfile(os.path.join(folder, durango.STEM + ".map")):
            rows[0] = (BAD, "durango", f"{_short(folder)} holds no {durango.STEM}.map")
        if importlib.util.find_spec("capstone") is None:
            rows.append((BAD, "capstone", "not installed: pip install -r scripts/cod/requirements.txt (Ghosts' loaders)"))
        return rows
    if engine == "s1":
        return [_user_file("s1_layout_x360", "x360", "file", False, "only maps with sound submixes, reverb or impact fx")]
    if engine == "t9":
        from .t9 import oodle

        path = oodle.library_path()
        if os.path.isfile(path):
            return [(OK, "ooz", _short(path))]
        return [(BAD, "ooz", f"no Oodle decoder at {_short(path)}: set `ooz` in cod.config.json or $OOZ_LIB")]
    return []


def check_tools():
    """Rows for what every export needs beside Python: Pillow and an ffmpeg that encodes Opus."""
    rows = []
    if importlib.util.find_spec("PIL") is None:
        rows.append((BAD, "Pillow", "not installed: pip install -r scripts/cod/requirements.txt (every texture)"))
    else:
        rows.append((OK, "Pillow", "installed"))
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        rows.append((BAD, "ffmpeg", "not on PATH: install ffmpeg (every sound is transcoded to Opus)"))
    else:
        try:
            encoders = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True).stdout
        except (OSError, subprocess.CalledProcessError):
            encoders = ""
        if "libopus" in encoders:
            rows.append((OK, "ffmpeg", f"{_short(ffmpeg)}, with libopus"))
        else:
            rows.append((BAD, "ffmpeg", f"{_short(ffmpeg)} has no libopus encoder: install an ffmpeg built with it"))
    return rows


def _print(rows, indent="  "):
    for status, label, text in rows:
        print(f"{indent}{status} {label:<8} {text}")


def main(args):
    ready = True
    path = config.config_path()
    print(f"config: {_short(path)}{'' if os.path.exists(path) else '  (none; copy cod.config.example.json)'}")
    tools = check_tools()
    _print(tools, indent="")
    ready &= not any(status == BAD for status, _, _ in tools)
    for game in [args.game] if args.game else config.games():
        desc = config.games()[game]
        rows, found, game_ready = check_game(game)
        source = installs.locate(game).source
        head = f"{'ready' if game_ready else 'NOT READY' if found else 'not found'}"
        print(f"\n{game:<7}{desc['title']}  [{source or '-'}]  {head}")
        _print(rows)
        if found or args.game:
            ready &= game_ready
    return ready
