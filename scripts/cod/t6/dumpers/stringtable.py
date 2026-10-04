"""`stringtable`: each string table as a CSV at its own name, as OpenAssetTools' dumper writes it.

Black Ops II keeps its multiplayer tables in `patch_mp.ff`: `mp/statstable.csv` names
each weapon's menu group, the attachments its menu offers and the default class it
belongs to, which the catalogue checks its weapon files against (t6_catalog.py).
A `StringTable` is `columnCount` by `rowCount` cells, row-major, each a string and its hash.
"""

import csv
import os


def write(walk, out, ctx=None):
    written = 0
    for asset in walk.by_type("stringtable"):
        if asset.name.startswith(","):
            continue
        table = asset.record
        columns, rows = table["columnCount"], table["rowCount"]
        values = table["values"]
        cells = [(values[i]["string"] or "") if values is not None else "" for i in range(columns * rows)]
        path = os.path.join(out, asset.name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh, lineterminator="\n")
            for r in range(rows):
                writer.writerow(cells[r * columns : (r + 1) * columns])
        written += 1
    print(f"      {written} string table(s) written")
