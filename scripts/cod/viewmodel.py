"""First-person viewmodels: a weapon's gun and clips, and the map's view hands.

The weapon file (OAT's WEAPONFILE infostring) names the gun model and one clip
per role. The gun's root joint `j_gun` hangs from the hands' `tag_weapon`, and
one clip drives both skeletons. So the weapon GLB carries the hands' skeleton
(joints only) with the gun grafted on, every clip the weapon plays, and the
weapon's definition in the scene's extras; each view-hands model is packed on
its own and rebound to that skeleton by joint name at runtime
(src/scene/viewmodel.ts). The data: docs/cod/reference.md#viewmodels.

**A world packs hands, not weapons.** `build_weapon_glb` below is the catalogue's
(catalog.py): a weapon is one file every map that names it shares, and
a gametype names it by catalogue id. A map's own export writes only its
view hands, which are the one half no two maps share.
"""

import os

from . import cac
from .animations import TRANSLATION_BY_ASSET_TYPE, clip_to_gltf
from .files import read_json, read_text
from .gltf import joint_subtree, read_glb, skin_roots, write_glb
from .pack import pack_one
from .textures import texture_index

# The weapon each game's worlds hold by default; `_overrides.json` "viewmodel" picks another.
# Black Ops' is the M16, what its first default class carries.
DEFAULT_WEAPON = {"iw4": "m4_mp", "iw5": "iw5_m4_mp", "iw6": "iw6_ak12_mp", "t5": "m16_mp"}


def weapon_key(game, name):
    """A weapon's catalogue id, `<game>/<name>`. The Python half of `weaponKey` in weaponRegistry.ts.

    A name alone is not unique — both Modern Warfares ship an `at4_mp` — so this
    is what a world file, a loadout and the wire all say. Spelled here rather
    than inline anywhere because the two halves are easy to write round the
    wrong way and `iw5/iw5_m4_mp` reads like a mistake until you know it is not.
    """
    return f"{game}/{name}"


# View-hands models that are not a team's everyday pair; a default avoids them.
# Ghosts' `viewhands_gs_hostage` is a hostage's, and sorts before every pair a
# player wears, so leaving it in would make it the default on every Ghosts map.
SPECIAL_HANDS = ("ghillie", "sniper", "juggernaut", "hostage")
OUT_DIR = "viewmodel"  # under the world's assets/
VIEW_TEXTURE_SIZE = 1024
FORMAT_VERSION = 5  # of the `viewmodel` scene extras, read by @3d/shared/sim/weaponDef.ts

