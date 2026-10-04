"""The shared asset catalogue: things that belong to no one map.

A weapon used to live inside whichever world shipped it, which is why a world
held exactly one and why a class could not name a gun that map did not happen to
carry. The catalogue is the other half of that: `catalog/<kind>/<game>/<id>/`,
served by `@3d/api` and fetched by both ends, with `kind` and `game` as path
segments so the same id can exist in two games (`m4` in iw4 and iw5) and so a
whole branch can be listed.

Weapons are the first tenant, not the purpose — vehicles and characters belong
here too, which is why nothing below is weapon-shaped except the weapon builder.

It is built from a game's own companion zone, and from nothing else. A world
used to ship the one weapon it held and the catalogue could be assembled from
those, but a world now *names* its weapon rather than packing it
(viewmodel.py) — so this is where every weapon comes from, and a deployment
with no catalogue built has none.
"""

import glob
import json
import os
import shutil

from . import attachments, aw_cast, backends, composite, materials, sound, t6_catalog, textures, zones
from .animations import absolute_joints
from .fastfile import is_t5
from .files import find_file, read_bytes, read_json, read_text, write_text
from .gltf import read_glb, skin_roots
from .maps import CACHE_DIR, load_maps, require_game
from .materials import classify_materials
from .metadata import zone_listing
from .pack import pack_one
from .t6 import ff as t6_ff
from .textures import texture_index
from .viewmodel import (
    CLIP_ROLES,
    INFO_STRING_PREFIX,
    VIEW_TEXTURE_SIZE,
    _model_glb,
    build_weapon_glb,
    default_hands,
    parse_infostring,
    view_hands,
)
from .xanim import decode

CATALOG_DIR = "catalog"
INDEX_FILE = "index.json"
# The shape of a *weapon entry*, which `@3d/shared/sim/weaponRegistry.ts` reads.
# Bump together — and only for that: a new kind is a new key, which an older
# reader sees as absent rather than as an entry it must learn to skip, so adding
# one costs no version. Both readers refuse the whole catalogue on a mismatch
# (every player unarmed), which is far too blunt for "there is a kind you have
# not heard of".
CATALOG_VERSION = 4

# The kinds `index.json` enumerates, which is the same as the kinds something has
# to be able to *list*: every weapon, for Create-a-Class; every body and pair of
# hands, for a gametype choosing a cast; every creature a script can spawn (actors.py).
#
# Props are deliberately absent, and so are attachments and overlays. A world
# *addresses* those by id through `catalogFilePath`, and nothing enumerates them
# — listing ~6000 props would double a parse both ends do on the main thread at
# boot for bytes no client needs before a world loads.
INDEXED_KINDS = ("weapons", "characters", "viewhands", "animations", "actors")


def entry_dir(root, kind, game, ident):
    """`<root>/catalog/<kind>/<game>/<id>`, the one place a catalogue path is built."""
    return os.path.join(root, CATALOG_DIR, kind, game, ident)


