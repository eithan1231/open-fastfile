# Reference: the data the pipeline reads

Facts about the dumps, and how each was established. "Measured" means checked
against real zones; the code that relies on each fact is named.

## Coordinates

CoD is Z-up in inches; the engine is Y-up in metres (`units.to_engine`):

```
engine = (cod.x / 39.37,  cod.z / 39.37,  -cod.y / 39.37)
```

This is a rotation (determinant +1), not a reflection. Triangles are still
reversed (`shell.py`) because Direct3D treats clockwise triangles as front
faces and glTF counter-clockwise; `check_winding` confirms the result against
the stored normals on every export. Inside-out geometry still renders, lit
from the wrong side, so the check matters.

Orientations carry across by conjugation, `C · R · Cᵀ` (`props.engine_euler`).
Quake `angles` are `pitch yaw roll` composed as `Rz(yaw) · Ry(pitch) · Rx(roll)`.
GfxWorld stores a 3×3 `axis` whose rows are the local basis, so local-to-world
is its transpose (`props.axis_to_angles`). `tests/props-orientation.test.ts`
pins the conversion against three.js.

## IWI textures

An `.iwi` is a small header over the same block data a DDS carries
(`textures.decode_iwi`). Only v8 starts with a flags dword:

```
v6  (IW3/T4)   int8 format; int8 flags; u16 dims[3]; u32 fileSizeForPicmip[4]
v8  (IW4/IW5)  u32 flags; int8 format; int8 unused; u16 dims[3]; u32 fsfp[4]
v13 (T5)       int8 format; int8 flags; u16 dims[3]; float gamma; u32 fsfp[8]
```

Formats `0xB/0xC/0xD` are DXT1/3/5 in every version; the largest mip is last.
IWI v8 cannot hold `B8_G8_R8_X8` (24-bit colour, padded to 32 bits), so the
dump writes those images as DDS ([pipeline](pipeline.md#images)).

v8's other formats: 1 BGRA, 2 BGR, 3 luminance-alpha, 4 luminance, 5 alpha (one
or two bytes a pixel, byte order as named), 0xE DXN, and 6-10 **wavelets** of
the same five layouts. Flags: `0x2` no mips, `0x10000` cube, `0x20000` volume.
A header's `fileSizeForPicmip[i]` is the file's size up to and including level
`i`, levels stored smallest first and a cube's six faces inside each level.

A wavelet image is a mip chain coded against itself, smallest level first. A
level one pixel wide or high is raw bytes, a byte per channel. Every other level
reads, LSB-first, one bit (then, if set, a Huffman-coded correction per pixel and
channel of the level below it), and per 2×2 block and channel a parity bit and
three Huffman-coded detail coefficients `h, v, d` over the parent's value `p`:

```
top-left  = parity + (2p + h + v + d) >> 1      top-right    = (2p + h - v - d) >> 1
bottom-left =        (2p - h + v - d) >> 1      bottom-right = (2p - h - v + d) >> 1
```

The first channel (blue, or luminance) has its own code table; green and red use
a second, added to the first channel's coefficients; alpha and the corrections a
third. An escape code is followed by a raw 9-bit value (10 for green and red)
less a bias. The three tables are the game's (`scripts/cod/wavelet.py` reads them
out of the executable), and the layout decoded here reproduces OpenAssetTools'
output byte for byte ([reverse/iw5-wavelet](../../reverse/iw5-wavelet/README.md)).

## GfxWorld vertices