# Role -> the weapon-file key naming its clip. Melee (the knife is its own model)
# and akimbo (the left hand's clips) are not exported yet.
CLIP_ROLES = {
    "idle": "idleAnim",
    "emptyIdle": "emptyIdleAnim",
    "fire": "fireAnim",
    "lastShot": "lastShotAnim",
    "reload": "reloadAnim",
    "reloadEmpty": "reloadEmptyAnim",
    "raise": "raiseAnim",
    "firstRaise": "firstRaiseAnim",
    "drop": "dropAnim",
    "quickRaise": "quickRaiseAnim",
    "quickDrop": "quickDropAnim",
    "sprintIn": "sprintInAnim",
    "sprintLoop": "sprintLoopAnim",
    "sprintOut": "sprintOutAnim",
    "adsFire": "adsFireAnim",
    "adsLastShot": "adsLastShotAnim",
    "adsUp": "adsUpAnim",
    "adsDown": "adsDownAnim",
    "rechamber": "rechamberAnim",
    "adsRechamber": "adsRechamberAnim",
    "reloadStart": "reloadStartAnim",
    "reloadEnd": "reloadEndAnim",
}
# What a round takes off, and how far it carries. `damage` **is** the maximum —
# there is no `maxDamage` key — and it is the player-versus-player number: MW2's
# M4 is 30 falling to 20, which is that game's published figure. `playerDamage`
# and `minPlayerDamage` are what an AI's copy of the weapon does to the player
# and are deliberately not here; on MW2 they are 100/30 whatever the gun is.
DAMAGE = {
    "max": "damage",
    "min": "minDamage",
    # Both in CoD units (`units.UNITS_PER_M`), as every distance in the
    # catalogue is: full damage within `maxRange`, `min` past `minRange`, and
    # interpolated between the two.
    "maxRange": "maxDamageRange",
    "minRange": "minDamageRange",
    "melee": "meleeDamage",
}
# The cone a shot leaves in, in degrees. Hip spread grows by `fireAdd` a shot and
# by `moveAdd` while moving, and decays at `decayRate` a second toward the stance's
# minimum; `ads` is a fixed cone instead, and is 0 on everything that is not a shotgun.
#
# `hipStandMax` is the one key with no stance in its name: the standing maximum
# is spelled `hipSpreadMax` while the ducked and prone ones keep theirs. The
# struct member is `fHipSpreadStandMax`, so reading the struct gives a key no
# weapon file has.
SPREAD = {
    "ads": "adsSpread",
    "hipStandMin": "hipSpreadStandMin",
    "hipStandMax": "hipSpreadMax",
    "hipDuckedMin": "hipSpreadDuckedMin",
    "hipDuckedMax": "hipSpreadDuckedMax",
    "hipProneMin": "hipSpreadProneMin",
    "hipProneMax": "hipSpreadProneMax",
    "fireAdd": "hipSpreadFireAdd",
    "turnAdd": "hipSpreadTurnAdd",
    "moveAdd": "hipSpreadMoveAdd",
    "decayRate": "hipSpreadDecayRate",
    "duckedDecay": "hipSpreadDuckedDecay",
    "proneDecay": "hipSpreadProneDecay",
}
# The damage multiplier per hit location, keyed by the engine's name for it.
#
# The order is `HIT_LOCATIONS` in `@3d/shared/sim/hitLocations.ts`, which a test
# checks: the engine classifies a bone to one of those names and looks the
# multiplier up by it, so a name in one list and not the other is a location
# whose multiplier nothing ever finds. A key is all three games have in common:
# IW6's own list is twenty-two and interleaves left with right, so its dumper
# writes each multiplier under the name standing at its index and never by
# position (docs/cod/reference.md#iw6s-hit-locations-are-not-iw5s).
LOCATIONS = {
    "none": "locNone",
    "helmet": "locHelmet",
    "head": "locHead",
    "neck": "locNeck",
    "torsoUpper": "locTorsoUpper",
    "torsoLower": "locTorsoLower",
    "rightArmUpper": "locRightArmUpper",
    "rightArmLower": "locRightArmLower",
    "rightHand": "locRightHand",
    "leftArmUpper": "locLeftArmUpper",
    "leftArmLower": "locLeftArmLower",
    "leftHand": "locLeftHand",
    "rightLegUpper": "locRightLegUpper",
    "rightLegLower": "locRightLegLower",
    "rightFoot": "locRightFoot",
    "leftLegUpper": "locLeftLegUpper",
    "leftLegLower": "locLeftLegLower",
    "leftFoot": "locLeftFoot",
    "gun": "locGun",
}
# Every weapon-file key stages 8 and 9 cannot do without, which is what a backend
# that writes only part of a weapon file has to carry for them to run at all
# (`Backend.writes`, scripts/cod/backends.py). The times and the motion
# parameters are deliberately not here: each is optional key by key, and a game
# whose own struct has no member for one leaves it out rather than lying about it.
# The damage, the spread and the locations are, because a weapon missing one of
# those is not a weapon read in part — it is a gun that does nothing, or one
# whose head shot is a body shot, silently.
WEAPON_KEYS = (
    "displayName",
    "gunModel",
    "handModel",
    "worldModel",
    "playerAnimType",
    "weaponClass",
    "inventoryType",
    "killIcon",
    "hideTags",
    "clipSize",
    "fireType",
    "boltAction",
    "segmentedReload",
    "reloadAmmoAdd",
    "adsOverlayShader",
    "adsZoomFov",
    "shotCount",
    "weaponType",
    "penetrateType",
    *CLIP_ROLES.values(),
    *DAMAGE.values(),
    *SPREAD.values(),
    *LOCATIONS.values(),
)
# How long each state lasts in the game, in seconds. The clips run longer or
# shorter (a 1.1 s pullout in a 0.75 s raise), so the engine times states by these.
TIMES = {
    "fire": "fireTime",
    "fireInterruptible": "fireInterruptableTime",
    "rechamber": "rechamberTime",
    "reload": "reloadTime",
    "reloadEmpty": "reloadEmptyTime",
    "reloadAdd": "reloadAddTime",
    "reloadStart": "reloadStartTime",
    "reloadStartAdd": "reloadStartAddTime",
    "reloadEnd": "reloadEndTime",
    "raise": "raiseTime",
    "firstRaise": "firstRaiseTime",
    "drop": "dropTime",
    "quickRaise": "quickRaiseTime",
    "quickDrop": "quickDropTime",
    "sprintIn": "sprintInTime",
    "sprintLoop": "sprintLoopTime",
    "sprintOut": "sprintOutTime",
    "adsIn": "adsTransInTime",
    "adsOut": "adsTransOutTime",
    "adsReloadOut": "adsReloadTransTime",
}
# The procedural motion's parameters, copied as numbers under the game's own
# names. A verbatim tuple rather than a rename map like `DAMAGE` and `SPREAD`,
# because the engine has no other name for any of these: `@3d/shared/sim/recoil.ts`
# reads them back by spelling the key (`mix`, `between`), so a rename here would
# have to be undone there.
#
# **Two recoil families, and only one of them is the aim.** `*GunKick*` rocks the
# weapon *model* in the player's hands and is a drawing effect; `*ViewKick*` punches
# the player's aim off target and recentres it at `ViewKickCenterSpeed`, which is
# the recoil a player fights and what a shot's direction is bent by. They are not
# interchangeable and a weapon can carry one without the other — every scoped
# sniper in MW3 has `adsGunKickPitchMin`/`Max` of exactly 0 and does all of its
# recoil through `adsViewKick*`, so a build exporting only the gun kick gives a
# scoped sniper no recoil at all (docs/cod/reference.md#the-two-recoils).
MOTION = (
    "hipIdleAmount",
    "hipIdleSpeed",
    "adsIdleAmount",
    "adsIdleSpeed",
    "swayMaxAngle",
    "swayLerpSpeed",
    "swayPitchScale",
    "swayYawScale",
    "swayHorizScale",
    "swayVertScale",
    "adsSwayMaxAngle",
    "adsSwayLerpSpeed",
    "adsSwayPitchScale",
    "adsSwayYawScale",
    "adsSwayHorizScale",
    "adsSwayVertScale",
    "adsViewBobMult",
    "hipGunKickPitchMin",
    "hipGunKickPitchMax",
    "hipGunKickYawMin",
    "hipGunKickYawMax",
    "hipGunKickAccel",
    "hipGunKickSpeedMax",
    "hipGunKickSpeedDecay",
    "hipGunKickStaticDecay",
    "adsGunKickPitchMin",
    "adsGunKickPitchMax",
    "adsGunKickYawMin",
    "adsGunKickYawMax",
    "adsGunKickAccel",
    "adsGunKickSpeedMax",
    "adsGunKickSpeedDecay",
    "adsGunKickStaticDecay",
    # The first N rounds of a burst kick at a reduced percentage. Exported and not
    # yet simulated: they scale the gun kick, which draws nothing but the model.
    "hipGunKickReducedKickBullets",
    "hipGunKickReducedKickPercent",
    "adsGunKickReducedKickBullets",
    "adsGunKickReducedKickPercent",
    # The aim's own kick. Pitch's max end is >= 0 in all 1503 weapon files of the
    # three games, which is what fixes the sign: positive is upward.
    "hipViewKickPitchMin",
    "hipViewKickPitchMax",
    "hipViewKickYawMin",
    "hipViewKickYawMax",
    "hipViewKickCenterSpeed",
    "adsViewKickPitchMin",
    "adsViewKickPitchMax",
    "adsViewKickYawMin",
    "adsViewKickYawMax",
    "adsViewKickCenterSpeed",
    "standMoveF",
    "standMoveR",
    "standMoveU",
    "standRotP",
    "standRotY",
    "standRotR",
)
# The rig's root and the engine's eye: a clip moving either would carry the
# camera with it rather than the gun. The gun's own root is deliberately not
# here — four Ghosts weapons animate it, which is the gun swinging under the
# hands and is what the animator meant.
FIXED_BONES = ("tag_origin", "tag_view")
GRAFT_PARENT = "tag_weapon"
# What the gun's root joint is called on all but one model; `gun_root_joint`
# reads the rig instead, because Ghosts' riot shield roots at `tag_riotshiled`.
GUN_ROOT = "j_gun"
# The folded backup sight; the game draws the raised one unless an optic hides it.
FOLDED_SIGHT = "tag_sight_off"


