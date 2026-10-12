# The export pipeline

`python3 -m scripts.cod export` runs these stages for one map
(`scripts/cod/export.py`). Every stage prints counts; the checks that guard
against silent failures print there too.

| Stage                 | Module                                                                                                                        | Reads                                                                       | Writes                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1. Dump               | `backends.py`, `zones.py`, `fastfile.py`, `zone/`, `zonecode/`, `iw4/`, `iw5/`, `t5/`, `t6/`, `iw6/`, `s1/`, `brushmodels.py` | the map's `.ff` and its companion zones (T6: and the `.ipak` packs)         | `.cache/cod/<slug>/`                                                            |
| 2. Classify materials | `materials.py`                                                                                                                | material JSON                                                               | render state per material                                                       |
| 3. Convert textures   | `textures.py`, `lightmap.py`, `dxgi.py`                                                                                       | `.iwi` / `.dds`                                                             | colour maps (≤512 px), `assets/lightmap.png`                                    |
| 4. Shell and decals   | `shell.py`                                                                                                                    | GfxWorld manifest + vertex/index blobs                                      | `assets/world.glb`, `assets/decals.glb`                                         |
| 5. Props              | `props.py`, `pack.py`, `animations.py`                                                                                        | static models, entity lump, XModel GLBs, xanims, scripts                    | `assets/props/*.glb`                                                            |
| 6. Collision          | `collision.py`, `mantle.py`, `ladder.py`, `triggers.py`                                                                       | clipmap manifest + soup blobs, entity lump                                  | `assets/collision.glb`, `mantle.world`, `ladder.world`, `volumes.world`         |
| 7. Prop placements    | `props.py`                                                                                                                    | stage 5 + XModel JSON + clipmap                                             | `props.world`                                                                   |
| 8. Viewmodel          | `viewmodel.py`                                                                                                                | the weapon files and the view-hands GLBs                                    | `assets/viewmodel/*.glb` (hands), harvested into `catalog/viewhands/`           |
| 9. Characters         | `characters.py`, `animations.py`                                                                                              | the map's MP bodies and heads, the weapon's world model                     | `assets/characters/*.glb`, harvested into `catalog/characters/`                 |
| 10. Loadscreen        | `textures.py`                                                                                                                 | the `.iwd` archives, `<map>_load.ff`, or a backend's `loadscreen_zones`     | `assets/loadscreen.jpg`                                                         |
| 11. Minimap, metadata | `textures.py`, `metadata.py`, `worldfile.py`, `nav/`                                                                          | `.iwd` or the image dump, entity lump, rawfiles, zone list, `<map>_path.ff` | `assets/minimap.png`, `export_metadata.json`, `minimap.world`, `gameplay.world` |
| 12. Effects           | `fx.py`, `worldfile.py`                                                                                                       | `fx` + material dumps, stage 11's createfx placements                       | `assets/fx/`, `fx.world`                                                        |
| 13. Sound             | `sound.py`, `iwd.py`, `worldfile.py`                                                                                          | `sound` + `loadedsound` dumps, the `.iwd` archives, stage 11's placements   | `assets/sounds/`, `sound.world`                                                 |
| — World file          | `worldfile.py`                                                                                                                | worldspawn, `.vision`, `_overrides.json`                                    | `world.world`                                                                   |

