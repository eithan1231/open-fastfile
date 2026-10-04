"""The T9 dump backend: the dump tree, from a zone read by content.

    backend = Backend()
    backend.dump(ff, out, "gfxworld")      # writes the GfxWorld dump under `out`

A fastfile is inflated once, on the first dump that names it, and every later
kind is written from that one `Walked`. Each kind is a writer in `dumpers/`.
What each writes, and what it leaves as a placeholder: dumpers/__init__.py.
"""

import os

from . import oodle
from .dumpers import COMPLETE, DUMPERS, PARTS
from .dumpers.zonesource import write_listing
from .ff import is_fastfile
from .walk import Walked


class Backend:
    name = "t9"
    kinds = frozenset(COMPLETE)
    # Cold War ships no .iwd archives: every picture is an image in a zone.
    pictures = "zone"

    def __init__(self, search=None):
        # `search` names .iwd archives, and Cold War ships none.
        self._walked = {}

    @staticmethod
    def claims(fastfile):
        """Whether `fastfile` is a T9 fastfile (TAFF, version 9), from its header."""
        return is_fastfile(fastfile)

    def check(self):
        """Refuse to start without the Oodle decoder every block and stream item needs."""
        if not oodle.available():
            raise SystemExit(
                f"no Oodle decoder at {oodle.library_path()}: T9 zones are Oodle Kraken. Build ooz with "
                f"{oodle.BUILD} (it clones github.com/powzix/ooz at a pinned commit and compiles it), "
                "or point OOZ_LIB at a build of it"
            )

    def dumps(self, kind):
        return kind in DUMPERS

    def provides(self, *kinds):
        return all(kind in self.kinds for kind in kinds)

    def writes(self, kind, *fields):
        return self.provides(kind) or set(fields) <= PARTS.get(kind, set())

    def dump(self, fastfile, out, kind):
        if kind not in DUMPERS:
            raise SystemExit(f"the T9 backend cannot dump {kind!r} yet (it can: {', '.join(sorted(DUMPERS))})")
        walked = self.walk(fastfile)
        DUMPERS[kind](walked, out)
        write_listing(walked, out)

    def walk(self, fastfile):
        key = os.path.abspath(fastfile)
        if key not in self._walked:
            print(f"      inflating {os.path.basename(fastfile)}")
            self._walked = {key: Walked(key)}  # a map zone and its companions hold a gigabyte: one at a time
        return self._walked[key]