INFO_STRING_PREFIX = "WEAPONFILE"


def parse_infostring(text):
    """A WEAPONFILE infostring (`WEAPONFILE\\key\\value\\...`) as {key: value}. Values may span lines."""
    parts = text.split("\\")
    if parts[0] != INFO_STRING_PREFIX:
        raise ValueError(f"not a weapon file (starts {parts[0][:20]!r})")
    return dict(zip(parts[1::2], parts[2::2], strict=False))


def rounds_per_load(info):
    """How many rounds one load of a segmented reload puts in; 0 for a magazine.

    Two weapon-file keys folded into one number, because neither runs a reload
    without the other: `segmentedReload` says a shotgun is loaded a shell at a
    time and `reloadAmmoAdd` says how many go in per loop (1 on all eight that
    set it, in both games).
    """
    if _number(info, "segmentedReload") != 1:
        return 0
    return int(_number(info, "reloadAmmoAdd") or 1)


def _number(info, key):
    try:
        return float(info[key])
    except (KeyError, ValueError):
        return None


def role_clips(info, clip_names):
    """{role: clip asset name}. Weapon files spell clips in mixed case (`viewmodel_M4_idle`); the assets are lowercase."""
    by_lower = {c.lower(): c for c in clip_names}
    out, missing = {}, []
    for role, key in CLIP_ROLES.items():
        wanted = (info.get(key) or "").strip()
        if not wanted:
            continue
        if wanted.lower() in by_lower:
            out[role] = by_lower[wanted.lower()]
        else:
            missing.append(wanted)
    return out, missing


