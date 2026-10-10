"""FX effect definitions: the closure a map needs, converted to engine units.

The `fx` dump is one JSON per `FxEffectDef` (docs/cod/pipeline.md#the-dump-tree).
A map names effects through its createfx script, and
those effects name more through their children, so the set a world ships is a
transitive closure rather than the whole zone.

Two conventions here were established from the dumped data rather than assumed,
because both are silently wrong-looking rather than broken (see
docs/cod/reference.md):

- A range is `base + amplitude * rand01`, with **amplitude signed**. It is not
  `base = min, amplitude = span`: `spawnAngles` ships `base 2pi, amplitude -4pi`,
  a full turn either way, and `angularVelocity` ships ranges symmetric about
  zero. Read as min/span, 192 of mp_dome's 6,405 ranges are inside out.
- `velocity` and `totalDelta` are **rates in units per millisecond**, not
  displacements and not per-second. Every magnitude checks out against what the
  effect is named once read that way: dust motes in a light shaft drift 0.38 m
  over their 3 s life, ceiling ash falls 12.7 m over 10 s.
"""

import math
import os

from .files import read_json, write_json
from .materials import colour_map, drawn_state, material_file_stem, material_render_state
from .units import UNITS_PER_M

# The types the runtime draws today. Anything else is exported (the definition is
# cheap and complete) but counted, so a missing element is a number in the log
# rather than an absence nobody notices.
DRAWN_TYPES = ("SPRITE_BILLBOARD", "SPRITE_ORIENTED", "SPRITE_ROTATED", "TAIL", "LINE", "CLOUD", "RUNNER")

# A looping elem spawns for ever rather than a finite number of times.
SPAWN_FOREVER = 2147483647


def ref(name):
    """An asset name as identity: no companion-zone marker, and lower case.

    Two normalisations, both of which cost an effect if skipped:

    - A leading comma means the asset is defined in another fastfile
      (common_mp.ff). It is linkage, not part of the name: left on, every lookup
      misses -- dome's sandstorm draws `,gfx_wind_hl_atlas`, whose material file
      is `gfx_wind_hl_atlas`.
    - Names are matched case-insensitively, as the game matches them. Every one of
      the 581 fx and 560 visual names in MW3's zones is lower case, but the GSC
      scripts are not: 12 maps call `loadfx("smoke/battlefield_smokebank_S")` for
      an asset stored as `..._s`. Matched exactly, each of those maps silently
      loses an effect.
    """
    return (name[1:] if name.startswith(",") else name).lower()


def _range(r, scale=1.0):
    """A dumped FxFloatRange/FxIntRange as [base, amplitude], both scaled.

    The transform is linear, so amplitude scales exactly as base does -- including
    a negative scale, which flips the interval end for end and is what makes the
    axis swap below correct for a signed amplitude.
    """
    return [r["base"] * scale, r["amplitude"] * scale]


def _range_triple(ranges, scale=1.0):
    """Three CoD-axis ranges as engine-axis ranges: (x, y, z) -> (x, z, -y)."""
    x, y, z = ranges
    return [_range(x, scale), _range(z, scale), _range(y, -scale)]


def _vec3(v):
    return [v[0] / UNITS_PER_M, v[2] / UNITS_PER_M, -v[1] / UNITS_PER_M]


def _per_ms3(v):
    """A CoD units-per-millisecond triple as engine metres-per-millisecond, axes swapped.

    Kept per millisecond on purpose: `totalDelta` is the integral of `velocity`
    over *sample index*, so travel is recovered by multiplying by the duration of
    one sample step (life / intervals), which the runtime knows and this does not.
    """
    return [v[0] / UNITS_PER_M, v[2] / UNITS_PER_M, -v[1] / UNITS_PER_M]


def _rgba(c):
    """A stored colour in D3D byte order (B, G, R, A) as RGBA in 0..1.

    Read in stored order, every tinted effect comes out with red and blue
    swapped: blood blue, fire violet-blue, dome's tan sandstorm blue-grey.
    Established over the 581 MW3 effects -- all 649 tinted blood samples and all
    36 `_red` samples have byte 2 dominant, and the one blue cockpit light has
    byte 0 dominant.
    """
    return [c[2] / 255.0, c[1] / 255.0, c[0] / 255.0, c[3] / 255.0]


