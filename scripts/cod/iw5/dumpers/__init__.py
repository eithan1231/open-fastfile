"""One writer per dump kind, keyed by the name `Backend.dump` takes (`gfxworld`, `clipmap`, ...).

A writer takes a `zonecode.Walk`, an output folder and a `Context`, and writes that kind's
files in the dump tree's schema (docs/cod/pipeline.md#the-dump-tree), with `_game` the
walk's. What it writes is the zone's data in the zone's order; a stage that depends
on another order is the stage's bug (docs/cod/pipeline.md). To add a kind, add a
module here and import it below. Most of these writers are IW4's too
(scripts/cod/iw4/dumpers/__init__.py): a change here is checked on both games.

The registry has IW6's shape (scripts/cod/iw6/dumpers/__init__.py): a writer
registered with `parts` writes only those top-level fields, so a stage that
needs the whole kind refuses to run rather than reading a gap as absence.
"""

from collections import namedtuple

# What a writer may need beyond its own zone: `search` is the `;`-joined `.iwd`
# search path (images whose pixels are not in the zone are in those archives),
# `exe` the game's executable (the wavelet image code tables are read from it),
# `companions` what the companion zones walked so far hold (zonecode/companions.py).
Context = namedtuple("Context", "search exe companions", defaults=(None, None, None))

GAME = "iw5"
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
    fx,
    gfxworld,
    image,
    mapents,
    material,
    rawfile,
    scriptfile,
    sound,
    weapon,
    xanim,
    xmodel,
)
