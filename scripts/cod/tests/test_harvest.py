"""Harvesting the cast out of the worlds and into the catalogue.

The two things worth pinning are the ones that silently produce a plausible wrong
result: pairing a body with the wrong head, and shipping one map's clip file as a
game's when it is missing joints a clip animates.
"""

import json
import re

from scripts.cod.gltf import add_view, pack, read_glb, write_glb
from scripts.cod.harvest import (
    CHARACTER_BLOCK,
    Collisions,
    _animated_joints,
    _joint_names,
    harvest_characters,
    harvest_props,
    harvest_viewhands,
    merge_anim_rigs,
    prop_id,
    prune_props,
)

# --- The body/head pairing ----------------------------------------------------


def test_character_block_reads_a_generated_pairing():
    text = """characters {
  animations: "assets/characters/animations.glb"

  character allies {
    body: "assets/characters/mp_body_a.glb"
    head: "assets/characters/head_a.glb"
    weapon: "assets/characters/weapon_m4.glb"
  }
}
"""
    found = [m.groupdict() for m in CHARACTER_BLOCK.finditer(text)]
    assert found == [
        {
            "body": "assets/characters/mp_body_a.glb",
            "head": "assets/characters/head_a.glb",
            "weapon": "assets/characters/weapon_m4.glb",
        }
    ]


def test_character_block_reads_a_body_with_no_head():
    text = 'character x {\n    body: "assets/characters/mp_body_b.glb"\n  }'
    (found,) = [m.groupdict() for m in CHARACTER_BLOCK.finditer(text)]
    assert found["body"].endswith("mp_body_b.glb")
    assert found["head"] is None


def make_world(root, slug, game, characters=(), viewhands=(), weapon="weapon_m4"):
    """A world folder with a characters.world and the GLBs it names (contents are the name)."""
    d = root / slug
    (d / "assets" / "characters").mkdir(parents=True)
    (d / "assets" / "viewmodel").mkdir(parents=True)
    (d / "export_metadata.json").write_text(json.dumps({"game": game}))
    (d / "world.world").write_text('world { name: "W" }')
    lines = ["characters {", '  animations: "assets/characters/animations.glb"']
    for body, head in characters:
        lines += [
            f"  character {body} {{",
            f'    body: "assets/characters/{body}.glb"',
            f'    head: "assets/characters/{head}.glb"',
            f'    weapon: "assets/characters/{weapon}.glb"',
            "  }",
        ]
        (d / "assets" / "characters" / f"{body}.glb").write_text(body)
        (d / "assets" / "characters" / f"{head}.glb").write_text(head)
    lines += ["}"]
    (d / "characters.world").write_text("\n".join(lines))
    (d / "assets" / "characters" / f"{weapon}.glb").write_text(weapon)
    for hands in viewhands:
        (d / "assets" / "viewmodel" / f"{hands}.glb").write_text(hands)
    return d


def test_harvest_characters_keeps_the_declared_pairing(tmp_path):
    # Sorted bodies and sorted heads do not correspond, which is exactly how
    # pairing by position put the wrong face on 4 of the 26 bodies on disk.
    make_world(tmp_path, "x-mw2", "iw4", characters=[("mp_body_zebra", "head_alpha"), ("mp_body_alpha", "head_zebra")])
    entries = harvest_characters(str(tmp_path), Collisions())
    pairs = {e["id"]: e["head"] for e in entries}
    assert pairs == {"mp_body_zebra": "head_alpha.glb", "mp_body_alpha": "head_zebra.glb"}


def test_harvest_characters_records_the_side_and_the_baked_weapon(tmp_path):
    make_world(tmp_path, "x-mw3", "iw5", characters=[("mp_body_delta_assault_a", "head_delta_a")])
    (entry,) = harvest_characters(str(tmp_path), Collisions())
    assert entry["side"] == "allies"
    # Recorded because a peer holds this gun rather than the one their class
    # names, until run-time joint grafting exists.
    assert entry["bakedWeapon"] == "weapon_m4"
    assert entry["game"] == "iw5"


