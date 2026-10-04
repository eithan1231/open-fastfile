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

import os

from .files import read_json, write_json
from .materials import colour_map, drawn_state, material_file_stem, material_render_state
from .units import UNITS_PER_M

# The types the runtime draws today. Anything else is exported (the definition is
# cheap and complete) but counted, so a missing element is a number in the log
# rather than an absence nobody notices.
DRAWN_TYPES = ("SPRITE_BILLBOARD", "SPRITE_ORIENTED", "TAIL", "RUNNER")

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


def _convert_elem(elem):
    life = elem["lifeSpanMsec"]
    spawn = dict(elem["spawn"])
    if spawn.get("kind") == "looping":
        spawn = {
            "kind": "looping",
            "interval": spawn["intervalMsec"] / 1000.0,
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
        "atlas": elem["atlas"],
        "sortOrder": elem["sortOrder"],
        "visuals": {"kind": elem["visuals"].get("kind"), "names": visual_names(elem)},
        "velSamples": [{"local": _vel_frame(s["local"]), "world": _vel_frame(s["world"])} for s in elem["velSamples"]],
        "visSamples": [{"base": _vis_state(s["base"]), "amplitude": _vis_state(s["amplitude"])} for s in elem["visSamples"]],
        "effectOnDeath": ref(elem["effectOnDeath"]) if elem.get("effectOnDeath") else None,
        "effectEmitted": ref(elem["effectEmitted"]) if elem.get("effectEmitted") else None,
        "randomSeed": elem["randomSeed"],
        # Which velocity frames and forces apply, and whether size[1] is used.
        "flags": elem["flags"] & 0xFFFFFFFF,
    }


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


def convert(effect):
    """One dumped effect in engine units."""
    looping = effect["elemCounts"]["looping"] > 0
    return {
        "name": effect["name"],
        "looping": looping,
        "radius": _bounds_radius(effect),
        "elems": [_convert_elem(e) for e in effect["elems"]],
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
        feather = next((c["literal"][1] for c in data.get("constants", []) if c.get("name") == "featherParms"), None)
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
        }
    return out


def export_fx(fx_root, wanted, out_dir, mat_root=None):
    """Write `<out_dir>/effects.json` for `wanted` and everything it reaches.

    Returns (effects written, missing names, {material: image}, type counts).
    """
    defs = load_dump(fx_root)
    names, missing = closure(defs, wanted)

    effects, materials, counts = {}, set(), {}
    for name in sorted(names):
        effect = convert(defs[name])
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
    write_json(os.path.join(out_dir, "effects.json"), {"_version": 4, "effects": effects, "materials": table})
    return effects, missing, images, counts


def undrawn(counts):
    """{type: count} for the elem types exported but not yet drawn."""
    return {t: n for t, n in sorted(counts.items()) if t not in DRAWN_TYPES}
