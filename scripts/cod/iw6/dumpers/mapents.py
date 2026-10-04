"""`mapents`: the entity lump as text, `<map>.ents`, beside where OpenAssetTools puts it.

Keys are script-string numbers, as on IW5; scripts/cod/entities.py recognises
the ones the pipeline needs by their values.
"""

from ..memory import Struct
from . import dumper
from .common import asset_path


@dumper("mapents")
def write(walked, out):
    for name, loaded in walked.zone.found.get("MAP_ENTS", {}).items():
        ents = Struct.of(walked.zone, loaded)
        text = ents.data("entityString", ents["numEntityChars"]) or b""
        with open(asset_path(out, f"{name}.ents"), "wb") as fh:
            fh.write(text.rstrip(b"\0"))
