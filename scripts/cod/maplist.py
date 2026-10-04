"""`python3 -m scripts.cod maps [--game g]`: every map zone each install holds, and which have a world.

What counts as a map zone is games.json's `maps` rule (installs.map_zones), plus
any zone maps.json names for that game. The world each would be exported to is
maps.json's, else installs.default_world's.
"""

import os

from . import config
from .installs import default_world, map_zones
from .maps import REPO_ROOT, load_maps


def main(args):
    """Print each game's maps; `*` marks one whose world folder exists. False when no game was found."""
    games, maps = load_maps()
    worlds_root = args.worlds or os.path.join(REPO_ROOT, "worlds")
    any_found = False
    for game in [args.game] if args.game else games:
        desc = config.games()[game]
        zone_dirs = games[game]["zones"]
        if not zone_dirs:
            print(f"{game}: not found ({desc['title']}; `python3 -m scripts.cod doctor --game {game}` says where to look)")
            continue
        any_found = True
        found = map_zones(desc, zone_dirs)
        for entry in maps:
            if entry["game"] == game and entry["map"] not in found:
                if any(os.path.exists(os.path.join(z, entry["map"] + ".ff")) for z in zone_dirs):
                    found[entry["map"]] = True
        named = {m["map"]: m["world"] for m in maps if m["game"] == game}
        rows = [(name, named.get(name) or default_world(name, game)) for name in sorted(found)]
        exported = [os.path.isdir(os.path.join(worlds_root, world)) for _, world in rows]
        print(f"{game}: {len(rows)} map(s), {sum(exported)} with a world  ({desc['title']})")
        width = max((len(name) for name, _ in rows), default=0)
        for (name, world), done in zip(rows, exported, strict=True):
            print(f"  {'*' if done else ' '} {name:<{width}}  -> {world}")
    return any_found
