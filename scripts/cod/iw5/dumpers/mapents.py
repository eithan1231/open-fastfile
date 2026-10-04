"""`mapents`: the entity lump as text, `<map>.ents`, where OpenAssetTools puts it.

`numEntityChars` counts the terminating NUL, which is not part of the text.
Keys are script-string numbers where the compiler had no name for them;
scripts/cod/entities.py recognises the ones the pipeline needs by their values.
"""

from ...iw6.dumpers.common import asset_path
from . import dumper


@dumper("mapents")
def write(walk, out, ctx=None):
    for asset in walk.by_type("mapents"):
        ents = asset.record
        text = ents["entityString"]
        data = bytes(text.bytes()) if text is not None else b""
        with open(asset_path(out, f"{asset.name}.ents"), "wb") as fh:
            fh.write(data[: max(ents["numEntityChars"] - 1, 0)])
