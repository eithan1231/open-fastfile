"""Black Ops II's zombies as catalogue actors: the compiled AI scripts, the state machine, the clips.

The unit tests build compiled scripts and state machines of their own; the data
tests read the retail zone and skip where zombies is not installed (as test_t6.py finds it).
The xanim reading is checked harder by reverse/t6-xanim/verify.py.
"""

import os
import struct

import pytest

from scripts.cod import actors as bo1
from scripts.cod.t6 import actors
from scripts.cod.t6.gsc import MAGIC, Script, strings_before

from .test_t6 import BO2_ZONES

CLASSIC = os.path.join(BO2_ZONES, "so_zclassic_zm_transit.ff")


def compiled(functions):
    """A T6 compiled script: `functions` is [(name, [("str", text) | ("call", "ns::name" | "name")])].

    Each event gets four bytes of code of its own, in order, so address order is list order.
    """
    pool = bytearray()
    offsets = {}

    def string(text):
        if text not in offsets:
            offsets[text] = 64 + len(pool)
            pool.extend(text.encode("latin-1") + b"\0")
        return offsets[text]

    for name, events in functions:
        string(name)
        for kind, text in events:
            if kind == "call":
                ns, _, fn = text.rpartition("::")
                string(ns)
                string(fn)
            else:
                string(text)
    base = 64 + len(pool)
    cseg = base
    sites, addr, exports = {"call": {}, "str": {}}, cseg, []
    for name, events in functions:
        exports.append((addr, name))
        for kind, text in events:
            key = text if kind == "str" else tuple(reversed(text.rpartition("::")[::2]))
            sites[kind].setdefault(key, []).append(addr)
            addr += 4
        addr += 4
    size = addr - cseg
    out = bytearray(pool)
    out += bytes(size)
    at_exports = 64 + len(out)
    for a, name in exports:
        out += struct.pack("<IIHBB", 0, a, offsets[name], 0, 0)
    at_imports = 64 + len(out)
    for (fn, ns), where in sites["call"].items():
        out += struct.pack("<HHHBB", offsets[fn], offsets[ns], len(where), 0, 0) + struct.pack(f"<{len(where)}I", *where)
    at_strfix = 64 + len(out)
    for text, where in sites["str"].items():
        out += struct.pack("<HBB", offsets[text], len(where), 0) + struct.pack(f"<{len(where)}I", *where)
    at_fixup = 64 + len(out)
    header = struct.pack(
        "<8sI9IHHHHHHBBBB",
        MAGIC, 0, cseg, 0, cseg, at_strfix, at_exports, at_imports, at_fixup, at_fixup, size,
        offsets[functions[0][0]], len(sites["str"]), len(exports), len(sites["call"]), 0, 0, 0, 0, 0, 0,
    )  # fmt: skip
    return header + bytes(out)


AITYPE = compiled(
    [
        ("main", [("str", "health"), ("call", "codescripts/character::get_random_character"),
                  ("call", "character/c_one::main"), ("call", "character/c_two::main"), ("call", "setcharacterindex")]),
        ("precache", [("call", "character/c_one::precache")]),
    ]
)  # fmt: skip
CHARACTER = compiled(
    [
        ("main", [("str", "c_zom_body_a"), ("call", "setmodel"), ("call", "xmodelalias/heads::main"),
                  ("call", "codescripts/character::randomelement"), ("str", "headmodel"), ("call", "attach"),
                  ("str", "c_zom_body_a_g_upclean"), ("str", "torsodmg1"), ("str", "c_zom_g_rarmspawn"),
                  ("str", "gibspawn1"), ("str", "J_Elbow_RI"), ("str", "gibspawntag1")]),
        ("precache", [("str", "c_zom_body_a"), ("call", "precachemodel")]),
    ]
)  # fmt: skip
HEADS = compiled([("main", [("str", "a"), ("str", "head_k"), ("str", "head_l")])])

