"""`mapents`: `<map>.d3dbsp.ents`, every record of the map's entity lists as `{ "key" "value" }` blocks.

Each record's origin and angles are its own fields, so they are always written;
of its key/value pairs only those whose key and value both resolved to strings
(world.read_ents) and that fit the text format are; a record whose classname
did not resolve is left out.
"""

import re

from ...iw6.dumpers.common import asset_path
from .. import world
from . import dumper

_KEY = re.compile(r"[A-Za-z_][\w .:<>-]{0,63}")


def short(v):
    return f"{v:.6g}"


def block(entity):
    pairs = [(k, v) for k, v in entity["kv"] if k and v is not None and _KEY.fullmatch(k) and '"' not in v and "\n" not in v]
    keys = {k for k, _ in pairs}
    lines = [f'"{k}" "{v}"' for k, v in pairs if k not in ("origin", "angles")]
    if "classname" not in keys:
        return None
    lines.append(f'"origin" "{" ".join(short(x) for x in entity["origin"])}"')
    lines.append(f'"angles" "{" ".join(short(x) for x in entity["angles"])}"')
    return "{\n" + "\n".join(lines) + "\n}\n"


@dumper("mapents")
def write(walked, out):
    d = walked.zone.data
    blocks, records = [], 0
    for h in world.find_ents(d, walked.map):
        for e in world.read_ents(d, h):
            records += 1
            text = block(e)
            if text:
                blocks.append(text)
    with open(asset_path(out, f"{walked.bsp}.ents"), "w", encoding="latin-1") as fh:
        fh.write("".join(blocks))
    print(f"      mapents: {len(blocks)} of {records} records written (the rest have no classname that resolved)")