def hidden_bones(info, gun_joints):
    """Joints whose surfaces the game does not draw with no attachments: the weapon's hideTags and the folded sight.

    MW2 lists the folded sight in hideTags; MW3 leaves it out and draws it over the raised one otherwise.
    """
    tags = {t.strip() for t in (info.get("hideTags") or "").split("\n") if t.strip()}
    tags.add(FOLDED_SIGHT)
    return sorted(t for t in tags if t in gun_joints)


# What a weapon sounds like: field -> the weapon-file key naming its alias.
#
# **Carried rather than derived, and the M4 is the reason.** `m4_mp` in MW2 and
# `iw5_m4_mp` in MW3 both name `weap_m4carbine_*`, so a rule spelling the alias
# from the weapon's id works on most of a game's 53 guns and silently fails on
# the rest. The weapon file already says it; `docs/cod/games.md` records that
# IW4 and IW5 keep a weapon's sounds there and that Ghosts' are not recoverable
# at all, which is why every one of these is optional downstream.
SOUNDS = {
    "fire": "fireSound",
    "firePlayer": "fireSoundPlayer",
    "emptyFire": "emptyFireSound",
    "emptyFirePlayer": "emptyFireSoundPlayer",
    "reload": "reloadSound",
    "reloadEmpty": "reloadEmptySound",
    "melee": "meleeSwipeSound",
    "meleePlayer": "meleeSwipeSoundPlayer",
}

# What a weapon file writes where it means "no sound". `0` is in here because a
# handful of keys are numbers in a file that leaves the sound out.
NO_SOUND = {"", "none", "0"}
# A Black Ops II clip's sound notetracks: `sndnt#<alias>` (and `rmbnt#<rumble>`, not a sound).
SOUND_NOTETRACK = "sndnt#"

# Which of `soundOverrides`' five columns is which: the two attachments it
# applies to, which sound it replaces, and the alias it replaces it with. The
# fifth is the *underbarrel weapon's* own fire and is deliberately not read —
# an M203 under an M4 is a second gun, not a change to the first.
SOUND_OVERRIDE_FIELDS = {"fire": "fire", "player_fire": "firePlayer"}


def _alias(info, key):
    value = (info.get(key) or "").strip()
    return None if value.lower() in NO_SOUND else value


