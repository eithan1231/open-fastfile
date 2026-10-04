"""Units, axes, and reading vectors out of the dump's JSON."""

UNITS_PER_M = 39.37  # CoD units are inches


def to_engine(p):
    """CoD (x, y, z), inches, Z-up -> engine (x, y, z), metres, Y-up. See docs/cod/reference.md#coordinates."""
    return (p[0] / UNITS_PER_M, p[2] / UNITS_PER_M, -p[1] / UNITS_PER_M)


def vec(value, keys="xyzw"):
    """A vector as a tuple of floats. OAT writes some as `[x, y, z]` and some as `{"x": .., "y": ..}`."""
    if value is None:
        return None
    if isinstance(value, dict):
        return tuple(float(value[k]) for k in keys if k in value)
    return tuple(float(v) for v in value)


def vec3(value):
    v = vec(value, "xyz")
    if v is None:
        return None
    if len(v) != 3:
        raise ValueError(f"expected a 3-component vector, got {len(v)}: {value!r}")
    return v


def vec4(value):
    v = vec(value, "xyzw")
    if v is None:
        return None
    if len(v) != 4:
        raise ValueError(f"expected a 4-component vector, got {len(v)}: {value!r}")
    return v
