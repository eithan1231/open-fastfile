"""`weapon`: each weapon as OpenAssetTools' `WEAPONFILE` infostring, under `weapons/<name>`.

A weapon is loaded by the emulated Durango loader, so its fields are read out of
the emulator's memory by path (memory.py) rather than off the file. The keys are
**OpenAssetTools' IW5 spellings**, because scripts/cod/viewmodel.py,
characters.py, catalog.py and attachments.py were written against IW4 and IW5
dumps and a per-game key table would be one more thing to keep in step.

Which IW6 member each key names was settled by matching member names between
OAT's `IW5/Weapon/WeaponFields.h` and x64-zt's IW6 `WeaponCompleteDef` /
`WeaponDef`: 759 of OAT's 773 keys name a member IW6 declares under the same
name, and `KEY_NAMES` below is every one whose key is not simply that member
without its Hungarian prefix. The dump is **partial** (`parts=KEYS`), and what is
left out is left out for a reason:

- **akimbo (`*Akimbo`) and the left/right-handed clips (`*AnimR`, `*AnimL`).**
  IW6 has them; nothing here reads them.
- **`parallel*Bounce` / `perpendicular*Bounce`.** IW5's are sound aliases per
  surface type; IW6's `parallelBounce` is a `float*`, so the key would mean
  something else. x64-zt's loader writes neither.
- **`fireInterruptableTime` and the other four `*InterruptableTime`s,
  `adsViewError*`, the two AI accuracy graphs.** IW6's structs have no such member.
- **Every sound alias, and `soundOverrides` with them.** `Load_WeaponDef` reads
  them through `Load_SndAliasCustom`, which turns the name it just streamed into
  a header with `DB_FindXAssetHeader` — a stub in the emulator, so the field is
  left null and the name is gone. Written out they would all read as "no sound".
  The cues in `notetrackSoundMap` are script strings and are written.
- **`meleeChargeAnim`.** IW6 splits melee into swipe/hit/fatal/miss slots and
  which one is IW5's "charge" is a guess; `meleeAnim` is the swipe, which is
  what IW5's is.
- **The eight `RELOAD_MULTIPLE_n` clip slots**, one per number of rounds a
  `bMultipleReload` weapon still has to load. OAT has no key for them and
  nothing here plays more than one reload clip; the flag itself is written,
  under `segmentedReload` (`SEGMENTED_KEY` below).

IW6's own additions have no OAT key and are not invented here: the camo models,
the 82 clip slots IW5 has no role for (mantles, slides, fast and multiple
reloads, the additive set) and `notetrackFXMap`.
"""

import struct

from ..memory import Struct
from . import dumper
from .clipmap import cstring
from .common import asset_path, plain

FOLDER = "weapons"
HEADER = "WEAPONFILE"

# Array lengths the loader reads, from x64-zt's iw6 weapondef.cpp.
MODEL_SLOTS = 64  # of `gunXModel` and of `worldModel`
HIDE_TAGS = 32
NOTETRACK_SOUNDS, NOTETRACK_RUMBLES = 24, 16
SCOPES, UNDER_BARRELS, OTHERS = 6, 3, 8
# OpenAssetTools writes 16 camo slots of each model array, and so does this.
MODEL_KEYS = 16

# `hitLocation_t` in IW6's own order, which `locationDamageMultipliers` indexes.
# It is **not** IW5's: IW6 keeps 22 and interleaves the sides where IW5 groups
# them, so a multiplier is written under the OAT key for the location standing at
# its index and never by position
# (docs/cod/reference.md#iw6s-hit-locations-are-not-iw5s).
HIT_LOCATIONS = (
    "none helmet head neck torso_upper torso_lower right_arm_upper left_arm_upper right_arm_lower left_arm_lower "
    "right_hand left_hand right_leg_upper left_leg_upper right_leg_lower left_leg_lower right_foot left_foot gun "
    "shield armor soft"
).split()
NUM_HIT_LOCATIONS = len(HIT_LOCATIONS)
# The three IW6 has that the engine does not: `HIT_LOCATIONS` in
# `@3d/shared/sim/hitLocations.ts` is nineteen and is a wire format, so a key for
# these would name a location nothing ever classifies a bone to.
UNWRITTEN_LOCATIONS = frozenset({"shield", "armor", "soft"})
# The 19 written, in IW6's order. The engine reads them by name, so its own
# order is not this one and does not have to be.
WRITTEN_LOCATIONS = [loc for loc in HIT_LOCATIONS if loc not in UNWRITTEN_LOCATIONS]

