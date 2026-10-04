"""`fx`: each effect as `fx/<name>.json`, in game units.

Three things in an `FxEffectDef` are decided by something other than a flag, and
each misread yields a plausible wrong effect rather than an error
(docs/cod/pipeline.md#the-dump-tree):

- an elem's **type is written as its name**, read from IW5's own enum in the load
  program: T5's list diverges from index 2 on, so the number alone is the wrong
  element in the other game;
- which member of the `spawn` union is live is the elem's **position** in
  `elemDefs` (looping, then oneShot, then emission), written as `spawnKind`;
- `velSamples`/`visSamples` are `intervalCount + 1` long **where the pointer is
  set**: a RUNNER has no `visSamples` at all, so an absent array stays empty.

An asset a visual names is written by its name as the zone spells it, a comma
included, as OpenAssetTools' writer read it off the stub.
"""

import json

from ...iw6.dumpers.common import asset_path
from . import GAME, dumper

FOLDER = "fx"
# The members of FxElemVisuals each type reads, as the zone code selects them.
MATERIAL_TYPES = ("SPRITE_BILLBOARD", "SPRITE_ORIENTED", "TAIL", "TRAIL", "CLOUD", "SPARK_CLOUD", "SPARK_FOUNTAIN")
TRAIL_FIELDS = ("scrollTimeMsec", "repeatDist", "invSplitDist", "invSplitArcDist", "invSplitTime")
SPARK_FIELDS = (
    "gravity bounceFrac bounceRand sparkSpacing sparkLength sparkCount loopTime velMin velMax "
    "velConeFrac restSpeed boostTime boostFactor"
).split()
SPOT_FIELDS = ("fovInnerFraction", "startRadius", "endRadius", "brightness", "maxLength", "exponent")
ATLAS_FIELDS = ("behavior", "index", "fps", "loopCount", "colIndexBits", "rowIndexBits", "entryCount")


def elem_type_names(enums):
    """IW5's FxElemType, index -> name, from the load program's enum values (not a hand-kept list)."""
    prefix = "FX_ELEM_TYPE_"
    names = {}
    for key, value in enums.items():
        name = key[len(prefix) :]
        if key.startswith(prefix) and name != "COUNT" and not name.startswith("LAST_"):
            names.setdefault(value, name)
    count = enums[prefix + "COUNT"]
    if sorted(names) != list(range(count)):
        raise SystemExit(f"IW5's FxElemType in the load program is not 0..{count - 1}: {names}")
    return [names[i] for i in range(count)]


def frange(record, path, code="f"):
    base, amplitude = record.unpack(f"<2{code}", path)
    return {"base": base, "amplitude": amplitude}


def franges(record, path, count=3):
    values = record.unpack(f"<{2 * count}f", path)
    return [{"base": values[2 * i], "amplitude": values[2 * i + 1]} for i in range(count)]


def vec3_range(values):
    return {"base": list(values[:3]), "amplitude": list(values[3:6])}


def vel_frame(v):
    """FxElemVelStateInFrame (12 floats): a velocity range, then a total delta range."""
    return {"velocity": vec3_range(v[:6]), "totalDelta": vec3_range(v[6:12])}


def vel_samples(array):
    """FxElemVelStateSample: local, then world."""
    return [{"local": vel_frame(v[:12]), "world": vel_frame(v[12:])} for v in (array.unpack("<24f") if array is not None else ())]


def visual_state(v):
    """FxElemVisualState: four colour bytes, rotation delta and total, size[2], scale."""
    return {"color": list(v[:4]), "rotationDelta": v[4], "rotationTotal": v[5], "size": list(v[6:8]), "scale": v[8]}


def vis_samples(array):
    out = []
    for v in array.unpack("<4B5f4B5f") if array is not None else ():
        out.append({"base": visual_state(v[:9]), "amplitude": visual_state(v[9:])})
    return out


def name_of(value):
    """An asset's name as the zone spells it (a stub keeps its comma), a string as is; None when null."""
    if value is None:
        return None
    return value if isinstance(value, str) else value.name


def ref_name(ref):
    """An FxEffectDefRef: the zone code loads its `name`, never a handle."""
    return None if ref is None else ref["name"]


