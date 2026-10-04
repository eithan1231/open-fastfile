"""`weapon`: each weapon as OpenAssetTools' `WEAPONFILE` infostring, under `weapons/<name>`.

The keys are **OpenAssetTools' IW5 spellings**, as the IW6 dumper's are
(scripts/cod/iw6/dumpers/weapon.py), because viewmodel.py, catalog.py and
attachments.py read those. S1's `WeaponDef` is one flat struct whose members
are named as the keys are, less a Hungarian prefix, so `KEY_NAMES` below lists
only the ones that are not. The dump is **partial** (`parts=KEYS`); what is
left out has no S1 member to read or is not read by anything here:

- **akimbo** (`akimboStateTimers`, `*AnimR`/`*AnimL`) and the AI accuracy graphs.
- `penetrateMultiplier`, the three `*RotMinSpeed`s, the five `*InterruptableTime`s,
  `adsFire`, `cancelAutoHolsterWhenEmpty`, `enhanced`, `hasDetonator`,
  `laserSightDuringNightvision`: S1 has no such member. It says the same
  things other ways (`adsFireMode`, `autoHolsterType`, `penetrateDepth`), and
  inventing a key for them is not this file's job.
- `turretOverheat*`: S1's `overheat*` are the EM1's and the XMG's heat, not a turret's.
- `parallel*Bounce`/`perpendicular*Bounce`: IW5's are aliases, S1's floats.
- `fxOverrides`, `reloadOverrides` and `notetrackOverrides`: nothing here reads them.

Every sound alias *is* written: S1's are streamed as names, where IW6's are
lost to the emulator. Every enum is read through S1's own table (`ENUMS`),
three of which are not IW6's; README.md#the-weapons has the evidence for each.
"""

import struct

from ...iw6.dumpers.common import asset_path, plain
from ...iw6.dumpers.weapon import HIT_LOCATIONS, UNWRITTEN_LOCATIONS, location_key, number
from . import dumper

FOLDER = "weapons"
HEADER = "WEAPONFILE"

HIDE_TAGS = 32
NOTETRACK_SOUNDS, NOTETRACK_RUMBLES = 36, 16
NUM_HIT_LOCATIONS = len(HIT_LOCATIONS)  # S1's `hitLocation_t` is IW6's: its L/R pairs match

# Enum value -> the string OpenAssetTools writes, in S1's own order. A value past
# the end is written as its number: S1 extended three of these past every
# source we have, and a wrong name is worse than none.
ENUM_NAMES = {
    # x64-zt's s1 enum; `energy` is the EM1's.
    "weapType_t": "none|bullet|grenade|projectile|riotshield|energy",
    # x64-zt's s1 enum, which the zone bears out from 12 up: the EM1 is `beam`,
    # the riot shield `shield`, each exo ability its own, the Uplink drone `ball`.
    "weapClass_t": (
        "rifle|sniper|mg|smg|spread|pistol|grenade|rocketlauncher|turret|throwingknife|non-player|item|cone|beam"
        "|shield|hover|cloak|ping|repulsor|adrenaline|health|mute|underwater|ball"
    ),
    "PenetrateType": "none|small|medium|large",
    # H1's, not x64-zt's s1 one: `shotgun_energy` at 7 moves every value after it.
    "ImpactType": (
        "none|bullet_small|bullet_large|bullet_ap|bullet_explode|shotgun|shotgun_explode|shotgun_energy"
        "|grenade_bounce|grenade_explode|rocket_explode|projectile_dud|energy_beam|grapple"
    ),
    "weapInventoryType_t": "primary|offhand|item|altmode|exclusive|scavenger",
    # H1's, not IW6's: `5-Round Burst` at 5 moves `Double Barrel` to 6.
    "weapFireType_t": "Full Auto|Single Shot|2-Round Burst|3-Round Burst|4-Round Burst|5-Round Burst|Double Barrel",
    "weapStance_t": "stand|duck|prone",
    "activeReticleType_t": "None|Pip-On-A-Stick|Bouncing diamond",
    "weapOverlayReticle_t": "none|crosshair",
    "WeapOverlayInteface_t": "None|Javelin|Turret Scope",
    "weapProjExposion_t": "grenade|rocket|flashbang|none|dud|smoke|heavy explosive|spawner",
    "WeapStickinessType": (
        "Don't stick|Stick to all|Stick to all, orient to surface|Stick to ground|Stick to ground, maintain yaw|Knife"
    ),
    "guidedMissileType_t": "None|Sidewinder|Hellfire|Javelin",
    "ammoCounterClipType_t": "None|Magazine|ShortMagazine|Shotgun|Rocket|Beltfed|AltWeapon",
    "weaponIconRatioType_t": "1:1|2:1|4:1",
    # x64-zt's s1 enum, not IW6's (whose `mg` is S1's `sniper`); 15 is x64-zt's
    # `0x1F`, a typo between 0xE and 0x10.
    "playerAnimType_t": (
        "none|other|pistol|smg|autorifle|sniper|rocketlauncher|grenade|m203|hold|briefcase|riotshield|laptop"
        "|throwingknife|minigun|smg_bullpup|autorifle_bullpup|sniper_bullpup|killstreaktrigger|trophysystem"
        "|combatknife"
    ),
    # S1 splits `siderail` out of `other`, which moves `other` to 3.
    "AttachmentType": "scope|underbarrel|siderail|other",
}
ENUMS = {name: tuple(values.split("|")) for name, values in ENUM_NAMES.items()}
# The zone's frag, semtex, smoke, EMP, paint, knife, exo and drone classes are 1-8,
# where every source names six; nothing downstream reads it, so it is a number.
NUMBERED = ("OffhandClass",)

