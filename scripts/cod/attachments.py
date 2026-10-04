"""What may be fitted to a weapon, and what fitting it does to that weapon.

The two Modern Warfares describe an attachment in ways with nothing in common:

- **IW5 says it outright.** `common_mp.ff` carries 40 `attachment` assets and
  each weapon file lists the ones it accepts, so one ACOG description is shared
  by every rifle that takes one. Its numbers are a mixture of multiplicative
  scales and absolute blocks.
- **IW4 says it by example.** There is no `attachment` asset type at all.
  Instead the zone ships one complete weapon file per combination — 1078 of
  them beside 43 base weapons — so an attachment's effect is the difference
  between `aa12_eotech_mp` and `aa12_mp`, in absolute numbers.

Both collapse to the same `AttachmentEntry` here: against one named weapon, in
that weapon's own absolute numbers, so that no runtime code learns that either
shape existed and `resolveWeapon` stays a spread. The rules the collapse relies
on are measured rather than assumed — `tests/test_attachments.py` rebuilds
MW2's 806 two-attachment weapon files from the deltas taken here, and 801 match.
docs/cod/reference.md#attachments.
"""

import os

from .files import read_json
from .viewmodel import CLIP_ROLES, MOTION, TIMES, _number, ballistics, parse_infostring, sound_overrides, weapon_sounds

# Slot order, which IS the wire format and also how two attachments touching one
# field are settled: `resolveWeapon` walks the list front to back and the later
# one wins. This order is what reproduces MW2's own combinations — a grip keeps
# the reload it authored even with an optic on the same gun.
TYPE_ORDER = ("other", "scope", "underbarrel")
DEFAULT_TYPE = "other"

# The exception to that: the clips played while aiming belong to a fitted optic
# whatever else is on the gun. Kept in step with SIGHT_ROLES in
# `@3d/shared/sim/weaponRegistry.ts`, which is where it is applied.
ADS_ROLES = ("adsUp", "adsDown", "adsFire", "adsLastShot")
SIGHT_TYPE = "scope"

# The most attachments one weapon may offer, because the wire names a fitted one
# by its slot in four bits. Kept in step with MAX_ATTACHMENT_SLOTS in
# `@3d/shared/sim/weaponRegistry.ts`, which refuses a longer list outright — so a
# catalogue built past this is one no client can load at all.
MAX_ATTACHMENT_SLOTS = 16


def sort_key(entry):
    """A weapon's attachments in slot order: by `type`, then by name."""
    kind = entry.get("type", DEFAULT_TYPE)
    return (TYPE_ORDER.index(kind) if kind in TYPE_ORDER else 0, entry["id"])


def accepted(info):
    """The attachment names a weapon file lists, in its own order. Empty for a game that has none."""
    return [a.strip() for a in (info.get("attachments") or "").split("\n") if a.strip()]


def spec_of(info):
    """The part of a weapon file that `WeaponDef` keeps, before its clips are decoded.

    Clip names are the weapon file's own spelling (`viewmodel_M4_idle`), not the
    zone's lowercase asset names; `catalog.build_one` resolves them against what
    was actually dumped, for a base weapon and its attachments alike.
    """
    return {
        "roles": {role: name for role, key in CLIP_ROLES.items() if (name := (info.get(key) or "").strip())},
        "times": {role: v for role, key in TIMES.items() if (v := _number(info, key)) is not None},
        "motion": {key: v for key in MOTION if (v := _number(info, key)) is not None},
        "clipSize": int(_number(info, "clipSize") or 0),
        "fireType": info.get("fireType", ""),
        "adsZoomFov": _number(info, "adsZoomFov"),
        "adsOverlay": info.get("adsOverlayShader") or None,
        "hideTags": {t.strip() for t in (info.get("hideTags") or "").split("\n") if t.strip()},
        # The aliases this weapon is heard through, and — for IW5, which says it
        # outright rather than by example — what fitting one attachment does to
        # them. A silencer is the whole of what that means in both games: it
        # replaces the two fire sounds and leaves the reload, the melee and the
        # notetracks alone, which is why `resolveWeapon` merges `sounds` key by key.
        "sounds": weapon_sounds(info),
        "soundOverrides": sound_overrides(info),
    }


def _entry(name, kind, display=None):
    entry = {"id": name, "type": kind if kind in TYPE_ORDER else DEFAULT_TYPE}
    if display:
        entry["display"] = display
    return entry


