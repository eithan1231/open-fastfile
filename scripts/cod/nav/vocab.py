"""The standard navigation vocabularies, and how each game's path data maps onto them.

The first half is the format's own vocabulary, numbered exactly as
`packages/shared/src/nav/vocab.ts` numbers it; both are checked against the
conformance fixture's `vocab` tables (docs/engine/nav-format.md). The second
half is Call of Duty's: which classname, type number and animscript becomes
which standard value, per game. The evidence for every entry is
reverse/cod-pathdata (docs/cod/navigation.md has the counts).

A value is never renumbered: a number is what a `nav.bin` stores.
"""

# ---- the format's own vocabulary (game-agnostic) ---------------------------------

#: `u8 type` of a NODE record. What the place is for; nothing about how to reach it.
NODE_TYPES = {
    "PATH": 0,
    "COVER_STAND": 1,
    "COVER_CROUCH": 2,
    "COVER_CROUCH_WINDOW": 3,
    "COVER_PRONE": 4,
    "COVER_RIGHT": 5,
    "COVER_LEFT": 6,
    "COVER_WIDE_RIGHT": 7,
    "COVER_WIDE_LEFT": 8,
    "COVER_PILLAR": 9,
    "COVER_MULTI": 10,
    "CONCEALMENT_STAND": 11,
    "CONCEALMENT_CROUCH": 12,
    "CONCEALMENT_PRONE": 13,
    "EXPOSED": 14,
    "AMBUSH": 15,
    "GUARD": 16,
    "TURRET": 17,
    "DOOR": 18,
    "DOOR_INTERIOR": 19,
    "SCRIPTED": 20,
    "BALCONY": 21,
    "REACQUIRE": 22,
    "TRAVERSE_BEGIN": 23,
    "TRAVERSE_END": 24,
    "JUMP": 25,
    "JUMP_ATTACK": 26,
}

#: `u8 flags` of a NODE record.
NODE_FLAGS = {
    "HAS_YAW": 1 << 0,  # `yaw` means something
    "FLOOR_Z": 1 << 1,  # the position is already on the floor, not authored above it
    "DYNAMIC": 1 << 2,  # the position is in `group`'s frame, not the world's
}

#: `u8 stance` of a NODE record: the stances the source allows there; 0 = not stated.
STANCES = {
    "STAND": 1 << 0,
    "CROUCH": 1 << 1,
    "PRONE": 1 << 2,
}

#: `u32 abilities` of a NODE record: what a mover needs to use the node; 0 = nothing special.
ABILITIES = {
    "WALK": 1 << 0,
    "DROP": 1 << 1,
    "MANTLE": 1 << 2,
    "LADDER": 1 << 3,
    "JUMP": 1 << 4,
    "BOOST": 1 << 5,
}

#: `u8 kind` of a LINK record.
LINK_KINDS = {
    "WALK": 0,
    "TRAVERSE": 1,
}

#: `u8 flags` of a LINK record.
LINK_FLAGS = {
    "GAME": 1 << 0,  # the source's own compiled link
    "START_DISCONNECTED": 1 << 1,  # blocked until something connects it
    "ONE_WAY_IN_GAME": 1 << 2,  # the source has no link back
    "NEGOTIATION": 1 << 3,  # exactly the begin -> end link of a traversal
}

#: `u8 kind` of a TRAV record. 0 is UNKNOWN so that a zeroed record claims nothing.
TRAVERSAL_KINDS = {
    "UNKNOWN": 0,
    "STEP_UP": 1,
    "MANTLE_ON": 2,
    "MANTLE_OVER": 3,
    "JUMP_DOWN": 4,
    "JUMP_ACROSS": 5,
    "JUMP_UP": 6,
    "LADDER_UP": 7,
    "LADDER_DOWN": 8,
    "SPECIAL": 9,
}

#: The header's `u32 flags`. Bits 16-31 must be understood by a reader; 0-15 may be ignored.
HEADER_FLAGS = {
    "HAS_GAME_WALK_LINKS": 1 << 0,
    "DERIVE_WALK_LINKS": 1 << 16,
}