# The keys whose spelling is not the S1 member without its prefix.
KEY_NAMES = {
    "szAltWeaponName": "altWeapon",
    "weapType": "weaponType",
    "weapClass": "weaponClass",
    "fireLoopSound": "loopFireSound",
    "fireLoopSoundPlayer": "loopFireSoundPlayer",
    "fireStopSound": "stopFireSound",
    "fireStopSoundPlayer": "stopFireSoundPlayer",
    "fireLastSound": "lastShotSound",
    "fireLastSoundPlayer": "lastShotSoundPlayer",
    "ammoDropStockMin": "dropAmmoMin",
    "ammoDropStockMax": "dropAmmoMax",
    "projLifetime": "projectileLifetime",
    "hipSpreadStandMax": "hipSpreadMax",
    "suppressTime": "suppressionTime",
    "sharedAmmo": "shareAmmo",
    "bulletExplosiveDamage": "bBulletExplosiveDamage",
    "projExplosion": "projExplosionType",
    "positionReloadTransTime": "adsReloadTransTime",
    "overlayInterface": "adsOverlayInterface",
    "aiFuseTime": "aifuseTime",
}
HUNGARIAN = ("sz",)


def key_of(member):
    """The infostring key for an S1 member."""
    if member in KEY_NAMES:
        return KEY_NAMES[member]
    for prefix in HUNGARIAN:
        if member.startswith(prefix) and member[len(prefix)].isupper():
            member = member[len(prefix) :]
    return member[0].lower() + member[1:]


