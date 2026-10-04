"""The T5 dump backend: the dump tree for Black Ops, from a zonecode walk.

    backend = Backend(search)             # `search`: the `;`-joined .iwd archives, or None
    backend.dump(ff, out, "clipmap")       # writes the clipmap dump under `out`

The walk-once-then-write shape is IW5's and IW4's (scripts/cod/zonecode/backend.py).
One difference is Black Ops' own: a zone keeps its aliases *and* their audio in one
`soundbank` asset, so `sound` writes both halves and `loadedsound` writes nothing,
not even the listing.
"""

from ..zone.spec import T5
from ..zonecode.backend import Backend as WalkBackend
from . import dumpers


class Backend(WalkBackend):
    name = "t5"
    spec = T5
    dumpers = dumpers
    exe = ("T5_EXE", "bo1")  # BlackOpsMP.exe, read (never run) for the wavelet code tables

    def dump(self, fastfile_path, out, kind):
        if kind in dumpers.NOTHING_AT_ALL:
            return None
        return super().dump(fastfile_path, out, kind)