# Enum value -> the string OpenAssetTools writes, in IW6's own order (x64-zt's
# structs.hpp), `|` between them because several contain a space. Every enum IW5
# and IW6 share has the same members in the same order; `playerAnimType_t` is the
# one that grew, and its eleven new values take the lowercased enum tail, which
# is what OAT's own names are.
ENUM_NAMES = {
    "weapType_t": "none|bullet|grenade|projectile|riotshield",
    "weapClass_t": "rifle|sniper|mg|smg|spread|pistol|grenade|rocketlauncher|turret|throwingknife|non-player|item",
    "PenetrateType": "none|small|medium|large",
    "ImpactType": (
        "none|bullet_small|bullet_large|bullet_ap|bullet_explode|shotgun|shotgun_explode|grenade_bounce"
        "|grenade_explode|rocket_explode|projectile_dud"
    ),
    "weapInventoryType_t": "primary|offhand|item|altmode|exclusive|scavenger",
    "weapFireType_t": "Full Auto|Single Shot|2-Round Burst|3-Round Burst|4-Round Burst|Double Barrel",
    "OffhandClass": "None|Frag Grenade|Smoke Grenade|Flash Grenade|Throwing Knife|Other",
    "weapStance_t": "stand|duck|prone",
    "activeReticleType_t": "None|Pip-On-A-Stick|Bouncing diamond",
    "weapOverlayReticle_t": "none|crosshair",
    "WeapOverlayInteface_t": "None|Javelin|Turret Scope",
    "weapProjExposion_t": "grenade|rocket|flashbang|none|dud|smoke|heavy explosive",
    "WeapStickinessType": (
        "Don't stick|Stick to all|Stick to all, orient to surface|Stick to ground|Stick to ground, maintain yaw|Knife"
    ),
    "guidedMissileType_t": "None|Sidewinder|Hellfire|Javelin",
    "ammoCounterClipType_t": "None|Magazine|ShortMagazine|Shotgun|Rocket|Beltfed|AltWeapon",
    "weaponIconRatioType_t": "1:1|2:1|4:1",
    "AttachmentType": "scope|underbarrel|other",  # read by dumpers/attachment.py, not by a weapon key
    "playerAnimType_t": (
        "none|other|pistol|smg|autorifle|mg|sniper|rocketlauncher|explosive|grenade|turret|c4|m203|hold|briefcase"
        "|riotshield|laptop|throwingknife|mortar|juggernautmaniac|claymore|minigun|drill|dogwhistle|smg_bullpup"
        "|autorifle_bullpup|sniper_bullpup|killstreaktrigger|trophysystem"
    ),
}
ENUMS = {name: tuple(values.split("|")) for name, values in ENUM_NAMES.items()}

# The keys whose spelling is not the member without its Hungarian prefix.
KEY_NAMES = {
    "adsFireOnly": "adsFire",
    "aiFuseTime": "aifuseTime",
    "ammoDropStockMax": "dropAmmoMax",
    "ammoDropStockMin": "dropAmmoMin",
    "bBulletExplosiveDamage": "bBulletExplosiveDamage",  # the one key OAT spells with its prefix
    "handXModel": "handModel",
    "hipSpreadStandMax": "hipSpreadMax",
    "iPositionReloadTransTime": "adsReloadTransTime",
    "overlayInterface": "adsOverlayInterface",
    "projExplosion": "projExplosionType",
    "projLifetime": "projectileLifetime",
    "sharedAmmo": "shareAmmo",
    "suppressTime": "suppressionTime",
    "szAltWeaponName": "altWeapon",
    "szOverlayName": "AIOverlayDescription",
    "weapClass": "weaponClass",
    "weapType": "weaponType",
}

HUNGARIAN = ("sz", "b", "i", "f", "v")


def key_of(member):
    """The infostring key for a struct member: OAT's spelling, which is the member without its prefix."""
    if member in KEY_NAMES:
        return KEY_NAMES[member]
    for prefix in HUNGARIAN:
        if member.startswith(prefix) and len(member) > len(prefix) and member[len(prefix)].isupper():
            member = member[len(prefix) :]
            break
    return member[0].lower() + member[1:]


def location_key(location):
    """The infostring key for a hit location: `right_arm_upper` -> `locRightArmUpper`."""
    return "loc" + "".join(part.capitalize() for part in location.split("_"))