class Writer:
    def __init__(self, walk):
        self.types = elem_type_names(walk.program.data["enums"])

    def visual(self, vis, kind):
        """One FxElemVisuals, read through the member `kind` selects, as the zone code does."""
        if kind == "MODEL":
            return {"kind": "model", "name": name_of(vis["model"])}
        if kind == "RUNNER":
            return {"kind": "effect", "name": ref_name(vis["effectDef"])}
        if kind == "SOUND":
            return {"kind": "sound", "name": vis["soundName"]}
        if kind == "SPOT_LIGHT":
            return {"kind": "light", "name": name_of(vis["lightDef"])}
        if kind in MATERIAL_TYPES:
            return {"kind": "material", "name": name_of(vis["material"])}
        return {"kind": "none"}

    def visuals(self, elem, kind):
        """DECAL reads `markArray`; more than one visual reads `array`; else the inline instance."""
        visuals, count = elem["visuals"], elem["visualCount"]
        if kind == "DECAL":
            marks = visuals["markArray"]
            return {
                "kind": "markArray",
                "marks": [{"materials": [name_of(m) for m in mark["materials"]]} for mark in marks or ()],
            }
        if count > 1:
            entries = visuals["array"]
            return {"kind": "array", "entries": [self.visual(v, kind) for v in entries or ()]}
        return self.visual(visuals["instance"], kind)

    @staticmethod
    def extended(elem, kind):
        ext = elem["extended"]
        if kind == "TRAIL":
            trail = ext["trailDef"]
            if trail is None:
                return None
            verts = trail["verts"]
            inds = trail["inds"]
            return {
                "kind": "trail",
                **{k: trail[k] for k in TRAIL_FIELDS},
                "verts": [
                    {"pos": [v[0], v[1]], "normal": [v[2], v[3]], "texCoord": v[4]}
                    for v in (verts.unpack("<5f") if verts is not None else ())
                ],
                "inds": [i for (i,) in inds.unpack("<H")] if inds is not None else [],
            }
        if kind == "SPARK_FOUNTAIN":
            fountain = ext["sparkFountainDef"]
            return None if fountain is None else {"kind": "sparkFountain", **{k: fountain[k] for k in SPARK_FIELDS}}
        if kind == "SPOT_LIGHT":
            spot = ext["spotLightDef"]
            return None if spot is None else {"kind": "spotLight", **{k: spot[k] for k in SPOT_FIELDS}}
        return None

    def elem(self, elem, index, spawn_kind):
        kind = self.types[elem["elemType"]]
        if spawn_kind == "looping":
            spawn = {"kind": "looping", "intervalMsec": elem["spawn.looping.intervalMsec"], "count": elem["spawn.looping.count"]}
        else:
            spawn = {"kind": spawn_kind, "count": frange(elem, "spawn.oneShot.count", "i")}
        bounds = elem.unpack("<6f", "collBounds")
        return {
            "index": index,
            "type": kind,
            "typeIndex": elem["elemType"],
            "flags": elem["flags"],
            "spawnKind": spawn_kind,
            "spawn": spawn,
            "spawnRange": frange(elem, "spawnRange"),
            "fadeInRange": frange(elem, "fadeInRange"),
            "fadeOutRange": frange(elem, "fadeOutRange"),
            "spawnFrustumCullRadius": elem["spawnFrustumCullRadius"],
            "spawnDelayMsec": frange(elem, "spawnDelayMsec", "i"),
            "lifeSpanMsec": frange(elem, "lifeSpanMsec", "i"),
            "spawnOrigin": franges(elem, "spawnOrigin"),
            "spawnOffsetRadius": frange(elem, "spawnOffsetRadius"),
            "spawnOffsetHeight": frange(elem, "spawnOffsetHeight"),
            "spawnAngles": franges(elem, "spawnAngles"),
            "angularVelocity": franges(elem, "angularVelocity"),
            "initialRotation": frange(elem, "initialRotation"),
            "gravity": frange(elem, "gravity"),
            "reflectionFactor": frange(elem, "reflectionFactor"),
            "atlas": {k: elem[f"atlas.{k}"] for k in ATLAS_FIELDS},
            "visualCount": elem["visualCount"],
            "velIntervalCount": elem["velIntervalCount"],
            "visStateIntervalCount": elem["visStateIntervalCount"],
            "visuals": self.visuals(elem, kind),
            "collBounds": {"midPoint": list(bounds[:3]), "halfSize": list(bounds[3:])},
            "emitDist": frange(elem, "emitDist"),
            "emitDistVariance": frange(elem, "emitDistVariance"),
            "extended": self.extended(elem, kind),
            "sortOrder": elem["sortOrder"],
            "lightingFrac": elem["lightingFrac"],
            "useItemClip": elem["useItemClip"],
            "fadeInfo": elem["fadeInfo"],
            "randomSeed": elem["randomSeed"],
            "effectOnImpact": ref_name(elem["effectOnImpact"]),
            "effectOnDeath": ref_name(elem["effectOnDeath"]),
            "effectEmitted": ref_name(elem["effectEmitted"]),
            "velSamples": vel_samples(elem["velSamples"]),
            "visSamples": vis_samples(elem["visSamples"]),
        }

    def effect(self, asset):
        fx = asset.record
        looping, one_shot, emission = fx["elemDefCountLooping"], fx["elemDefCountOneShot"], fx["elemDefCountEmission"]
        total = looping + one_shot + emission  # one array, all three kinds back to back
        elems = []
        for i, elem in enumerate(list(fx["elemDefs"] or ())[:total]):
            spawn_kind = "looping" if i < looping else "oneShot" if i < looping + one_shot else "emission"
            elems.append(self.elem(elem, i, spawn_kind))
        return {
            "_type": "fx",
            "_version": 1,
            "_game": GAME,
            "name": asset.name,
            "flags": fx["flags"],
            "totalSize": fx["totalSize"],
            "msecLoopingLife": fx["msecLoopingLife"],
            "elemCounts": {"looping": looping, "oneShot": one_shot, "emission": emission, "total": total},
            "occlusionQueryDepthBias": fx["occlusionQueryDepthBias"],
            "occlusionQueryFadeIn": fx["occlusionQueryFadeIn"],
            "occlusionQueryFadeOut": fx["occlusionQueryFadeOut"],
            "occlusionQueryScaleRange": frange(fx, "occlusionQueryScaleRange"),
            "elems": elems,
        }


@dumper("fx")
def write(walk, out, ctx=None):
    writer = Writer(walk)
    found = walk.by_type("fx")
    written = 0
    for asset in found:
        if asset.name.startswith(","):
            continue  # another zone's: a stub with a name and nothing else
        with open(asset_path(out, f"{FOLDER}/{asset.name}.json"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps(writer.effect(asset), indent=4, sort_keys=True, ensure_ascii=False) + "\n")
        written += 1
    print(f"      {written} of {len(found)} effects written")