def _vis_state(s):
    return {
        "color": _rgba(s["color"]),
        "rotationDelta": s["rotationDelta"],
        "rotationTotal": s["rotationTotal"],
        "size": [s["size"][0] / UNITS_PER_M, s["size"][1] / UNITS_PER_M],
        "scale": s["scale"],
    }


def _vel_frame(f):
    return {
        "velocity": {"base": _per_ms3(f["velocity"]["base"]), "amplitude": _per_ms3(f["velocity"]["amplitude"])},
        "totalDelta": {"base": _per_ms3(f["totalDelta"]["base"]), "amplitude": _per_ms3(f["totalDelta"]["amplitude"])},
    }


def visual_names(elem):
    """Every name an elem's visuals refer to, whatever shape the union took."""
    v = elem.get("visuals") or {}
    kind = v.get("kind")
    if kind == "array":
        return [ref(e["name"]) for e in v.get("entries", []) if e.get("name")]
    if kind == "markArray":
        return [ref(n) for mark in v.get("marks", []) for n in mark.get("materials", []) if n]
    return [ref(v["name"])] if v.get("name") else []


def child_effects(effect):
    """The effects this one names: the three impact/death/emitted hooks, and any RUNNER visual."""
    out = []
    for elem in effect["elems"]:
        for key in ("effectOnImpact", "effectOnDeath", "effectEmitted"):
            if elem.get(key):
                out.append(ref(elem[key]))
        if elem["type"] == "RUNNER":
            out.extend(visual_names(elem))
    return out


def closure(defs, wanted):
    """`wanted` plus every effect reachable from it. Returns (names, missing names).

    A child defined in a zone that was not dumped would otherwise leave an effect
    that plays but is silently empty, so the names that could not be resolved come
    back to be reported rather than dropped.
    """
    seen, missing, queue = set(), set(), [ref(n) for n in wanted]
    while queue:
        name = queue.pop()
        if name in seen or name in missing:
            continue
        effect = defs.get(name)
        if effect is None:
            missing.add(name)
            continue
        seen.add(name)
        queue.extend(child_effects(effect))
    return seen, missing


def load_dump(fx_root):
    """{effect name: dumped JSON} for every `fx/<name>.json` under `fx_root`."""
    defs = {}
    for dirpath, _dirs, files in os.walk(fx_root):
        for f in files:
            if not f.endswith(".json"):
                continue
            d = read_json(os.path.join(dirpath, f))
            if d.get("_type") == "fx":
                defs[d["name"]] = d
    return defs


def global_wind(data):
    """The level's global wind speed in units/s from its scripts' dvars, or 0 where it has none (T5 only)."""
    for script in (data.get("scripts") or {}).values():
        dvars = script.get("dvars") or {}
        if "wind_global_vector" in dvars and int(dvars.get("enable_global_wind", 0)):
            return math.hypot(*(float(v) for v in str(dvars["wind_global_vector"]).split()))
    return 0.0


def _wind_weight(elem, wind):
    """How far a T5 elem's life and spawn interval move toward their max-wind values (FX_SpawnElem, t5-fx).

    The weight is fixed when the effect spawns, and a world's wind does not change,
    so it is baked here rather than carried to the client.
    """
    strongest = elem.get("maxWindStrength") or 0
    return min(max(wind / strongest, 0.0), 1.0) if strongest else 0.0


def _windy(r, toward, w):
    """`lerp(base + amp*r, toward, w)` is still a range: ((1-w)base + w*toward, (1-w)amp)."""
    return {"base": (1 - w) * r["base"] + w * toward, "amplitude": (1 - w) * r["amplitude"]}


def _atlas(atlas):
    """IW5's atlas as is; T5's packs the cell count (low 9 bits) and an index range (the rest) in one u16."""
    if "entryCountAndIndexRange" not in atlas:
        return atlas
    packed = atlas["entryCountAndIndexRange"]
    out = {k: v for k, v in atlas.items() if k != "entryCountAndIndexRange"}
    return {**out, "entryCount": packed & 0x1FF, "indexRange": packed >> 9}