Stage 11 also writes `assets/nav.bin` and `navigation.world`: from the entity lump
alone for MW3, from `<map>_path.ff` for Ghosts and AW, and from the map zone's
`GameWorldMp` for Black Ops ([Navigation](#navigation)).

## 1. Dump

`backends.for_fastfile` picks what dumps the zone from the fastfile's header:
`scripts/cod/iw5/backend.py` for MW3 ([below](#the-zonecode-walker)),
`scripts/cod/iw4/backend.py` for MW2 ([below](#the-iw4-backend)),
`scripts/cod/t5/backend.py` for Black Ops ([below](#the-t5-backend)),
`scripts/cod/t6/backend.py` for Black Ops II ([below](#the-t6-backend)),
`scripts/cod/iw6/backend.py` for Ghosts and
`scripts/cod/s1/backend.py` for Advanced Warfare (which reaches a walkable world
but not yet its models, and is [in progress](../../reverse/s1-zone/PLAN.md)). A
fastfile none of them claims is refused. All of them write the same tree in the
same schema ([below](#the-dump-tree)), so every later stage reads it the same
way. A backend walks each zone once, on its first dump, and writes each kind
from that walk through its own `dumpers/`, one writer per kind.
A kind it writes only in part is dumped but not claimed (`provides`), and says
which top-level fields it does write (`writes`). So each stage asks for what it
reads: stages 8 and 9 ask for `viewmodel.WEAPON_KEYS` rather than for whole
weapon files, because a game's own structs need not have a member for every key
the weapon dump's schema has ([games.md](games.md#ghosts-iw6)). `export` stops after the shell without whole models and the clipmap's
model lists, and after `props.world` without a whole clipmap — `world.world`
names `assets/collision.glb`, so collision is the one stage it cannot do
without. Stages 8–13 are each skipped on their own and say which dump they
wanted, and `world.world` includes only the files that were written. The partial
runs (`--climbing-only` and the rest) refuse to start.

Ghosts' and AW's AI path nodes are in `<map>_path.ff`, which nothing in the map zone
names: stage 11 walks it on its own for the `pathdata` kind ([Navigation](#navigation)).
Black Ops' are in the map zone's `GameWorldMp`, dumped as the same kind.

Companion zones are dumped whole for the assets a map only names, and for
Ghosts that includes `common_core_mp.ff`, which nothing references and which
holds every weapon in the game ([games.md](games.md#ghosts-iw6)).

An export dumps, in order: the GfxWorld; xmodels, images, materials, weapon
files and xanims from the companion zones (`common_mp.ff`, `common.ff`; the
xanims into `view_anim/`, apart from the map's); then the map's own entity
lump, xmodels, images (each once, as IWI or DDS), materials, clipmap, rawfiles
and xanims, plus on IW5 its compiled scripts. The map is dumped after its
companions so its own copy of a shared asset wins.

Before any other work, `brushmodels.preflight` refuses a dump that cannot place
its brush models: one without the `models` / `cmodels` tables, without an
entity lump, or with a _rendered_ brush
model that nothing places, which would draw its walls at the world origin. A
collision-only one nothing places cannot be seen either way and is counted and
skipped (mp_frag's `*69`). It prints how many are placed by entity and by
dynamic entity.
`volumes.require_axial_faces` then refuses a clipmap without its brushes' axial
faces, which would lose most ladders quietly. Both guard a writer, not the data:
every stock map passes them.

### The dump tree

Every backend writes these under the export's scratch directory
(`.cache/cod/<slug>/`, one folder per kind), and every manifest carries `_game`
(`iw4`, `iw5`, `t5`, `iw6`, `s1`), which later stages use to pick per-game rules:

```
zone_source/<zone>.zone                     beside every dump: the zone's asset listing (metadata.zone_listing)
maps/mp/<map>.d3dbsp.gfxworld.json          counts, strides, bounds, surfaces (+material), static models, brush models
maps/mp/<map>.d3dbsp.gfxworld_vertices.bin  GfxWorldVertex[vertexCount], 44 bytes each
maps/mp/<map>.d3dbsp.gfxworld_indices.bin   uint16[indexCount]
maps/mp/<map>.d3dbsp.clipmap.json           brushes (+axial faces), materials, partitions, AABB leaves, cmodels, dynEnts, static models
maps/mp/<map>.d3dbsp.clipmap_verts.bin, _tris.bin, _edgewalkable.bin
maps/mp/<map>.d3dbsp.ents                   the entity lump, as text
xmodel/<name>.json, model_export/<lod>.glb  a model's LODs, bones and collision `contents`; one GLB per LOD
materials/<name>.json, images/<name>.iwi    or .dds where IWI cannot hold the format (IW6 and S1: always)
xanim/<name>, weapons/<name>                compiled clips; weapon infostrings
fx/<name>.json                              one per effect: elem defs, spawn, curves, visuals
sound_aliases/<name>.json, sound/<path>     one per alias list, and the PCM its loaded half names
```

A backend writes what the zone holds, in the zone's order, in game units: the
field-level meaning is [reference.md](reference.md) (world, collision, brush
models, models), [effects.md](effects.md) and [audio.md](audio.md). IW4, IW5 and
T5 write vectors as `{x, y, z}` objects and IW6 and S1 as lists;
`units.vec` reads both. An IW5 submodel whose `ClipInfo` is not the map's would
be written with no brushes and `foreignClipInfo: true`; no stock map has one.

### The zone core

Every Python backend reads a zone the same way, so there is one reader for all
games, in `scripts/cod/zone/`. A game differs from another only in data:

- **Containers** hand over the zone.
  - `fastfile.py` claims IW4, IW5 and T5 by magic and version.
    - A signed `IWff0100` file is checked chunk by chunk against its SHA-256
      hashes, and each master chunk against the auth header.
    - An unsigned `IWffu100` file is plain zlib.
    - Either way the zone is inflated into one buffer of the size its XFile
      header states, and anything longer or shorter is refused.
  - `iw6/ff.py` and `s1/ff.py` do the same for Ghosts and AW.
  - The layouts are in [reverse/x86-zone](../../reverse/x86-zone/README.md),
    under "The container".
- **`zone/spec.py`** holds one `ZoneSpec` per game. It says:
  - the blocks, and which of them are runtime: those read no bytes, but their
    cursor still moves;
  - the pointer width and its encoding. IW6 and S1 tag a 64-bit pointer. The
    32-bit games split `value - 1` into a block and an offset, with 4 block bits
    on IW4 and IW5 and 3 on T5;
  - the block that inserted pointer slots go to;
  - the XFile header: two words, then one per block. Its size is 40 bytes on
    IW4, 44 on IW5, 36 on T5 and 72 on IW6.
- **`zone/core.py`** is the `Zone` a walker consumes, and the `Record` it reads
  a struct through. `zone/layout.py` reads a game's generated `layout.json`.
- **`iw6/zone.py`** is IW6's spec and layouts over the core. S1 reads with it.

### The zonecode walker

IW4, IW5 and T5 zones are walked by one interpreter, `scripts/cod/zonecode/`,
rather than a hand-written walker per game. OpenAssetTools' ZoneCode — which
struct loads which member, in what order, into which block, with what count,
alignment and condition — is turned into `scripts/cod/data/<g>/zonecode.json`
(shipped; `reverse/x86-zone/build.sh` regenerates it, and proves every loader it
describes identical to OAT's generated C++). The walker runs that program over
the zone core:

- **`walker.py`** compiles each struct's load program into closures once per walk
  and runs the XAsset list through them, the way OAT's `*_load_db.cpp` would. A
  struct's "current instance", which counts and conditions read, is per asset
  loader, as in OAT.
- **`stream.py`** adds the loaded memory to the zone core's cursors: which zone
  bytes landed at which block offset, which object each allocation produced, and
  what each aliasable pointer slot resolved to. A reference to earlier data is a
  lookup in these, and gives back the very object loaded there.
- **`actions.py`** holds the hand-written actions: four a game (IW5: `OnImageLoaded`,
  `LoadImageData`, `SetSoundData`, `ReallocClipInfo`; IW4 has `SetModelSurfs`
  in place of the last), two for T5. What OAT copies out of TEMP
  is kept as a view of the zone's own bytes, which are never rewound
  (`Record.captured`).
- **`values.py`** is what a dumper reads. An `Asset` has a type, a name and a
  header `Record`. A `Record` gives a member by path (`"lodInfo[0].dist"`,
  `"info.name"`): a pointer as what it resolved to, a scalar as a number, an
  embedded struct as a `Record`. An `Array` is a view of the zone's bytes and
  holds Python objects only for elements that have pointers, so a walk costs one
  object per such struct and nothing per float
  ([what a walk costs](../../reverse/x86-zone/README.md#the-walk)).
- **`companions.py`** finds what a map names under a leading comma and only a
  companion zone holds. The backend indexes each companion zone it walks by
  name, through an indexer per kind that a writer registers (`@holds`), and
  keeps only the names. A writer asks for the names it lacks, and a companion
  already let go is walked again, once per request. The walk's records are lazy,
  so only what is asked for is ever decoded. The `xmodel` writer is the one user
  ([comma-named surfaces](#comma-named-surfaces)).

A walk is exact when it ends at the zone's last byte and every block's
high-water mark is the size the XFile header gives it (`Walk.check()`), and a
backend refuses a walk that is not. `python3 -m scripts.cod.zonecode <ff>
--listing -` prints a zone's asset listing, and `reverse/x86-zone/walkall.py`
walks every zone the pipeline reads ([reverse/x86-zone](../../reverse/x86-zone/README.md#the-walk)).

`scripts/cod/iw5/backend.py` walks MW3 with it and writes the kinds below through
`iw5/dumpers/`, claiming every MW3 fastfile by header.

| Kind                                     | What the IW5 backend writes                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| zone listing (`zone_source/<zone>.zone`) | written beside every dump (`zonecode.listing`)                                                                     |
| `mapents`, `rawfile`, `scriptfile`       | whole                                                                                                              |
| `gfxworld`                               | whole: manifest (surfaces with materials, static models, brush models) and both blobs                              |
| `clipmap`                                | whole: brushes with axial faces, materials, partitions, AABB leaves, cmodels, dyn ents, static models, three blobs |
| `xmodel`                                 | whole: the JSON (collision `contents` included) and a GLB per LOD; another zone's surfaces from its companion zone |
| `material`                               | whole; constant and texture names from OAT's known list and the zone's own shaders' constant tables                |
| `image`                                  | each image once, as IWI or DDS ([Images](#images))                                                                 |
| `xanim`, `attachment`                    | whole                                                                                                              |
| `weapon`                                 | whole: every key of OAT's field table (`out/iw5/weapon_fields.json`), and the AI accuracy graphs                   |
| `fx`                                     | whole: types named from IW5's own enum, `spawnKind` by position, samples only where present                        |
| `sound`, `loadedsound`                   | whole: alias lists, and each loaded sound as a PCM `.wav` at its own name                                          |

The IW5 backend dumps every kind the pipeline asks an MW3 zone for.

#### The IW4 backend

`scripts/cod/iw4/backend.py` walks MW2 the same way, claiming every MW2
fastfile by header. The walk-once machinery is one class for both games
(`zonecode/backend.py`), and so are the writers: `iw4/dumpers/` registers IW5's,
which name what they read by member and take `_game` from the walk. IW4 differs in
a handful of members, each handled in the writer that reads it
([reverse/x86-zone](../../reverse/x86-zone/README.md#what-the-world-records-hold)).

| Kind                                                            | What the IW4 backend writes                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| zone listing, `mapents`, `rawfile`                              | whole (a rawfile deflated or plain)                                                           |
| `gfxworld`, `clipmap`                                           | whole, IW5's writers: the clipmap's ClipInfo members are read flat, partition counts unsigned |
| `xmodel`, `material`, `image`, `xanim`, `weapon`, `loadedsound` | whole, IW5's writers; the weapon keys from `out/iw4/weapon_fields.json`                       |
| `fx`, `sound`                                                   | **nothing but the listing**; stages 12 and 13 skip                                            |

Writing MW2's effects and alias tables would be new output, so it waits for its
own decision. MW2 has no `scriptfile` or `attachment` asset.

#### The T5 backend

`scripts/cod/t5/backend.py` walks Black Ops with the same machinery, claiming
every Black Ops fastfile by header.
T5's records differ from IW's more than IW4's do, so half its writers are its
own (`t5/dumpers/`), each saying what differs; the rest are IW5's
([reverse/x86-zone](../../reverse/x86-zone/README.md#what-the-world-records-hold)).
`BlackOpsMP.exe` (`games.json`'s `exe` under the install, or `$T5_EXE`) is read for the wavelet
tables, as on IW.

| Kind                    | What the T5 backend writes                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| zone listing, `mapents` | whole                                                                                                           |
| `rawfile`               | whole: a `.gsc`/`.csc` is inflated from its own container and written without its NUL                           |
| `gfxworld`, `clipmap`   | whole, T5's own writers, in IW's schema plus T5's flags, corners and lightmap pages                             |
| `xmodel`, `xanim`       | whole, IW5's writers: a model's surfaces sliced per LOD from the model's own array; clips written as version 19 |
| `material`              | whole, T5's schema; names from OAT's T5 list and the technique sets' shaders, hashed as T5 hashes them          |
| `image`                 | each image once, as IWI v13 or DDS                                                                              |
| `weapon`                | whole: every key of `out/t5/weapon_fields.json`, the accuracy graphs, and a flamethrower's two flame tables     |
| `sound`                 | **both halves**: every alias list, and every loaded sound as xWMA, MS ADPCM or PCM RIFF                         |
| `loadedsound`           | nothing, not even a listing: the bank is one asset, and `sound` writes it                                       |
| `fx`                    | **nothing but the listing**; stage 12 skips                                                                     |

T5's `GameWorldMp` (and a zombies zone's `GameWorldSp`) holds the map's path
graph, which the `pathdata` kind writes ([Navigation](#navigation)).

#### The T6 backend

`scripts/cod/t6/backend.py` walks Black Ops II the same way, once `t6/ff.py` has
decrypted the zone (`fastfile.claim` hands it `TAff0100` files). T6's records are
T5's in most places, so its writers are T5's and IW5's where they fit and its own
where they do not ([games.md](games.md#black-ops-ii-t6--walkable-textured-and-lit)):

| Kind                    | What the T6 backend writes                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| zone listing, `mapents` | whole                                                                                                                            |
| `rawfile`               | whole, T5's writer: the `.vision` and the like (T6's scripts are compiled `script` assets, not rawfiles)                         |
| `gfxworld`              | whole, T6's own: its 36-byte vertex groups rewritten as IW's 44-byte vertices, in T5's manifest schema                           |
| `clipmap`               | whole, T6's own, in T5's schema: faces carry flags, the soup has a `uinds` blob                                                  |
| `xmodel`                | whole, IW5's writer, with T6's normal and texture-coordinate packing                                                             |
| `xanim`                 | whole, IW5's writer: T6's pools are IW5's ([reference](reference.md#black-ops-ii-xanims)); no prop animates yet                  |
| `script`                | each compiled script (`\x80GSC`) as it is, which `t6/gsc.py` reads for calls and strings                                         |
| `material`              | whole, T6's schema; slot names from OAT's T6 list (`out/t6/material_names.json`), the DXBC shaders not read                      |
| `image`                 | each image once as DDS: from the zone where it has pixels, else the largest level ≤ 512 px from the `.ipak` packs                |
| `sound`                 | every alias list; each entry names the `.sabl`/`.sabs` bank file and offset of its recording ([audio](audio.md#black-ops-ii-t6)) |
| `loadedsound`           | nothing: T6 has no such asset, and stage 13 reads a recording out of its bank file when a table names it                         |
| `weapon`                | OAT's infostrings over `out/t6/weapon_fields.json`: each weapon, `attachment` and `attachmentunique` (t6/dumpers/weapon.py)      |
| `stringtable`           | each table as a CSV at its own name (`patch_mp.ff`'s `mp/statstable.csv`)                                                        |
| everything else         | **nothing**: `fx` is not claimed, so its stage skips                                                                             |

#### Comma-named surfaces

A model's LOD names the `XModelSurfs` that holds its geometry, and a map zone's
copy of a shared model can name one under a leading comma and load no surfaces
for it: the zone that owns them is `common_mp.ff`. On IW5 the companion holds
each as an asset; on IW4 as the header a model of its own keeps
(`prop_flag_neutral` holds `flag2_lod000`). The map's model still brings its own
materials and bones, so a team's flag is the neutral flag's surfaces under its
own cloth. Every MW3 and MW2 map zone has such models:

| Game | Models (maps) | What they name                                                                                                                                                          |
| ---- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MW3  | 17 (all 25)   | `prop_flag_<team>` both LODs (`,flag2_lod000`, `,flag2_lod100`); `com_plasticcase_<team>` LOD 0 (`,plastic_case_big_us_dirt_lod011`)                                    |
| MW2  | 14 (all 16)   | the same flags and cases; mp_afghan's `projectile_cbu97_clusterbomb_static` LODs 1-2; `viewhands_us_army` LOD 0 in mp_highrise, mp_invasion, mp_nightshift, mp_terminal |
| BO1  | none          | T5 keeps a model's surfaces on the model, so there is nothing to name                                                                                                   |

The `xmodel` writer looks each one up by name in the companion zones the export
has already dumped (`zonecode/companions.py`; the export dumps them before the
map) and writes it as it would its own. A LOD whose name no companion holds is
written with its materials and no vertices, and a `WARNING` names it: both
companions' `fx` model names `,fx10`, which neither `common_mp.ff` nor
`common.ff` holds, so every MW3 and MW2 export prints that one. Two maps place
such a model: mp_nola its flag, and mp_afghan the cluster bomb, whose LOD 0,
the one a world draws, is its own. The other maps spawn theirs from script. The
four MW2 maps that name `viewhands_us_army` get a sixth pair of view hands from
it, the mesh and materials of `common_mp.ff`'s `viewmodel_base_viewhands`.

#### Images

Each image is written once: IWI v8 where IWI can hold the format, DDS where it
cannot (24-bit colour, padded to 32 bits, and colour wavelets). An image's pixels are the zone's own
when its load definition carries them, else `images/<name>.iwi` from the search
path's `.iwd` archives, taking the highest-named archive in a folder
([pitfalls](pitfalls.md#extraction)). An archive IWI
keeps its payload under a rewritten v8 header. Wavelet IWIs
(formats 6-10) are decoded by `scripts/cod/wavelet.py` with the game's own code
tables, read out of its executable (`games.json`'s `exe`: `iw5mp.exe` for MW3,
`iw4mp.exe` for MW2; or `$IW5_EXE` / `$IW4_EXE`); the
file is only read, and without it those images are skipped and counted
([reverse/iw5-wavelet](../../reverse/iw5-wavelet/README.md)).

### Memory

An export is one process, its stages in sequence. What it holds is the zone walks:
a walk keeps its zone's bytes (records read them lazily) plus one object per struct
with pointers, and a dump reads a companion's walk while the map's is still held.
So the peak is in stage 1, at the map's walk plus a companion being read:

| Map (game)  | Zone (inflated)           | Peak before | Peak after | Stages 2-13 before → after |
| ----------- | ------------------------- | ----------- | ---------- | -------------------------- |
| mp_la (T6)  | 147 MB, +196 MB common_mp | 954 MB      | 615 MB     | 650-930 → 120-330 MB       |
| mp_dam (AW) | 801 MB                    | 3.42 GB     | 2.31 GB    | 1.7-2.3 → 0.27-0.84 GB     |

What keeps it there:

- **A container is inflated into one buffer**, allocated at the size its header
  states, and never copied to `bytes`: joining pieces, or growing a bytearray and
  copying it, held the zone twice (`t6/ff.py`, `s1/ff.py`; `fastfile.inflate`
  does the same). The file and the payload are let go before the zone is made
  (`iw6/ff.py`, `s1/ff.py`). `test_t6.py` and `test_s1.py` bound the peak with
  `tracemalloc`. Reading mp_detroit (AW, a 953 MB zone) alone went
  from 2.79 to 1.40 GB, mp_alien_armory (Ghosts, 479 MB) from 1.77 to 1.24 GB.
- **The walks go once stage 1's dumps are written** (`export._release_walks`),
  and the cycle collector is run, since a walk's records point back at it. The
  map's is kept only where stage 11 reads its path nodes from the map zone itself
  (Black Ops).

The stage-1 peak is still the map's walk beside a companion's: dropping the map's
first would cost a second walk of it (about 100 s on AW). The next peak is the
shell (stage 4), which holds every vertex as Python floats, 32 bytes a value.
Several exports at once add up: each is its own process.

## 2. Materials

`materials.classify_materials` reads every material JSON into a render state:
blend equation, alpha test, culling, sort key and shadow casting, all taken from
the technique the game actually draws with (see
[reference.md](reference.md#materials)). `check_state_flags` checks that lookup
against each material's independent `stateFlags` byte and reports any
disagreement. It also splits out decals (an `unlit` techset) and drops
non-surfaces (`falloff`, `tools`, `shadowcaster` techsets, and what else a game's
`SURFACES_BY_GAME` entry names).

## 3. Textures

Colour maps become JPEG, or PNG when they carry alpha or modulate the surface
under them (multiply/add/screen decals, where JPEG artefacts would land on the
wall). Everything is capped at 512 px. A missing colour map is named in the log:
its surfaces render flat white.

`lightmap.convert` writes the map's baked lighting separately, at full size:
what each game's pages hold, and how the intensity the world file takes is
arrived at, is [reference.md](reference.md#lightmaps). Ghosts keeps its in two
DX10 formats Pillow cannot read, so `dxgi.py` unpacks BC4 and half-float RGBA;
its atlas can be several pages, which are stacked into one image and whose UV
rectangles stage 4 moves each surface into.

## 4. Shell and decals

`shell.export_shell` decodes the 44-byte GfxWorld vertices into the engine
frame, reverses winding, moves brush-model surfaces to their placements, drops
the sky and exposure portals, and writes one glTF primitive per material with
its colour map embedded. Where stage 3 stacked several lightmap pages,
`move_lightmap_uvs` first moves each surface's `TEXCOORD_1` into its own page.
Decal materials go to `decals.glb`, which the world
places with `collide: false` and `decal: on`. Draw order, blend equation and
shadow casting ride in each material's glTF `extras`; `packages/client/src/scene/importedMaterials.ts`
reads them. `check_winding` and `check_unit_vectors` run on every export. A
brush model that only some game modes have is drawn in a mesh `part:*N` of its
own, as its collision is ([reference.md](reference.md#game-mode-objects)).

## 5. Props

Skipped, with stage 7, when the backend dumps no `xmodel` or not the clipmap's
model lists (no backend today): no `props.world` is written, a stale one is
removed, and the export carries on to collision and the world file.

`props.collect_placements` merges the GfxWorld's static models with the
script-placed ones from the entity lump (vehicles, tarps, animated foliage),
which exist nowhere else. `pack.pack_models` makes each exported XModel GLB
self-contained: textures embedded, scaled to metres, render state applied,
vertex colours neutralised (see [games.md](games.md)) after the flag-wind
weights are copied out, FX cards and shadow proxies dropped. Only `lod0` is
packed.

Animated props: `animations.ClipAssignments` reads which clip each
`animated_model` entity plays from the map's own scripts, and
`animations.embed_clips` writes those clips into the packed GLBs (see
[reference.md](reference.md#animations)). The log counts the placements that
animate and names any `animated_model` entity whose clip the zone lacks.

## 6. Collision

`collision.export_collision` turns the clipmap's brushes into triangles
(clipping each face against the brush's planes), adds the triangle soup,
welds, and writes one glTF mesh per group: `solid`, `soup`, a `clip:0x…` group
per distinct brush contents value and a `clip:soup:0x…` one per soup contents.
Brushes that do not block the player are dropped. Each group's `extras` carry
its contents bits, what they block, the clip materials and per-brush triangle
ranges, which is what lets the in-game collider view (`X`) and inspector name an
invisible wall. `collides: false` marks a group the engine's BVH leaves out —
water, and the soup clips of the games whose `SOUP_CLIPS_COLLIDE_BY_GAME` entry
says so ([reference.md](reference.md#collision)).

A solid brush model that can be absent is a **part**: one only some game modes
have, or a `script_brushmodel` with DYNAMICPATH set (a door, a window clip).
`brushmodels.part_of` is the one predicate, and both the collision and the shell
split by it. A part's triangles go into meshes of their own, one per group,
tagged with its `*N`, and the scene's `extras.parts` lists them all. The log
names each with its modes (or `DYNAMICPATH`) and its triangle count. Which
entities those are, and how a world names them, is
[reference.md](reference.md#game-mode-objects).

The same dump says where a player may climb, and that comes out as world-file
nodes rather than geometry: `mantle.py` writes the mantle volumes (which block
nothing, so are not in the mesh) to `mantle.world`, and `ladder.py` the ladders
(which are walls, so are in it as well) to `ladder.world`. Both are yaw-aligned
boxes fitted by `volumes.py`, and both print a coarse report on whether the
surface a climb ends on is where the box says
([reference.md](reference.md#collision)). Neither is in `export_metadata.json`,
so `--gameplay-only` cannot rewrite them.

`--climbing-only` rewrites just those two files, from a fresh dump of the
clipmap, the GfxWorld and the entities (the last two to place brush models), in
seconds. It adds their includes to an existing `world.world` if it lacks them.

**Trigger volumes.** Every `info_volume` and `trigger_*` whose model is `*N` has
its volume in the clipmap, as `cmodels[N]`'s brushes stored around the entity's
origin. `triggers.py` writes each **brush** as one yaw-aligned `trigger` box
(`volumes.fit_box`) to `volumes.world`: one box per model would overfill a zone
that turns a corner, and one per brush stays within 1.42× of the brushes on both
zombies maps ([reference.md](reference.md#zombies-entities)). A box is named
`t<entity id>`, with `_<k>` for each brush of a model of several. It carries
`tag`, `target`, `mode` and `use` exactly as `gameplay.world`'s nodes do, and the
log prints the box fit and every target it dropped. IW4 and IW5 name a trigger's
volume `?N`, an index into the entity lump's own trigger table, which no backend
dumps; those are counted in `gameplay.world` and not exported.

`--volumes-only` rewrites just `volumes.world` from a fresh dump of the entities
and the clipmap, and adds its include if it is missing. A target in it may name a
tag `gameplay.world` carries, so run `--gameplay-only` beside it on a world
exported before points existed.

## 7. Prop placements

`props.write_props_world` writes one `asset` per model (with `until:`, the
game's cull distance, and `hull:`, the collision LOD) and one `model` per
placement, densest kinds first. What collides is the game's own answer: a model
in the clipmap's static-model or dynamic-entity lists collides, unless its
XModel contents stop nothing the player walks into (foliage, glass debris). A
model name can hold a folder (Ghosts' `mv/` variants); the packed file keeps
it, and the clipmap lists such a model without it
([games.md](games.md#ghosts-iw6)).
Script-spawned destructibles inside the playable area keep collision. A
placement whose clip made it into its GLB gets `animate: "<clip>"`, and a
script model only some game modes have gets their `mode:`. The file's
header counts what collides and why the rest does not, and what animates. A
clipmap dumped without its brushes (Ghosts, so far) bounds no playable area, and
the header says so.

## 8. Viewmodel

`viewmodel.export_viewmodel` packs every view-hands model the zones hold into
`assets/viewmodel/`, and **names** one weapon: `iw5/iw5_m4_mp` on MW3,
`iw4/m4_mp` on MW2, `iw6/iw6_ak12_mp` on Ghosts, or whatever `_overrides.json`
says. No world file: `assets/viewmodel/` is a staging area, and `harvest` moves
the pairs into `catalog/viewhands/` where a gametype picks one.

**A world packs hands, not weapons.** The weapon is a catalogue id, and the
catalogue is one copy every world that names it shares — so the gun, its
skeleton, its clips and its definition are built once, by the catalogue builder
below, rather than once per map. That is also why a game server no longer reads a
weapon out of a filename. The data and why each step is shaped this way:
[reference.md](reference.md#viewmodels).

`--viewmodel-only` runs this stage alone (the model, image, material and weapon
dumps, about half a minute), and adds the include to an existing
`world.world` if it lacks one. On Black Ops the hands are the ones the map's
create-a-class scripts give the allies' default class
([games.md](games.md#black-ops-t5)).

## 9. Characters

`characters.export_characters` dresses the other players. It picks one
`mp_body_*` a side out of the map's own zone (an assault body, by the faction in
its name), pairs each with the `head_*` whose name shares the most words with
it, and packs body, head and the world model of the weapon stage 8 chose into
`assets/characters/`. The head's own joints and the weapon's whole joint tree
are grafted into the body GLB, so one skeleton drives all three and the other
two are rebound to it by joint name at run time. A chosen body it can find no
head for stops the export: dressing one side and dropping the other renders
perfectly and is wrong ([pitfalls.md](pitfalls.md#characters)).

Black Ops is read differently: its map zones say which head and arms each body
wears, in the create-a-class scripts (`cac.py`), so stage 9 dresses each side's
`standard` class from those rather than from names.

Advanced Warfare is not dressed by this stage at all. Its bodies are costumes
assembled from per-item part zones, which no map ships, so `catalog --dump aw`
builds its cast straight into the catalogue from the game's own costume tables
(`scripts/cod/costumes.py`, `aw_cast.py`;
[reverse/s1-zone/README.md](../../reverse/s1-zone/README.md#the-characters)).

What the stage decided is written to `assets/characters/cast.json` — each body, its
head and its side, the gun grafted into them and the anim type of the clip set
they play — because `harvest` cannot recover the pairing from filenames.

A zone whose bodies name no faction — every Ghosts map, which ships one side's —
gets one character per body instead, named for the body. Nothing invents a second
side out of a camo variant: each catalogue entry records the `side` the game put
that body on, so two teams that are one faction say so.

The clips are not the map's, and the stage writes none: every player clip lives
in `common_mp.ff` and serves every character in the game. They are built once a
game, straight into the catalogue ([the player clip set](#the-player-clip-set)).

`--characters-only` runs stages 8 and 9 from the dumps they need. Both, because
a character holds the weapon the viewmodel stage picks; only the flag's own
include is added to an existing `world.world`.

## 11. Minimap and metadata

`textures.export_minimap` copies `compass_map_<zone>` at full size out of the
first place that has it: the `.iwd` archives, where every stock IW and T5 zone
ships one (Black Ops lists none in the zone itself); then the image dump, for a
game that ships no `.iwd` at all (`Backend.pictures`, and stage 10 reads the
loading screen the same way, out of `<map>_load.ff`); then the `minimap.png` a
previous export already wrote, so that a run which reaches neither leaves the
world's HUD map alone instead of deleting it. `metadata.write_metadata` then writes
`export_metadata.json`: every entity with its keys named, spawns by mode and
team, Black Ops spawn influencers, game-mode objects grouped by
`script_gameobjectname`, where the minimap lies (see
[reference.md](reference.md#minimap)), the literal settings in the map's
plain-text scripts (dvars, fog, ambience), createfx placements, the `.sun` and
`.vision` cvars, and the zone's asset listing. Positions carry the game's
`origin` and the engine's `at`.

**Nothing in `packages/` reads this file, and nothing may.** It is a reference
dump: a record of what the entity lump held, for humans and for debugging this
pipeline. Anything the engine needs from it is written into the world file
instead (below), so that `ResolvedWorld` stays the one description of a world
and `pnpm check` stays the whole truth about one.

`worldfile.write_minimap_world` turns the image and its frame into
`minimap.world`, the `minimap` node the HUD map reads: the image's centre, size
and the yaw of its up. It sets no `range`. The map's `compassmaxrange` (kept in
the metadata) runs from 35 m to 100 m, so every map takes the engine's default
zoom instead.

`worldfile.write_gameplay_world` writes `gameplay.world`, which is the part of
the entity lump the **engine** reads: every spawn point as a `spawn` node
qualified by `mode`, `team` and `start`, and every trigger volume the entity
itself describes as a `trigger` node. A spawn's `facing` direction becomes a
`look:` point one metre along it. A trigger is named `t<entity id>` rather than
by its `targetname`, because a targetname is deliberately shared — three
Domination flags carry `flag_primary` — and a DSL `name` must be unique; the
targetname becomes its `tag` instead. A trigger only some game modes have gets
their `mode:`, and each collision part a `solid { part: "*N", tag: ..., mode: ... }`
([reference.md](reference.md#game-mode-objects)).

Every AI spawner (`actor_*`) and every named `script_struct` or `script_origin`
becomes a `point` named `p<entity id>`, at its origin and facing its `angles`.
Black Ops' ambience structs (a `script_sound` with a `script_label`) are left out:
the client's `_audio.csc` plays them, no server script reads one, and the looping
ones are already in `sound.world`.

**Tags and targets.** Every node's `tag` is the entity's `targetname`,
`script_noteworthy` and `script_string`, in that order and each once: the three
ways a CoD script sorts an entity. Its `target` is the entity's own, but only
when some node of the world carries that tag. `gameplay.py` holds these rules,
and both `gameplay.world` and `volumes.world` compute the whole world's tags from
the entity lump, so neither trusts the other file to be current. A target naming
something no node is written for (a `script_model`, a path node) is dropped, and
the log and the file's header count them by what they named.

**Brush-volume triggers are `volumes.world`'s.** Only `trigger_radius` carries its
own size; a `*N` volume is in the clipmap, which this stage does not read, so
`gameplay.world` counts those in its header and stage 6 writes them. IW's `?N`
triggers are counted as not exported.

### Navigation

Last in the stage, `export.export_navigation` turns the map's path nodes into
`assets/nav.bin` (the format is [../engine/nav-format.md](../engine/nav-format.md))
and a one-line `navigation.world` naming it; what each game's data becomes, and
why, is [navigation.md](navigation.md).

- **MW3:** the entity lump's `node_*` entities, already in `export_metadata.json`,
  which `scripts/cod/nav/from_ents.py` maps through `nav/vocab.py`.
- **Ghosts and AW:** the game's compiled graph, from `<map>_path.ff` beside the map.
  `_dump_pathdata` walks that zone alone (a second or two) and writes the
  `pathdata` kind, which `scripts/cod/nav/from_pathdata.py` maps and checks
  against the entity lump in the metadata; a mismatch stops the export. A map
  with no path zone keeps whatever navigation files it has.
- **Black Ops:** the same, from the map zone itself: its `GameWorldMp` (the
  zombies maps' `GameWorldSp`) holds the PathData, which
  `scripts/cod/t5/dumpers/pathdata.py` writes as the same `pathdata` kind. In a
  full export it reuses the map's walk; `--nav-only` walks the map zone (a few
  seconds). Its nodes keep their authored height, so the check against the
  entity lump compares z as well.
- **Black Ops II:** as Black Ops, from `GameWorldMp`, with
  `scripts/cod/t6/dumpers/pathdata.py` reading T6's wider link. The links the
  game marks redundant are left out and counted in the report.

The stage prints the node, traversal and game walk-link counts, how far the
path data's nodes sit from their entities at worst, and names any negotiation
node that pairs with nothing, any animscript the vocabulary maps to `UNKNOWN`,
and what it skipped. A map with fewer than 10 nodes gets no graph, and a stale
`navigation.world` and `nav.bin` are removed. MW2 never has one.

**The `pathdata` dump** is ours rather than an OpenAssetTools kind: an
intermediate in game units, at `path/maps/mp/<map>.d3dbsp.pathdata.json` under
the work folder, named like the other world dumps by the asset's own name. Its
schema is in `scripts/cod/iw6/dumpers/pathdata.py`: every node (the zone nodes
too) with its game type number, origin, yaw, spawnflags, strings and dynamic
group, each node's links as the game stored them, and the counts of entity, zone
and dynamic-group nodes. The dumper refuses a path zone whose walk did not close
on its last byte; Black Ops' refuses a node array whose 128 runtime slots after
`nodeCount` are not empty.

**`--nav-only` needs no game files for MW3**, like `--gameplay-only` below: it
rebuilds `nav.bin` and `navigation.world` from the committed metadata, and adds
or drops the `navigation.world` include to match, on a machine without the game
installed. Ghosts', AW's and both Black Ops' graphs are not in the metadata, so there
it also needs the game's `<map>_path.ff` (and, for Ghosts, the Durango build, as any
Ghosts walk does), or Black Ops' or Black Ops II's `<map>.ff`; it looks in
the game's zone folders (cod.config.json), and says so and changes nothing when the
zone is not there. Run `python3 -m scripts.cod export --game mw3 --nav-only`
(or `--game ghosts`, `--game aw`, `--game bo1`, `--game bo2`), then `pnpm check`, which decodes each file and prints its
counts.

`--metadata-only` runs this stage alone: it needs only the `mapents` and
`rawfile` dumps, and takes the game from the zone listing's `>game,` line. It
adds the `minimap.world`, `gameplay.world` and `navigation.world` includes to an existing
`world.world` if it lacks them. It does not dump images, so on a game whose
compass picture is a zone image it keeps the `minimap.png` already there.

**`--gameplay-only` needs no game files at all.** It rewrites `gameplay.world`
from the `export_metadata.json` already committed beside it, so changing how
spawns or triggers are emitted costs a second across every world rather than a
full re-export — no fastfile, no game install. Use it whenever the
change is to the emitter rather than to what was dumped. Its `solid` lines name
collision parts, so a world needs a `collision.glb` exported with them
(`--collision-only`) first. `props.world`'s `mode:` comes from
`python3 -m scripts.cod migrate --object-modes`, which matches each placement to
its entity by asset and position, also without game files.

## 12. Effects

The map's particle effects: the definitions behind its createfx placements, the
closure over the effects they spawn, their materials and sheets, and an
`fx.world` that says where each plays. Needs an `fx` dump (IW5 only) and, since most effects are defined there, the
companion zone's. The whole story, including how each field's meaning was
established, is in [effects.md](effects.md).

`--effects-only` rewrites `fx.world` from the committed metadata and the
`assets/fx/effects.json` already on disk — byte-identical to the full export,
and like `--gameplay-only` it needs no game files.

## 13. Sound

The map's ambience: the alias table behind its `createLoopSound` placements, the
aliases those layer in, the clips behind them converted to Opus, and a
`sound.world` that says where each plays. Needs `sound` and `loadedsound`
dumps (IW5, T5 and T6), and the `.iwd`
search path for the half of the bank that is streamed rather than stored in the
zone (Black Ops II's recordings are all in its `.sabl`/`.sabs` bank files instead,
which the dump names by path). The whole story is in [audio.md](audio.md); the engine's half is in
[../engine/audio.md](../engine/audio.md).

`--sounds-only` rewrites `sound.world` from the committed metadata and the
`assets/sounds/sounds.json` already on disk, on the same terms `--effects-only`
has: byte-identical to the full export, and no game files.

`--sound-export-only` runs this stage alone from a fresh dump — the companions'
aliases, then the map's — and rewrites `assets/sounds/` and `sound.world`, adding
`include "sound.world"` to `world.world` and touching nothing else. It is how the
16 Black Ops II worlds got their sound without a full re-export
(`export --game bo2 --sound-export-only`, about 4 minutes).

## The shared asset catalogue

`python3 -m scripts.cod catalog` builds `worlds/catalog/`, which is where things
that belong to **no one map** live:

```
catalog/weapons/iw5/iw5_m4_mp/           iw5_m4_mp.glb, iw5_m4_mp.json
catalog/attachments/iw5/viewmodel_acog/  viewmodel_acog.glb
catalog/characters/iw5/mp_body_delta_.../ the body, its head, and what it is
catalog/viewhands/iw5/viewhands_delta/   viewhands_delta.glb
catalog/animations/iw5/autorifle/        animations.glb — one clip set per game
catalog/worldweapons/iw5/weapon_m4_iw5/  the gun a body is seen holding
catalog/props/iw5/com_barrel_lod0/       com_barrel_lod0.glb — 7,227 of these
catalog/sounds/iw5/mp/                   sounds.json and clips/ — the shared alias bank
catalog/actors/t5/zombie_ger/            a creature's bodies, heads and what it is (below)
catalog/animations/t5/zombie/            its clips, and which role picks which
catalog/index.json                       the kinds something has to enumerate
```

`kind` and `game` are path segments rather than parts of an id, so `m4` can exist
in both iw4 and iw5 without colliding and a whole branch is a prefix — which is
what let characters and props move in here without a route each.

### The player clip set

`catalog/animations/<game>/<animType>/animations.glb` is the one clip set every
body of a game plays: a skeleton with no meshes — the union of the joints of
every body `catalog/characters/<game>/` holds, because a clip has to be able to
turn any of them — carrying the clips and, in its scene extras, the table of
which clip plays which role. `scripts/cod/cast_clips.py` builds it from a
companion-zone dump and from nothing else, in three places:

- `catalog --dump <game>` (or `--work <dir>`), after the weapons;
- an `export`, after its harvest, from the export's own dumps — a new body's
  joints join the set there;
- `catalog --clips-only --work .cache/cod/catalog-<game> --game <key>`, which
  rebuilds the set and the index from a dump already made and touches nothing
  else. With `--dump <game>` it dumps the companion zones first.

`harvest` does not carry clips: a world ships none.

What each clip is _called_ is per game (`characters.CLIP_ROLES_BY_GAME`), and a
role whose clip the zone lacks is left out of the table, which is how the engine
knows to fall back ([player.md](../engine/player.md#the-body-in-a-stance)). The
standing roles are in [reference.md](reference.md#characters); crouched and prone:

| Role                             | MW2, MW3, Black Ops                                               | Ghosts, AW                                       |
| -------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| `crouchIdle`, `crouchIdleAds`    | `pb_crouch_alert`, `pb_crouch_ads`                                | `mp_crouch_idle`, `mp_crouch_idle_ads`           |
| `crouchForward/Back/Left/Right`  | `pb_crouch_run_{forward,back,left,right}`                         | `mp_crouch_{f,b,l,r}`                            |
| `proneIdle`, `proneIdleAds`      | `pb_prone_aim`; `pb_prone_aim_ads` (Black Ops)                    | `mp_prone_idle_iw6`; none                        |
| `proneForward/Back/Left/Right`   | `pb_prone_crawl{,_back,_left,_right}`                             | the same clips                                   |
| `standToCrouch`, `crouchToStand` | `pb_rifle_stand2crouch`, `pb_rifle_crouch2stand` (Black Ops only) | `mp_stand_2_crouch`, `mp_crouch_2_stand`         |
| `crouchToProne`, `proneToCrouch` | `pb_crouch2prone`, `pb_prone2crouch`                              | `mp_crouch_2_prone`, `mp_prone_2_crouch`         |
| `crouchFire`, `crouchFireAds`    | `pt_crouch_shoot_auto`, `pt_crouch_shoot_auto_ads`                | `pt_crouch_shoot_auto`, `pt_crouch_shoot_ads`    |
| `crouchReload`                   | `pt_reload_crouch_rifle`                                          | `mp_crouch_reload`                               |
| `proneFire`, `proneFireAds`      | `pt_prone_shoot_auto`; `pt_prone_ads_shoot_auto` (Black Ops)      | `pt_prone_shoot_auto`; none                      |
| `proneReload`                    | `pt_reload_prone_auto`                                            | `mp_prone_reload_iw6`, which keys the whole body |

So a Modern Warfare set has 34 roles, Ghosts' and AW's 36 and Black Ops' all 38.
Black Ops II plays Black Ops' set. Where each was found, and what else the zones
ship: [reverse/cod-stance-anims](../../reverse/cod-stance-anims/README.md).

**An idle is written as its first frame** (`characters.HELD_ROLES`). The engine
holds a body at rest at phase 0 — a pose is a function of the state and of no
clock — so the 8 to 20 seconds of fidgets after that frame would be bytes nothing
reads.

**A loop's stride is the game's own, and the engine's is one number a stance.**
The engine turns a crouched loop once every 6.9 m and a crawl once every 2.8 m
(`sim/gait.ts`). The forward loops' own root travel:

|                 | MW2, MW3 | Black Ops | Ghosts  | AW     |
| --------------- | -------- | --------- | ------- | ------ |
| `crouchForward` | 6.89 m   | 6.89 m    | 10.03 m | 8.14 m |
| `proneForward`  | 2.83 m   | 2.40 m    | 2.91 m  | 2.91 m |

so a Ghosts body's feet turn 45% too fast for the ground under a crouched walk,
an AW body's 18%, and a Black Ops body crawls 14% slow. The other three
directions are different lengths again in every game, and share the forward
clip's clock.

**Only some kinds are in the index.** A kind is listed when something has to
enumerate it — weapons for Create-a-Class, bodies and hands for a gametype
choosing a cast. Props, attachments, overlays and world weapons are _addressed_ by
id and appear in no index: 7,227 prop entries would double a 1.1 MB parse both ends
do on the main thread at boot, for bytes no client needs before a world loads.

**A prop id is its path under `assets/props/`, with `/` becoming `.`** — a
catalogue id is one path segment, and Ghosts ships five props under an `mv/`
subdirectory whose basenames collide with top-level ones. Keyed by basename those
two silently become one asset. Verified: all 7,227 ids land inside the route's
allowlist and under its 64-character cap. `@3d/api`
serves it at `/api/catalog`, and both the client and a game server fetch it at
boot; the definition is written beside the model rather than left inside it so
that a game server can hold a weapon without loading 2.5 MB of geometry to learn
a reload time.

**It is built from a game's own companion zone, and from nothing else** — with
one documented exception, which is sound ([below](#the-sound-bank)). A world used
to ship the one weapon it held, and a catalogue could be assembled from those
with no game files at all; a world now _names_ its weapon instead, so this is
where every weapon comes from. The index is rebuilt from what is on disk after
each run, so building one game does not drop another's:

- **`catalog --work .cache/cod/<world>`** takes _every_ player weapon out of an
  export's scratch directory — the one a normal export already fills with the
  common zone's models, images, materials, weapon files and view clips. It dumps
  nothing itself, so it runs against a cache in a couple of minutes. On MW3 that
  is **53 weapons, ~100 MB**; on MW2, **43 weapons out of 1121 player weapon
  files, ~150 MB**, because MW2 ships one file per attachment combination. Which
  files count, and why so few do, is
  [reference.md](reference.md#weapons-what-a-player-may-carry).
- **`catalog --dump mw2`** does the dump itself — only the companion zone, not a
  map, since every weapon in a game lives there. That is why it is its own
  command: exporting a whole map to reach `common_mp.ff` would dump a few hundred
  MB of geometry nothing here reads. What reads the zone is the fastfile's own
  answer, exactly as it is for an export (`backends.for_fastfile`), so
  `--dump ghosts` walks Ghosts' three companion zones in Python and takes about
  90 s. For MW3 and Ghosts it also dumps the `attachment` assets, an asset type
  MW2 and Black Ops do not have and whose dump those zones error on rather than
  leave empty (`catalog.ATTACHMENT_GAMES`).

`--dump ghosts` builds **39 weapons and 66 attachments, ~92 MB**.

`--dump bo2` builds **37 weapons and 18 pairs of hands, ~103 MB**, from four kinds
of zone rather than one (`t6_catalog.py`): `common_mp.ff`, then
`common_patch_mp.ff` over it (the game's own rebalance of 70 guns, and the
Peacekeeper), the seven `faction_*_mp.ff` for the hands, which no map or companion
ships, and `patch_mp.ff`'s `mp/statstable.csv`, the Create-a-Class menu the build
is checked against: every gun a row, every attachment list the menu's, and the
menu's slot where `weaponClass` disagrees. Each gun offers what the menu does bar
dual wield, up to the wire's 16 ([games.md](games.md#black-ops-ii-t6--walkable-textured-and-lit)).

**What may be fitted comes out of the same build.** Each weapon's entry carries
its attachments in slot order, already collapsed against that weapon in absolute
numbers, and MW3's and Ghosts' attachment models are packed once each under
`catalog/attachments/`. The two games are read completely differently and the
readings are full of plausible-looking traps —
[reference.md](reference.md#attachments) is all of it. An `--game iw4` build
checks itself: MW2 ships a weapon file for each of 806 two-attachment
combinations, and composing our own deltas has to give them back, bar five known
ones ([reference.md](reference.md#the-two-recoils)).

A weapon's catalogue id is **`<game>/<name>`**, because a name alone is not
unique: `at4_mp`, `javelin_mp`, `rpg_mp`, `stinger_mp` and `riotshield_mp` are
each in both Modern Warfares with different numbers.

Like an imported map's `assets/`, `worlds/catalog/` is **kept out of git**: it is
the game's own content, and it rebuilds in a second from files the repo already
does not carry.

A snapshot names a weapon by its **index** in this catalogue and an attachment by
its **slot** in that weapon's own list, rather than by name — which is why
`WeaponRegistry` sorts by id and why a join carries a `catalogHash` covering both
orders. See [docs/server/README.md](../server/README.md#the-wire).

`pnpm catalog` loads a built catalogue through that same `WeaponRegistry` and
reports it, which is the fastest way to see what fitting something does:
`pnpm catalog iw5/iw5_m4_mp acog` prints the M4's ADS going from 50° to 30°.

### The sound bank

Footsteps, landings, weapons, bullet impacts and body foley belong to no one
map, so they are here — **1,330 aliases and 730 clips, 5.9 MB**, as one entry:

```
catalog/sounds/iw5/mp/sounds.json         the alias table: 500 KB, `_version` 1
catalog/sounds/iw5/mp/clips/**.webm       730 mono Opus clips, 87.2 MB of PCM in
```

`sounds` is not in `index.json`, for the reason props are not — nothing
enumerates it. But unlike a prop, which a world addresses by id, an **alias table
has to be fetchable whole**, because what a caller holds is a name and a name has
to resolve to a row. So the table is one file fetched on demand and the clips are
addressed one at a time: exactly the shape a world's own `assets/sounds/` has, and
read by the same reader. The id is _which bank_: `mp` is
`localized_common_mp.ff`, and a campaign bank would be `sp` beside it.

**Three things about it are unlike every other kind.**

**It comes out of a different zone.** IW5's `common_mp.ff` — the companion zone
every other kind is built from — holds not one sound asset. The 7,387-alias bank
is `localized_common_mp.ff` beside it (`zones.SOUND_ZONES`). Two more zones are
dumped for their PCM and nothing else (`zones.SOUND_PCM_ZONES`): `common_mp.ff`
holds `misc/pu_weapon02.wav`, which is every weapon's pickup, and the localized
code zone holds `null.wav`.

**It takes the union with one map zone, which is the documented exception to
"and from nothing else".** Sixteen aliases — `step_run_plr_*`,
`step_sprint_plr_*` and six `land*` — are absent from the bank and defined by
_every_ map zone instead. They are the player's own footsteps and landings, which
is precisely where the first footstep work looks, so a catalogue built the usual
way would have a hole exactly where it is noticed last. `dump_sound` therefore
takes the first map zone that defines them, and `sound.merge_dumps` **proves** the
two zones agree wherever both define a name rather than trusting it. Measured:
the overlap is **empty** — the bank and a map zone are disjoint by construction,
since a map zone references what the bank defines rather than redefining it — and
the sixteen are byte-identical across aground, dome, paris, seatown and village.
Only the families the catalogue asks for by name are taken from the map zone, so a
map's own ambience stays the map's. The design and its reasons are in
[../engine/audio.md](../engine/audio.md#where-sound-lives).

**It is a closure from named roots, not the whole bank.** 7,387 aliases is ~161 MB
of JSON, overwhelmingly campaign voiceover and battlechatter no multiplayer game
plays. The roots are two prefix families, one reading of the weapon files, one
concatenation and one list of names (`sound.CATALOG_FAMILIES`,
`sound.weapon_roots`, `sound.impact_roots`, `sound.FEEDBACK_ALIASES`), and
`secondaryAliasName` closes it as it does for a world:

| Group      | Roots | What                                                                 |
| ---------- | ----- | -------------------------------------------------------------------- |
| `steps`    | 385   | `step_*` and `land*`: five gaits × 33 surfaces, own and third-person |
| `foley`    | 140   | `bodyfall_*`, `bodyslam_*`, `gear_*`, `breathing_*`                  |
| `weapons`  | 523   | every alias the 53 catalogued weapons name                           |
| `impacts`  | 155   | `<impactType>_<surface>`, over the engine's own surface list         |
| `feedback` | 3     | `mp_hit_alert`, and the two the countdown script says                |
|            | 124   | pulled in as `with` layers — mechanical layers, distant-report tails |

A weapon file keeps its aliases in some thirty keys and two embedded tables
(`notetrackSoundMap`, `soundOverrides`), so every word of every key whose name
says _sound_ is read and kept only where the bank has an alias by that name. That
drops `none`, `fire` and the twelve `missileConeSound*` numbers without a list of
keys to maintain per game. Those same tables are what `viewmodel.weapon_sounds`
carries into a weapon's `WeaponDef` — the alias per role, and which notetracks
are sounds — because a weapon's sounds cannot be spelled from its id: `m4_mp` and
`iw5_m4_mp` are both `weap_m4carbine_*`.

**Impacts are the one group spelled rather than matched.** `bullet_*` is 375
aliases and most are for surfaces no collision triangle can answer (`bottle`,
`piano`, `teddybear`), so the roots are each catalogued weapon's `impactType`
crossed with `collision.ENGINE_SURFACES` and kept where the bank has a row. The
gaps are real and the engine falls back through them: `bullet_ap` has all 31 IW
surfaces, `bullet_small` 30 (no `snow`), `bullet_large` 29 (no `snow`, no
`water`), and `shotgun` — which six of MW3's guns name — has **none at all**.

**`null.wav` is the game's own spelling of silence**, and it is exported rather
than dropped. Half a second at −91 dB, named by 1,532 aliases — every
`step_scrape_*`, every `*_flesh`, `weap_putaway` — and, in four `gear_rattle_*`
rows, mixed _with_ real recordings, where it is a one-in-four chance of no breath.
Dropped as a missing clip that chance would become a certainty of one.

#### Black Ops II's bank

`catalog --dump bo2 --sounds-only` builds `catalog/sounds/t6/mp/` alone, and leaves
every other kind and `index.json` as they are; a full `catalog --dump bo2` builds it
beside the weapons. The counts below are the bank before the weapons. **505 aliases and 203 clips, 20.4 MB of
PCM and FLAC in, 1.5 MB of Opus out**:

| Group      | Roots | What                                                                                    |
| ---------- | ----- | --------------------------------------------------------------------------------------- |
| `steps`    | 411   | `fly_step_*` and `fly_land_*`, under the engine's names too; from mp_carrier's zone     |
| `zombies`  | 24    | a zombie's vocals, swing, gibs, spawn and inert; the round music; a purchase (89 clips) |
| `feedback` | 1     | `mp_hit_alert` (`mpl_hit_alert`); the countdown's two are not in the bank               |
|            | 69    | pulled in as `with` layers                                                              |

`foley` is empty: T6's foley is `fly_gear_*`, which no family names. With the 37
weapons built, `weapons` is 368 roots (175 clips): the weapon files' fire and
dry-fire aliases, the silencers' from their attachment uniques, and every
`sndnt#<alias>` notetrack the built clips carry (`sound.notetrack_roots`, since a
T6 weapon file names no reload sound); `impacts` is 93. 444 of the 467 aliases the
weapons name resolve; the rest are `*_futz` notetracks and a few fire layers the bank lacks.

**It takes two unions, each with the same guard.** The bank is `common_mp.ff`'s
`mpl_common.all` (2,144 aliases). The footsteps and landings are in every map zone
and not in it, so `dump_sound` takes the first map zone that has them (mp_carrier,
3,194 aliases); one name is in both and **differs** (`wpn_gren_pickup_plr`), the
bank's copy is kept, and the log says so. The zombies' sounds are in no companion:
`common_zm.ff`'s bank has no aliases at all, and TranZit's are in
`so_zclassic_zm_transit.ff`. So `dump_zombie_sound` dumps the first zombies map's
zones (the map and the `common` maps.json names for it), and `build_sounds` takes
from them only `CATALOG_FAMILIES["zombies"]` and what those layer in (25 aliases,
no overlap).

**Black Ops takes the same route**, with the same names: `catalog --dump bo1
--sounds-only` finds zombie_theater's zones (the map, `common_zombie.ff` and its
English zone) and adds 18 aliases and 70 clips to `catalog/sounds/t5/mp/` (1,153
aliases, 663 clips in all; nothing already there changed). Its difference is where
the recordings are: BO1's zombie PCM is in those zones' `soundbank`
(`zmb_common.all`), not in the `.iwd`s, so `build_sounds` searches the zombies
dump's `sound/` for clips after the bank's and the map's. BO1 has no `_loud`
vocals, `zmb_cha_ching_loud`, or inert sounds; everything the engine plays is in
both.

### Actors

The creatures a script spawns — a zombie, later a dog — are a kind of their own,
`actors`, built by their own command because they come from different zones than
anything else here:

```sh
python3 -m scripts.cod actors                          # both games, into worlds/catalog/
python3 -m scripts.cod actors --game bo2               # Black Ops II's only (bo1: Black Ops')
python3 -m scripts.cod actors --worlds <root> --no-dump  # into <root>/catalog/, from dumps already made
```

Black Ops' dumps go into `.cache/cod/actors-bo1/` (`--work`, with `--game`), and it skips a zone and kind it
has already dumped there: `common_zombie.ff` for every clip, the map zone for the
models, both zones' `_patch` copies for the scripts — which load after their base
and replace its scripts, so they are dumped after it — and the map's companions
for images and materials: about 35 s and 560 MB. `actors.ACTORS` is the list of
rows it builds; today one:

```
catalog/actors/t5/zombie_ger/     zombie_ger.json, zombie_ger.hitboxes.json,
                                  c_ger_honorguard_body{1,2}.glb, c_ger_zombie_head{1..4}.glb
catalog/animations/t5/zombie/     zombie.json, animations.glb (skeleton only, 51 clips, 5 MB)
```

**Who a creature is comes out of the game's AI scripts**, not out of names:
`aitype/<name>.gsc` → `character/<name>.gsc` → two `xmodelalias/` lists
([reference.md](reference.md#ai-bodies-black-ops-zombies)). A repeat in a list is
a weight, so the entry keeps each model once and says how often the game picks it.
Every body and every head is exported, not every pairing: each body carries the
union of the four heads' joints (`characters.graft_head`), and the runtime picks a
body and a head per actor from its seed, exactly as a player's head is rebound by
joint name. Nothing else is grafted — a zombie holds no weapon and has no hands.

An actor entry (`version` 1):

| Key                          | Meaning                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `kind`                       | What a script spawns it as (`zombie`)                                                             |
| `bodies`, `heads`            | GLBs in the entry's folder                                                                        |
| `bodyWeights`, `headWeights` | How often each is picked, parallel to the list; absent means uniform                              |
| `animations`                 | The clip set, `animations/<game>/<id>/`                                                           |
| `roles`                      | Optional: the roles this actor's map plays differently, replacing the clip set's whole list       |
| `hitboxes`                   | `hitboxes.py`'s file, the union over every body and head                                          |
| `health`, `size`             | The aitype's own health and its `QUAKED` box as `radius` and `height` in metres                   |
| `source`, `gibs`             | Where it came from; the dismemberment models the character names, by field (listed, not exported) |

**The clip set's role table is the game's own table**, read out of
`_zombiemode.gsc`'s `level.scr_anim["zombie"]` and `level._zombie_*["zombie"]`
arrays (`actors.ZOMBIE_CLIP_ROLES` says which array each role is). A role is a
list of every variant the game picks among, in its order, repeats kept:
`sprint` is `sprint1..3`, which are `v1 v2 v1`. A map's own script can replace a
variant — theater's `anim_override_func` makes `walk7` the goose step,
`ai_zombie_walk_v8` — and that goes on the actor as `roles`, so the clip set stays
the one every zombies map shares. The clip file carries both.

`<id>.json` for a clip set is a soldier's (`id`, `game`, `animType` = the id,
`clips`, `joints`) with `actor: true`, `version`, `roles` as lists, `onceRoles`
(the roles that play once and hold) and a `clipTable`: per clip `duration`,
`frames`, `fps`, `looped`, `notes` (`[name, seconds]`; the melee hit is `fire`)
and `rootMotion`. **A zombie's speed is its clip's**: CoD moves an AI by its
animation's root motion, so `rootMotion` gives the delta track over one cycle in
the actor's own frame (`forward`, `left`, `up` in metres, `yaw` in degrees) and
its ground `speed` in m/s, which is what a runtime divides a movement speed by to
scrub the cycle. It is not played: the clip file's bones are in place, and
`j_mainroot` keeps only its bob (under 14 in of sway against a 155 in stride).

**A traversal clip is a path, not a cycle.** `traversals` maps the animscript a
nav link names to the clip a standing zombie plays for it, read out of that
script's own `jump_down_zombie()` (`animscripts/traverse/zombie_jump_*.gsc`,
`actors.read_traversals`), and each of those clips also carries `rootPath`: its
delta track key by key, `[seconds, forward, left, up]` in metres from its start,
which the runtime moves the body along. Seven are theater's: 40, 72, 120, 127,
190, 240 and 286 (the number is the drop in inches, and the path drops that far).
The last three are in the map's zone rather than `common_zombie.ff`, so the stage
dumps each map's clips too; a script whose clip no dumped zone holds (pentagon's
184 and 222) is said and left out.

**Black Ops II** is `--game bo2` (both games when `--game` is left out), built by
`t6/actors.py` into `.cache/cod/actors-bo2/` from one mode zone,
`so_zclassic_zm_transit.ff`, plus the traverse scripts in `zm_transit_patch.ff`:
about 11 s and 70 MB.

```
catalog/actors/t6/zm_transit_basic/  zm_transit_basic.json, zm_transit_basic.hitboxes.json,
                                     c_zom_zombie{1,2,3}_body0N.glb (10), c_zom_zombie_head_{k,l,n,a}.glb
catalog/animations/t6/zombie/        zombie.json, animations.glb (skeleton only, 78 clips, 9 MB)
```

Two things differ from BO1's ([reference.md](reference.md#black-ops-ii-tranzits-walkers)):
one entry holds **every body TranZit's three spawners dress**, weighted as the game
picks a spawner and then a character, read from the compiled scripts by
`t6/gsc.py`; and **the role table is the AI's animation state machine**,
`animstatedefs/zm_transit_basic.asd`, a text rawfile (`t6/actors.ROLES` names a
state, or a state and an alias, per role). A traversal's clip is the
`zm_traverse` alias its traverse script hands `dosimpletraverse`. The set also
carries `superSprint` and a legless zombie's `crawl*` roles, which nothing plays
yet. The entry has no `health` or `size`: both are numbers in the aitype's bytecode.

**The dog** is the next row: aitype `zombie_dog` (in `common_zombie.ff`),
character `character_sp_zombie_dog` → `setModel("zombie_wolf")` (in the map zone,
no head, which the readers already handle), and a `dog` clip set whose role table
is `animscripts/zombie_dog_init.gsc`'s `zombie_dog_*` clips — that one is local
variables rather than `level` arrays, so its roles will be `%name` literals.
**The crawler** is the same honor guard on the `crawl*` roles `_zombiemode.gsc`
already assigns (`scr_anim.crawl1..6`, `_zombie_melee_crawl`), which is rows in
`ZOMBIE_CLIP_ROLES` and nothing else.

## World file and overrides

`worldfile.write_world_file` composes `world.world` from the map's worldspawn
(sun direction, colour and intensity, ambient) and its `.vision` film grading,
picks a spawn (a team start beats a plain spawn), and includes, when stages 7,
11, 6, 12 and 13 wrote them, `props.world`, `gameplay.world`, `volumes.world`,
`minimap.world`, `mantle.world`, `ladder.world`, `navigation.world`, `fx.world`
and `sound.world`, in that order.
`worldfile.ensure_include` keeps the same order -- anchored on the `collision`
node when no earlier include is there, as on a world with no props -- and `worldfile.drop_include` is
its inverse — what retired the two cast fragments from the 42 worlds that had
them.

The single `spawn` it writes stays the world's **fallback** — the one every
world has, and the one a world with no `gameplay.world` uses. The qualified
spawns live in `gameplay.world` beside it.

### Overrides

Everything above is regenerated on every export. Hand tuning goes in
`worlds/<slug>/_overrides.json`, which is re-applied each time and leaves a
comment saying what it replaced:

```json
{
  "world": { "sky": "#c3ccd8", "visibility": 400 },
  "grade": { "desaturation": 0.25, "gamma": 0.8 },
  "shell": { "lightmap-intensity": 0.25 },
  "decals": { "decal": false },
  "sun": { "intensity": 1.2, "color": "#ffeecc", "shadows": false },
  "fill": { "intensity": 0.2 },
  "spawn": { "at": "12 3 -40", "look": "12 3 -30" },
  "viewmodel": { "weapon": "iw5_acr_mp", "hands": "viewhands_op_force" },
  "characters": { "bodies": ["mp_body_delta_elite_smg_a", "mp_body_russian_military_lmg_a"] },
  "append": ["light lamp { type: point, at: 4 3 -12, intensity: 2 }"]
}
```

Unknown sections or properties are errors, so a typo never silently does
nothing. `append` lines are copied verbatim; `pnpm check` validates them.
`sky`, `visibility` and `exposure` are this engine's, not the game's, so they
are the usual things to tune; the lightmap intensity must match between `shell`
and `decals`. `viewmodel` takes the game's names (a weapon asset, a view-hands
model), not DSL values: it chooses what stage 8 names and packs, and `characters` the
same for stage 9 — `bodies` names the `mp_body_*` models to dress, and an
optional `heads` of the same length picks each one's head instead of inferring
it by name. A body the zone does not ship is an error, not a silent substitution.

## What a world looks like

```
worlds/hardhat-mw3/
  world.world        generated: lighting, grading, spawn, shell, decals, collision
  props.world        generated: every prop asset and placement
  gameplay.world     generated: spawn points, radius triggers, points and removable solids
  volumes.world      generated: brush-volume triggers and zones, a box per brush (clipmap)
  minimap.world      generated: where the HUD map's image lies
  mantle.world       generated: where a player can mantle (clipmap)
  ladder.world       generated: where a player can climb a ladder (clipmap)
  navigation.world   generated: names assets/nav.bin, the map's path nodes for bots
  fx.world           generated: which effects play where
  export_metadata.json  generated: spawns, objectives, minimap frame, fx, script settings, every entity
  _overrides.json    hand tuning (optional)
  _shots.json        camera poses for scripts/shots.mjs (optional)
  assets/            gitignored: world.glb, decals.glb, collision.glb, nav.bin, props/, viewmodel/, characters/, lightmap.png, loadscreen.jpg, minimap.png
```

Only `assets/` is shipped by `pnpm build`.

## Checking a change to the pipeline

- **Compare an export.** Export the same map before and after into a scratch
  worlds root (never over `worlds/`), then prove the second holds everything the
  first does with `equiv` ([below](#proving-an-export-equivalent)). A refactor
  should also reproduce every file byte for byte; a change of dumper need not.
- **Screenshot it.** `pnpm shots worlds/<slug>/_shots.json --out before`, change,
  re-export, then `--out after --compare before`. Poses are captured in-app
  with `P` and must carry `hold`.
- **Use a fresh browser** when judging a rendering change. A long-lived dev tab
  has shown artefacts that were not in the assets.

## Proving an export equivalent

`equiv` compares two exports for **effective identity**: nothing the golden one
holds may be missing from the candidate or mean something else there. Order,
formatting, float noise under tolerance, buffer layout and generator stamps do
not count.

**The golden baseline** is `.cache/cod/golden/` (gitignored, read-only): every
world, five dump trees and every catalogue as OpenAssetTools' patched Unlinker
exported them, with `PROVENANCE.json` saying how. It is the reference a backend
change is proven against, and the only place OpenAssetTools' output still
appears; where it differs from what a backend writes is below.

```sh
python3 -m scripts.cod export mp_dome --worlds <scratch> --work <scratch>/work/dome-mw3 --keep-work
python3 -m scripts.cod equiv worlds .cache/cod/golden/worlds/dome-mw3 <scratch>/dome-mw3
python3 -m scripts.cod equiv dump .cache/cod/golden/work/dome-mw3 <scratch>/work/dome-mw3
```

`--worlds` writes a `maps.json` map under another worlds root, and the cast
harvest lands in that root's `catalog/`, so `worlds/` is untouched. Either
command takes a single world, a folder of them, a catalogue or a dump tree: it
walks the golden tree, pairs files by path (an image by its name, so an `.iwi`
pairs with a `.dds`), and prints per file what is **MISSING** and what
**DIFFERS** (both fail, exit 1) and what is **EXTRA** (reported, allowed), each
named by its record. `--json` writes every finding; `--only <glob>` narrows it.
Copy the golden world's `_overrides.json`, where it has one, into the scratch
world first, so that the export applies the same hand tuning.

**What a backend writes that the baseline does not** is reported, and is
expected:

- **The navigation files are EXTRA** (`assets/nav.bin`, `navigation.world` and
  its include in `world.world`): the baseline predates [navigation](#navigation).
- **Game-mode objects are EXTRA**: each GLB's `parts` list, `solid` lines and
  every `mode:`. A part's triangles are compared as the group they were split
  from ([reference.md](reference.md#game-mode-objects)), so moving one is not a
  loss and dropping one is.
- **Companion zones' 24-bit images are EXTRA in a dump tree**, written as DDS
  ([Images](#images)): two on MW2, forty on Black Ops. The baseline has none.
- **Black Ops' `sw4` DIFFERS** in the worlds whose view arms have a watch
  ([games](games.md#black-ops-t5)): the baseline draws a 1×1 placeholder where
  the archive holds a 16×16 image (four textures on mp_nuked).
- **Comma-named surfaces are filled** ([comma-named surfaces](#comma-named-surfaces)): the
  baseline wrote such a LOD empty, so its dump DIFFERS there. mp_nola places a
  flag the baseline skipped, and four MW2 worlds gain a sixth pair of view hands.

| File                               | Compared as                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.world`                           | a multiset of nodes: type, name, enclosing groups and properties, units normalised. Each file on its own; an `include` is a record of the file holding it |
| `export_metadata.json`             | JSON, with every entity index (`id`, `targetnames`) replaced by the entity's `classname@origin`                                                           |
| other JSON                         | parsed values; collections matched by identity key, index spaces in order (`equiv.JSON_RULES`)                                                            |
| `.glb`                             | materials (params, textures by pixels), a world-space triangle multiset per node and material, named nodes, skins, animations sampled at every key        |
| images                             | decoded pixels: exact, or for JPEG a mean difference of at most 1 and a maximum of 32 out of 255; a DDS by its texels first                               |
| `.wav` and other RIFF              | PCM, or the `fmt`, `data` and `dpds` chunks, read to the end of the file whatever the RIFF size says (the baseline's say 36, which `wave` believes)       |
| `.webm`                            | decoded through ffmpeg: the same length and an SNR of at least 40 dB                                                                                      |
| GfxWorld manifest and blobs        | surfaces in order, each surface's triangles as a multiset of decoded 44-byte vertices                                                                     |
| clipmap manifest and blobs         | soup triangles in order as positions; the other blobs byte for byte, the edge-walkable bits only as far as the zone's array goes (below)                  |
| xanim, weapon infostrings, `.ents` | decoded clip (tracks by bone, the delta track's bytes); key/value records; entities as a collection                                                       |
| scripts and other text             | lines, line endings ignored                                                                                                                               |

**Tolerances:** 1e-4 m for positions and matrices, 1e-3° for world-file angles, a
world-file number printed with the same decimals on both sides also within one
unit of the last (float noise that flips a rounding is not a change), 1e-3 for unit vectors, colours and
weights, 1e-4 for UVs, and JSON numbers within 1e-4 or 1e-6 relative. A GLB
node's world matrix and a joint's inverse bind matrix are also allowed 1e-6 of
their largest value in every component, because a float32 bone thousands of units
out carries that noise into all of them: on mp_estate's powerline wires, the baseline's
float32 `-Rᵀt` is 2e-4 from the exact value where the Python backend's is 7e-9.
Integers (flags, counts, indices) are exact.

**The edge-walkable blob is compared on its meaningful length.** The zone's
`triEdgeIsWalkable` is a bit per triangle edge in whole 4-byte words,
`(3 × triCount + 31) / 32 × 4` bytes. The baseline's IW4, IW5 and T5 blobs are
`triCount` bytes instead, so the blob runs on into whatever follows the array
(on mp_dome, 11,358 bytes of `borders`). Nothing downstream reads the file.

**What stays in order** is what something else points into by index: a
GfxWorld's surfaces and models, a clipmap's brushes, materials, partitions and
AABB trees, an effect's elements and curves. A collision group's brush ranges
are dereferenced instead: each triangle carries its brush's materials. Unnamed
records are matched by whole content, so a changed one is reported as MISSING
plus EXTRA rather than DIFFERS.

**Memory is bounded by design.** A vertex stays in the file's own arrays and
becomes a tuple only to be hashed, a triangle is one 64-bit digest in a sorted
array, and only triangles with no partner are materialised, at most 20,000 a
side. So a GLB costs about its buffer, however many primitives share it (a
shell's hundred materials index one vertex buffer; `test_equiv.py` holds that
with `tracemalloc`). Measured peaks with `/usr/bin/time -v`: dome-mw3's
`world.glb` (23 MB) 150 MB in 2 s; shipbreaker-mw3's (59 MB, the largest in the
golden tree) 377 MB in 7 s, and the same when every triangle has moved (20 s).