def notetrack_sounds(info, wanted=None):
    """`{notetrack: alias}` out of `notetrackSoundMap`, kept to the notetracks `wanted` holds.

    This is what makes a first-person reload a sequence: a clip already carries
    its notetracks with their times, and this says which of them are sounds — so
    `weap_m4carbine_clipin_plr` is played and `viewmodel_small`, `reload_vm` and
    `interruptible` are not, with no keep-list per game. Nearly an identity map
    (33 of 8,875 pairs across MW2, MW3 and Ghosts are not), and carried in full
    because those 33 are real.
    """
    out = {}
    # Black Ops II names the alias in the notetrack itself (`sndnt#fly_an94_mag_out`) and
    # leaves `notetrackSoundMap` empty: every such notetrack is a sound, spelled after the `#`.
    # Sorted: `wanted` is a set, and its order changes with each process's hash seed.
    for note in sorted(wanted or ()):
        if note.startswith(SOUND_NOTETRACK) and note[len(SOUND_NOTETRACK) :].lower() not in NO_SOUND:
            out[note] = note[len(SOUND_NOTETRACK) :]
    for line in (info.get("notetrackSoundMap") or "").split("\n"):
        parts = line.split()
        if len(parts) != 2 or parts[1].lower() in NO_SOUND:
            continue
        note, alias = parts
        if wanted is None or note in wanted:
            out[note] = alias
    return out


def sound_overrides(info):
    """`{attachment: {field: alias}}` for the attachments that change how a weapon fires.

    One row per attachment combination, so only the single-attachment rows are
    read: a two-attachment row is the composition of two of these, which is the
    same claim `attachments.iw4_entries` makes about MW2's variant weapon files.
    """
    out = {}
    for line in (info.get("soundOverrides") or "").split("\n"):
        parts = line.split()
        if len(parts) != 5 or parts[1].lower() != "none":
            continue
        name, _, which, alias, _secondary = parts
        field = SOUND_OVERRIDE_FIELDS.get(which)
        if field and alias.lower() not in NO_SOUND:
            out.setdefault(name, {})[field] = alias
    return out


def weapon_sounds(info, notetracks=None):
    """The `sounds` block of a `WeaponDef`: every alias the weapon file names, and its notetrack map.

    `impactType` goes in as spelled (`bullet_large`, `bullet_small`,
    `bullet_ap`), because it is a *prefix*: the engine concatenates a surface
    onto it to name what a round arriving sounds like, exactly as a footstep is
    spelled. Six of MW3's guns carry `shotgun`, for which the bank has no alias
    at all; it is carried anyway rather than dropped, so that the silence has a
    name to be looked up.
    """
    out = {field: alias for field, key in SOUNDS.items() if (alias := _alias(info, key))}
    if impact := _alias(info, "impactType"):
        out["impact"] = impact
    if notes := notetrack_sounds(info, notetracks):
        out["notes"] = notes
    return out


# The three ballistics fields that are a name rather than a number, so a test can
# tell "the game did not say" from a key this spells wrong.
BALLISTIC_STRINGS = ("weaponType", "weaponClass", "penetrateType")


def ballistics(info):
    """The half of a weapon nothing draws: what a shot takes off, the cone it leaves in, and where it landed.

    Its own function so that a test can run it over a game's real weapon files
    (`tests/test_viewmodel.py`). That is the whole guard here: a key spelled
    wrong resolves to nothing, and a gun that does no damage is exactly what a
    gun the game gives no damage looks like.
    """
    return {
        "damage": {role: v for role, key in DAMAGE.items() if (v := _number(info, key)) is not None},
        "spread": {role: v for role, key in SPREAD.items() if (v := _number(info, key)) is not None},
        "locationDamage": {loc: v for loc, key in LOCATIONS.items() if (v := _number(info, key)) is not None},
        # Pellets a shot casts: 8 for a SPAS-12, 1 for a rifle. Carried as spelled,
        # so the 99 MW3 files that fire no bullet at all keep their 0.
        "shotCount": int(_number(info, "shotCount") or 0),
        # `bullet` (hitscan), `grenade`, `projectile`, `riotshield` or `none`. A
        # server judging a shot needs this before it traces anything.
        "weaponType": info.get("weaponType", ""),
        # The same key `WeaponEntry.class` is read from, kept here because
        # `resolveWeapon` hands a server a `WeaponDef` and nothing else.
        "weaponClass": info.get("weaponClass", ""),
        # What a round goes through: `none`, `small`, `medium` or `large`.
        "penetrateType": info.get("penetrateType", ""),
    }


