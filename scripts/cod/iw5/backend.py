"""The IW5 dump backend: the dump tree for MW3, from a zonecode walk.

    backend = Backend(search)             # `search`: the `;`-joined .iwd archives, or None
    backend.dump(ff, out, "clipmap")       # writes the clipmap dump under `out`

The walk-once-then-write shape is shared with IW4's (scripts/cod/zonecode/backend.py).
Each kind is a writer in `dumpers/`, and every kind the pipeline asks an IW5 zone
for has one.
"""

from ..zone.spec import IW5
from ..zonecode.backend import Backend as WalkBackend
from . import dumpers


class Backend(WalkBackend):
    name = "iw5"
    spec = IW5
    dumpers = dumpers
    exe = ("IW5_EXE", "mw3")  # iw5mp.exe
