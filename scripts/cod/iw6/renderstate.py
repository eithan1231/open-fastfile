"""IW6 render state in OpenAssetTools' material spelling: state bits, samplers, camera regions.

Pure decoding, no zone. How each layout was established is in
reverse/iw6-zone/README.md#render-state; the spellings are OAT's
(src/ObjCommon/Material/JsonMaterial.h.template) so scripts/cod/materials.py
reads an IW6 dump as it reads the others.
"""

# GfxBlend (Durango PDB). 11-14 are D3D11's dual-source factors, which OAT's enum lacks.
BLENDS = (
    "disabled",
    "zero",
    "one",
    "srccolor",
    "invsrccolor",
    "srcalpha",
    "invsrcalpha",
    "destalpha",
    "invdestalpha",
    "destcolor",
    "invdestcolor",
    "srccolor1",
    "invsrccolor1",
    "srcalpha1",
    "invsrcalpha1",
)
BLEND_OPS = ("disabled", "add", "subtract", "revsubtract", "min", "max")  # GfxBlendOp
STENCIL_OPS = ("keep", "zero", "replace", "incrsat", "decrsat", "invert", "incr", "decr")  # GfxStencilOp
STENCIL_FUNCS = ("never", "less", "equal", "lessequal", "greater", "notequal", "greaterequal", "always")

# loadBits[0] bits 1-2 while bit 0 (disabled) is clear: X360 R_SetAlphaTestFunction
# sets GREATER 0, LESS 128 and GREATEREQUAL 128 for these.
ALPHA_TESTS = {1: "gt0", 2: "lt128", 3: "ge128"}
CULL_FACES = {1: "none", 2: "back", 3: "front"}  # loadBits[0] bits 3-4
DEPTH_TESTS = ("always", "less", "equal", "less_equal")  # loadBits[1] bits 2-3
POLYGON_OFFSETS = ("offset0", "offset1", "offset2", "offsetShadowmap")  # loadBits[1] bits 4-5

# GfxCameraRegionType (Durango PDB), in OAT's camelCase. 1 (lit decal) is new since IW5.
CAMERA_REGIONS = ("litOpaque", "litDecal", "litTrans", "emissive", "depthHack", "lightMapOpaque", "hudOutline", "motionBlur")
CAMERA_REGION_NONE = 8

# MaterialTextureDef.samplerState: X360 R_SetSampler reads IW5's bitfield from this byte.
TEXTURE_FILTERS = ("disabled", "nearest", "linear", "aniso2x", "aniso4x")
MIPMAPS = ("disabled", "nearest", "linear")


def _name(table, index):
    """A table's spelling for `index`, or the number itself when the game uses a value OAT has no name for."""
    return table[index] if index < len(table) else index


def _bits(word, shift, width):
    return (word >> shift) & ((1 << width) - 1)


def _stencil(word, shift):
    """pass, fail, zfail (3 bits each) and func (3 bits) from `shift` up."""
    return {
        "pass": STENCIL_OPS[_bits(word, shift, 3)],
        "fail": STENCIL_OPS[_bits(word, shift + 3, 3)],
        "zfail": STENCIL_OPS[_bits(word, shift + 6, 3)],
        "func": STENCIL_FUNCS[_bits(word, shift + 9, 3)],
    }


def state_bits(load_bits):
    """One GfxStateBits.loadBits (three words) as an OAT `stateBits` entry.

    Word 0 is alpha test, cull, polymode and gamma; word 1 depth and stencil;
    word 2 the blend (X360 R_ChangeState_0/1/2 read them the same way).
    """
    raster, depth, blend = load_bits
    entry = {
        "srcBlendRgb": _name(BLENDS, _bits(blend, 0, 4)),
        "dstBlendRgb": _name(BLENDS, _bits(blend, 4, 4)),
        "blendOpRgb": _name(BLEND_OPS, _bits(blend, 8, 3)),
        "alphaTest": "disabled" if raster & 1 else ALPHA_TESTS.get(_bits(raster, 1, 2), "invalid"),
        "cullFace": CULL_FACES.get(_bits(raster, 3, 2), "invalid"),
        "srcBlendAlpha": _name(BLENDS, _bits(blend, 12, 4)),
        "dstBlendAlpha": _name(BLENDS, _bits(blend, 16, 4)),
        "blendOpAlpha": _name(BLEND_OPS, _bits(blend, 20, 3)),
        "colorWriteRgb": bool(blend & 0x7000000),
        "colorWriteAlpha": bool(blend & 0x8000000),
        "gammaWrite": bool(raster & 0x40),
        "polymodeLine": bool(raster & 0x20),
        "depthWrite": bool(depth & 1),
        "depthTest": "disabled" if depth & 2 else DEPTH_TESTS[_bits(depth, 2, 2)],
        "polygonOffset": POLYGON_OFFSETS[_bits(depth, 4, 2)],
    }
    if depth & 0x40:
        entry["stencilFront"] = _stencil(depth, 8)
    if depth & 0x80:
        entry["stencilBack"] = _stencil(depth, 20)
    return entry


def sampler_state(byte):
    return {
        "filter": _name(TEXTURE_FILTERS, _bits(byte, 0, 3)),
        "mipMap": _name(MIPMAPS, _bits(byte, 3, 2)),
        "clampU": bool(byte & 0x20),
        "clampV": bool(byte & 0x40),
        "clampW": bool(byte & 0x80),
    }


def camera_region(value):
    return "none" if value == CAMERA_REGION_NONE else _name(CAMERA_REGIONS, value)


def game_flags(value):
    """MaterialInfo.gameFlags as OAT lists them: each set bit in hex."""
    return [f"{1 << bit:x}" for bit in range(8) if value & (1 << bit)]