def definition(game_key, weapon, info, roles, clips, hide, used=None):
    """The weapon as the engine reads it from the GLB's scene extras (src/scene/viewmodel.ts).

    `used` is every clip the GLB carries, which is the weapon's own roles plus
    whatever its attachments name — a fitted grip plays a reload the bare gun
    never does, so the definition has to describe that clip too or the engine
    finds a role pointing at nothing.
    """
    used = sorted(used) if used is not None else sorted(set(roles.values()))
    # Only the notetracks the exported clips actually carry, which is the weapon's
    # own plus whatever its attachments brought: the map is the weapon file's
    # whole vocabulary, most of which belongs to clips this gun never plays.
    notetracks = {note for name in used for note, _ in clips[name].notetracks}
    return {
        "version": FORMAT_VERSION,
        "game": game_key,
        "weapon": weapon,
        "gun": info.get("gunModel", ""),
        "roles": roles,
        "sounds": weapon_sounds(info, notetracks),
        "clips": {
            name: {
                "duration": clips[name].duration,
                "looped": clips[name].looped,
                "notes": [[n, frame / clips[name].fps] for n, frame in clips[name].notetracks],
            }
            for name in used
        },
        "times": {role: v for role, key in TIMES.items() if (v := _number(info, key)) is not None},
        "clipSize": int(_number(info, "clipSize") or 0),
        "fireType": info.get("fireType", ""),
        # Not `rechamberAnim is set`: MW3's `defaultweapon` and `xm25_mp` name one
        # and are semi-automatic. The flag is what says the shot waits for it.
        "boltAction": _number(info, "boltAction") == 1,
        "roundsPerLoad": rounds_per_load(info),
        # The material name, which is also its catalogue id (`catalog/overlays/`).
        # None for every weapon whose sights are drawn rather than overlaid.
        "adsOverlay": info.get("adsOverlayShader") or None,
        "adsZoomFov": _number(info, "adsZoomFov"),
        "motion": {k: v for k in MOTION if (v := _number(info, k)) is not None},
        **ballistics(info),
        "hideBones": hide,
    }


def gun_root_joint(gltf):
    """The node index of the gun's root joint: `j_gun` on every model but one.

    Read off the rig rather than by name because Ghosts' riot shield roots at
    `tag_riotshiled` instead, and no clip names either — the root is only where
    the graft hangs the gun from the hands' `tag_weapon`.
    """
    roots, joints = skin_roots(gltf)
    named = next((j for j in joints if gltf["nodes"][j].get("name") == GUN_ROOT), None)
    if named is not None:
        return named
    if len(roots) != 1:
        raise ValueError(f"the gun has no {GUN_ROOT} joint and {len(roots)} root joints, expected 1")
    return roots[0]


def graft_hands_skeleton(gltf, hands):
    """Copy the hands' skeleton (joints, no meshes) into the packed gun GLB and hang the gun's root from its `tag_weapon`.

    `gltf` is the gun, packed (its scene has one unit-scale root). The gun keeps
    its inverse bind matrices: they place its geometry relative to its root,
    which is identity relative to `tag_weapon` in CoD's frame. The hands' joints
    become a second, mesh-less skin, which makes them bones for the loader and
    joints for clip_to_gltf.
    """
    gun_root = gun_root_joint(gltf)
    hand_joints = {j for s in hands.get("skins", []) for j in s["joints"]}
    hand_parent = {c: i for i, n in enumerate(hands["nodes"]) for c in n.get("children", [])}
    roots = [j for j in hand_joints if hand_parent.get(j) not in hand_joints]
    if len(roots) != 1:
        raise ValueError(f"the hands have {len(roots)} root joints, expected 1")

    copied = {}
    for old in joint_subtree(hands, roots[0]):
        src = hands["nodes"][old]
        node = {"name": src["name"], **{k: list(src[k]) for k in ("translation", "rotation", "scale") if k in src}}
        copied[old] = len(gltf["nodes"])
        gltf["nodes"].append(node)
    for old, new in copied.items():
        kids = [copied[c] for c in hands["nodes"][old].get("children", []) if c in copied]
        if kids:
            gltf["nodes"][new]["children"] = kids
    names = {gltf["nodes"][i]["name"]: i for i in copied.values()}
    if GRAFT_PARENT not in names:
        raise ValueError(f"the hands have no {GRAFT_PARENT} joint")

    # OAT hangs the gun's root from a `<model>_skel` node, beside the meshes; the hands' root
    # takes its place there. A node listed under two parents would be attached to whichever
    # the loader meets first.
    parents = [n for n in gltf["nodes"] if gun_root in n.get("children", [])]
    if len(parents) != 1:
        raise ValueError(f"the gun's root has {len(parents)} parents, expected 1")
    parents[0]["children"] = [c for c in parents[0]["children"] if c != gun_root] + [copied[roots[0]]]
    gltf["nodes"][names[GRAFT_PARENT]].setdefault("children", []).append(gun_root)
    gun = gltf["nodes"][gun_root]
    gun.pop("translation", None)
    gun.pop("rotation", None)  # was OAT's axis change, which tag_origin now carries for the whole rig
    gltf["skins"].append({"name": "viewhands", "joints": sorted(copied.values()), "skeleton": copied[roots[0]]})


