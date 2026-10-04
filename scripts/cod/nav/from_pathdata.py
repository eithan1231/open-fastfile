"""A map's `pathdata` dump as a `NavData`: the game's own compiled graph, walk links included.

Ghosts and AW ship their path nodes compiled into `<map>_path.ff`, Black Ops
into the map zone's GameWorldMp (the dump is
scripts/cod/iw6/dumpers/pathdata.py's schema, in game units). Unlike the
entity lump (`from_ents.py`), it carries every link the game's compiler made, so
the file says `HAS_GAME_WALK_LINKS` and nothing is derived at load. The mapping
is docs/cod/navigation.md; the evidence reverse/cod-pathdata/README.md.

- **Nodes**: the entity nodes, in order. The zone graph's nodes (one type-0 node
  per path zone, appended) and nodes riding a dynamic group are left out and
  counted in META's `skipped`, with every link touching them.
- **Positions** go through `metadata.to_engine`, as `from_ents` and
  `gameplay.world` convert theirs. Ghosts' and AW's compiler dropped them onto
  the floor, so `FLOOR_Z` is set; Black Ops keeps the authored height, so it is
  not. Never snapped here.
- **Links** keep `fDist` as the game cost, as given: a cost, never a distance.
  A link the game's search never expands (`vocab.UNSEARCHED_LINK_FLAGS`: Black
  Ops II's redundant links) is left out and counted in META's `links.unsearched`.
- **Traversals** are named by the begin's animscript, or by its negotiation hint
  where the game has them and the animscript is empty (`vocab.negotiation_move`).

The node array is the entity lump's `node_*` entities, in lump order (§1), and
that is checked, not assumed: a mismatch in count, order, type or x/y (and z,
where the height is the authored one) is an error, since a graph off by one node
would put every link somewhere else.
"""

import math
from collections import Counter

from ..metadata import floats, to_engine
from .format import Link, NavData, Node, Traversal
from .from_ents import MIN_NODES, NODE_PREFIX, VOCAB_GAMES, engine_yaw
from .vocab import (
    CLASSNAME_TYPES,
    FLOOR_Z,
    GAME_TYPES,
    HAS_YAW_SPAWNFLAG,
    HEADER_FLAGS,
    LINK_FLAGS,
    UNSEARCHED_LINK_FLAGS,
    negotiation_move,
)

#: The zone graph's nodes carry type 0, the games' ERROR type (reverse/cod-pathdata §6).
ZONE_NODE_TYPE = 0

#: How far (inches) a node's x or y (or z) may sit from its entity's: the lump writes
#: origins as text with a few significant figures, the zone as float32. Nodes
#: of one map are never this close, so a node off by one index cannot pass.
ORIGIN_TOLERANCE = 0.1


class NavSourceError(ValueError):
    """The path data does not say what this mapping assumes it says; nothing is written."""


def from_pathdata(pathdata, entities, game_key, map_name):
    """A `pathdata` dump and the map's entities (lump order) -> (NavData, None), or (None, why).

    Raises NavSourceError when the dump disagrees with the entity lump or with
    what reverse/cod-pathdata found: zone nodes that are not last, a type the
    game does not number, a negotiation link between nodes that are no pair.
    """
    game = VOCAB_GAMES.get(game_key)
    if game is None or (game, "pathdata") not in FLOOR_Z:
        return None, f"no path-data mapping for {game_key!r}"
    if pathdata.get("_type") != "pathdata" or pathdata.get("_game") != game_key:
        raise NavSourceError(
            f"{map_name}: expected a {game_key} pathdata dump, got {pathdata.get('_game')!r} {pathdata.get('_type')!r}"
        )
    types = GAME_TYPES[game]
    src = pathdata["nodes"]
    count, zone_count = pathdata["nodeCount"], pathdata["zoneCount"]
    if len(src) != count or not 0 <= zone_count <= count:
        raise NavSourceError(f"{map_name}: {len(src)} nodes read, {count} declared, {zone_count} zones")
    entity_count = count - zone_count
    for n in src[entity_count:]:
        if n["type"] != ZONE_NODE_TYPE:
            raise NavSourceError(f"{map_name}: node {n['index']} should be a zone node (type 0), is type {n['type']}")
    for n in src[:entity_count]:
        if n["type"] not in types:
            raise NavSourceError(f"{map_name}: node {n['index']} has type {n['type']}, which {game} does not number")
    floor_z = FLOOR_Z[(game, "pathdata")]
    worst = check_against_entities(src[:entity_count], entities, types, map_name, with_z=not floor_z)

    # Old index -> new, for the nodes kept; why each other one was left out.
    index, skipped = {}, Counter()
    for n in src:
        if n["index"] >= entity_count:
            skipped["zoneNodes"] += 1
        elif n.get("dynamicGroup") is not None:
            skipped["dynamicNodes"] += 1
        else:
            index[n["index"]] = len(index)
    if len(index) < MIN_NODES:
        return None, f"{len(index)} path node(s), fewer than {MIN_NODES}: not a pathed map"

    yaw_bit = HAS_YAW_SPAWNFLAG[game]
    nodes = [
        Node(
            position=tuple(to_engine(n["origin"])),
            type=types[n["type"]],
            yaw=engine_yaw(n["angle"]) if n["spawnflags"] & yaw_bit else None,
            floor_z=floor_z,
            source=n["index"],
            name=n.get("targetname") or "",
        )
        for n in src
        if n["index"] in index
    ]
    links, traversals, counts, unknown = _links(src, index, nodes, game, map_name)
    ends = {t.end for t in traversals}
    begins = {t.begin for t in traversals}
    unpaired = {
        "begin": [n.source for i, n in enumerate(nodes) if n.type == "TRAVERSE_BEGIN" and i not in begins],
        "end": [n.source for i, n in enumerate(nodes) if n.type == "TRAVERSE_END" and i not in ends],
    }
    abilities = Counter(n["pathAbility"] for n in src if n.get("pathAbility"))

    meta = {
        "game": game,
        "map": map_name,
        "source": "pathdata",
        "generator": "scripts/cod/nav/from_pathdata.py",
        "pathdataVersion": pathdata.get("version"),
        "entityMatch": {"nodes": entity_count, "compared": "x y z type" if not floor_z else "x y type", "worst": round(worst, 4)},
        "nodes": dict(sorted(Counter(n.type for n in nodes).items())),
        "links": dict(sorted(counts.items())),
        "traversals": dict(sorted(Counter(t.kind for t in traversals).items())),
    }
    if any(unpaired.values()):
        meta["unpaired"] = {k: v for k, v in unpaired.items() if v}
    if unknown:
        meta["unknownAnimscripts"] = dict(sorted(unknown.items()))
    if abilities:
        # No MP map sets one (§11), so there is no vocabulary to map them onto yet.
        meta["pathAbilities"] = {str(k): v for k, v in sorted(abilities.items())}
    nav = NavData(
        nodes=nodes,
        links=links,
        traversals=traversals,
        flags=HEADER_FLAGS["HAS_GAME_WALK_LINKS"],
        meta=meta,
        skipped=dict(sorted(skipped.items())),
    )
    return nav, None