def _convert_elem(elem, wind=0.0):
    w = _wind_weight(elem, wind)
    life = _windy(elem["lifeSpanMsec"], elem["lifespanAtMaxWind"], w) if w else elem["lifeSpanMsec"]
    spawn = dict(elem["spawn"])
    if spawn.get("kind") == "looping":
        interval = spawn["intervalMsec"]
        if w:
            interval = int((1 - w) * interval + w * elem["spawnIntervalAtMaxWind"])
        spawn = {
            "kind": "looping",
            "interval": interval / 1000.0,
            "count": None if spawn["count"] == SPAWN_FOREVER else spawn["count"],
        }
    else:
        spawn = {"kind": spawn.get("kind", "oneShot"), "count": _range(spawn["count"])}

    return {
        "type": elem["type"],
        "spawn": spawn,
        "spawnDelay": _range(elem["spawnDelayMsec"], 1 / 1000.0),
        "life": _range(life, 1 / 1000.0),
        "spawnOrigin": _range_triple(elem["spawnOrigin"], 1 / UNITS_PER_M),
        "spawnOffsetRadius": _range(elem["spawnOffsetRadius"], 1 / UNITS_PER_M),
        "spawnOffsetHeight": _range(elem["spawnOffsetHeight"], 1 / UNITS_PER_M),
        # Radians, and radians per millisecond, in the game's own (pitch, yaw, roll)
        # order: they build an axis the Quake way at run time, so no axis swap here.
        "spawnAngles": [_range(r) for r in elem["spawnAngles"]],
        "angularVelocity": [_range(r) for r in elem["angularVelocity"]],
        "initialRotation": _range(elem["initialRotation"]),
        # A multiple of 800 units/s^2, applied only with the gravity flag.
        "gravity": _range(elem["gravity"]),
        # Distance gates and fades, all measured from the camera. spawnRange gates
        # whether the elem spawns at all, by distance to the *effect*; the two fades
        # scale a particle's alpha by its own distance (fadeIn far, fadeOut near).
        "spawnRange": _range(elem["spawnRange"], 1 / UNITS_PER_M),
        "fadeInRange": _range(elem["fadeInRange"], 1 / UNITS_PER_M),
        "fadeOutRange": _range(elem["fadeOutRange"], 1 / UNITS_PER_M),
        "spawnFrustumCullRadius": elem["spawnFrustumCullRadius"] / UNITS_PER_M,
        "lightingFrac": elem["lightingFrac"] / 255.0,
        "atlas": _atlas(elem["atlas"]),
        "sortOrder": elem["sortOrder"],
        "visuals": {"kind": elem["visuals"].get("kind"), "names": visual_names(elem)},
        "velSamples": [{"local": _vel_frame(s["local"]), "world": _vel_frame(s["world"])} for s in elem["velSamples"]],
        "visSamples": [{"base": _vis_state(s["base"]), "amplitude": _vis_state(s["amplitude"])} for s in elem["visSamples"]],
        "effectOnDeath": ref(elem["effectOnDeath"]) if elem.get("effectOnDeath") else None,
        "effectEmitted": ref(elem["effectEmitted"]) if elem.get("effectEmitted") else None,
        # T5 seeds from the effect alone (t5-fx): no per-elem term.
        "randomSeed": elem.get("randomSeed", 0),
        # Which velocity frames and forces apply, and whether size[1] is used.
        "flags": elem["flags"] & 0xFFFFFFFF,
        **_quad_shape(elem),
    }


def _quad_shape(elem):
    """T5's trapezoid trim and pivot, written only where they change the quad.

    `trim` is (top, bottom), each clamped to [0, 1] as FX_GenSpriteVerts clamps it;
    `pivot` moves the centre by (pivot0 * A', pivot1 * B'), and only with flag 0x200000.
    """
    out = {}
    union = elem.get("union") or {}
    if union.get("kind") == "cloudDensityRange":
        # How many of the 1024 shared points one cloud draws (t5-fx, CLOUD).
        out["cloudDensity"] = [union["base"], union["amplitude"]]
    if union.get("kind") == "billboard":
        trim = [min(max(union["topWidth"], 0.0), 1.0), min(max(union["bottomWidth"], 0.0), 1.0)]
        if trim != [1.0, 1.0]:
            out["trim"] = trim
    if elem["flags"] & 0x200000 and any(elem.get("billboardPivot") or ()):
        out["pivot"] = list(elem["billboardPivot"])
    return out


