"""The T6 dump backend: the dump tree for Black Ops II, from a zonecode walk.

    backend = Backend(search)             # `search` is unused: T6 has no .iwd archives
    backend.dump(ff, out, "clipmap")       # writes the clipmap dump under `out`

The walk-once-then-write shape is T5's (scripts/cod/zonecode/backend.py). The zone
is decrypted by `t6/ff.py`, which `fastfile.claim` hands T6 files to, so the walker
reads it as it reads the other 32-bit games. The compass and loading-screen
pictures are zone images, as on Ghosts (`pictures = "zone"`), not loose files. The
loading screen is not in a `<map>_load.ff`: it is the `loadscreen_<map>` material
in `code_post_gfx_mp.ff`, or in a DLC map's `<dlc>_load_mp.ff`
(t6/dumpers/loadscreen.py). A zombies map's is `loadscreen_<map>_<gametype>_<location>`
in `code_post_gfx_zm.ff`, which maps.json names (`loadscreen`).
"""

from ..zone.spec import T6
from ..zonecode.backend import Backend as WalkBackend
from . import dumpers


class Backend(WalkBackend):
    name = "t6"
    spec = T6
    dumpers = dumpers
    pictures = "zone"  # no .iwd archives: the compass map is an image in the map's zone
    # Where stage 10 looks for `loadscreen_<map>` (globs beside the map's zone; `{mode}` is
    # the zone name's prefix, `mp` or `zm`), and the shape it is drawn at: the game
    # stretches a square picture over the screen.
    loadscreen_zones = ("code_post_gfx_{mode}.ff", "*_load_{mode}.ff")
    loadscreen_size = (640, 360)