def test_harvest_characters_reads_the_cast_an_export_writes(tmp_path):
    # An export writes `cast.json` beside the GLBs; there is no `characters.world` any more.
    d = make_world(tmp_path, "x-bo1", "t5", characters=[("c_usa_cia_mp_body_standard", "c_usa_cia_mp_head_4")])
    (d / "characters.world").unlink()
    cast = {
        "characters": [
            {
                "side": "allies",
                "body": "assets/characters/c_usa_cia_mp_body_standard.glb",
                "head": "assets/characters/c_usa_cia_mp_head_4.glb",
            }
        ],
        "weapon": "assets/characters/weapon_m4.glb",
    }
    (d / "assets" / "characters" / "cast.json").write_text(json.dumps(cast))
    (entry,) = harvest_characters(str(tmp_path), Collisions())
    assert entry["head"] == "c_usa_cia_mp_head_4.glb"
    assert entry["side"] == "allies"
    assert entry["bakedWeapon"] == "weapon_m4"


def test_harvest_viewhands_takes_black_ops_arms(tmp_path):
    make_world(tmp_path, "x-bo1", "t5", viewhands=["viewmodel_usa_cia_standard_arms", "viewmodel_not_hands"])
    assert [e["id"] for e in harvest_viewhands(str(tmp_path), Collisions())] == ["viewmodel_usa_cia_standard_arms"]


def test_harvest_skips_a_world_with_no_metadata(tmp_path):
    d = make_world(tmp_path, "handmade", "iw5", characters=[("mp_body_a", "head_a")])
    (d / "export_metadata.json").unlink()
    assert harvest_characters(str(tmp_path), Collisions()) == []


def test_harvest_viewhands_takes_every_pair_a_world_packs(tmp_path):
    # A world packs every pair its zone shipped in order to name one; the
    # catalogue gains all of them.
    make_world(tmp_path, "x-mw3", "iw5", viewhands=["viewhands_delta", "viewhands_op_force"])
    ids = sorted(e["id"] for e in harvest_viewhands(str(tmp_path), Collisions()))
    assert ids == ["viewhands_delta", "viewhands_op_force"]


def test_harvest_is_keyed_by_game(tmp_path):
    # `at4_mp` is in both Modern Warfares with different numbers; the same is true
    # of a body name, which is why `game` is a path segment.
    make_world(tmp_path, "a-mw2", "iw4", viewhands=["viewhands_shared"])
    make_world(tmp_path, "b-mw3", "iw5", viewhands=["viewhands_shared"])
    entries = harvest_viewhands(str(tmp_path), Collisions())
    assert sorted(e["game"] for e in entries) == ["iw4", "iw5"]


def test_collisions_keeps_the_first_and_reports_the_rest(tmp_path):
    a, b = tmp_path / "a.glb", tmp_path / "b.glb"
    a.write_text("one")
    b.write_text("two")
    c = Collisions()
    assert c.claim("props", "iw5", "x.glb", str(a), "first") is True
    assert c.claim("props", "iw5", "x.glb", str(b), "second") is False
    assert c.clashes == [("props", "iw5", "x.glb", "first", "second")]


def test_collisions_says_nothing_when_the_bytes_agree(tmp_path):
    a, b = tmp_path / "a.glb", tmp_path / "b.glb"
    a.write_text("same")
    b.write_text("same")
    c = Collisions()
    c.claim("props", "iw5", "x.glb", str(a), "first")
    assert c.claim("props", "iw5", "x.glb", str(b), "second") is False
    # The overwhelmingly common case: 2254 of 2261 shared prop keys.
    assert c.clashes == []


# --- The clip-file merge ------------------------------------------------------


def rig(path, joints, clips):
    """A minimal animations.glb: a joint chain under `tag_origin`, and clips over it.

    `joints` is [(name, parent or None)]; `clips` is {clip: [joint...]} naming which
    joints each clip turns.
    """
    extras = {"characters": {"animType": "autorifle"}}
    gltf = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0], "extras": extras}]}
    nodes, index = [], {}
    for name, parent in joints:
        nodes.append({"name": name, "translation": [0.0, 0.0, 0.0]})
        index[name] = len(nodes) - 1
        if parent is not None:
            nodes[index[parent]].setdefault("children", []).append(index[name])
    gltf["nodes"] = nodes
    gltf["skins"] = [{"joints": list(range(len(nodes)))}]
    buf, views, accessors, animations = bytearray(), [], [], []
    for clip, turned in clips.items():
        channels, samplers = [], []
        for joint in turned:
            t = add_view(buf, views, pack("f", [0.0, 1.0]))
            accessors.append({"bufferView": t, "componentType": 5126, "count": 2, "type": "SCALAR", "min": [0.0], "max": [1.0]})
            v = add_view(buf, views, pack("f", [0.0] * 8))
            accessors.append({"bufferView": v, "componentType": 5126, "count": 2, "type": "VEC4"})
            samplers.append({"input": len(accessors) - 2, "output": len(accessors) - 1, "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": index[joint], "path": "rotation"}})
        animations.append({"name": clip, "channels": channels, "samplers": samplers})
    gltf["bufferViews"], gltf["accessors"], gltf["animations"] = views, accessors, animations
    gltf["buffers"] = [{"byteLength": len(buf)}]
    write_glb(str(path), gltf, buf)
    return str(path)