# Scalar members by how they read. `T` is `stateTimers`, `O` the `overlay`
# (whose keys are `adsOverlay` plus the member, capitalised). Every string,
# asset and sound member's name comes off the walk (`S1Weapon.names`).
WEAPDEF = {
    "name": (
        "szDisplayName szScript szAmmoName szClipName szSharedAmmoCapName szAltWeaponName szUseHintString "
        "dropHintString fireRumble meleeImpactRumble turretBarrelSpinRumble handModel worldClipModel rocketModel "
        "knifeModel worldKnifeModel projectileModel stowOffsetModel reticleCenter reticleSide hudIcon pickupIcon "
        "ammoCounterIcon killIcon dpadIcon physCollmap tracerType viewFlashEffect worldFlashEffect "
        "viewShellEjectEffect worldShellEjectEffect viewLastShotEjectEffect worldLastShotEjectEffect "
        "projExplosionEffect projDudEffect projTrailEffect projBeaconEffect projIgnitionEffect turretOverheatEffect"
    ),
    "scrstring": "stowTag",
    "int": (
        "reticleCenterSize reticleSideSize reticleMinOfs startAmmo maxAmmo clipSize shotCount sharedAmmoCap damage "
        "playerDamage meleeDamage minDamage minPlayerDamage destabilizeDistance reloadAmmoAdd reloadStartAdd "
        "ammoDropStockMin ammoDropStockMax ammoDropClipPercentMin ammoDropClipPercentMax explosionRadius "
        "explosionRadiusMin explosionInnerDamage explosionOuterDamage projectileSpeed projectileSpeedUp "
        "projectileSpeedForward projectileActivateDist riotShieldHealth projIgnitionDelay "
        "adsGunKickReducedKickBullets hipGunKickReducedKickBullets"
    ),
    "ms": "adsTransInTime adsTransOutTime positionReloadTransTime scanPauseTime",
    "float": (
        "posMoveRate posProneMoveRate standMoveMinSpeed duckedMoveMinSpeed proneMoveMinSpeed posRotRate "
        "posProneRotRate maxDamageRange minDamageRange destabilizationRateTime destabilizationCurvatureMax "
        "autoAimRange aimAssistRange aimAssistRangeAds aimPadding enemyCrosshairRange moveSpeedScale "
        "adsMoveSpeedScale sprintDurationScale idleCrouchFactor idleProneFactor gunMaxPitch gunMaxYaw "
        "adsIdleLerpStartTime adsIdleLerpTime swayMaxAngle swayLerpSpeed swayPitchScale swayYawScale "
        "swayHorizScale swayVertScale swayShellShockScale adsSwayMaxAngle adsSwayLerpSpeed adsSwayPitchScale "
        "adsSwayYawScale adsSwayHorizScale adsSwayVertScale adsViewErrorMin adsViewErrorMax "
        "dualWieldViewModelOffset damageConeAngle bulletExplDmgMult bulletExplRadiusMult projLifetime "
        "timeToAccelerate projectileCurvature lowAmmoWarningThreshold ricochetChance riotShieldDamageMult "
        "maxSteeringAccel adsIdleAmount adsIdleSpeed adsZoomFov adsZoomInFrac adsZoomOutFrac adsBobFactor "
        "adsViewBobMult adsAimPitch adsCrosshairInFrac adsCrosshairOutFrac adsGunKickReducedKickPercent "
        "adsGunKickPitchMin adsGunKickPitchMax adsGunKickYawMin adsGunKickYawMax adsGunKickAccel "
        "adsGunKickSpeedMax adsGunKickSpeedDecay adsGunKickStaticDecay adsViewKickPitchMin adsViewKickPitchMax "
        "adsViewKickYawMin adsViewKickYawMax adsViewKickCenterSpeed adsSpread hipSpreadStandMin "
        "hipSpreadDuckedMin hipSpreadProneMin hipSpreadStandMax hipSpreadDuckedMax hipSpreadProneMax "
        "hipSpreadDecayRate hipSpreadFireAdd hipSpreadTurnAdd hipSpreadMoveAdd hipSpreadDuckedDecay "
        "hipSpreadProneDecay hipReticleSidePos hipIdleAmount hipIdleSpeed hipGunKickReducedKickPercent "
        "hipGunKickPitchMin hipGunKickPitchMax hipGunKickYawMin hipGunKickYawMax hipGunKickAccel "
        "hipGunKickSpeedMax hipGunKickSpeedDecay hipGunKickStaticDecay hipViewKickPitchMin hipViewKickPitchMax "
        "hipViewKickYawMin hipViewKickYawMax hipViewKickCenterSpeed leftArc rightArc topArc bottomArc accuracy "
        "aiSpread playerSpread pitchConvergenceTime yawConvergenceTime suppressTime maxRange animHorRotateInc "
        "playerPositionDist horizViewJitter vertViewJitter scanSpeed scanAccel fightDist maxDist adsDofStart "
        "adsDofEnd turretADSTime turretFov turretFovADS turretScopeZoomRate turretScopeZoomMin turretScopeZoomMax "
        "turretBarrelSpinUpTime turretBarrelSpinDownTime turretBarrelSpinSpeed missileConeSoundRadiusAtTop "
        "missileConeSoundRadiusAtBase missileConeSoundHeight missileConeSoundOriginOffset "
        "missileConeSoundVolumescaleAtCore missileConeSoundVolumescaleAtEdge missileConeSoundVolumescaleCoreSize "
        "missileConeSoundPitchAtTop missileConeSoundPitchAtBottom missileConeSoundPitchTopSize "
        "missileConeSoundPitchBottomSize missileConeSoundCrossfadeTopSize missileConeSoundCrossfadeBottomSize"
    ),
    "bool": (
        "sharedAmmo requireLockonToFire isAirburstWeapon bigExplosion noAdsWhenMagEmpty inheritsPerks "
        "avoidDropCleanup crosshairColorChange rifleBullet armorPiercing boltAction aimDownSight canHoldBreath "
        "canVariableZoom rechamberWhileAds bulletExplosiveDamage clipOnly noAmmoPickup cookOffHold "
        "disableSwitchToWhenEmpty suppressAmmoReserveDisplay motionTracker markableViewmodel noDualWield "
        "flipKillIcon dpadIconShowsAmmo noPartialReload segmentedReload blocksProne silenced isRollingGrenade "
        "projExplosionEffectForceNormalUp projImpactExplode stickToPlayers stickToVehicles stickToTurrets "
        "disableFiring timedDetonation rotate holdButtonToThrow freezeMovementWhenFiring riotShieldEnableDamage "
        "offhandHoldIsCancelable doNotAllowAttachmentsToOverrideSpread turretADSEnabled thermalScope "
        "altModeSameWeapon turretBarrelSpinEnabled missileConeSoundEnabled missileConeSoundPitchshiftEnabled "
        "missileConeSoundCrossfadeEnabled"
    ),
    "weapType_t": "weapType",
    "weapClass_t": "weapClass",
    "PenetrateType": "penetrateType",
    "ImpactType": "impactType",
    "weapInventoryType_t": "inventoryType",
    "weapFireType_t": "fireType",
    "OffhandClass": "offhandClass",
    "weapStance_t": "stance",
    "activeReticleType_t": "activeReticleType",
    "ammoCounterClipType_t": "ammoCounterClip",
    "weapProjExposion_t": "projExplosion",
    "WeapStickinessType": "stickiness",
    "guidedMissileType_t": "guidedMissileType",
    "WeapOverlayInteface_t": "overlayInterface",
    "playerAnimType_t": "playerAnimType",
    "weaponIconRatioType_t": "hudIconRatio pickupIconRatio ammoCounterIconRatio killIconRatio dpadIconRatio",
}
TIMERS = {
    "ms": (
        "fireTime altRaiseTime firstRaiseTime fireDelay meleeDelay meleeChargeDelay rechamberTime "
        "rechamberTimeOneHanded rechamberBoltTime holdFireTime detonateTime detonateDelay meleeTime meleeChargeTime "
        "reloadTime reloadShowRocketTime reloadEmptyTime reloadAddTime reloadStartTime reloadStartAddTime "
        "reloadEndTime dropTime raiseTime altDropTime quickDropTime quickRaiseTime breachRaiseTime emptyRaiseTime "
        "emptyDropTime sprintInTime sprintLoopTime sprintOutTime stunnedTimeBegin stunnedTimeLoop stunnedTimeEnd "
        "nightVisionWearTime nightVisionWearTimeFadeOutEnd nightVisionWearTimePowerUp nightVisionRemoveTime "
        "nightVisionRemoveTimePowerDown nightVisionRemoveTimeFadeInStart fuseTime aiFuseTime blastFrontTime "
        "blastRightTime blastBackTime blastLeftTime"
    ),
}
OVERLAY = {
    "name": "shader shaderLowRes shaderEMP shaderEMPLowRes",
    "float": "width height widthSplitscreen heightSplitscreen",
    "weapOverlayReticle_t": "reticle",
}
# A three-float member written as one key per component, in OAT's spelling.
VECTORS = {
    "standMove": "FRU",
    "standRot": "PYR",
    "strafeMove": "FRU",
    "strafeRot": "PYR",
    "duckedOfs": "FRU",
    "duckedMove": "FRU",
    "duckedRot": "PYR",
    "proneOfs": "FRU",
    "proneMove": "FRU",
    "proneRot": "PYR",
}
PAIRS = {"minTurnSpeed": ("minVertTurnSpeed", "minHorTurnSpeed"), "maxTurnSpeed": ("maxVertTurnSpeed", "maxHorTurnSpeed")}
COLOUR = ("projectileRed", "projectileGreen", "projectileBlue")
# Streamed by name, so written; OAT's key is the member, bar KEY_NAMES.
SOUNDS = (
    "pickupSound pickupSoundPlayer ammoPickupSound ammoPickupSoundPlayer projectileSound pullbackSound "
    "pullbackSoundPlayer fireSound fireSoundPlayer fireLoopSound fireLoopSoundPlayer fireStopSound "
    "fireStopSoundPlayer fireLastSound fireLastSoundPlayer emptyFireSound emptyFireSoundPlayer meleeSwipeSound "
    "meleeSwipeSoundPlayer meleeHitSound meleeMissSound rechamberSound rechamberSoundPlayer reloadSound "
    "reloadSoundPlayer reloadEmptySound reloadEmptySoundPlayer reloadStartSound reloadStartSoundPlayer "
    "reloadEndSound reloadEndSoundPlayer detonateSound detonateSoundPlayer nightVisionWearSound "
    "nightVisionWearSoundPlayer nightVisionRemoveSound nightVisionRemoveSoundPlayer raiseSound raiseSoundPlayer "
    "firstRaiseSound firstRaiseSoundPlayer altSwitchSound altSwitchSoundPlayer putawaySound putawaySoundPlayer "
    "scanSound changeVariableZoomSound projExplosionSound projDudSound projIgnitionSound turretOverheatSound"
).split()