def check_fixed_bones(clip):
    """Refuse a clip that moves a bone the graft or the engine's eye holds still."""
    moved = [b.name for b in clip.bones if b.name in FIXED_BONES and (b.rotation or b.translation)]
    if moved:
        raise ValueError(f"{clip.name} moves {', '.join(moved)}, which the viewmodel assumes fixed")


def build_weapon_glb(gun_packed, hands_raw, out_path, game_key, weapon, info, clips, extra=(), absolute_bones=None):
    """Write the weapon GLB; return (its definition, the gun's joints, [clip problems]).

    `extra` names clips to embed beyond the weapon's own roles — its attachments',
    which `attachments.resolve_clips` collects. MW2 gives a gun with a grip its
    own idle, reload and sprint, so a weapon carrying only the bare set would
    fall silent the moment one was fitted; that is what roughly doubles MW2's
    catalogue, from 540 clips over 43 base weapons to 1055.

    The joints come back because an attachment's hide and show rules are filtered
    against them, exactly as `hidden_bones` filters the weapon's own.

    `absolute_bones`, where given, decides what a translation key means instead of
    the clip's asset type (animations.clip_to_gltf): Advanced Warfare's.
    """
    gltf, buf = read_glb(gun_packed)
    hands, _ = read_glb(hands_raw)
    gun_joints = {gltf["nodes"][j].get("name") for s in gltf.get("skins", []) for j in s["joints"]}
    graft_hands_skeleton(gltf, hands)

    roles, missing = role_clips(info, clips)
    problems = [f"no clip {m} in the zone" for m in missing]
    used = set(roles.values()) | set(extra)
    for name in sorted(used):
        clip = clips[name]
        if absolute_bones is None and TRANSLATION_BY_ASSET_TYPE.get(clip.asset_type) != "absolute":
            raise ValueError(f"{name} is asset type {clip.asset_type}; every view clip measured is 1 (absolute translations)")
        check_fixed_bones(clip)
        written, unmatched = clip_to_gltf(gltf, buf, clip, absolute_bones)
        if not written:
            # A clip with no track at all is the game saying this weapon does not
            # do that: Ghosts gives the riot shield and the knife a one-frame
            # `ads_up` rather than leaving the role empty.
            problems.append(f"{name} drives no joint of this rig" if unmatched else f"{name} has no animated bone")
        elif unmatched > len(clip.bones) // 2:
            problems.append(f"{name}: {unmatched} of {len(clip.bones)} bones not in the rig")

    spec = definition(game_key, weapon, info, roles, clips, hidden_bones(info, gun_joints), used)
    gltf["scenes"][0].setdefault("extras", {})["viewmodel"] = spec
    gltf["buffers"] = [{"byteLength": len(buf)}]
    write_glb(out_path, gltf, buf)
    return spec, gun_joints, problems


def is_view_hands(name):
    """Whether a model's name is a view-hands one: `viewhands_*`, Black Ops' `viewmodel_<faction>_<class>_arms`,
    or Black Ops II's `c_<country>_mp_<faction>_<sleeve>_viewhands`."""
    return (
        name.startswith("viewhands_")
        or (name.startswith("viewmodel_") and name.endswith("_arms"))
        or (name.startswith("c_") and name.endswith("_viewhands"))
    )


