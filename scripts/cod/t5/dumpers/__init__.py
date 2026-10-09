"""T5's writer per dump kind: IW5's where T5's records have IW5's members, T5's own where not.

The registry has IW5's shape (scripts/cod/iw5/dumpers/__init__.py): `DUMPERS`,
`COMPLETE`, `PARTS` and `Context`. IW5's `mapents`, `xmodel` and `xanim` writers
read T5's records as they are (a model's surfaces on the model, a bone's `offset`,
version-19 clips); the rest are T5's own modules, each saying what differs.

**Sound is one asset.** A T5 zone's `soundbank` holds the aliases and their audio
together, so `sound` writes both halves and `loadedsound` writes nothing at all
(`NOTHING_AT_ALL`, which the backend returns on before it walks or lists anything).
"""

from ...iw5.dumpers import Context, mapents, xanim, xmodel
from . import clipmap, fx, gfxworld, image, material, pathdata, rawfile, sound, weapon

__all__ = ["COMPLETE", "Context", "DUMPERS", "NOTHING_AT_ALL", "PARTS"]


def nothing(walk, out, ctx=None):
    """A kind this backend dumps no file of (see above)."""


DUMPERS = {
    "gfxworld": gfxworld.write,
    "clipmap": clipmap.write,
    "mapents": mapents.write,
    "rawfile": rawfile.write,
    "xmodel": xmodel.write,
    "material": material.write,
    "image": image.write,
    "xanim": xanim.write,
    "weapon": weapon.write,
    "sound": sound.write,
    "loadedsound": nothing,
    "fx": fx.write,
    "pathdata": pathdata.write,
}
PARTS = {}  # kind -> the top-level fields a partial writer writes
COMPLETE = set(DUMPERS) - set(PARTS)
NOTHING_AT_ALL = frozenset({"loadedsound"})
