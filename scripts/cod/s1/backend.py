"""The S1 dump backend: the dump tree, from a Python walk.

    backend = Backend()
    backend.dump(ff, out, "gfxworld")      # writes the GfxWorld dump under `out`

A fastfile is walked once, on the first dump that names it, and every later kind
is written from that walk. Each kind is a writer in `dumpers/`, which is where a
new one goes. The shape is IW6's (scripts/cod/iw6/backend.py) member for member;
what differs is that there is nothing to emulate, so `check` asks only for the
struct layouts.
"""

import os

from . import ff, walkers
from .dumpers import COMPLETE, DUMPERS, PARTS, Walked
from .dumpers.material import summary
from .dumpers.zonesource import write_listing


class Backend:
    name = "s1"
    kinds = frozenset(COMPLETE)  # dumped whole; `dump` also writes the partial ones (dumpers/__init__.py)
    # Advanced Warfare ships no .iwd archives at all, so the compass picture and the
    # loading screen are images in the map's own zone and in `<map>_load.ff`.
    pictures = "zone"

    def __init__(self, search=None):
        # `search` names .iwd archives, and Advanced Warfare ships none: every image is in a zone.
        self._walked = {}
        # What every zone walked so far says about materials a *model* in another zone
        # names; the xmodel dumper reads it (PLAN.md phase 6).
        self.library = {"materials": {}}

    @staticmethod
    def claims(fastfile):
        """Whether `fastfile` is an S1 PC fastfile, from its header."""
        return ff.is_fastfile(fastfile)

    def check(self):
        """Refuse to start without what a walk needs: the struct layouts."""
        if not os.path.exists(walkers.LAYOUT):
            raise SystemExit(
                f"no S1 struct layout at {walkers.LAYOUT}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)"
            )

    def dumps(self, kind):
        """Whether `kind` can be dumped at all, whole or in part."""
        return kind in DUMPERS

    def provides(self, *kinds):
        """Whether every kind is dumped whole."""
        return all(kind in self.kinds for kind in kinds)

    def writes(self, kind, *fields):
        """Whether `kind`'s dump holds these top-level fields, whole or not."""
        return self.provides(kind) or set(fields) <= PARTS.get(kind, set())

    def dump(self, fastfile, out, kind):
        """Write `kind` from `fastfile` under `out`."""
        if kind not in DUMPERS:
            raise SystemExit(f"the S1 backend cannot dump {kind!r} yet (it can: {', '.join(sorted(DUMPERS))})")
        walked = self.walk(fastfile)
        DUMPERS[kind](walked, out)
        # The zone's asset listing goes beside whatever was dumped: stage 11 reads
        # it for the game and for what the zone holds.
        write_listing(walked, out)

    def release(self, keep=()):
        """Let go of every walk but those of the fastfiles in `keep` (zonecode/backend.py's)."""
        keep = {os.path.abspath(path) for path in keep}
        self._walked = {k: w for k, w in self._walked.items() if k in keep}

    def walk(self, fastfile):
        """The walked zone, walking it on first use.

        An export dumps its map, then each companion zone, then the map again, and a
        walk holds most of a gigabyte. So a map's walk is kept, and of the others only
        the latest -- dropped before the next one starts, so that two companion zones
        are never held at once."""
        key = os.path.abspath(fastfile)
        if key not in self._walked:
            self._walked = {k: w for k, w in self._walked.items() if w.world is not None}
            print(f"      walking {os.path.basename(fastfile)}")
            walk, world = walkers.walk_zone(fastfile)
            if walk.failed:
                raise SystemExit(f"{fastfile}: the walk stopped at asset {walk.failed[0]} ({walk.failed[1]}): {walk.failed[2]}")
            self._walked[key] = Walked(key, walk.z, world, self.library, walk.assets)
            for name, material in walk.z.found.get("MATERIAL", {}).items():
                if not name.startswith(","):
                    self.library["materials"][name] = summary(material)
            # LOD geometry a model here names in another zone; that zone's xmodel dump keeps it.
            wanted = self.library.setdefault("wanted surfs", set())
            for model in walk.z.found.get("XMODEL", {}).values():
                wanted.update(
                    info.surfs[1:] for info in model.lods if model.at is not None and (info.surfs or "").startswith(",")
                )
        return self._walked[key]