def _with_overrides(entry, overrides, hide=(), show=()):
    """Finish an entry, leaving out every part of it that turned out to be empty."""
    if overrides:
        entry["overrides"] = overrides
    if hide:
        entry["hideBones"] = sorted(hide)
    if show:
        entry["showBones"] = sorted(show)
    return entry


# --- IW5: 40 attachment assets ------------------------------------------------

ATTACH_DIR = "attach"  # under an export's scratch directory, as the `attachment` dump fills it

# An attachment carrying its own `ammunition` is not a change to the gun but a
# second gun on it: the four rounds, the 80° ADS zoom and the recoil in
# `shotgun`, `gl`, `gp25` and `m320` are the underbarrel weapon's own. Folded
# onto the rifle they make a plausible four-round M4, so nothing but the model
# and the hide rule is taken from those four.
ALT_WEAPON_KEY = "ammunition"
# The block holding what a round is and how it leaves the barrel. Not the one above.
AMMO_KEY = "ammoGeneral"

# Which of `WeaponDef.times` each of IW5's two timer scales multiplies.
TIMER_SCALES = {
    "fireTimersScale": ("fire", "fireInterruptible"),
    "stateTimersScale": (
        "reload",
        "reloadEmpty",
        "reloadAdd",
        "raise",
        "firstRaise",
        "drop",
        "quickRaise",
        "quickDrop",
        "sprintIn",
        "sprintLoop",
        "sprintOut",
    ),
}

# The raised iron sight, hidden by an optic that says so. The folded one
# (`tag_sight_off`) is in the bare weapon's own hideBones already.
IRON_SIGHT = "tag_sight_on"

# How a gun names the tag its own dedicated scope hangs on, and the tags that
# only look like one. A `tag_reticle_*` is a joint *inside* a scope, not a place
# to hang one.
SCOPE_TAG = "scope"
NOT_A_MOUNT = "reticle"


def read_defs(work):
    """{name: the `attachment` asset}, out of a `--include-assets attachment` dump. Empty for a game with none."""
    root = os.path.join(work, ATTACH_DIR, "attachment")
    if not os.path.isdir(root):
        return {}
    return {f[:-5]: read_json(os.path.join(root, f)) for f in sorted(os.listdir(root)) if f.endswith(".json")}


def scale(attach, key):
    """A `*Scale` field, or None where it changes nothing.

    **IW5 writes an unused scale as 0, not 1.** `adsSettingsScale`, `gunKickScale`,
    `hipSpreadScale` and `idleSettingsScale` are 0 on all 40 attachments, and
    `ammunitionScale` is 0 on the 35 that do not touch the magazine. Read as
    multipliers they would take every one of those numbers to nothing, which is
    the sort of wrong that still renders.
    """
    value = attach.get(key)
    return None if value in (None, 0.0, 1.0) else value


def iw5_entry(name, attach, base, model=None, tag=None):
    """One IW5 attachment against one weapon, in that weapon's own absolute numbers.

    `base` is `spec_of(the weapon file)`, which is what the scales multiply:
    `ammunitionScale` 1.5 on an M4's 30 rounds is 45 here, and the engine never
    sees that a scale was involved.
    """
    overrides, times = {}, {}

    if ALT_WEAPON_KEY not in attach:
        ads = attach.get("adsSettings") or {}
        if ads.get("adsZoomFov") is not None:
            overrides["adsZoomFov"] = ads["adsZoomFov"]
        for role, key in (("adsIn", "adsTransInTime"), ("adsOut", "adsTransOutTime")):
            if ads.get(key) is not None:
                times[role] = ads[key]
        # An optic that has one brings it; one that has none takes the weapon's
        # away, which is what an ACOG on a sniper rifle does. `resolveWeapon`
        # gives a fitted sight the last word on it, as it does the aiming clips.
        if "adsOverlay" in attach:
            overrides["adsOverlay"] = (attach["adsOverlay"] or {}).get("shader") or None
        for key, roles in TIMER_SCALES.items():
            if (factor := scale(attach, key)) is not None:
                times.update({role: base["times"][role] * factor for role in roles if role in base["times"]})
        if (factor := scale(attach, "ammunitionScale")) is not None and base["clipSize"]:
            overrides["clipSize"] = round(base["clipSize"] * factor)
        # Ghosts sells the fire selector as an attachment, and this is the only
        # thing that says the rifle it is on now fires one round a press. MW3's
        # four `ammoGeneral` blocks are all an underbarrel weapon's, which the
        # branch above already leaves alone.
        fire = (attach.get(AMMO_KEY) or {}).get("fireType")
        if fire and fire != base["fireType"]:
            overrides["fireType"] = fire
        # What this attachment does to how the gun is heard, out of the *weapon
        # file's* own table rather than the attachment asset's: a silencer is
        # named once and the alias it swaps in is a different one on every gun.
        if sounds := {k: v for k, v in base["soundOverrides"].get(name, {}).items() if base["sounds"].get(k) != v}:
            overrides["sounds"] = sounds

    if times:
        overrides["times"] = times

    entry = _entry(name, attach.get("type"), attach.get("displayName"))
    if model:
        entry["model"] = model
        if tag:
            entry["tag"] = tag
    # Filtered against the gun's own joints by `restrict_bones`, like the bare
    # weapon's hideTags: not every gun carries a raised iron sight to hide.
    hide = {IRON_SIGHT} if attach.get("hideIronSightsWithThisAttachment") else set()
    return _with_overrides(entry, overrides, hide)