The patched dumper (or the IW6 backend) writes `<map>.gfxworld.json` plus two
blobs. The vertex is 44 bytes in IW4, IW5, T5 and IW6. T6 keeps 36-byte vertices
in groups a surface names by byte offset, and its writer rewrites them into this
layout ([games.md](games.md#black-ops-ii-t6--walkable-textured-and-lit)):

| offset | field        | notes                               |
| ------ | ------------ | ----------------------------------- |
| 0      | position     | 3 × float32                         |
| 12     | binormalSign | float32                             |
| 16     | colour       | 4 × uint8 RGBA; see below           |
| 20     | texCoord     | 2 × float32, tiles far outside 0..1 |
| 28     | lmapCoord    | 2 × float32, lightmap UVs, 0..1     |
| 36     | normal       | PackedUnitVec                       |
| 40     | tangent      | PackedUnitVec                       |

**PackedUnitVec:** `(byte[i] - 127) * (byte[3] + 192) / 32385`. Byte 3 is 63 on
every vertex measured (MW3 and Black Ops), which makes that `/127`;
`check_unit_vectors` reports if a game stops pinning it. IW6 packs three 10-bit
fields instead ([reverse/iw6-zone](../../reverse/iw6-zone/README.md#static-models-and-vertices)).

**Colour:** on IW4/IW5 the alpha is a layer blend weight and RGB is white on
97% of vertices. Black Ops and Black Ops II put layer weights in RGB instead,
but only on generated (`*`) surfaces ([layered materials](#layered-materials)),
so `shell.py` whitens those and keeps every other surface's RGB as a tint: on
zombie_theater that tint is what draws `incandescent_white` bulbs black. The
render state, not the vertex alpha, decides whether a material is transparent.

Surfaces index as `indices[baseIndex + t*3 + i] + firstVertex`. Surfaces share
the vertex buffer, so a partial export (the decal pass) compacts to the vertices
it uses.

## Materials

**`stateBits` is a table.** `stateBitsEntry` holds one index into it per
`MaterialTechniqueType`, and blend, alpha test, cull face and depth write are
all per technique. The pass that draws a world surface is LIT, falling back to
UNLIT then EMISSIVE (`materials.TECHNIQUES_BY_GAME`):

|          | UNLIT | EMISSIVE | LIT                             |
| -------- | ----- | -------- | ------------------------------- |
| IW4, IW5 | 0x4   | 0x5      | 0x9                             |
| T5       | 0x4   | 0x5      | 0xA (0x9 is EMISSIVE_REFLECTED) |
| IW6      | 0x2   | 0x3      | 0x7                             |

DEPTH_PREPASS is 0x0 on all four. IW6's indices are the Durango PDB's
`MaterialTechniqueType`, and the zones agree: every lit world material has
technique 0x7 and its fog variant 0x30, and the few technique sets that carry
their techniques name 0x2 `…vertcol_simple…` and 0x4 `…_dfog`
([reverse/iw6-zone](../../reverse/iw6-zone/README.md#render-state)).

`stateFlags` is a separate byte caching two facts (`0x1` CULL_BACK, `0x8`
WRITES_DEPTH). `check_state_flags` compares them: with the right index cullFace
agrees on every lit material (193/193 on mp_dome, 731/731 on mp_firingrange,
1731/1731 on mp_prisonbreak with its companions); with T5's index read as 0x9 it
agreed on 0 of 10. WRITES_DEPTH is "the lit pass or the depth prepass writes
depth": IW6's lit pass mostly tests against the prepass's depth instead, and
on mp_hardhat the two readings agree on all 1487 lit materials.

**IW6 state bits.** OpenAssetTools decodes IW4, IW5 and T5; for IW6
`scripts/cod/iw6/renderstate.py` decodes `GfxStateBits.loadBits`, three words
in IW5's layout: word 0 alpha test (bit 0 disables; bits 1–2 `gt0`, `lt128`,
`ge128`), cull (bits 3–4: none, back, front), polymode line (0x20) and gamma
write (0x40); word 1 depth write (0x1), depth test (0x2 disables; bits 2–3),
polygon offset (bits 4–5), stencil enables (0x40, 0x80) and ops; word 2 the RGB
blend (source, destination, op in bits 0–10), the alpha blend (bits 12–22) and
the colour-write mask (bits 24–27). The blend factors add D3D11's dual-source
`srccolor1`…`invsrcalpha1` (11–14).

**Blend equations** (`BLEND_EQUATIONS`). glTF's `BLEND` is only alpha blending,
and most decals are not that. On mp_dome's 28 decal materials: 20 multiply
(`zero/srccolor`), 7 add (`one/one`), 1 screen (`invdestcolor/one`), 0 alpha.
The equation rides in glTF `extras.blend`.
IW6's blended world materials use `one/invsrcalpha1` (lit) and
`srcalpha1/invsrcalpha1` (unlit), both alpha blends. `srcalpha/zero` replaces
what is under it, like `one/zero`; only IW6's `*r…` layer bases use it.

**Alpha test** (`ALPHA_CUTOFFS`): `gt0` → 1/255, `ge128` → 0.5, `ge255` → 0.5.
`ge255` is 0.5 rather than 1.0 because after the 512 px resample almost no texel
is exactly 255, and 1.0 strips foliage to bare trunks. Blended _and_ tested
exports as BLEND; opaque and tested is MASK.

**Shadows** are two `gameFlags` bits: `0x40` casts a solid shadow, `0x80` an
alpha-tested one, neither casts none. The partition is exact on mp_dome (every
`0x40` material is opaque and untested, every `0x80` opaque `ge128`).
On IW6 either bit still means "casts": every `nocast` technique set has
neither (117 of 117 on three zones) and the one `onlycast` has `0x80`. But
`0x80` is no longer alpha-test only: 281 opaque materials on those zones carry it.

**`sortKey`** is the game's draw order: 1 is the opaque world, 6 and up are
overlay tiers (gravel over concrete, then graffiti, then papers and puddles).
It is the only field that says a surface sits _on_ another; `applySortKey` in
`packages/client/src/scene/importedMaterials.ts` turns it into render order plus a polygon offset.

**Techsets** name what a material is: `r0` opaque, `b0` blend, `t0` cutout,
`unlit` a multiply/add/screen pass; `c0 n0 s0 d0` the texture slots that are
real (a bound `normalMap` without `n0` is the shared placeholder). Non-surfaces
are dropped by techset, not name: `falloff` (volumetric light shafts and dust),
`tools` (caulk), `shadowcaster` (shadow proxies). Left in, tool surfaces render
as blank white walls: never lit in game, their lightmap UVs point at unused,
white atlas space.
What the names mark differs per game (`SURFACES_BY_GAME`). IW6 also drops
`onlycast` (shadow-only cards) and `distortion` (a normal map that refracts the
screen), and the `*a…` pass of a two-pass layer blend
([games.md](games.md#ghosts-iw6)); it keeps `unlit_atest` vista cards out of the
decals.

**The colour map** is the first texture with the `colorMap` semantic, which on
IW5 is not always the colour: texture tables are sorted by name hash, and
`heatmap` (thermal) and `dustMap` share the semantic. On mp_hardhat that picks
the wrong image for 108 materials, one of them in the shell
(`wc/ny_manhattan_concrete_01_dusty`). IW6 takes the texture named `colorMap`
(`SurfaceRules.colour_map`); switching IW4/IW5/T5 to it would change their
exports, and has not been done.

**Black Ops' generated layer materials** (`*342n_22(a:b)`) are written by OAT as
`generated/_342n_22.json`; `material_file_stem` maps a surface's material name
to that file. That is 275 of mp_firingrange's 407 shell materials.
Ghosts' (`*108_11`, `*r101dn_101z`) take the same path, with nothing to cut.

### Layered materials

A generated material is a base plus up to three layers drawn over it **in one
pass**, each weighted per vertex: snow fading into mud, grime up a wall, a stain
painted on plaster. Its name lists them (`*81n_129n(wc/rus_ter_mud_puddle:wc/a_ter_snow_ice_3_blend)`),
`n` marking one with a normal map. Draw the base alone and every surface edge
is a hard seam, because neighbouring surfaces have different bases. IW4/IW5 have
no such materials: a blend there is a second surface, faded by vertex alpha.

On **Black Ops** (read from `pimp_shader_layer_lmap_*`, the LIT pixel shaders of
the `l_sm_r0c0…_b1c1…` techsets, with `reverse/t5-fx/shaders.py --techset`):

- **The techset spells each layer's mode**, `_<mode><k>c<k>`: `b1c1n1s1` is
  layer 1 blended. Colour map k is the texture named `colorMap<k>`.
  `w` is the layer's weight, `c` its colour, applied in layer order before
  lighting (normal and specular maps are lerped by the same factor):

  | Mode | Result                   | On mp_russianbase |
  | ---- | ------------------------ | ----------------- |
  | `b`  | `lerp(base, c, c.a·w)`   | 166               |
  | `m`  | `base · lerp(1, c, w)`   | 124               |
  | `a`  | `base + c·c.a·w`         | 2                 |
  | `t`  | `c.a·w ≥ 0.5 ? c : base` | 6                 |

- **The weights are vertex colour**: layer 1 is COLOR0.y, 2 is .z, 3 is .w.
  D3DCOLOR is BGRA in memory, so those are bytes 1, 0 and 3. A decal layer's
  weight is 255 and its texture's alpha does the shaping.
- **Each layer's texture coordinate is in `GfxWorldDraw.vld`**, at the
  surface's `srfTriangles_t.vertexLayerData` byte offset plus the vertex's
  index (from `firstVertex`) times a stride: a float2 per layer, then a packed
  tangent per layer whose name token ends in `n`, so `*16n_18n` is 12 bytes.
  That rule from the name matches the gap to the next surface's data on 1,038
  of mp_russianbase's 1,039 layered surfaces; `*30_166n` (whose base has no
  normal map) holds 8. So `shell.measured_strides` takes the stride from the gap
  and falls back to the name.

The exporter carries them as the glTF extension `COD_material_layers` (mode and
texture per layer) and an attribute `_LAYERk` of (u, v, weight) per vertex;
the client's `scene/layers.ts` draws them. Black Ops II keeps its layers in
`vd1` ([reverse/t6-zone](../../reverse/t6-zone/README.md#the-world-vertices-data-oat)),
Ghosts in a second `*a…` pass and AW in one pass; none of the three is read yet.

Not used yet: normal, specular and detail maps, `colorTint` and the other
constants, sampler clamping, and `cameraRegion`. `STATE_FLAG_DECAL` marks
runtime decals (bullet holes), not map geometry.

## Lightmaps

Every IW map ships a **pair** of images per lightmap page, `*lightmapN_primary`
and `*lightmapN_secondary` (`_lightmapN_…` on IW4/IW5), reached through
`GfxWorld.draw.lightmaps`. `scripts/cod/lightmap.py` converts them; the atlas is
kept at full resolution, not put through the 512 px cap. When checking one,
sample it through the shell's own `TEXCOORD_1` at triangle centroids, not
vertices (vertices sit on padded chart borders). Engine side: see
`configureLightmapTexture` in `packages/client/src/scene/importedMaterials.ts`.

**The pair holds three quantities.** On Ghosts, where the formats say what the
other games' bytes only imply:

| Image                  | Format             | Size against the page | Holds                                                       |
| ---------------------- | ------------------ | --------------------- | ----------------------------------------------------------- |
| `*lightmapN_primary`   | BC4 (one channel)  | 2x in both axes       | the **sun's visibility**                                    |
| `*lightmapN_secondary` | R16G16B16A16_FLOAT | the page, twice down  | the page's **ambient** colour over its **highlight** colour |

The names are the engine's own: `GfxStaticModelVertexLighting`, which lights a
static model the same way, is `{unsigned char visibility[4]; unsigned short
ambientColorFloat16[4]; unsigned short highlightColorFloat16[4];}`. What each is
was then checked against the zones (mp_prisonbreak unless said otherwise):

- **The secondary is two stacked pages, not one tall one.** Its halves share a
  chart layout — 97.7% of texels agree on being inside a chart, and their
  luminances correlate at 0.95 — while carrying different light: the bottom half
  is 2.3x the top and a different hue. Sampled as one image, every chart comes
  out half greenish and half blue-grey. So a page's UVs address `(u, v/2)` for
  the ambient lobe and `(u, v/2 + 1/2)` for the highlight.
- **The primary shares those UVs at twice the resolution.** Over all 1,048,576
  positions of mp_prisonbreak's page, wherever any of the four primary texels
  above a position is lit the secondary carries light there (P = 1.000), and the
  primary is near-binary: 84% of it zero and 8% full.
- **The primary is the sun's visibility.** Its mean is 0.46 over up-facing
  triangles, 0.23 over walls and 0.09 over ceilings, and bucketed by N·L against
  the map's own `sundirection` it runs from 0.07 at −1 to 0.53 at +1, with the
  step at 0. mp_frag, whose sun points elsewhere, says the same: 0.05–0.15 below
  zero and 0.23–0.50 above. That is also what fixes
  [worldspawn key 761](games.md#ghosts-iw6).
- **The highlight lobe leans to the sun's colour.** Over four maps its
  chromaticity is 0.02–0.09 from `suncolor`'s (mean 0.04) against the ambient
  lobe's 0.03–0.17 (mean 0.09). The test only says anything where the map's
  light is coloured: on mp_prisonbreak, the most coloured of the four, the
  ambient lobe sits 0.088 from the map's greenish colour key and 0.127 from
  `suncolor`, and the highlight lobe the other way about (0.217 and 0.088); on
  mp_zebra the two lobes' hues are identical to three figures. Both lobes are
  HDR: up to 6.1 on mp_prisonbreak and 11.5 on mp_frag.
- **What each lobe's alpha holds is not established.** They are signed, bounded
  to ±1, centred on 0 (sd 0.22), uncorrelated with each other (0.02) and with
  their own colour (0.02, 0.05), and spatially structured. A direction in world
  space they are not: over walls bucketed by facing they hold no trend.

**What the export writes.** `E = ambient + highlight`, which is the irradiance a
flat normal receives, as sRGB of `E / range` — `range` the power of two that
covers all but 0.1% of the page. The sun the primary gates is _not_ baked in:
the engine's own sun light casts it, and doubling it would light every sunlit
texel twice. The primary is written beside the atlas as `lightmap-primary.png`,
unread, as on IW4/IW5.

**The bake's own unit is not comparable between maps**, so `lightmap-intensity`
normalises it: it is solved so that a lit texel at the page's 90th percentile is
worth an ambient light of 0.3, and the map's own sun carries how bright the map
is. Against its worldspawn `sunlight`, the highlight lobe's p90 runs from 0.06
(mp_prisonbreak) to 0.76 (mp_descent_new) over nine zones, a spread of 12. Taken
absolutely, on mp_prisonbreak's calibration, mp_frag's bake **alone** lights its
shell to a median 211 of 255, where mp_prisonbreak's whole scene — sun
included — reaches 141.

**A map can have several pages**, each a texture of its own and each its own
size: one on 12 of the 21 Ghosts MP zones and two on the rest (`mp_descent_new`
pairs a 2048x2048 page with a 1024x2048 one). The export stacks them down one
image and moves each surface's UVs into its own page
(`shell.move_lightmap_uvs`), from `GfxSurface.laf.fields.lightmapIndex` — which
the IW6 dumper writes into the manifest and OpenAssetTools' does not. **31 is
"no lightmap"**, on 74 to 571 surfaces a map — the ones the game never lights:
vista cards, scrolling cloud and water sheets, shadow casters, caulk and
decals — and such a surface's lightmap UVs are unused and far out of range (up
to 1112 on mp_prisonbreak). They are left alone rather than zeroed, so they
sample whatever the clamped edge of the atlas holds; a texel of bake on a
sheet of cloud is not worth a second atlas column of black.

**IW4 and IW5 ship the same pair** — mp_hardhat's primary is a 2048x2048
single-channel A8 and its secondary a 1024x2048 RGBA8 — and the halves behave as
Ghosts' do (RGB correlating at 0.84 between them, alpha at 0.09 and centred on
128, which is zero for a signed byte). So `lightmap.py`'s IW4/IW5 reading, the
secondary's **alpha**, is one of the two signed channels rather than the light,
and their RGB holds the two lobes. It is left alone here: changing it changes
every MW2 and MW3 world's lighting, which is a judgement to make in renders.

**Advanced Warfare keeps Ghosts' pair**, down to the formats, the 2x primary
and the two lobes stacked down the secondary, and on all fourteen MP zones the
halves share one chart layout; one to three pages a map, 512x512 to 4096x4096
each. `lightmap.PAGED_GAMES` reads it as IW6's
([reverse/s1-zone](../../reverse/s1-zone/README.md#the-lightmap)).

**Black Ops keeps two pages in an R5G6B5 secondary and two scales in a G16R16
secondaryB** (D3D formats `0x17` and `0x22`, which the image dumper once
skipped, so every map was lit by its worldspawn sun alone). The secondary's top
page is the ambient colour and its bottom the directional one, each
`s · (4r, 2(1 − r − b), 4b)` with `s` its secondaryB channel times 31.875; the
two greens are a tangent-space direction. The primary is DXT1 at twice the
page's size, its green the sun's visibility. The lit shaders add the bake and
`sunDiffuse` (`sunParse.sunSettings.sunDiffuseColor`, times its strength) in one
unit, as T6's do, so `t5/lightmap.py` bakes `A + D · w(d)` per texel and hands
the sun over through T6's scales. Read on zombie_theater: neighbouring triangles
sample 12× more alike than random pairs on both pages.

**Black Ops II keeps one secondary per lightmap and no primary**, and its pages
mean something else. The secondary is R8G8B8A8_UNORM, three pages stacked down
it (512x1024 or 1024x1024 each; a second lightmap on five of the 15 maps is three
512x512 pages), and a vertex's lightmap coordinate spans one page. Read from
every lit world shader and `t6mp.exe`
([reverse/t6-lightmap](../../reverse/t6-lightmap/README.md), whose `verify.py`
checks all 15 maps):

| Page | Holds                                                                              | Decode                     |
| ---- | ---------------------------------------------------------------------------------- | -------------------------- |
| 0    | the **ambient** colour A                                                           | RGBD: `rgb / (a + 1e-6)`   |
| 1    | the **directional** colour B                                                       | RGBD                       |
| 2    | the **direction** D B arrives from, in world space; alpha the **sun's visibility** | `rgb * 2 - 1`; alpha as is |

A surface's diffuse light is `A + B * sat(dot(D, N)) + sunDiffuse * shadow *
sat(dot(L, N))`. The sun is live: `sunDiffuse` is `GfxWorld.sunParse`'s
`sunCd.rgb * sunCd.w`, unscaled, and `shadow` is the shadow map or, past it, page
2's alpha. There is no ambient term (`ambientColor` is zero on every map).

**What the export writes** (`scripts/cod/t6/lightmap.py`): `A + B * sat(dot(D,
N))` baked per texel, N being the surface's interpolated vertex normal rasterised
in lightmap space, which is what the game computes for the normal the engine draws
with (it has no normal maps). It is written as sRGB of `E / range`. The sun is
`sunParse`'s, and the intensities put one unit of the game's irradiance at one of
three's for both (`range / LIGHTMAP_SCALE`, `sunCd.w / DIRECTIONAL_SCALE`), so the
bake-to-sun ratio is the game's. The fill light is the one stand-in: the bake's
median in shade, for the props, which the game lights from its light grid. Page 2's
alpha goes beside the atlas as `lightmap-primary.png`.

## Prop lighting

The engine lights no prop from its world's bake; the ways it could, and what
each costs, are [rendering.md](../engine/rendering.md#lighting-props-not-built)'s
options A-D. This is what each game can feed them. **Nothing below is exported
yet.**

The games themselves light most props with **one sample per placement**, not
per vertex. IW4, IW5 and T5 store a `lightingOrigin` for each static model, where
the grid is presumably looked up (inferred from the fields, not traced in a
binary). Ghosts' and AW's `0x40` placements carry a single `colorIndex` into the
grid's palette. So a value per placement (option A) is the games' own model for
most props, not only a cheap stand-in.

| Per placement                         | IW4 / IW5                                                                                               | T5                                             | IW6                                                                           | S1                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `groundLighting` (A)                  | `GfxColor` on `GfxStaticModelDrawInst`; not dumped                                                      | `GfxColor` on `GfxStaticModelInst`; not dumped | four floats on every placement, varied, on the lightmap's scale; not exported | `GfxColorHdr` in the `0x40` member (87%); not exported                                     |
| A light-grid sample (A, D)            | `lightingOrigin` plus a grid of 56 directional RGB8 samples per colour; not dumped, lookup not reversed | the same shape                                 | `colorIndex` into the palette bitstream: **unsolved**                         | the same: **unsolved**                                                                     |
| Per-vertex light (B)                  | none                                                                                                    | none                                           | ~1% of placements                                                             | `0x80`, 5.5%                                                                               |
| Its own rectangle of the lightmap (C) | none (no `lmapUnwrap`)                                                                                  | none                                           | the field exists; no placement uses it                                        | `0x100`, 5.6%, verified ([reverse/s1-zone](../../reverse/s1-zone/README.md#prop-lighting)) |
| A shell lightmap to sample (A, D)     | yes, though IW4/IW5's reading is in doubt ([lightmaps](#lightmaps))                                     | none usable                                    | yes                                                                           | yes                                                                                        |

"Not dumped" means the IW4, IW5 and T5 GfxWorld writers write only each static
model's placement and name, and giving them the lighting
fields is a few lines each. **What `groundLighting` means has not been
established in any game.** The name suggests the light where the model meets the
ground. The IW6 and S1 walkers read all of these fields, but their backends do
not write them to the dump.

So what each option can serve today: **A** all five from `groundLighting` once it
is dumped, or IW4/IW5/IW6/S1 from a sample of the shell's lightmap traced below
the placement; **B** S1 (5.5%) and IW6 (~1%) as the game lit them, and the others
only with a bake of our own; **C** S1's `0x100` placements alone; **D** none from
a game's own grid (all blocked), and IW4/IW5/IW6/S1 from probes rendered from the
lit shell.

**What the importer would do for each.** A: `props.py` writes the value on
each `model`, where a traced sample is taken where a ray down from the
placement's origin meets the shell. B: the `0x80` values go to a sidecar, in the
game's vertex order. C: S1's model writer emits `lmapUnwrap` as the prop GLB's
`TEXCOORD_1`, and each placement's `offset`, `scale` and page are moved into the
stacked atlas the way `shell.move_lightmap_uvs` moves the shell's UVs.

**Recommended order**, for the user to accept or reject:

1. **A for all five games.** The first check below decides its source:
   `groundLighting` if it is what its name says, otherwise the traced lightmap
   sample. T5 takes either, as the others do.
2. **C for S1's `0x100` placements**, on A's per-instance path.
3. **B only if** S1's and IW6's `0x80` props visibly fail under A, and then in
   the texture form.
4. **D once a grid decodes**, or sooner if the viewmodel and player bodies need
   it anyway; A's value then becomes a grid sample.

**What needs verifying first:**

- **What `groundLighting` is.** For each game, compare it against the shell's
  lightmap texel directly below the placement, and look at the correlation and
  the ratio over a whole map. IW6's values already sit on the lightmap's scale
  (median luminance 1.0).
- **Whether IW4, IW5 and T5 populate it.** Dump one map with the field added to
  the dumper and count the distinct values.
- **Whether a constant is enough.** On one S1 map, compare the spread of the
  `0x80` values within a placement against the spread between placements. If the
  spread within a placement is small, B is not needed.
- **What a palette entry decodes to** on IW6 and S1: an RGB value, an ambient
  cube or SH. That sets A's width, and decides whether D uses the game's grid or
  our own probes.
- **The per-vertex order**, for B: whether the GLB's LOD0 vertices match
  `numLightingValues`, and whether `pack.py` reorders nothing.

## Collision

The patched clipmap dumper writes `<map>.clipmap.json` plus soup blobs.

**Brushes.** A brush is the intersection of half-spaces. The six axial planes
are implicit in its bounds; `sides` holds only the bevels. `collision.face_polygon`
clips a brush-sized quad on each plane against all the others, then drops
repeated vertices (the clip emits a vertex on a plane twice, which would make
zero-area triangles that wireframes draw as lines across the map). The export
asserts no degenerate triangle survives and no vertex leaves its brush's bounds.

**What a face is.** Each face also says what it is made of: a material index on
IW4/IW5 and IW6, whose `surfaceFlags` apply, and the flags themselves on T5. A side
record carries its own; the six axial faces' are in `axialMaterialNum` (IW) and
`axialSurfaceFlags` / `axialContents` (T5), `[0]` the min faces and `[1]` the
max, each x y z. `volumes.face_flags` lists them in
`brush_planes` order. **Without the axial arrays most box brushes have no
material at all**: more than half of all ladder faces are axial, and so is the
only material of 38% of Modern Warfare mantle volumes. The exporter refuses a
dump that lacks them.

**What a face is made of.** The same `surfaceFlags` carry a 5-bit surface type
at bit 20: `(flags >> 20) & 0x1F`, indexing the game's `surfaceTypeNames[]`.
OpenAssetTools' IW4 `infoParms[]` is the proof — each surface keyword's
surfaceFlags is exactly `index << 20` (`bark` `0x100000`, `gravel` `0xb00000`,
`riotshield` `0x1d00000`) — and `collision.surface_of` reads it beside
`ladder.py`'s `0x8`. **The table is not the same in every game**: T5's entries
29 and 30 are `player` and `tallgrass` where IW's are `riotshield` and `slush`
(`T5/Weapon/WeaponStrings.h`'s `bounceSoundSuffixes[]`), and IW3 has 29 entries
and no `riotshield` at all. OpenAssetTools publishes no IW5 table; IW5 is read
against IW4's, corroborated on mp_dome, where all 902 materials land in 0-24 and
every name matches its type (`me_sidewalk_01` concrete, `ch_ground_gravel02`
gravel, `office_tilefloor` ceramic, `clip_nosight_rock` rock, `radome_cloth`
plastic).

**Advanced Warfare's table is its own, and wider.** Its `infoParms[]` names 52
surface keywords, the last `cushion` at `0x03400000`, so the field runs to bit 25
and `mantleOn` `0x04000000` is the next flag above it:
`SURFACE_TYPE_MASK_BY_GAME["s1"]` is `0x3f`. The table is not IW's with rows
appended either — it inserts `metal_grate` at 14 and moves `cushion` to 52, so 17
of IW's 31 indices mean something else, and its 22 new types are
wet/hollow/debris variants of one the engine already has (`SURFACE_TYPES_S1` maps
each onto the engine's list; `grass_tall` is the entry T5 contributed). Read at
five bits against IW's table, every AW surface above `metal_solid` comes out as
another real surface, which looks like data rather than a bug. The check is
`mp_prison`'s own material names: `clip_grating_metal` is 14, `clip_water` 21,
`asphalt_dark_01` 23, `clip_nosight_rubber` 26, `clip_nosight_concrete_wet` 33,
`clip_nosight_metal_vehicle` 39 — each its own name's surface, and each a
different one under IW's table.

A soup triangle's surface comes from the same AABB-tree leaf its contents do,
and that one works on IW4/IW5 as well, where the contents do not: dome's 2,166
partitions tile its 18,174 triangles exactly, every partition is named by at
least one leaf, and every leaf naming a partition agrees on its material.
`caulk` carries no surface type, which is why a third of an IW map's collision
triangles come out `default` — those are brush sides nothing was meant to see.

**Contents bits** were read from the zones' own `materials` tables (no header
publishes them). The two the pipeline decides on, `SOLID 0x1` and
`PLAYERCLIP 0x10000`, match across games; a brush is kept if it has either.

**AI-only clip is kept too, and no player collides with it.** A brush with
`monsterclip 0x20000` and neither of those (`clip_ai`; on Black Ops `0x08020000`,
AI + detail) goes in a `clip:0x…` group of its own contents with
`collides: false` and its decoded `blocks` naming `ai`
(`collision.brush_role`), so `extras.collides` still means "stops a player" and
player movement and bullets are unchanged, while a runtime building an AI channel
from `blocks` finds it. A removable one is its own part's group. On
`zombie_theater` that is 37 brushes: 12 in the world (148 triangles) and 12
triangles on each of the 22 window clips and 3 `dog_clips`, which were parts with
no triangle before; on `zombie_pentagon` 147, and 34 parts gain triangles: 32
window clips, `trap_elevator_clip` and `trap_quickrevive_clip`.
The player-blocking groups are the same triangles either way. A Black Ops soup
clip is already written this way (`clip:soup:…`, `collides: false`) whatever it
blocks, so an AI channel read from `blocks` takes those as well.

| material (IW)  | contents     | blocks                                       |
| -------------- | ------------ | -------------------------------------------- |
| `clip_ai`      | `0x00020000` | AI                                           |
| `clip_player`  | `0x00030000` | player + AI                                  |
| `clip_vehicle` | `0x00000200` | vehicles                                     |
| `clip`         | `0x00030200` | player + AI + vehicles                       |
| `clip_missile` | `0x000300c0` | player + AI + projectiles                    |
| `clip_nosight` | `0x00031640` | player + AI + vehicles + projectiles + sight |
| `clip_weap`    | `0x000020c0` | AI + projectiles, not the player             |
| `mantle_on`    | `0x01000000` | nothing; marks a mantle edge (see below)     |

**Ghosts publishes the answer.** The Durango server build carries the engine's
own `infoParms[]` (`{name, clearSolid, surfaceFlags, contents}`, 24 bytes a row,
34 rows, at `0x1405e0b80`; `reverse/iw6-zone/README.md#infoparms`), which pairs
each Radiant keyword with the bit it sets. `collision.CONTENTS_BITS_IW6` is that
table, and it settles four labels IW4/IW5's guess got wrong:

| bit          | IW6 infoparm       | IW4/IW5's guess |
| ------------ | ------------------ | --------------- |
| `0x00000004` | `aiclipallowdeath` | camera          |
| `0x00000040` | `canshootclip`     | projectile      |
| `0x00000080` | `clipmissile`      | item            |
| `0x00000400` | `itemclip`         | sight           |
| `0x00000800` | `sky`              | —               |
| `0x00001000` | `ai_nosight`       | sight2          |
| `0x00002000` | `clipshot`         | detail2         |
| `0x10000000` | `structural`       | —               |
| `0x80000000` | `nodrop`           | —               |

`solid 0x1`, `playerclip 0x10000`, `monsterclip 0x20000`, `vehicleclip 0x200`,
`detail 0x8000000` and `mantleOn`/`mantleOver` `0x1000000` are as IW4/IW5 have
them, and `0x20` is water as on T5 (`clip_water`, and the only material with the
bit). Brushes whose every named face is one material confirm the whole table on
mp_prisonbreak: `clip_ai` is `0x08020000`, `clip_ai_player` `0x08030000`,
`clip_vehicle` `0x08000200`, `clip_item` `0x08000400`, `clip_foliage`
`0x08000002`, `clip_nosight` `0x08031640`, `mantle_on` `0x09000000`. The same
table's _surface_ flags name `ladder 0x8` and `sky 0x4` (which is what
`ladder.py` reads), and `mantleOn 0x02000000` / `mantleOver 0x04000000` — so on
IW6 a mantle's kind is in the flags as well as the material's name. Nothing reads
the flag: the name already names every one of 1,391 volumes across five maps.

**Advanced Warfare publishes it too, and says the same thing.** Its X360 server
build carries the same `infoParms[]` (89 rows of **20** bytes — `{name,
clearSolid, surfaceFlags, contents, toolFlags}` — at `0x8301aba8`), and every
contents bit it names is Ghosts', so `CONTENTS_BITS_BY_GAME["s1"]` is
`CONTENTS_BITS_IW6` itself. `mp_prison`'s own materials carry exactly those bits
(`clip_player` `0x00010000`, `clip_nosight` `0x00031640`, `clip_water`
`0x00000020`, `mantle_on` `0x09000000`), and no brush or material in the fourteen
MP zones sets a contents or surface bit the table does not name. **Its
surface-type field is six bits, not five** — above.

T5 differs at `0x20` (water), `0x400` (physics, not sight), `0x800` (sky) and
`0x2000` (weapon): `collision.CONTENTS_BITS_T5`. T5's most common brush contents,
`0x2080` (60% of mp_firingrange's brushes), has no SOLID bit: those are
6 cm bullet-impact shells over solid brushes, rightly dropped. In the _soup_,
`0x2080` is ordinary walkable ground.

**Ladder brushes stay in the collision mesh, and also come out as nodes.** A
ladder is a face whose surface flags carry `0x8` (the `ladder` infoparm, in all
three games; every ladder material is `0x000440b8`: ladder, noimpact, nomarks,
nodraw, nocastshadow). In the data it is always a thin invisible box of its own,
never a flagged face of an ordinary wall: contents `0x08010000` (playerclip +
detail) on 145 of 154. So `blocks_player` keeps it, in the
`clip:0x08010000` group, and that is right — the game collides with a ladder as
well as climbing it. Nothing in that group says "ladder" (it is shared with
`clip_player`, and T5 has no names), so `scripts/cod/ladder.py` reads the flag
and writes `ladder` nodes to `ladder.world` (docs/engine/player.md#ladders). Measured
over 75 re-dumped zones:

- **154 ladders**: 72 in 12 of 16 MW2 zones, 27 in 11 of 25 MW3, 55 in 18 of 34
  Black Ops. mp_dome has 2. None in the soup (4.07 M triangles) or on any
  xmodel's collision: the brush is the whole of the data.
- **636 of the 939 flagged faces are axial.** Read from the side records alone,
  the dump finds 67 of the 154.
- **147 are flagged on every face**, so the game lets a player grab one from
  any side. The other 7 are flagged on one face, which the node names as
  `face`; on all 7 it points away from the landing, which is also what fixes the
  axial arrays' index order.
- **The top is flush with a walkable surface on exactly one side** for 118 of
  154, by a probe of brush faces only (no soup, no brush models). Reported per
  map, never used to drop one.
- 5 are brush-model brushes (carbon, interchange, kowloon), placed as their
  collision is. 3 more brushes flag only a plane their hull does not have, and
  are ignored.
- **One false positive:** MW3's `sky_ny_manhattan_01` (`0x3c`) has the bit on
  36 sky faces. A ladder face is `0x8` without sky `0x4`.
- 56 flagged faces are tilted (slanted ladders); a yaw-aligned box keeps their
  yaw and loses the tilt.

**Mantle brushes** are the exception to "kept if it has either": `0x01000000`
blocks nobody, so `brush_role` drops them from the collision mesh, which is
right — a mantle volume is a permission region and a BVH is the wrong place for
one. `scripts/cod/mantle.py` picks them up separately and writes them as
`mantle` nodes in `mantle.world` (docs/engine/player.md#mantling). Measured over
43 dumped zones:

- **3,006 volumes**, 29 to 330 a map (median ~70): 594 across 7 MW3 maps, 282
  across 2 MW2 maps, 2,130 across 34 Black Ops zones, 8 of which have none.
- **Contents is uniformly `0x09000000`** (mantle + detail); 24 T5 volumes also
  carry `0x2080`. There is no player/AI variant of a mantle brush in any of the
  three games, so there is nothing for a `subject` to say.
- **None is owned by a brush model**, in any of the 3,006, so no placement has
  to be composed.
- **Half the hulls are exactly boxes**, and the best yaw-aligned box fits the
  rest to a median 0.99 of their volume — which is what makes a `mantle` node an
  `at`/`size`/`rotate` box rather than a convex hull.
- **The kind is `mantle_on`, `mantle_over` or `mount_mantle_on`, from the face
  materials** on MW2/MW3. T5 and T6 faces carry `surfaceFlags` and no material,
  and the game reads the kind off those flags (`mantleOn` 0x4000000, `mantleOver`
  0x8000000; [reverse/t6-traversal](../../reverse/t6-traversal/README.md)).
  Read from the side records alone it was unknown for 43% of IW
  volumes; read from every face, the axial ones included, **every one of 5,825
  names a kind** (41 IW zones), and none changes or
  names both. `mount_mantle_on` is in T5's material table but never resolves to
  a brush on any game.
- **The volume's top is the surface a player lands on** — mp_dome's 29 volumes
  are flush to a median 1.00 of their own height — which is why `size.y` is the
  climb height and no target has to be authored. The exporter reports this per
  map, but reads brush bounds only and no soup, so its 84% is a floor.

Clip-only brushes are the map's invisible walls: 1,300 to 4,600 per MW3 map.
`clip_player` volumes are few but huge (the boundary cage); `clip_nosight_metal`
ones are many and small (smoothing railings and pipes). Both are wanted.

**The soup's indices are segmented** on IW4/IW5 and IW6. `triIndices` is 16-bit and maps
exceed 65,536 collision vertices (mp_seatown has 72,255); each
`CollisionPartition.firstVertSegment` supplies the high part in steps of 1024.
The stride was established from the data: with it, mp_bootleg's highest index
is exactly its last vertex. Getting it wrong is silent (every index still lands
in range, on the wrong vertex) and only affects maps over the limit. Ghosts is
the same, and its `firstVertSegment` is an `unsigned char`: mp_flooded's 74,642
vertices are addressed through segments 0–9, and mp_strikezone's 68,090 through
0–3, each giving a highest index of exactly its last vertex, where the raw
indices alone stop at 65,534 and 65,532.

T5 partitions have no segment; their indices are global, which works because no
stock Black Ops zone exceeds 65,536 vertices (largest 55,824). `nuinds`/`fuind`
are a per-partition vertex gather list, **not** a segment replacement. The
exporter refuses a T5 map over the limit.

**Soup contents.** A collision AABB tree leaf links a partition to a material, so
the soup separates into ground, clip volumes and water (`collision.soup_role`).
Every backend writes the leaves. What separates a clip from ground is the
clip bits, not SOLID.

Whether such a surface is a wall is `collision.SOUP_CLIPS_COLLIDE_BY_GAME`, and
Ghosts and Advanced Warfare say yes. A Ghosts map's soup clips are thousands of
triangles of curved invisible wall — `clip_nosight_rock` and the like, over the
rock faces that bound a map (9,225 of mp_prisonbreak's 90,720 soup triangles,
2,640 of mp_frag's 67,159) — and leaving them out lets a player walk off the
edge. Advanced Warfare's are the same shape: 5,336 of mp_prison's 65,739 soup
triangles, most of them `clip_nosight_metal` and `clip_nosight_rock`. Black Ops
II's code says the same, and more: `SOUP_STOPS_BY_GAME` gives a soup triangle the
role its player and bullet masks give it ([games.md](games.md#black-ops-ii-t6--walkable-textured-and-lit)).
Black Ops' are a couple of small volumes a map, which is the open call in
[games.md](games.md#black-ops-t5). Either way a soup clip that stops only AI or
vehicles is not a wall, and water never is.

**Ghosts brush models share the map's ClipInfo, through the game's own global.**
`Load_clipMap_t` ends with `Load_ClipInfoFixup(&clipMap->pInfo, &cm.info)`, and
every stock `cmodel_t.info` is an offset alias of that same slot — so it points
into the _executable_, at the global `clipMap_t cm`, not into the asset. Read as
a ClipInfo of its own it is an empty struct, and every submodel comes out with no
brushes: a map's brush-model walls silently vanish from the collision mesh.
`iw6/dumpers/clipmap.clip_info` compares the pointer with the clipmap's own
`pInfo` instead. On five stock maps all 412 submodels share, and 381 have brushes.

## Brush models

A brush model N ≥ 1 is `GfxWorld.models[N]` (surfaces) plus `clipmap.cmodels[N]`
(brushes and soup partitions); index 0 is the world. Its geometry is stored
relative to whatever places it. In all 54 stock MP maps, each has exactly one
placer (`brushmodels.load`):

- an entity whose model key is `"*N"` (`script_brushmodel`, `glass`, T5
  `trigger_*`), at its origin. None of 3,903 has non-zero angles;
- a dynamic entity whose `brushModel` is N (breakable signs, ceiling tiles), at
  its pose. All 210 carry the identity quaternion.

Only `script_brushmodel` and `glass` are solid in game. Black Ops makes every
trigger a brush model with SOLID in its contents, so trusting contents would
turn every bomb site into a wall. Established by structure (the model ranges
tile the surface array; `cmodels[N]` bounds equal `models[N]` bounds + 1 unit)
and by placement (moved to its origin, glass lands within 6 mm of its window
frame; at random offsets, about 1%).

## Game-mode objects

Some entities exist in only some game modes: a bomb site's crates, the
Headquarters boxes, Black Ops' wager barriers. The entity says which in
`script_gameobjectname`, a space-separated list of names. Each gametype's
`onStartGameType` hands `maps/mp/gametypes/_gameobjects.gsc`'s `main` the names
it allows, and `main` deletes, once at level load, every entity carrying the key
whose names include none of them. The entity is gone from that match: model,
collision and trigger alike. An entity without the key is in every mode.

`scripts/cod/gameobjects.py` holds the lists and `modes_of`, which gives an
entity's **mode keys**: the gametype names in which it survives, with IW's `war`
spelled `tdm` as the spawn classnames spell it. A `mode:` lists these keys, never
the raw names.

**Black Ops, from source** (`common_mp.ff`; `patch_mp.ff` replaces `ctf`, `dem`,
`dom`, `koth` and `sab` with the same lines). `_gameobjects.gsc:5-47` is `main`,
and `entity_is_allowed` (`:50-78`) keeps an entity whose whole value is
`"[all_modes]"` (`:63`) and otherwise splits the value on spaces (`:67`).

| Mode key                            | Allowed names                                   | Where                                                                       |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `tdm`                               | `tdm`                                           | `tdm.gsc:128`                                                               |
| `dm`                                | `dm`                                            | `dm.gsc:119`                                                                |
| `dom`                               | `dom`                                           | `dom.gsc:227`                                                               |
| `koth`                              | `hq`, and `koth` on `mp_kowloon` only           | `koth.gsc:201-206`                                                          |
| `sd`                                | `sd`, `bombzone`, `blocker`                     | `sd.gsc:320-322`                                                            |
| `dem`                               | `sd`, `bombzone_dem`, `blocker`, `dem`          | `dem.gsc:366-374`                                                           |
| `sab`                               | `sab`                                           | `sab.gsc:222`                                                               |
| `ctf`                               | `ctf`                                           | `ctf.gsc:308`                                                               |
| `twar`                              | `twar`, and `dom` on a map without War's spawns | `twar.gsc:367-422`, `:460-467`                                              |
| `gun`, `oic`, `shrp`, `hlnd`, `sur` | the name itself                                 | `gun.gsc:305`, `oic.gsc:184`, `shrp.gsc:160`, `hlnd.gsc:220`, `sur.gsc:180` |

Two lists depend on the map. Demolition allows `bombzone` in place of
`bombzone_dem` when no entity's targetname is `bombzone_dem` (`dem.gsc:366-369`),
so it reuses Search and Destroy's sites. War keeps Domination's objects when the
map lacks any of `mp_twar_spawn_axis_start`, `mp_twar_spawn_allies_start` or
`mp_twar_spawn`, because it then spawns on Domination's points.

**MW2, from source** (`common_mp.ff`). `_gameobjects.gsc:5-39` is the same loop
without `[all_modes]`, and its first line (`:7`) appends `airdrop_pallet` to every
gametype's list, so an entity naming it is in every mode.

| Mode key  | Allowed names               | Where               |
| --------- | --------------------------- | ------------------- |
| `tdm`     | `war` (`level.gameType`)    | `war.gsc:111-112`   |
| `dm`      | `dm`                        | `dm.gsc:81`         |
| `dom`     | `dom`                       | `dom.gsc:159`       |
| `koth`    | `hq`                        | `koth.gsc:201`      |
| `sd`      | `sd`, `bombzone`, `blocker` | `sd.gsc:200-202`    |
| `dd`      | `dd`, `bombzone`, `blocker` | `dd.gsc:272-274`    |
| `sab`     | `sab`                       | `sab.gsc:170`       |
| `ctf`     | `ctf`                       | `ctf.gsc:186`       |
| `oneflag` | `ctf`                       | `oneflag.gsc:124`   |
| `gtnw`    | `gtnw`, `gtnw_zone`         | `gtnw.gsc:138-140`  |
| `arena`   | `dom`, `arena`              | `arena.gsc:125-127` |
| `vip`     | `vip`, `sd`                 | `vip.gsc:118-119`   |

**MW3, from its compiled scripts.** Its gametypes are compiled `ScriptFile`s, and
each one's inflated buffer holds its string literals in order. Right after its
spawn-point setup each names exactly MW2's list: `sd` `bombzone blocker`, `koth`
`hq`, `arena` `dom airdrop_pallet arena`, `gtnw` `airdrop_pallet gtnw gtnw_zone`,
`vip` `vip sd`, `oneflag` `ctf`, and `war` only `airdrop_pallet` (its own name is
`level.gameType`, a variable). The one difference is Demolition, which names
`dd_bombzone blocker`, and MW3's maps carry `dd_bombzone` on Demolition's own
sites. The unnamed script whose first strings are `airdrop_pallet`,
`briefcase_bomb_mp` and `briefcase_bomb_defuse_mp` is `_gameobjects.gsc`: MW2's
`main` and `init` in that order. MW3's other gametypes (`conf`, `infect`, `jugg`,
`tjugg`, `grnd`, `tdef`, `gun`, `oic`) name no gameobject there and are not
tabled; no MW3 entity names them.

**Advanced Warfare** is read as MW3, not yet checked against its scripts, plus
`hp` and `horde`, each allowing its own name. **Ghosts**: no entity in its zones
carries the key.

**What the maps carry**, over the 72 imported worlds:

| Game | Names on entities                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MW2  | `hq`, `sab`, `bombzone`, `ctf`, `dom onslaught`, `gtnw`, `airdrop_pallet`, `sd`, `arena`                                                                         |
| MW3  | the same, and `dd_bombzone`, `dom dd sd`                                                                                                                         |
| BO1  | the above, the four wager modes in any order, `bombzone_dem`, `twar`, `[all_modes]`, lists naming up to eleven modes, and `tktc`, `ktc`, `ffa` on mp_russianbase |
| AW   | MW3's, and `horde`, `hp`, `drop_obj`, `boost_add`, `boost_remove`                                                                                                |

A name no list holds is **unknown**. Beside a name the lists know it is ignored
(`onslaught`, on every map's Domination flags, and `ffa`). An entity naming only
unknown names (`tktc`, `ktc`, AW's `drop_obj` and `boost_*`) is left in every mode
rather than guessed out of one. The export prints each unknown name once.

**How a world says it.** A script model gets `mode:` in `props.world`, a radius
trigger in `gameplay.world`. A solid brush model (`brushmodels.SOLID_CLASSES`)
whose entity is restricted becomes a **part** of `collision.glb`, and so does
one that is DYNAMICPATH in every mode ([below](#dynamicpath-brush-models)); both
are `brushmodels.part_of`. A part is one mesh per
group it has triangles in (`solid`, `soup`, each `clip:0x…`), named
`part:*N/<group>`, whose `extras` carry the group's usual fields plus
`part: "*N"` and `entity`, its index in `export_metadata.json`. The scene's
`extras.parts` lists every such brush model with its triangle count, including
one with no triangle that blocks the player, and `gameplay.world` names each with
`solid { part: "*N", tag: ..., mode: ... }`, its tags the entity's names
([below](#zombies-entities)). Unrestricted brush models stay in the ordinary
groups, and the base's triangles plus the parts' are the file's whole, which
`export_collision` asserts. mp_cairo has 39 parts (496 of 157,092 triangles; the
fourteen wager barriers are `gun hlnd oic shrp`), and mp_dome 17 (368 of 120,366:
the bomb sites and Headquarters crates, none in `tdm`).

**The drawn half.** Such a brush model's rendered surfaces go into `world.glb` (or
`decals.glb`) as a node and mesh `part:*N` of their own, never merged with the
base mesh `world`, whose `extras` are `{part: "*N", group: "world"}`; that
file's scene `extras.parts` lists **only the parts it draws**, each with its
triangle count, in the same shape as the collision file's. The same `*N` names
both halves, so a gametype hides a part's model and collision together. The base
and the parts are every drawn triangle, which `export_shell` asserts. mp_dome's
restricted brush models are all invisible clip, so its shell has no parts. Eight
of mp_cairo's wager barriers are drawn (54 triangles): doors
(`cub_art_door_brown_tall`, `jun_art_door_wood02_blue`, `eb_art_door_wood_diana`)
and the walls around them, which close a doorway only in the wager modes.

`equiv` folds a part back into the group it was split from: its triangles are
compared under the group's key, its counts added to the group's, and the part
lists are EXTRA. A triangle moved into a part is not a loss; one dropped is.

### DYNAMICPATH brush models

A `script_brushmodel` whose `spawnflags` has bit 1 is **DYNAMICPATH**: the game
builds its path links as if the brush were absent, and a script disconnects and
reconnects them (`DisconnectPaths` / `ConnectPaths` refuse any other brush
model). Black Ops' `SP_script_brushmodel` sets the entity flag both of those test
from exactly this bit, and the zombies scripts disconnect every door piece at
load and connect it when the door opens
([reverse/t5-zombies](../../reverse/t5-zombies/README.md#3-door-links)). So the
bit is the game's own list of brush models that can go away, and each is a
**part** in every mode: `solid { part: "*N", tag: ... }` with no `mode`, present
until a script removes it.

On `zombie_theater` that is 50 parts: all 23 door pieces, the 22 window clips, the
3 `dog_clips`, `theater_curtains_clip` (opened on power) and `vending_revive`'s
clip; nothing else on the map has the bit. `zombie_pentagon` has 96. The window
and dog clips block AI and not the player, so their triangles are in a
`collides: false` group whose `blocks` names `ai` ([Collision](#collision)).
Pentagon's debris `jiggle` pieces are bullet shells (`0x2080`), blocking neither,
and are listed with 0 triangles. MP maps carry the bit too,
on prefab pieces: mp_dome has 33 parts where its modes alone gave 17, mp_hardhat
70 (17) and mp_afghan 53 (19). MW2, MW3 and AW name the key `spawnflags` as Black
Ops does; Ghosts' number for it is unnamed (`entities.IW6_KEY_NAMES`), so none of
its are found.

## Zombies entities

What a Black Ops zombies map's entity lump says, and the generic node each
becomes. The world says what is where and what points at what; prices, prompts,
round logic and which zone wakes which are the script's, so none of them is
exported (`scripts/cod/gameplay.py`, `scripts/cod/triggers.py`).

Every node's `tag` is the entity's `targetname`, `script_noteworthy` and
`script_string`, in that order and each once, and its `target` the entity's own
when some node carries that tag. A target naming a `script_model` (the wall-buy
chalk, a perk machine), a `misc_turret` or a path node is dropped and counted: no
node is written for those.

| Entity                                                | Node                                          | Where         | Example (theater)                                                                       |
| ----------------------------------------------------- | --------------------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `info_volume` (a zone), `*N`                          | `trigger` box per brush, `target` spawners    | volumes.world | `tag: "foyer_zone" "player_volume", target: "foyer_zone_spawners"` (2 boxes)            |
| `trigger_use` (door, debris, wall buy, box, perk)     | `trigger` box per brush, `use: near`          | volumes.world | `tag: "zombie_door", target: "backstage_door", use: near`                               |
| `trigger_use_touch` (pentagon's doors, some boxes)    | `trigger` box per brush, `use: touch`         | volumes.world | pentagon `tag: "zombie_door", target: "pf824_auto2727", use: touch`                     |
| `trigger_multiple`, `_once`, `_damage`, `_hurt`       | `trigger` box per brush                       | volumes.world | traps, the teleporter pad, audio zones                                                  |
| `script_brushmodel`, DYNAMICPATH                      | `solid`, no `mode`                            | gameplay      | `solid { part: "*27", tag: "backstage_door" }`, clips add `"clip"`                      |
| `actor_zombie_*`, `actor_zombie_dog`                  | `point`, facing its `angles`                  | gameplay      | `tag: "foyer_zone_spawners" "zombie_spawner"`: the tag its zone's `info_volume` targets |
| `script_struct` / `script_origin` with a `targetname` | `point`                                       | gameplay      | `exterior_goal`, `*_rise` and `*_dog` spawns, box and teleport spots                    |
| `player_respawn_point` struct                         | `point`, and a `spawn` (`metadata.py`)        | gameplay      | `tag: "player_respawn_point" "foyer_zone"`: the zone it serves                          |
| `script_struct` with `script_sound` + `script_label`  | nothing: the client's ambience, `sound.world` | —             | `amb_chandelier_loop`                                                                   |

Brush volumes are placed as [research](../../reverse/t5-zombies/README.md#2-volumes-clipmap-bounds-against-fit_box)
measured: `cmodels[N]` and its brushes are model space around the entity's
origin, so world = `origin` + local, and no volume entity carries a rotation.
Theater writes 179 boxes for 169 entities, pentagon 162 for 156.

**Prices**, from each trigger's `zombie_cost` (`door_init` defaults a missing one
to 1000), for a script that wants CoD's own. A script keys them by the tag the
trigger targets. The box (`treasure_chest_use`) is 950 on both maps.

| Map      | Target                                             | Kind   | Cost | Note                                                     |
| -------- | -------------------------------------------------- | ------ | ---- | -------------------------------------------------------- |
| theater  | `foyer_top_door`, `foyer_bottom_door`              | door   | 750  |                                                          |
| theater  | `vip_top_door`, `alley_door2`                      | door   | 1000 |                                                          |
| theater  | `backstage_door`, `dress_door`                     | door   | 1250 |                                                          |
| theater  | `dining_room_door`, `alleyway_fencedoor`           | door   | 1250 |                                                          |
| theater  | `theater_to_foyer_door`                            | door   | 750  | `electric_door`: opens free on `power_on` (`door_think`) |
| pentagon | `pf318_auto1` (`pack_room_door`)                   | door   | 750  |                                                          |
| pentagon | `pf824_auto2727`                                   | door   | 750  |                                                          |
| pentagon | `pf824_auto2731`, `_2738`, `_2739`                 | door   | 1250 |                                                          |
| pentagon | `war_room_stair`, `elev1_blocker`, `elev2_blocker` | debris | 1000 |                                                          |
| pentagon | `war_room_west`, `war_room_east`                   | debris | 1250 |                                                          |
| pentagon | `pf890_auto2747`, `pf890_auto2748`                 | lift   | 1250 | `elevator1_call_box`                                     |
| pentagon | `pf892_auto3`, `pf892_auto4`                       | lift   | 1000 | `elevator2_call_box`                                     |

### The use rule

Black Ops picks what the use key uses by building a list of candidates and
sorting it ([reverse/t5-zombies](../../reverse/t5-zombies/README.md#4-the-use-rule),
read from `BlackOps.exe`). `game/focus.ts`'s `USE_RULE` keeps its numbers:

- **`trigger_use_touch`** (`use: touch`): the player's box, `(-15,-15,0)..(15,15,70)`
  in, overlaps the trigger. No angle, no line of sight; it scores **−144**.
- **`trigger_use`** (`use: near`): the **eye** within **72 in** (1.83 m) of the
  centre of the trigger's bounds — inside is not required — and a clear trace
  from the eye to that centre. With `UseTriggerRequireLookAt()` the view must
  also satisfy **`dot(forward, toCentre) ≥ 0.76`** (about 40.5°).
- **Score** `512 × (1 − dot) / 2 + inches − 512`, lowest wins.
- **Which things want the look** is the GSC's, not the class's: doors, debris,
  window shutters and boards do not call it; wall buys, perks, the bowie and
  equipment buys, turrets and pentagon's traps and elevator do. So it is the
  script's `usable` here, not a world property.

Where the engine differs, on purpose: a `touch` is judged against the player's
own upright body (the capsule's 0.3 m radius and 1.7 m height) rather than a
30 in square; the trace runs on the `shots` channel, since `sight` is not built;
and for a usable `solid` it stops where it enters the solid's bounds, since the
game's trace skips the entity being used.

The round, health and points numbers are in
[reverse/t5-zombies](../../reverse/t5-zombies/README.md#5-numbers). The scripts
that set them are the **patch** zones' (`common_zombie_patch.ff`,
`zombie_theater_patch.ff`), which replace the base GSC and are not in
`maps.json`: nothing the export writes reads GSC for gameplay yet, so they are
listed here for the day something does.

### Black Ops zombies

`game/scripts/zombies.ts` plays BO1's rules on a map that carries the entities
above (`zombiesGametype`: `game: t5`, maps `theater-bo1`). The numbers are the
README's [§ 5](../../reverse/t5-zombies/README.md#5-numbers); what the script does
with the world's links, and where it stops, is here. Lines are
`common_zombie_patch/maps/_zombiemode.gsc` unless named.

| What               | Value                                                                                         | Read from                                            |
| ------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Zombies in a round | `24 + int(…)` by players and round, × 0.25/0.3/0.5/0.7/0.9 in rounds 1–5 (round 1 solo: 6)    | `round_spawning`, `default_max_zombie_func`          |
| Alive at once      | 24                                                                                            | `zombie_ai_limit`                                    |
| Health             | 150, +100 a round to 950 at round 9, then +10 % a round (1045 at 10)                          | `ai_calculate_health`, CSV MEDIUM                    |
| Spawn delay        | `2 × 0.95^(round−1)` s, held at 0.08                                                          | 3951–3961                                            |
| Gait               | `randomintrange(speed, speed + 35)` (upper bound excluded); ≤ 35 walk, ≤ 70 run, else sprint  | `set_run_speed`                                      |
| First round        | 2 s after the first player arrives                                                            | `round_start`'s `wait( 2 )`                          |
| Between rounds     | 10 s                                                                                          | `zombie_between_round_time` (707–709)                |
| End of game        | everybody dead; the match ends 15 s later                                                     | `checkForAllDead` (1567), `zombie_intermission_time` |
| Starting points    | 500 each                                                                                      | `zombie_score_start_Np`, MEDIUM                      |
| A hit              | 10, on a hit that does not kill [inf]                                                         | `_zombiemode_score.gsc`                              |
| A kill             | 50, + head/helmet 50, neck 20, torso 10, limb 0; a blow 50 + 80                               | `_zombiemode_score.gsc`                              |
| Door prices        | the table above; 1000 where a door says none                                                  | `zombie_cost`, `door_init`                           |
| The dead           | stay dead until the round ends; brought back after round 6 with less than 1500 are given 1500 | `spectators_respawn` (2778–2804)                     |

**Which spawners a round uses.** A zone is an `info_volume`, exported as a
`trigger` whose first tag is its name and which carries `player_volume`; its
`target` tags its spawners (`zone_init`: `zone.volumes[0].target`). A player's
zones are the ones whose triggers their feet are in (`ctx.zonesOf`), and a round
draws from the spawners of every zone a living player stands in, drawing again
once when it lands on the spawner it used last (`old_spawn`). Not walkers, and
not spawned: points tagged `riser`, `find_flesh` or `quad_zombie_spawner`, and
dog spawners (a tag ending `_dog`). Leaving quads out altogether stands in for
theater's `theater_ignore_spawner` (`zombie_theater.gsc` 464), which keeps them
out until the curtains open. A spawner whose `script_string` is `zombie_chaser` is a
walker like any other: it stands on a roof or a ledge (theater's VIP roof is 5.7 m
over its floor, the alleyway's 13 m), skips the window in the game
(`zombie_think`, `_zombiemode_spawner.gsc` 476–495), and comes down a
`zombie_jump_down_*` traversal; here every zombie hunts straight away, so it does
the same.

**Which window clips go at match start.** A window is an `exterior_goal` point;
its `target` names what blocks it. The script removes that target's solids when
**every** solid carrying it is a `clip`, and leaves a window whose target also
names its boards, since the boards are torn down one at a time and that is not
built. On theater all 22 window targets are clip-only.

**Doors.** A trigger tagged `zombie_door` is bought through `interact` for the
price its `target` has on this map, if the buyer has it; the solids with that tag
are then removed. It is usable from any angle (`door_init` never calls
`UseTriggerRequireLookAt`). An `electric_door` is not for sale: the power opens
it, and power is not built. Solo rules only — a buyer pays from their own purse;
BO1's team pool (0 on MEDIUM) is not kept.

Not built: adjacent zones (BO1 also wakes the zones next to an occupied one once
the door between is open — `add_adjacent_zone`, in each map's own GSC, which the
export does not read), risers, dogs, quads, boards and their repair, perks, the
box, power, last stand, the round 4–9 last zombie made to sprint
(`zombie_speed_up`), BO1's respawn points (the start spawns are used), the round
sounds, and the starting M1911.

On theater, one door trigger cannot be focused: `vip_top_door`'s upper trigger
(the slab at y 9.5) has its centre on or behind the geometry from both sides, so
the `shots` trace to it is blocked. Its lower trigger can, so the door can still
be bought (`game-server/tests/zombiesTheater.test.ts`).

## Entities and worldspawn

The `mapents` dump is Quake-style text. IW5 keys are per-zone script-string
indices (`1668 "script_model"`); IW4 and T5 keys are quoted names. So
`entities.detect_keys` recognises keys by content: classname is whichever key
holds `worldspawn`, origin and angles are the three-number keys (angles within
±360), picked by **how many entities carry them**, then by span. Span alone
picked a key on one entity (all rotations became zero on mp_underpass) and a
second map-scale vector (vehicles 0.9 m in the air on mp_bootleg).

IW6's keys are numbers too, but other ones; `entities.IW6_KEY_NAMES` has them
and their evidence. The IW5 indices are the same in all 25 MW3 zones, and `entities.IW5_KEY_NAMES`
names the ones that could be confirmed: mp_terminal_cls remakes IW4's
mp_terminal, 505 entities share a classname and origin, and each index takes
the IW4 key whose value it repeats. The rest stay numeric in
`export_metadata.json` (its `unnamed_keys` lists them).

Worldspawn keys, every spelling tried (`worldfile.WS_KEYS`):

| meaning                                 | IW4 / T5                          | IW5 index | IW6 index      |
| --------------------------------------- | --------------------------------- | --------- | -------------- |
| sun direction (pitch yaw roll, degrees) | `sundirection`                    | 1991      | 761 (or 32069) |
| sun intensity                           | `sunlight`                        | 1989      | 759, 32081     |
| sun colour                              | `suncolor`                        | 1990      | 760, 32066     |
| ambient intensity                       | `ambient` (T5 `ambientintensity`) | 1987      | —              |
| ambient colour                          | `_color` (T5 `_ambientcolor`)     | 2811      | —              |

The entity match puts `_color` at 2813, not 2811 (29 entities agree), so 2811 is
probably `skycolor` and MW3 fill lights take the sky colour. Unresolved: a fix
changes every MW3 world's lighting and needs judging in renders.

IW6's numbers are its own, and each was settled against the map's own lightmap
rather than by shape ([lightmaps](#lightmaps)): **761** is the direction the
primary page's sun-visibility mask follows, **760** the colour of the highlight
lobe, and **759** the only scalar key in every one of the 21 MP zones, whose
value the highlight lobe's brightness tracks over nine of them (0.2 to 10;
Spearman 0.83 against its p90). A second key repeats each value on almost every
zone (32081 on 21 of 21, 32066 on 19, 32069 on the 3 that carry it), so both
spellings are tried. **No ambient key is established**: the one colour key every
zone carries (1619) is a saturated blue on mp_strikezone and matches the bake's
ambient lobe only on some maps, and no scalar key tracks that lobe at all
(3235, its best candidate, is 0.1 on mp_prisonbreak and 0.0 on mp_zebra, whose
bakes are within a third of each other). So a Ghosts world takes the house
ambient, and the lightmap carries the map's real one.

Colours are written 0..1 by some maps and 0..255 by others. Black Ops' light
values run about 12× (sun) and 4× (ambient) IW's, and Ghosts' suns about 3×
(median 4 against IW's 1.2, over the whole roster each way), so
`LIGHT_SCALE_BY_GAME` divides them to put each game's median on IW's scale, an
empirical fit.

The sun's `at:` is its forward vector `(cos p cos y, cos p sin y, −sin p)`,
converted to the engine frame, 120 m out.

**Vision file.** `<map>.vision` (a rawfile) holds the film grade: `r_filmLightTint`,
`r_filmMediumTint`, `r_filmDarkTint` (0..2, 1 neutral) and the two
`r_filmDesaturation` values, which are exactly `grade`'s properties. A grade is
a function of luminance, so it cannot fix a scene lit wrongly; fix lighting
first. Per-map lighting lives in worldspawn and the vision file, not in the
compiled shaders.

## Path nodes

What each game ships for AI navigation, and what an exporter of it depends on.
How each fact was established, and the tools that re-check it:
[reverse/cod-pathdata](../../reverse/cod-pathdata/README.md). What an
exporter writes from it: [navigation.md](navigation.md).

| Game   | Where                                                    | Read by                                     |
| ------ | -------------------------------------------------------- | ------------------------------------------- |
| MW2    | nowhere                                                  | -                                           |
| MW3    | `PATHDATA` (17) in `so_survival_<map>.ff`, 22 of 25 maps | not yet (the reverse/ scan finds it)        |
| BO1    | `GameWorldMp.path` (15); zombies `GameWorldSp.path` (14) | `scripts/cod/t5`, the zonecode walker       |
| BO2    | `GameWorldMp.path` in the map zone, all 15 MP maps       | `scripts/cod/t6`, the zonecode walker       |
| Ghosts | `PATHDATA` (22) in `<map>_path.ff`                       | `scripts/cod/iw6`, emulated `Load_PathData` |
| AW     | `PATHDATA` (27) in `<map>_path.ff`                       | `scripts/cod/s1/paths.py`                   |

- **The node array is the entity lump's `node_*` entities, in lump order.** On
  every map with both, count, order, x/y, animscript and target agree, so a
  node's index is its entity's rank among `node_*` entities. MW3's MP zones
  carry only the entities; its Survival zone is their compiled PathData.
- **Heights differ by game.** MW3, Ghosts and AW compile a node down onto the
  floor (0.6–0.8 in above the collision our player walks on, 95% within 10 cm);
  a `node_*` entity's own `origin` is authored higher (median 61–111 cm, up to
  ~5 m on MW3). Both Black Ops keep the authored height in their PathData too. Snap
  from an entity origin or a T5 node by searching down, not by a small settle.
- **After the entity nodes:** Ghosts and AW append one type-0 node per path zone
  (`zoneCount` of them), linked only to each other; they are not places. Black
  Ops stores 128 empty runtime slots after `nodeCount` (not in the count).
- **A link** is `{f32 fDist, u16 nodeNum, u8 disconnectCount, u8
negotiationLink, ...}`, 12 bytes, directed and stored per node; 1–2% of links
  have no reverse. `fDist` is the **horizontal** distance in inches on a walk
  link, and a cost on a negotiation link (Black Ops: always 15.0). Shipped
  `disconnectCount` and bad-place counts are always 0. Black Ops II's is 16
  bytes, with a `flags` byte after `negotiationLink`: 0x10 marks a redundant link
  no search takes, 0x08 and 0x20 a link a double-width AI and a quadrotor may use.
- **The linking rule:** no game links two nodes more than 256 in apart
  horizontally, or (bar outliers) more than 128 in apart vertically, and within
  that it links every pair its traces allow — up to 25 (MW3) to 49 (AW) links a
  node.
- **A traversal** is a `NEGOTIATION_BEGIN` whose `target` names one
  `NEGOTIATION_END`, joined by the one link with `negotiationLink` = 1; the
  animscript is on the begin node, under entity key `1983` (MW3), `animscript`
  (BO1, BO2), `52` (Ghosts) or `71` (AW). A Black Ops II begin without one is a
  negotiation hint, its move named by a spawnflag: 0x400000 LADDER, 0x800000
  MANTLE, 0x1000000 JUMP, 0x2000000 FALL. The number in an animscript's name is the
  obstacle the animation was made for; the pair's own rise varies.
- **spawnflags** keep the entity's bits and add the compiler's; 0x8000 (AW
  0x80000) is set exactly when the entity has `angles`, i.e. when the node's
  yaw means something.
- **Node types** are numbered per game, alike up to `COVER_LEFT` (7): MW3's
  enum is `IW5_Assets.h`'s, Black Ops' `T5_Assets.h`'s, Ghosts' x64-zt's IW6
  `structs.hpp` (`COVER_MULTI` at 8 shifts the rest), and AW uses Ghosts'
  numbers. No map ships a door, `*_3D` or `DONTLINK` node.
- **Ghosts' dynamic node groups** (5 maps, 37 nodes) store their nodes in the
  parent entity's frame (`vLocalOrigin`, `parent` = the group's `parentIndex`):
  their coordinates are not world positions.

## Minimap

`compass_map_<zone>` is a top-down image; the map places it with
`maps/mp/_compass.gsc::setupMiniMap` (ported as `metadata.minimap_frame`). Two
`minimap_corner` entities are opposite corners of a rectangle aligned to
**north**, the direction `northyaw` degrees from CoD +X; the rectangle is widened
about its centre to a square (`scr_RequiredMapAspectratio`, 1). Image up is north.

Only mp_estate sets `northyaw` (144). Everywhere else it is 0, so image up is
CoD **+X** and image right is CoD −Y, not the +Y-up a top-down view suggests.
Established by plotting every map's spawns on its minimap: all 43 land on the
drawn playable area at 0 (Estate at 144), and at 90 they spill off it. Ghosts
reads the same way, from a different game's zones: all 1,392 of
mp_prisonbreak's AI pathnodes land inside its drawn boundary, and on its ground
rather than in its rocks.

In the engine frame image up is +X, which `minimap.world` writes as
`rotate: -90` (Estate: 54, which is `northyaw` − 90).

## XModels

Each XModel is dumped as a GLB in inches, with textures as external `.iwi`
paths and no alpha mode, plus a JSON with its LOD table (`lods[].distance`:
where the next LOD takes over; the last is the cull distance, 1e6 = never),
`collLod` and `contents`. On props the vertex alpha is a
wind/sway weight, not opacity; multiplied into a MASK material it discards
whole plants, so `pack.py` forces it to 1, after copying it to `_FLAG_WEIGHT`
on the materials that use it ([flag wind](#flag-wind)). A rigged XModel's GLB
has a `skin` whose joints carry the game's bone names; the root joint holds
the Z-up → Y-up rotation OAT's GLB writer puts there, and every other joint is
in CoD's own frame. Every backend writes that layout (`scripts/cod/xmodel_glb.py`) from the
zone's own skeleton and weights
([reverse/iw6-zone](../../reverse/iw6-zone/README.md#skeletons-and-skinning)).

**An IW5 base-pose quaternion is not unit length.** `DObjAnimMat` stores a
quaternion with |q|² about 1 + 2e-5 .. 6e-5 and a `transWeight` of 2/|q|², which
the game scales its rotations by. OpenAssetTools ignores `transWeight` and
builds each bone with the unit-quaternion formulas from the quaternion as
stored, so a bone 1000 units out lands up to 7e-4 from where a normalised
quaternion puts it. The IW5 backend reproduces OAT's bones (`ModelLodData.stored_rotations`);
IW6 and S1 build from the normalised rotation.

## Animations

A map animates the `script_model`s whose `targetname` is `animated_model`:
`maps/mp/_animatedmodels.gsc` plays `level.anim_prop_models[model][key]` on
each. That table is filled by one small script per prefab, which the entity
names in `precache_script` (`maps animated_models <name>`):

```
model = "foliage_desertbrush_1_animated";
level.anim_prop_models[ model ][ "sway" ] = "foliage_desertbrush_1_sway";
```

IW4 and T5 ship these as text rawfiles, `maps/animated_models/<name>.gsc`. IW5
and IW6 compile them to `scriptfile` assets named by number; OAT (and the IW6
backend) writes each as a `.gscbin` (the name, a NUL, three int32 sizes:
compressed, inflated, bytecode; then the zlib-compressed string section and the
bytecode). The string section keeps the literals in first-use order, the model,
the animtree `animated_props`, then each clip and its key, so `animations.py`
reads the pairing from it and accepts a string as a clip only if the zone has a
clip of that name. Bytes before a literal can be printable (`|` before IW6's
models), so the model is the name that ends its run. Two things make the scripts
the only source:

- Clip names do not follow model names (`foliage_desertbrush_3_animated` plays
  `foliage_desertbrush_1_sway`), and one clip serves several models (mp_afghan's
  `bushtree02` and both half-size variants play `bushtree01_sway`).
- Two scripts can give one model different clips (mp_dome's 134×76 tarps:
  `med_01` and `med_02`). The entity's own `precache_script` decides; IW5's
  scripts are named after the clip they assign.

The clips are `xanim` assets in the map's own zone, dumped as compiled xanims
(`xanim/<name>`, no extension): version 17 for IW4/IW5 (18 only when a clip has
a 3D root-motion track), 19 for T5. Every backend writes them with
`xanim.encode`, a port of OAT's writer, and the IW6 and S1 backends in IW5's
versions. `xanim.decode` reads them,
a port of OAT's `CompiledXAnimLoader.cpp`:

| Field            | Meaning                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Header           | version, frames, bone count, flags (loop, delta, delta3D), asset type, fps                 |
| Rotation keys    | int16 components over 32767, `w` rebuilt from the other three; a 2-component key is (z, w) |
| Translation keys | `mins + size × q`, `q` a byte (steps of 1/255) or a short (1/65535) per axis               |
| Indices          | the frame of each key; omitted when a track keys every frame; bytes when frames < 256      |
| Looping          | a looped clip stores frames + 1 keys, the last repeating the first                         |
| Delta track      | root motion; flagged on some clips, empty on every mp_dome clip, never applied to a prop   |
| Notetracks       | name and frame of each cue (sounds, rumble, events); OAT divides the frame by the count    |

What the values mean was settled on mp_dome's pump jack, whose linkage only
closes one way, and cross-checked against the beam's own geometry:

- **A rotation key replaces the bone's local bind rotation.** Composed with it
  instead, the pitman arm tears off the walking beam.
- **A translation key is an offset added to the bone's local bind translation**,
  on asset type 2, which every animated prop measured is. The pump jack's
  `j_head` key of −60.7 in matches the drop the beam's 23.8° swing gives a
  147 in arm; taken as absolute, a brush tip 66 in up collapses to its root.
  On asset type 1 (every view clip) the key _is_ the translation
  ([viewmodels](#viewmodels)); `animations.TRANSLATION_BY_ASSET_TYPE` picks.
  Type 0 (three light swings, a fan, a hose) is unverified and read as an
  offset, which the export log flags.
- **Advanced Warfare does not go by asset type.** A translation key adds to
  the _model's_ `tagPositions`, and the view arms store zeros there, so a view
  clip is absolute on arm bones and an offset on the gun's; a body clip is an
  offset whatever its type (340 are type 1, and read as absolute they sink the
  head 8.8 in into the chest). The S1 xmodel dump writes `zeroTagPositions` on
  the eight models that do this, and `clip_to_gltf`'s `absolute_bones` takes
  their joints in place of the asset-type rule; unset, as every other game
  leaves it, nothing changes. AW's type 6 (689 aim, lean and `*_additive` clips)
  is additive and is refused rather than baked
  ([reverse/s1-zone](../../reverse/s1-zone/README.md#the-animations)).
- A 2-component key is a rotation about the bone's local Z (the windmill head's
  ±3° yaw). A bone listed with no rotation track keeps its bind rotation.
- Tracks bind to joints by name; a bone the skeleton lacks is skipped and
  reported. On the root joint the clip's rotation and offset are composed with
  OAT's axis rotation (identity in CoD's frame is that rotation in the GLB's).

`animations.embed_clips` writes each clip a placement plays into its model's
packed GLB as a glTF animation named after the clip (keys at `frame / fps`,
LINEAR), and `props.world` gives the placement `animate: "<clip>"`.

Two clips decode cleanly and move coherently but hold a pose worth checking
against the game: mp_dome's fence tarps stream out flat from their pinned top
corners and flap up and down, and its windmills hold the tail boom at a
constant 90° to the side while the rotor turns at about 440°/s.

### Black Ops II xanims

T6's `XAnimParts` is T5's with one flag swapped (`bDelta3D` where T5 has
`bStreamable`) and IW5's delta part (a 2D `quat2` and a 3D `quat`), and its bone
tracks live in the same flat pools, read in the same order by bone-count class. So
the T6 backend writes clips with IW5's writer (`iw5/dumpers/xanim.py`), in IW5's
file versions (17, or 18 for a 3D delta), and `xanim.decode` reads them as any
other. What makes that more than "it did not throw"
([reverse/t6-xanim](../../reverse/t6-xanim/README.md), `verify.py` re-checks each):

- Every one of the 501 clips in `so_zclassic_zm_transit.ff` uses up every pool
  exactly, which a misread count or class order does not.
- 69 of the 81 clips BO1 also ships decode to BO1's keys exactly; the other twelve
  were re-authored (other bones or frames, or the rises re-keyed).
- A walk or run cycle posed on a BO2 body keeps its planted foot within 0.02–0.21
  m/s against a body moving 0.6–2.6 m/s, and the lowest foot within 0.4 in of the
  floor; read with inverted rotations the foot slides 0.9–3.9 m/s, and read with
  absolute translations it sinks 37 in.
- A jump clip's root path falls or rises the inches in its name, within 3
  (`jump_down_190` falls 189.9), except `jump_up_222`, which rises 186: the
  traverse script lifts the body the rest (`handletraversealignment`, `[gsc]`).

Every AI clip measured is asset type 2 (translations are offsets) at 30 fps. Asset
type 7 (five clips in the zone) and type 1 (five) are not used by an actor.

## Flag wind

Materials drawn with a `flag` technique set (`mc_l_flag_*`, `mc_l_sm_flag_*`)
ripple along their normals. This is the only vertex deformation on an IW5
prop; ordinary swaying foliage is a skeletal clip. The vertex shader
(`vs_lp_flag_*`) is in `common_mp.ff`, and its constant table names only
`gameTime`, the material's `flagParms` and the vertex data. Disassembled:

```
t      = (gameTime + flagParms.y) * flagParms.x;    // x is a speed multiplier
p      = 1 - uv;                                    // the first texture coordinate
offset = vertexAlpha * (1.7 sin(19.5777 p.x + 5.24583 p.y  + 7.53982 t)
                      + 7.5 sin(3.62305 p.x + 0.253348 p.y + 5.65487 t)
                      + 3.0 sin(8.25031 p.x - 1.45475 p.y  + 9.42478 t));  // inches
position += normal * offset / modelScale;           // constant world amplitude
```

It also tilts the normal along the tangent frame by the matching cosine terms
(× 0.025), for lighting only; the port leaves that out. The phase comes from
UVs alone, so every copy of a model moves in sync, as in the game. mp_dome's
grass tufts and spiky shrubs have alpha 0 at the base and 0.11 at the tips
(3.5 cm of travel); the radome cloth and the Domination flags reach 1.0 (31 cm).

IW6 keeps this contract for its `flag` sets. Its `flagext_wv…` sets make the
waves material constants instead, and are not drawn with this shader
([games.md](games.md#ghosts-iw6)); `materials.FLAG_TECHSETS_BY_GAME` says which
sets each game draws with it.

`materials.flag_parms` carries `flagParms` into the material's `extras.flag`
(`speed`, `offset`), `pack.keep_flag_weights` copies the vertex alpha to a
`_FLAG_WEIGHT` attribute before the alpha is neutralised, and
`packages/client/src/scene/flag.ts` is the shader.

## Viewmodels

The first-person hands and weapon. Exported by `scripts/cod/viewmodel.py`; drawn
by `packages/client/src/engine/viewmodel.ts` ([rendering.md](../engine/rendering.md#the-viewmodel)).

**Where they are.** A weapon is a `weapon` asset in `common_mp.ff` (156 on MW3).
It is dumped as a `WEAPONFILE\key\value\...` infostring naming everything else:
the gun (`gunModel`, then its camos `gunModel2`...), one clip per role
(`idleAnim`, `fireAnim`, `reloadAnim`, `reloadEmptyAnim`, `raiseAnim`,
`firstRaiseAnim`, `dropAnim`, `sprintInAnim`/`LoopAnim`/`OutAnim`, `adsUpAnim`...),
how long each state lasts (`fireTime`, `reloadTime`, `reloadAddTime`,
`raiseTime`, `sprintInTime`, `adsTransInTime`...), `clipSize`, `fireType`,
`hideTags`, and the parameters of the motion the game computes (below). Its
`handModel`, `viewmodel_base_viewhands`, is a placeholder: players wear their
team's hands, which each map zone ships (mp_dome: `viewhands_delta`,
`_op_force`, `_russian_a`, `_iw5_ghillie_desert`; mp_rust: `viewhands_tf141`,
`_usmc`, `_militia`). The script that picks a team's pair uses canonical
strings, so the exporter picks by name (`viewmodel.default_hands`).

Ghosts puts both halves somewhere else. Its weapons are in `common_core_mp.ff`
([above](#ghosts-keeps-its-weapons-in-a-zone-of-their-own)) and so are all seven
of its hands — five `viewhands_us_rangers_*` camo variants, `_juggernaut_ally`
and `_gs_hostage` — so a Ghosts map's view hands come out of a companion zone
rather than its own. A camo variant is which uniform the player is wearing, not
which team they are on, so it is `_overrides.json` that decides:
`worlds/prisonbreak-ghosts` wears `viewhands_us_rangers_woodland` because the
map is a jungle prison, where the default would have taken `_arctic`.

**How they fit.** The hands' skeleton is `tag_origin` → `tag_view` (the eye,
60 in up) → `tag_ads` → `tag_torso` → the arms, with `tag_torso` → `tag_weapon`
and `tag_view` → `tag_cambone` → `tag_camera`. The gun is rigid parts, each
surface on one joint (`j_gun`, `tag_clip` the magazine, `j_reload`,
`tag_sight_on`/`_off`, `tag_foregrip`, the attachment tags), rooted at `j_gun`,
which hangs from `tag_weapon` with no offset. One clip drives both skeletons
(the M4's clips name 140 bones). Established by rendering the graft: the M4's right
hand closes on the pistol grip, the left fist on `tag_foregrip`, and `ads_up`
puts the front post in the rear aperture at the centre of the screen.

**Clips** are xanims with one difference. **On asset type 1, which is every view
clip (all 2,173 in MW3's `common_mp`, all 1,700 in MW2's), a translation key is
the bone's local translation, not an offset.** The idle's finger, wrist and
elbow keys equal the bind translations exactly (`j_elbow_le` 12.09 in against
a bind of 12.09); added to the bind, every forearm doubles and the hands float
off the gun. Rotations still replace the bind rotation, and a bone listed with
no data keeps its bind pose: every clip lists `tag_flash` empty, and zeroed,
the muzzle would sit at the gun's root. Also:

- No MW2 or MW3 view clip keys `tag_origin`, `tag_view`, `j_gun` or
  `tag_cambone`, and none has root motion. Four Ghosts weapons do key the gun's
  root, which swings the gun under the hands; the export refuses only a clip
  that moves `tag_origin` or `tag_view`, which would carry the camera with it.
- 1,934 play once and 239 loop. 141 are a single frame, every idle among them:
  the idle is a still pose.
- ADS clips key `tag_ads` alone (436 clips), which no other clip keys, so they
  layer over anything. `ads_up` (0.4 s) is longer than `adsTransInTime`
  (0.3 s); the engine scrubs it by how far into the sights the player is.
- Clip lengths are not state times: the M4's pullout is 1.1 s in a 0.75 s
  `raiseTime`, its putaway 0.67 s in a 0.45 s `dropTime`, its reload 2.033 s in
  a 2.029 s `reloadTime`. The engine times states by the weapon file and plays
  each clip at the rate that fits.
- **A shotgun's `reloadTime` is one shell, not the reload.** `segmentedReload`
  is the flag; `reloadStartAnim` and `reloadEndAnim` are the two ends and
  `reloadAnim` is the loop between them, `reloadAmmoAdd` rounds at a time (1 on
  all eight that set it, in both games). A SPAS-12 read without this fills all
  eight in the 0.666 s the game spends on one, against 7.3 s for the real thing.
- **`adsTransOutTime` is not what the sights take to drop for a reload** —
  `adsReloadTransTime` is, and it is not a fraction of the other: of the 96
  catalogued weapons not one has it at half `adsTransOutTime`, and it is often
  longer (an ACR's 0.5 s against 0.2 s).
- **A bolt-action weapon's rate of fire is `fireTime` plus `rechamberTime`,
  not `fireTime`.** `boltAction` is the flag; `rechamberAnim`/`adsRechamberAnim`
  are the clips, and the engine gives them a state of their own
  ([rendering.md](../engine/rendering.md#the-viewmodel)). Nine catalogued weapons
  set it, and for each the sum is the game's published rate: the MSR's 0.05 +
  0.865 s is 66 rounds a minute, the L96's 0.266 + 0.93 s is 50. The flag is what
  says so, not the clip — MW3's `defaultweapon` and `xm25_mp` name a
  `rechamberAnim` and are semi-automatic. `rechamberBoltTime` is not exported;
  nothing uses it.
- 470 clips rotate `tag_camera` (the M4's reload rolls it about 7°). The game
  presumably turns the view with it; the engine does not yet.
- Weapon files spell clip names in mixed case (`viewmodel_M4_idle`); the assets
  are lowercase.

**Notetracks** are cues at a frame. On the view clips: sound aliases (1,205, e.g.
`weap_m4carbine_clipout_plr`), rumble (`viewmodel_small`/`medium`/`large`),
`interruptible` (75; on the M4's fire clip at frame 6, which is its
`fireInterruptableTime` of 0.2 s), and `reload_vm`/`vm_reload` (57; on the M4's
reload at frame 40, which is its `reloadAddTime` of 1.333 s: the magazine is
full from there). `notetrackSoundMap` maps a cue to a sound alias.

**The magazine is the one bone that ignores its clip's asset type.** A view clip's
translations are absolute — 47 of the 48 position tracks in an M4 reload start
within half an inch of their bind pose — but `tag_clip` is keyed at exactly the
origin on the first and last frame of every reload clip in both games, while its
bind is four inches away in the magwell. A reload begins and ends at idle, which
does not key the magazine at all, so read as absolute those keys drop the
magazine a hand's width out of the gun for the length of the reload and float it
back afterwards. `animations.OFFSET_BONES` is that one exception, and
`packages/client/tests/weaponClips.test.ts` measures it against the built
catalogue.

**Scope overlays.** A sniper scope is not geometry the player looks through: at
full aim the game **hides the viewmodel outright** and multiplies a picture over
the whole frame. `adsOverlayShader` names the material, whose colour map is that
picture — a white circle on black, with the reticle drawn into it. The blend is
the material's own (`srcBlend zero, dstBlend srccolor`), which is what turns the
black into a tube rather than a border. Without it a 15° field of view is a
screenful of receiver, which is why five of Modern Warfare 3's weapons and four
of Modern Warfare 2's are unusable until it is drawn.

Four pictures cover both games (`scope_overlay_us_iw5`, `_russian_iw5`,
`_m40a3`, `_m14_night`), so they are catalogued in their own right, under
`catalog/overlays/<game>/<material>/`, rather than copied beside each gun.
**A fitted optic owns it**, the way it owns the aiming clips: an ACOG on a
sniper rifle takes the overlay away (its `adsOverlay` names no shader), a
thermal replaces it. Modern Warfare 2 ships the proof — `barrett_acog_mp` has
none and `barrett_thermal_mp` has the thermal one — and `check_variants` holds
the composition to it.

`adsOverlayWidth`/`Height` are 480 x 480 in a 640 x 480 virtual screen for every
overlay in both games, which is a square of the screen's height on any aspect, so
the engine draws that and does not carry the numbers. `thermalScope` is not
reproduced: MW2's thermal reads as a plain scope with a red reticle rather than
as heat vision.

**What the game computes rather than animates.** No weapon has a walk clip.
Walk bob, idle sway (`hipIdleAmount`, `hipIdleSpeed`), the lag behind a turning
view (`swayMaxAngle`, `swayLerpSpeed`, `sway*Scale`) and both recoils
([below](#the-two-recoils)) are code, and only their parameters are data;
`packages/client/src/engine/weaponMotion.ts` approximates the drawing half and
`@3d/shared/sim/recoil.ts` simulates the half that decides where a round goes.

**Hidden parts.** The game skips a whole surface when a joint it touches is
hidden, and OAT keeps one primitive per surface, so hiding by joint is the same
rule. The folded backup sight `tag_sight_off` sits over the raised one: MW2's
`hideTags` lists it, MW3's lists nothing, and drawn, the two clutter the sight
picture, so the export always hides it (an optic's
`hideIronSightsWithThisAttachment` would swap them). The MW3 M4's vertical
foregrip belongs to the base gun.

**Field of view.** `cg_fov` 65 is horizontal at 4:3 (51.08° vertical), the view
the guns are posed for; `adsZoomFov` (50 on the M4) is in the same unit.

**Materials** are lit, sun-shadowed `mc_l_sm_*` with colour, normal and specular
maps. Only colour is exported, at up to 1024 px.

## Weapons: what a player may carry

A zone holds far more weapon files than guns — MW3's `common_mp` has 164, and
about a third are guns. The rest are grenades, killstreaks, turrets, markers and
five debug cameras, and most of them answer the obvious questions the same way a
rifle does. Three fields do the work, and one question has no answer at all.

| Field           | What it says                                                         |
| --------------- | -------------------------------------------------------------------- |
| `inventoryType` | `primary` (a carried weapon), `offhand`, `item`, `exclusive`, ...    |
| `weaponClass`   | `rifle`, `smg`, `sniper`, `pistol`, `spread`, `mg`, `rocketlauncher` |
| `weaponType`    | `bullet`, `grenade`, `projectile`, `riotshield`                      |

**There is no primary/secondary flag.** `inventoryType: primary` is what a
pistol, a launcher, a shotgun and an assault rifle all say — it separates a
weapon from a grenade, not a loadout's first slot from its second. The
primary/secondary split lives in the game's menu and script files, which this
pipeline does not dump, so `catalog.weapon_slot` derives it from `weaponClass`:
rifle/smg/spread/mg/sniper are primaries, pistol/rocketlauncher secondaries.
That is a reading, not a fact from the data, and it is the one place in the
catalogue builder that is.

On MW3's `common_mp`, 87 files are `inventoryType: primary` and **53** survive
the rest of the filters:

- **`gunModel` must be a `viewmodel_*`.** The five `camera_<n>fov` entries are
  debug cameras pointing at `weapon_ac130`, and answer every other test as SMGs.
- **A weapon with no `displayName` is not player-facing.** That is what catches
  `uav_strike_projectile_mp`, a launcher by every other field.
- **A killstreak's kill icon** marks its own copies of ordinary weapons, which
  differ in no other field: MW3 gives the Juggernaut's four `death_juggernaut`,
  Ghosts names every streak's icon `icon_ks_<streak>_hud`, and
  `catalog.KILLSTREAK_KILL_ICONS` is both spellings as prefixes.
- **Weapons no field separates at all** (`uav_strike_marker_mp`,
  `uav_strike_missile_mp`, `iw6_magnumhorde_mp`) are named in
  `catalog.NOT_SELECTABLE`. A list rather than a pattern, because it is a
  judgement and should look like one.

The riot shields export with a warning — their `ads_up`/`ads_down` clips drive no
joint of the rig, which is correct: a shield has no sights.

### What a shot does

`viewmodel.DAMAGE`, `SPREAD` and `LOCATIONS` are the numbers a server judges a
shot by, copied into `WeaponDef` at format 4. All three are rename maps: the
engine's name for a figure is not the game's. Every one of MW2's 1209 weapon
files and MW3's 156 carries every key, which
`tests/test_viewmodel.py` asserts against a kept companion-zone dump — a
misspelt key resolves to nothing, and a gun that does no damage looks exactly
like a gun the game gives no damage.

| Engine                            | Weapon file                         | Trap                                                                              |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| `damage.max`                      | `damage`                            | There is no `maxDamage` key; `damage` **is** the maximum                          |
| `damage.min`                      | `minDamage`                         |                                                                                   |
| `damage.maxRange` / `minRange`    | `maxDamageRange` / `minDamageRange` | CoD units, not metres: an M4's 800 is 20 m                                        |
| `damage.melee`                    | `meleeDamage`                       | 135 on all but a handful                                                          |
| `spread.hipStandMax`              | `hipSpreadMax`                      | The one hip key with no stance in its name                                        |
| `spread.hipStandMin` and the rest | `hipSpread*`                        | Degrees                                                                           |
| `spread.ads`                      | `adsSpread`                         | 0 on everything but a shotgun and a few pistols                                   |
| `locationDamage.<location>`       | `loc<Location>`                     | IW6 indexes its own 22-location order ([below](#iw6s-hit-locations-are-not-iw5s)) |

`playerDamage` and `minPlayerDamage` are **not** taken: they are what an AI's
copy of the weapon does to the player. `damage` is the player-versus-player
number, and MW2's M4 says 30 falling to 20, which is that game's published
figure.

**A min and a max are a range, not an order.** `hipGunKickPitchMin` is 5 on the
M4 and `hipGunKickPitchMax` is -15; the L96's `adsViewKickYawMin` is 70 and its
`Max` is -75, which spans zero as well as running high to low. The same holds of
every `*Min`/`*Max` pair the exporter copies; they are carried exactly as the
game spells them, and code that assumes `min <= max` kicks the gun the wrong way.

### The two recoils

`*GunKick*` and `*ViewKick*` are different quantities and are not
interchangeable. All fourteen keys are in `viewmodel.MOTION`, verbatim rather
than renamed, because the engine reads them back by spelling the key.

| Family       | What it moves                        | Shape                                                            |
| ------------ | ------------------------------------ | ---------------------------------------------------------------- |
| `*GunKick*`  | The weapon **model** in the hands    | An impulse into a speed, with `Accel`, `SpeedMax` and two decays |
| `*ViewKick*` | The player's **aim**, and the bullet | An impulse into an angle, walked back at `*ViewKickCenterSpeed*` |

**A scoped sniper's gun kick is identically zero.** Every one of them in Modern
Warfare 3 — the L96, the MSR, the AS50, the Barrett — has
`adsGunKickPitchMin`/`Max` of 0 and carries all of its recoil in
`adsViewKickPitch` (30 to 85 on the L96, recentring at 500). So a pipeline that
exports the gun kick and not the view kick produces a rifle with no recoil at all,
and nothing downstream can tell that apart from a rifle the game gave none.

**Their pitch signs are not the same, and only one of them has a sign to read.**
`hipViewKickPitchMax` and `adsViewKickPitchMax` are `>= 0` in **every one of the
1503 weapon files** of Modern Warfare 2 (1209), 3 (164) and Ghosts (130); the
matching `*GunKickPitchMax*` is negative in 613 of them. A gun kicks up, so
positive view-kick pitch is upward. The gun kick has no single convention — the
M4 runs 5 to -15 and the L96 80 to 85 — which is consistent with its being the
model's own rocking rather than a claim about where the barrel points.
`test_the_pitch_of_a_view_kick_is_upward_where_the_gun_kick_has_no_one_sign`
holds both halves against the games themselves.

**The units are not degrees and this pipeline does not know what they are.** A
rifle does not kick 85° up. `@3d/shared/sim/recoil.ts` reads them at an estimated
scale it names and documents; the exporter carries the numbers as spelled.

**`ViewKickCenterSpeed` alone cannot describe both a rifle and a bolt-action.** An
L96 has 14 times as long between rounds as an M4 and only 2.7 times the recentre
rate, so no function of the two can leave one climbing and bring the other home.
That is a fact about the data, and it is why the engine's recoil model carries one
term the weapon files do not
([player.md](../engine/player.md#recovery-is-what-you-see-after-you-stop-firing)).

**`*GunKickReducedKickBullets*`/`Percent`** say that the first N rounds of a burst
kick at a reduced percentage. They are exported and not simulated: they scale the
gun kick, which decides nothing, and on 44 of the 49 Modern Warfare 3 files whose
percentage is non-zero the bullet count is 0, so the game itself applies nothing.
Ghosts spells a percentage of 145 on one weapon, which is not a reduction at all.

**Five of Modern Warfare 2's 806 two-attachment weapon files do not compose.**
`aug_acog_grip_mp` and four others differ from ACOG-then-grip in
`ViewKickCenterSpeed` alone: the ACOG takes 400 off the base and the grip puts
400 on, and the file the game ships is the base value again — the game composed
those as deltas where the catalogue holds an absolute per attachment. They are
named one by one in `tests/test_attachments.py`, because a sixth would be a rule
rather than an accident.

### Ghosts keeps its weapons in a zone of their own

Every table above holds for IW6, and the same three fields do the work — but
three things about where the data is and how it reads are its own.

**They are in `common_core_mp.ff`, not `common_mp.ff`.** That zone holds **129**
weapon files, 669 models and 2,460 clips; `common_mp.ff` holds exactly one
weapon (`defaultweapon_mp`) and is not the zone. It is not a companion of a map
either — nothing references it — so `games.json` names it for Ghosts explicitly,
and every Ghosts export pays about 90 s and 2 GB of scratch for walking it.

Of the 130 files, 57 are `inventoryType: primary` and **39** survive
`catalog.is_player_weapon`, which is Ghosts' roster. The seven it drops are
copies of weapons already in it, made for a killstreak or for a co-op mode: six
carry that streak's `icon_ks_<streak>_hud` (the Juggernaut's four, the Maniac's
knife and `iw6_gm6helisnipe_mp`), and the seventh, Safeguard's
`iw6_magnumhorde_mp`, wears the ordinary Magnum's icon over 1000 damage and is
named in `catalog.NOT_SELECTABLE`.

Two the roster keeps are worth knowing about: `iw6_minigun_mp`, which is the
Juggernaut's minigun under an ordinary icon and name, and `iw6_knifeonly_mp`,
whose clips are the Maniac's. Both answer every test a carried weapon does, and
an extra weapon offered is not the kind of mistake that renders.

**A clip role is a slot in an enum that grew.** `weapAnimFiles_t` has 124
members against IW5's 42, and the numbers moved — RELOAD is 16 where IW5's is 9
— so a role is read through IW6's own enum
(`iw6/dumpers/weapon.ANIMS`, [pitfalls.md](pitfalls.md#viewmodels)). The 82
slots IW5 has no key for are the mantles (seven heights, up and over), the
slides, the fast and multiple reloads, the recoil settle, the swim loop and a 30
-clip additive set (walk, crawl, jump, drag) that layers over whatever is
playing. Nothing is dumped under a name for them, because inventing key
spellings is what a per-game key table is.

**A shell-at-a-time reload is two flags, not one.** IW6 declares both
`bSegmentedReload` — IW5's, with `reloadStartAnim`/`reloadEndAnim`, set on the
UTS-15 — and `bMultipleReload`, which loads through eight `RELOAD_MULTIPLE_n`
clip slots instead and is set on the FP6, with five of the eight filled,
`reloadAmmoAdd` 1 and a `reloadTime` of 0.833 s for one shell. Only the first
has an OpenAssetTools key. Since nothing downstream plays more than one reload
clip and `viewmodel.rounds_per_load` reads only the flag and `reloadAmmoAdd`,
the dumper writes either as `segmentedReload`; left out, the FP6 would put five
shells in with one pump. The eight clip slots are not dumped.

**Every weapon's `hideTags` is empty**, where MW2 lists the folded backup sight
and MW3 relies on an attachment to hide the raised one. `hidden_bones` still
adds `tag_sight_off` where the gun has one, and an optic's
`hideIronSightsWithThisAttachment` still hides `tag_sight_on`, so the sight
picture comes out right; nothing else in a Ghosts weapon is hidden by name.

**One kind of field is not recoverable through the emulated loader**, and is
left out rather than written empty: **every sound alias.** `Load_WeaponDef`
resolves each by name through `DB_FindXAssetHeader`, which the emulator stubs,
so 54 keys and `soundOverrides` would all read as silence. The cues in
`notetrackSoundMap` are script strings and survive: 87 of the 130 files carry
one.

**`loc*`, damage by hit location, is written by name.**
`locationDamageMultipliers` is a `float*` of 22 the zone writes positionally,
and the order is [below](#iw6s-hit-locations-are-not-iw5s) — not IW5's — so
`iw6/dumpers/weapon.HIT_LOCATIONS` says which location stands at each index and
the multiplier is written under that location's OAT key. The three IW6 has and
the engine does not (`shield`, `armor`, `soft`) are dropped: `HIT_LOCATIONS` in
`@3d/shared/sim/hitLocations.ts` is nineteen and is a wire format. An
attachment's `locationDamage` block names each location itself and is written as
it stands.

#### IW6's hit locations are not IW5's

IW5 and IW4 spell nineteen `loc*` keys per weapon, all the right-hand locations
then all the left. IW6 keeps twenty-two, and interleaves them:

```
none helmet head neck torso_upper torso_lower
right_arm_upper left_arm_upper right_arm_lower left_arm_lower
right_hand left_hand
right_leg_upper left_leg_upper right_leg_lower left_leg_lower
right_foot left_foot gun shield armor soft
```

Read straight off the Durango build: two 22-entry arrays of pointers to its own
`hitLocation_t` strings, at file offsets `0x5d7050` and `0x5e10e0`, whose targets
are the block at `0x4c1984`. That is also H1's `hitLocation_t` exactly, and
twenty of the twenty-two are `AttLocationDamage`'s nineteen in a different order
— so an IW6 weapon array copied under IW5's names swaps every arm and leg for
the other side, which is the plausible wrong answer this pipeline is prone to.

The **attachment** block is the other order: `AttLocationDamage` in the Durango
PDB names its nineteen floats exactly as IW5 does, grouped rather than
interleaved. So the two blocks in one game do not line up by index, and an
attachment's multipliers map to a weapon's array by _name_.

The zones agree with the order twice over. The L115 boosts indices 3, 4, 5 and
12, 13 to 1.1 — neck, both halves of the torso and **both** thighs, which is a
sniper meant to kill in one shot to the upper body; read as IW5 spells it those
last two are the right leg's thigh and shin, and the left leg is left alone.
`defaultweapon_mp` falls away down a limb (0.8 upper, 0.6 lower, 0.1 hand, each
twice over), where the grouped order gives a hand the forearm's number. Nothing
else would show it: not one of Ghosts' 130 tables tells its left side from its
right, so a weapon whose multipliers are one number for a whole limb — which is
most of the roster — reads the same either way.

**74 of the 130 tables are all zero**, and every one of them is a grenade or a
projectile, whose damage is explosive rather than located — the same shape as
MW3's 94 zero tables and MW2's 66, so nothing here is new. The rest are MW3's:
1 everywhere, `gun` at 0, and a head multiplier, which in Ghosts runs from 1.0
on a shotgun through 1.05 on the 48-damage rifles to 1.56 on the marksman
rifles.

### MW2 ships a weapon file per attachment combination

The two games do this completely differently, and it is the single biggest
difference between their weapon data.

|             | weapon files | player weapons | base weapons |
| ----------- | ------------ | -------------- | ------------ |
| MW3 (`iw5`) | 164          | 87             | 53           |
| MW2 (`iw4`) | **1209**     | **1121**       | **43**       |

MW2 has `aa12_mp`, `aa12_eotech_mp`, `aa12_grip_mp`, `aa12_eotech_grip_mp`,
`aa12_fmj_silencer_mp` and so on — **one complete weapon file per combination**,
each with its own clip names, its own recoil and its own `hideTags`. MW3 ships
base weapons only.

`catalog.base_weapons` keeps the ones no shorter weapon's name prefixes:
`aa12_eotech_mp` splits to `[aa12, eotech]` and `aa12_mp` exists, so it is a
variant. It is a reading of the names, but the names are the game's own, and the
answer it gives is exactly MW2's roster. Catalogued whole the combinations would
be 1121 entries for 43 weapons — and the wire carries a weapon as one byte
(`uint(8)`), so they would not fit.

The 1078 variants are not waste: they are where MW2's attachments come from.

## Attachments

`scripts/cod/attachments.py`. **Both games collapse to one shape**, against a
named weapon and in that weapon's own absolute numbers, so nothing at run time
learns they ever disagreed — `AttachmentEntry` in
`@3d/shared/sim/weaponRegistry.ts`, and `resolveWeapon` is a spread.

|                | what the game gives                                       | how it is read                                    |
| -------------- | --------------------------------------------------------- | ------------------------------------------------- |
| MW3 (`iw5`)    | 40 `attachment` assets + a per-weapon list of accepted    | dump `--include-assets attachment`, apply scales  |
| MW2 (`iw4`)    | no attachment assets at all; 1078 baked combinations      | diff each single-attachment file against its base |
| Ghosts (`iw6`) | 66 `WeaponAttachment` assets, in the same blocks as IW5's | dump them, then as IW5                            |

An entry is `{id, type, display, tag, model, hideBones, showBones, overrides}`.
`overrides` merges `roles`, `times` and `motion` key by key and replaces
everything else; `hideBones`/`showBones` are the only say it has over what is
drawn. Nothing here is a scale or a fraction: the collapse happens in the
exporter, once.

### MW3: 40 attachment assets

`common_mp.ff` carries an `attachment` asset type IW4 does not have, and each
weapon file lists what it accepts, newline-separated:

```
iw5_m4_mp: attachments = "acog\neotech\nreflex\nthermal\nshotgun\ngl\nhybrid\nsilencer\nheartbeat\nxmags"
```

Across the 53 MW3 weapons, 37 distinct attachments are referenced and all 37 are
in the dump. **The longest list is 11** — the distribution is
`{0: 10, 4: 6, 5: 10, 7: 6, 8: 6, 9: 5, 10: 7, 11: 3}` — which is why the wire
names a fitted attachment by a four-bit slot index rather than by a bit in a
mask.

Three things about the asset are traps:

- **An unused scale is written as 0, not 1.** `adsSettingsScale`,
  `gunKickScale`, `hipSpreadScale` and `idleSettingsScale` are 0 on all 40, and
  `ammunitionScale` is 0 on the 35 that do not touch the magazine. Read as
  multipliers they take a weapon's numbers to nothing. `attachments.scale` is
  the one place that is decided.
- **An attachment with its own `ammunition` block is a second weapon, not a
  change to this one.** `shotgun`, `gl`, `gp25` and `m320` carry a clip size, an
  ADS zoom, a recoil curve and a fire type belonging to the underbarrel weapon.
  Folded onto the host they make a plausible four-round M4. Nothing but the
  model and the hide rule is taken from those four.
- **The real numbers are in absolute blocks, not the scales.** An ACOG's
  `adsSettings.adsZoomFov` is 30 outright, against the M4's 50. What the scales
  actually carry in the shipped data is `ammunitionScale` 1.5 (extended mags)
  and `fireTimersScale` 0.8 (`rof`); everything else is 0 or 1.

**Where a model mounts is in the data.** An attachment model's own root joint is
the gun tag it belongs on — `viewmodel_acog`'s root is `tag_acog_2`, which is a
joint of every rifle that accepts one — so `catalog._attachment_models` reads it
rather than keeping a table. One packed GLB per _model_, under
`catalog/attachments/<game>/<model>/`, because `acog` and `acogsmg` share
`viewmodel_acog` and twenty rifles share it again. An attachment whose tag this
gun does not carry loses its model rather than mounting it at the origin.

### Ghosts: 66 attachments, reached through the weapons

IW6 says it as IW5 does — one asset per attachment, its numbers in `Att*` blocks
that carry IW5's member names, so `attachments.iw5_entry` reads the dump without
knowing which game wrote it. Three things are its own:

- **They are not in the asset list in any usable way.** `common_core_mp.ff`
  lists 63 `ATTACHMENT` entries and every one is an _alias_: each attachment is
  loaded in full at the first weapon that accepts it, and the list entry then
  points at that copy. The walk therefore records none, and
  `iw6/dumpers/attachment.py` reaches all **66** through
  `WeaponCompleteDef.scopes` / `underBarrels` / `others`
  ([pitfalls.md](pitfalls.md#extraction)).
- **The three arrays are the type.** IW5 keeps a `type` field and so does IW6,
  but the array a weapon lists an attachment in says the same thing — 6 scope
  slots, 3 under-barrel, 8 other — and that is also what an override row's
  bitfield indexes (`scope:3, underBarrel:2, other:8`).
- **`AttADSOverlay` nests where IW5's is flat.** IW6 moved the four shaders, the
  reticle and the sizes into an `ADSOverlay` inside the block; the dump flattens
  it back, because `attachments.py` reads `adsOverlay.shader`.

The AK-12 accepts sixteen: `acog eotech hybrid reflex thermal tracker` (scopes),
`gl grip shotgun` (under barrels) and `barrelrange firetypeburstlight
firetypesinglelight flashsuppress silencer xmags fmj` (others). **Sixteen is the
longest list, and twelve of the 39 weapons are that long** against MW3's longest
of 11. The wire names a fitted attachment by a four-bit slot index and
`MAX_ATTACHMENT_SLOTS` is 16, so Ghosts fits exactly and nothing may be added to
one of those twelve lists. A build past it is refused by `catalog._fitted`
rather than written for a client that could not load it.

**The fire selector is an attachment, and it is the only thing that says so.**
Six of the 66 (`firetypeauto`, `firetypeburst`, `firetypeburstdmr`,
`firetypeburstlight`, `firetypesingle`, `firetypesinglelight`) carry an
`ammoGeneral` block whose `fireType` replaces the weapon's — a Full Auto rifle
becomes Single Shot with one fitted — alongside a `fireTimersScale` that slows
the trigger. MW3 has no such attachment: its only four `ammoGeneral` blocks
belong to underbarrel weapons, which `iw5_entry` leaves alone entirely, so
reading the block costs MW3 nothing and its catalogue is byte-identical with and
without. The two slug rounds carry one too, saying `Single Shot` on shotguns
that already fire one shot a press.

### MW2: 1078 baked combinations

IW4 has no `attachment` asset type and its weapon files have no `attachments`
key. An attachment's effect is the **difference** between `aa12_eotech_mp` and
`aa12_mp`, and `attachments.iw4_entry` is that diff, over exactly the fields
`WeaponDef` keeps. Two of them do not diff the obvious way:

- **`hideTags` is a set, not a string.** MW2's gun model carries every
  attachment's mesh and the bare weapon hides them all; fitting one _reveals_
  its own. So an entry has `showBones` as well as `hideBones`, and two
  attachments each drop their own tag. Composed as text, the second would put
  the first's back.
- **`displayName` is not diffed at all.** A two-attachment file calls itself
  `WEAPON_AA12_BLING`, which is a name for the combination and for neither
  attachment.

**The combinations are the proof, and they are checked.** 272 of the 1078
variants carry one attachment and 806 carry two; composing the two matching
single-attachment deltas reproduces **801** of the game's own 806 files; the five
that do not are [a recoil field the game composed as deltas](#the-two-recoils).
`attachments.check_variants` does that during every `--game iw4` build and prints
anything that does not, and `tests/test_attachments.py` runs it over the whole
zone. It works because the deltas are orthogonal: `gunModel` is identical across
every combination, the grip drives the handling clips
(`viewmodel_aa12_grip_idle`), and the sight drives the ADS clips
(`viewmodel_aa12_eotech_ADS_up`).

### Black Ops II weapons

The research and its evidence: [reverse/t6-weapons](../../reverse/t6-weapons/README.md).
The weapon file is OAT's infostring over T6's `WeaponFullDef`, so every key the engine
reads is spelled as on IW, bar two:

| Engine field            | T6 weapon file                             | Note                                                                                      |
| ----------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `adsZoomFov`            | `adsZoomFov1`                              | three zoom levels, the first the default (`t6_catalog.normalize`)                         |
| `damage.max`/`maxRange` | `damage`/`maxDamageRange` (`damage[0]`)    | CoD units, as every game's                                                                |
| `damage.min`/`minRange` | `minDamage`/`minDamageRange` (`damage[5]`) | the steps between (`damage2`-`damage5`, 0 when unused) are **not carried**: open          |
| `locationDamage`        | `loc*` by name                             | 21 locations; `torsoMid` (1.5 on the Ballista, where lower is 1) and `shield` are dropped |
| `sounds.notes`          | the clips' `sndnt#<alias>` notetracks      | `notetrackSoundMap` is empty on every gun                                                 |
| `fireInterruptible`     | none                                       | T6 has no `fireInterruptableTime`                                                         |
| `slot`                  | `mp/statstable.csv` column 13              | where `weaponClass` disagrees: the crossbow                                               |

Times are OAT's milliseconds printed as seconds and the recoil is IW's scale (the
AN-94's view kick is 30-47.5 pitch, -50-50 yaw, centred at 1500, beside BO1's M16 at
-30-50, 35/-35, 1200).

**An attachment is two assets.** Against one weapon (`attachments.t6_entry`):

- From the `attachment` (`extclip_lmg`), numbers: `clipSizeScale` x `clipSize`
  (rounded), `fireTimeScale` x `fire`, `reload*TimeScale` x the reload times,
  `adsTrans*TimeScale` x `adsIn`/`adsOut`, `damageRangeScale` x both ranges,
  `hipSpreadMin/MaxScale` x the hip minima and maxima, `adsViewKickCenterSpeedScale`,
  `adsIdleAmountScale`; and absolutes where set: `adsZoomFov1` (1 is unset), the sway
  and ADS-sway blocks behind their `*Override` flags, `hipIdleAmount` (0 is unset),
  `standMoveF`/`standRotP`/`standRotR` (-300 is unset on all 48). None of it is read
  from an attachment whose unique names an `altWeapon` (grenade launcher, select fire,
  dual optic): those numbers are a second gun's.
- From the unique (`au_<gun>_<attachment>`): each role whose clip differs from the
  gun's own `au_<gun>_none`, the two fire sounds (a silencer's), and the ADS overlay.
  Where it has no model, its hide tags too, as a difference from `au_<gun>_none`'s:
  the 870's dual tube and the crossbow's tri-bolt are the gun's own meshes. A
  second weapon's unique brings its clips alone. Its location multipliers are not the
  gun's (head x4 on 346 of 520) and are not read.
- **Not mounted: the model.** Rigid, at `viewModelTag` (empty on 490 of 520) plus
  `viewModelOffset*` in the gun's frame from `j_gun` (a silencer's height is its gun's
  `tag_flash` height), which the engine's `tag` cannot say. So a model-bearing
  attachment changes nothing drawn: a scope is fitted with its zoom, sway and aiming
  clips, over the gun's own iron sights.
- `dw` (dual wield) is not offered, and `fmj`, `stalker`, `sf` and `stackfire` change
  nothing the engine carries (a perk, ADS move speed, a fire-mode toggle, a tri-bolt).

### The composition rule

Two attachments can touch one field, and the catalogue's slot order settles it:
`resolveWeapon` walks the list front to back and the later one wins. The order
is by `type` — **`other`, then `scope`, then `underbarrel`** — with one
exception:

> **A fitted optic keeps the aiming clips** (`adsUp`, `adsDown`, `adsFire`,
> `adsLastShot`) whatever else is on the gun.

Neither half is a decision; both are what reproduces the 806. An MG4 with a grip
and a reflex plays the grip's reload and the reflex's ADS, and swapping the rule
round breaks fifteen of the combinations. IW4 ships nothing that says what kind
of thing an attachment is, so `attachments.IW4_TYPES` is a table of its fourteen
names — checked against IW5's own `type` for the thirteen both games ship.

**A weapon's GLB carries every clip its attachments name**, not just its own
roles: a fitted grip that names a reload the GLB does not hold plays nothing.
That is what roughly doubles MW2's catalogue, from 540 clips over 43 base
weapons to 1055 (worst: `ak47_mp`, 15 to 49), and MW2's share of it from about
130 MB to about 260 MB.

## Characters

The bodies other players are drawn as. Exported by `scripts/cod/characters.py`;
built by `packages/client/src/scene/character.ts` and posed by
`packages/client/src/engine/characterAnimator.ts`
([rendering.md](../engine/rendering.md#player-characters)).

**Where they are.** A multiplayer character is three xmodels, and the first two
are in the _map's own_ zone, not `common_mp` — mp_dome ships 12 `mp_body_*` and
11 `head_*`, one family per faction and one body per weapon class
(`mp_body_delta_elite_assault_aa`, `..._smg_b`, `..._lmg_a`;
`mp_body_russian_military_assault_a`). The game's script pairs a body with a
head, so the exporter pairs by name: the head sharing the most _words_ with the
body, prefixes off, ties broken by how many of those words come first. Which
side a body is on is likewise only in its name (`delta`/`ally` against
`russian`/`opforce`); `characters.SIDES` is that lookup. The third model is the
weapon's `worldModel` (`weapon_m4_iw5`), in `common_mp`, which is a different
asset from the viewmodel's `gunModel` (`viewmodel_m4_iw5`) and rigged
differently.

**Why words rather than a leading run**, which is what this paired on first and
what cost twelve MW2 worlds a side ([pitfalls.md](pitfalls.md#characters)). The
same family is written either way round (`mp_body_desert_tf141_assault_a` wears
`head_tf141_desert_a`), the allied one is spelled `ally` on a body and `allies`
on its head (`characters.SPELLINGS` is that one word), and the variant a body and
its head agree on can be last rather than first: the militia's `_blk` and `_wht`
bodies have `_blk` and `_wht` heads, and pairing on the leading run put a `_wht`
face on `_blk` arms. Two words in common, or the same first word, is what counts
as a head being a body's at all — one alone is a coincidence, which is how
Ghosts' `head_mp_head_a` stays nobody's own and reaches the rangers as a spare.

**The pairing is checkable against the game's own.** Dump a map's rawfiles and
read `zone_source/<map>.zone`: it lists each head under the body that wears it.
Over the 41 MW2 and MW3 maps that ship characters, the rule above agrees with
that listing for 75 of the 80 bodies an export picks. The five it does not are
not in the names — `mp_body_russian_military_assault_a_woodland` wears
`head_russian_military_b` and there is no `_woodland` head to say so — and it
picks the same head the leading-run rule did.

**How they fit.** The body carries the whole skeleton: 84 joints from
`tag_origin` at the feet up through `pelvis` → `torso_stabilizer` →
`j_spinelower` → `j_spineupper` → `j_spine4` → `j_neck` → `j_head`, with
`tag_weapon_right` and `j_gun` at the same place under `j_wrist_ri`. A head's
skeleton is the body's from `j_spine4` up plus its own (`j_jaw`, `j_eyeball_*`,
`j_helmet`, `j_nvg`, `tag_eye`) — 8 extra on a Delta head, 28 on a Russian one.
The world weapon is rigid parts on tag joints rooted at `tag_weapon`, whose own
transform is only OAT's axis change. So the export grafts the head's extra
joints under their named parents and the weapon's whole tree under `j_gun` at
rest, and the head and weapon are packed on their own and rebound to that one
skeleton by joint name at run time — the same shape as a viewmodel's gun and
hands, and for the same reason: several heads share one body.

**Where they are, on a Ghosts map.** One faction, five camos: mp_prisonbreak's
zone ships `mp_body_us_rangers_assault_a_{arctic,desert,elite,urban,woodland}`
plus an infected and a juggernaut, and the Federation's bodies are in the
per-loadout streaming zones (93 `mp_body_<character>_<class>_<variant>_tr.ff`)
an export does not walk. So `SIDES` matches nothing and each character is named
for its body. Ghosts also names no head after a body — the rangers wear any of
`head_mp_head_{a,ab,ac,ad}` — so `HEADS_ARE_A_BODYS_BY_GAME` is false for it and
each body takes the plainest head no _other_ body claims, which leaves
`head_juggernaut_light_black` to the juggernaut. Its bodies are MW3's shape
otherwise: 84 joints, `torso_stabilizer` and `j_gun` included, and its heads
carry a full face rig, so a graft adds 95 joints where MW3's adds 8 to 28.

**Clips** are the `pb_`/`pt_` xanims in `common_mp` (460 and 98 on MW3;
190 and 32 on Ghosts), one set for every character in the game rather than per
model:

- `pb_` is the whole body and `pt_` the spine up. The engine plays a `pb_` clip
  and layers a `pt_` one over it; here the `pt_` clip is made additive against
  its own first frame, since the stance it was authored over is not necessarily
  the one the legs are in.
- **The two disagree on translations.** `pb_` clips are asset type 2 (a
  translation key is an offset on the bind pose) and `pt_` clips type 1 (it is
  the local translation), the same split as animated props against view clips —
  `animations.TRANSLATION_BY_ASSET_TYPE` covers both.
- The set is named by weapon class, not by weapon. A weapon file's
  `playerAnimType` (`autorifle` on the M4) selects a variant of the same clip
  where one exists: `pb_sprint_assault` over `pb_sprint`,
  `pb_combatrun_forward_loop_assault` over `pb_combatrun_forward_loop`. Many
  clips have no variant (`pb_stand_alert`, the jumps), so the base name is both
  the rifle set and the fallback. A `CLIP_ROLES` entry is a pattern: `{}` is
  where `_<class>` goes, and a name without one takes it on the end — which is
  every MW name, and not Ghosts' `mp_stand{}_reload`.
- **Every game spells them its own way**, so the role table is per game
  (`CLIP_ROLES_BY_GAME`) and so is the class lookup
  (`ANIM_TYPE_SUFFIX_BY_GAME`). MW2 and MW3 share one set. Ghosts shares only
  `pb_stand_ads`, the two jumps, the two climbs and `pt_stand_shoot_auto`:

  | Role               | MW2 and MW3                    | Ghosts                                 |
  | ------------------ | ------------------------------ | -------------------------------------- |
  | idle               | `pb_stand_alert`               | `pb_hold_idle`                         |
  | runForward         | `pb_combatrun_forward_loop`    | `pb_hold_run`                          |
  | runBack/Left/Right | `pb_combatrun_<dir>_loop`      | `pb_hold_run_<dir>`                    |
  | sprint             | `pb_sprint`                    | `pb_sprint`, else `pb_sprint_hold`     |
  | fire               | `pt_stand_shoot_auto`          | `pt{}_stand_shoot_auto`                |
  | fireAds            | `pt_stand_shoot_auto_ads`      | `mp_core_stand_fire_ads`               |
  | reload             | `pt_reload_stand_rifle`        | `mp_stand{}_reload`                    |
  | mantle, mantleOver | `mp_mantle_up_39`, `_over_mid` | `mp_mantle_40_up`, `mp_mantle_40_over` |

  Two of those are judgements rather than lookups, and both were settled by
  reading what the clips key rather than what they are called:

  - **A Ghosts torso clip can be spelled `mp_`.** `mp_stand_reload` and
    `mp_core_stand_fire_ads` are asset type 1 and key the same 153 joints as
    `pt_stand_shoot_auto` — spine up, no legs — so they are `pt_` clips in
    everything but the prefix. Read only the `pt_` names and a Ghosts character
    has no standing reload and no ADS fire, which the zone appears to confirm.
  - **The four-way run comes from one family.** `pb_combatrun_*_<class>` is
    complete for `_smg`, `_lmg`, `_sniper` and `_shotgun` and has no `_assault`
    forward clip at all, while `pb_hold_run{,_back,_left,_right}` is complete
    and classless — and `_hold` is a class in Ghosts' own naming
    (`pb_sprint_hold` sits beside `pb_sprint_assault`). One stride clock drives
    all four directions, so they come from the `_hold` family whatever the
    weapon is, and the per-class runs go unused.

- There is **no walk set and no aim-up/down set** in any of them. Movement is
  the four directional run clips and the sprint, blended by the direction of
  travel and scrubbed by speed; aim pitch is the engine turning
  `torso_stabilizer`, which is exactly the joint that name is for. (Ghosts does
  ship an aim grid, `mp_hold_stand_aim_1`..`_9`, which nothing here reads.)
- `pb_stand_alert` is 529 frames (17.6 s) of fidgets and `pb_hold_idle` 126
  (4.2 s); the runs are 43 to 56 frames on MW3 and 33 to 54 on Ghosts. The four
  are different lengths, so one stride clock drives all of them or a strafe's
  feet slide against a run's.
- The run and sprint clips carry root motion, which is skipped: position comes
  from the network, and applying it too would walk a body away from its player.
- **The ladder clips are `pb_climbup` and `pb_climbdown`**, whole-body loops
  (16 frames, 0.533 s; 22 frames, 0.733 s) and the only climb clips in
  `common_mp`. Their root motion is skipped as well, and is a rise of +37.1 in
  and −39.9 in per cycle, near enough linear in time (2.3 in a frame going up),
  so the engine can scrub them by height. `j_mainroot` keeps its in-place bob.
  The `ladder_climb*` clips (on, off, up, down) are in `common.ff`, not
  `common_mp`, and are not exported.

**The clip file.** The clips are written once into
`assets/characters/animations.glb`, a skeleton with no meshes — the union of
every exported body's joints — carrying the role table in its scene extras.
A glTF animation binds by node name, so one file plays on any body whose joints
have those names, which is what keeps the whole set at ~800 KB instead of a copy
per character. A rig drops the tracks its own skeleton has no joint for
(a body with no coat has no coat bones) rather than letting three warn per track.

**Materials** are the same lit `mc_l_sm_*` as everything else, colour only, at
the props' 512 px rather than the viewmodel's 1024: a body is seen across a map,
not at arm's length.

## AI bodies (Black Ops zombies)

The creatures a zombies map spawns. Exported by `scripts/cod/actors.py`
([pipeline.md](pipeline.md#actors)); where each fact was found is
[reverse/t5-zombies](../../reverse/t5-zombies/README.md#1-clips-and-models).

**Dressing is three rawfiles deep**, all in the map zone for the walker:

| Step                                              | Theater's walker                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Spawner classname → `aitype/<name>.gsc`           | `actor_zombie_ger_zombie` → `zombie_ger_zombie.gsc`: health 150, `QUAKED` box `(-16 -16 0) (16 16 72)` |
| aitype `main()` → `character\<name>::main()`      | `c_ger_honorguard_zt` (a `switch` over several, as the dog's aitype has, weights each by its cases)    |
| `setModelFromArray(xmodelalias\<list>::main())`   | `c_ger_honorguard_zomb_bodyalias`: `body1`, `body2` ×3, so 3 in 4 are `body2`                          |
| `self.headModel = randomElement(<list>)`, attach  | `c_ger_honorguard_zomb_headalias`: `c_ger_zombie_head1..4`, uniform                                    |
| `self.torsoDmg1..5`, `legDmg1..4`, `gibSpawn1..4` | `char_ger_honorgd_body1_g_*`: 17 dismemberment models, not exported                                    |

A character that calls `setModel("x")` instead has one body (the dog's
`zombie_wolf`), and one with no `headModel` has no head. The aitype also names a
weapon (`ak47_zm`) that nothing draws; nothing is grafted.

**How they fit.** Both bodies are 73 joints from `tag_origin` — the MP bodies'
`j_` biped, with `tag_weapon_right`/`_left`/`_chest` and no `j_gun` — and both
heads' skeletons are the body's from `j_spine4` up plus 23 face joints (`j_jaw`,
`j_brow_*`, `j_eyeball_*`, `j_lip_*`, `tag_eye`, …); heads 2 and 3 have two fewer
joints than 1 and 4, all of them ones the body has. So each body carries 96 after
the graft, and every head's joints are in it. The clips key 108 joints: 92 of the
96, plus 15 the honor guard does not have (`j_coat*`, `j_collar*`, `j_shorts*`,
`j_gun`, `tag_bipod`), which a rig drops. No clip drives `j_cheekpuff_*` or
`j_head_end`. Hitboxes derive to 25 boxes, none past `hitboxes.PLAUSIBLE_EXTENT`,
and **no neck box**: no vertex of any body or head weights `j_neck` most (a head
weights 104 vertices to it partly), so a hit the game calls "neck" (+20 points)
lands in `head` or `torsoUpper` here.

**A model can wear another zone's material.** The honor guard's linen, leather,
metal and skin are `,mc/mtl_c_ger_honorguard_zombie_*` in `zombie_theater.ff` — a
stub with no texture table, the real one being a companion's — so the xmodel dump
names no colour map for them and the body packs white.
`actors.fill_colour_maps` takes it from the companion's dumped material JSON.

**Clips** are all `common_zombie.ff`'s: asset type 2 (translations are offsets),
30 fps, version 19, 2D delta tracks. Which role picks which, from
`common_zombie_patch.ff`'s `maps/_zombiemode.gsc`:

| Role                             | Clips                                                                               | Length (s)   | Root speed (m/s)              |
| -------------------------------- | ----------------------------------------------------------------------------------- | ------------ | ----------------------------- |
| `idle`                           | `ai_zombie_idle_v1_delta` (no delta track, whatever the name says)                  | 1.97         | —                             |
| `walk` (`walk1..7`)              | `ai_zombie_walk_v1 v2 v3 v4 v6 v7 v9`; theater `v7` → `v8`                          | 2.87 – 4.40  | 0.58 – 1.21                   |
| `run` (`run1..5`)                | `ai_zombie_walk_fast_v1 v2 v3`, `ai_zombie_run_v2 v4`                               | 2.23 – 2.73  | 1.66 – 2.75                   |
| `sprint` (`sprint1..3`)          | `ai_zombie_sprint_v1 v2 v1`                                                         | 1.97 – 2.13  | 3.54 – 3.61                   |
| `attack` (`_zombie_melee`)       | `ai_zombie_attack_v2 v4 v6 v1`, `_attack_forward_v1 v2`                             | 1.03 – 7.17  | 0 – 0.48                      |
| `walkAttack`, `runAttack`        | `ai_zombie_walk_attack_v1..v4`, `ai_zombie_run_attack_v1..v3`                       | 0.70 – 1.57  | 1.13 – 1.25, 2.2 – 2.7        |
| `death` (`_zombie_deaths`)       | `ch_dazed_a..d_death` — what the spawner gives a standing zombie                    | 2.13 – 4.50  | 0.03 – 0.42                   |
| `deathAlt` (`death1`, `death2`)  | `ai_zombie_death_v1 v2`, in the table and never picked                              | 2.00, 2.27   | 0.72, 0.62                    |
| `windowClimb`, `…Run`, `…Sprint` | `ai_zombie_traverse_v1 v2` / `_v5` / `_v6 v7`                                       | 1.13 – 1.93  | 0.85 – 2.44; up to 0.47 m up  |
| `rise`, `riseRun`, `riseSprint`  | `ai_zombie_traverse_ground_v1_walk`, `_v2_walk_alta` / `_v1_run` / `_climbout_fast` | 3.03 – 10.10 | 0.06 – 0.24; 0.38 – 1.17 m up |

Per clip speeds: walk v1 0.956, v2 0.990, v3 0.952, v4 1.212, v6 0.582, v7 0.585,
v8 0.695, v9 0.662; walk_fast v1 1.662, v2 2.052, v3 1.994; run v2 2.752, v4
2.398; sprint v1 3.609, v2 3.542. These are averages over a cycle: a locomotion
clip's delta translation is 2 to 40 keys (`walk_v1` is two, first and last, and
`run_v2` forty), so some surge within the stride, and some carry yaw keys that
wander and return to 0 by the end. `walk_fast_v1` also drifts 0.58 m right a
cycle. The rawest reading of
`zombie_dog_run` is 724 in in 2.0 s (9.2 m/s), which is worth a second look
before the dog trusts it.

**A swing** is `animscripts/zombie_melee.gsc`'s loop. Each pass picks a clip with
`pick_zombie_melee_anim`: `random()` over `_zombie_melee` combined with
`_zombie_walk_melee` when `zombie_move_speed` is `walk`, or with
`_zombie_run_melee` when it is `run` or `sprint` (a legless zombie uses the
stumpy and crawl lists instead). It plays the clip with a `meleeanim` flag and,
until the `end` note, calls `self melee()` on **every** `fire` note — so
`ai_zombie_attack_v2`'s five notes are five hits — breaking out early on a `stop`
note when `CanContinueToMelee()` says no, or when the enemy is gone.

Not exported yet: the crawl set, the window board-tear and taunt clips, the
rise deaths, the jump-downs, the quad's and the thundergun's clips.

### Black Ops II: TranZit's walkers

Black Ops II ships BO1's zombie clips again, bit for bit where they are the same
clip, and dresses and drives them differently. Where each fact was found:
[reverse/t6-xanim](../../reverse/t6-xanim/README.md#the-actors).

**Everything is in the mode zone.** `so_zclassic_zm_transit.ff` holds the three
spawners' aitypes, their characters, the head alias list, the bodies and heads,
their materials, 501 clips and the state machine; only the traverse scripts are the
map's (`zm_transit_patch.ff`). Images are in `zm.ipak` beside it.

**The scripts are compiled**, so `t6/gsc.py` reads calls and strings, not text:

| Step                                                                                              | TranZit                                                                                            |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Spawner → aitype: three `zombie_spawner`s, `random(level.zombie_spawners)` (`_zm.gsc`)            | `actor_zm_transit_basic_01`, `_02`, `_03`                                                          |
| aitype `main` → `codescripts/character::get_random_character` over `character/<c>::main` calls    | `_01`: `c_zom_zombie1_01`, `_02`; `_02`: `c_zom_zombie2_01..03`; `_03`: `c_zom_zombie3_01..05`     |
| character `main`: `setmodel("<body>")`, then `randomelement(xmodelalias/<list>::main())` attached | one body each (`c_zom_zombieN_bodyNN`), every one the head list `c_zom_zombie_head_als`: `k l n a` |
| `self.torsodmg1..5`, `legdmg1..4`, `gibspawn1..4` (the value pushed before the field)             | `*_g_upclean`, `_rarmoff`, … — listed, not exported                                                |

So a body's weight is 1/3 × 1/(its aitype's characters): zombie1's two bodies 15
each, zombie2's three 10, zombie3's five 6 (of 90); the heads are uniform. The
survival and grief zones add aitypes `_05`, `_08` and `_09`, with other bodies. The
aitype's health and the `QUAKED` box are numbers in the bytecode, so the entry
has neither; `mp/zombiemode.csv` gives the round's (150, +100 a round).

**Which clip is what is a state machine, not a script.** An aitype names
`animstatedefs/zm_transit_basic.asd`, a text rawfile of 96 states, each listing
its clips, some under an alias the script asks for:

```
zm_move_walk : notify move_anim           zm_traverse_barrier : aliased restart notify traverse_anim
{                                         {
	ai_zombie_walk_v1                        	barrier_walk	ai_zombie_traverse_v1
	…                                        	barrier_run		ai_zombie_traverse_v5
}                                         }
```

| Role                                | State (`:alias`)                              | Clips                                                                       |
| ----------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `idle`                              | `zm_idle`                                     | `ai_zombie_idle_v1_delta`                                                   |
| `walk`, `run`, `sprint`             | `zm_move_walk`, `_run`, `_sprint`             | BO1's walks with `v9` twice (8), BO1's runs plus `run_v3` (6), sprint v1 v2 |
| `superSprint`                       | `zm_move_super_sprint`                        | `ai_zombie_fast_sprint_01`, `_02`: 4.60, 4.47 m/s                           |
| `attack`, `walkAttack`, `runAttack` | `zm_walk_melee`, `zm_run_melee`               | what both states list, then each one's own: BO1's pools exactly             |
| `death`                             | `zm_death`                                    | `ch_dazed_a..d_death`                                                       |
| `windowClimb`, `…Run`, `…Sprint`    | `zm_traverse_barrier:barrier_walk/run/sprint` | `ai_zombie_traverse_v1 v2` / `v5` / `v6 v7`, as BO1                         |
| `rise`                              | `zm_rise`                                     | the four ground climbs, one list: the script picks by speed                 |
| `crawl*`                            | the `missing_legs` states                     | idle, crawl, sprint, attack, death, window climb: nothing plays them yet    |

A traverse script is `main() { dosimpletraverse("<alias>"); }`, which plays that
alias of `zm_traverse` (`_crawl` appended for a legless one), so `traversals` maps
each of TranZit's 19 such scripts to its clip: `zm_jump_down_48` →
`ai_zombie_jump_down_48`, `zm_traverse_car` → `ai_zombie_traverse_car` (the
walker's; the script appends `_run` or `_sprint` by speed). `zm_mantle_over_40`
calls `dotraverse` on `zm_traverse_barrier` instead: the window climb roles.

**The bodies** are 73 joints, the BO1 biped's; each head 27, `j_spine4` up plus
the face. After the graft a body carries 95. Hitboxes derive to 26 boxes, and
unlike the honor guard's **a neck box**. The clips key 108 joints.

## Effects (FX)

How effects are exported: [effects.md](effects.md). How this was established, and the tools to check it: [reverse/iw5-fx](../../reverse/iw5-fx/README.md).

What an `FxEffectDef` means, read from `iw5mp.exe` (retail, 32-bit) and its
compiled particle shaders rather than inferred from the look of a render. The
`fx` dump writes the struct; `scripts/cod/fx.py` converts it; the runtime is
`packages/client/src/engine/fx/`. Addresses are for the depot `iw5mp.exe`, as
named in a private Ghidra project; every function below is named there, with a
plate comment, and each claim was checked a second time by decompiling it again.

### Data conventions

| Field                            | Meaning                                                                                                                                                                                                                             | Source                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `FxFloatRange`                   | `base + amplitude * r`, amplitude **signed**                                                                                                                                                                                        | `FX_EvalVisFloat` 0x4e4d30                                                                                          |
| `FxIntRange`                     | `base + ((u16(r) * (amplitude + 1)) >> 16)`, where `u16(r)` is the low 16 bits of the random float's IEEE bit pattern, not `r * 65536`                                                                                              | `FX_SetupUpdateElem` 0x4f2dc0                                                                                       |
| `visual.color`                   | bytes **B,G,R,A**; per sample `lerp(base, amplitude, r)`, one r for all four                                                                                                                                                        | vertex decl D3DCOLOR; `FX_InterpolateColorChannel` 0x4d67b0                                                         |
| `visual.size`                    | a **half-extent**: the quad is `2*size[0]` by `2*size[1]`; `size[1]` only with flag `0x10000000`                                                                                                                                    | `FX_GenQuadVerts` 0x4d74e0, `FX_EvalSize` 0x4f1550                                                                  |
| `visual.scale`                   | never read for sprites or tails: model scale, light intensity, cloud gate                                                                                                                                                           | `FX_EvalScale` 0x4f15e0                                                                                             |
| `velocity`, `totalDelta`         | units per ms; `totalDelta` is the running trapezoid sum of `velocity` over sample index                                                                                                                                             | `FX_IntegrateVelocity` 0x4f2af0                                                                                     |
| `rotationDelta`, `rotationTotal` | the same pair for the sprite's roll, radians                                                                                                                                                                                        | `FX_IntegrateRotation` 0x4f1430                                                                                     |
| `gravity`                        | a multiple of 800 units/s². The gravity integrator has no flag test of its own: it runs whenever `flags & 0x6000000` (world graph or gravity) is set, and on the collision path. MW3 only ships a non-zero gravity with `0x4000000` | `FX_IntegrateWithGravity` 0x4f2ca0                                                                                  |
| `spawnRange`                     | the elem spawns only while the camera-to-_effect_ distance is in `[base, base+amp]` (amp 0: always)                                                                                                                                 | `FX_CullElemForSpawn` 0x4ed160                                                                                      |
| `fadeInRange` / `fadeOutRange`   | alpha falls off with the camera-to-_particle_ distance: far and near respectively                                                                                                                                                   | `FX_ApplyDistanceFade` 0x4d6ad0                                                                                     |
| `spawnFrustumCullRadius`         | with flag `0x4`, nothing spawns unless this sphere around the effect is in view                                                                                                                                                     | `FX_PassesElemSpawnCull` 0x4ed160, which returns 1 when the elem **may** spawn; with no valid camera nothing spawns |
| `elemDefs` order                 | looping, then one-shot, then emission; the position selects the `spawn` union member                                                                                                                                                | zone code                                                                                                           |

**Travel** at life fraction `u`, with `N` intervals, `i = floor(N*u)`, `f = N*u - i`:
`life_ms * [TD_i + (f - f²/2) v_i + (f²/2) v_i+1]`. The whole life is passed into
every segment -- the lifespan is stored at `elem+0x48` and never divided -- so
neither "rate × age" nor "life / N" is right. Rotation integrates the same way.

**Visual state** blends samples `i` and `i+1` by `f`, with the same `i`, `f` over
`visStateIntervalCount`.

### Flags

| Bit          | Meaning                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `0x2`        | rotate `spawnOrigin` by the placement's axes (otherwise world axes)                                                                     |
| `0x4`        | frustum-gate spawning                                                                                                                   |
| `0x30`       | offset: `0x10` sphere shell in world axes; `0x20` cylinder about the placement's forward axis                                           |
| `0xc0`       | frame of local velocity and elem axes: `0` world; `0x40` the effect at spawn; `0x80` the effect now; `0xc0` a frame at the offset point |
| `0x1000000`  | local velocity graph applies                                                                                                            |
| `0x2000000`  | world velocity graph applies                                                                                                            |
| `0x4000000`  | gravity applies                                                                                                                         |
| `0x10000000` | non-uniform size (`size[1]`)                                                                                                            |

### Randomness

Every random is `fx_randomTable[seed + key]` (`g_flFxRandomTable`, 0x7fc8d0,
479 + 28 = 507 entries: the highest key is 28), with
`seed = (sequence*0x128 + effectSeed + elem.randomSeed + msecBegin) % 479`. The
exception is the one-shot count (key 19), which indexes with the effect's seed
alone.
Keys: velocity 0–2, angular velocity 3–5, spawn origin 6–8, offset yaw 9 /
height 10 / radius 11, spawn angles 12–14, gravity 15, reflection 16, life 17,
spawn delay 18, one-shot count 19, emit distance 20, visual 21, atlas start 22,
colour 23, initial rotation 24, rotation 25, size 26/27, scale 28. The runtime
keeps this layout with its own seeded generator, so no two fields share a random.

### Drawing

The particle materials use technique sets `effect_zfeather_blend[_nofog]`
(`zfeather_dtex.hlsl` / `zfeather.hlsl`). Each quad is built on the CPU as a full
32-byte packed vertex (position, colour as D3DCOLOR, texcoord, normal, tangent);
the shader reads position, colour and texcoord. The pixel shader:

```
soft = saturate(sceneViewDepth / featherDepth - particleViewDepth / featherDepth)
rgb  = lerp(fogColor, tex.rgb * vcol.rgb, fogFactor)   // no fog in _nofog
a    = soft * tex.a * vcol.a                            // straight, not premultiplied
```

The vertex shader also fades alpha by `saturate(particleViewDepth / featherDepth)`
near the camera. `featherDepth` is the material constant `featherParms[1]`
(80 units for `_z80` materials). Blend factors are the material's own, which for
these sheets is `srcalpha / invsrcalpha`. The runtime implements the near fade;
the scene-depth soft edge needs a depth texture the engine does not have yet.

**Quad layout** (`FX_GenQuadVerts` 0x4d74e0). Corners are `O ± s0·A ± s1·B`, with
`A = cos·P2 + sin·P3` and `B = sin·P2 − cos·P3`: the corner is scaled, then
turned anticlockwise by the roll. Vertices and UVs, drawn 0-1-2 and 2-3-0:

| Vertex | Corner | UV             |
| ------ | ------ | -------------- |
| 0      | −A +B  | (u0, v0+dv)    |
| 1      | −A −B  | (u0, v0)       |
| 2      | +A −B  | (u0+du, v0)    |
| 3      | +A +B  | (u0+du, v0+dv) |

For a billboard (`P2`, `P3` = camera right and up) at zero roll, A is right and B
is down: the usual top-left D3D layout, not mirrored.

- An **oriented sprite** (`FX_DrawOrientedSprite` 0x4d60e0) spans `axis[1]` and
  `axis[2]` of the _run-mode frame_ and faces along `axis[0]`; in run mode 0 that
  is the world's YZ plane. `spawnAngles` and `angularVelocity` play no part --
  only models read them. Seen from the `+axis[0]` side, u runs right and v down.
- A **tail** (`FX_DrawTail` 0x4d6220) is `size[0]` half-width across its velocity
  and `size[1]` half-length along it, centred `size[1]` behind the particle; B
  points backwards, so the top of the texture is at the leading edge.
- **Atlas** frames follow `FX_GetAtlasUV` 0x4d6960, counting rows from the top.
- **Final alpha** is `(distanceFade · occlusionFade · a) >> 16`, each fade a byte
  that defaults to 255, so an unfaded 255 draws as 253. Anything below
  `fx_alphaThreshold` is dropped.
- **Lighting** (`FX_ApplyLightingFrac` 0x4f1640) is integer maths:
  `c = clamp((255 + (2L − 255)·frac/255) · c / 255)`, truncating. L is sampled
  once, when the effect spawns, and only if `FxEffectDef.flags & 1`; otherwise 255.

Placement angles from createfx are Quake (pitch, yaw, roll) and go through the
same conversion as prop angles (`props.engine_euler`).

### Not implemented in the runtime

- the scene-depth half of zfeather soft particles (needs a depth texture);
- lighting by `lightingFrac`, and occlusion fading;
- sparks, models, lights, decals, sounds, trails, and heat distortion (T5 clouds are drawn, without their outdoor mask);
- run mode `0xc0` builds its frame at the offset point; the runtime uses the
  placement's axes for it.

### Black Ops (T5)

Read from Black Ops' own code: the symbolised Xbox 360 MP client, the retail
`BlackOpsMP.exe` and the dedicated server's PDB; how, the function map and what
is open are in [reverse/t5-fx](../../reverse/t5-fx/README.md). Everything above
holds for T5 except:

- **Types** are renumbered from index 2 and add `SPRITE_ROTATED` and `LINE`.
- **Seed:** `(sequence*0x128 + effectSeed + msecBegin) % 479`, with no per-elem term;
  508 table entries; key 29 is a cloud's count.
- **Rotated sprite:** its own `spawnAngles` (keys 12–14, no angular velocity) as a
  Quake axis, through the run frame, drawn as an oriented sprite on axis[1]/axis[2].
- **Line:** a tail centred `size[1]` ahead of the particle instead of behind. Tails
  and lines roll like any sprite.
- **Billboard facing**, flags `0x180000`: `0x80000` keeps the world's up, `0x100000`
  faces the eye, both do both.
- **Trim and pivot:** the quad's top and bottom edges are `topWidth`/`bottomWidth`
  of full, each in [0, 1], with UVs pulled in to match; with flag `0x200000` the
  centre moves by `pivot[0]·A' + pivot[1]·B'`.
- **Atlas:** `entryCountAndIndexRange` is cells (low 9 bits) and an index range;
  start mode 3 cycles that range from `index`.
- **Wind:** with `maxWindStrength`, `w = clamp(|wind| / maxWindStrength, 0, 1)` moves
  life and spawn interval toward their max-wind values. `windInfluence` is unread.
- **Final alpha** is `(a · round(fade·255 + 0.5)) >> 8`: an unfaded 255 draws as 254.
- **Cloud:** each particle is one rigid cloud of `count` screen-aligned quads out of a
  shared buffer of 2 × 1024 points (a jittered grid scattered by a 10-bit LFSR, then
  a clipped quarter-normal), from offset `((1025 − count)·u) >> 16`, both from key 29.
  A point lands at `pos + scale·(axes·p)`, `scale` in game units, the axes the spawn
  angles plus angular velocity over the particle's age. Quads are `size0` by `size1`
  (half a sprite's span), streaked along the motion only with non-uniform size; no
  atlas, roll, fog or feather. `particle_cloud_outdoor` also hides a flake under a
  roof, from a height map the runtime does not have.
- **Shaders:** `effect_zfeather` is IW5's blend. `effect_add` writes `rgb·a`;
  `effect_zfeather_add` writes `rgb·a·(0.25R + 0.5G + 0.25B)`, with additive sets
  fading to black in fog. `_falloff` scales alpha by and tints toward
  `f = sat(dot(view, N)²·falloffParms.z + falloffParms.w)`; `_eyeoffset` pulls the
  vertex `eyeOffsetParms.x` toward the eye along its ray. Particles add into the
  gamma-encoded frame with no exposure, as the engine's canvas blend does.

The exporter writes the roll, facing, fixed-range atlas and fade rounding as the
element and library properties `rolls`, `facing`, `atlas.ranged` and
`fadeQuantise` ([effects.md](effects.md)); the runtime reads those, never the game.

### Where these came from

Every address above is a named function in the RE project; the full map, with
the evidence for each name, is in
[reverse/iw5-fx](../../reverse/iw5-fx/README.md#function-map).