# As IW6's: a round-at-a-time reload is two flags, and OAT has a key for one.
SEGMENTED_KEY = "segmentedReload"
MULTIPLE_RELOAD = "multipleReload"

# Clip role -> its slot in S1's `weapAnimFiles_t` (x64-zt's s1 enum, 180 slots).
# Every slot below names the clip its role says on every gun in common_mp
# (`vm_ak12_reload` at 24, `vm_ak12_ads_up` at 128), which is what settles it:
# IW6's numbers are wrong from 16 up.
ANIMS = {
    "idleAnim": 1,
    "emptyIdleAnim": 2,
    "fireAnim": 3,
    "holdFireAnim": 4,
    "lastShotAnim": 5,
    "rechamberAnim": 6,
    "meleeAnim": 9,
    "reloadAnim": 24,
    "reloadEmptyAnim": 25,
    "reloadStartAnim": 26,
    "reloadEndAnim": 27,
    "raiseAnim": 36,
    "firstRaiseAnim": 37,
    "breachRaiseAnim": 38,
    "dropAnim": 39,
    "altRaiseAnim": 40,
    "altDropAnim": 41,
    "quickRaiseAnim": 43,
    "quickDropAnim": 44,
    "emptyRaiseAnim": 45,
    "emptyDropAnim": 46,
    "sprintInAnim": 49,
    "sprintLoopAnim": 52,
    "sprintOutAnim": 53,
    "stunnedAnimStart": 57,
    "stunnedAnimLoop": 58,
    "stunnedAnimEnd": 59,
    "detonateAnim": 61,
    "nightVisionWearAnim": 62,
    "nightVisionRemoveAnim": 63,
    "adsFireAnim": 64,
    "adsLastShotAnim": 65,
    "adsRechamberAnim": 66,
    "blastFrontAnim": 67,
    "blastRightAnim": 68,
    "blastBackAnim": 69,
    "blastLeftAnim": 70,
    "adsUpAnim": 128,
    "adsDownAnim": 129,
    "altAdjustAnim": 131,
}
NUM_ANIMS = 180