# --- IW4: one weapon file per combination -------------------------------------

# What each of MW2's 14 attachment names *is*. IW4 ships no attachment assets to
# say so, and the slot order and the aiming-clip rule both turn on it, so it is a
# table — checked against IW5's own `type` for the 13 names both games ship
# (tests/test_attachments.py). `fmj` is the one MW2 has and MW3 does not.
IW4_TYPES = {
    "acog": "scope",
    "akimbo": "other",
    "eotech": "scope",
    "fmj": "other",
    "gl": "underbarrel",
    "grip": "underbarrel",
    "heartbeat": "other",
    "reflex": "scope",
    "rof": "other",
    "shotgun": "underbarrel",
    "silencer": "other",
    "tactical": "other",
    "thermal": "scope",
    "xmags": "other",
}
# Black Ops' own names, the same table for the same reason: it too ships a weapon
# file per combination and no attachment assets. `elbit` is the red dot, `ir` the
# infrared scope, `vzoom` the variable zoom, `upgradesight` a pistol's upgraded
# iron sight; `mk` (Masterkey) and `ft` (flamethrower) are underbarrel weapons,
# `rf` is rapid fire. `check_variants` is what proves the scopes are scopes: a
# sight's aiming clips beat an underbarrel's in every combination the game ships.
T5_TYPES = {
    "acog": "scope",
    "dualclip": "other",
    "elbit": "scope",
    "extclip": "other",
    "ft": "underbarrel",
    "gl": "underbarrel",
    "grip": "underbarrel",
    "ir": "scope",
    "mk": "underbarrel",
    "reflex": "scope",
    "rf": "other",
    "silencer": "other",
    "snub": "other",
    "speed": "other",
    "upgradesight": "scope",
    "vzoom": "scope",
}


def variant_name(base, names):
    """`aa12_mp` + `["eotech"]` -> `aa12_eotech_mp`. The game's own spelling, alphabetical."""
    return "_".join([base[:-3], *sorted(names), "mp"]) if base.endswith("_mp") else "_".join([base, *sorted(names)])


def split_variants(base, names):
    """{variant name: [its attachment names]} for every variant of `base` in `names`.

    A variant is a weapon whose name is the base's plus one or more tokens. The
    names are the game's own and alphabetical, which is what makes this readable
    rather than a guess — but it is only a reading of names, so `base_weapons`
    stays the thing that decides which weapons exist.
    """
    stem = base[:-3] if base.endswith("_mp") else base
    out = {}
    for name in names:
        if name == base or not name.startswith(f"{stem}_"):
            continue
        tokens = (name[:-3] if name.endswith("_mp") else name)[len(stem) + 1 :].split("_")
        if tokens and all(tokens):
            out[name] = tokens
    return out


def iw4_entry(name, base, variant):
    """One IW4 attachment, as the difference between a variant weapon file and its base.

    `base` and `variant` are both `spec_of(...)`. `displayName` is deliberately
    not diffed: a two-attachment file calls itself `WEAPON_AA12_BLING`, which is
    a name for the combination and not for either attachment.
    """
    overrides = {}
    for key in ("clipSize", "fireType", "adsZoomFov", "adsOverlay"):
        if base[key] != variant[key]:
            overrides[key] = variant[key]
    for key in ("roles", "times", "motion", "sounds"):
        changed = {k: v for k, v in variant[key].items() if base[key].get(k) != v}
        if changed:
            overrides[key] = changed

    # hideTags is a set, not a string: an attachment reveals the gun's own mesh
    # for it by dropping a tag, and two of them drop one each. Composed as text,
    # the second would put the first's back.
    entry = _entry(name, IW4_TYPES.get(name) or T5_TYPES.get(name))
    return _with_overrides(entry, overrides, variant["hideTags"] - base["hideTags"], base["hideTags"] - variant["hideTags"])


