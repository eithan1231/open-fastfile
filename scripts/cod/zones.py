"""Which fastfiles beside a map are dumped with it, and which hold a game's sound."""

import os

# Fastfiles a map borrows assets from, tried in order: common_mp.ff for
# multiplayer, common.ff for the campaign.
COMMON_ZONES = ("common_mp.ff", "common.ff")

# Where a game keeps its sound, which is *not* where it keeps everything else:
# IW5's common_mp.ff holds no sound asset at all, and the 7,387-alias bank is in
# the localized zone beside it. Tried in order, multiplayer first.
SOUND_ZONES = ("localized_common_mp.ff", "localized_common.ff")
# Black Ops has no localized bank zone: its common_mp.ff carries aliases and PCM together.
T5_SOUND_ZONES = ("common_mp.ff",)

# Fastfiles that define no alias but hold PCM those aliases name, so they are
# dumped for `loadedsound` and nothing else.
SOUND_PCM_ZONES = (*COMMON_ZONES, "localized_code_post_gfx_mp.ff")


def companion_zones(zone_dir, requested):
    """(name, path) of each companion fastfile to dump alongside the map.

    Defaults to whichever of COMMON_ZONES sits beside the map; a reference to a
    zone that is not dumped silently drops the props it names. `requested`
    (from `--common`) overrides that; `['']` opts out.
    """
    if requested is not None:
        return [(os.path.basename(p), p) for p in requested if p]
    found = [(n, os.path.join(zone_dir, n)) for n in COMMON_ZONES]
    return [(n, p) for n, p in found if os.path.exists(p)]
