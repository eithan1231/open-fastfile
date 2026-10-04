# Reading 32-bit zones without OpenAssetTools

## The question

**Can we read IW4 (MW2), IW5 (MW3) and T5 (Black Ops) zones without
OpenAssetTools?**

Why it matters: Ghosts and AW are read by Python (`scripts/cod/iw6`,
`scripts/cod/s1`), and a Python reader for the 32-bit games lets every game's
fx, sound, destructibles and PathData be added in Python, with no C++ tool in
the pipeline. The readers are `scripts/cod/iw4`, `scripts/cod/iw5` and
`scripts/cod/t5`.

**Answer: yes, and without a hand-written walker per game.** Everything OAT
knows about loading these zones lives in two kinds of data that can be read
without running OAT:

- the structs, in `src/Common/Game/<G>/<G>_Assets.h`;
- how to load them, in the ZoneCode command files
  (`src/ZoneCode/Game/<G>/<G>_Commands.txt` and `XAssets/*.txt`).

OAT's ZoneCodeGenerator (ZCG) turns those into C++. Here they are turned into
two JSON files per game instead:

- `out/<g>/layout.json`: offsets, sizes and alignments;
- `scripts/cod/data/<g>/zonecode.json`: a load program for every struct, the one
  the importer reads.

Both are proven against ZCG's own output:

- **Every struct-test `REQUIRE` agrees, in all three games**:
  - IW4: 2562 of 2562;
  - IW5: 3048 of 3048;
  - T5: 2991 of 2991.
- **Every generated loader is reproduced exactly from the JSON**, all 107 of
  them. Rendered back to C++, they are identical to OAT's `*_load_db.cpp`:
  - IW4: 35 loaders, 280 functions;
  - IW5: 40 loaders, 325 functions;
  - T5: 32 loaders, 286 functions.