CHAIN = [("tag_origin", None), ("j_spine", "tag_origin"), ("j_head", "j_spine")]


def test_merge_adds_a_joint_the_base_lacks_and_the_channel_that_turns_it(tmp_path):
    # The real case: one map's bodies wear a gas mask and another's do not, so
    # only one map's clip file has the joints *or* the channels for them.
    base = read_glb(rig(tmp_path / "base.glb", CHAIN, {"pb_stand_alert": ["j_spine"]}))
    donor = read_glb(rig(tmp_path / "donor.glb", [*CHAIN, ("j_gasmask", "j_head")], {"pb_stand_alert": ["j_spine", "j_gasmask"]}))
    added, channels = merge_anim_rigs(base, [donor])
    assert added == ["j_gasmask"]
    assert channels == 1
    gltf, buf = base
    assert "j_gasmask" in _joint_names(gltf)
    assert "j_gasmask" in _animated_joints(gltf)
    # Hung under its own parent, not at the root.
    head = next(i for i, n in enumerate(gltf["nodes"]) if n["name"] == "j_head")
    mask = next(i for i, n in enumerate(gltf["nodes"]) if n["name"] == "j_gasmask")
    assert mask in gltf["nodes"][head]["children"]
    # And it is a joint of the rig, so the skin poses it.
    assert mask in gltf["skins"][0]["joints"]
    assert gltf["buffers"][0]["byteLength"] == len(buf)


def test_merge_leaves_a_joint_both_files_animate_on_the_base(tmp_path):
    # A joint the base already has keeps the base's samples, so two files can
    # never disagree about it.
    base = read_glb(rig(tmp_path / "base.glb", CHAIN, {"pb_stand_alert": ["j_spine"]}))
    donor = read_glb(rig(tmp_path / "donor.glb", CHAIN, {"pb_stand_alert": ["j_spine", "j_head"]}))
    before = len(base[0]["animations"][0]["channels"])
    added, channels = merge_anim_rigs(base, [donor])
    assert added == [] and channels == 0
    assert len(base[0]["animations"][0]["channels"]) == before


def test_merge_writes_a_glb_that_reads_back(tmp_path):
    base = read_glb(rig(tmp_path / "base.glb", CHAIN, {"pb_stand_alert": ["j_spine"]}))
    donor = read_glb(rig(tmp_path / "donor.glb", [*CHAIN, ("j_tail", "j_head")], {"pb_stand_alert": ["j_tail"]}))
    merge_anim_rigs(base, [donor])
    out = tmp_path / "merged.glb"
    write_glb(str(out), base[0], base[1])
    gltf, buf = read_glb(str(out))
    # Every reference still in range after the round trip.
    for a in gltf["accessors"]:
        view = gltf["bufferViews"][a["bufferView"]]
        assert view.get("byteOffset", 0) + view["byteLength"] <= len(buf)
    for anim in gltf["animations"]:
        for c in anim["channels"]:
            assert c["target"]["node"] < len(gltf["nodes"])
            assert anim["samplers"][c["sampler"]]["output"] < len(gltf["accessors"])


def test_merge_ignores_a_donor_joint_whose_parent_is_not_shared(tmp_path):
    # Not a joint of the same skeleton at all: there is nothing to hang it from.
    base = read_glb(rig(tmp_path / "base.glb", CHAIN, {"pb_stand_alert": ["j_spine"]}))
    orphan = [("other_root", None), ("j_thing", "other_root")]
    donor = read_glb(rig(tmp_path / "donor.glb", orphan, {"pb_stand_alert": ["j_thing"]}))
    added, channels = merge_anim_rigs(base, [donor])
    assert added == [] and channels == 0


