"""The IW4 dump backend: the dump tree for MW2, from a zonecode walk.

    backend = Backend(search)             # `search`: the `;`-joined .iwd archives, or None
    backend.dump(ff, out, "clipmap")       # writes the clipmap dump under `out`

The walk-once-then-write shape is shared with IW5's (scripts/cod/zonecode/backend.py).
"""

from ..zone.spec import IW4
from ..zonecode.backend import Backend as WalkBackend
from . import dumpers


class Backend(WalkBackend):
    name = "iw4"
    spec = IW4
    dumpers = dumpers
    exe = ("IW4_EXE", "mw2")  # iw4mp.exe
