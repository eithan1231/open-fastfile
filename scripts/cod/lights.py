"""A map's scripted lights: the primary lights its scripts switch, written as `light` nodes, on.

A light entity left in a compiled map is one a script drives; the rest were baked
and stripped. Those with a black `_bakecolor` are not in the lightmap at all, so
without a live light they light nothing. Each is written in its scripted "on" state
(`script_light2_*`), because nothing here switches them yet.

Two halves, because neither says it all (t5/dumpers/gfxworld.py's `primaryLights`):

- the **compiled** light (`pl#` indexes it) has where it is, where it points (its
  `dir` faces back toward the light) and how far it reaches; its target, which is
  how the designer aimed it, is stripped;
- the **entity** has the "on" colour and beam. The compiled cone is no use: a square
  (superellipse) beam compiles to its diagonal, `atan(sqrt 2 * tan(fov / 2))`, and
  a round one to `fov / 2`, so the entity's full `fov` is the beam an author means.

Colours are sRGB times an intensity, as the compiler's own are (light 24's 0.82 at 8
compiles to 5.107), in the units the lightmap and sun are handed over in.
"""

import math

from .units import UNITS_PER_M, to_engine, vec3

#: The client's POINT_SPOT_SCALE (packages/client/src/scene/lights.ts): one game unit
#: of light is one engine unit, as the lightmap's and the sun's are.
ENGINE_POINT_SPOT_SCALE = 60.0

#: The widest beam a spot can be drawn with; a 180-degree "spot" is a hemisphere.
MAX_CONE = 170.0


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _floats(value):
    try:
        return [float(v) for v in str(value).split()]
    except ValueError:
        return []


def _first(entity, *keys):
    """The first of `keys` the entity sets to a number, stripped: some carry a leading space."""
    for key in keys:
        for k in (key, " " + key):
            values = _floats(entity.get(k, ""))
            if values:
                return values
    return None


def on_colour(entity):
    """The linear colour times intensity a script turns this light on to, or None for black."""
    colour = _first(entity, "script_light2_color", "_color")
    intensity = _first(entity, "script_light2_intensity", "intensity")
    if not colour or len(colour) != 3 or not intensity:
        return None
    rgb = tuple(srgb_to_linear(c) * intensity[0] for c in colour)
    return rgb if max(rgb) > 0.0 else None


def aim(forward):
    """`rotate:` (pitch, yaw) degrees that turn -Z onto the engine-space unit vector `forward`.

    The client turns (0, 0, -1) by Euler XYZ (scene/lights.ts), which with no roll is
    (-sin y, cos y sin p, -cos y cos p).
    """
    x, y, z = forward
    yaw = math.asin(max(-1.0, min(1.0, -x)))
    pitch = math.atan2(y, -z)
    return math.degrees(pitch), math.degrees(yaw)


def scripted_lights(entities, primary):
    """[(name, properties)] for each unbaked scripted light, in `pl#` order, and the count skipped."""
    out, skipped = [], 0
    for entity in entities:
        if entity.get("classname") != "light" or _floats(entity.get("_bakecolor", "1")) != [0.0, 0.0, 0.0]:
            continue
        index = int(_floats(entity.get("pl#", "-1"))[0])
        compiled = primary[index] if 0 <= index < len(primary) else None
        colour = on_colour(entity)
        if compiled is None or compiled["type"] not in ("spot", "omni") or colour is None:
            skipped += 1
            continue
        peak = max(colour)
        props = {
            "type": "spot" if compiled["type"] == "spot" else "point",
            "at": " ".join(f"{v:.3f}" for v in to_engine(vec3(compiled["origin"]))),
        }
        if compiled["type"] == "spot":
            dx, dy, dz = vec3(compiled["dir"])
            pitch, yaw = aim(to_engine((-dx * UNITS_PER_M, -dy * UNITS_PER_M, -dz * UNITS_PER_M)))
            props["rotate"] = f"{pitch:.1f} {yaw:.1f} 0"
            outer = min(_first(entity, "script_light2_outer_fov", "fov_outer")[0], MAX_CONE)
            inner = min(_first(entity, "script_light2_inner_fov", "fov_inner")[0], outer)
            props["cone"] = f"{outer:g} {inner:g}"
        props["range"] = round(compiled["radius"] / UNITS_PER_M, 2)
        props["intensity"] = round(peak / ENGINE_POINT_SPOT_SCALE, 4)
        props["color"] = "#" + "".join(f"{round(255 * c / peak):02x}" for c in colour)
        out.append((index, props))
    out.sort(key=lambda item: item[0])
    return [(f"pl{index}", props) for index, props in out], skipped


def render(lights, skipped):
    """`light` lines for world.world, or [] when there are none."""
    if not lights:
        return []
    lines = [
        "",
        f"// The map's {len(lights)} scripted lights, none of them baked, all on (scripts/cod/lights.py)."
        + (f" {skipped} more are black or not a spot or omni." if skipped else ""),
    ]
    for name, props in lights:
        body = ", ".join(f"{k}: {v}" for k, v in props.items())
        lines.append(f"light {name} {{ {body} }}")
    return lines
