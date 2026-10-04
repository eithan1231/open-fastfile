"""`stringtable`: each string table as a CSV at its own name, as OpenAssetTools' dumper writes it.

AW keeps its multiplayer tables -- the costume tables that say which models
dress a player (scripts/cod/costumes.py), the class table, the rank table -- in
its *localized* patch zones, not in `common_mp.ff`.
"""

import csv

from ...iw6.dumpers.common import asset_path
from . import dumper


@dumper("stringtable")
def write(walked, out):
    for name, table in walked.zone.found.get("STRINGTABLE", {}).items():
        if name.startswith(","):
            continue
        with open(asset_path(out, name), "w", newline="", encoding="utf-8") as fh:
            rows = csv.writer(fh, lineterminator="\n")
            for r in range(table.rows):
                rows.writerow([table.cells[r * table.columns + c] or "" for c in range(table.columns)])