# Scalar members by where they live and how they read. `C` is WeaponCompleteDef;
# everything else is on the WeaponDef it points at, `T` its `stateTimers` and `O`
# its `overlay` (whose keys are `adsOverlay` plus the member, capitalised).
COMPLETE = {
    "str": "szDisplayName szAltWeaponName",
    "int": "iClipSize ammoDropStockMax",
    "ms": "iFireTime iAltRaiseTime iFirstRaiseTime iAdsTransInTime iAdsTransOutTime",
    "float": "penetrateMultiplier fAdsZoomFov fAdsViewKickCenterSpeed fHipViewKickCenterSpeed adsDofStart adsDofEnd",
    "bool": "enhanced motionTracker dpadIconShowsAmmo",
    "material": "killIcon dpadIcon",
    "ImpactType": "impactType",
    "weaponIconRatioType_t": "dpadIconRatio",
}
WEAPDEF = {
    "str": (
        "szOverlayName szModeName szScript szAmmoName szClipName szSharedAmmoCapName szUseHintString "
        "dropHintString fireRumble meleeImpactRumble turretBarrelSpinRumble"
    ),
    "scrstring": "stowTag",
    "model": "handXModel worldClipModel rocketModel knifeModel worldKnifeModel projectileModel stowOffsetModel",
    "material": "reticleCenter reticleSide hudIcon pickupIcon ammoCounterIcon",
    "collmap": "physCollmap",
    "tracer": "tracerType",
    "fx": (
        "viewFlashEffect worldFlashEffect viewShellEjectEffect worldShellEjectEffect viewLastShotEjectEffect "
        "worldLastShotEjectEffect projExplosionEffect projDudEffect projTrailEffect projBeaconEffect "
        "projIgnitionEffect turretOverheatEffect"
    ),
    "int": (
        "iReticleCenterSize iReticleSideSize iReticleMinOfs iStartAmmo iMaxAmmo shotCount iSharedAmmoCap damage "
        "playerDamage iMeleeDamage minDamage minPlayerDamage destabilizeDistance iReloadAmmoAdd iReloadStartAdd "
        "ammoDropStockMin ammoDropClipPercentMin ammoDropClipPercentMax iExplosionRadius iExplosionRadiusMin "
        "iExplosionInnerDamage iExplosionOuterDamage iProjectileSpeed iProjectileSpeedUp iProjectileSpeedForward "
        "iProjectileActivateDist riotShieldHealth projIgnitionDelay adsGunKickReducedKickBullets "
        "hipGunKickReducedKickBullets"
    ),
    "ms": "iPositionReloadTransTime scanPauseTime",
    "float": (
        "fPosMoveRate fPosProneMoveRate fStandMoveMinSpeed fDuckedMoveMinSpeed fProneMoveMinSpeed fPosRotRate "
        "fPosProneRotRate fStandRotMinSpeed fDuckedRotMinSpeed fProneRotMinSpeed fMaxDamageRange fMinDamageRange "
        "destabilizationRateTime destabilizationCurvatureMax autoAimRange aimAssistRange aimAssistRangeAds "
        "aimPadding enemyCrosshairRange moveSpeedScale adsMoveSpeedScale sprintDurationScale fIdleCrouchFactor "
        "fIdleProneFactor fGunMaxPitch fGunMaxYaw adsIdleLerpStartTime adsIdleLerpTime swayMaxAngle swayLerpSpeed "
        "swayPitchScale swayYawScale swayHorizScale swayVertScale swayShellShockScale adsSwayMaxAngle "
        "adsSwayLerpSpeed adsSwayPitchScale adsSwayYawScale adsSwayHorizScale adsSwayVertScale "
        "dualWieldViewModelOffset damageConeAngle bulletExplDmgMult bulletExplRadiusMult projLifetime "
        "timeToAccelerate projectileCurvature lowAmmoWarningThreshold ricochetChance riotShieldDamageMult "
        "maxSteeringAccel fAdsIdleAmount adsIdleSpeed fAdsZoomInFrac fAdsZoomOutFrac fAdsBobFactor fAdsViewBobMult "
        "fAdsAimPitch fAdsCrosshairInFrac fAdsCrosshairOutFrac adsGunKickReducedKickPercent fAdsGunKickPitchMin "
        "fAdsGunKickPitchMax fAdsGunKickYawMin fAdsGunKickYawMax fAdsGunKickAccel fAdsGunKickSpeedMax "
        "fAdsGunKickSpeedDecay fAdsGunKickStaticDecay fAdsViewKickPitchMin fAdsViewKickPitchMax fAdsViewKickYawMin "
        "fAdsViewKickYawMax fAdsSpread fHipSpreadStandMin fHipSpreadDuckedMin fHipSpreadProneMin hipSpreadStandMax "
        "hipSpreadDuckedMax hipSpreadProneMax fHipSpreadDecayRate fHipSpreadFireAdd fHipSpreadTurnAdd "
        "fHipSpreadMoveAdd fHipSpreadDuckedDecay fHipSpreadProneDecay fHipReticleSidePos fHipIdleAmount hipIdleSpeed "
        "hipGunKickReducedKickPercent fHipGunKickPitchMin fHipGunKickPitchMax fHipGunKickYawMin fHipGunKickYawMax "
        "fHipGunKickAccel fHipGunKickSpeedMax fHipGunKickSpeedDecay fHipGunKickStaticDecay fHipViewKickPitchMin "
        "fHipViewKickPitchMax fHipViewKickYawMin fHipViewKickYawMax leftArc rightArc topArc bottomArc accuracy "
        "aiSpread playerSpread pitchConvergenceTime yawConvergenceTime suppressTime maxRange fAnimHorRotateInc "
        "fPlayerPositionDist horizViewJitter vertViewJitter scanSpeed scanAccel fightDist maxDist turretADSTime "
        "turretFov turretFovADS turretScopeZoomRate turretScopeZoomMin turretScopeZoomMax turretOverheatUpRate "
        "turretOverheatDownRate turretOverheatPenalty turretBarrelSpinUpTime turretBarrelSpinDownTime "
        "turretBarrelSpinSpeed missileConeSoundRadiusAtTop missileConeSoundRadiusAtBase missileConeSoundHeight "
        "missileConeSoundOriginOffset missileConeSoundVolumescaleAtCore missileConeSoundVolumescaleAtEdge "
        "missileConeSoundVolumescaleCoreSize missileConeSoundPitchAtTop missileConeSoundPitchAtBottom "
        "missileConeSoundPitchTopSize missileConeSoundPitchBottomSize missileConeSoundCrossfadeTopSize "
        "missileConeSoundCrossfadeBottomSize"
    ),
    "bool": (
        "sharedAmmo lockonSupported requireLockonToFire isAirburstWeapon bigExplosion noAdsWhenMagEmpty "
        "inheritsPerks avoidDropCleanup crosshairColorChange bRifleBullet armorPiercing bBoltAction aimDownSight "
        "canHoldBreath canVariableZoom bRechamberWhileAds bBulletExplosiveDamage bClipOnly noAmmoPickup bCookOffHold "
        "adsFireOnly cancelAutoHolsterWhenEmpty disableSwitchToWhenEmpty suppressAmmoReserveDisplay "
        "laserSightDuringNightvision markableViewmodel noDualWield flipKillIcon bNoPartialReload bSegmentedReload "
        "blocksProne silenced isRollingGrenade projExplosionEffectForceNormalUp bProjImpactExplode stickToPlayers "
        "stickToVehicles stickToTurrets hasDetonator disableFiring timedDetonation rotate holdButtonToThrow "
        "freezeMovementWhenFiring riotShieldEnableDamage offhandHoldIsCancelable "
        "doNotAllowAttachmentsToOverrideSpread turretADSEnabled thermalScope altModeSameWeapon "
        "turretBarrelSpinEnabled missileConeSoundEnabled missileConeSoundPitchshiftEnabled "
        "missileConeSoundCrossfadeEnabled"
    ),
    "weapType_t": "weapType",
    "weapClass_t": "weapClass",
    "PenetrateType": "penetrateType",
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
    "weaponIconRatioType_t": "hudIconRatio pickupIconRatio ammoCounterIconRatio killIconRatio",
}
TIMERS = {
    "ms": (
        "iFireDelay iMeleeDelay meleeChargeDelay iRechamberTime rechamberTimeOneHanded iRechamberBoltTime "
        "iHoldFireTime iDetonateTime iDetonateDelay iMeleeTime meleeChargeTime iReloadTime reloadShowRocketTime "
        "iReloadEmptyTime iReloadAddTime iReloadStartTime iReloadStartAddTime iReloadEndTime iDropTime iRaiseTime "
        "iAltDropTime quickDropTime quickRaiseTime iBreachRaiseTime iEmptyRaiseTime iEmptyDropTime sprintInTime "
        "sprintLoopTime sprintOutTime stunnedTimeBegin stunnedTimeLoop stunnedTimeEnd nightVisionWearTime "
        "nightVisionWearTimeFadeOutEnd nightVisionWearTimePowerUp nightVisionRemoveTime "
        "nightVisionRemoveTimePowerDown nightVisionRemoveTimeFadeInStart fuseTime aiFuseTime blastFrontTime "
        "blastRightTime blastBackTime blastLeftTime"
    ),
}
OVERLAY = {
    "material": "shader shaderLowRes shaderEMP shaderEMPLowRes",
    "float": "width height widthSplitscreen heightSplitscreen",
    "weapOverlayReticle_t": "reticle",
}
# A three-float member written as one key per component, in OAT's spelling.
VECTORS = {
    "vStandMove": ("standMove", "FRU"),
    "vStandRot": ("standRot", "PYR"),
    "strafeMove": ("strafeMove", "FRU"),
    "strafeRot": ("strafeRot", "PYR"),
    "vDuckedOfs": ("duckedOfs", "FRU"),
    "vDuckedMove": ("duckedMove", "FRU"),
    "vDuckedRot": ("duckedRot", "PYR"),
    "vProneOfs": ("proneOfs", "FRU"),
    "vProneMove": ("proneMove", "FRU"),
    "vProneRot": ("proneRot", "PYR"),
}
PAIRS = {"minTurnSpeed": ("minVertTurnSpeed", "minHorTurnSpeed"), "maxTurnSpeed": ("maxVertTurnSpeed", "maxHorTurnSpeed")}
COLOUR = ("projectileRed", "projectileGreen", "projectileBlue")

