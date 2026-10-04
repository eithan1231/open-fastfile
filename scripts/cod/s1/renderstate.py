"""S1 render state in OpenAssetTools' material spelling: state bits, camera regions.

Sampler state and game flags are a byte-for-byte shared decode and are imported
from `scripts/cod/iw6/renderstate.py` by the callers that want them, as are the
blend, stencil-op and stencil-function tables, which S1 declares identically.

`GfxStateBits.loadBits` is **six** words where IW6 writes three, and the three
D3D11 states S1 caches beside them say which is which: `rasterizerState` (a byte
in the same struct), `XGfxGlobals.depthStencilStateBits` (a `u64` per state) and
`XGfxGlobals.blendStateBits` (a `u32[3]`, one per render target). `cached_states`
below rebuilds all three from the six words, and the material dumper checks every
entry of every map against them -- which is what stops a plausible wrong decode,
since the first three words read under IW6's rules give every material a blend
mode and no sign of being wrong. README.md#the-state-bits.
"""

from ..iw6.renderstate import BLEND_OPS, BLENDS, POLYGON_OFFSETS, _bits, _name, _stencil

# GfxCameraRegionType (x64-zt s1/structs.hpp). S1 names three regions and numbers
# "none" 13; IW6 names eight and numbers it 8, so its table cannot be reused. A
# region S1 leaves unnamed keeps its number, as OpenAssetTools does.
CAMERA_REGIONS = {0: "litOpaque", 2: "litDecal", 3: "litTrans"}
CAMERA_REGION_NONE = 13

# loadBits[0], bits 1-2 while bit 0 (disabled) is clear. IW6's values.
ALPHA_TESTS = {1: "gt0", 2: "lt128", 3: "ge128"}
CULL_FACES = {1: "none", 2: "back", 3: "front"}  # loadBits[0] bits 3-4

# loadBits[1] bits 1-3. Three bits where IW6 has a disable bit and two, so the two
# games' tables are not a prefix of each other: S1 writes 0x6 for the lessequal
# that IW6 writes 0xC, and IW6's reader calls that same 0x6 "disabled".
DEPTH_TESTS = ("always", "less", "equal", "less_equal", "greater", "greater_equal", "disabled")

DEPTHWRITE_OPAQUE = 0x10000000  # loadBits[3]: the one bit of that word no blend state carries
POLYGON_OFFSET_MASK = 0x30  # loadBits[1]: D3D11's depth bias, a rasterizer state
STENCIL_REF_MASK = 0xFF0000  # loadBits[2]: OMSetDepthStencilState's argument, not the state
# loadBits[2]'s read and write masks. The zone caches both as 0xFF on every entry, even
# the 26 of common_mp.ff's (weapon reticles, the motion tracker) whose word says
# otherwise, so the cached state cannot check them.
STENCIL_MASKS = 0xFFFF


def camera_region(value):
    return "none" if value == CAMERA_REGION_NONE else CAMERA_REGIONS.get(value, value)


def _blend(word):
    """One blend-state word (GFXS3) as the blend half of an OAT `stateBits` entry."""
    return {
        "srcBlendRgb": _name(BLENDS, _bits(word, 0, 4)),
        "dstBlendRgb": _name(BLENDS, _bits(word, 4, 4)),
        "blendOpRgb": _name(BLEND_OPS, _bits(word, 8, 3)),
        "srcBlendAlpha": _name(BLENDS, _bits(word, 12, 4)),
        "dstBlendAlpha": _name(BLENDS, _bits(word, 16, 4)),
        "blendOpAlpha": _name(BLEND_OPS, _bits(word, 20, 3)),
        "colorWriteRgb": bool(word & 0x7000000),
        "colorWriteAlpha": bool(word & 0x8000000),
    }


def state_bits(load_bits):
    """One GfxStateBits.loadBits (six words) as an OAT `stateBits` entry.

    Word 0 is the rasterizer state, words 1-2 the 64-bit depth/stencil state, and
    words 3-5 one blend state per render target. The entry carries render target
    0's blend under the names every other game's dump uses, because that is the
    target the surface's colour is written to; 1 and 2 ride in `blendTargets`.
    """
    raster, depth, stencil, blend, blend1, blend2 = load_bits
    entry = {
        **_blend(blend),
        "alphaTest": "disabled" if raster & 1 else ALPHA_TESTS.get(_bits(raster, 1, 2), "invalid"),
        "cullFace": CULL_FACES.get(_bits(raster, 3, 2), "invalid"),
        "gammaWrite": bool(raster & 0x40),
        "polymodeLine": bool(raster & 0x20),
        "depthWrite": bool(depth & 1),
        "depthTest": _name(DEPTH_TESTS, _bits(depth, 1, 3)),
        "polygonOffset": POLYGON_OFFSETS[_bits(depth, 4, 2)],
    }
    if blend & DEPTHWRITE_OPAQUE:
        entry["depthWriteOpaque"] = True
    if depth & 0xC0:
        entry["stencilRef"] = _bits(stencil, 16, 8)
        entry["stencilReadMask"] = _bits(stencil, 0, 8)
        entry["stencilWriteMask"] = _bits(stencil, 8, 8)
    if depth & 0x40:
        entry["stencilFront"] = _stencil(depth, 8)
    if depth & 0x80:
        entry["stencilBack"] = _stencil(depth, 20)
    if blend1 or blend2:
        entry["blendTargets"] = [_blend(blend1), _blend(blend2)]
    return entry


def cached_states(load_bits):
    """(rasterizerState byte, depthStencilStateBits u64, blendStateBits u32[3]) for one entry.

    The D3D11 states the linker derived from the same six words, each written
    elsewhere in the zone. The three fields the state objects do not carry are
    dropped here for the same reason D3D11 does not carry them: the alpha test
    and gamma write are the shader's, the depth bias is the rasterizer's, and the
    stencil reference is an argument to `OMSetDepthStencilState`. The stencil masks
    are cached full whatever the word holds (STENCIL_MASKS).
    """
    raster, depth, stencil, blend, blend1, blend2 = load_bits
    alpha_test = 0 if raster & 1 else _bits(raster, 1, 2)
    rasterizer = _bits(raster, 3, 2) | (_bits(depth, 4, 2) << 2) | (_bits(raster, 5, 1) << 4)
    rasterizer |= (alpha_test << 5) | (_bits(raster, 6, 1) << 7)
    depth_stencil = (depth & ~POLYGON_OFFSET_MASK) | (((stencil & ~STENCIL_REF_MASK) | STENCIL_MASKS) << 32)
    return rasterizer, depth_stencil, [blend & ~DEPTHWRITE_OPAQUE, blend1, blend2]