def iw4_entries(base_name, base_info, variants):
    """Every attachment a base weapon offers, from its single-attachment variants.

    `variants` is {weapon file name: its infostring}, every player weapon in the
    zone. Only the one-token variants of `base_name` are read: a two-token file
    is the composition of two of these, which is a claim the tests check rather
    than something used here.
    """
    base = spec_of(base_info)
    entries = []
    for name, tokens in split_variants(base_name, variants).items():
        if len(tokens) == 1:
            entries.append(iw4_entry(tokens[0], base, spec_of(variants[name])))
    return sorted(entries, key=sort_key)


# --- Finishing an entry against the gun it belongs to --------------------------


def resolve_clips(entries, clip_names):
    """Rewrite each attachment's clip names to the zone's own spelling, in place; return the names used.

    Weapon files spell a clip in mixed case (`viewmodel_M4_grip_reload`) and the
    assets are lowercase, the same mismatch `role_clips` handles for the bare
    weapon. A role naming a clip the dump does not carry is dropped rather than
    left pointing at nothing — a fitted grip that names no reload plays none.
    """
    by_lower = {c.lower(): c for c in clip_names}
    used = set()
    for entry in entries:
        roles = (entry.get("overrides") or {}).get("roles")
        if not roles:
            continue
        found = {role: by_lower[name.lower()] for role, name in roles.items() if name.lower() in by_lower}
        used.update(found.values())
        if found:
            entry["overrides"]["roles"] = found
        else:
            entry["overrides"].pop("roles")
            if not entry["overrides"]:
                entry.pop("overrides")
    return used


def wanted_clips(entries):
    """Every clip name the attachments name, as the weapon files spell them. For deciding what to decode."""
    return {name for entry in entries for name in ((entry.get("overrides") or {}).get("roles") or {}).values()}


def restrict_bones(entries, joints):
    """Cut each attachment down to what this gun actually carries, in place.

    The same filter `hidden_bones` applies to the bare weapon, and for the same
    reason: the game skips a surface by the joint it hangs from, so a rule naming
    a joint that is not there hides and reveals nothing. A mount tag goes the same
    way — an attachment description is shared by every weapon that accepts it, and
    a model with nowhere on this gun to hang is better absent than at the origin.
    """
    for entry in entries:
        for key in ("hideBones", "showBones"):
            if key in entry:
                kept = [bone for bone in entry[key] if bone in joints]
                if kept:
                    entry[key] = kept
                else:
                    entry.pop(key)
        if entry.get("tag") and entry["tag"] not in joints:
            entry.pop("tag")
            entry.pop("model", None)


# --- The composition rule, and checking it against the game -------------------


def compose(base, entries):
    """`resolveWeapon` in Python: `base` with every entry in `entries` fitted.

    The one place the composition rule is written down on this side, because
    `check_variants` uses it to prove the rule against Modern Warfare 2's own
    weapon files. It must agree with `resolveWeapon` in
    `@3d/shared/sim/weaponRegistry.ts` — slot order, the same three maps merged
    key by key, and the same second pass for the aiming clips.
    """
    out = {key: (dict(value) if isinstance(value, dict) else value) for key, value in base.items()}
    out["hideTags"] = set(base["hideTags"])
    for entry in entries:
        overrides = entry.get("overrides") or {}
        for key in ("clipSize", "fireType", "adsZoomFov", "adsOverlay"):
            if key in overrides:
                out[key] = overrides[key]
        for key in ("roles", "times", "motion", "sounds"):
            if key in overrides:
                out[key] = {**out[key], **overrides[key]}
        out["hideTags"].update(entry.get("hideBones", ()))
        out["hideTags"].difference_update(entry.get("showBones", ()))

    # A fitted optic authors the aiming clips, and the scope picture, whatever
    # else is on the gun.
    for entry in entries:
        if entry.get("type") == SIGHT_TYPE:
            overrides = entry.get("overrides") or {}
            out["roles"].update({r: c for r, c in (overrides.get("roles") or {}).items() if r in ADS_ROLES})
            if "adsOverlay" in overrides:
                out["adsOverlay"] = overrides["adsOverlay"]
    return out