def test_merge_skips_a_clip_the_base_does_not_have(tmp_path):
    base = read_glb(rig(tmp_path / "base.glb", CHAIN, {"pb_stand_alert": ["j_spine"]}))
    donor = read_glb(rig(tmp_path / "donor.glb", [*CHAIN, ("j_new", "j_head")], {"pb_other": ["j_new"]}))
    added, channels = merge_anim_rigs(base, [donor])
    # The joint arrives; the clip the base never had does not.
    assert added == ["j_new"] and channels == 0
    assert [a["name"] for a in base[0]["animations"]] == ["pb_stand_alert"]


def test_merge_is_byte_reproducible(tmp_path):
    """Two runs must produce the same bytes, or two machines hold different catalogues.

    A set's iteration order is randomised per process, so the donated joints — and
    the accessors and buffer bytes behind them — have to be ordered by something
    stable rather than by whatever the set yields.
    """
    donor_joints = [*CHAIN, ("j_b", "j_head"), ("j_a", "j_head"), ("j_c", "j_spine")]
    out = []
    for run in range(2):
        base = read_glb(rig(tmp_path / f"base{run}.glb", CHAIN, {"pb_stand_alert": ["j_spine"]}))
        donor = read_glb(rig(tmp_path / f"donor{run}.glb", donor_joints, {"pb_stand_alert": ["j_a", "j_b", "j_c"]}))
        merge_anim_rigs(base, [donor])
        path = tmp_path / f"merged{run}.glb"
        write_glb(str(path), base[0], base[1])
        out.append(path.read_bytes())
    assert out[0] == out[1]
    # And the order is the documented one: shallowest first, then by name.
    gltf, _ = read_glb(str(tmp_path / "merged0.glb"))
    added = [n["name"] for n in gltf["nodes"]][len(CHAIN) :]
    assert added == ["j_c", "j_a", "j_b"]


# --- Props --------------------------------------------------------------------


def test_prop_id_folds_a_subdirectory_into_the_segment():
    # A catalogue id is one path segment, and Ghosts ships five props under `mv/`
    # whose basenames collide with top-level ones. Keyed by basename those two
    # silently become one asset.
    assert prop_id("com_barrel_lod0.glb") == "com_barrel_lod0"
    assert prop_id("mv/iw6_rock_lod0.glb") == "mv.iw6_rock_lod0"


def test_prop_id_stays_inside_the_route_allowlist():
    # `catalogSegment` in protocol/routes/catalog.ts: it becomes a path segment on
    # the api, so what it may be is part of the contract.
    segment = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    for rel in ["a_lod0.glb", "mv/a_lod0.glb", "com_table_1._lod0.glb", "p-thing_2.glb"]:
        ident = prop_id(rel)
        assert segment.match(ident), ident
        assert len(ident) <= 64


def props_world(lines):
    return "// GENERATED\n\n" + "\n".join(lines) + "\n\ngroup props {\n}\n"


def make_props_world(root, slug, game, assets):
    """A world with a props.world and the prop files it names. `assets` is {rel: contents}."""
    d = root / slug
    (d / "assets" / "props").mkdir(parents=True)
    (d / "export_metadata.json").write_text(json.dumps({"game": game}))
    (d / "world.world").write_text('world { name: "W" }')
    lines = []
    for rel, contents in assets.items():
        path = d / "assets" / "props" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        name = rel.removesuffix(".glb").replace("/", "_")
        lines.append(f'asset {name} {{ source: "assets/props/{rel}" }}')
    (d / "props.world").write_text(props_world(lines))
    return d


def test_harvest_props_rewrites_a_world_to_name_the_catalogue(tmp_path):
    d = make_props_world(tmp_path, "a-mw3", "iw5", {"com_barrel_lod0.glb": "barrel"})
    counts, kept = harvest_props(str(tmp_path))
    assert counts == {"entries": 1, "rewritten": 1}
    assert kept == []
    text = (d / "props.world").read_text()
    assert 'catalog: "props/iw5/com_barrel_lod0", source: "com_barrel_lod0.glb"' in text
    assert "assets/props/" not in text
    assert (tmp_path / "catalog" / "props" / "iw5" / "com_barrel_lod0" / "com_barrel_lod0.glb").read_text() == "barrel"


def test_harvest_props_keeps_until_and_hull_on_the_line(tmp_path):
    # Per-asset facts, and every world agrees on them — but the resolver is
    # synchronous and has never seen a catalogue, so it could not read them from an
    # entry even though they belong to one.
    d = tmp_path / "a-mw3"
    (d / "assets" / "props").mkdir(parents=True)
    (d / "export_metadata.json").write_text(json.dumps({"game": "iw5"}))
    (d / "world.world").write_text('world { name: "W" }')
    (d / "assets" / "props" / "x_lod0.glb").write_text("x")
    (d / "props.world").write_text(props_world(['asset x { source: "assets/props/x_lod0.glb", until: 38.1, hull: 0 }']))
    harvest_props(str(tmp_path))
    line = next(ln for ln in (d / "props.world").read_text().splitlines() if ln.startswith("asset "))
    assert line == 'asset x { catalog: "props/iw5/x_lod0", source: "x_lod0.glb", until: 38.1, hull: 0 }'