def _members(groups):
    return [(kind, member) for kind, names in groups.items() for member in names.split()]


def _keys():
    out = [key_of(m) for _kind, m in _members(WEAPDEF) + _members(TIMERS)]
    out += ["adsOverlay" + m[0].upper() + m[1:] for _kind, m in _members(OVERLAY)]
    out += [member + suffix for member, suffixes in VECTORS.items() for suffix in suffixes]
    out += [key for pair in PAIRS.values() for key in pair]
    out += list(COLOUR)
    out += [key_of(s) for s in SOUNDS]
    out += [location_key(loc) for loc in HIT_LOCATIONS if loc not in UNWRITTEN_LOCATIONS]
    out += ["gunModel", "gunModel2", "worldModel", "worldModel2"]
    out += list(ANIMS)
    out += ["hideTags", "notetrackSoundMap", "notetrackRumbleMap", "attachments", "animOverrides", "soundOverrides"]
    return out


KEYS = frozenset(_keys())


def scalar(record, kind, member):
    """One scalar member as its infostring value."""
    raw = record[member]
    if kind in ENUMS:
        names = ENUMS[kind]
        return names[raw] if 0 <= raw < len(names) else str(raw)
    if kind in NUMBERED or kind == "int":
        return str(raw)
    if kind == "bool":
        return "1" if raw else "0"
    if kind == "float":
        return number(raw)
    if kind == "ms":
        return number(raw / 1000.0)
    raise ValueError(f"no reading for {kind} {member}")