def check_variants(base_name, base_info, variants, entries):
    """Rebuild each of this weapon's multi-attachment weapon files from `entries`; return the ones that differ.

    Modern Warfare 2 ships the answers: `aa12_eotech_grip_mp` is what the game
    itself says an AA-12 with both is. Composing two single-attachment deltas has
    to reproduce it exactly, or the catalogue's numbers are only plausible — and
    plausible is the failure this whole pipeline is prone to. Across all 43 base
    weapons that is 806 combinations, and 801 reproduce; the five that do not are
    named in `tests/test_attachments.py` (docs/cod/reference.md#the-two-recoils).
    """
    by_id = {entry["id"]: entry for entry in entries}
    base = spec_of(base_info)
    wrong = []
    for name, tokens in split_variants(base_name, variants).items():
        if len(tokens) < 2 or any(token not in by_id for token in tokens):
            continue
        fitted = sorted((by_id[token] for token in tokens), key=sort_key)
        mine, real = compose(base, fitted), spec_of(variants[name])
        differs = sorted(key for key in real if mine[key] != real[key])
        if differs:
            wrong.append((name, differs))
    return wrong


def derived_tag(model):
    """The gun tag a model's name implies: `viewmodel_as50_scope_iw5` -> `tag_as50_scope`, `vm_foregrip` -> `tag_foregrip`."""
    name = model.removeprefix("viewmodel_").removeprefix("vm_")
    for suffix in ("_iw5", "_iw4", "_t5"):
        name = name.removesuffix(suffix)
    return f"tag_{name}"


def resolve_mounts(entries, joints):
    """Give each attachment that has a model but no tag of its own the gun's, in place.

    **A rigid attachment model carries no joints at all.** A skinned one says
    where it goes — its root joint *is* the gun tag it belongs on — but five of
    IW5's sniper scopes are rigid, and OAT exports those as bare meshes with no
    bone anywhere in the file.

    The gun says it instead: it carries one scope tag of its own, named after the
    model. The Barrett proves the rule, being the one sniper scope that *is*
    skinned — `viewmodel_m82_scope_iw5`'s root joint is `tag_m82_scope`, which is
    exactly what the rifle carries. So the name is derived and used when the gun
    has it, which settles the AS50, the RSASS and the Dragunov as well.

    Two guns do not follow it: the MSR's and the L96A1's scopes mount on a plain
    `tag_scope`. For those the answer is the gun's own scope tag that no other
    attachment has claimed — and when that is not exactly one tag, the model is
    dropped rather than guessed at, because a scope on the wrong tag is a scope
    floating beside the rifle and nothing downstream would complain.
    """
    claimed = {entry["tag"] for entry in entries if entry.get("tag")}
    unclaimed = sorted(j for j in joints if SCOPE_TAG in j and NOT_A_MOUNT not in j and j not in claimed)
    for entry in entries:
        if not entry.get("model") or entry.get("tag"):
            continue
        derived = derived_tag(entry["model"])
        if derived in joints:
            entry["tag"] = derived
        elif len(unclaimed) == 1:
            entry["tag"] = unclaimed[0]


# --- S1: an attachment is a list of edits to the weapon -------------------------

# S1 splits `siderail` (a laser, a tracker, a hacking tool) out of `other`; the
# slot order and the aiming-clip rule know three kinds.
S1_TYPES = {"scope": "scope", "underbarrel": "underbarrel", "siderail": "other", "other": "other"}
# An S1 attachment that shares the host's ammunition, or sets a round's damage or
# a magazine outright, is a second weapon: the launcher's one round of 135, the
# underbarrel shotgun's eight pellets. As with IW5's `ammunition`, its numbers
# are not the host's; its clips and its model are.
S1_ALT_WEAPON_KEYS = ("damage", "clipSize")
# The maps `resolveWeapon` merges key by key beside `times` and `motion`: what a
# server judges a shot by, which a long barrel or a laser changes on S1.
BALLISTIC_MAPS = ("damage", "spread", "locationDamage")


def s1_second_weapon(attach):
    """Whether an S1 attachment describes the weapon it adds rather than a change to its host."""
    if attach.get("shareAmmoWithAlt"):
        return True
    return any(e["op"] == "set" and e.get("key") in S1_ALT_WEAPON_KEYS for e in attach.get("fields") or [])