# IW6 splits IW5's one segmented reload in two: `bSegmentedReload` loads a round
# at a time through `reloadStart`/`reload`/`reloadEnd`, and `bMultipleReload`
# through eight `RELOAD_MULTIPLE_n` clip slots instead. OAT has a key for the
# first and none for the second, and nothing downstream reads the clips — only
# the flag and `reloadAmmoAdd` (`viewmodel.rounds_per_load`). So both are
# written as `segmentedReload`; one weapon of the 130 sets each (the UTS-15 and
# the FP6), and without the fold the FP6 reloads five shells in one pump.
SEGMENTED_KEY = "segmentedReload"
MULTIPLE_RELOAD = "bMultipleReload"

# Clip role -> its slot in IW6's `weapAnimFiles_t`. IW5's slots are not IW6's
# (its RELOAD is 9, IW6's is 16), so this is IW6's enum keyed by OAT's names.
ANIMS = {
    "idleAnim": 1,
    "emptyIdleAnim": 2,
    "fireAnim": 3,
    "holdFireAnim": 4,
    "lastShotAnim": 5,
    "rechamberAnim": 6,
    "meleeAnim": 9,  # WEAP_ANIM_MELEE_SWIPE, which is what IW5's melee clip is
    "reloadAnim": 16,
    "reloadEmptyAnim": 17,
    "reloadStartAnim": 18,
    "reloadEndAnim": 19,
    "raiseAnim": 24,
    "firstRaiseAnim": 25,
    "breachRaiseAnim": 26,
    "dropAnim": 27,
    "altRaiseAnim": 28,
    "altDropAnim": 29,
    "quickRaiseAnim": 34,
    "quickDropAnim": 35,
    "emptyRaiseAnim": 36,
    "emptyDropAnim": 37,
    "sprintInAnim": 38,
    "sprintLoopAnim": 40,
    "sprintOutAnim": 41,
    "stunnedAnimStart": 42,
    "stunnedAnimLoop": 43,
    "stunnedAnimEnd": 44,
    "detonateAnim": 45,
    "nightVisionWearAnim": 46,
    "nightVisionRemoveAnim": 47,
    "adsFireAnim": 48,
    "adsLastShotAnim": 49,
    "adsRechamberAnim": 50,
    "blastFrontAnim": 51,
    "blastRightAnim": 52,
    "blastBackAnim": 53,
    "blastLeftAnim": 54,
    "adsUpAnim": 90,
    "adsDownAnim": 91,
    "altAdjustAnim": 93,
}
# `weapAnimFiles_t` in order, which is what an `animOverrides` row names. IW5 has
# a key for 41 of these; the rest are IW6's own (the mantles, the slides, the fast
# and multiple reloads, and the additive set a view clip is layered with).
ANIM_SLOTS = (
    "root idle empty_idle fire hold_fire lastshot rechamber grenade_prime grenade_prime_ready_to_throw melee_swipe "
    "melee_hit melee_fatal melee_miss melee_victim_crouching_hit melee_victim_crouching_fatal "
    "melee_victim_crouching_miss reload reload_empty reload_start reload_end fast_reload fast_reload_empty "
    "fast_reload_start fast_reload_end raise first_raise breach_raise drop alt_raise alt_drop alt_override "
    "toggle_override scope_toggle_on scope_toggle_off quick_raise quick_drop empty_raise empty_drop sprint_in "
    "sprint_in_cancel sprint_loop sprint_out stunned_start stunned_loop stunned_end detonate nightvision_wear "
    "nightvision_remove ads_fire ads_lastshot ads_rechamber blast_front blast_right blast_back blast_left slide_in "
    "slide_loop slide_out recoil_settle swim_loop mantle_up_64 mantle_up_56 mantle_up_48 mantle_up_40 mantle_up_32 "
    "mantle_up_24 mantle_up_16 mantle_over_64 mantle_over_56 mantle_over_48 mantle_over_40 mantle_over_32 "
    "mantle_over_24 mantle_over_16 reload_multiple_1 reload_multiple_2 reload_multiple_3 reload_multiple_4 "
    "reload_multiple_5 reload_multiple_6 reload_multiple_7 reload_multiple_8 reload_multiple_fast_1 "
    "reload_multiple_fast_2 reload_multiple_fast_3 reload_multiple_fast_4 reload_multiple_fast_5 "
    "reload_multiple_fast_6 reload_multiple_fast_7 reload_multiple_fast_8 ads_up ads_down recoil alt_adjust "
    "additive_ads_root additive_ads_up additive_drag_left_root additive_drag_left additive_drag_right_root "
    "additive_drag_right additive_drag_up_root additive_drag_up additive_drag_down_root additive_drag_down "
    "additive_swim_forward_root additive_swim_forward additive_swim_backward_root additive_swim_backward "
    "additive_jump_root additive_jump additive_jump_land_root additive_jump_land additive_walk_root additive_walk "
    "additive_crawl_in_root additive_crawl_in additive_crawl_loop_root additive_crawl_loop "
    "additive_crawl_loop_left_root additive_crawl_loop_left additive_crawl_loop_right_root "
    "additive_crawl_loop_right additive_prone_drop_root additive_prone_drop"
).split()
NUM_ANIMS = len(ANIM_SLOTS)  # NUM_WEAP_ANIMS