def script_strings(zone, at, count):
    """`count` script strings from the `scr_string_t` array at file offset `at`; [] for none."""
    if at is None:
        return []
    table = zone.script_strings
    return [table[i] if 0 < i < len(table) else "" for i in struct.unpack_from(f"<{count}I", zone.data, at)]


def notetrack_map(zone, keys_at, values_at, count):
    """A notetrack map as OAT writes it: `<cue> <value>`, one pair a line."""
    keys, values = script_strings(zone, keys_at, count), script_strings(zone, values_at, count)
    return "\n".join(f"{k} {v}".rstrip() for k, v in zip(keys, values, strict=False) if k)


def location_damage(zone, at):
    """`loc*` by name, from IW6's 22-location order; empty values where the weapon has no table."""
    values = struct.unpack_from(f"<{NUM_HIT_LOCATIONS}f", zone.data, at) if at is not None else [None] * NUM_HIT_LOCATIONS
    return [
        (location_key(loc), "" if v is None else number(v))
        for loc, v in zip(HIT_LOCATIONS, values, strict=True)
        if loc not in UNWRITTEN_LOCATIONS
    ]


# `soundType` 1-3 are IW5's (the zone's type-1 aliases are `*_npc`, its type-2 and
# type-3 ones `*_plr`, and every type-3 row is an akimbo's); 5, 10 and 11 are
# S1's own and are written as numbers.
SOUND_TYPES = {1: "fire", 2: "player_fire", 3: "player_akimbo"}
# `animHand` 1 is the left gun of an akimbo pair, which nothing here draws.
RIGHT_HAND = 0


def _pair(entry, first, second, accepted, where):
    """The attachments an override row applies to, the one of a single-attachment row first.

    S1 names them by a one-based index into this weapon's own `attachments`,
    0 for none, where IW6 packs a bitfield. Either column may hold the only one
    (`0 9`), and `0 0` is the bare weapon; every row in common_mp and
    patch_common_mp is in range, and a row that is not stops the dump."""
    picked = []
    for column in (first, second):
        index = entry[column]
        if index > len(accepted):
            raise SystemExit(f"{where}: an override row names attachment {index} of {len(accepted)}")
        if index:
            picked.append(plain(accepted[index - 1]))
    return (picked + ["none", "none"])[:2]


def sound_overrides(weapon, accepted, where):
    """`soundOverrides` in OAT's five columns: the two attachments, the sound it replaces, the two aliases."""
    rows = []
    for entry, alias, alt in weapon.overrides.get("soundOverrides", []):
        which = SOUND_TYPES.get(entry["soundType"], str(entry["soundType"]))
        rows.append(
            " ".join((*_pair(entry, "attachment1", "attachment2", accepted, where), which, alias or "none", alt or "none"))
        )
    return "\n".join(rows)


def anim_overrides(weapon, accepted, where):
    """`animOverrides`: the two attachments, the clip's role as its weapon-file key, the two clips and their times.

    A slot with no OpenAssetTools key is written as its number, as IW6's fx
    slots are; attachments.py reads only the keys it knows."""
    keys = {slot: key for key, slot in ANIMS.items()}
    rows = []
    for entry, anim, alt in weapon.overrides.get("animOverrides", []):
        if entry["animHand"] != RIGHT_HAND:
            continue
        slot = entry["animTreeType"]
        pair = _pair(entry, "attachment1", "attachment2", accepted, where)
        clips = (plain(anim) or "none", plain(alt) or "none")
        rows.append(" ".join((*pair, keys.get(slot, str(slot)), *clips, str(entry["animTime"]), str(entry["altTime"]))))
    return "\n".join(rows)