def _spelled(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    return f"{value:g}" if isinstance(value, float) else str(value)


def s1_apply(info, edits):
    """A weapon file with S1 edits made, in order: `set` replaces a value, `scale` multiplies it.

    An edit to a member no weapon-file key names changes nothing here. A scaled
    whole number is rounded; whether the game truncates instead is not known,
    and it moves a magazine by one round at most."""
    out = dict(info)
    for edit in edits:
        key, value = edit.get("key"), edit["value"]
        if key is None or key not in out:
            continue
        if edit["op"] == "set":
            out[key] = _spelled(value)
        elif (current := _number(out, key)) is not None:
            if edit["type"] == "int":
                out[key] = str(round(current * value))
            elif edit["type"] == "ms":
                out[key] = _spelled(round(current * value * 1000) / 1000)
            else:
                out[key] = _spelled(current * value)
    return out


def s1_roles(info, name):
    """{role: clip} this attachment alone plays on this weapon, from the weapon's own `animOverrides`."""
    roles_by_key = {key: role for role, key in CLIP_ROLES.items()}
    roles = {}
    for line in (info.get("animOverrides") or "").split("\n"):
        parts = line.split()
        if len(parts) == 7 and parts[:2] == [name, "none"] and parts[2] in roles_by_key and parts[3] != "none":
            roles[roles_by_key[parts[2]]] = parts[3]
    return roles


def s1_fold_automatic(info, defs):
    """A weapon file with its automatic attachments' edits made: they are part of the weapon, not choices.

    A sniper rifle's own scope is one (`gm6scope` sets its 15-degree zoom), and so
    is anything S1 flags `automaticAttachment`. A second weapon among them is
    left alone, as it is when fitted."""
    for name in accepted(info):
        attach = defs.get(name)
        if attach and attach.get("automaticAttachment") and not s1_second_weapon(attach):
            info = s1_apply(info, attach.get("fields") or [])
    return info


def s1_entry(name, attach, info, model=None, tag=None):
    """One S1 attachment against one weapon, in that weapon's own absolute numbers.

    Its edits are made to a copy of the weapon file and the result diffed
    against the original over what `WeaponDef` keeps, which is `iw4_entry`'s
    shape with the variant computed rather than shipped."""
    base = spec_of(info)
    overrides = {}
    if not s1_second_weapon(attach):
        edited = s1_apply(info, attach.get("fields") or [])
        variant = spec_of(edited)
        for key in ("clipSize", "fireType", "adsZoomFov", "adsOverlay"):
            if base[key] != variant[key]:
                overrides[key] = variant[key]
        for key in ("times", "motion"):
            if changed := {k: v for k, v in variant[key].items() if base[key].get(k) != v}:
                overrides[key] = changed
        before, after = ballistics(info), ballistics(edited)
        for key in BALLISTIC_MAPS:
            if changed := {k: v for k, v in after[key].items() if before[key].get(k) != v}:
                overrides[key] = changed
        if sounds := {k: v for k, v in base["soundOverrides"].get(name, {}).items() if base["sounds"].get(k) != v}:
            overrides["sounds"] = sounds
    # The clips are the host's own, held differently (a launcher's grip), so a
    # second weapon brings them too.
    if roles := {r: c for r, c in s1_roles(info, name).items() if base["roles"].get(r) != c}:
        overrides["roles"] = roles
    entry = _entry(name, S1_TYPES.get(attach.get("type")), attach.get("displayName"))
    if model:
        entry["model"] = model
        if tag:
            entry["tag"] = tag
    hide = {IRON_SIGHT} if attach.get("hideIronSightsWithThisAttachment") else set()
    return _with_overrides(entry, overrides, hide)


def s1_offered(entry):
    """Whether an S1 attachment changes anything the catalogue carries: numbers, clips or what is drawn.

    S1 guns list up to 21, against a wire that carries 16. What is left out is
    what nothing downstream could show: a stock with no edits at all, a dual
    magazine whose reloads have no role, a tracker whose model is its only
    trace. A model alone is not enough; it mounts, and does nothing."""
    return bool(entry.get("overrides") or entry.get("hideBones") or entry.get("showBones"))


def s1_distinct(entries):
    """`entries` less any that repeats an earlier one in all but the ADS sway.

    Every AW rifle lists `opticsacog2` and `opticsacog2ar`, and `opticsthermal`
    and `opticsthermalar`: one model, one pair of aiming clips, and numbers that
    differ only in `adsIdleAmount`/`adsIdleSpeed`. Which of the two the game's
    menu offers is not in the zone; offering both would put two ACOGs in one
    menu, and five rifles past the wire's sixteen."""
    kept = []
    for entry in entries:
        motionless = _without_motion(entry)
        if not any(_without_motion(k) == motionless for k in kept):
            kept.append(entry)
    return kept


def _without_motion(entry):
    overrides = {k: v for k, v in (entry.get("overrides") or {}).items() if k != "motion"}
    rest = {k: v for k, v in entry.items() if k not in ("id", "display", "overrides")}
    return rest, overrides


# --- T6: an attachment and its unique ------------------------------------------

T6_UNIQUE_DIR = "attachmentunique"
T6_ATTACHMENT_DIR = "attachment"
# `szAttachmentTypeNames`, by what each is to the slot order and the aiming-clip rule.
# `is` is a pistol's iron-sight upgrade; `mms` the millimetre-wave scanner, sighted
# through; `ir` the thermal scope. `dw` (dual wield) is not offered: the engine draws one gun.
T6_TYPES = {
    "acog": "scope",
    "dualoptic": "scope",
    "holo": "scope",
    "ir": "scope",
    "is": "scope",
    "mms": "scope",
    "rangefinder": "scope",
    "reflex": "scope",
    "vzoom": "scope",
    "gl": "underbarrel",
    "grip": "underbarrel",
    "mk": "underbarrel",
}
T6_NOT_OFFERED = ("none", "dw")
# What a T6 attachment writes where it means "leave the weapon's own": a zoom of 1, a
# sway override off, and -300 in the view offsets (all 48 attachments; never a real value).
T6_UNSET_FOV = 1.0
T6_UNSET_OFFSET = -300.0
# Which of `WeaponDef.times` each timer scale multiplies.
T6_TIME_SCALES = {
    "fireTimeScale": ("fire",),
    "reloadTimeScale": ("reload",),
    "reloadEmptyTimeScale": ("reloadEmpty",),
    "reloadAddTimeScale": ("reloadAdd",),
    "adsTransInTimeScale": ("adsIn",),
    "adsTransOutTimeScale": ("adsOut",),
}
T6_SPREAD_SCALES = {
    "hipSpreadMinScale": ("hipStandMin", "hipDuckedMin", "hipProneMin"),
    "hipSpreadMaxScale": ("hipStandMax", "hipDuckedMax", "hipProneMax"),
}
T6_MOTION_SCALES = {"adsViewKickCenterSpeedScale": "adsViewKickCenterSpeed", "adsIdleAmountScale": "adsIdleAmount"}
T6_SWAY = ("MaxAngle", "LerpSpeed", "PitchScale", "YawScale", "HorizScale", "VertScale")
# The view offsets an attachment may set; `standRotY` is 0 rather than -300 when unset, so it is not read.
T6_VIEW_OFFSETS = ("standMoveF", "standRotP", "standRotR")
# The roles a unique's clips are compared on, and the unique's two fire sounds.
T6_SOUNDS = {"fire": "fireSound", "firePlayer": "fireSoundPlayer"}


def t6_read(work):
    """{"attachment": {name: infostring}, "unique": {name: infostring}} out of a T6 dump."""
    out = {}
    for key, folder in (("attachment", T6_ATTACHMENT_DIR), ("unique", T6_UNIQUE_DIR)):
        root = os.path.join(work, ATTACH_DIR, folder)
        out[key] = {}
        for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
            with open(os.path.join(root, name), encoding="latin-1") as fh:
                _, _, rest = fh.read().partition("\\")
            out[key][name] = parse_infostring("WEAPONFILE\\" + rest)
    return out


def t6_unique(info, kind, uniques):
    """The weapon's own `au_<gun>_<kind>`: the one its `attachmentUniques` lists for that type alone."""
    for name in (info.get("attachmentUniques") or "").split("\n"):
        unique = uniques.get(name.strip())
        if unique is not None and "+" not in name and unique.get("attachmentType") == kind:
            return unique
    return None


def _scaled(values, keys, factor):
    return {k: round(values[k] * factor, 6) for k in keys if k in values}


def t6_numbers(attach, info):
    """`overrides` from a WeaponAttachment's scales and absolutes, against one weapon file."""
    base = spec_of(info)
    shot = ballistics(info)
    overrides, times, motion, spread, damage = {}, {}, {}, {}, {}
    number = lambda key: _number(attach, key)  # noqa: E731
    for key, roles in T6_TIME_SCALES.items():
        if (factor := number(key)) not in (None, 1.0):
            times.update(_scaled(base["times"], roles, factor))
    for key, keys in T6_SPREAD_SCALES.items():
        if (factor := number(key)) not in (None, 1.0):
            spread.update(_scaled(shot["spread"], keys, factor))
    if (factor := number("damageRangeScale")) not in (None, 1.0):
        damage.update(_scaled(shot["damage"], ("maxRange", "minRange"), factor))
    for key, target in T6_MOTION_SCALES.items():
        if (factor := number(key)) not in (None, 1.0):
            motion.update(_scaled(base["motion"], (target,), factor))
    for prefix, flag in (("sway", "swayOverride"), ("adsSway", "adsSwayOverride")):
        if number(flag) == 1:
            motion.update({f"{prefix}{k}": number(f"{prefix}{k}") for k in T6_SWAY if number(f"{prefix}{k}") is not None})
    if number("hipIdleAmount"):
        motion["hipIdleAmount"] = number("hipIdleAmount")
    motion.update({k: number(k) for k in T6_VIEW_OFFSETS if number(k) not in (None, T6_UNSET_OFFSET)})
    if (fov := number("adsZoomFov1")) not in (None, T6_UNSET_FOV):
        overrides["adsZoomFov"] = fov
    if (factor := number("clipSizeScale")) not in (None, 1.0) and base["clipSize"]:
        overrides["clipSize"] = round(base["clipSize"] * factor)
    for key, value in (("times", times), ("motion", motion), ("spread", spread), ("damage", damage)):
        if changed := {k: v for k, v in value.items() if (base.get(key) or shot.get(key) or {}).get(k) != v}:
            overrides[key] = changed
    return overrides


def t6_entry(name, attach, unique, none, info):
    """One T6 attachment against one weapon: its generic numbers and its unique's clips, sounds and hides.

    The unique carries the whole clip set, so a role is taken where it differs from
    the weapon's own `au_<gun>_none` (or from the weapon file, where that names no
    clips). A unique naming an `altWeapon` (the grenade launcher, select fire, the
    dual optic) is a second weapon, as IW5's `ammunition` is: its clips and hides
    are taken, its numbers and sounds are not.

    **Its model is not mounted yet.** A T6 attachment model is rigid and hangs at
    `viewModelTag` (usually empty) plus `viewModelOffset*`, in the gun's frame, which
    the engine's `tag` cannot express (reference.md#black-ops-ii-weapons). So an
    attachment with a model changes nothing drawn: hiding the raised sights under a
    scope nobody draws leaves no sights, and showing the folded ones beside them two.
    """
    kind = attach.get("attachmentType", "")
    second = bool((unique or {}).get("altWeapon"))
    overrides = {} if second else t6_numbers(attach, info)
    if unique:
        against = none if none and any((none.get(k) or "").strip() for k in CLIP_ROLES.values()) else info
        roles = {
            r: c for r, k in CLIP_ROLES.items() if (c := (unique.get(k) or "").strip()) and c != (against.get(k) or "").strip()
        }
        if roles:
            overrides["roles"] = roles
        own = weapon_sounds(info)
        sounds = {f: a for f, k in T6_SOUNDS.items() if (a := (unique.get(k) or "").strip()) and own.get(f) != a}
        if sounds and not second:
            overrides["sounds"] = sounds
        if (overlay := unique.get("adsOverlayShader") or None) != (info.get("adsOverlayShader") or None):
            overrides["adsOverlay"] = overlay
    entry = _entry(name, T6_TYPES.get(kind), attach.get("displayName"))
    tags = lambda u: {t.strip() for t in ((u or {}).get("hideTags") or "").split("\n") if t.strip()}  # noqa: E731
    base_hidden = tags(none) if none else tags(info)
    drawn = unique is not None and not unique.get("viewModel")
    hide = tags(unique) - base_hidden if drawn else set()
    show = base_hidden - tags(unique) if drawn else set()
    return _with_overrides(entry, overrides, hide, show)


def t6_entries(weapon, info, defs, models=None):
    """Every attachment a T6 weapon lists, bar the default and dual wield, in slot order."""
    uniques = defs.get("unique") or {}
    none = t6_unique(info, "none", uniques)
    entries = []
    for name in accepted(info):
        attach = (defs.get("attachment") or {}).get(name)
        if attach is None or attach.get("attachmentType") in T6_NOT_OFFERED:
            continue
        entries.append(t6_entry(name, attach, t6_unique(info, attach["attachmentType"], uniques), none, info))
    return entries