ASD = """zm_idle : notify idle_anim
{
	ai_zombie_idle_v1_delta
}

zm_move_walk : notify move_anim
{
	ai_zombie_walk_v1
	ai_zombie_walk_v9
	ai_zombie_walk_v9
}

zm_walk_melee : restart notify melee_anim
{
	ai_zombie_attack_v2
	ai_zombie_walk_attack_v1
}

zm_run_melee : restart notify melee_anim
{
	ai_zombie_attack_v2
	ai_zombie_run_attack_v1
}

zm_traverse_barrier : aliased restart notify traverse_anim
{
	barrier_walk	ai_zombie_traverse_v1
	barrier_walk	ai_zombie_traverse_v2
	barrier_run		ai_zombie_traverse_v5
}

zm_traverse : aliased restart notify traverse_anim
{
	jump_down_48				ai_zombie_jump_down_48
//	jump_down_72					ai_zombie_jump_down_72
	traverse_car							ai_zombie_traverse_car
	traverse_car_run				ai_zombie_traverse_car_run
}
"""


# -- The compiled scripts -------------------------------------------------------------


def test_a_compiled_script_says_what_each_function_calls_and_pushes_in_order():
    script = Script(CHARACTER, "c.gsc")
    main = script.of("main")
    assert [e.text for e in main[:4]] == ["c_zom_body_a", "setmodel", "xmodelalias/heads::main",
                                          "codescripts/character::randomelement"]  # fmt: skip
    assert [e.kind for e in main[:2]] == ["str", "call"]
    assert [e.text for e in script.of("precache")] == ["c_zom_body_a", "precachemodel"]
    assert strings_before(main, 1) == ["c_zom_body_a"]


def test_a_script_whose_tables_do_not_meet_is_refused():
    with pytest.raises(ValueError, match="not a T6"):
        Script(b"\x80GSC\r\n\x00\x05" + CHARACTER[8:])
    broken = bytearray(CHARACTER)
    struct.pack_into("<H", broken, 52, 99)  # the export count: the exports now overrun the imports
    with pytest.raises(ValueError):
        Script(bytes(broken))


def test_an_aitype_names_its_characters_and_a_character_its_body_head_and_gibs():
    assert actors.read_aitype(Script(AITYPE)) == ["c_one", "c_two"]
    assert actors.read_character(Script(CHARACTER)) == {
        "body": "c_zom_body_a",
        "head": "heads",
        # The field's name comes after its value; a gib's tag (a joint) is not a gib.
        "gibs": {"torsoDmg1": ["c_zom_body_a_g_upclean"], "gibSpawn1": ["c_zom_g_rarmspawn"]},
    }
    assert actors.read_alias(Script(HEADS)) == ["head_k", "head_l"]


def _dumped(tmp_path, files):
    for rel, data in files.items():
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return str(tmp_path)


def _character(body):
    return compiled([("main", [("str", body), ("call", "setmodel"), ("call", "xmodelalias/heads::main")])])


def test_a_bodys_weight_is_its_share_of_a_uniform_spawner_then_a_uniform_character(tmp_path):
    raw = _dumped(
        tmp_path,
        {
            "aitype/one.gsc": compiled([("main", [("call", "character/c_a::main"), ("call", "character/c_b::main")])]),
            "aitype/two.gsc": compiled([("main", [("call", "character/c_c::main")])]),
            "character/c_a.gsc": _character("body_a"),
            "character/c_b.gsc": _character("body_b"),
            "character/c_c.gsc": _character("body_c"),
            "xmodelalias/heads.gsc": HEADS,
        },
    )
    cast = actors.read_cast(raw, ("one", "two"))
    # A spawner half the time, then one of its characters: 1/4, 1/4, 1/2.
    assert cast["bodies"] == [("body_a", 1), ("body_b", 1), ("body_c", 2)]
    # Every character repeats the list, so each head is as likely as the next.
    assert cast["heads"] == [("head_k", 1), ("head_l", 1)]
    assert cast["characters"] == ["c_a", "c_b", "c_c"]
    entry = bo1.actor_entry(actors.ACTORS[0], cast, {}, actors.GAME)
    assert entry["game"] == "t6" and entry["bodyWeights"] == [1, 1, 2] and "headWeights" not in entry
    assert "health" not in entry and "size" not in entry  # numbers live in the bytecode


# -- The state machine ------------------------------------------------------------------