# An override entry names the attachments it applies to as a bitfield: a scope by
# index, an under barrel by index, and everything else as one bit each. IW5
# declares the widths and IW6 stores the same sixteen bits with no structure, so
# `combination` checks every row against the arrays it indexes rather than
# trusting them: widths read wrongly would name a real attachment of the wrong
# kind rather than fail.
SCOPE_BITS, UNDER_BARREL_BITS = 3, 2
ATTACHMENT_ARRAYS = (("scopes", SCOPES), ("underBarrels", UNDER_BARRELS), ("others", OTHERS))


def _members(groups):
    return [(kind, member) for kind, names in groups.items() for member in names.split()]


def _keys():
    out = []
    for groups in (COMPLETE, WEAPDEF, TIMERS):
        out += [key_of(member) for _kind, member in _members(groups)]
    out += ["adsOverlay" + m[0].upper() + m[1:] for _kind, m in _members(OVERLAY)]
    out += [base + suffix for base, suffixes in VECTORS.values() for suffix in suffixes]
    out += [key for pair in PAIRS.values() for key in pair]
    out += list(COLOUR)
    out += [location_key(loc) for loc in WRITTEN_LOCATIONS]
    out += [f"gunModel{i + 1}" if i else "gunModel" for i in range(MODEL_KEYS)]
    out += [f"worldModel{i + 1}" if i else "worldModel" for i in range(MODEL_KEYS)]
    out += list(ANIMS)
    out += [
        "hideTags",
        "notetrackSoundMap",
        "notetrackRumbleMap",
        "attachments",
        "animOverrides",
        "fxOverrides",
        "reloadOverrides",
        "notetrackOverrides",
    ]
    return out