#: A section table entry's `u16 flags`.
SECTION_FLAGS = {
    "REQUIRED": 1 << 0,
}

#: Every table above, under the key the conformance fixture's `vocab` uses.
TABLES = {
    "nodeTypes": NODE_TYPES,
    "nodeFlags": NODE_FLAGS,
    "stances": STANCES,
    "abilities": ABILITIES,
    "linkKinds": LINK_KINDS,
    "linkFlags": LINK_FLAGS,
    "traversalKinds": TRAVERSAL_KINDS,
    "headerFlags": HEADER_FLAGS,
    "sectionFlags": SECTION_FLAGS,
}


def mask(table, names):
    """The bitwise OR of `names` in a flag table; an unknown name is a KeyError."""
    out = 0
    for name in names:
        out |= table[name]
    return out


def names(table, value):
    """The names of the bits set in `value`, in table order. Bits no name covers are dropped."""
    return [name for name, bit in table.items() if value & bit]


# ---- Call of Duty ----------------------------------------------------------------------

#: A `node_*` entity's classname -> standard type. The same in every game that has nodes.
CLASSNAME_TYPES = {
    "node_pathnode": "PATH",
    "node_cover_stand": "COVER_STAND",
    "node_cover_crouch": "COVER_CROUCH",
    "node_cover_crouch_window": "COVER_CROUCH_WINDOW",
    "node_cover_prone": "COVER_PRONE",
    "node_cover_right": "COVER_RIGHT",
    "node_cover_left": "COVER_LEFT",
    "node_cover_wide_right": "COVER_WIDE_RIGHT",
    "node_cover_wide_left": "COVER_WIDE_LEFT",
    "node_cover_pillar": "COVER_PILLAR",
    "node_cover_multi": "COVER_MULTI",
    "node_concealment_stand": "CONCEALMENT_STAND",
    "node_concealment_crouch": "CONCEALMENT_CROUCH",
    "node_concealment_prone": "CONCEALMENT_PRONE",
    "node_exposed": "EXPOSED",
    "node_ambush": "AMBUSH",
    "node_guard": "GUARD",
    "node_turret": "TURRET",
    "node_door": "DOOR",
    "node_door_interior": "DOOR_INTERIOR",
    "node_scripted": "SCRIPTED",
    "node_balcony": "BALCONY",
    "node_reacquire": "REACQUIRE",
    "node_negotiation_begin": "TRAVERSE_BEGIN",
    "node_negotiation_end": "TRAVERSE_END",
    "node_jump": "JUMP",
    "node_jump_attack": "JUMP_ATTACK",
}

