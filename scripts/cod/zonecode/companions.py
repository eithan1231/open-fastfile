"""What a map names under a leading comma and a companion zone holds, found by name.

    companions = Companions(backend.companion_walk)
    companions.note(walk)                     # every non-map zone the backend walks
    companions.find("surfaces", {"flag2_lod000"})   # {name: what the holding zone's indexer gave}

A writer registers an indexer per kind with `@holds(kind)`: a function from a walk to
{name: value} for everything of that kind the zone holds itself. Only the names are
kept per zone, so a companion's walk can be let go; `find` walks it again if a later
companion replaced it, and each zone at most once per call. The values are the walk's
own lazy records, so nothing is decoded until the writer reads it.
"""

import os
from collections import defaultdict

INDEXERS = {}  # kind -> fn(walk) -> {name: value}


def holds(kind):
    def register(fn):
        INDEXERS[kind] = fn
        return fn

    return register


class Companions:
    def __init__(self, walk_zone, is_held=lambda path: False):
        """`walk_zone(path)` is the backend's walk of a companion zone; `is_held(path)`
        whether that walk is still in memory, so a name two zones hold costs no walk."""
        self._walk_zone, self._is_held = walk_zone, is_held
        self._where = defaultdict(lambda: defaultdict(list))  # kind -> name -> [zone path]

    def note(self, walk):
        """Index what `walk` (a companion zone) holds of each registered kind, by name."""
        path = os.path.abspath(walk.path)
        for kind, index in INDEXERS.items():
            for name in index(walk):
                zones = self._where[kind][name]
                if path not in zones:
                    zones.append(path)

    def find(self, kind, names):
        """{name: value} for each of `names` some noted zone holds; a name none holds is left out."""
        by_zone = defaultdict(list)
        for name in names:
            zones = self._where[kind].get(name)
            if zones:
                by_zone[next((z for z in zones if self._is_held(z)), zones[0])].append(name)
        found = {}
        # The zones still held first, so a walk this call needs is not dropped for another.
        for path in sorted(by_zone, key=lambda z: not self._is_held(z)):
            held = INDEXERS[kind](self._walk_zone(path))
            found.update((name, held[name]) for name in by_zone[path] if name in held)
        return found
