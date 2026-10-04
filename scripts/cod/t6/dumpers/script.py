"""`script`: each compiled script (ScriptParseTree) at its own name, as the zone holds it.

T6 keeps its `.gsc`/`.csc` compiled (`\\x80GSC\\r\\n\\0\\x06`), not as text rawfiles as
T5 does; `t6/gsc.py` reads what they say. A ScriptParseTree is `{name, len,
buffer}` (OAT's T6_Assets.h), so the file is `len` bytes of `buffer`.

Named `script`, the zone's own type name, not `scriptfile`: the export's
animated-props stage reads IW5's `scriptfile`s, and T6's are not those.
"""

from ...iw6.dumpers.common import asset_path


def contents(asset):
    rec = asset.record
    buf = rec["buffer"]
    return bytes(buf.bytes())[: max(rec["len"], 0)] if buf is not None else b""


def write(walk, out, ctx=None):
    written = 0
    for asset in walk.by_type("script"):
        if asset.name.startswith(","):
            continue
        with open(asset_path(out, asset.name), "wb") as fh:
            fh.write(contents(asset))
        written += 1
    print(f"      {written} scripts written")
