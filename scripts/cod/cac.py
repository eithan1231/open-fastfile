"""Black Ops' create-a-class scripts: which body, head and view arms each faction wears.

The IW games name a body after its faction and leave the pairing to be read out
of the names (characters.py). Black Ops does not need reading: every MP map zone
ships `mpbody/<class>_mp.gsc` and `mphead/head_<class>_mp.gsc` as text rawfiles,
and those say it outright —

    level.cac_assets[ "usa_cia" ][ "standard_mp" ] = "c_usa_cia_mp_body_standard";
    level.cac_assets[ "usa_cia" ][ "viewmodel" ][ "standard_mp" ] = "viewmodel_usa_cia_standard_arms";
    get_default_head() { return( "head_standard_mp" ); }
    level.cac_assets[ "usa_cia" ][ "head_standard_mp" ] = "c_usa_cia_mp_head_4";

— so a body's head is its class's default head in its own faction, and its view
arms are named beside it. The heads are not a body's by name (every faction's
`_head_1`..`_5` share two words with every body), which is why a reading of the
names would dress the Spetsnaz in the CIA's faces.
"""

import os
import re

from .files import read_text

BODY_DIR, HEAD_DIR = "mpbody", "mphead"

# The class a side is dressed in by default. Black Ops calls it `standard`, and it
# is the only one of the five with no perk attached (`set_specialties` is empty).
DEFAULT_CLASS = "standard_mp"

# Which team each faction plays, from the four `_teamset_*.gsc` in common_mp.ff
# (`game["cac_faction_allies"]` / `["cac_faction_axis"]`): urban and winter spec
# ops, jungle marines, and the Cubans. A map zone only says which two it ships.
FACTION_SIDES = {
    "usa_cia": "allies",
    "usa_ciawin": "allies",
    "usa_sog": "allies",
    "cub_rebels": "allies",
    "rus_spet": "axis",
    "rus_spetwin": "axis",
    "vtn_nva": "axis",
    "cub_tropas": "axis",
}

_ASSET = re.compile(r'level\.cac_assets\[\s*"([^"]+)"\s*\]\[\s*"([^"]+)"\s*\](?:\[\s*"([^"]+)"\s*\])?\s*=\s*"([^"]+)"')
_DEFAULT_HEAD = re.compile(r'get_default_head\s*\(\s*\)\s*\{[^}]*return\s*\(\s*"([^"]+)"')


def _scripts(raw_dir, sub):
    d = os.path.join(raw_dir, sub)
    for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if name.endswith(".gsc"):
            yield name.removesuffix(".gsc"), read_text(os.path.join(d, name))


def read_cast(raw_dir):
    """{faction: {class: (body, head, arms)}} from a map's rawfile dump; {} for a zone with none.

    Only the combinations the scripts complete: a class whose default head or arms
    no script names is left out rather than half-dressed.
    """
    heads = {}  # (faction, head class) -> model
    for _, text in _scripts(raw_dir, HEAD_DIR):
        for faction, key, _, model in _ASSET.findall(text):
            heads[(faction, key)] = model

    out = {}
    for cls, text in _scripts(raw_dir, BODY_DIR):
        default_head = _DEFAULT_HEAD.search(text)
        bodies, arms = {}, {}
        for faction, key, sub, model in _ASSET.findall(text):
            if key == "viewmodel" and sub == cls:
                arms[faction] = model
            elif key == cls and not sub:
                bodies[faction] = model
        for faction, body in bodies.items():
            head = heads.get((faction, default_head.group(1))) if default_head else None
            if head and faction in arms:
                out.setdefault(faction, {})[cls] = (body, head, arms[faction])
    return out


def factions_in(cast, models):
    """The factions of `cast` whose default body this zone actually dumped, allies first.

    Every map's scripts list all eight factions; the zone carries two.
    """
    present = [f for f, classes in cast.items() if DEFAULT_CLASS in classes and classes[DEFAULT_CLASS][0] in models]
    return [f for f, _ in sorted(((f, None) for f in present), key=allies_first)]


def allies_first(item):
    """Sort key for (faction, ...) pairs: the allied factions first, then by name."""
    return FACTION_SIDES.get(item[0]) != "allies", item[0]


def side_of(body):
    """ "allies", "axis", or None, for a `c_<faction>_mp_body_<class>` name."""
    m = re.match(r"c_(.+)_mp_body_", body)
    return FACTION_SIDES.get(m.group(1)) if m else None
