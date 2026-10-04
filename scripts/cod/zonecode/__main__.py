"""Walk one IW4, IW5 or T5 fastfile and report it, or write its asset listing.

    python3 -m scripts.cod.zonecode <file.ff> [--listing OUT.zone | -] [--compare GOLDEN.zone] [--json]

Prints the walk's summary: assets, time, where it stopped if it did, and each block's
high-water mark against the XFile header. `--listing` writes the asset listing in OAT's
`.zone` format; `--compare` checks the walk's assets against such a listing as sets.
Exits non-zero when the walk is not exact or the listing differs.
"""

import argparse
import collections
import json
import os
import sys

try:
    import resource  # POSIX only: Windows reports no peak RSS
except ImportError:
    resource = None

from .listing import compare, lines, read_listing, rows, write_listing
from .walker import walk_fastfile


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="python3 -m scripts.cod.zonecode", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("fastfile")
    ap.add_argument("--listing", help="write the asset listing here (a file or a directory), or print it: -")
    ap.add_argument("--compare", action="append", default=[], help="a golden .zone listing to compare with (repeatable)")
    ap.add_argument("--json", action="store_true", help="print the summary as one JSON line")
    args = ap.parse_args(argv)

    walk = walk_fastfile(args.fastfile)
    problems = walk.check()
    summary = {
        "zone": os.path.basename(args.fastfile),
        "game": walk.game,
        "bytes": len(walk.data),
        "entries": len(walk.entries),
        "assets": len(walk.assets),
        "aliased": walk.aliased,
        "loose": walk.loose,
        "seconds": round(walk.seconds, 2),
        "blocks": walk.blocks(),
        "problems": problems,
    }
    if args.listing == "-":
        print("\n".join(lines(walk)))
        sys.exit(1 if problems else 0)
    if args.listing:
        write_listing(walk, args.listing)
    listings = []
    for golden in args.compare:
        missing, extra = compare(rows(walk), read_listing(golden))
        listings.append({"golden": golden, "missing": len(missing), "extra": len(extra), "examples": (missing + extra)[:10]})
        if missing or extra:
            problems.append(f"listing differs from {golden}: {len(missing)} missing, {len(extra)} extra")
    summary["listings"] = listings
    summary["rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024 if resource else None
    if args.json:
        print(json.dumps(summary))
    else:
        print(
            f"{summary['zone']}: {walk.game}, {summary['bytes']:,} bytes, "
            f"{summary['entries']} XAssets, {summary['assets']} assets loaded"
        )
        print(f"  {walk.aliased} XAssets alias an earlier asset; {walk.loose} references to no allocation")
        print(f"  {summary['seconds']} s, peak RSS {summary['rss_mb']} MB")
        for name, peak, size in summary["blocks"]:
            print(f"  {name:10} {peak:>12,} {'==' if peak == size else '!='} {size:,}")
        counts = collections.Counter(a.listed for a in walk.assets)
        print("  " + ", ".join(f"{k} {v}" for k, v in counts.most_common()))
        for entry in listings:
            print(f"  vs {entry['golden']}: {entry['missing']} missing, {entry['extra']} extra {entry['examples'] or ''}")
        for problem in problems:
            print(f"  PROBLEM: {problem}")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