_IW5_TYPES = [
    None, "PATH", "COVER_STAND", "COVER_CROUCH", "COVER_CROUCH_WINDOW", "COVER_PRONE", "COVER_RIGHT",
    "COVER_LEFT", "AMBUSH", "EXPOSED", "CONCEALMENT_STAND", "CONCEALMENT_CROUCH", "CONCEALMENT_PRONE",
    "DOOR", "DOOR_INTERIOR", "SCRIPTED", "TRAVERSE_BEGIN", "TRAVERSE_END", "TURRET", "GUARD",
]  # fmt: skip
_T5_TYPES = [
    None, "PATH", "COVER_STAND", "COVER_CROUCH", "COVER_CROUCH_WINDOW", "COVER_PRONE", "COVER_RIGHT",
    "COVER_LEFT", "COVER_WIDE_RIGHT", "COVER_WIDE_LEFT", "COVER_PILLAR", "CONCEALMENT_STAND",
    "CONCEALMENT_CROUCH", "CONCEALMENT_PRONE", "REACQUIRE", "BALCONY", "SCRIPTED", "TRAVERSE_BEGIN",
    "TRAVERSE_END", "TURRET", "GUARD",
]  # fmt: skip
# T6 drops the two wide covers and puts AMBUSH and EXPOSED back, after COVER_PILLAR: the server's
# own classname table (0xcb8000) and name table (nodeStringTable, 0xe065c8), and its PDB's enum.
_T6_TYPES = [
    None, "PATH", "COVER_STAND", "COVER_CROUCH", "COVER_CROUCH_WINDOW", "COVER_PRONE", "COVER_RIGHT",
    "COVER_LEFT", "COVER_PILLAR", "AMBUSH", "EXPOSED", "CONCEALMENT_STAND", "CONCEALMENT_CROUCH",
    "CONCEALMENT_PRONE", "REACQUIRE", "BALCONY", "SCRIPTED", "TRAVERSE_BEGIN", "TRAVERSE_END", "TURRET",
    "GUARD",
]  # fmt: skip
# IW6's `*_3D` types (21-28) never ship and have no standard type: a node of one is an error.
_IW6_TYPES = [
    None, "PATH", "COVER_STAND", "COVER_CROUCH", "COVER_CROUCH_WINDOW", "COVER_PRONE", "COVER_RIGHT",
    "COVER_LEFT", "COVER_MULTI", "AMBUSH", "EXPOSED", "CONCEALMENT_STAND", "CONCEALMENT_CROUCH",
    "CONCEALMENT_PRONE", "DOOR", "DOOR_INTERIOR", "SCRIPTED", "TRAVERSE_BEGIN", "TRAVERSE_END", "TURRET",
    "GUARD", None, None, None, None, None, None, None, None, "JUMP", "JUMP_ATTACK",
]  # fmt: skip

#: A PathData node's `type` number -> standard type, per game (0 is the game's error type).
#: AW numbers its nodes as Ghosts does.
GAME_TYPES = {
    "mw3": {i: t for i, t in enumerate(_IW5_TYPES) if t},
    "bo1": {i: t for i, t in enumerate(_T5_TYPES) if t},
    "bo2": {i: t for i, t in enumerate(_T6_TYPES) if t},
    "ghosts": {i: t for i, t in enumerate(_IW6_TYPES) if t},
    "aw": {i: t for i, t in enumerate(_IW6_TYPES) if t},
}

#: The entity key a `node_negotiation_begin` names its animscript under.
ANIMSCRIPT_KEYS = {"mw3": "1983", "bo1": "animscript", "bo2": "animscript", "ghosts": "52", "aw": "71"}

#: The PathData spawnflags bit the compiler sets exactly when the node's entity has `angles`:
#: HAS_YAW. Read from entities, HAS_YAW is simply "has `angles`".
HAS_YAW_SPAWNFLAG = {"mw3": 0x8000, "bo1": 0x8000, "bo2": 0x8000, "ghosts": 0x8000, "aw": 0x80000}

#: Where each source's node positions sit: on the floor (FLOOR_Z) or authored above it.
FLOOR_Z = {
    ("mw3", "entities"): False,
    ("mw3", "pathdata"): True,  # the Survival zone's
    ("bo1", "entities"): False,
    ("bo1", "pathdata"): False,  # Black Ops keeps the authored height
    ("bo2", "entities"): False,
    ("bo2", "pathdata"): False,  # and so does Black Ops II
    ("ghosts", "entities"): False,
    ("ghosts", "pathdata"): True,
    ("aw", "entities"): False,
    ("aw", "pathdata"): True,
}

