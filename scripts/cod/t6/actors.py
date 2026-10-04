"""Black Ops II's zombies as catalogue actors: TranZit's walkers, their clips and their boxes.

The shape is BO1's (scripts/cod/actors.py): an actor entry of bodies, heads and
weights, a clip set of roles, and one hitbox sidecar. Two sources differ.

**Who a zombie is** comes from the same three scripts deep, `aitype/` →
`character/` → `xmodelalias/`, but compiled: `t6/gsc.py` reads which character each
aitype calls, which model a character hands `setmodel`, and which alias list it
takes its head from. TranZit spawns from three spawners, `actor_zm_transit_basic_01`
to `_03`, picked uniformly (`random(level.zombie_spawners)`), and each aitype picks
among its characters. One entry holds all three, weighted as the game picks.

**Which clip is what** is not in a script at all. T6 drives its AI with an animation
state machine whose definition is a text rawfile, `animstatedefs/<name>.asd`: each
state lists its clips, some keyed by an alias the script asks for
(`zm_traverse_barrier` → `barrier_walk`). The roles are read out of that
(`ROLES`), and a traversal's clip out of the traverse script's own alias
(`zm_jump_down_48.gsc` → `dosimpletraverse("jump_down_48")` → `zm_traverse`).
docs/cod/pipeline.md#actors has the table; docs/cod/reference.md the numbers.
"""

import os
import re
from collections import Counter
from dataclasses import dataclass
from fractions import Fraction
from functools import reduce
from math import gcd, lcm

from .. import actors, catalog, hitboxes, maps
from ..backends import for_fastfile
from ..files import read_bytes, read_text, write_text
from ..materials import classify_materials
from ..textures import texture_index
from ..xanim import decode
from .gsc import Script, strings_before

GAME = "t6"
MAPS_GAME = "bo2"  # games.json's key for the install
WORK = os.path.join(maps.CACHE_DIR, "actors-bo2")
ASD_DIR = "animstatedefs"
TRAVERSE_DIR = "maps/mp/animscripts/traverse"


@dataclass(frozen=True)
class ActorSource:
    """One catalogue actor: the aitypes a map's spawners name, in which zone, and the state machine they run."""

    id: str
    kind: str
    zone: str  # the mode zone holding the spawners' aitypes, characters, models, clips and the .asd
    aitype: tuple  # every `aitype/<name>.gsc` the map's zombie spawners name; one is picked uniformly
    clips: str  # the clip set, `animations/t6/<clips>/`
    asd: str  # `animstatedefs/<asd>.asd`
    scripts: tuple = ()  # zones holding the traverse scripts, after `zone`


# TranZit's classic mode: its zone's three `zombie_spawner`s (reverse/t6-zombies § 2).
# The survival and grief zones add `_05`, `_08`, `_09` (other bodies, same machine).
ACTORS = (
    ActorSource(
        "zm_transit_basic",
        "zombie",
        "so_zclassic_zm_transit",
        ("zm_transit_basic_01", "zm_transit_basic_02", "zm_transit_basic_03"),
        "zombie",
        "zm_transit_basic",
        ("zm_transit_patch",),
    ),
)

# Each role, as the states (and `state:alias`) of the .asd it lists, in order.
# `attack` is what both melee states share; `walkAttack` and `runAttack` what each
# adds, so the engine's `attack + walkAttack` is exactly `zm_walk_melee`
# (`swings`, docs/engine/actors.md#melee).
ROLES = {
    "idle": ("zm_idle",),
    "walk": ("zm_move_walk",),
    "run": ("zm_move_run",),
    "sprint": ("zm_move_sprint",),
    "superSprint": ("zm_move_super_sprint",),
    "death": ("zm_death",),
    "windowClimb": ("zm_traverse_barrier:barrier_walk",),
    "windowClimbRun": ("zm_traverse_barrier:barrier_run",),
    "windowClimbSprint": ("zm_traverse_barrier:barrier_sprint",),
    # Out of the ground: one state, the variant picked by speed in script (not readable).
    "rise": ("zm_rise",),
    # A legless zombie's: `missing_legs` states. Nothing plays them yet.
    "crawlIdle": ("zm_idle_crawl",),
    "crawl": ("zm_move_walk_crawl",),
    "crawlSprint": ("zm_move_sprint_crawl",),
    "crawlAttack": ("zm_walk_melee_crawl",),
    "crawlDeath": ("zm_death_crawl",),
    "crawlWindowClimb": ("zm_traverse_barrier_crawl:barrier_crawl",),
}
MELEE = ("zm_walk_melee", "zm_run_melee")  # split into attack, walkAttack, runAttack
ONCE_ROLES = ("crawlAttack", "crawlDeath", "crawlWindowClimb")
TRAVERSE_STATE = "zm_traverse"
TRAVERSE_CALL = "dosimpletraverse"


