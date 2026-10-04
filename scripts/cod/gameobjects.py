"""Which game modes an entity exists in, from its `script_gameobjectname`.

Every gametype's `onStartGameType` hands `maps/mp/gametypes/_gameobjects.gsc`'s
`main` the names it allows, and that deletes, once at level load, every entity
whose space-separated `script_gameobjectname` names none of them. So a bomb
site's crate exists in Search and Destroy and not in Team Deathmatch, and a
Black Ops wager barrier only in the four wager modes. The tables and their
evidence: docs/cod/reference.md#game-mode-objects.

A tag lists our **mode keys**, which are the game's own gametype names with IW's
`war` spelled `tdm`, as the spawn classnames already spell it.
"""

import dataclasses

from .entities import named_keys, parse_ents

# The key that holds the names, once entities.named_keys has named it.
KEY = "script_gameobjectname"

# IW's `main` appends this to every gametype's list, so what carries it is in every mode.
IW_ALWAYS = "airdrop_pallet"
# T5's `entity_is_allowed` keeps an entity whose whole value is this string, in every mode.
T5_ALL_MODES = "[all_modes]"

# {mode key: names its gametype allows}, read from each gametype's `onStartGameType`.
# MW2's are in the source; MW3's are the same lists read from its compiled
# scripts' strings, with Demolition's own `dd_bombzone`.
IW4_ALLOWED = {
    "tdm": ("war",),  # war.gsc: allowed[0] = level.gameType
    "dm": ("dm",),
    "dom": ("dom",),
    "koth": ("hq",),
    "sd": ("sd", "bombzone", "blocker"),
    "dd": ("dd", "bombzone", "blocker"),
    "sab": ("sab",),
    "ctf": ("ctf",),
    "oneflag": ("ctf",),
    "gtnw": ("gtnw", "gtnw_zone"),
    "arena": ("dom", "arena"),
    "vip": ("vip", "sd"),
}
IW5_ALLOWED = {**IW4_ALLOWED, "dd": ("dd", "dd_bombzone", "blocker")}
# AW is read as MW3 (not yet verified against its scripts), plus its two modes whose
# names its maps carry, each allowing its own name as every IW gametype but three does.
S1_ALLOWED = {**IW5_ALLOWED, "hp": ("hp",), "horde": ("horde",)}

# Black Ops, from common_mp.ff. The three conditional lists are in `_allowed_t5`.
T5_ALLOWED = {
    "tdm": ("tdm",),
    "dm": ("dm",),
    "dom": ("dom",),
    "koth": ("hq",),
    "sd": ("sd", "bombzone", "blocker"),
    "dem": ("sd", "bombzone_dem", "blocker", "dem"),
    "sab": ("sab",),
    "ctf": ("ctf",),
    "twar": ("twar",),
    "gun": ("gun",),
    "oic": ("oic",),
    "shrp": ("shrp",),
    "hlnd": ("hlnd",),
    "sur": ("sur",),
}

# Ghosts: no entity in any of its zones carries the key, so there is nothing to allow.
# Cold War's gametype scripts are not read, so, as on Ghosts, no entity is restricted to a mode.
ALLOWED_BY_GAME = {"iw4": IW4_ALLOWED, "iw5": IW5_ALLOWED, "s1": S1_ALLOWED, "t5": T5_ALLOWED, "t6": {}, "iw6": {}, "t9": {}}

# twar.gsc falls back to Domination's spawns, and then keeps Domination's objects, when
# a map lacks any of these.
T5_TWAR_SPAWNS = ("mp_twar_spawn_axis_start", "mp_twar_spawn_allies_start", "mp_twar_spawn")


@dataclasses.dataclass
class MapFacts:
    """What the conditional lists read off a map, and the names already reported for it.

    One per export, so an unknown name is printed once however many stages ask.
    """

    map: str
    targetnames: frozenset = frozenset()
    classnames: frozenset = frozenset()
    reported: set = dataclasses.field(default_factory=set)

    @classmethod
    def from_entities(cls, map_name, entities):
        """From entities whose keys entities.named_keys has named."""
        return cls(
            map=map_name,
            targetnames=frozenset(e["targetname"] for e in entities if e.get("targetname")),
            classnames=frozenset(e["classname"] for e in entities if e.get("classname")),
        )


def _allowed_t5(facts):
    allowed = dict(T5_ALLOWED)
    if facts.map == "mp_kowloon":  # koth.gsc
        allowed["koth"] += ("koth",)
    if "bombzone_dem" not in facts.targetnames:  # dem.gsc: level.demBombzoneName
        allowed["dem"] = ("sd", "bombzone", "blocker", "dem")
    if any(c not in facts.classnames for c in T5_TWAR_SPAWNS):  # twar.gsc: allow_dom_object_placement
        allowed["twar"] += ("dom",)
    return allowed


def allowed_names(game, facts):
    """{mode key: names allowed} for one map of `game`, its conditions applied."""
    if game == "t5":
        return _allowed_t5(facts)
    if game not in ALLOWED_BY_GAME:
        raise ValueError(f"no game-object table for game {game!r}")
    return ALLOWED_BY_GAME[game]


def known_names(game):
    """Every name some gametype of `game` allows on some map."""
    if game == "t5":
        conditional = _allowed_t5(MapFacts(map="mp_kowloon"))
        return {n for names in (*T5_ALLOWED.values(), *conditional.values()) for n in names}
    return {n for names in ALLOWED_BY_GAME.get(game, {}).values() for n in names}


def modes_of(game, entity, facts):
    """The sorted mode keys `entity` exists in, or None when it exists in every mode.

    None also for a name no table knows, which stays in every mode rather than be
    guessed out of one (AW's `boost_add`); it is printed, once per `facts`.
    """
    value = entity.get(KEY)
    if value is None:
        return None
    if game == "t5" and value == T5_ALL_MODES:
        return None
    names = value.split()
    if game in ("iw4", "iw5", "s1") and IW_ALWAYS in names:
        return None
    known = known_names(game)
    unknown = sorted(n for n in names if n not in known)
    for n in unknown:
        if (game, n) not in facts.reported:
            facts.reported.add((game, n))
            fate = "ignored beside the names it knows" if len(unknown) < len(names) else "left in every mode"
            print(f"      game objects: {n!r} is in no {game} gametype's list ({entity.get('classname')}); {fate}")
    if len(unknown) == len(names):
        return None
    modes = sorted(mode for mode, allowed in allowed_names(game, facts).items() if any(n in allowed for n in names))
    if not modes:
        # Known names that no gametype allows on this map (a conditional one): the
        # game deletes it everywhere, which a tag cannot say.
        if (game, value) not in facts.reported:
            facts.reported.add((game, value))
            print(f"      game objects: {value!r} is allowed by no gametype on {facts.map}; left in every mode")
        return None
    return modes


def mode_clause(modes):
    """The DSL property for a list of mode keys: `mode: "gun" "hlnd"`."""
    return "mode: " + " ".join(f'"{m}"' for m in modes)


def facts_from_ents(map_name, ents_path, game):
    """The MapFacts of an entity-lump dump."""
    return MapFacts.from_entities(map_name, named_keys(parse_ents(ents_path), game))