#: Animscript -> traversal kind, per game, by exact name: every name that ships outside the
#: families below. The number in a name is the obstacle the animation was made for, not the
#: pair's rise, so the kind comes from here and reachability from the positions, at load.
ANIMSCRIPT_KINDS = {
    "mw3": {
        "jump_across_72": "JUMP_ACROSS",
        "jump_across_100": "JUMP_ACROSS",
        "berlin_jumpdown_28": "JUMP_DOWN",
        "jumpdown_40": "JUMP_DOWN",
        "jumpdown_56": "JUMP_DOWN",
        "jumpdown_96": "JUMP_DOWN",
        "jumpdown_130": "JUMP_DOWN",
        "ladder_up": "LADDER_UP",
        "traverse_window_terminal": "MANTLE_OVER",
        "wall_hop": "MANTLE_OVER",
        "wall_over_40": "MANTLE_OVER",
        "window_over_40": "MANTLE_OVER",
        "step_up_32": "STEP_UP",
        "stepup_52": "STEP_UP",
    },
    "bo1": {
        "jump_down_40": "JUMP_DOWN",
        "jump_down_56": "JUMP_DOWN",
        "jump_down_96": "JUMP_DOWN",
        "mantle_on_40": "MANTLE_ON",
        "mantle_on_56": "MANTLE_ON",
        "mantle_on_96": "MANTLE_ON",
        "mantle_over_40": "MANTLE_OVER",
        "mantle_window_36": "MANTLE_OVER",
        # The zombies maps' own: each is `animscripts/traverse/<name>.gsc` in common_zombie(_patch).ff
        # or the map zone (reverse/t5-zombies). Climbing in at a window, over a 40-inch sill:
        "zombie_mantle_over_40": "MANTLE_OVER",
        # Dropping down, as `ai_zombie_jump_down_<n>` or a crawler's or dog's own clip.
        "zombie_jump_down_40": "JUMP_DOWN",
        "zombie_jump_down_72": "JUMP_DOWN",
        "zombie_jump_down_120": "JUMP_DOWN",
        "zombie_jump_down_127": "JUMP_DOWN",
        "zombie_jump_down_190": "JUMP_DOWN",
        "zombie_jump_down_240": "JUMP_DOWN",
        "zombie_jump_down_286": "JUMP_DOWN",
        # A quad's ways down, gravity and collision off: out of a vent (114 in) and down a wall to
        # the ground (650-800 in). The end is below the begin on every pair, so a drop.
        "zombie_quad_vent_jump_down": "JUMP_DOWN",
        "zombie_wall_crawl_drop": "JUMP_DOWN",
        "zombie_wall_crawl_drop_quick": "JUMP_DOWN",
    },
    "bo2": {
        "jump_down_40": "JUMP_DOWN",
        "jump_down_56": "JUMP_DOWN",
        "mantle_on_40": "MANTLE_ON",
        "mantle_on_56": "MANTLE_ON",
        "mantle_over_36": "MANTLE_OVER",
        "mantle_over_40": "MANTLE_OVER",
        # Plays the begin's `script_animation` (drone's `jump_over_wall_drone`): a scripted move.
        "generic": "SPECIAL",
        # TranZit's own, each `animscripts/traverse/<name>.gsc` in zm_transit_patch.ff. The kind is
        # the name's, checked against every pair's rise (reverse/t6-zombies § path nodes): the
        # window climb and the vaults over a car, a counter and a garage door are level; the
        # drops fall 30-295 in and the climbs rise 30-293 in.
        "zm_mantle_over_40": "MANTLE_OVER",
        "zm_traverse_car": "MANTLE_OVER",
        "zm_traverse_car_reverse": "MANTLE_OVER",
        "zm_traverse_diner_counter": "MANTLE_OVER",
        "zm_traverse_diner_counter_reverse": "MANTLE_OVER",
        "zm_traverse_garage_door": "MANTLE_OVER",
        "zm_jump_across_120": "JUMP_ACROSS",
        "zm_jump_down_48": "JUMP_DOWN",
        "zm_jump_down_96": "JUMP_DOWN",
        "zm_jump_down_127": "JUMP_DOWN",
        "zm_jump_down_190": "JUMP_DOWN",
        "zm_jump_down_222": "JUMP_DOWN",
        "zm_climb_down_pothole": "JUMP_DOWN",
        "zm_traverse_diner_roof": "JUMP_DOWN",
        "zm_jump_up_127": "JUMP_UP",
        "zm_jump_up_222": "JUMP_UP",
        "zm_climb_up_pothole": "JUMP_UP",
        "zm_traverse_diner_roof_up": "JUMP_UP",
        "zm_traverse_diner_roof_hatch_up": "JUMP_UP",
    },
    "ghosts": {
        "jump_across": "JUMP_ACROSS",
        "jump_across_72": "JUMP_ACROSS",
        "jump_down": "JUMP_DOWN",
        "jump_down_40": "JUMP_DOWN",
        "jump_down_80": "JUMP_DOWN",
        "step_down": "JUMP_DOWN",
        "jump_standing_80": "JUMP_UP",
        "jump_up_40": "JUMP_UP",
        "jump_up_80": "JUMP_UP",
        "ladder_up": "LADDER_UP",
        "wall_hop": "MANTLE_OVER",
        "wall_over": "MANTLE_OVER",
        "window_over_40": "MANTLE_OVER",
        "window_over_quick": "MANTLE_OVER",
        "step_up": "STEP_UP",
    },
    "aw": {
        "jump_across_72": "JUMP_ACROSS",
        "jump_down": "JUMP_DOWN",
        "jump_down_40": "JUMP_DOWN",
        "jump_down_80": "JUMP_DOWN",
        "jumpdown_40": "JUMP_DOWN",
        "jumpdown_96": "JUMP_DOWN",
        "jumpdown_130": "JUMP_DOWN",
        "jump_standing_80": "JUMP_UP",
        "jump_up_40": "JUMP_UP",
        "jump_up_80": "JUMP_UP",
        "ladder_down": "LADDER_DOWN",
        "ladder_up": "LADDER_UP",
        "mantle_over_low_cover_40": "MANTLE_OVER",
        "wall_hop": "MANTLE_OVER",
        "window_over_40": "MANTLE_OVER",
        "stepup_112": "STEP_UP",
    },
}