def check_against_entities(src, entities, types, map_name, with_z=False):
    """Require the entity nodes to be the lump's `node_*` entities: same count, order, x/y and type,
    and z too `with_z` (a source that keeps the authored height). Returns the worst axis
    difference seen, in inches."""
    ents = [e for e in entities if e.get("classname", "").startswith(NODE_PREFIX)]
    if len(ents) != len(src):
        raise NavSourceError(
            f"{map_name}: the path data has {len(src)} entity nodes and the entity lump {len(ents)} node_* entities; "
            "they are one array in every map read so far (reverse/cod-pathdata §1)"
        )
    axes = 3 if with_z else 2
    bad, worst = [], 0.0
    for n, e in zip(src, ents, strict=True):
        origin = floats(e.get("origin"))
        kind = CLASSNAME_TYPES.get(e.get("classname"))
        off = max(abs(origin[k] - n["origin"][k]) for k in range(axes)) if origin is not None else math.inf
        if off > ORIGIN_TOLERANCE or kind != types[n["type"]]:
            at = " ".join(f"{v:.1f}" for v in n["origin"][:axes])
            bad.append(f"#{n['index']} ({types[n['type']]} at {at} vs {e.get('classname')} at {e.get('origin')})")
        else:
            worst = max(worst, off)
    if bad:
        raise NavSourceError(
            f"{map_name}: {len(bad)} path node(s) differ from their node_* entity in {'x/y/z' if with_z else 'x/y'} or type: "
            f"{', '.join(bad[:5])}" + (" ..." if len(bad) > 5 else "")
        )
    return worst


def _links(src, index, nodes, game, map_name):
    """The kept nodes' links, and a traversal per negotiation link. Returns (links, traversals, counts, unknown)."""
    unsearched = UNSEARCHED_LINK_FLAGS.get(game, 0)
    searched = {n["index"]: [lk for lk in n["links"] if not lk.get("flags", 0) & unsearched] for n in src}
    pairs = {(i, lk["target"]) for i, lks in searched.items() for lk in lks}
    links, traversals, counts, unknown = [], [], Counter(), Counter()
    for n in src:
        a = index.get(n["index"])
        if a is None:
            continue
        if len(searched[n["index"]]) != len(n["links"]):
            counts["unsearched"] += len(n["links"]) - len(searched[n["index"]])
        for lk in searched[n["index"]]:
            b = index.get(lk["target"])
            if b is None:
                counts["droppedToSkippedNodes"] += 1
                continue
            flags = LINK_FLAGS["GAME"]
            if (lk["target"], n["index"]) not in pairs:
                flags |= LINK_FLAGS["ONE_WAY_IN_GAME"]
            if lk["disconnectCount"]:
                flags |= LINK_FLAGS["START_DISCONNECTED"]
                counts["startDisconnected"] += 1
            if not lk["negotiationLink"]:
                links.append(Link(a, b, kind="WALK", game_cost=lk["fDist"], flags=flags))
                counts["walk"] += 1
                counts["walkOneWay"] += bool(flags & LINK_FLAGS["ONE_WAY_IN_GAME"])
                continue
            # Every shipped negotiation link runs from a begin to the end it targets (§2);
            # Extinction's JUMP links do not, and need a decision this mapping does not make.
            if (nodes[a].type, nodes[b].type) != ("TRAVERSE_BEGIN", "TRAVERSE_END"):
                raise NavSourceError(
                    f"{map_name}: negotiation link {n['index']} -> {lk['target']} joins a {nodes[a].type} to a {nodes[b].type}"
                )
            animscript, kind = negotiation_move(game, n.get("animscript") or "", n["spawnflags"])
            if kind == "UNKNOWN":
                unknown[animscript] += 1
            flags |= LINK_FLAGS["NEGOTIATION"]
            links.append(Link(a, b, kind="TRAVERSE", game_cost=lk["fDist"], flags=flags, traversal=len(traversals)))
            traversals.append(Traversal(begin=a, end=b, kind=kind, animscript=animscript))
            counts["traverse"] += 1
    return links, traversals, counts, unknown