KEYS = frozenset(_keys())


# --- reading one value --------------------------------------------------------

# The struct behind each asset-pointer kind, for the name read out of it.
ASSET_TYPES = {
    "model": "XModel",
    "material": "Material",
    "fx": "FxEffectDef",
    "collmap": "PhysCollmap",
    "tracer": "TracerDef",
}


def number(value):
    """A float as OpenAssetTools writes it: C++'s default six significant digits."""
    return f"{value:g}"


def asset(emulator, pointer, typename):
    """The name of the asset a pointer field names, as OAT writes it (no leading comma).

    A type the Python walkers handle (models, clips, materials, sounds, effects)
    is a stand-in address the emulator remembers; everything else is a struct in
    its memory whose first member is the name."""
    if not pointer:
        return ""
    foreign = emulator.foreign_asset(pointer)
    if foreign:
        return plain(foreign[1]) or ""
    return plain(cstring(emulator, Struct(emulator, typename, pointer)["name"])) or ""


def pointers(record, path, count):
    """The `count` pointers a pointer-to-pointer member holds; zeros for a null member."""
    base = record[path]
    if not base:
        return [0] * count
    return list(struct.unpack(f"<{count}Q", record.emulator.read(base, 8 * count)))


def script_strings(record, path, count, strings):
    """The `count` script strings a `scr_string_t*` member holds, resolved; [] for a null member."""
    base = record[path]
    if not base:
        return []
    raw = struct.unpack(f"<{count}I", record.emulator.read(base, 4 * count))
    return [strings[i] if i < len(strings) else "" for i in raw]


def location_damage(weapon):
    """`loc*`: the damage multiplier per hit location, keyed by name rather than by index.

    A weapon whose `locationDamageMultipliers` is null is given empty values
    rather than 1: the game said nothing, and 1 would say every shot is a body
    shot in a way nothing downstream could tell from a real table.
    """
    base = weapon["locationDamageMultipliers"]
    raw = weapon.emulator.read(base, 4 * NUM_HIT_LOCATIONS) if base else None
    values = struct.unpack(f"<{NUM_HIT_LOCATIONS}f", raw) if raw else [None] * NUM_HIT_LOCATIONS
    return [
        (location_key(loc), "" if v is None else number(v))
        for loc, v in zip(HIT_LOCATIONS, values, strict=True)
        if loc not in UNWRITTEN_LOCATIONS
    ]