def test_harvest_props_leaves_a_disagreeing_world_pointing_at_its_own_copy(tmp_path):
    # 7 of 2,261 shared keys on disk differ, all because one export carried an
    # animation clip the other did not. A world whose bytes are not the shared bytes
    # keeps its own file rather than being pointed at somebody else's asset.
    first = make_props_world(tmp_path, "a-mw3", "iw5", {"vent_lod0.glb": "with clip"})
    second = make_props_world(tmp_path, "b-mw3", "iw5", {"vent_lod0.glb": "without"})
    counts, kept = harvest_props(str(tmp_path))
    assert counts["rewritten"] == 1
    assert len(kept) == 1 and "b-mw3/vent_lod0.glb" in kept[0]
    assert 'catalog: "props/iw5/vent_lod0"' in (first / "props.world").read_text()
    assert 'source: "assets/props/vent_lod0.glb"' in (second / "props.world").read_text()


def test_harvest_props_keeps_two_games_apart(tmp_path):
    # `727_coach_seat01` is genuinely not the same asset in MW2 and MW3.
    make_props_world(tmp_path, "a-mw2", "iw4", {"seat_lod0.glb": "mw2 seat"})
    make_props_world(tmp_path, "b-mw3", "iw5", {"seat_lod0.glb": "mw3 seat"})
    counts, kept = harvest_props(str(tmp_path))
    assert counts["entries"] == 2 and kept == []
    assert (tmp_path / "catalog/props/iw4/seat_lod0/seat_lod0.glb").read_text() == "mw2 seat"
    assert (tmp_path / "catalog/props/iw5/seat_lod0/seat_lod0.glb").read_text() == "mw3 seat"


def test_harvest_props_separates_a_subdirectory_twin(tmp_path):
    make_props_world(tmp_path, "a-ghosts", "iw6", {"rock_lod0.glb": "top level", "mv/rock_lod0.glb": "the mv one"})
    counts, kept = harvest_props(str(tmp_path))
    assert counts["entries"] == 2 and kept == []
    assert (tmp_path / "catalog/props/iw6/rock_lod0/rock_lod0.glb").read_text() == "top level"
    assert (tmp_path / "catalog/props/iw6/mv.rock_lod0/rock_lod0.glb").read_text() == "the mv one"


def test_prune_deletes_only_what_no_world_names(tmp_path):
    first = make_props_world(tmp_path, "a-mw3", "iw5", {"shared_lod0.glb": "same", "vent_lod0.glb": "with clip"})
    second = make_props_world(tmp_path, "b-mw3", "iw5", {"shared_lod0.glb": "same", "vent_lod0.glb": "without"})
    harvest_props(str(tmp_path))
    freed, kept, trouble = prune_props(str(tmp_path))
    assert trouble == []
    # b-mw3 keeps its own vent, because its props.world still names it.
    assert kept == 1
    assert (second / "assets" / "props" / "vent_lod0.glb").exists()
    assert not (second / "assets" / "props" / "shared_lod0.glb").exists()
    assert not (first / "assets" / "props" / "shared_lod0.glb").exists()
    assert freed > 0


def test_prune_never_deletes_what_the_catalogue_cannot_give_back(tmp_path):
    # `worlds/*/assets/` is gitignored and rebuilding it needs the game files, so a
    # file whose bytes are not in the catalogue is left alone and reported.
    d = make_props_world(tmp_path, "a-mw3", "iw5", {"x_lod0.glb": "original"})
    harvest_props(str(tmp_path))
    (tmp_path / "catalog/props/iw5/x_lod0/x_lod0.glb").write_text("tampered")
    # The world now points at the catalogue, so nothing names the local file — and
    # it still must not go, because the catalogue's copy is not it.
    freed, _, trouble = prune_props(str(tmp_path))
    assert freed == 0
    assert len(trouble) == 1 and "not in the catalogue byte-for-byte" in trouble[0]
    assert (d / "assets" / "props" / "x_lod0.glb").exists()