#: Families of animscripts no player of ours performs as such, SPECIAL by prefix: Ghosts'
#: Extinction aliens, AW's exo `boost_*` moves and its `bot_*` scripts. Black Ops' `zombie_*`
#: are exact rows, so a zombies map with a script they lack reports it as UNKNOWN.
SPECIAL_PREFIXES = {
    "mw3": (),
    "bo1": (),
    "bo2": (),
    "ghosts": ("alien_",),
    "aw": ("boost_", "bot_"),
}


#: Black Ops II's negotiation hints: a `node_negotiation_begin` with no animscript and one of these
#: spawnflags, which the server's debug draw names (DrawClaimedNodes 0x5b69d8). A bot takes only
#: these traversals (reverse/cod-pathdata §T6), as the player's own move; the name stands in the
#: TRAV record's `animscript`. A mantle is the player's, which picks over or onto from the ledge.
NEGOTIATION_HINTS = {
    "bo2": {0x400000: "LADDER", 0x800000: "MANTLE", 0x1000000: "JUMP", 0x2000000: "FALL"},
}
#: A hint's kind. JUMP ships on no map, and whether it is up or across is not known: UNKNOWN.
HINT_KINDS = {"LADDER": "LADDER_UP", "MANTLE": "MANTLE_ON", "FALL": "JUMP_DOWN"}

#: Link flags whose link the game's search never expands, per game: Black Ops II's 0x10, which
#: marks a link redundant (a two-link route exists) or disconnected (reverse/cod-pathdata §T6).
UNSEARCHED_LINK_FLAGS = {"bo2": 0x10}


def negotiation_move(game, animscript, spawnflags):
    """(the move's name, its kind) for a negotiation begin: its animscript, else its hint."""
    if animscript or game not in NEGOTIATION_HINTS:
        return animscript, traversal_kind(game, animscript)
    hints = [name for bit, name in NEGOTIATION_HINTS[game].items() if spawnflags & bit]
    if len(hints) != 1:
        return "", "UNKNOWN"
    return hints[0], HINT_KINDS.get(hints[0], "UNKNOWN")


def traversal_kind(game, animscript):
    """The standard kind of `game`'s `animscript`; UNKNOWN for a name the tables have not seen."""
    kind = ANIMSCRIPT_KINDS[game].get(animscript)
    if kind:
        return kind
    if animscript.startswith(SPECIAL_PREFIXES[game]):
        return "SPECIAL"
    return "UNKNOWN"