# -- The animation state machine -----------------------------------------------------

_STATE = re.compile(r"^(\w+)\s*:([^\n{]*)\n\s*\{(.*?)\}", re.S | re.M)


def read_asd(text):
    """{state: {"flags": [..], "clips": [(alias or None, clip), ...]}} of one .asd, in its order.

    A line is a clip, or an alias and a clip; `//` starts a comment. Clip names are
    lower-cased, as the zone's are.
    """
    text = text.split("\0", 1)[0]
    states = {}
    for m in _STATE.finditer(actors.strip_comments(text)):
        clips = []
        for line in m.group(3).splitlines():
            words = line.split()
            if len(words) == 1:
                clips.append((None, words[0].lower()))
            elif len(words) == 2:
                clips.append((words[0], words[1].lower()))
            elif words:
                raise ValueError(f"{m.group(1)}: cannot read {line.strip()!r}")
        states[m.group(1)] = {"flags": m.group(2).split(), "clips": clips}
    return states


def state_clips(states, ref):
    """The clips `state` or `state:alias` lists, in order, repeats kept. Raises on one that names nothing."""
    state, _, alias = ref.partition(":")
    if state not in states:
        raise ValueError(f"{ref}: no such state")
    clips = [c for a, c in states[state]["clips"] if not alias or a == alias]
    if not clips:
        raise ValueError(f"{ref} names no clip")
    return clips


def split_swings(walk, run):
    """(shared, walk's own, run's own): each melee state is the shared swings plus its gait's."""
    run_set, walk_set = set(run), set(walk)
    return [c for c in walk if c in run_set], [c for c in walk if c not in run_set], [c for c in run if c not in walk_set]


def resolve_roles(states, table=ROLES):
    roles = {role: [c for ref in refs for c in state_clips(states, ref)] for role, refs in table.items()}
    roles["attack"], roles["walkAttack"], roles["runAttack"] = split_swings(*(state_clips(states, s) for s in MELEE))
    return roles


# -- The compiled AI scripts ---------------------------------------------------------


def _script(raw, rel):
    path = os.path.join(raw, rel)
    if not os.path.exists(path):
        raise ValueError(f"{rel} was not dumped")
    return Script(read_bytes(path), rel)


def _calls(script, function, prefix):
    return [e.text[len(prefix) : -len("::main")] for e in script.of(function) if e.kind == "call" and e.text.startswith(prefix)]


def read_aitype(script):
    """The characters an aitype's `main` calls, once each: `get_random_character` picks among them uniformly."""
    return _calls(script, "main", "character/")


def read_character(script):
    """{"body": model, "head": alias list or None, "gibs": {field: [model]}} of one character's `main`.

    The body is the string handed to `setmodel`; the head the alias list whose
    `main` is called before `randomelement`. A gib is `self.<field> = "<model>"`,
    which pushes the model before the field's name [inferred order].
    """
    events = script.of("main")
    body = head = None
    for i, e in enumerate(events):
        if e.kind != "call":
            continue
        if e.text == "setmodel" and body is None:
            body = (strings_before(events, i) or [None])[-1]
        elif e.text.startswith("xmodelalias/") and e.text.endswith("::main"):
            head = e.text[len("xmodelalias/") : -len("::main")]
    strings = [e.text for e in events if e.kind == "str"]
    gibs = {}
    for value, field in zip(strings, strings[1:], strict=False):
        if actors.GIB_FIELD.match(_gib_field(field)):
            gibs[_gib_field(field)] = [value]
    if body is None:
        raise ValueError(f"{script.path}: no setmodel")
    return {"body": body, "head": head, "gibs": gibs}


