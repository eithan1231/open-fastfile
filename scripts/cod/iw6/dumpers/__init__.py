"""One writer per dump kind, keyed by the name `Backend.dump` takes (`gfxworld`, `image`, ...).

A writer takes the walked zone and an output folder and writes that kind's files
in the dump tree's schema (docs/cod/pipeline.md#the-dump-tree), with
`_game: "iw6"`. To add a kind, add a module here and import it below.

A writer registered with `parts` writes only those top-level fields of that
schema; the backend dumps it but does not claim the kind, so a stage that needs
all of it refuses to run rather than reading a gap as "nothing there", and a
stage that needs only some fields asks for them by name (Backend.writes).
"""

from collections import namedtuple

# `zone` is the walked zone.Zone (its `found` holds what the walkers kept);
# `world` is gfxworld.World; `library` is what every zone walked so far says
# about shared assets (Backend.library), for the ones this zone only names;
# `assets` is what the walk listed, in order (walkers.ZoneWalk.assets).
Walked = namedtuple("Walked", "path zone world library assets", defaults=(None, None))

GAME = "iw6"
DUMPERS = {}
COMPLETE = set()
PARTS = {}  # kind -> the top-level fields a partial writer writes


def dumper(kind, parts=None):
    def register(fn):
        DUMPERS[kind] = fn
        if parts is None:
            COMPLETE.add(kind)
        else:
            PARTS[kind] = frozenset(parts)
        return fn

    return register


from . import (  # noqa: E402, F401  (each registers itself)
    attachment,
    clipmap,
    gfxworld,
    image,
    mapents,
    material,
    pathdata,
    rawfile,
    scriptfile,
    weapon,
    xanim,
    xmodel,
)