def value(record, kind, member, strings):
    """One scalar member as its infostring value."""
    emulator = record.emulator
    if kind in ENUMS:
        names = ENUMS[kind]
        index = record[member]
        return names[index] if 0 <= index < len(names) else ""
    if kind == "str":
        return cstring(emulator, record[member]) or ""
    if kind == "scrstring":
        index = record[member]
        return strings[index] if 0 < index < len(strings) else ""
    if kind == "bool":
        return "1" if record[member] else "0"
    if kind == "int":
        return str(record[member])
    if kind == "float":
        return number(record[member])
    if kind == "ms":
        return number(record[member] / 1000.0)
    return asset(emulator, record[member], ASSET_TYPES[kind])


# --- the attachment arrays and the override tables ----------------------------


def attachment_names(complete):
    """{array: [name or None]}: what this weapon accepts, in the three arrays it lists them in."""
    out = {}
    for path, count in ATTACHMENT_ARRAYS:
        out[path] = [
            cstring(complete.emulator, Struct(complete.emulator, "WeaponAttachment", p)["szInternalName"]) if p else None
            for p in pointers(complete, path, count)
        ]
    return out


def combination(fields, accepted, where):
    """The attachment an override row applies to, or "none" for one that applies to the bare weapon."""
    if not fields:
        return "none"
    scope = fields & ((1 << SCOPE_BITS) - 1)
    under = (fields >> SCOPE_BITS) & ((1 << UNDER_BARREL_BITS) - 1)
    other = fields >> (SCOPE_BITS + UNDER_BARREL_BITS)
    picked = [("scopes", scope - 1)] if scope else []
    picked += [("underBarrels", under - 1)] if under else []
    picked += [("others", bit) for bit in range(OTHERS) if other & (1 << bit)]
    if len(picked) != 1 or other >> OTHERS:
        raise SystemExit(f"{where}: attachment bits {fields:#06x} name {len(picked)} attachments, expected 1")
    path, index = picked[0]
    name = accepted[path][index] if index < len(accepted[path]) else None
    if name is None:
        raise SystemExit(f"{where}: attachment bits {fields:#06x} name {path}[{index}], which this weapon does not carry")
    return name


def anim_overrides(complete, accepted, name):
    """`animOverrides`: attachment pair, clip role, the two clips and their times, one row each."""
    rows = []
    for entry in complete.array("animOverrides", "AnimOverrideEntry", complete["numAnimOverrides"]):
        slot = entry["animTreeType"]
        rows.append(
            " ".join(
                (
                    combination(entry["attachment1"], accepted, f"{name} animOverrides"),
                    combination(entry["attachment2"], accepted, f"{name} animOverrides"),
                    ANIM_SLOTS[slot] if slot < NUM_ANIMS else str(slot),
                    asset(complete.emulator, entry["overrideAnim"], "XAnimParts") or "none",
                    asset(complete.emulator, entry["altmodeAnim"], "XAnimParts") or "none",
                    str(entry["animTime"]),
                    str(entry["altTime"]),
                )
            )
        )
    return "\n".join(rows)


def fx_overrides(complete, accepted, name):
    """`fxOverrides`: attachment pair, the effect slot as a number, and the two effects.

    OpenAssetTools names IW5's five slots; IW6's are not the same enum and are
    written as they are. Across `common_core_mp`, shell-eject effects appear
    under 3 and 4 *and* under 5 and 6, and 8 carries the ADS muzzle flash IW5 has
    no field for — so IW5's names on these numbers would read plausibly and be
    wrong for at least half of them.
    """
    rows = []
    for entry in complete.array("fxOverrides", "FXOverrideEntry", complete["numFXOverrides"]):
        rows.append(
            " ".join(
                (
                    combination(entry["attachment1"], accepted, f"{name} fxOverrides"),
                    combination(entry["attachment2"], accepted, f"{name} fxOverrides"),
                    str(entry["fxType"]),
                    asset(complete.emulator, entry["overrideFX"], "FxEffectDef") or "none",
                    asset(complete.emulator, entry["altmodeFX"], "FxEffectDef") or "none",
                )
            )
        )
    return "\n".join(rows)


def reload_overrides(complete, accepted, name):
    """`reloadOverrides`: an attachment and the two reload times it adds, in milliseconds."""
    rows = []
    for entry in complete.array("reloadOverrides", "ReloadStateTimerEntry", complete["numReloadStateTimerOverrides"]):
        row = combination(entry["attachment"], accepted, f"{name} reloadOverrides")
        rows.append(f"{row} {entry['reloadAddTime']} {entry['reloadStartAddTime']}")
    return "\n".join(rows)


