"""A map's `node_*` entities as a `NavData`: the graph for a game whose zone ships no links.

The entity lump is the node array in every game that has one (reverse/cod-pathdata
§1): lump order, x/y exact, type from the classname, traversals from a
`node_negotiation_begin`'s `target`. What it lacks is walk links, so the file
says `DERIVE_WALK_LINKS` and holds each traversal's own link and nothing else.
The mapping is docs/cod/navigation.md; the vocabularies are `vocab`.

Entities come as `export_metadata.json` holds them (`entities.py`'s parse, keys
already named), so this needs no game files. Positions go through
`metadata.to_engine`, the conversion `gameplay.world`'s `at:` uses, and are
never snapped: an entity's origin is authored above the floor, so `FLOOR_Z` is
not set.
"""

import math
from collections import Counter

from ..metadata import floats, to_engine
from .format import Link, NavData, Node, Traversal
from .vocab import ANIMSCRIPT_KEYS, ANIMSCRIPT_KINDS, CLASSNAME_TYPES, FLOOR_Z, HEADER_FLAGS, LINK_FLAGS, traversal_kind

#: `_game` (the dump's own key) -> the game name `vocab` keys its tables by.
VOCAB_GAMES = {"iw5": "mw3", "t5": "bo1", "t6": "bo2", "iw6": "ghosts", "s1": "aw"}

#: Fewer nodes than this is a map no designer pathed (aground and courtyard carry
#: three stray covers), not a graph a bot could use: nothing is written.
MIN_NODES = 10

NODE_PREFIX = "node_"


def from_entities(entities, game_key, map_name):
    """`entities` (lump order) -> (NavData, None), or (None, why) when there is no graph worth writing.

    `nav.meta` holds what an exporter reports: counts by type and traversal kind,
    the negotiation nodes that pair with nothing, and animscripts the vocabulary
    has not seen.
    """
    game = VOCAB_GAMES.get(game_key)
    if game is None or game not in ANIMSCRIPT_KINDS:
        return None, f"no path-node mapping for {game_key!r}"
    floor_z = FLOOR_Z[(game, "entities")]
    animscript_key = ANIMSCRIPT_KEYS[game]

    nodes, rows, skipped = [], [], Counter()
    rank = -1
    for e in entities:
        cls = e.get("classname", "")
        if not cls.startswith(NODE_PREFIX):
            continue
        # `source` is the rank among every `node_*` entity, skipped ones included,
        # because that rank is also the node's PathData index where a zone has one.
        rank += 1
        kind = CLASSNAME_TYPES.get(cls)
        origin = floats(e.get("origin"))
        if kind is None:
            skipped[cls] += 1
            continue
        if origin is None:
            skipped["noOrigin"] += 1
            continue
        angles = floats(e.get("angles"))
        nodes.append(
            Node(
                position=tuple(to_engine(origin)),
                type=kind,
                yaw=engine_yaw(angles[1]) if angles else None,
                floor_z=floor_z,
                source=rank,
                name=e.get("targetname", ""),
            )
        )
        rows.append(e)

    if len(nodes) < MIN_NODES:
        return None, f"{len(nodes)} path node(s), fewer than {MIN_NODES}: not a pathed map"

    traversals, unpaired, unknown = _traversals(nodes, rows, game, animscript_key)
    links = [
        Link(t.begin, t.end, kind="TRAVERSE", flags=LINK_FLAGS["NEGOTIATION"], traversal=i) for i, t in enumerate(traversals)
    ]
    meta = {
        "game": game,
        "map": map_name,
        "source": "ents",
        "generator": "scripts/cod/nav/from_ents.py",
        "nodes": dict(sorted(Counter(n.type for n in nodes).items())),
        "traversals": dict(sorted(Counter(t.kind for t in traversals).items())),
    }
    if unpaired:
        meta["unpaired"] = unpaired
    if unknown:
        meta["unknownAnimscripts"] = dict(sorted(unknown.items()))
    nav = NavData(
        nodes=nodes,
        links=links or None,
        traversals=traversals,
        flags=HEADER_FLAGS["DERIVE_WALK_LINKS"],
        meta=meta,
        skipped=dict(sorted(skipped.items())),
    )
    return nav, None


def engine_yaw(cod_yaw_degrees):
    """A CoD yaw (degrees) as the player's yaw (radians): φ = θ − 90°.

    CoD θ faces engine (cos θ, 0, −sin θ) (`metadata.facing`, which a spawn's
    `look` is built from); the player's φ faces (−sin φ, 0, −cos φ).
    """
    return math.radians(cod_yaw_degrees - 90.0)


def _traversals(nodes, rows, game, animscript_key):
    """Each begin whose `target` names exactly one end, as a Traversal. Returns (traversals, unpaired, unknown).

    `unpaired` is {"begin"|"end": [source index, ...]} for negotiation nodes in no
    traversal; `unknown` counts animscripts `vocab.traversal_kind` maps to UNKNOWN,
    by name ("" for a begin that names none).
    """
    ends = {}
    for i, n in enumerate(nodes):
        if n.type == "TRAVERSE_END" and n.name:
            ends.setdefault(n.name, []).append(i)

    traversals, paired_ends, unknown = [], set(), Counter()
    unpaired = {"begin": [], "end": []}
    for i, n in enumerate(nodes):
        if n.type != "TRAVERSE_BEGIN":
            continue
        targets = ends.get(rows[i].get("target", ""), [])
        if len(targets) != 1:
            unpaired["begin"].append(n.source)
            continue
        animscript = rows[i].get(animscript_key, "")
        kind = traversal_kind(game, animscript)
        if kind == "UNKNOWN":
            unknown[animscript] += 1
        traversals.append(Traversal(begin=i, end=targets[0], kind=kind, animscript=animscript))
        paired_ends.add(targets[0])
    unpaired["end"] = [n.source for i, n in enumerate(nodes) if n.type == "TRAVERSE_END" and i not in paired_ends]
    return traversals, {k: v for k, v in unpaired.items() if v}, unknown