def write_index(root, entries_by_kind):
    """`catalog/index.json`: every indexed entry, one array per kind.

    The index is what both ends fetch at boot; it carries the definitions because
    they are what a weapon is *built* from, and a game server holds one without
    ever loading a model. Kept as one file because it is fetched once and an
    extra request per weapon would cost more than the bytes do.

    One array per kind rather than one flat list of `{kind, ...}`: the top-level
    key *is* the first path segment `entry_dir` builds with, so the index and the
    tree cannot disagree, and each kind stays a homogeneous array that its own
    reader validates whole. `weapons` is always written, even empty, because
    that is the one key every reader of this file requires.
    """
    path = os.path.join(root, CATALOG_DIR, INDEX_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = {"version": CATALOG_VERSION}
    for kind in INDEXED_KINDS:
        entries = entries_by_kind.get(kind, [])
        if entries or kind == "weapons":
            body[kind] = sorted(entries, key=lambda e: e["id"])
    write_text(path, json.dumps(body, indent=1) + "\n")
    return path


# --- Building from a game's own zone ------------------------------------------

# What a weapon is, as the weapon file says. `inventoryType` separates a
# carryable weapon from equipment; `weaponClass` is the only thing that separates
# a loadout's primary from its secondary, and it does so by *our* reading — the
# game's own split lives in its menu files, which this pipeline does not dump.
# See docs/cod/reference.md#weapons.
PRIMARY_CLASSES = ("rifle", "smg", "spread", "mg", "sniper")
# Black Ops II files its Executioner (a revolver firing shot shells) as `pistol spread`.
SECONDARY_CLASSES = ("pistol", "rocketlauncher", "pistol spread")

# A weapon file whose `gunModel` is not a viewmodel is not a gun a player holds:
# the five `camera_*fov` entries in MW3's common zone are debug cameras pointing
# at `weapon_ac130`, and they answer every other test. The IW games spell every
# viewmodel `viewmodel_<gun>`; Black Ops puts the word anywhere
# (`t5_weapon_ak47_viewmodel`, `t5_weapon_viewmodel_m16a1`, `viewmodel_rpg7`).
VIEWMODEL_WORD = "viewmodel"
# Advanced Warfare spells its guns `vm_<gun>_...` (`vm_ak12_loot_base`).
S1_VIEWMODEL_WORD = "vm"
# Black Ops II spells them `t6_wpn_<class>_<gun>_view` (`t6_wpn_ar_an94_view`).
T6_VIEWMODEL = ("t6_", "_view")
PLACEHOLDER_NAME = "WEAPON_DEFAULTWEAPON"

# How a killstreak's own copy of an ordinary weapon is spelled: MW3 gives the
# Juggernaut's four the Juggernaut's kill icon, and Ghosts names every
# killstreak icon `icon_ks_<streak>_hud`. Identical to the weapons they copy bar
# this, so the icon is the only thing that tells them apart — and matched as a
# prefix because Ghosts has six streaks and no field that groups them.
KILLSTREAK_KILL_ICONS = ("death_juggernaut", "icon_ks_", "hud_obit_minigun", "hud_obit_grim")

# Weapons no field distinguishes from one a player picks: MW3's two strike
# markers have a launcher's `inventoryType`, `weaponClass` and `weaponType`, and
# Ghosts' Safeguard pistol is the Magnum with 1000 damage and the ordinary
# Magnum's kill icon. Black Ops' `m220_tow_mp` (and its Wager Match copy) is a launcher
# on the Strela's viewmodel that no class offers. The game's menus know none of them is selectable and its
# menus are not dumped, so this is the one judgement in this file rather than a
# reading of the data — and it is a list rather than a pattern for that reason.
NOT_SELECTABLE = (
    "uav_strike_marker_mp",
    "uav_strike_missile_mp",
    "iw6_magnumhorde_mp",
    "m220_tow_mp",
    "m220_tow_wager_mp",
    *t6_catalog.NOT_SELECTABLE,
)

# The hands skeleton every weapon file names in `handModel`. A companion zone
# ships this and nothing else; the per-team hands are a map zone's.
BASE_VIEWHANDS = "viewmodel_base_viewhands"


def weapon_slot(info):
    """`"primary"`, `"secondary"`, or None for something a player does not carry."""
    if info.get("inventoryType") != "primary":
        return None
    cls = info.get("weaponClass", "")
    if cls in PRIMARY_CLASSES:
        return "primary"
    return "secondary" if cls in SECONDARY_CLASSES else None


def base_weapons(guns):
    """The base weapons out of `{name: info}`, dropping every attachment combination.

    **Modern Warfare 2 ships one weapon file per attachment combination** — 1209
    of them, against Modern Warfare 3's 164, and 1121 of those describe a gun a
    player can carry. `aa12_mp` is the bare AA-12; `aa12_eotech_grip_mp` is the
    same gun with two attachments, its own clip names, its own recoil and its own
    `hideTags`. Catalogued whole they would be 1121 entries where 43 weapons
    exist — and the wire carries a weapon as one byte, so they would not even fit.

    A base is a weapon no shorter weapon's name prefixes: `aa12_eotech_mp` splits
    to `[aa12, eotech]` and `aa12_mp` exists, so it is a variant of it. Entirely a
    reading of the names, but the names are the game's own and the answer it gives
    is exactly MW2's roster.

    The 1078 variants are not waste: diffing one against its base is where an
    attachment's real numbers come from, which is the one thing the catalogue's
    `attachments` still needs. That is not built yet.
    """
    names = set(guns)

    def tokens(name):
        return name[:-3].split("_") if name.endswith("_mp") else name.split("_")

    def is_base(name):
        parts = tokens(name)
        return not any("_".join(parts[:n]) + "_mp" in names for n in range(1, len(parts)))

    return {name: info for name, info in guns.items() if is_base(name)}


def s1_base_weapons(guns):
    """The weapons out of `{name: info}` that are no other's variant, for Advanced Warfare.

    AW spells a variant by running its suffix into the gun's own name rather
    than after an underscore: ten supply-drop `iw5_ak12loot<N>_mp` beside
    `iw5_ak12_mp`, and skins such as `iw5_bal27atlas_mp`. Each differs from its
    base in a handful of balance numbers and its parts, and 30 guns with ten each
    would not fit a one-byte weapon index. A digit after the stem is a different
    gun (`iw5_dlcgun10_mp` is not `iw5_dlcgun1_mp`'s)."""

    def stem(name):
        return name.removesuffix("_mp")

    stems = {stem(n) for n in guns}

    def is_variant(name):
        own = stem(name)
        return any(own != s and own.startswith(s) and not own[len(s)].isdigit() for s in stems)

    return {name: info for name, info in guns.items() if not is_variant(name)}


# AW's weapon files no field separates from a gun a player picks: the Goliath's
# autocannon, punch and MAHEM, the juggernaut's own copies of the Atlas 45 and
# the micro-drone launcher, and the zombie mode's knife. A judgement, as
# NOT_SELECTABLE is, and a list for that reason.
S1_NOT_SELECTABLE = (
    "iw5_exominigun_mp",
    "iw5_mechpunch_mp",
    "killstreakmahem_mp",
    "iw5_juggtitan45_mp",
    "iw5_juggmicrodronelauncher_mp",
    "iw5_zombiemelee_mp",
)

# Where an AW gun's assembled model is written, under an export's `models/`:
# apart from what the zone dumped, since nothing in the zone is this model.
COMPOSED_DIR = "composed"


def s1_compose_guns(work, guns):
    """Assemble each AW gun's viewmodel from its parts, where `_model_glb` finds it.

    An AW `gunModel` is a composite (`vm_ak12_loot_base`): a receiver carrying
    the skeleton, and a barrel, a sight and a stock that each hang from a bone
    of it -- models the per-gun `mp_vm_<gun>_tr.ff` zones hold, which
    `dump_common` dumps beside the companions. The receiver is the part with
    the most joints; composite.py places the rest on it."""
    s1_compose(work, sorted({info.get("gunModel", "") for info in guns.values()}), "gun model")


def s1_compose(work, names, what="model"):
    """Assemble each composite model in `names` from its parts into `models/composed/`."""
    models = os.path.join(work, "models")
    xmodels = os.path.join(models, "xmodel")
    out_dir = os.path.join(models, COMPOSED_DIR)
    os.makedirs(out_dir, exist_ok=True)
    built, missing = 0, []
    for name in names:
        parts = composite.parts_of(xmodels, name)
        if not parts:
            continue
        found = [(part, _model_glb(models, part)) for part in parts]
        absent = [part for part, path in found if path is None]
        if absent:
            missing.append(f"{name} ({', '.join(absent)})")
            continue
        joints = {part: len(skin_roots(read_glb(path)[0])[1]) for part, path in found}
        base = max(found, key=lambda f: joints[f[0]])
        if not joints[base[0]]:
            missing.append(f"{name} (no part carries a skeleton)")
            continue
        rest = [(path, composite.root_bone_of(xmodels, part)) for part, path in found if (part, path) != base]
        try:
            composite.compose(base[1], rest, os.path.join(out_dir, f"{name}_lod0.glb"))
            built += 1
        except ValueError as e:
            missing.append(f"{name} ({e})")
    print(f"  {built} {what}(s) assembled from their parts")
    for why in missing:
        print(f"  !! no parts for {why}")


def s1_absolute_bones(models, hands, hands_raw):
    """The joints an AW view clip keys absolutely: the hands', whose tagPositions are zero.

    Empty means the hands were dumped before the dump said so, and every arm
    would then be read as an offset from its bind -- each forearm doubled."""
    joints = absolute_joints(os.path.join(models, "xmodel"), hands, read_glb(hands_raw)[0])
    if not joints:
        raise SystemExit(f"{hands}'s dump does not say its tagPositions are zero; re-dump the companion zones")
    return joints


def s1_akimbo(info, defs):
    """Whether an AW weapon is only ever held two at a time: the SAC-3 and the XMG, whose akimbo
    is automatic. The engine draws one gun, as for Black Ops' dual wield (`is_player_weapon`)."""
    return any(
        (a := defs.get(name)) and a.get("automaticAttachment") and a.get("displayName") == "WEAPON_AKIMBO_ATTACHMENT"
        for name in attachments.accepted(info)
    )


def s1_without_still_clips(info, clips):
    """`info` less the clip keys whose clip moves no bone: the combat knife's `ads_up` and `ads_down`.
    Such a clip is written as no animation at all, and the engine refuses a role it cannot find."""
    moves = {name.lower(): any(b.rotation or b.translation for b in clip.bones) for name, clip in clips.items()}
    return {k: v for k, v in info.items() if k not in CLIP_ROLES.values() or moves.get(v.strip().lower(), True)}


def is_player_weapon(name, info):
    """Whether this weapon file describes a gun a player can be given."""
    if weapon_slot(info) is None:
        return False
    # A companion zone can be a campaign one too: Black Ops' `common.ff` holds
    # `ak47_sp` beside `common_mp.ff`'s `ak47_mp`.
    if not name.endswith("_mp"):
        return False
    gun = info.get("gunModel", "")
    if not (
        {VIEWMODEL_WORD, S1_VIEWMODEL_WORD} & set(gun.split("_"))
        or (gun.startswith(T6_VIEWMODEL[0]) and gun.endswith(T6_VIEWMODEL[1]))
    ):
        return False
    # Dual wield draws two guns, one per hand, and the engine draws one. Black Ops
    # ships each as a right-hand `<gun>dw_mp` and a left-hand `<gun>lh_mp`, both
    # named `WEAPON_<GUN>_DW`.
    if info.get("displayName", "").endswith("_DW"):
        return False
    # No name at all means nothing shows it to a player: `uav_strike_projectile_mp`
    # is a launcher by every other field and has none.
    display = info.get("displayName", "")
    if not display or display == PLACEHOLDER_NAME:
        return False
    if info.get("killIcon", "").startswith(KILLSTREAK_KILL_ICONS):
        return False
    return name not in NOT_SELECTABLE


def read_index(worlds_root):
    """The catalogue index as it stands on disk, or None."""
    path = os.path.join(worlds_root, CATALOG_DIR, INDEX_FILE)
    return read_json(path) if os.path.exists(path) else None


def _clips_for(info, anim_dir, extra=()):
    """Decode just the clips this weapon can play, out of the zone's view anims.

    `extra` is what its attachments name on top of its own roles: MW2 gives a gun
    with a grip its own idle, reload and sprint, and a GLB without those plays
    nothing the moment one is fitted.
    """
    wanted = {(info.get(key) or "").strip().lower() for key in CLIP_ROLES.values()} - {""}
    wanted |= {name.strip().lower() for name in extra if name.strip()}
    clips = {}
    for name in sorted(os.listdir(anim_dir)) if os.path.isdir(anim_dir) else []:
        if name.lower() in wanted:
            clips[name] = decode(read_bytes(os.path.join(anim_dir, name)), name)
    return clips


def build_one(work, worlds_root, game_key, weapon, info, hands_raw, iwi, states, scratch, fitted=(), absolute_bones=None):
    """One weapon out of a zone dump into the catalogue, or None with a reason.

    The heavy half of an export for a single gun: pack its model's textures, decode
    the clips its roles name, and graft it onto the view-hands skeleton every clip
    is authored against (viewmodel.py does the same for a world's own viewmodel).

    `fitted` is what may be attached to it, already collapsed against this weapon
    by `attachments`. It is finished here, where the rig is: its clip names become
    the zone's own spelling, and a rule for a joint this gun lacks is dropped.
    """
    gun_raw = _model_glb(os.path.join(work, "models"), info["gunModel"])
    if gun_raw is None:
        return None, f"{info['gunModel']} is not in the dump"

    clips = _clips_for(info, os.path.join(work, "view_anim", "xanim"), attachments.wanted_clips(fitted))
    if not clips:
        return None, "none of its clips are in the dump"
    if game_key == "s1":
        info = s1_without_still_clips(info, clips)

    packed = os.path.join(scratch, f"{weapon}.gun.glb")
    _, missing, _ = pack_one(gun_raw, packed, iwi, VIEW_TEXTURE_SIZE, states, False)

    out = entry_dir(worlds_root, "weapons", game_key, weapon)
    os.makedirs(out, exist_ok=True)
    glb = os.path.join(out, f"{weapon}.glb")
    extra = attachments.resolve_clips(fitted, clips)
    try:
        spec, joints, problems = build_weapon_glb(packed, hands_raw, glb, game_key, weapon, info, clips, extra, absolute_bones)
    except ValueError as e:
        # An empty entry folder reads as a weapon with no definition to anything that lists them.
        shutil.rmtree(out, ignore_errors=True)
        return None, str(e)
    finally:
        if os.path.exists(packed):
            os.remove(packed)
    attachments.resolve_mounts(fitted, joints)
    attachments.restrict_bones(fitted, joints)

    entry = {
        "id": weapon,
        "game": game_key,
        # The game's own localisation key. Turning it into words needs the
        # localized strings, which this pipeline does not dump; a UI that wants a
        # name can map it, and until then the id reads well enough.
        "display": info.get("displayName") or weapon,
        "slot": weapon_slot(info),
        "class": info.get("weaponClass", ""),
        "def": spec,
        "attachments": list(fitted),
    }
    write_text(os.path.join(out, f"{weapon}.json"), json.dumps(entry, indent=1) + "\n")
    if missing:
        problems = [*problems, f"{missing} texture(s) not in the dump, drawn white"]
    return (entry, os.path.getsize(glb)), problems


# The scope overlays are drawn at full screen height and carry their reticle in
# the image, so they are kept at native size rather than the props' 512 px.
OVERLAY_SIZE = 1024


def _overlay_images(work, worlds_root, game_key, entries):
    """Write every ADS scope overlay the built entries name into `catalog/overlays/`.

    A weapon file names a *material* (`scope_overlay_us_iw5`), and that material's
    colour map is the image. The material name is kept as the catalogue id
    because it is what the weapon file and the attachment both say; four of them
    cover both games, and five weapons share one, so they are their own catalogue
    entries rather than a copy beside each gun.
    """
    wanted = set()
    for entry in entries:
        wanted.add(entry["def"].get("adsOverlay"))
        for attachment in entry["attachments"]:
            wanted.add((attachment.get("overrides") or {}).get("adsOverlay"))
    wanted.discard(None)
    if not wanted:
        return 0

    mat_root = os.path.join(work, "mat", "materials")
    images, missing = {}, []
    for name in sorted(wanted):
        path = os.path.join(mat_root, materials.material_file_stem(name) + ".json")
        if not os.path.exists(path):
            missing.append(name)
            continue
        colour = next((t.get("image") for t in read_json(path).get("textures") or [] if t.get("name") == "colorMap"), None)
        if colour:
            images[name] = colour
        else:
            missing.append(name)

    written = 0
    for name, image in images.items():
        out = entry_dir(worlds_root, "overlays", game_key, name)
        # `convert_textures` writes <image>.<ext>; the entry is named for the
        # material, so it is renamed to the id a client asks for.
        ok, gone, _ = textures.convert_textures(os.path.join(work, "img"), [image], out, OVERLAY_SIZE, lossless=[image])
        if not ok:
            missing += gone or [image]
            continue
        os.replace(os.path.join(out, f"{image}.png"), os.path.join(out, f"{name}.png"))
        written += 1
    if missing:
        print(f"      !! no image for scope overlay {', '.join(sorted(set(missing)))}; those weapons draw none")
    return written


def _attachment_models(work, worlds_root, game_key, defs, iwi, states):
    """Pack every attachment model the zone offers; return {attachment name: (model id, mount tag)}.

    One packed GLB per *model*, not per attachment: `acog` and `acogsmg` are two
    attachments sharing one `viewmodel_acog`, and two rifles offering the ACOG
    share it again.

    **The mount tag is the model's own root joint.** IW5 names that root for the
    gun tag it belongs on — `viewmodel_acog`'s is `tag_acog_2`, which is a joint
    of every rifle that accepts one — so where an attachment goes is in the data
    rather than in a table here.
    """
    models = os.path.join(work, "models")
    found, packed = {}, {}
    for name, attach in defs.items():
        model = next((m for m in attach.get("viewModels") or [] if m), None)
        if model is None:
            continue  # xmags, rapidfire, akimbo: a change to the numbers and nothing to see
        if model not in packed:
            raw = _model_glb(models, model)
            if raw is None:
                packed[model] = None
            else:
                gltf, _ = read_glb(raw)
                roots, _ = skin_roots(gltf)
                # None for a rigid model, which has no joints to read a mount
                # from; `attachments.resolve_mounts` asks the gun instead.
                tag = gltf["nodes"][roots[0]].get("name") if len(roots) == 1 else None
                out = entry_dir(worlds_root, "attachments", game_key, model)
                os.makedirs(out, exist_ok=True)
                pack_one(raw, os.path.join(out, f"{model}.glb"), iwi, VIEW_TEXTURE_SIZE, states, False)
                packed[model] = (model, tag)
        if packed[model]:
            found[name] = packed[model]
    return found


def _fitted(game_key, weapon, info, guns, defs, models):
    """What may be fitted to one weapon, in slot order, in that weapon's own numbers.

    The two games are read differently and only here: IW5 lists the attachments a
    weapon accepts and describes each once, IW4 lists nothing and ships a whole
    weapon file per combination instead.
    """
    if game_key == "t6":
        entries = attachments.t6_entries(weapon, info, defs, models)
    elif game_key == "s1":
        offered = [
            attachments.s1_entry(name, defs[name], info, *models.get(name, (None, None)))
            for name in attachments.accepted(info)
            if name in defs and not defs[name].get("automaticAttachment")
        ]
        entries = attachments.s1_distinct([entry for entry in offered if attachments.s1_offered(entry)])
    elif defs:
        base = attachments.spec_of(info)
        entries = [
            attachments.iw5_entry(name, defs[name], base, *models.get(name, (None, None)))
            for name in attachments.accepted(info)
            if name in defs
        ]
    else:
        entries = attachments.iw4_entries(weapon, info, guns)
    entries = sorted(entries, key=attachments.sort_key)
    most = attachments.MAX_ATTACHMENT_SLOTS
    if len(entries) > most:
        raise ValueError(f"{game_key}/{weapon} offers {len(entries)} attachments; the wire carries {most}")
    return entries


def player_weapons(work):
    """`{name: info}` for every weapon file in a zone dump that describes a gun a player carries."""
    weapons_dir = os.path.join(work, "weapons", "weapons")
    guns = {}
    for name in sorted(os.listdir(weapons_dir)) if os.path.isdir(weapons_dir) else []:
        text = read_text(os.path.join(weapons_dir, name))
        # Black Ops writes its flamethrower tables here too (`FLAMETABLEFILE`).
        if not text.startswith(INFO_STRING_PREFIX):
            continue
        info = parse_infostring(text)
        if is_player_weapon(name, info):
            guns[name] = info
    return guns


def build_from_zone(work, worlds_root, game_key, states, hands=None):
    """Every player weapon in a zone dump into the catalogue.

    `work` is an export's scratch directory — the one a normal export already
    fills with the common zone's models, images, materials, weapon files and view
    clips. Nothing is dumped here, so this runs against a cache in seconds and
    needs no game install of its own.
    """
    weapons_dir = os.path.join(work, "weapons", "weapons")
    if not os.path.isdir(weapons_dir):
        print(f"  ! no weapon files in {weapons_dir}; run a full export first")
        return []

    models = os.path.join(work, "models")
    # A team's own hands live in a *map* zone, not the companion one — MW2's
    # companion ships only `viewmodel_base_viewhands`, the placeholder every
    # weapon file names in `handModel`. That is all a catalogue needs: the weapon
    # GLB carries the hands' skeleton and no hand meshes, and each world packs its
    # teams' real hands separately and rebinds them by joint name at runtime.
    hands = hands or default_hands(view_hands(os.path.join(models, "xmodel"))) or BASE_VIEWHANDS
    hands_raw = _model_glb(models, hands)
    if hands_raw is None:
        # Every view clip is authored against the hands' skeleton, so without one
        # there is nothing to graft a gun onto and no clip would play.
        print(f"  ! the zone ships no view hands (not even {BASE_VIEWHANDS}), so no weapon can be rigged")
        return []
    print(f"  rigging onto {hands}")
    absolute = s1_absolute_bones(models, hands, hands_raw) if game_key == "s1" else None

    iwi = texture_index(os.path.join(work, "img"))
    scratch = os.path.join(work, "catalog")
    os.makedirs(scratch, exist_ok=True)

    guns = player_weapons(work)
    bases = base_weapons(guns)
    if game_key == "s1":
        bases = {name: info for name, info in s1_base_weapons(bases).items() if name not in S1_NOT_SELECTABLE}
    if len(bases) < len(guns):
        print(
            f"  {len(guns)} player weapon file(s), {len(bases)} base weapon(s), "
            f"{len(guns) - len(bases)} attachment combination(s) left out"
        )

    if game_key == "s1":
        s1_compose_guns(work, bases)

    defs = attachments.t6_read(work) if game_key == "t6" else attachments.read_defs(work)
    # T6's attachment models are not packed: nothing mounts them yet (attachments.t6_entry).
    models = _attachment_models(work, worlds_root, game_key, defs, iwi, states) if defs and game_key != "t6" else {}
    if game_key == "t6":
        print(f"  {len(defs['attachment'])} attachment(s), {len(defs['unique'])} attachment unique(s)")
    elif defs:
        print(f"  {len(defs)} attachment(s), {len({m for m, _ in models.values()})} with a model of their own")

    entries, total, skipped, unproven = [], 0, [], []
    for name, info in bases.items():
        if game_key == "s1":
            if s1_akimbo(info, defs):
                skipped.append((name, "akimbo: always two guns, one a hand, and the engine draws one"))
                continue
            info = attachments.s1_fold_automatic(info, defs)
        if game_key == "t6":
            info = t6_catalog.normalize(info)
        fitted = _fitted(game_key, name, info, guns, defs, models)
        unproven += attachments.check_variants(name, info, guns, fitted)
        built, problems = build_one(work, worlds_root, game_key, name, info, hands_raw, iwi, states, scratch, fitted, absolute)
        if built is None:
            skipped.append((name, problems))
            continue

        entry, size = built
        entries.append(entry)
        total += size
        note = f"  !! {'; '.join(problems)}" if problems else ""
        fits = f"{len(entry['attachments']):2} att" if entry["attachments"] else "      "
        print(f"  + {entry['slot'][:4]} {entry['class']:15} {name:24} {size / 1e6:5.1f} MB {fits}{note}")

    overlays = _overlay_images(work, worlds_root, game_key, entries)
    if overlays:
        print(f"  {overlays} scope overlay image(s)")

    shutil.rmtree(scratch, ignore_errors=True)
    for name, why in skipped:
        print(f"  - {name}: {why}")
    # A game that ships one weapon file per combination has already answered what
    # fitting two attachments does; composing our own deltas has to give the same
    # weapon back. Silent where the game ships no combinations to check against.
    for name, differs in unproven:
        print(f"  !! {name} is not what composing its attachments gives: {', '.join(differs)}")
    print(f"  = {len(entries)} weapon(s) for {game_key}, {total / 1e6:.1f} MB")
    return entries


# --- The sound bank -----------------------------------------------------------

# Where the catalogue keeps sound: `catalog/sounds/<game>/mp/sounds.json`, and
# `clips/` beside it at the game's own paths -- the same two names a world's
# `assets/sounds/` uses, so one reader reads both.
#
# The id is *which bank*, not a made-up entry name: a game has more than one and
# they do not hold the same thing. `mp` is `localized_common_mp.ff`; a campaign
# bank would be `sp` beside it rather than merged into this one.
SOUND_KIND = "sounds"
SOUND_BANK_ID = "mp"
# A maps.json map whose zones are searched for the zombies family (`dump_zombie_sound`).
ZOMBIES_MAP_PREFIXES = ("zm_", "zombie_")


def sound_zones(zone_dirs):
    """(name, path) of the sound bank beside the first zone directory that has one.

    Black Ops has no localized bank zone: `common_mp.ff` carries `mpl_common.all`,
    aliases and PCM together. Black Ops II keeps its bank there too, with the audio
    in the `.sabl`/`.sabs` files beside the zones (t6/sab.py).
    """
    for zone_dir in zone_dirs:
        found = [(n, os.path.join(zone_dir, n)) for n in zones.SOUND_ZONES]
        found = [(n, p) for n, p in found if os.path.exists(p)]
        if found:
            return found
    for zone_dir in zone_dirs:
        found = [(n, os.path.join(zone_dir, n)) for n in zones.T5_SOUND_ZONES]
        found = [(n, p) for n, p in found if os.path.exists(p) and (is_t5(p) or t6_ff.is_fastfile(p))]
        if found:
            return found
    return []


def dump_sound(game, work):
    """Dump the game's sound bank into `work/snd`, and one map zone into `work/snd-map/<map>`.

    **The one documented exception to "a game's companion zone and nothing
    else"**, and it is narrow: sixteen `step_run_plr_*`, `step_sprint_plr_*` and
    `land*` aliases -- the player's own footsteps and landings, which is exactly
    where the first footstep work looks -- are absent from
    `localized_common_mp.ff` and defined by every map zone instead. Built the
    usual way the catalogue would have a hole precisely where it is noticed last.

    The first map zone that carries them is used, and `sound.merge_dumps` then
    proves the two zones agree wherever both define a name rather than trusting
    it. Only the alias families the catalogue asks for by name are taken from it,
    so a map's own ambience stays the map's (docs/cod/audio.md#the-sound-catalogue).
    """
    if game not in GAME_KEYS:
        print(f"  ! {game} has no catalogue")
        return None
    require_game(game)
    games, maps = load_maps()
    zone_dirs = games[game]["zones"]
    banks = sound_zones(zone_dirs)
    if not banks:
        print(f"  ! no sound bank ({', '.join(zones.SOUND_ZONES)}) beside any of {', '.join(zone_dirs)}")
        return None

    backend = backends.for_fastfile(banks[0][1])
    if not backend.dumps("sound"):
        print(f"  ! {backend.name} cannot dump sound aliases yet")
        return None
    for name, ff in banks:
        print(f"  dumping {name} ({backend.name})")
        for kind in ("sound", "loadedsound"):
            backend.dump(ff, os.path.join(work, "snd"), kind)
    # The PCM alone, from the zones that hold some of it and not one alias:
    # `misc/pu_weapon02.wav` (every weapon's pickup) is in common_mp.ff, and
    # `null.wav` -- half a second of silence, at -91 dB, which is how the game
    # spells a variant that plays nothing, and what 1,532 aliases name -- is in
    # the localized code zone. Without them a weapon is picked up in silence and
    # every 404 looks like a broken export.
    for zone_dir in zone_dirs:
        for name in zones.SOUND_PCM_ZONES:
            ff = os.path.join(zone_dir, name)
            if os.path.exists(ff):
                backend.dump(ff, os.path.join(work, "snd"), "loadedsound")

    # Exactly one map zone, so which one is never a question of what a previous
    # run happened to leave behind.
    shutil.rmtree(os.path.join(work, "snd-map"), ignore_errors=True)
    for entry in [m for m in maps if m["game"] == game]:
        candidates = [os.path.join(z, entry["map"] + ".ff") for z in zone_dirs]
        ff = next((p for p in candidates if os.path.exists(p)), None)
        if ff is None:
            continue
        out = os.path.join(work, "snd-map", entry["map"])
        backend.dump(ff, out, "sound")
        if not sound.own_steps(sound.load_dump(os.path.join(out, "sound_aliases"))):
            shutil.rmtree(out, ignore_errors=True)  # a zone with no footsteps in it is not the one
            continue
        print(f"  + {entry['map']} for the player's own footsteps and landings, which the bank has not got")
        backend.dump(ff, out, "loadedsound")
        break
    else:
        print("  ! no map zone of this game defines the player's own footsteps; the catalogue will have none")
    dump_zombie_sound(backend, games[game], [m for m in maps if m["game"] == game], work)
    return work


def dump_zombie_sound(backend, game, maps, work):
    """Dump the first zombies map's zones into `work/snd-zm/<map>`, for the zombies family alone.

    The second documented exception, and as narrow as the first: a zombie's
    vocals, its gibs and the round music are defined by no companion zone. Black
    Ops II's `common_zm.ff` carries a bank with no aliases in it (`zmb_common.all`);
    TranZit's are in `so_zclassic_zm_transit.ff`, one of the zones maps.json names
    beside `zm_transit`. So the map zone and those are dumped, and `build_sounds`
    takes from them only `sound.CATALOG_FAMILIES["zombies"]` and what it layers in.
    """
    shutil.rmtree(os.path.join(work, "snd-zm"), ignore_errors=True)
    for entry in maps:
        if not entry["map"].startswith(ZOMBIES_MAP_PREFIXES):
            continue
        names = [entry["map"] + ".ff", *(entry.get("common") or game.get("common") or [])]
        zone_files = [os.path.join(z, n) for n in names for z in game["zones"][:1]]
        out = os.path.join(work, "snd-zm", entry["map"])
        for ff in [p for p in zone_files if os.path.exists(p)]:
            backend.dump(ff, out, "sound")
        defs = sound.load_dump(os.path.join(out, "sound_aliases"))
        if any(sound.family_of(name) == "zombies" for name in defs):
            print(f"  + {entry['map']} for the zombies' own sounds, which no companion zone defines")
            return
        shutil.rmtree(out, ignore_errors=True)


def build_sounds(work, worlds_root, game_key, search=None):
    """The catalogue's sound bank: the alias table, and every clip it names.

    A closure from named roots rather than the whole bank, which for MW3 is 7,387
    aliases and 161 MB of JSON -- overwhelmingly campaign voiceover and
    battlechatter no multiplayer game ever plays. The roots are the families that
    belong to no one map (`sound.CATALOG_FAMILIES`) and whatever the catalogued
    weapons name; `secondaryAliasName` closes it, as it does for a world.
    """
    alias_root = os.path.join(work, "snd", "sound_aliases")
    if not os.path.isdir(alias_root):
        print(f"  ! no sound dump at {alias_root}; pass --dump <game>")
        return False

    bank = sound.load_dump(alias_root)
    map_dir = next(iter(sorted(glob.glob(os.path.join(work, "snd-map", "*")))), None)
    map_defs = sound.load_dump(os.path.join(map_dir, "sound_aliases")) if map_dir else {}
    defs, shared, conflicts = sound.merge_dumps(bank, map_defs)
    where = os.path.basename(map_dir) if map_dir else "no map zone"
    print(f"  {len(bank)} alias(es) in the bank + {len(map_defs)} from {where}, {len(shared)} defined by both")
    zm_dir = next(iter(sorted(glob.glob(os.path.join(work, "snd-zm", "*")))), None)
    if zm_dir:
        zm_defs = sound.family_closure(sound.load_dump(os.path.join(zm_dir, "sound_aliases")), "zombies")
        defs, zm_shared, zm_conflicts = sound.merge_dumps(defs, zm_defs)
        print(f"  + {len(zm_defs)} zombies alias(es) from {os.path.basename(zm_dir)}, {len(zm_shared)} defined by both")
        conflicts += zm_conflicts
    if conflicts:
        # Not resolved here: two zones meaning different things by one name is a
        # finding about the game's data, and picking one silently is how the
        # catalogue starts shipping one map's sound to every other map.
        print(f"  !! {len(conflicts)} alias(es) DIFFER between the two zones: {', '.join(conflicts[:6])}")

    roots = sound.catalog_roots(defs, player_weapons(work))
    # Black Ops II names a reload's sounds in its clips' notetracks, not its weapon file.
    notes = sound.notetrack_roots([e for e in scan_kind(worlds_root, "weapons") if e.get("game") == game_key], defs)
    roots["weapons"] |= notes - set().union(*roots.values())
    wanted = set().union(*roots.values())
    out = entry_dir(worlds_root, SOUND_KIND, game_key, SOUND_BANK_ID)
    aliases, missing, clips, lost, size_in, size_out = sound.export_from_defs(
        defs,
        wanted,
        out,
        # The zombies zone last: Black Ops keeps a zombie's PCM in that zone
        # (`zmb_common.all`), where Black Ops II's is in the .sab banks instead.
        [os.path.join(work, "snd", "sound"), *(os.path.join(d, "sound") for d in (map_dir, zm_dir) if d)],
        search,
    )
    for group, names in sorted(roots.items()):
        found = {n: defs[n] for n in names if n in defs}
        print(f"  {group:8} {len(names):5} alias(es), {len(sound.clip_sources(found)):4} clip(s)")
    layers = len(aliases) - (len(wanted) - len(missing))
    print(
        f"  = {len(aliases)} alias(es) ({layers} pulled in as layers), {clips} clip(s), "
        f"{size_in / 1e6:.1f} MB in, {size_out / 1e6:.1f} MB out"
    )
    if missing:
        print(
            f"  !! {len(missing)} alias(es) named but in neither zone, silent where they layer: {', '.join(sorted(missing)[:6])}"
        )
    if lost:
        print(f"  !! {len(lost)} clip(s) not found, silent where they are picked: {', '.join(sorted(lost)[:4])}")
    return bool(aliases)


def main(args):
    """`python3 -m scripts.cod catalog`. Returns whether anything was written.

    Takes every player weapon out of a companion-zone dump: `--dump <game>` makes
    one, `--work <dir>` reuses an export's scratch directory. The index is
    rewritten from what is on disk afterwards, so running one game does not drop
    another's. Sound comes out of a *different* zone and is not indexed at all
    (`build_sounds`).
    """
    work, game = args.work, args.game
    if getattr(args, "sounds_only", False):
        return main_sounds(args)
    if args.dump:
        game = GAME_KEYS[args.dump]
        work = work or os.path.join(CACHE_DIR, f"catalog-{args.dump}")
        if dump_common(args.dump, work) is None:
            return False
        dump_sound(args.dump, work)
    if not work:
        print("  ! nothing to build from: pass --dump <game> to dump a companion zone, or --work <dir> to reuse one")
        return False

    if not game:
        listing = find_file(os.path.join(work, "ents"), ".zone")
        if listing is None:
            print(f"  ! {work} has no zone listing to tell its game by: pass --game")
            return False
        game = zone_listing(listing)[0]
    _, _, _, states = classify_materials(os.path.join(work, "mat", "materials"), set(), game)
    entries = build_from_zone(work, args.worlds, game, states, args.hands or (t6_catalog.DEFAULT_HANDS if game == "t6" else None))
    if game == "s1":
        # AW's bodies are costumes no map ships, so the cast is built here, not harvested.
        for problem in aw_cast.build(work, args.worlds, states):
            print(f"  !! {problem}")
    if game == "t6":
        # No map zone ships Black Ops II's hands: the faction zones do (t6_catalog.py).
        t6_catalog.build_hands(work, args.worlds, texture_index(os.path.join(work, "img")), states)
        menu = t6_catalog.read_menu(work)
        for problem in t6_catalog.check_menu(menu, entries, args.worlds) if menu else ["no mp/statstable.csv to check against"]:
            print(f"  !! {problem}")
        print(f"  default class carries {t6_catalog.default_weapon(menu)}")
    build_sounds(work, args.worlds, game, iwd_search(args.dump or GAME_NAMES.get(game)))

    by_kind = scan_entries(args.worlds)
    path = write_index(args.worlds, by_kind)
    counts = ", ".join(f"{len(v)} {k}" for k, v in by_kind.items() if v)
    print(f"  = {counts} in the catalogue -> {os.path.relpath(path, args.worlds)}")
    return bool(by_kind.get("weapons"))


def main_sounds(args):
    """`catalog --sounds-only`: the sound bank alone, from `--dump <game>` or a `--work` that holds one.

    Nothing else is built and the index is not rewritten, because sound is not in
    it: a game whose weapons this pipeline cannot dump yet (Black Ops II) still has
    a bank, and building it touches no other game's entries.
    """
    work = args.work or (os.path.join(CACHE_DIR, f"catalog-{args.dump}") if args.dump else None)
    game = GAME_KEYS[args.dump] if args.dump else args.game
    if not work or not game:
        print("  ! --sounds-only needs --dump <game>, or --work <dir> with --game")
        return False
    if args.dump:
        os.makedirs(work, exist_ok=True)
        if dump_sound(args.dump, work) is None:
            return False
    return build_sounds(work, args.worlds, game, iwd_search(args.dump or GAME_NAMES.get(game)))


def scan_kind(worlds_root, kind):
    """One kind's entries on disk, read back from each entry's own JSON."""
    root = os.path.join(worlds_root, CATALOG_DIR, kind)
    entries = []
    for game in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        game_dir = os.path.join(root, game)
        for ident in sorted(os.listdir(game_dir)) if os.path.isdir(game_dir) else []:
            path = os.path.join(game_dir, ident, f"{ident}.json")
            if os.path.exists(path):
                entries.append(read_json(path))
    return entries


def scan_entries(worlds_root, kinds=INDEXED_KINDS):
    """Every indexed entry on disk, by kind.

    The index is rebuilt from the entries rather than from whatever this run
    produced, so a run that adds one game's weapons drops neither another game's
    nor another kind's.
    """
    return {kind: scan_kind(worlds_root, kind) for kind in kinds}


# Which fastfile game key each games.json game uses. The zone listing would say
# too, but only after a dump — and this picks which zone to dump.
GAME_KEYS = {"mw2": "iw4", "mw3": "iw5", "bo1": "t5", "bo2": "t6", "ghosts": "iw6", "aw": "s1"}
GAME_NAMES = {key: name for name, key in GAME_KEYS.items()}


def iwd_search(game):
    """A game's `;`-joined .iwd search path, where the streamed 41% of its sound lives."""
    games, _ = load_maps()
    return ";".join(games[game]["search"]) if game in games else None


# The games whose zones carry an `attachment` asset at all. IW4 says the same
# thing with a whole weapon file per combination instead (attachments.py), and
# asking an IW4 zone for one is an error rather than an empty dump.
ATTACHMENT_GAMES = ("iw5", "iw6", "s1")
# The zones holding AW's gun viewmodel parts: one or two a gun (`mp_vm_ak12_tr`, `_2_tr`).
S1_VIEW_PARTS = "mp_vm_*_tr.ff"


def dump_common(game, work):
    """Dump a game's companion zone into `work`: the models, images, materials, weapon files and view clips.

    Only the companion zone, not a map — every weapon in a game lives there, so a
    catalogue needs no map at all. That is also why this is its own command
    rather than a stage of an export: exporting a whole map to reach
    `common_mp.ff` would dump a few hundred MB of geometry nothing here reads.

    Which backend reads the zone is the fastfile's own answer, exactly as it is
    for an export (backends.py).
    """
    if game not in GAME_KEYS:
        print(f"  ! {game} has no catalogue")
        return None
    require_game(game)
    games, _ = load_maps()
    zone_dirs = games[game]["zones"]
    search = ";".join(games[game]["search"])
    companions = []
    for zone in zone_dirs:
        companions = zones.companion_zones(zone, games[game].get("common"))
        if companions:
            break
    if not companions:
        print(f"  ! no companion zone ({', '.join(zones.COMMON_ZONES)}) beside any of {', '.join(zone_dirs)}")
        return None

    os.makedirs(work, exist_ok=True)
    backend = backends.for_fastfile(companions[0][1], search)
    for name, ff in companions:
        print(f"  dumping {name} ({backend.name})")
        backend.dump(ff, os.path.join(work, "models"), "xmodel")
        backend.dump(ff, os.path.join(work, "img"), "image")
        backend.dump(ff, os.path.join(work, "mat"), "material")
        backend.dump(ff, os.path.join(work, "weapons"), "weapon")
        if GAME_KEYS[game] in ATTACHMENT_GAMES:
            backend.dump(ff, os.path.join(work, attachments.ATTACH_DIR), "attachment")
        if backend.dumps("xanim"):
            backend.dump(ff, os.path.join(work, "view_anim"), "xanim")
        else:
            print(f"  ! {backend.name} cannot dump view clips yet, and no weapon builds without them")
    if GAME_KEYS[game] == "s1":
        for zone in zone_dirs:
            # Each AW gun's parts, which its composite viewmodel names (s1_compose_guns).
            for ff in sorted(glob.glob(os.path.join(zone, S1_VIEW_PARTS))):
                backend.dump(ff, os.path.join(work, "models"), "xmodel")
        aw_cast.dump(backend, zone_dirs[0], work)
    if GAME_KEYS[game] == "t6":
        t6_catalog.dump(backend, zone_dirs, work)
    return work