def test_a_state_machine_lists_each_states_clips_and_aliases_without_comments():
    states = actors.read_asd(ASD + "\0trailing bytes")
    assert states["zm_move_walk"] == {
        "flags": ["notify", "move_anim"],
        "clips": [(None, "ai_zombie_walk_v1"), (None, "ai_zombie_walk_v9"), (None, "ai_zombie_walk_v9")],
    }
    assert ("jump_down_72", "ai_zombie_jump_down_72") not in states["zm_traverse"]["clips"]
    assert actors.state_clips(states, "zm_traverse_barrier:barrier_walk") == ["ai_zombie_traverse_v1", "ai_zombie_traverse_v2"]
    with pytest.raises(ValueError):
        actors.state_clips(states, "zm_traverse_barrier:barrier_sprint")
    with pytest.raises(ValueError):
        actors.state_clips(states, "zm_nothing")


def test_the_two_melee_states_are_the_shared_swings_and_each_gaits_own():
    table = {"idle": ("zm_idle",), "walk": ("zm_move_walk",), "windowClimbRun": ("zm_traverse_barrier:barrier_run",)}
    roles = actors.resolve_roles(actors.read_asd(ASD), table)
    assert roles["walk"] == ["ai_zombie_walk_v1", "ai_zombie_walk_v9", "ai_zombie_walk_v9"]  # a repeat is a weight
    assert roles["attack"] == ["ai_zombie_attack_v2"]
    assert roles["walkAttack"] == ["ai_zombie_walk_attack_v1"]
    assert roles["runAttack"] == ["ai_zombie_run_attack_v1"]
    assert roles["windowClimbRun"] == ["ai_zombie_traverse_v5"]


def test_every_engine_role_is_in_the_table():
    """The roles `readActorAssets` reads (docs/engine/actors.md): a missing one falls back silently."""
    assert {"idle", "walk", "run", "sprint", "death", "windowClimb", "windowClimbRun", "windowClimbSprint"} <= set(actors.ROLES)
    assert set(actors.ONCE_ROLES) <= set(actors.ROLES)


def test_a_traverse_script_plays_its_alias_in_the_traverse_state(tmp_path):
    folder = actors.TRAVERSE_DIR
    raw = _dumped(
        tmp_path,
        {
            f"{folder}/zm_jump_down_48.gsc": compiled([("main", [("str", "jump_down_48"), ("call", "dosimpletraverse")])]),
            # Speed decides the suffix at run time; the base alias is pushed last: the walker's.
            f"{folder}/zm_traverse_car.gsc": compiled(
                [("main", [("str", "_run"), ("str", "walk"), ("str", "traverse_car"), ("call", "dosimpletraverse")])]
            ),
            # The window climb is a role, played through `dotraverse` on its own state.
            f"{folder}/zm_mantle_over_40.gsc": compiled(
                [("main", [("str", "zm_traverse_barrier"), ("str", "barrier_walk"), ("call", "dotraverse")])]
            ),
        },
    )
    assert actors.read_traversals(raw, actors.read_asd(ASD)) == {
        "zm_jump_down_48": "ai_zombie_jump_down_48",
        "zm_traverse_car": "ai_zombie_traverse_car",
    }


def test_the_scratch_paths_stay_under_the_cache():
    assert actors.WORK.startswith(os.path.join(bo1.maps.CACHE_DIR, ""))


# -- The retail zone ----------------------------------------------------------------------


@pytest.mark.skipif(not os.path.exists(CLASSIC), reason="Black Ops II zombies is not installed")
def test_transits_walk_is_read_from_the_zone_as_bo1_ships_it():
    """IW5's flat-pool reader over T6's XAnimParts: the pools used up exactly, and BO1's own numbers."""
    from scripts.cod.iw5.dumpers.xanim import raw_clip
    from scripts.cod.t6.backend import Backend
    from scripts.cod.xanim import decode, encode

    walk = Backend("").walk(CLASSIC)
    by_name = {a.name: a for a in walk.by_type("xanim")}
    clip = decode(encode(raw_clip(walk, by_name["ai_zombie_walk_v1"].record)), "ai_zombie_walk_v1")
    assert (clip.frames, clip.fps, clip.looped, clip.asset_type) == (124, 30.0, True, 2)
    # docs/cod/reference.md#ai-bodies-black-ops-zombies: BO1's walk v1 is 0.956 m/s.
    assert bo1.root_motion(clip)["speed"] == pytest.approx(0.956, abs=0.001)
    drop = decode(encode(raw_clip(walk, by_name["ai_zombie_jump_down_190"].record)), "")
    assert bo1.root_path(drop)[-1][3] == pytest.approx(-190 / 39.37, abs=0.05)