def _gib_field(field):
    """T6's field names are lower case (`torsodmg1`); BO1's entry spells them `torsoDmg1`."""
    return field.replace("dmg", "Dmg").replace("spawn", "Spawn")


def read_alias(script):
    """The models an `xmodelalias/` list names, in order, repeats kept. `a` is the list itself."""
    return [e.text for e in script.of("main") if e.kind == "str" and e.text != "a"]


def _integers(weights):
    """Fractions -> the smallest integers in the same proportions."""
    scale = reduce(lcm, (w.denominator for w in weights), 1)
    ints = [int(w * scale) for w in weights]
    common = reduce(gcd, ints)
    return [i // common for i in ints]


def read_cast(raw, aitypes):
    """How the game dresses a spawner set: bodies and heads with weights, and the gibs. BO1's cast shape.

    A spawner is picked uniformly, then one of its aitype's characters, so a body's
    weight is the sum over characters of 1 / aitypes / characters.
    """
    body_weight, heads, gibs, characters = {}, [], {}, []
    for aitype in aitypes:
        names = read_aitype(_script(raw, f"aitype/{aitype}.gsc"))
        if not names:
            raise ValueError(f"aitype/{aitype}.gsc names no character")
        for name in names:
            character = read_character(_script(raw, f"character/{name}.gsc"))
            share = Fraction(1, len(aitypes) * len(names))
            body_weight[character["body"]] = body_weight.get(character["body"], 0) + share
            if character["head"]:
                heads += read_alias(_script(raw, f"xmodelalias/{character['head']}.gsc"))
            for field, models in character["gibs"].items():
                gibs[field] = sorted(set(gibs.get(field, [])) | set(models))
            characters.append(name)
    bodies = list(body_weight)
    # Every character here takes its head from the same list; the heads are then independent of the body.
    return {
        "characters": sorted(set(characters)),
        "bodies": list(zip(bodies, _integers([body_weight[b] for b in bodies]), strict=True)),
        "heads": _weighted(heads),
        "gibs": gibs,
        "health": None,  # a number in the bytecode; the round sets it anyway (mp/zombiemode.csv)
        "bounds": None,
    }


def _weighted(names):
    """[(name, weight)] in first-seen order, in the smallest integers: each character repeats its list."""
    counts = Counter(names)
    return list(zip(counts, _integers([Fraction(n) for n in counts.values()]), strict=True))


def read_traversals(raw, states):
    """{animscript: clip}: each traverse script's alias in the `zm_traverse` state, for a zombie with legs.

    A script is `main() { dosimpletraverse("<alias>"); }` (a crawler's alias gets
    `_crawl` appended inside it). One that computes its alias from the zombie's speed
    (`zm_traverse_car`) pushes the base alias last, which is the walker's.
    """
    folder = os.path.join(raw, TRAVERSE_DIR)
    table = {a: c for a, c in states[TRAVERSE_STATE]["clips"] if a}
    out = {}
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if not name.endswith(".gsc"):
            continue
        script = Script(read_bytes(os.path.join(folder, name)), name)
        events = script.of("main")
        at = next((i for i, e in enumerate(events) if e.kind == "call" and e.text == TRAVERSE_CALL), None)
        if at is None:
            continue  # the window climb (`dotraverse` on zm_traverse_barrier) is a role instead
        alias = (strings_before(events, at) or [None])[-1]
        if alias not in table:
            raise ValueError(f"{name}: alias {alias!r} is not in {TRAVERSE_STATE}")
        out[name[:-4]] = table[alias]
    return out


# -- Building ------------------------------------------------------------------------


def build(work, worlds_root, sources=ACTORS):
    """Every actor in `sources` and the clip sets they play. Returns [problems]."""
    raw = os.path.join(work, "raw")
    anim_dir = os.path.join(work, "anim", "xanim")
    _, _, _, states = classify_materials(os.path.join(work, "mat", "materials"), set(), GAME)
    iwi = texture_index(os.path.join(work, "img"))
    problems = []
    by_set = {}
    built = []
    for source in sources:
        machine = read_asd(read_text(os.path.join(raw, ASD_DIR, f"{source.asd}.asd")))
        roles = resolve_roles(machine)
        traversals = read_traversals(raw, machine)
        cast = read_cast(raw, source.aitype)
        cast, specs, trouble = actors.build_actor(source, work, worlds_root, states, iwi, cast, GAME)
        problems += trouble
        known = by_set.setdefault(source.clips, (roles, traversals, []))
        if known[0] != roles or known[1] != traversals:
            raise ValueError(f"clip set {source.clips}: {source.id}'s machine differs from another actor's")
        known[2].extend(specs)
        built.append((source, actors.actor_entry(source, cast, {}, GAME)))

    for ident, (roles, traversals, specs) in sorted(by_set.items()):
        needed = {c for clips in roles.values() for c in clips} | set(traversals.values())
        absent = sorted(n for n in needed if not os.path.exists(os.path.join(anim_dir, n)))
        if absent:
            raise ValueError(f"clip set {ident}: {', '.join(absent)} not in the dump")
        clips = {name: decode(read_bytes(os.path.join(anim_dir, name)), name) for name in sorted(needed)}
        out = catalog.entry_dir(worlds_root, actors.ANIM_KIND, GAME, ident)
        os.makedirs(out, exist_ok=True)
        problems += actors.write_clip_glb(os.path.join(out, actors.ANIM_FILE), specs, clips)
        joints = len({name for spec in specs for name, _, _ in spec})
        entry = actors.clip_set_entry(ident, roles, clips, joints, traversals, GAME)
        entry["onceRoles"] += [r for r in ONCE_ROLES if r in roles]
        actors._write_json(os.path.join(out, f"{ident}.json"), entry)
        print(f"  + {actors.ANIM_KIND}/{GAME}/{ident}: {len(roles)} role(s) over {len(clips)} clip(s), {joints} joints")

    for source, entry in built:
        out = catalog.entry_dir(worlds_root, actors.KIND, GAME, source.id)
        actors._write_json(os.path.join(out, f"{source.id}.json"), entry)
        if hitboxes.write_entry(out, source.id, entry["bodies"] + entry["heads"]) is None:
            problems.append(f"{source.id}: no skin, so no hitboxes")
    return problems


def zone_folder():
    return maps.require_game(MAPS_GAME)["zones"][0]


def dump(sources, work, zone_dir=None):
    """Dump what the stage reads into `work`; a zone and kind already dumped there is skipped.

    Everything is in the mode zone — the aitypes, characters, alias lists, models,
    materials, the .asd and every clip it names — except the traverse scripts,
    which are the map's patch zone's. Images come from the `.ipak` packs beside it.
    """
    zone_dir = zone_dir or zone_folder()

    def ff(name):
        return os.path.join(zone_dir, f"{name}.ff")

    plan = []
    for source in sources:
        zone = ff(source.zone)
        plan += [(zone, "raw", "rawfile"), (zone, "raw", "script"), (zone, "models", "xmodel")]
        plan += [(zone, "anim", "xanim"), (zone, "img", "image"), (zone, "mat", "material")]
        plan += [(ff(z), "raw", "script") for z in source.scripts]
    done_path = os.path.join(work, ".dumped")
    done = set(read_text(done_path).split()) if os.path.exists(done_path) else set()
    os.makedirs(work, exist_ok=True)
    backend = None
    for path, sub, kind in plan:
        key = f"{os.path.basename(path)}:{kind}"
        if key in done:
            continue
        if not os.path.exists(path):
            raise SystemExit(f"{path} is not installed")
        backend = backend or for_fastfile(path, "")
        print(f"  dumping {os.path.basename(path)} {kind}")
        backend.dump(path, os.path.join(work, sub), kind)
        done.add(key)
        write_text(done_path, "\n".join(sorted(done)) + "\n")
    return work


def main(args):
    """`python3 -m scripts.cod actors --game bo2`: dump, build, and return [problems]."""
    work = (args.work if args.game else None) or WORK  # --work is one game's
    if not args.no_dump:
        dump(ACTORS, work)
    return build(work, args.worlds)