A table-driven walker that interprets `zonecode.json` is therefore ZCG's loader,
one level removed. `scripts/cod/zonecode/` is that walker, and it walks **every
zone the pipeline reads, in all three games, exactly**: to the last byte, with
every block's high-water mark the size its XFile header states ([The
walk](#the-walk)).

## Sources, in order of trust

1. **OpenAssetTools**, a **read-only struct reference**: a checkout at `$OAT`
   (at `f0513c41` when this was checked). The tools
   here read these files, never run OAT's Unlinker, never write to the checkout
   and copy none of its text into this repository:
   - the headers and command files above;
   - `src/ZoneCodeGeneratorLib/`, whose rules `layout/oat.py` ports;
   - ZCG's generated output in `build/src/ZoneCode/Game/<G>/XAssets/*/`:
     `*_struct_test.cpp` and `*_load_db.cpp`. **These are the ground truth for
     every check here**;
   - `src/ZoneLoading/`: the zone loaders, the stream and the per-game actions.
2. **The retail fastfiles' headers**, read with `header.py`. They
   confirm the container facts.
3. **The host g++ in `-m32` mode**, for the compiled layouts.

## Findings

### The container (read from `src/ZoneLoading/Game/<G>/ZoneLoaderFactory<G>.cpp`; checked on retail files)

| Game | Magic      | Version     | After the 12-byte header                                   | Where zlib starts                                                               |
| ---- | ---------- | ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| IW5  | `IWff0100` | 1           | 1 byte (ignored), 8-byte timestamp, auth header `IWffs100` | 21 + 0x2000 + 0x2000: past the auth chunk and the first master block, as on IW6 |
| IW4  | `IWff0100` | 0x114 (276) | the same                                                   | the same                                                                        |
| IW5  | `IWffu100` | 1           | 1 byte, 8-byte timestamp; no auth header                   | 21 (MW3's `so_survival_mp_*.ff` are these)                                      |
| T5   | `IWffu100` | 0x1D9 (473) | nothing: no byte, no timestamp                             | 12                                                                              |

- **The signed layout** (`IWffs100`):
  - The auth header (`DB_AuthHeader`, 0x1FD0 bytes) sits at offset 21. It holds
    the magic, a reserved word, the subheader hash, a 256-byte RSA signature, the
    fastfile name, and 244 master-block hashes.
  - It is padded to one 0x2000 chunk.
  - Then come groups of one master block (256 SHA-256 hashes, one per data
    chunk) and up to 256 data chunks of 0x2000.
  - The data chunks, concatenated, are one zlib stream (`ProcessorAuthedBlocks`).
- **The unsigned layout**: the zlib stream simply follows the header.
- **What the stream holds**, in order:
  - `u32 size`, then `u32 externalSize`;
  - `u32 blockSize[n]`, one per block;
  - then the zone: `XAssetList { ScriptStringList {count, strings}, assetCount, assets }`,
    read raw, 16 bytes.
- **Checked on retail files** (`mp_dome`, `so_survival_mp_dome`, `mp_rust`,
  `mp_nuked`):
  - each magic and version is as in the table;
  - each stream inflates at the offset given;
  - each has exactly the block count below, followed by the script-string
    count.
- **Checked on every zone the pipeline reads** (`inflateall.py`, 92 zones:
  every MW2, MW3 and BO1 map in `maps.json`, the companion zones, the sound
  zones and MW3's 22 `so_survival_mp_*.ff`). `scripts/cod/fastfile.py` inflates
  each one, and all 92 pass:
  - Every signed chunk matches its master chunk's hash, and every master chunk
    matches the auth header's hash (46 signed zones).
  - Every zone is exactly its XFile header plus the `size` that header states.
    The header is 40 bytes on IW4, 44 on IW5 and 36 on T5: `size`,
    `externalSize`, then one `u32` per block.
  - The zlib stream ends inside the last chunk. The rest of that chunk is
    padding: 507 bytes on `mp_dome`, 5,452 on `mp_rust`.
- **Unsigned zones are not only Survival's.** Each of these is `IWffu100`, with
  zlib at 21:
  - MW2's `common.ff` (version 0x114);
  - MW3's `common.ff` and `so_deltacamp.ff` (version 1).
- **No retail signed file ends on a short chunk.** Every one is a whole number of
  0x2000 chunks after offset 21. So `fastfile.py` hashes a short last chunk as it
  is, as `ProcessorAuthedBlocks` does, but no retail file tests that.

### Blocks (the `block` lines of each `<G>_Commands.txt`, and `SetupBlock` in each factory)

| Index | IW4          | IW5          | T5                         |
| ----: | ------------ | ------------ | -------------------------- |
|     0 | TEMP (temp)  | TEMP (temp)  | TEMP (temp)                |
|     1 | PHYSICAL     | PHYSICAL     | RUNTIME (runtime)          |
|     2 | RUNTIME (rt) | RUNTIME (rt) | LARGE_RUNTIME (runtime)    |
|     3 | VIRTUAL      | VIRTUAL      | PHYSICAL_RUNTIME (runtime) |
|     4 | LARGE        | LARGE        | VIRTUAL                    |
|     5 | CALLBACK     | CALLBACK     | LARGE                      |
|     6 | VERTEX       | VERTEX       | PHYSICAL                   |
|     7 | INDEX        | INDEX        |                            |
|     8 |              | SCRIPT       |                            |

- **Unmarked blocks are "normal"**: their bytes come from the file.
- **A runtime block reads nothing.** Its bytes are zero-filled, but its cursor
  still advances (`LoadDataFromBlock`).
- **The defaults**: TEMP (temp), RUNTIME (runtime) and VIRTUAL (normal).
  - Every asset header is loaded into TEMP.
  - Every asset's members are loaded into VIRTUAL.
  - VIRTUAL is also where inserted pointers go (`INSERT_BLOCK`).
- **T5's order differs from IW6's.** Its VIRTUAL block is 4, not 3.

### Pointers in a 32-bit zone (`ZoneInputStream.cpp`, `ContentLoaderBase.cpp`)

| Value        | Meaning                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0            | null                                                                                                                                                      |
| `0xFFFFFFFF` | FOLLOWING: the data comes next in the stream                                                                                                              |
| `0xFFFFFFFE` | INSERT: the data follows, and a 4-byte pointer slot is reserved first in VIRTUAL (aligned to 4, no file bytes). Only honoured where the member is in TEMP |
| other `v`    | OFFSET: earlier data. `v - 1` splits into block and offset (below)                                                                                        |

- **How an offset splits** (`blockBitCount` in each factory's
  `CreateStepLoadZoneContent`):
  - IW4 and IW5 (`OFFSET_BLOCK_BIT_COUNT` = 4): the block is
    `(v - 1) >> 28` and the offset is `(v - 1) & 0x0FFFFFFF`.
  - T5 (3 bits): the block is `(v - 1) >> 29` and the offset is
    `(v - 1) & 0x1FFFFFFF`.
- **An offset resolves one of two ways.**
  - A pointer resolves to that address (`ConvertOffsetToPointerNative`).
  - An _alias_, used for members in TEMP and for asset handles, resolves to the
    pointer stored _at_ that address (`ConvertOffsetToAliasNative`), as on IW6.
- **Strings** (`LoadXString`) handle FOLLOWING and OFFSET only.
  - A FOLLOWING string is allocated with alignment 1 in the current block and
    read up to and including its NUL.
- **Allocation moves only the destination block's cursor, never the file
  position.** `Alloc(align)` aligns the cursor, and a `Load` of n bytes reads n
  bytes (or zero-fills them) and advances it.
- **TEMP is rewound on pop.** Pushing TEMP saves its cursor, and popping it
  restores the cursor.
- **The importer's zone core reads these rules as data.** Each game's blocks,
  runtime blocks, block bits and header are a `ZoneSpec` in
  `scripts/cod/zone/spec.py`. `scripts/cod/tests/test_zone_core.py` checks each
  split, the runtime blocks, the TEMP rewind and the 4-byte insert slots.

### Struct layouts (`out/<g>/layout.json`)

| Game | Structs laid out | Members | Struct-test checks | Checks against ZCG's own layout |
| ---- | ---------------: | ------: | ------------------ | ------------------------------- |
| IW4  |              293 |    2155 | 2562 / 2562        | 2712 / 2712 rows                |
| IW5  |              330 |    2593 | 3048 / 3048        | 3228 / 3228 rows                |
| T5   |              300 |    2526 | 2991 / 2991        | 3111 / 3111 rows                |

- **The schema** is IW6's:
  `[type, member, offset, size, elem, pointee, kind, e0, e1, base]`, plus an
  eleventh column holding `alignof` (the member's type, or the struct's on its
  size row). `reverse/iw6-zone/layout/gen.py` writes the program.
  - The alignment column is opt-in.
  - Without it, IW6's and S1's `layout.json` are byte-identical to before.
- **The compile flags** are OAT's own x86 flags:
  `-m32 -std=c++23 -DARCH_x86` (`build/src/*/Makefile`).
  - OAT marks every 8-byte member that i386 would align to 4 with
    `gcc_align32(8)`. That is why g++'s layout equals MSVC's.
  - No `-malign-double` is needed, and no member had to be dropped.
- **What layout.json does not have:**
  - bit-fields: C++ gives them no offset;
  - anonymous types: they have no name for a size row. Their members appear
    under the struct holding them, dotted when the member has a name (`u.x`).

  zonecode.json has both.

- **Allocation alignment is not `alignof`.** Under g++, OAT's `tdef_align`
  typedef alignment expands to nothing, but ZCG honours it when it allocates.
  - For example, `cbrush_array_t` is `alignas(128) cbrush_t`: g++ gives it
    alignment 16, while the loader allocates it at 128.
  - IW5 has nine such typedefs, including `raw_byte16`, `BoundsArray`,
    `GfxCellTree128` and `XSurfaceTri16`.
  - **Every allocation alignment must come from zonecode.json, never from
    layout.json.**

### The load program (`scripts/cod/data/<g>/zonecode.json`)

`layout/oat.py` reads the header and the command files by ZCG's rules; each
function cites the ZCG file it ports.

- The header is preprocessed by g++ with `-D__zonecodegenerator`, as ZCG's
  preprocessor sees it.
- Parsing, sizes, the commands and the post-processors follow ZCG:
  - usages;
  - leaves;
  - member leaves;
  - union ordering, where the one member without a condition goes last.

`layout/zonecode.py` then makes ZoneLoadTemplate's decisions and writes them as
data. Only the native path is modelled; ZCG's "fill" code is for loading
32-bit zones on a 64-bit host.

**Schema.** An _expression_ is one of:

- a plain integer;
- `{int}`;
- `{enum, value}`;
- `{op, a, b}`, where `op` is a C operator, or `ptrdiff` for a pointer
  difference in elements of size `elem`. A static expression also carries its
  `value`;
- a field read: `{var, struct, path: [{member, deref}], index: [expr], is, ...}`.
  - It is read from the **current instance of `var`**: the one the loader is
    loading, or last loaded, as a `var<Struct>` in OAT's generated code.
  - It follows `path`, dereferencing a step whose member is a pointer.
  - `index` then indexes the last step.
  - `is` is one of `scalar` (with `size`/`signed`/`float`), `pointer`,
    `array`, `struct` or `address` (an empty path: the instance's own
    address).

The top-level keys:

- `blocks`: `[{name, index, type: temp|runtime|normal, default}]`.
- `asset_types`: XAssetType, and what `ContentLoader<G>.cpp` does with each.
  - Each entry is `{index, enum, listed}` plus one of the below. `listed` is
    the type's name in a `.zone` listing (`Game<G>.cpp`'s `ASSET_TYPE_NAMES`).
    - `struct, header_member`: the struct it loads;
    - `skip`: it loads nothing (`SNDDRIVER_GLOBALS`);
    - `unsupported`: OAT throws, so no retail zone holds it.
- `assets`: one entry per asset loader (see below).
- `enums`: the enum values.
- `typedefs`: each typedef's mods, size and ZCG alignment.
- `structs[fullName]`: every struct and union.

Each `structs` entry holds:

- `kind`, `size`, `align`, `alloc_align`, `asset`, `block`, `action`, `leaf`,
  `dynamic_member`;
- `members`, in ZCG's load order, with reorders and union order applied. Each
  member has:
  - `offset`, `size`, `align`;
  - `type`, `type_kind`, `struct`, `const`, `bits`;
  - `mods`: outermost first, `{ptr, count?, count_by_index?}` or
    `{array, dyn_count?, dyn_size?}`;
  - `scalar` (`{size, signed, float}`) for a scalar with no mods, or `element`
    for an array of, or pointer to, scalars: how to read one;
  - `string`, `scriptstring`, `reusable`, `leaf`, `asset_ref`, `condition`,
    `block`, `alloc_align`, `action`;
- `load`, for the structs a loader reaches:
  `{header: "full" | {partial, member} | "none", push, body}`.

**The load body.** `Load_<S>(atStreamStart)`:

1. If `atStreamStart`, read the header:
   - `full`: `size` bytes;
   - `partial`: up to the dynamic member's offset.
2. Push `push` (VIRTUAL for an asset).
3. Run `body`.
4. Pop.

A `body` holds three kinds of statement:

- **`{if, then}`**: a member with a condition.
- **`{select: [{if, then}]}`**: a union.
  - The first case whose `if` holds runs.
  - An `if` of null is the `else`.
- **`{member, index, kind, push?, null_check?, reuse?, alloc?, insert?, do}`**:
  one member, or one element of a member's embedded array. It runs in this
  order:
  1. Push `push`.
  2. If `null_check` is set and the slot is 0, stop.
  3. If `reuse` is set, read the pointer type:
     - `FOLLOWING`, or `INSERT` when `reuse.temp` is set: go on to step 4;
     - anything else: resolve the offset (an alias when `reuse.temp` is set,
       otherwise a pointer), and stop.
  4. If `alloc` is set, align the cursor to `alloc`.
  5. If `insert` is set and the pointer is INSERT, reserve a slot in VIRTUAL.
  6. Run `do`.
  7. Fill the reserved slot.
  8. Pop.

`kind` is one of `embedded`, `embedded_array`, `dynamic_array`,
`single_pointer`, `array_pointer` or `pointer_array`. `do` is one of:

| `do`                                     | What it does                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{string}`                               | an XString at the slot                                                                                                                                                                                              |
| `{strings, at_start}`                    | an array of XStrings. With `at_start`, first read `strings` pointers                                                                                                                                                |
| `{asset}`                                | a nested asset handle: that asset's `entry`                                                                                                                                                                         |
| `{ptr_array, count, at_start}`           | an array of pointers. With `at_start`, read `count` pointers. Then, per non-null element, run the asset `entry`, or reuse (per the loader's `ptr_arrays[].reusable`), `Alloc(align)`, and a `load` or a raw element |
| `{load_array, count, at_start, actions}` | `count` elements. With `at_start`, read them all first. Then each element's `load` with `atStreamStart` false                                                                                                       |
| `{load, at_start, actions}`              | `Load_<struct>`                                                                                                                                                                                                     |
| `{raw: count}`                           | `count` elements of the member's element type, read into the current block                                                                                                                                          |
| `null`                                   | nothing                                                                                                                                                                                                             |

**Per asset**, `assets[]` gives:

- `entry` (`LoadPtr_<asset>`): push TEMP if `temp`. If the handle is FOLLOWING
  or INSERT:
  1. Allocate at `align`.
  2. Reserve the insert slot.
  3. Run `Load_<asset>(true)`.
  4. Run `action`.
  5. Register the asset.
  6. Fill the slot.

  Anything else is an alias.

- `ptr_arrays`, `arrays`, `loads` and `referenced_assets`: the struct and
  helper set of that asset's generated loader.

- `asset_name`: how OAT names one (`<G>.h`'s `DEFINE_ASSET_NAME_ACCESSOR`):
  `{member}`, a member path such as `info.name`, or `{singleton}`, a fixed name.

The content loader wraps all of it:

1. Read `XAssetList` raw. (The game loads it into TEMP, where it stays; see
   [The walk](#the-walk).)
2. Push VIRTUAL.
3. Read the script strings: FOLLOWING. Allocate at 4, read `count` pointers,
   then each is an XString.
4. Read the asset array: FOLLOWING. Allocate at 4, read `assetCount` × 8
   bytes of `{type, pointer}`.
5. For each asset, run its type's `entry` on the pointer inside that array.

### Custom actions (`src/ZoneLoading/Game/<G>/XAssets/*/*_actions.cpp`; A3 writes these by hand)

All of them are memory management for OAT's in-process copy. None reads the
stream, so none changes the walk. What a walker must copy is noted.

| Action                                      | Games        | Called                                                 | What it does, and what a walker keeps                                                                                                           |
| ------------------------------------------- | ------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `OnImageLoaded(GfxImage)`                   | IW4, IW5, T5 | asset action, after `Load_GfxImage`                    | Zeroes a runtime field: `cardMemory.platform[0]` (IW4/IW5), `loadedSize` (T5). Nothing to keep                                                  |
| `LoadImageData(GfxImageLoadDef, GfxImage)`  | IW4, IW5, T5 | after `GfxTexture.loadDef` is loaded, which is in TEMP | Copies the loadDef, its header plus `resourceSize` bytes of `data`, out of TEMP before it is rewound. **Keep those bytes: they are the pixels** |
| `SetSoundData(MssSound)`                    | IW4, IW5     | after `LoadedSound.sound`                              | Copies `data` (`info.data_len` bytes, loaded in TEMP) out, or nulls it when the length is 0. **Keep the bytes**                                 |
| `ReallocClipInfo(ClipInfo, clipMap_t)`      | IW5          | after `clipMap_t.pInfo`, which is in TEMP and reusable | Copies the `ClipInfo` header out of TEMP into `pInfo`. **Keep the struct**; the arrays it points to are in VIRTUAL                              |
| `SetModelSurfs(XModelLodInfo, XModelSurfs)` | IW4          | after `XModelLodInfo.modelSurfs`, which is in TEMP     | Copies the `XModelSurfs` header out of TEMP. **Keep it.** IW5 has the action but does not use it: there `modelSurfs` is an asset handle         |

That makes four actions each for IW4 and IW5, and two for T5 (not four as the
plan guessed).

### Asset loaders

- IW4 has 35 asset loaders, IW5 40 and T5 32.
- XAssetType types with no loader:
  - IW4: `XMODEL_SURFS`, `UI_MAP`, `AITYPE`, `MPTYPE`, `CHARACTER`,
    `XMODELALIAS`;
  - IW5: the same minus `XMODEL_SURFS`;
  - T5: `XMODELPIECES`, `UI_MAP`, `WEAPONDEF`, `WEAPON_VARIANT`, `AITYPE`,
    `MPTYPE`, `MPBODY`, `MPHEAD`, `CHARACTER`, `XMODELALIAS`.
- `SNDDRIVER_GLOBALS` is skipped on IW4 and IW5: it is in the list and loads
  nothing.
- T5's `CLIPMAP` and `CLIPMAP_PVS` both load `clipMap_t`.
- T5's `WEAPON` loads `WeaponVariantDef`.
- Every asset header is loaded in TEMP.

### The walk

`scripts/cod/zonecode/` interprets `zonecode.json` over the zone core
(docs/cod/pipeline.md#the-zonecode-walker has its design). `walkall.py` walks
every zone the pipeline reads, one per subprocess, and compares each with the
golden baseline's `.zone` listing where there is one.

| Game | Zones walked                                                                                                                     | Exact | Golden listings compared                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MW3  | 25 maps (with `so_deltacamp`), `common_mp`, `common`, `localized_common_mp`, `localized_code_post_gfx_mp`, 22 `so_survival_mp_*` | 51/51 | 6, all the same multiset, and **byte-identical, order included**: `mp_dome`, `mp_aground_ss`, `common_mp`, `common`, both localized zones |
| MW2  | 16 maps, `common_mp`, `common`, both localized zones                                                                             | 20/20 | 5, all the same multiset                                                                                                                  |
| BO1  | 16 maps, `common_mp`, `common`, `common_zombie`, two `en_zombie_*`                                                               | 21/21 | 4, all the same multiset                                                                                                                  |

"Exact" means the walk ends at the zone's last byte, and every block's high-water
mark is the size the XFile header gives it. No reference in any of them lands
where no allocation starts or holds it (`Walk.loose` is 0 everywhere).

- **Cost.** `mp_dome` (106 MB of zone, 792 XAssets, 6,984 assets) walks in 1.0 s
  at a peak RSS of 224 MB. `common_mp` (102 MB, 5,640 XAssets, 15,077 assets)
  takes 2.3 s at 286 MB. The largest map, `mp_exchange`, peaks at 367 MB.
- **Survival zones alias.** In each of the 22 `so_survival_mp_*`, 154 XAsset
  entries name an asset loaded earlier. `common` has 5 such entries and
  `localized_common_mp` 41; the map zones have none.
- **MW3's PathData is there.** The Survival zones' `pathdata` asset walks, for
  example `so_survival_mp_dome`'s 511 nodes.

**Where the walk departs from OAT's loaders, and why:**

- **The XAssetList is loaded into TEMP.** OAT reads it raw, into no block. In
  every zone of all three games, TEMP's header size was then exactly 16 bytes more
  than OAT's high-water mark. 16 bytes is `sizeof(XAssetList)`: the game loads
  the list into TEMP, the stream's first block, and never pops it, so every
  asset's TEMP use starts 16 bytes in. The walker does the same, so its TEMP
  addresses are the game's.
- **An alias is looked up, not read from memory.** `ConvertOffsetToAlias` reads
  the pointer stored at an address. The walker files what each aliasable slot
  resolved to, when the slot is outside TEMP:
  - the XAsset list's entries;
  - asset handles, including the asset elements of pointer arrays;
  - insert slots;
  - TEMP-reusable members.

  An alias to any other address is an error. None occurs.

- **Actions keep views instead of copies.** OAT copies out of TEMP because it
  reuses TEMP's memory. The walker reads the zone's own bytes, which nothing
  rewinds.
- **A pointer into an array gives an element or a view.** OAT has a raw pointer.
  A single pointer into an earlier array gives the element there, and an array
  pointer gives a view of the array from there, sharing its elements. For
  example, `cbrush_t.sides` points into `ClipInfo.brushsides`, and
  `Walk.span(record, n)` gives its `numsides`. A view shares the elements
  rather than copying them: `mp_roughneck`'s 28,188 brushes all point into one
  array of 78,907 sides.
- **Nothing else differs.** Order, counts, conditions, blocks and alignment all
  come from `zonecode.json`.

**The 64-bit MW3 build cannot be walked, and says so.** The Steam install at
`steamapps/common/Call of Duty Modern Warfare 3` is the 64-bit build
(`steam_api64.dll`).

- Its fastfiles carry IW5's header (`IWff0100`, version 1), so `fastfile.py`
  claims and inflates them.
- But their zones store 8-byte pointers. `mp_dome`'s XAssetList reads `0x201,
0, -1, -1`: a count, then one 64-bit pointer.
- The walker refuses such a list at once.

The pipeline reads the 32-bit depots ([docs/cod/README.md](../../docs/cod/README.md#prerequisites)).

### What the world records hold

`scripts/cod/iw5/dumpers/` writes MW3's GfxWorld, clipMap, MapEnts, RawFile and
ScriptFile records in the [dump tree](../../docs/cod/pipeline.md#the-dump-tree)'s
schema ([pipeline.md](../../docs/cod/pipeline.md#the-zonecode-walker)). Facts the
records showed on the way:

- **`clipMap_t.info` and `*pInfo` are the same ClipInfo.** The embedded one and
  the one `ReallocClipInfo` keeps name the same arrays, and every stock
  `cmodel_t.info` points at `pInfo`.
- **`triEdgeIsWalkable` is `(3 × triCount + 31) / 32 × 4` bytes**, a bit per
  triangle edge (the load program's own count)
  ([how `equiv` reads the baseline's](../../docs/cod/pipeline.md#proving-an-export-equivalent)).
- **Every IW5 rawfile is deflated.** `buffer` is loaded `compressedLen` long and
  there is no other copy; mp_dome's rawfile `mp_dome` is 8 bytes that inflate to
  nothing.
- **`MapEnts.numEntityChars` counts the terminating NUL.**
- **Names keep their leading comma.** A static model the map only references is
  named `,weapon_us_smoke_grenade_burnt` in the GfxWorld, as the zone stores it.
- **A leaf brush node's `data` is loaded as the leaf** when `leafBrushCount > 0`:
  `node["data.leaf.brushes"]` is the brush-index array, a view into
  `ClipInfo.leafbrushes`.

MW2's records are read by the same writers (`scripts/cod/iw4/dumpers/` registers
IW5's), because every member they read has the same name in IW4. What differs,
from the walks of mp_rust and the MW2 zones the pipeline reads:

- **IW4 has no ClipInfo.** Its members sit flat on `clipMap_t`, and `cmodel_t`
  has no `info`. The single-player clipmap is its own asset type over the same
  struct, registered and listed as the MP one, as on T5 (below); no MP zone
  holds one.
- **`CollisionPartition`'s three counts are `char` in IW4's header**, `unsigned
char` in IW5's. Read as declared, mp_rust's partitions of 128 to 192 triangles
  come out negative and collision loses those triangles' materials. The game and
  OAT's writer read them unsigned, and so does the writer here.
- **A rawfile's `data` is a union.** `compressedBuffer` when `compressedLen` is
  set, else `len` plain bytes of `buffer` and a NUL. In mp_rust every non-empty
  rawfile is deflated; the empty one named after the map is plain.
- **`SetModelSurfs` keeps each LOD's `XModelSurfs` header** (it is loaded in
  TEMP), so `lodInfo[i].modelSurfs` is a record rather than an asset. It can
  still be another zone's: mp_rust's flags name `,flag2_lod000` and load no
  surfaces, as mp_nola's do on IW5. `common_mp.ff` holds that header on a model
  of its own (`prop_flag_neutral`), which is where the `xmodel` writer finds it
  ([pipeline](../../docs/cod/pipeline.md#comma-named-surfaces)).
- **The wavelet code tables are iw5mp.exe's, stored in the other order.**
  iw4mp.exe holds the alpha, colour and first-channel lookups back to back;
  `wavelet.find_tables` names each by its escape code's length, so both games'
  are found by shape. MW2's archives hold 26 wavelet images.

Black Ops' records have writers of their own where IW's members do not exist
(`scripts/cod/t5/dumpers/`). What the walks of mp_nuked, zombie_theater and
`common_mp.ff` showed:

- **An asset is registered as its loader's type, not its XAsset entry's.**
  `ASSET_TYPE_CLIPMAP` and `ASSET_TYPE_CLIPMAP_PVS` both load `clipMap_t`, whose
  loader is `AssetClipMapPvs`, so OAT lists either as `clipmap`. The MP zones'
  entries are the PVS type; zombie_theater's is the other, which a listing by
  entry would call `clipmap_unused` (`Program.type_of`). Brush sides and the six axial faces carry `contents` and
  `surfaceFlags` themselves; materials are `char[64]` names inline.
- **A model's surfaces are the model's.** `XModel.surfs` is one array and each
  LOD a `surfIndex`/`numsurfs` slice of it; a bone's position is `offset`, not
  IW5's `bounds` union.
- **A script rawfile is its own container**: `u32` inflated size (its NUL
  counted), `u32` deflated size, then zlib. OAT inflates it in 0x1000-byte chunks
  and drops the last byte of the chunk that reaches the size, so the file is
  written without the NUL; a buffer of 8 bytes or fewer is written empty.
- **Material slot names hash with every byte OR 0x20** (`R_HashString`, OAT's
  `djb2_xor_nocase`), not lower-cased: `_` becomes DEL, so `Color_Map` is
  3053961470 and IW6's `slot_hash` gets it wrong. T5 has no shader assets; the
  constant tables come from the technique sets' passes, and OAT hands its
  analyser `programSize`, a count of DWORDs, as a size in bytes. Only a table in
  the first quarter of a shader is read, and the dump names exactly those.
- **Images are IWI v13**: a 48-byte header (`IWi`, 13, format, a byte of flags --
  `NOMIPMAPS` 2, `CUBEMAP` 4, `VOLMAP` 8 -- three dimensions, a gamma float, eight
  picmip sizes), the formats numbered as v8's. A dozen of the archive IWIs are
  wavelets; `BlackOpsMP.exe` holds the same code tables as `iw5mp.exe`.
- **Clips are version 19**: flag 1 looped, 2 delta, 4 left-hand grip IK, 8
  streamable, which puts a primed length (a float) after the header.
- **A weapon is a `WeaponVariantDef`** over a `WeaponDef`; the variant holds
  `szXAnims` and `hideTags`. OAT's field table reads `coolWhileFiring` and
  `fuelTankWeapon`, two adjacent `bool`s, as `CSPFT_INT`, four bytes each, so
  its infostring carries the bytes after them too. The linker also shares a run
  of zeros: a null `XModel*[16]` (`gunXModel`, `worldModel`) can point into an
  earlier array of another type, and reads back as that array's zero elements.
- **Sound is one `SndBank`**, alias lists and loaded audio together: xWMA
  (format 7, `seek_table` is the `dpds` chunk), MS ADPCM (6, 512 frames a
  block), and PCM (0).
- **`GameWorldMp` holds the path graph** (`PathData`): on mp_nuked 316 nodes
  (296 `NODE_PATHNODE`, 10 each of the two negotiation types), 1,516 links
  (`pathlink_s`: distance, node index, negotiation flag), 316 base nodes,
  12,443 bytes of node visibility and a 227-node k-d tree over the nodes.
  The walk reads all of it; nothing writes it yet.

## How this was reached

- **The line parser failed.** `reverse/iw6-zone/layout/gen.py`'s line parser
  cannot read OAT's headers: `struct type_align32(4) X` heads and ZCG's
  treatment of nested and anonymous records defeat it.
  - Instead, `oat.py` parses the preprocessed header by ZCG's grammar.
  - `gen.py` now exposes `render()`, which writes the program for a member list
    it is handed.
- **Running ZCG was not an option.** ZCG itself could have printed all this,
  but running any OAT binary was ruled out. The port is checked against what
  ZCG already generated instead: two independent checks, each of every row or
  function.
- **Mutation check.** Mutating one allocation alignment in zonecode.json
  (`cbrush_array_t`, 128 → 64) makes `loaddb.py` report exactly that line of
  `Load_ClipInfo`.

## Reproduce

```sh
OAT=<an OpenAssetTools checkout> reverse/x86-zone/build.sh   # iw4 iw5 t5 t6, or: build.sh iw5
```

What the importer reads is written into its tracked data, `scripts/cod/data/<g>/`;
the compiled layout and its program stay in `out/<g>/`. Per game, `build.sh` runs
these steps (`$OAT` names the checkout):

- `layout/layout.sh <g>`: writes `out/<g>/layout.json`.
- `layout/zonecode.py <g>`: writes `scripts/cod/data/<g>/zonecode.json`.
- `layout/check.py <g>`: checks every struct-test `REQUIRE`. It also checks
  that the two layouts agree on every row both have.
- `layout/loaddb.py <g> [struct ...] [--show Function]`: renders the loaders
  and diffs them against `*_load_db.cpp`.
- `layout/infostring.py <g>`: writes `scripts/cod/data/<g>/weapon_fields.json`,
  OAT's weapon infostring field table and its name tables (IW4's are in
  `InfoString/EnumStrings.h`, T5's in `Weapon/WeaponStrings.h`, with T5's flame
  table fields beside them), and for IW5 `scripts/cod/data/iw5/attachment_enums.json`, how
  OAT's attachment JSON spells each enum value. The weapon and attachment
  dumpers read them.
- `layout/materialnames.py` (T5 and T6): writes `scripts/cod/data/<g>/material_names.json`,
  the constant and texture names OAT knows (`MaterialConstantZoneState<G>.cpp`).

What it needs:

- OAT's `build/src/ZoneCode/`: ZoneCodeGenerator's output, which the checkout's
  own build makes (`./generate.sh`, then
  `make -C build config=release_x86 ZoneCode`). It generates C++ from the
  command files and reads no zone. On
  GCC 13, upstream `9dca9653` needs two small source fixes to build: the
  missing `<format>` includes, and `std::sqrtf` spelled `sqrtf`;
- g++ with 32-bit support.

`out/` is gitignored, as everywhere under `reverse/`; `scripts/cod/data/` is
tracked, so a rebuild shows up as a diff.

To check every zone the pipeline reads, run `inflateall.py [mw2 mw3 bo1]`. It
prints one line per zone and exits non-zero on any failure. For one file, run
`python3 -m scripts.cod.fastfile <file.ff>`.

To walk them, run `walkall.py [mw2 mw3 bo1] [--golden .cache/cod/golden]`. It
prints one line per zone, with its size, XAssets, assets, time and peak RSS, and
exits non-zero if any walk is not exact or any listing differs. For one file, run
`python3 -m scripts.cod.zonecode <file.ff> [--listing - | FILE] [--compare GOLDEN.zone]`.

To reproduce the container facts, run `header.py <file.ff> ...`. For each
fastfile it prints:

- the magic, the version and the auth magic;
- where zlib starts;
- `size`, `externalSize` and each block size;
- the zone's first words.

It reads the first 0x6000 bytes only. On `mp_dome`, `so_survival_mp_dome`,
`mp_rust` and `mp_nuked` it prints 9, 9, 8 and 7 block sizes, followed by the
script-string count.

## Open

- **Anonymous types get stable names here** (`__anonymousN`); ZCG draws them at
  random. None is loaded through a program of its own.
- **Script strings need no load step.** A `scriptstring` member is a `u16`
  index into the zone's script-string list (ZCG only _marks_ them). A dumper
  resolves one with `Record.script_string(path)`, or `Walk.script_string(i)`
  for an array of them.
- **`asset_ref` members are strings naming another asset.** They are recorded
  but, like OAT, not followed.
