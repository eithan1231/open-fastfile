#!/usr/bin/env python3
"""Inflate every IW4, IW5 and T5 zone the pipeline touches, and check each against its XFile header.

    inflateall.py [mw2 mw3 bo1]

The zones: each map maps.json names, the companion zones beside the maps (and the
ones a map names itself), the sound zones, and MW3's `so_survival_mp_*.ff`. One
zone is in memory at a time. `scripts/cod/fastfile.py` refuses a zone whose length
is not its header plus the `size` it states, and a signed chunk that fails its
hash, so a line saying `ok` is both.
"""

import collections
import glob
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from scripts.cod import fastfile  # noqa: E402
from scripts.cod import zones as zone_names  # noqa: E402
from scripts.cod.maps import load_maps  # noqa: E402

GAMES = ("mw2", "mw3", "bo1")


def zones(game, config, maps):
    """(role, path) of every zone of `game` the pipeline reads, each once."""
    dirs = config["zones"]
    found = {}

    def add(role, path):
        path = os.path.normpath(path)
        if os.path.exists(path):
            found.setdefault(path, role)

    for entry in maps:
        if entry["game"] != game:
            continue
        where = next((d for d in dirs if os.path.exists(os.path.join(d, entry["map"] + ".ff"))), None)
        if where is None:
            print(f"  {entry['map']}.ff: not found under {dirs}")
            continue
        add("map", os.path.join(where, entry["map"] + ".ff"))
        for name in entry.get("common", ()):
            add("companion", os.path.join(where, name))
    for path in config.get("common", ()):
        add("companion", path)
    sound = zone_names.T5_SOUND_ZONES if game == "bo1" else zone_names.SOUND_ZONES
    for d in dirs:
        for name in zone_names.COMMON_ZONES:
            add("companion", os.path.join(d, name))
        for name in (*sound, *zone_names.SOUND_PCM_ZONES):
            add("sound", os.path.join(d, name))
        if game == "mw3":
            for path in sorted(glob.glob(os.path.join(d, "so_survival_mp_*.ff"))):
                add("survival", path)
    return found


def main():
    wanted = sys.argv[1:] or GAMES
    games, maps = load_maps()
    table = collections.Counter()
    failures = []
    for game in wanted:
        for path, role in zones(game, games[game], maps).items():
            started = time.time()
            container = fastfile.claim(path)
            if container is None:
                verdict = "FAILED: not claimed"
            else:
                try:
                    zone = fastfile.inflate(path, container)
                    size = container.spec.header(zone)[0]
                    verdict = f"ok {len(zone):>11,} = {container.spec.header_size} + {size:,}"
                    del zone
                except ValueError as error:
                    verdict = f"FAILED: {error}"
            kind = f"{container.spec.game} {'signed' if container.signed else 'unsigned'}" if container else "?"
            ok = verdict.startswith("ok")
            table[(game, role, ok)] += 1
            if not ok:
                failures.append((path, verdict))
            print(f"{game} {role:9} {os.path.basename(path):34} {kind:13} {verdict}  ({time.time() - started:.1f}s)", flush=True)
    print()
    for (game, role, ok), count in sorted(table.items()):
        print(f"{game} {role:9} {'ok' if ok else 'FAILED'} {count}")
    for path, verdict in failures:
        print(f"FAILED {path}: {verdict}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
