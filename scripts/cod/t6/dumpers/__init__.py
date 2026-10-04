"""T6's writer per dump kind: T5's or IW5's where T6's records have their members, T6's own where not.

The registry has IW5's shape (scripts/cod/iw5/dumpers/__init__.py): `DUMPERS`,
`COMPLETE`, `PARTS` and `Context`. IW5's `mapents` and `xmodel` writers read T6's
records as they are (a model's surfaces on the model, as on T5; the vertex packing
is chosen by `_game` inside the model writer), and so does T5's `rawfile` (T6 keeps
its scripts as compiled `script` assets, so its rawfiles are the `.vision`, the AI's
`animstatedefs/*.asd` and the like, stored plain). `gfxworld`, `clipmap`, `material`
and `image` are T6's own. `script` writes the compiled scripts as they are.

IW5's `xanim` writer reads T6's XAnimParts too: the same flat pools and IW5's delta
part (`quat2` and `quat`), and it refuses a clip whose pools are not used up exactly
(docs/cod/reference.md#black-ops-ii-xanims). Nothing animates a T6 prop yet: that
reads the animated-model scripts, which T6 compiles and nothing reads.

`weapon`, `attachment` and `attachmentunique` write OAT's infostrings
(t6/dumpers/weapon.py): the catalogue's input (catalog.py). `stringtable` writes each
table as a CSV (t6/dumpers/stringtable.py): `patch_mp.ff`'s `mp/statstable.csv` checks it.

**What is not written yet**, each a kind this backend does not claim, so the stages
that read it skip and say so (docs/cod/games.md#black-ops-ii-t6):

- `fx`, destructibles: not ported.

`sound` writes the `soundbank`'s alias lists; the audio is in the `.sabl`/`.sabs`
bank files beside the zones, and each entry says which (t6/dumpers/sound.py).
`loadedsound` writes nothing: T6 has no such asset, and scripts/cod/sound.py reads
a recording out of its bank file when a table names it.

`loadscreen` writes only the pictures of the `loadscreen_*` materials, at full size
(t6/dumpers/loadscreen.py).

`pathdata` is T5's writer over T6's wider link (t6/dumpers/pathdata.py).

`image` writes the pixels a zone holds itself, else a level from the `.ipak` packs
(t6/dumpers/image.py).
"""

from ...iw5.dumpers import Context, mapents, xanim, xmodel
from ...t5.dumpers import rawfile
from . import clipmap, gfxworld, image, loadscreen, material, pathdata, script, sound, stringtable, weapon

__all__ = ["COMPLETE", "Context", "DUMPERS", "PARTS"]


def nothing(walk, out, ctx=None):
    """A kind this backend dumps no file of (see above)."""


DUMPERS = {
    "gfxworld": gfxworld.write,
    "clipmap": clipmap.write,
    "mapents": mapents.write,
    "rawfile": rawfile.write,
    "xmodel": xmodel.write,
    "xanim": xanim.write,
    "script": script.write,
    "material": material.write,
    "image": image.write,
    "pathdata": pathdata.write,
    "loadscreen": loadscreen.write,
    "sound": sound.write,
    "loadedsound": nothing,
    "weapon": weapon.write,
    "attachment": weapon.write_attachments,
    "attachmentunique": weapon.write_uniques,
    "stringtable": stringtable.write,
}
PARTS = {}  # kind -> the top-level fields a partial writer writes
COMPLETE = set(DUMPERS) - set(PARTS)