def entries(zone, weapon):
    """Every (key, value) of one weapon, in the order the file is written."""
    w, names, lists, arrays = weapon.record, weapon.names, weapon.lists, weapon.arrays
    out = []
    for kind, member in _members(WEAPDEF):
        value = (plain(names.get(member)) or "") if kind == "name" else None
        if kind == "scrstring":
            index = w[member]
            value = zone.script_strings[index] if 0 < index < len(zone.script_strings) else ""
        out.append((key_of(member), value if value is not None else scalar(w, kind, member)))
    if w[MULTIPLE_RELOAD]:
        out = [(SEGMENTED_KEY, "1") if key == SEGMENTED_KEY else (key, v) for key, v in out]
    out += [(key_of(m), scalar(w, kind, f"stateTimers.{m}")) for kind, m in _members(TIMERS)]
    for kind, m in _members(OVERLAY):
        path = f"overlay.{m}"
        value = (plain(names.get(path)) or "") if kind == "name" else scalar(w, kind, path)
        out.append(("adsOverlay" + m[0].upper() + m[1:], value))
    for member, suffixes in VECTORS.items():
        out += [(member + suffix, number(w[f"{member}[{i}]"])) for i, suffix in enumerate(suffixes)]
    for member, keys in PAIRS.items():
        out += [(key, number(w[f"{member}[{i}]"])) for i, key in enumerate(keys)]
    out += [(key, number(w[f"projectileColor[{i}]"])) for i, key in enumerate(COLOUR)]
    out += [(key_of(s), plain(names.get(s)) or "") for s in SOUNDS]
    out += location_damage(zone, arrays.get("locationDamageMultipliers"))

    for member in ("gunModel", "worldModel"):
        models = (lists.get(member) or []) + [None, None]
        out += [(member, plain(models[0]) or ""), (f"{member}2", plain(models[1]) or "")]
    clips = lists.get("szXAnims") or [None] * NUM_ANIMS
    out += [(key, plain(clips[slot]) or "") for key, slot in ANIMS.items()]

    out.append(("hideTags", "\n".join(t for t in script_strings(zone, arrays.get("hideTags"), HIDE_TAGS) if t)))
    for key, count in (("notetrackSoundMap", NOTETRACK_SOUNDS), ("notetrackRumbleMap", NOTETRACK_RUMBLES)):
        member = key + "Keys"
        out.append((key, notetrack_map(zone, arrays.get(member), arrays.get(key + "Values"), count)))
    accepted = [a for a in lists.get("attachments") or [] if a]
    out.append(("attachments", "\n".join(plain(a) for a in accepted)))
    where = plain(names.get("szInternalName"))
    out.append(("animOverrides", anim_overrides(weapon, accepted, where)))
    out.append(("soundOverrides", sound_overrides(weapon, accepted, where)))
    return out


def infostring(zone, weapon):
    """One weapon as OAT's `WEAPONFILE\\key\\value\\...`."""
    return "\\".join([HEADER, *(part for pair in entries(zone, weapon) for part in pair)])


def check_damage_tiers(zone, weapons):
    """Refuse a zone whose guns lose damage and then regain it with range.

    That is what reading x64-zt's `minDamage`/`midDamage` its own way gives on
    every AW gun (walkers.Layout._name_damage_tiers). A debug weapon or two may
    disagree; most of the zone's bullet weapons may not."""
    falling = rising = 0
    for weapon in weapons.values():
        w = weapon.record
        if w["weapType"] != 1 or not w["damage"]:
            continue
        if w["midDamage"] >= w["minDamage"]:
            falling += 1
        else:
            rising += 1
    if rising > falling:
        raise SystemExit(f"{rising} bullet weapons gain damage past midDamage and {falling} do not: the tiers are misread")


@dumper("weapon", parts=KEYS)
def write(walked, out):
    zone = walked.zone
    weapons = {n: w for n, w in zone.found.get("WEAPON", {}).items() if n and not n.startswith(",")}
    check_damage_tiers(zone, weapons)
    for name, weapon in sorted(weapons.items()):
        with open(asset_path(out, f"{FOLDER}/{name}"), "w", encoding="latin-1") as fh:
            fh.write(infostring(zone, weapon))
    if weapons:  # most zones hold none; only the companion zones do
        print(f"      {len(weapons)} weapon file(s) written, {len(KEYS)} keys each")