def view_hands(xmodel_dir):
    """Names of every view-hands model OAT dumped: `is_view_hands` names whose xmodel JSON says `"type": "viewhands"`.

    OAT infers that type from bone data, and a foliage rig (foliage_desertbrush_3_animated) passes; the name is the game's.
    """
    out = []
    if not os.path.isdir(xmodel_dir):
        return out
    for f in sorted(os.listdir(xmodel_dir)):
        if is_view_hands(f.removesuffix(".json")) and f.endswith(".json"):
            try:
                if read_json(os.path.join(xmodel_dir, f)).get("type") == "viewhands":
                    out.append(f[:-5])
            except ValueError:
                continue
    return out


def default_hands(names):
    """A team's everyday hands rather than a sniper's or a juggernaut's; alphabetical among those."""
    plain = [n for n in names if not any(s in n for s in SPECIAL_HANDS)]
    return (plain or names or [None])[0]


def t5_default_hands(work, all_hands):
    """The arms Black Ops' create-a-class scripts give the allies' default class, if this zone ships them."""
    cast = cac.read_cast(os.path.join(work, "raw"))
    arms = [c[cac.DEFAULT_CLASS][2] for f, c in sorted(cast.items(), key=cac.allies_first) if cac.DEFAULT_CLASS in c]
    return next((a for a in arms if a in all_hands), None)


def _model_glb(models_dir, name):
    for dirpath, _, files in os.walk(models_dir):
        for stem in (f"{name}_lod0.glb", f"{name}.glb"):
            if stem in files:
                return os.path.join(dirpath, stem)
    return None


def export_viewmodel(work, assets_dir, game_key, states, weapon=None, hands=None):
    """The viewmodel stage: pack the map's view hands into `assets/viewmodel/`, and pick its weapon.

    Reads the weapon files dumped from the companion zone (`work/weapons`) and the
    models, images and materials the export already dumped. Returns (the weapon's
    catalogue id, chosen hands GLB, every hands GLB, (weapon name, its
    infostring)), the paths relative to the world, or None when this game or map
    has no viewmodel to export. The infostring goes on to the characters stage,
    which puts the same weapon's world model in a player's hands.

    The weapon itself is **not** packed here: it is named, and served from the
    catalogue every map shares (`python3 -m scripts.cod catalog`). What is left
    is the hands, which belong to this map.
    """
    weapon = weapon or DEFAULT_WEAPON.get(game_key)
    if weapon is None:
        print(f"      no viewmodel: {game_key} weapons are not supported yet")
        return None
    # The weapon files' `handModel` (`viewmodel_base_viewhands`) is a placeholder; a map ships its teams' hands.
    all_hands = view_hands(os.path.join(work, "models", "xmodel"))
    hands = hands or (t5_default_hands(work, all_hands) if game_key == "t5" else None) or default_hands(all_hands)
    if not hands:
        print("      no viewmodel: the zone ships no view hands")
        return None
    weapon_file = os.path.join(work, "weapons", "weapons", weapon)
    if not os.path.exists(weapon_file):
        print(f"      no viewmodel: no weapon file for {weapon}")
        return None
    info = parse_infostring(read_text(weapon_file))

    models = os.path.join(work, "models")
    hands_raw = _model_glb(models, hands)
    if hands_raw is None:
        print(f"      no viewmodel: hands {hands} not dumped")
        return None

    out_dir = os.path.join(assets_dir, OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)
    iwi = texture_index(os.path.join(work, "img"))
    # Seen from 30 cm, so a larger texture cap than a prop's 512 px.
    missing, packed_hands = 0, []
    for name in all_hands:
        raw = _model_glb(models, name)
        if raw:
            missing += pack_one(raw, os.path.join(out_dir, f"{name}.glb"), iwi, VIEW_TEXTURE_SIZE, states, False)[1]
            packed_hands.append(f"assets/{OUT_DIR}/{name}.glb")

    print(f"      {weapon_key(game_key, weapon)} from the catalogue; {len(packed_hands)} view hands, {hands} worn")
    if missing:
        print(f"      !! {missing} texture(s) not in the dump, drawn white")
    return weapon_key(game_key, weapon), f"assets/{OUT_DIR}/{hands}.glb", packed_hands, (weapon, info)