def _bounds_radius(effect):
    """A conservative radius in metres, for distance culling.

    IW5's FxEffectDef carries no bounding sphere, so one is computed from how far
    a particle can be spawned and how far it can travel in its lifetime.
    """
    worst = 0.0
    for elem in effect["elems"]:
        spawn = max(abs(r["base"]) + abs(r["amplitude"]) for r in elem["spawnOrigin"])
        spawn += abs(elem["spawnOffsetRadius"]["base"]) + abs(elem["spawnOffsetRadius"]["amplitude"])
        life = elem["lifeSpanMsec"]["base"] + max(0, elem["lifeSpanMsec"]["amplitude"])
        # totalDelta is integrated over sample index, so one step lasts life / intervals.
        step = life / max(len(elem["velSamples"]) - 1, 1)
        travel = 0.0
        for s in elem["velSamples"]:
            for frame in ("local", "world"):
                d = s[frame]["totalDelta"]
                travel = max(travel, max(abs(b) + abs(a) for b, a in zip(d["base"], d["amplitude"], strict=True)))
        worst = max(worst, spawn + travel * step)
    return worst / UNITS_PER_M


def convert(effect, wind=0.0):
    """One dumped effect in engine units, under a world's global wind (units/s)."""
    looping = effect["elemCounts"]["looping"] > 0
    return {
        "name": effect["name"],
        "looping": looping,
        "radius": _bounds_radius(effect),
        "elems": [_convert_elem(e, wind) for e in effect["elems"]],
    }


def material_states(mat_root, materials, game_key):
    """{material: {image, blend, alphaTest, sortKey, doubleSided, fog}} from the material dumps.

    Two things the client cannot work out for itself:

    - The exporter names a texture file after the *image*, not the material that
      draws it, and several effects share one sheet.
    - **How the game blends it.** Every one of dome's fx materials is `alpha`, not
      additive, despite "additive particle" being the obvious assumption. Drawn
      additively they saturate to white blobs on a bright sky instead of hanging
      as haze, which reads as a lighting bug rather than a blending one.

    A `nofog` technique set opts the material out of the world's fog, which the
    game uses for the sheets meant to read at any distance.
    """
    out = {}
    for name in sorted(materials):
        path = os.path.join(mat_root, material_file_stem(name) + ".json")
        if not os.path.exists(path):
            continue
        data = read_json(path)
        state = material_render_state(data, game_key)
        drawn = drawn_state(data, game_key)
        image = colour_map(data, game_key)
        if not image:
            continue
        techset = state["techniqueSet"]
        constants = {c.get("name"): c["literal"] for c in data.get("constants", []) if "literal" in c}
        feather = constants["featherParms"][1] if "featherParms" in constants else None
        out[name] = {
            "texture": image + ".png",
            # None means the material replaces what is under it; for a particle
            # sheet that is still drawn as a plain alpha blend.
            "blend": state["blend"] or "alpha",
            # The literal factors, because the names above fold two different
            # equations together: "alpha" is both straight (srcalpha, invsrcalpha)
            # and premultiplied (one, invsrcalpha), and the particle shaders output
            # straight colour, so the difference is the difference between a haze
            # and a glare.
            "blendOp": drawn.get("blendOpRgb") or "add",
            "blendSrc": drawn.get("srcBlendRgb") or "srcalpha",
            "blendDst": drawn.get("dstBlendRgb") or "invsrcalpha",
            "alphaTest": state["alphaTest"],
            "sortKey": state["sortKey"],
            "doubleSided": state["doubleSided"],
            "fog": "nofog" not in techset,
            # zfeather's featherParms = (1/depth, depth); the depth softens a sprite
            # where it meets geometry and fades it as it nears the camera.
            "featherDepth": feather / UNITS_PER_M if feather else None,
            **(_shader(techset, constants) if game_key == "t5" else {}),
        }
    return out


