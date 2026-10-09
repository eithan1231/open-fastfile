"""`fx`: each effect as `fx/<name>.json`, in game units, in IW5's schema plus T5's own members.

The three traps of IW5's writer hold here too (iw5/dumpers/fx.py): types are written
as names, read from T5's own enum (it adds `SPRITE_ROTATED` and `LINE` and renumbers
from index 2 on); `spawnKind` comes from the elem's position; absent sample arrays
stay empty. What T5 adds or moves:

- its bytes are `char`, **signed** in the zone code, so a colour, `lightingFrac` or
  `sortOrder` above 127 would read negative: each is unpacked as unsigned instead;
- the trail hangs off the elem (`trailDef`), with an integer `splitDist`;
- `collMins`/`collMaxs` replace IW5's `collBounds`, and the atlas packs its entry
  count and index range into one u16, written raw;
- there are no light defs: a light is drawn from its visual state alone.
"""

import json

from ...iw5.dumpers.fx import ATLAS_FIELDS, elem_type_names, frange, franges, name_of, ref_name, vel_samples
from ...iw6.dumpers.common import asset_path

GAME = "t5"
FOLDER = "fx"
MATERIAL_TYPES = (
    "SPRITE_BILLBOARD",
    "SPRITE_ORIENTED",
    "SPRITE_ROTATED",
    "TAIL",
    "LINE",
    "TRAIL",
    "CLOUD",
)
TRAIL_FIELDS = ("scrollTimeMsec", "repeatDist", "splitDist")
WIND_FIELDS = ("maxWindStrength", "spawnIntervalAtMaxWind", "lifespanAtMaxWind")


def visual_state(v):
    """FxElemVisualState: four colour bytes, rotation delta and total, size[2], scale."""
    return {"color": list(v[:4]), "rotationDelta": v[4], "rotationTotal": v[5], "size": list(v[6:8]), "scale": v[8]}


def vis_samples(array):
    out = []
    for v in array.unpack("<4B5f4B5f") if array is not None else ():
        out.append({"base": visual_state(v[:9]), "amplitude": visual_state(v[9:])})
    return out


def u8(record, path):
    return record.unpack("<B", path)[0]


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
        if kind in MATERIAL_TYPES:
            return {"kind": "material", "name": name_of(vis["material"])}
        return {"kind": "none"}

    def visuals(self, elem, kind):
        """DECAL reads `markArray`; more than one visual reads `array`; else the inline instance."""
        visuals, count = elem["visuals"], u8(elem, "visualCount")
        if kind == "DECAL":
            return {
                "kind": "markArray",
                "marks": [{"materials": [name_of(m) for m in mark["materials"]]} for mark in visuals["markArray"] or ()],
            }
        if count > 1:
            return {"kind": "array", "entries": [self.visual(v, kind) for v in visuals["array"] or ()]}
        return self.visual(visuals["instance"], kind)

    @staticmethod
    def trail(elem):
        trail = elem["trailDef"]
        if trail is None:
            return None
        verts, inds = trail["verts"], trail["inds"]
        return {
            "kind": "trail",
            **{k: trail[k] for k in TRAIL_FIELDS},
            "verts": [
                {"pos": [v[0], v[1]], "normal": [v[2], v[3]], "texCoord": v[4]}
                for v in (verts.unpack("<5f") if verts is not None else ())
            ],
            "inds": [i for (i,) in inds.unpack("<H")] if inds is not None else [],
        }

    def elem(self, elem, index, spawn_kind):
        type_index = u8(elem, "elemType")
        kind = self.types[type_index]
        if spawn_kind == "looping":
            spawn = {"kind": "looping", "intervalMsec": elem["spawn.looping.intervalMsec"], "count": elem["spawn.looping.count"]}
        else:
            spawn = {"kind": spawn_kind, "count": frange(elem, "spawn.oneShot.count", "i")}
        # `u` is a billboard's trim, or a cloud's density range, by type.
        if kind == "CLOUD":
            union = {"kind": "cloudDensityRange", **frange(elem, "u", "i")}
        else:
            top, bottom = elem.unpack("<2f", "u")
            union = {"kind": "billboard", "topWidth": top, "bottomWidth": bottom}
        atlas = {k: u8(elem, f"atlas.{k}") for k in ATLAS_FIELDS if k != "entryCount"}
        atlas["entryCountAndIndexRange"] = elem.unpack("<H", "atlas.entryCountAndIndexRange")[0]
        return {
            "index": index,
            "type": kind,
            "typeIndex": type_index,
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
            "rotationAxis": elem["rotationAxis"],
            "gravity": frange(elem, "gravity"),
            "reflectionFactor": frange(elem, "reflectionFactor"),
            "atlas": atlas,
            "windInfluence": elem["windInfluence"],
            **{k: elem[k] for k in WIND_FIELDS},
            "visualCount": u8(elem, "visualCount"),
            "velIntervalCount": u8(elem, "velIntervalCount"),
            "visStateIntervalCount": u8(elem, "visStateIntervalCount"),
            "visuals": self.visuals(elem, kind),
            "collMins": list(elem.unpack("<3f", "collMins")),
            "collMaxs": list(elem.unpack("<3f", "collMaxs")),
            "emitDist": frange(elem, "emitDist"),
            "emitDistVariance": frange(elem, "emitDistVariance"),
            "extended": self.trail(elem) if kind == "TRAIL" else None,
            "sortOrder": u8(elem, "sortOrder"),
            "lightingFrac": u8(elem, "lightingFrac"),
            "alphaFadeTimeMsec": elem["alphaFadeTimeMsec"],
            "union": union,
            "spawnSound": elem["spawnSound.spawnSound"],
            "billboardPivot": list(elem.unpack("<2f", "billboardPivot")),
            "effectOnImpact": ref_name(elem["effectOnImpact"]),
            "effectOnDeath": ref_name(elem["effectOnDeath"]),
            "effectEmitted": ref_name(elem["effectEmitted"]),
            "effectAttached": ref_name(elem["effectAttached"]),
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
            "flags": u8(fx, "flags"),
            "efPriority": fx["efPriority"],
            "totalSize": fx["totalSize"],
            "msecLoopingLife": fx["msecLoopingLife"],
            "elemCounts": {"looping": looping, "oneShot": one_shot, "emission": emission, "total": total},
            "boundingBoxDim": list(fx.unpack("<3f", "boundingBoxDim")),
            "boundingSphere": list(fx.unpack("<4f", "boundingSphere")),
            "elems": elems,
        }


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
