#!/usr/bin/env python3
"""Walk every IW4, IW5 or T5 zone the pipeline touches with the zonecode interpreter.

    walkall.py [mw3 ...] [--golden DIR] [--only NAME ...]

The zones are inflateall.py's: every map in maps.json, the companion and sound zones,
and MW3's `so_survival_mp_*.ff`. Each is walked in a subprocess of its own
(`python3 -m scripts.cod.zonecode --json`), so one zone is in memory at a time and each
line carries that zone's own peak RSS. A zone passes when the walk reaches the end of
the zone and every block's high-water mark is the size its XFile header gives it.

With `--golden` (a `.cache/cod/golden` from A0), each zone that has an OpenAssetTools
listing there (`work/*-<game>/*/zone_source/`, `catalog-<game>/work/**/zone_source/`) is
also compared with it, as a multiset of (type, name).
"""

import argparse
import collections
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
from inflateall import GAMES, zones  # noqa: E402

from scripts.cod.maps import load_maps  # noqa: E402


def golden_listings(golden, game):
    """zone name -> one golden `.zone` listing of it for `game` (they are identical wherever repeated)."""
    found = {}
    if not golden:
        return found
    patterns = (f"work/*-{game}/*/zone_source/*.zone", f"catalog-{game}/work/**/zone_source/*.zone")
    for pattern in patterns:
        for path in sorted(glob.glob(os.path.join(golden, pattern), recursive=True)):
            found.setdefault(os.path.splitext(os.path.basename(path))[0], path)
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("games", nargs="*", default=list(GAMES))
    ap.add_argument("--golden", help="an A0 golden tree (.cache/cod/golden) to compare listings with")
    ap.add_argument("--only", nargs="*", help="walk only zones with these names")
    ap.add_argument("--python", default=sys.executable)
    args = ap.parse_args()
    games, maps = load_maps()
    table = collections.Counter()
    failures = []
    for game in args.games:
        listings = golden_listings(args.golden, game)
        for path, role in zones(game, games[game], maps).items():
            name = os.path.splitext(os.path.basename(path))[0]
            if args.only and name not in args.only:
                continue
            cmd = [args.python, "-m", "scripts.cod.zonecode", path, "--json"]
            if name in listings:
                cmd += ["--compare", listings[name]]
            run = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
            try:
                s = json.loads(run.stdout.strip().splitlines()[-1])
            except (IndexError, json.JSONDecodeError):
                s = {"problems": [f"crashed: {run.stderr.strip().splitlines()[-1] if run.stderr.strip() else run.returncode}"]}
            ok = not s["problems"]
            table[(game, role, ok)] += 1
            if not ok:
                failures.append((path, s["problems"]))
            listing = ""
            for entry in s.get("listings", ()):
                same = "=" if not entry["missing"] and not entry["extra"] else "!="
                listing = f" listing {same} golden ({entry['missing']} missing, {entry['extra']} extra)"
            detail = (
                f"{s['bytes']:>12,} B {s['entries']:>5} XAssets {s['assets']:>6} assets {s['aliased']:>4} aliased "
                f"{s['seconds']:>6.1f} s {s['rss_mb']:>5} MB{listing}"
                if "bytes" in s
                else ""
            )
            print(f"{game} {role:9} {name:34} {'ok' if ok else 'FAILED'} {detail}", flush=True)
            for problem in s["problems"]:
                print(f"    {problem}", flush=True)
    print()
    for (game, role, ok), count in sorted(table.items()):
        print(f"{game} {role:9} {'ok' if ok else 'FAILED'} {count}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
