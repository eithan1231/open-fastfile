"""What dumps a fastfile into the tree every later stage reads, chosen by the fastfile itself.

`scripts/cod/iw4` reads MW2, `scripts/cod/iw5` MW3, `scripts/cod/t5` Black Ops,
`scripts/cod/t6` Black Ops II, `scripts/cod/iw6` Ghosts, `scripts/cod/s1` Advanced Warfare and `scripts/cod/t9`
Black Ops Cold War. All of them write
the same files in the same schema, told apart only by `_game`
(docs/cod/pipeline.md#1-dump). A backend is built with `search`, the `;`-joined
`.iwd` archives an image's pixels may be kept in (None for none), and has:

- `claims(ff)`: whether the fastfile is its game's, from the header;
- `check()`: exit unless what a walk needs (struct layouts, a load program) is built;
- `dump(ff, out, kind)`: write one kind (`gfxworld`, `image`, ...);
- `dumps(kind)`: whether it can write that kind at all;
- `provides(*kinds)`: whether it writes them whole, which a stage needs before it runs;
- `writes(kind, *fields)`: whether it writes those top-level fields of a kind,
  for a stage that reads only them;
- `pictures`: where the map's compass and loading-screen pictures are — `"iwd"`
  loose in the game's archives, `"zone"` as ordinary images in its zones;
- optionally `loadscreen_zones` (globs, `{map}` the zone name and `{mode}` its
  prefix, `mp` or `zm`; default `{map}_load.ff`) and `loadscreen_size`, the shape
  the game draws it at.
"""

import sys

from .iw4.backend import Backend as Iw4Backend
from .iw5.backend import Backend as Iw5Backend
from .iw6.backend import Backend as Iw6Backend
from .s1.backend import Backend as S1Backend
from .t5.backend import Backend as T5Backend
from .t6.backend import Backend as T6Backend
from .t9.backend import Backend as T9Backend

# Each backend claims a fastfile by its own header (magic and version). Two
# claiming the same file would mean one of those headers is wrong.
BACKENDS = (Iw4Backend, Iw5Backend, T5Backend, T6Backend, Iw6Backend, S1Backend, T9Backend)


def for_fastfile(fastfile, search=None):
    """The backend that reads `fastfile`, checked ready to run; exits on a file no backend claims.

    `search` is the game's `;`-joined `.iwd` search path, for its image dumps."""
    claimed = [cls for cls in BACKENDS if cls.claims(fastfile)]
    if len(claimed) > 1:
        sys.exit(f"{fastfile} is claimed by {len(claimed)} backends: {', '.join(cls.name for cls in claimed)}")
    if not claimed:
        sys.exit(f"{fastfile} is not a fastfile any backend reads: no header matches {', '.join(cls.name for cls in BACKENDS)}")
    backend = claimed[0](search)
    backend.check()
    return backend


def require_fields(backend, what, kind, *fields):
    """Exit unless `backend`'s `kind` dump carries these top-level fields, whole or in part."""
    if not backend.writes(kind, *fields):
        sys.exit(f"{what} needs a {kind} dump carrying {len(fields)} field(s) the {backend.name} backend does not write yet")


def require(backend, what, *kinds):
    """Exit unless `backend` dumps every kind whole: `what` would read a gap as absence."""
    missing = [kind for kind in kinds if not backend.provides(kind)]
    if missing:
        sys.exit(f"{what} needs {', '.join(missing)} dumps, which the {backend.name} backend does not write whole yet")
