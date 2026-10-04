"""The map's entity lump (OAT's `mapents` dump): parsing it, and working out which key means what."""

import re
from collections import Counter

from .files import read_text

# Keys are bare script-string indices on IW5 and quoted names on IW4/T5, so the
# quotes around a key are optional.
_PAIR = re.compile(r'"?([^"\s]+)"?\s+"([^"]*)"')
_BLOCK = re.compile(r"\{(.*?)\}", re.S)

# IW5 script-string indices with a confirmed name, identical in all 25 MW3 zones.
# Confirmed by matching mp_terminal_cls to IW4's mp_terminal (505 entities at the
# same classname and origin: each index takes the IW4 key whose value it repeats;
# `script_label` by the Domination flags' labels), plus the worldspawn lighting
# keys in worldfile.WS_*. An index not listed here stays a number: a guessed
# name would read as fact.
IW5_KEY_NAMES = {
    "1668": "classname",
    "1669": "origin",
    "1670": "model",
    "1671": "spawnflags",
    "1672": "target",
    "1673": "targetname",
    "1676": "dmg",
    "1677": "angles",
    "1774": "script_noteworthy",
    "1782": "radius",
    "1783": "height",
    "1788": "script_delay",
    "1987": "ambient",
    "1989": "sunlight",
    "1990": "suncolor",
    "1991": "sundirection",
    "2369": "destructible_type",
    "2812": "skylight",
    "2813": "_color",
    "2814": "ltOrigin",
    "2815": "gndLt",
    "2816": "sound_csv_include",
    "2817": "csv_include",
    "2818": "precache_script",
    "3717": "script_destruct_collision",
    "7712": "modelscale",
    "7876": "script_accel",
    "10338": "script_targetoffset_z",
    "10396": "script_airspeed",
    "11848": "script_gameobjectname",
    "11996": "script_label",
}


# IW6's numbers are its own. Each is the only key holding its values over nine
# Ghosts MP zones: `worldspawn` and every classname (97); the origin, angles and
# model entities.detect_keys picks on all nine (430, 47, 392); `minimap_corner`,
# `flag_primary` and `animated_model` (642); `maps animated_models <name>`, on
# every animated_model entity and nothing else (24841). The three worldspawn
# lighting keys were settled against the map's own lightmap, not by the shape of
# their values (docs/cod/reference.md#entities-and-worldspawn); each has a
# duplicate key nothing here names.
IW6_KEY_NAMES = {
    "47": "angles",
    "97": "classname",
    "392": "model",
    "430": "origin",
    "642": "targetname",
    "759": "sunlight",
    "760": "suncolor",
    "761": "sundirection",
    "24841": "precache_script",
}

# S1's numbers are its own again, read off the stock prefabs an AW map shares with
# an imported MW2, MW3 or Ghosts one (same classname, same origin: each index takes
# the name whose value it repeats), and off per-classname value profiles. Unlisted
# on purpose: 1395 (shaped like `_color`), which would set the ambient colour on a
# guess, and 36816, shaped like `northyaw` but measured not to be: every map's
# compass image lies at north 0 whatever 36816 says (4 to 42.34).
# The evidence per key: reverse/s1-zone/README.md#the-entity-keys.
S1_KEY_NAMES = {
    "58": "ambient",
    "65": "angles",
    "171": "classname",
    "280": "destructible_type",
    "294": "dmg",
    "489": "height",
    "672": "model",
    "742": "origin",
    "852": "radius",
    "917": "script_delay",
    "919": "script_label",
    "987": "spawnflags",
    "1047": "suncolor",
    "1048": "sundirection",
    "1049": "sunlight",
    "1189": "target",
    "1191": "targetname",
    "9382": "csv_include",
    "28362": "precache_script",
    "31014": "script_accel",
    "31021": "script_airspeed",
    "31125": "script_destruct_collision",
    "31215": "script_gameobjectname",
    "31463": "script_targetoffset_z",
    "34965": "sound_csv_include",
}

# Games whose entity keys are script-string numbers; the others' are names already.
KEY_NAMES_BY_GAME = {"iw5": IW5_KEY_NAMES, "iw6": IW6_KEY_NAMES, "s1": S1_KEY_NAMES}


def parse_ents(path):
    """Every entity in a `.ents` file, as a dict of key -> value strings."""
    text = read_text(path)
    return [dict(_PAIR.findall(block)) for block in _BLOCK.findall(text)]


def named_keys(entities, game_key):
    """Entities with numeric keys replaced by their names where known; IW4/T5 unchanged."""
    names = KEY_NAMES_BY_GAME.get(game_key)
    if names is None:
        return entities
    return [{names.get(k, k): v for k, v in e.items()} for e in entities]


def triple(value):
    """Parse "x y z" into [x, y, z]; None if it is not three numbers."""
    parts = value.split()
    if len(parts) != 3:
        return None
    try:
        return [float(p) for p in parts]
    except ValueError:
        return None


def detect_keys(entities):
    """Which keys mean (classname, origin, angles, model).

    IW5 stores keys as per-zone script-string indices, so they are recognised
    by content. `origin` and `angles` are picked by how many entities carry them
    (then by value span): a rare debug key can have a wider span than the real
    one. See docs/cod/pitfalls.md.
    """
    classname = next((k for e in entities for k, v in e.items() if v == "worldspawn"), None)
    if classname is None:
        raise SystemExit("could not find the classname key (no entity is a worldspawn)")

    spans, counts = {}, Counter()
    for e in entities:
        for k, v in e.items():
            if k == classname:
                continue
            t = triple(v)
            if t:
                lo, hi = spans.get(k, (1e18, -1e18))
                spans[k] = (min(lo, *t), max(hi, *t))
                counts[k] += 1

    # Angles stay within +-360; origins run to map scale.
    ranked = sorted(spans, key=lambda k: spans[k][1] - spans[k][0], reverse=True)
    positional = [k for k in spans if spans[k][0] < -361 or spans[k][1] > 361]
    origin = max(positional, key=lambda k: (counts[k], spans[k][1] - spans[k][0]), default=None)
    if origin is None:
        origin = ranked[0] if ranked else None

    rotational = [k for k in spans if k != origin and spans[k][0] >= -361 and spans[k][1] <= 361]
    angles = max(rotational, key=lambda k: (counts[k], spans[k][1] - spans[k][0]), default=None)

    # The model key: only it holds `*N` brush-model references, and it has far
    # more distinct values than a type tag set on as many entities.
    candidates = {}
    for e in entities:
        for k, v in e.items():
            if k in (classname, origin, angles) or not v:
                continue
            if re.fullmatch(r"\*?[A-Za-z0-9_,]+", v):
                candidates.setdefault(k, set()).add(v)
    model = None
    if candidates:
        model = max(candidates, key=lambda k: (any(v.startswith("*") for v in candidates[k]), len(candidates[k])))

    # Choosing the wrong map-scale key is silent (props land at the wrong height),
    # so the evidence goes in the log.
    rivals = [(k, counts[k]) for k in positional if k != origin]
    if rivals:
        detail = ", ".join(f"{k} on {n}" for k, n in sorted(rivals, key=lambda kv: -kv[1]))
        print(f"  origin {origin} is on {counts[origin]} entities; other map-scale key(s): {detail}")

    return classname, origin, angles, model
