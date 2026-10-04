"""IW4's writer per dump kind: IW5's writers, which read IW4's records as they are.

IW4's assets are IW5's with a few members moved or missing: no ClipInfo (its
members are flat on clipMap_t), `XModelSurfs` kept by an action rather than
loaded as an asset, a rawfile that may be stored plain, 48 techniques rather than
54, and a weapon without attachments. Each IW5 writer names what it reads by
member and takes the game from the walk, so the same writer is both games'
(docs/cod/pipeline.md#the-zonecode-walker). The registry has IW5's shape
(scripts/cod/iw5/dumpers/__init__.py).

**Effects and sound aliases are not written yet**: writing them is new output
and a decision of its own (docs/cod/games.md). They are registered as partial
kinds holding no fields: a dump writes the zone listing and nothing else, and
stages 12 and 13 skip. The PCM behind the loaded aliases (`loadedsound`) is
written.
"""

from ...iw5.dumpers import (
    Context,
    clipmap,
    gfxworld,
    image,
    mapents,
    material,
    rawfile,
    sound,
    weapon,
    xanim,
    xmodel,
)

__all__ = ["COMPLETE", "Context", "DUMPERS", "PARTS"]


def nothing(walk, out, ctx=None):
    """A kind this backend dumps no file of (see above); the listing is written beside it."""


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
    "loadedsound": sound.write_pcm,
    "fx": nothing,
    "sound": nothing,
}
PARTS = {"fx": frozenset(), "sound": frozenset()}  # kind -> the top-level fields a partial writer writes
COMPLETE = set(DUMPERS) - set(PARTS)