def notetrack_overrides(complete, accepted, name, strings):
    """`notetrackOverrides`: an attachment, then one cue and its sound alias per row."""
    rows = []
    for entry in complete.array("notetrackOverrides", "NoteTrackToSoundEntry", complete["numNotetrackOverrides"]):
        attachment = combination(entry["attachment"], accepted, f"{name} notetrackOverrides")
        keys = script_strings(entry, "notetrackSoundMapKeys", NOTETRACK_SOUNDS, strings)
        values = script_strings(entry, "notetrackSoundMapValues", NOTETRACK_SOUNDS, strings)
        rows += [f"{attachment} {k} {v}".rstrip() for k, v in zip(keys, values, strict=True) if k]
    return "\n".join(rows)


def notetrack_map(record, path, count, strings):
    """A notetrack map as OAT writes it: `<cue> <value>`, one pair a line."""
    keys = script_strings(record, path, count, strings)
    values = script_strings(record, path.replace("Keys", "Values"), count, strings)
    return "\n".join(f"{k} {v}".rstrip() for k, v in zip(keys, values, strict=True) if k)


# --- one weapon ---------------------------------------------------------------


def entries(zone, loaded, name):
    """Every (key, value) of one weapon, in the order the file is written."""
    complete = Struct.of(zone, loaded)
    weapon = Struct(complete.emulator, "WeaponDef", complete["weapDef"])
    timers = weapon.field("stateTimers", "StateTimers")
    overlay = weapon.field("overlay", "ADSOverlay")
    strings = zone.script_strings
    out = []

    for record, groups in ((complete, COMPLETE), (weapon, WEAPDEF), (timers, TIMERS)):
        out += [(key_of(member), value(record, kind, member, strings)) for kind, member in _members(groups)]
    if weapon[MULTIPLE_RELOAD]:
        out = [(SEGMENTED_KEY, "1") if key == SEGMENTED_KEY else (key, v) for key, v in out]
    out += [("adsOverlay" + m[0].upper() + m[1:], value(overlay, kind, m, strings)) for kind, m in _members(OVERLAY)]

    for member, (base, suffixes) in VECTORS.items():
        out += [(base + suffix, number(weapon[f"{member}[{i}]"])) for i, suffix in enumerate(suffixes)]
    for member, keys in PAIRS.items():
        out += [(key, number(weapon[f"{member}[{i}]"])) for i, key in enumerate(keys)]
    out += [(key, number(weapon[f"vProjectileColor[{i}]"])) for i, key in enumerate(COLOUR)]
    out += location_damage(weapon)

    for member, key in (("gunXModel", "gunModel"), ("worldModel", "worldModel")):
        models = pointers(weapon, member, MODEL_SLOTS)[:MODEL_KEYS]
        out += [(key if i == 0 else f"{key}{i + 1}", asset(weapon.emulator, p, "XModel")) for i, p in enumerate(models)]

    clips = pointers(complete, "szXAnims", NUM_ANIMS)
    out += [(key, asset(complete.emulator, clips[slot], "XAnimParts")) for key, slot in ANIMS.items()]

    tags = [t for t in script_strings(complete, "hideTags", HIDE_TAGS, strings) if t]
    out.append(("hideTags", "\n".join(tags)))
    out.append(("notetrackSoundMap", notetrack_map(weapon, "notetrackSoundMapKeys", NOTETRACK_SOUNDS, strings)))
    out.append(("notetrackRumbleMap", notetrack_map(weapon, "notetrackRumbleMapKeys", NOTETRACK_RUMBLES, strings)))

    accepted = attachment_names(complete)
    out.append(("attachments", "\n".join(n for path, _count in ATTACHMENT_ARRAYS for n in accepted[path] if n)))
    out.append(("animOverrides", anim_overrides(complete, accepted, name)))
    out.append(("fxOverrides", fx_overrides(complete, accepted, name)))
    out.append(("reloadOverrides", reload_overrides(complete, accepted, name)))
    out.append(("notetrackOverrides", notetrack_overrides(complete, accepted, name, strings)))
    return out


def infostring(zone, loaded, name):
    """One weapon as OAT's `WEAPONFILE\\key\\value\\...`."""
    return "\\".join([HEADER, *(part for pair in entries(zone, loaded, name) for part in pair)])


@dumper("weapon", parts=KEYS)
def write(walked, out):
    zone = walked.zone
    written = 0
    for name, loaded in sorted(zone.found.get("WEAPON", {}).items()):
        if not name or name.startswith(","):
            continue
        with open(asset_path(out, f"{FOLDER}/{name}"), "w", encoding="latin-1") as fh:
            fh.write(infostring(zone, loaded, name))
        written += 1
    if written:  # most zones hold none; only the game's weapon zone does
        print(f"      {written} weapon file(s) written, {len(KEYS)} keys each")
