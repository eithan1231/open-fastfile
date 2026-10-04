"""The IW6 dump backend: the dump tree, from a Python walk.

    backend = Backend()
    backend.dump(ff, out, "gfxworld")      # writes the GfxWorld dump under `out`

A fastfile is walked once, on the first dump that names it, and every later kind
is written from that walk (a walk takes 5-15 s). Each kind is a writer in
`dumpers/`, which is where a new one goes.
"""

import os

from . import durango, ff, zone
from .dumpers import COMPLETE, DUMPERS, PARTS, Walked
from .dumpers.material import summary
from .dumpers.zonesource import write_listing
from .gfxworld import walk_zone


class Backend:
    name = "iw6"
    kinds = frozenset(COMPLETE)  # dumped whole; `dump` also writes the partial ones (dumpers/__init__.py)
    # Ghosts ships no .iwd archives: the compass picture is an image in the map's
    # own zone, and the loading screen one in `<map>_load.ff` (docs/cod/games.md).
    pictures = "zone"

    def __init__(self, search=None):
        # `search` names .iwd archives, and Ghosts ships none: every image is in a zone.
        self._walked = {}
        # Material name -> dumpers.material.MaterialSummary, from every zone walked. A map
        # names a companion's material under a leading comma, and the companion is dumped first.
        self.library = {"materials": {}}

    @staticmethod
    def claims(fastfile):
        """Whether `fastfile` is an IW6 PC fastfile, from its header."""
        return ff.is_fastfile(fastfile)

    def check(self):
        """Refuse to start without what a walk needs: the struct layouts and the Durango build."""
        if not os.path.exists(zone.LAYOUT):
            raise SystemExit(f"no IW6 struct layout at {zone.LAYOUT}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)")
        types = zone.durango_types()
        if not types or not os.path.exists(types):
            where = (
                f"{types} does not exist"
                if types
                else f"neither $IW6_DURANGO_TYPES nor cod.config.json's `{zone.DURANGO_TYPES_KEY}` names it"
            )
            raise SystemExit(
                f"Ghosts needs the Durango type table (durango_types.json, generated from the Xbox One server build's .pdb), "
                f"and {where}: docs/cod/README.md#ghosts-and-advanced-warfare"
            )
        found = durango.folder()
        if not found or not os.path.exists(os.path.join(found, durango.STEM + ".exe")):
            # Without it the walk stops at the first weapon or menu, usually before the world.
            where = (
                f"{found} holds no {durango.STEM}.exe"
                if found
                else f"neither ${durango.ENV} nor cod.config.json's `{durango.KEY}` names it"
            )
            raise SystemExit(
                f"Ghosts needs the Xbox One server build ({durango.STEM}.exe and .map), and {where}: "
                "docs/cod/README.md#ghosts-and-advanced-warfare"
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
            raise SystemExit(f"the IW6 backend cannot dump {kind!r} yet (it can: {', '.join(sorted(DUMPERS))})")
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
        walk holds up to 800 MB. So a map's walk is kept, and of the others only the latest."""
        key = os.path.abspath(fastfile)
        if key not in self._walked:
            print(f"      walking {os.path.basename(fastfile)}")
            walk, world = walk_zone(fastfile)
            if walk.failed:
                raise SystemExit(f"{fastfile}: the walk stopped at asset {walk.failed[0]} ({walk.failed[1]}): {walk.failed[2]}")
            self._walked = {k: w for k, w in self._walked.items() if w.world is not None}
            self._walked[key] = Walked(key, walk.z, world, self.library, walk.assets)
            for name, material in walk.z.found.get("MATERIAL", {}).items():
                if not name.startswith(","):
                    self.library["materials"][name] = summary(material)
        return self._walked[key]