def _shader(techset, constants):
    """What a T5 particle technique set does beyond IW5's zfeather blend (t5-fx, [shader]).

    - `output`: `straight` colour and alpha (the blended sets); `alpha`, colour times
      alpha (`effect_add`); `luma`, colour times alpha times its own luminance
      (`effect_zfeather_add`). The last two are drawn one/one by their materials.
    - `fogFade`: an additive set fades to black in fog instead of toward its colour.
    - `falloff`: fades and tints a sprite by how squarely it faces the eye.
    - `eyeOffset`: metres the sprite is pulled toward the eye, keeping its size on screen.
    """
    if techset.startswith("distortion"):
        # Refracts the frame behind it, which needs a copy of the scene: not drawn.
        return {"undrawn": "distortion"}
    if techset.startswith("particle_cloud"):
        # A cloud has no fog, no feather and no luminance term: `tex * colour`,
        # times its own alpha in the additive set. `_outdoor` also hides flakes under
        # a roof, from a height map the runtime does not have.
        return {"output": "alpha" if "_add" in techset else "straight", "fogFade": False, "fog": False}
    add = "_add" in techset and techset.startswith("effect")
    out = {
        "output": ("luma" if "zfeather" in techset else "alpha") if add else "straight",
        "fogFade": add,
    }
    if "falloff" in techset and "falloffParms" in constants:
        out["falloff"] = {
            "scale": constants["falloffParms"][2],
            "bias": constants["falloffParms"][3],
            "begin": constants.get("falloffBeginColor", [1, 1, 1, 1]),
            "end": constants.get("falloffEndColor", [1, 1, 1, 1]),
        }
    if "eyeoffset" in techset and "eyeOffsetParms" in constants:
        out["eyeOffset"] = constants["eyeOffsetParms"][0] / UNITS_PER_M
    return out


def export_fx(fx_root, wanted, out_dir, mat_root=None, wind=0.0):
    """Write `<out_dir>/effects.json` for `wanted` and everything it reaches, under a global wind (units/s).

    Returns (effects written, missing names, {material: image}, type counts).
    """
    defs = load_dump(fx_root)
    names, missing = closure(defs, wanted)

    effects, materials, counts = {}, set(), {}
    for name in sorted(names):
        effect = convert(defs[name], wind)
        effects[name] = effect
        for elem, raw in zip(effect["elems"], defs[name]["elems"], strict=True):
            counts[elem["type"]] = counts.get(elem["type"], 0) + 1
            if raw["visuals"].get("kind") in ("material", "array", "markArray") and elem["type"] != "RUNNER":
                materials.update(elem["visuals"]["names"])

    game_key = next((defs[n]["_game"] for n in sorted(names)), "iw5")
    table = material_states(mat_root, materials, game_key) if mat_root else {}
    # Every fx sheet converts lossless, so the writer always chooses .png.
    images = {m: info["texture"][:-4] for m, info in table.items()}

    os.makedirs(out_dir, exist_ok=True)
    library = {"_version": 5, "fadeQuantise": conventions(effects, game_key), "effects": effects, "materials": table}
    write_json(os.path.join(out_dir, "effects.json"), library)
    return effects, missing, images, counts


# FxElemDef's billboard bits as T5 reads them (FX_DrawElem_BillboardSprite).
T5_FACING = {0x80000: "world-up", 0x100000: "viewpoint", 0x180000: "viewpoint-up"}


def conventions(effects, game_key):
    """Write where the games draw differently as engine properties, in place; returns the fade rounding.

    The runtime never reads a game (docs/restructure.md, rule 3). T5 faces a
    billboard by its flags, rolls a tail like a sprite, reads atlas start mode 3
    as a fixed range of cells, and rounds a fade to a byte where IW5 floors it
    (t5-fx). `readFxLibrary` does the same for a version-4 library.
    """
    if game_key != "t5":
        return "floor"
    for effect in effects.values():
        for elem in effect["elems"]:
            facing = T5_FACING.get(elem["flags"] & 0x180000)
            if facing:
                elem["facing"] = facing
            if elem["type"] in ("TAIL", "LINE"):
                elem["rolls"] = True
            if elem["atlas"]["behavior"] & 3 == 3:
                elem["atlas"]["ranged"] = True
    return "round"


def undrawn(counts):
    """{type: count} for the elem types exported but not yet drawn."""
    return {t: n for t, n in sorted(counts.items()) if t not in DRAWN_TYPES}
