# What differs between the games

One pipeline imports four games; the dump's `_game` field (`iw4`, `iw5`, `t5`,
`iw6`) selects the few per-game rules. That field is authoritative, and an
unknown value is fatal rather than defaulted. MW2, MW3, Black Ops and Ghosts
each have a Python reader that writes the same
dump ([pipeline.md](pipeline.md#the-zonecode-walker), [below](#ghosts-iw6)). Advanced Warfare (`s1`) has one too, and reaches a
walkable world with props and no lighting or catalogue yet, so it is not in the table
([below](#advanced-warfare-s1--walkable-with-props-no-light-yet)). Nor is Black Ops II
(`t6`), which reaches a walkable, textured and lit world with props, sound and
zombies, and no prop animation or player catalogue ([below](#black-ops-ii-t6--walkable-textured-and-lit)).

|                                                         | MW2 (IW4)                                  | MW3 (IW5)                                  | Black Ops (T5)                                        | Ghosts (IW6)                                                 |
| ------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| Dumped by                                               | `scripts/cod/iw4`                          | `scripts/cod/iw5`                          | `scripts/cod/t5`                                      | `scripts/cod/iw6`                                            |
| Loaded sound (the PCM in a zone)                        | dumped                                     | dumped                                     | in the `soundbank`: xWMA and MS ADPCM                 | not dumped                                                   |
| Effect definitions (`FxEffectDef`)                      | not dumped                                 | dumped                                     | not dumped; `FxElemType` differs from index 2 on      | not dumped; `FxElemType` is Durango's + 2 from 6 on          |
| Sound aliases (`snd_alias_list_t`)                      | not dumped; the struct **is** IW5's        | dumped                                     | in the `soundbank`; fixed-point fields                | not dumped; no `.iwd`, so the streamed half is unestablished |
| Entity keys                                             | quoted names                               | script-string indices                      | quoted names                                          | script-string indices, other numbers                         |
| LIT technique                                           | 0x9                                        | 0x9                                        | **0xA**                                               | **0x7** (UNLIT 0x2, EMISSIVE 0x3)                            |
| Layer weights                                           | vertex alpha                               | vertex alpha                               | **vertex RGB** (neutralised)                          | **RGBA of `*` surfaces** (neutralised); RGB a tint elsewhere |
| Prop vertex RGB                                         | a tint, kept                               | a tint, kept                               | layer weights, neutralised                            | a tint, kept; white on motion and colourless surfaces        |
| PackedUnitVec (normals)                                 | scale byte                                 | scale byte                                 | scale byte                                            | **10:10:10**                                                 |
| `.iwi` version                                          | 8                                          | 8                                          | 13                                                    | none: DXGI DDS, most in `imagefile*.pak`                     |
| Minimap and loadscreen                                  | loose in the `.iwd` archives               | loose in the `.iwd` archives               | loose in the `.iwd` archives                          | zone images: the map's own, and `<map>_load.ff`              |
| Worldspawn light scale                                  | 1                                          | 1                                          | sun ÷12, ambient ÷4                                   | sun ÷3; no ambient key                                       |
| Sun keys                                                | `sunlight`, `suncolor`, `sundirection`     | 1989, 1990, 1991                           | as IW4                                                | 759, 760, 761 (and a duplicate of each)                      |
| Ambient keys                                            | `ambient`, `_color`                        | 1987, 2811                                 | `ambientintensity`, `_ambientcolor`                   | **none established**; the lightmap carries it                |
| Generated material names                                | —                                          | —                                          | `*N(a:b)` → `generated/_N`                            | `*…` → `generated/_…`; `*r…`/`*a…` two-pass pairs            |
| Non-surfaces besides `falloff`, `tools`, `shadowcaster` | —                                          | —                                          | `gobo` (props, by name)                               | `onlycast`, `distortion`, the `*a…` pass                     |
| Soup indices                                            | segmented (1024)                           | segmented (1024)                           | global; refused above 65,536                          | segmented (1024); `firstVertSegment` is a byte               |
| Soup contents                                           | none (all ground)                          | none (all ground)                          | from AABB tree leaves                                 | from AABB tree leaves; player clips **collide**              |
| Triggers                                                | not brush models                           | not brush models                           | brush models; dropped                                 | not brush models                                             |
| Clip material names                                     | from brush sides                           | from brush sides                           | none (sides carry flags)                              | from brush sides                                             |
| Contents bits                                           | guessed from `clip_*` names                | guessed from `clip_*` names                | guessed from `clip_*` names                           | the engine's own `infoParms[]`                               |
| A brush face's surface flags                            | its material's (sides, `axialMaterialNum`) | its material's (sides, `axialMaterialNum`) | **on the face** (`surfaceFlags`, `axialSurfaceFlags`) | its material's, as IW4/IW5                                   |
| Surface types (`(flags >> 20) & 0x1f`)                  | IW4's `surfaceTypeNames[]`, 31             | IW4's table; no IW5 table exists           | **own table**: 29/30 are `player`, `tallgrass`        | IW4's table, unverified                                      |
| Mantle kind (`mantle_on` / `mantle_over`)               | every face's material, all volumes         | every face's material, all volumes         | **face flags** 0x4000000 / 0x8000000                  | every face's material; `mantle_on` on all 1,391 seen         |
| Ladders (`surfaceFlags & 0x8`)                          | 72, in 12 of 16 zones                      | 27, in 11 of 25; one sky has the bit       | 55, in 18 of 34                                       | 21, in 5 of 5 zones; every flagged face axial                |
| Lightmap                                                | secondary's alpha                          | secondary's alpha                          | none usable                                           | ambient + highlight, HDR; 1–2 pages stacked                  |
| Companion zones                                         | `zone/english`                             | `zone/english`; DLC maps need it passed    | `zone/Common`                                         | `common_mp.ff`, `common_core_mp.ff`, `code_post_gfx_mp.ff`   |
| Where the weapons are                                   | `common_mp.ff` (1209 files, 43 guns)       | `common_mp.ff` (164 files, 53 guns)        | `common_mp.ff` (1,592 player weapon files, 41 guns)   | **`common_core_mp.ff`** (129 files, 46 guns)                 |
| Clip roles (`weapAnimFiles_t`)                          | 42 slots                                   | 42 slots                                   | 66 slots; IW4's keys all present                      | **124 slots, renumbered** (RELOAD 16, not 9)                 |
| Attachments                                             | none; 1078 baked weapon files              | 40 `attachment` assets                     | none; 1,551 baked weapon files, as IW4                | 66, reachable only through the weapons that list them        |
| Player clip names (`pb_`/`pt_`)                         | `pb_stand_alert`, `pb_combatrun_*`         | as IW4                                     | as IW4; class suffix from `weaponClass`               | **`pb_hold_*`; torso clips spelled `mp_`**                   |
| A weapon's sounds                                       | in the weapon file                         | in the weapon file                         | in the weapon file                                    | **not recoverable**: the emulated loader resolves them away  |
| Picker categories                                       | MW2 Multiplayer / Special Ops / Campaign   | MW3 …                                      | BO Multiplayer / Zombies / Campaign                   | Ghosts Multiplayer                                           |
| Animated-model scripts                                  | text rawfiles, by `precache_script`        | compiled `.gscbin`, numbered; scanned      | text rawfiles (untested)                              | as IW5                                                       |
| Compiled xanim version                                  | 17 (18 with a 3D delta)                    | 17 (18 with a 3D delta)                    | 19                                                    | as IW5, written by the backend                               |
| Bones per vertex                                        | up to 4                                    | up to 4                                    | up to 4                                               | up to 8; the heaviest 4 kept                                 |
| Flag-wind technique sets                                | `flag`                                     | `flag`                                     | `flag` (untested)                                     | `_flag_`; `flagext_wv…` stays still                          |

Details for each row are in [reference.md](reference.md). The notes below are
what is easy to get wrong about each game.

## MW2 (IW4)

- The backend (`scripts/cod/iw4`) is IW5's writers over IW4's records, so it
  writes IW5's schema and nothing downstream knows the difference. IW4 has no
  `ClipInfo` (its clipmap fields are flat) and splits the clipmap into SP and MP
  asset types; both are handled in the writer. What else it has to know is
  small, and each of it would pass unnoticed: a collision partition's counts are `char` in IW4's
  header and must be read unsigned, a rawfile may be stored plain, an LOD's
  surfaces are a record an action keeps rather than an asset, and `iw4mp.exe`
  stores the wavelet tables in the reverse order
  ([reverse/x86-zone](../../reverse/x86-zone/README.md#what-the-world-records-hold)).
  It writes no effects and no sound aliases yet: that would be new output, and
  waits for its own decision.
- `stateBitsEntry` has 48 entries against IW5's 54, and the enums diverge from
  0x13, but UNLIT/EMISSIVE/LIT are identical. Anything reaching further into
  the table needs the per-game enum.
- Entity keys are quoted. A key pattern that captured the quotes made every
  worldspawn lookup miss, and every MW2 map imported with house-default
  lighting. The parser now makes the quotes optional.
- MW3 ships a remake of MW2's Terminal (`mp_terminal_cls`). Both are named
  "Terminal", so the game suffix and category come from `_game`.
- Campaign zones sit beside the MP ones and load the same way; none are
  imported yet.
- Animated props follow the same scheme as MW3 and every script parses, but
  no MW2 map has been re-exported with them yet. mp_afghan's 263 animated
  foliage placements all resolve to one of its five sway clips.
- Viewmodels are laid out as in MW3 (all 1,700 view clips are asset type 1, the
  idle's translations equal the bind pose, `j_gun` roots the gun), but every
  attachment combination is its own weapon (`m4_acog_mp`), and `hideTags`
  lists the folded sight and the attachment tags. Not yet exported end to end.
- **Characters are named far more loosely than MW3's**, which is what makes MW2
  the game that exercises the pairing in `characters.py`
  ([reference.md](reference.md#characters)). Its allies are Task Force 141
  (`tf141`, whose own sniper head is `head_allies_tf141_desert_sniper`), the US
  Army and the SEALs' UDT; its axis the OpFor (`opforce_arab`,
  `opforce_arctic`), the Brazilian militia and the Russian `airborne` — whose
  models carry the `op_` marker only on their sniper and riot variants
  (`head_op_airborne_sniper`). A body and its head need not agree on word order
  (`mp_body_desert_tf141_assault_a`, `head_tf141_desert_a`) or on spelling
  (`mp_body_ally_…`, `head_allies_…`), and the militia's bodies and heads carry a
  `_blk`/`_wht` variant as their last word that both must share.
- **No path nodes.** No MP zone holds a PathData (IW4's `GameWorldMp` has no
  field for one), and the MP lumps carry at most six `node_*` entities, so MW2
  gets no navigation ([reverse/cod-pathdata](../../reverse/cod-pathdata/README.md)).

## MW3 (IW5)

- Only 32-bit fastfiles are readable (see [README.md](README.md)).
- Worldspawn keys are script-string indices; the ones used are stable across
  every MW3 zone checked.
- The DLC maps' zones live in `zone/dlc`, away from `common_mp.ff` in
  `zone/english`. `games.json` passes the English companions for them; an
  explicit export needs `--common`.
- The animated-model scripts are compiled and named by number, so the
  exporter cannot look one up by `precache_script`; it reads every `.gscbin`
  (see [reference.md](reference.md#animations)). mp_dome is the verified map.
- Viewmodels: verified on mp_dome with `iw5_m4_mp`. Weapons build from
  attachments at runtime (40 `attachment` assets), so one weapon file is the
  base gun; attachments are not exported yet.
- **Path nodes.** The MP zones hold none, but the lump keeps every `node_*`
  entity, and `so_survival_<map>.ff` (22 of the 25 maps) holds the compiled
  PathData of exactly those nodes: same count, order and x/y, z dropped to the
  floor, links included ([reference.md](reference.md#path-nodes)). The
  traversal's animscript is under the unnamed key 1983. aground and courtyard
  have no Survival zone.

## Black Ops (T5)

- Zones are plain zlib (Black Ops 2 is encrypted and uses a different vertex
  layout).
- The Python backend (`scripts/cod/t5`) has writers of
  its own for what T5's records spell differently, each of which would pass
  unnoticed: material slot names hash with every byte OR 0x20 (so `Color_Map`
  stays a hash under IW6's lower-casing hash), OAT reads only the first quarter
  of a shader for its constant table, a normal map is chosen by its slot name
  as spelled (`Normal_Map` loses to the `Detail_Map` before it), and two `bool`
  weapon fields are read as four-byte ints
  ([reverse/x86-zone](../../reverse/x86-zone/README.md#what-the-world-records-hold)).
- Four differences were silent: the LIT index (0xA), generated material
  filenames, layer weights in vertex RGB, and the worldspawn light scale. Each
  imported a map that rendered and was wrong.
- Every trigger, `occlusion_override` and the `heli_height_lock` sheet is a
  brush model whose contents include SOLID. Only `script_brushmodel` and `glass`
  collide.
- Soup clip volumes (`clip:soup:0x…` groups) are exported but carry
  `collides: false`. The original reason for that (a supposed AI flight hull)
  turned out to be the misplaced `heli_height_lock`; what remains is a couple
  of small player-clip volumes per map. **Black Ops' own code says they are
  walls**: its server traces soup exactly as Black Ops II's does, with the same
  player mask (0x2818011, `ClientThink_real` 0x5fa1b0;
  [reverse/t6-traversal](../../reverse/t6-traversal/README.md)). Not changed yet,
  for want of a survey of what it would add: `SOUP_CLIPS_COLLIDE_BY_GAME["t5"]`
  and a `SOUP_STOPS_BY_GAME` entry are the switch.
- Brush faces carry `surfaceFlags` and `contents` themselves, on side records
  and the six axial faces alike, and no material. So a ladder is as
  recoverable as on IW — the flag is the same `0x8` — and so is **a mantle's
  kind**, which the game reads off the face's flags (`mantleOn` 0x4000000,
  `mantleOver` 0x8000000), not a material's name: `Mantle_Check` 0x41e6f2 in the
  symbolised server, and mp_nuked's 38 volumes name 23 `onto`, 15 `over`.
- `gobo` materials (fake-shadow cards in trees, black at every alpha) are
  dropped by name.
- No Black Ops map has an `animated_model` entity: the clips the MP zones carry
  are the view's swimming set, and the zombies zones' ~177 are the zombies' own.
  So the animated-model scripts, read as IW4's are, are still unexercised. The
  version-19 xanim decoder is not: every player and view clip in the catalogue
  goes through it.
- **Who wears what is written down, not named.** Each MP map zone ships the
  create-a-class scripts as text (`mpbody/<class>_mp.gsc`, `mphead/…`), which
  give each faction's body, its default head and its view arms
  (`scripts/cod/cac.py`). The IW reading of names cannot be used: every head
  shares `c` and `mp` with every body, so it pairs across factions. A map ships
  two factions of five bodies; stage 9 dresses each side's `standard` class, and
  which faction is which side comes from the four `_teamset_*.gsc` in
  `common_mp.ff`.
- **The gun hangs on `tag_weapon_right`.** The bodies have no `j_gun`, and the
  player clips key `tag_weapon_right` instead.
- **A body's clip suffix comes from `weaponClass`.** `playerAnimType` describes
  the reload (`default`, `rearclip`, `beltfed`, …), and every pistol is
  `default`, so `_pistol` and `_rpg` are read off the class.
- **Weapons.** 41 base guns in `common_mp.ff`, 40 of which build (the ballistic
  knife's fire clip moves `tag_origin`). A viewmodel is named `…_viewmodel`,
  `…_viewmodel_<gun>` or `viewmodel_<gun>`. Dual wield (`WEAPON_*_DW`, a
  right-hand `dw` file and a left-hand `lh` one) is left out because the engine
  draws one gun. So are the Death Machine and Grim Reaper (killstreaks, by kill
  icon) and the unused `m220_tow`. The China Lake is `weaponClass grenade` and
  fits no slot. `common.ff`'s campaign copies (`_sp`) are skipped by name.
- **Attachments compose as MW2's do, with 54 exceptions** out of every
  multi-attachment file. Most are the ACOG and grip pair, which the game adds as
  deltas that cancel; the rest are combination clips the game authored for the
  pair itself (`viewmodel_ak74u_extclip_grip_reload`), which no composition of
  single attachments can produce. `T5_TYPES` in `attachments.py` is what lets
  sights win the aiming clips; without it the count is 346.
- **Destructibles and vehicles are missing** (`t5_veh_*`, `dest_*_d0`, 3 to 14
  placements a map). The name a map places is a `destructibledef`, which
  nothing dumps for T5 yet.
- **Six of the forty view arms show a blank watch face** (the CIA, Spetsnaz
  and winter CIA sets). Their watch material samples `sw4`, which is the render
  target the game draws the match timer into (`mc_sw4_3d_ui3d_watch`). The
  archives hold a 16×16 grey 24-bit `sw4.iwi` too, which the backend writes as
  DDS, so the face is grey.
- **Zombies maps are walkable worlds only.** Kino der Toten (`zombie_theater`)
  and Five (`zombie_pentagon`) are the two zones on disk whole; the rest ship
  only a `_patch.ff`. They take their props from `common_zombie.ff`
  (`maps.json`'s per-map `common`). Players spawn from
  the `initial_spawn_points` and `player_respawn_point` script structs, under
  mode `zombies`. Zombie spawners, play zones, doors and buys stay in
  `export_metadata.json`: the engine has no AI to give them to. Their path
  nodes are in `GameWorldSp` (1,568 nodes and 15,978 links on Kino), exported
  as every Black Ops map's are ([navigation.md](navigation.md#black-ops-from-the-map-zone)).
  Neither map has a compass image, so neither has a minimap.
- **Path nodes** are in `GameWorldMp.path` (`GameWorldSp` on the zombies maps),
  in the map's own zone, one node per `node_*` entity, and at the entity's own
  height: T5 does not drop nodes to the floor. Its negotiation links cost a
  constant 15.0, and its MP maps have only path and negotiation nodes
  ([reference.md](reference.md#path-nodes)).

## Black Ops II (T6) — walkable, textured and lit

How its zones were cracked, and every finding below with its evidence:
[reverse/t6-zone](../../reverse/t6-zone/README.md).

- **The zone is encrypted.** A PC fastfile (`TAff0100`, version 147) is XChunks
  dealt to four streams, each Salsa20-decrypted under an IV from its stream's
  SHA-1 hash chain and raw-inflated on its own. `t6/ff.py` reads it; `fastfile.py`
  claims it, so the one zonecode walker reads T6 as it reads IW4, IW5 and T5
  (a 24-byte `XAssetList` with a dependency list, `ZoneSpec.depends`). The key
  is one constant for every PC zone, `t6/ff.SALSA20_KEY`. The game builds it
  on the stack rather than storing it, and `reverse/t6-zone/key.py` re-derives
  it from `t6mp.exe` to check the constant. A map
  zone decrypts in about 3 s.
- **The world vertex is not IW's.** `GfxWorldDraw` holds byte buffers, and a
  surface names its vertices by a byte offset into them: 36-byte vertices in
  16-byte-aligned groups (the model's `GfxPackedVertex` plus a unorm16 lightmap
  coordinate). The `gfxworld` writer rewrites them into IW's 44-byte layout and
  points each surface's `firstVertex` at its group, so `shell.py` reads T6 as it
  reads every other game. It refuses a world whose groups do not add up to
  `vertexCount` or whose indices leave their group.
- **A normal is three signed 10-bit fields** (`t6/vertices.py`), neither IW's
  scale byte nor Ghosts' unsigned 10:10:10; a model's texture coordinate keeps u in
  the **low** half, the other way round from IW. `shell.UNIT_VEC_BY_GAME` and the
  shared `xmodel` writer (`PACKING_BY_GAME`) choose by `_game`.
- **Colour maps live in `.ipak` packs, not the zone.** Every streamed image
  (1223 of mp_la's 1289, every colour map and the compass map) has no pixels in
  its zone at all. `t6/ipak.py` finds each in the `.ipak` files beside the
  fastfiles by its name and data hashes, and `t6/lzo.py` inflates LZO1X in plain
  Python. The `image` writer takes the largest level no longer than 512 px (the
  levels are stored smallest first, so the rest are never inflated) and writes a
  DDS. The full-resolution level is there for the day something wants it.
- **LIT is technique 4** of 36 (UNLIT 2, EMISSIVE 3); mp_la's `stateFlags` agree
  on all 1568 lit materials. The alpha test is one bit, `gt0` or `ge128`.
- **A generated material names each layer's colour** (`colorMap`, `colorMap1`…),
  so `SURFACES_BY_GAME` asks for `colorMap` by name. Its layer weights are in
  vertex RGB on generated surfaces only (`LAYER_WEIGHTS_BY_GAME` is
  `"generated"`); other layers' coordinates are in the second buffer, `vd1`,
  which is not read.
- **The clipmap is T5's inside IW5's ClipInfo**: brush faces carry their own
  `surfaceFlags` and contents and name no material, so `collision.FACE_FLAG_GAMES`
  reads T6 as T5. Its contents bits are named by the game's own `infoParms[]`
  (the symbolised dedicated server, as Ghosts' are): T5's decided bits plus
  `mantle` 0x1000000, with 0x400 `itemclip`, 0x2000 `clipshot` and 0x10000000
  `structural`. Surface types are T5's plus `riotshield` at 31. The soup indexes
  globally, as T5's. Everything below is read from code in
  [reverse/t6-traversal](../../reverse/t6-traversal/README.md).
- **The mantle kind is the traced face's surface flag**: `mantleOn` 0x4000000,
  `mantleOver` 0x8000000, over winning on a face with both; `mount` 0x10000000 is
  no kind. `mantle.kind_of` pools the flags of the faces the hull has: 1,826
  `onto` and 441 `over` across the 15 maps, and 2 two-kind brushes written `over`.
- **Ladders are `surfaceFlags & 0x8`, as IW5**: 28 across 11 of 15 maps, every one
  a player-clip box flagged on every face, so none names a `face`.
- **Soup that stops a player collides** (`SOUP_CLIPS_COLLIDE_BY_GAME` is true):
  the player's trace meets a soup leaf whenever its material's contents meet the
  player's mask. `SOUP_STOPS_BY_GAME` holds that mask and the bullet's, and the
  soup's role follows them: player clip is a wall (mp_la's `dirt_clip`, 753
  triangles, half of them with nothing else near), wet floors that are player
  clip are floors (mp_overflow's canal, mp_raid's `_dripping` tiles), and
  `clip_physics`/missile-only soup, which stops neither, is not a wall (6,375 of
  mp_nuketown_2020's triangles). Soup that stops only bullets (`clipshot`, 0x2080:
  15–84% of a map's soup) stays ground, since the engine has no shots-only tree.
- **The lightmap is directional, and the sun is GfxWorld's.** Each
  `*lightmapN_secondary` is three RGBA8 pages stacked: page 0 an RGBD (`rgb / a`)
  ambient colour A, page 1 an RGBD directional colour B, page 2 the world-space
  direction D (`rgb * 2 - 1`) with the sun's visibility in alpha. Every lit world
  shader sums `A + B * sat(dot(D, N))` and adds the sun live, `sunCd.rgb * sunCd.w`
  from `GfxWorld.sunParse` with no scale between (read from the shaders and
  `t6mp.exe`: [reverse/t6-lightmap](../../reverse/t6-lightmap/README.md)).
  `t6/lightmap.py` bakes that sum per texel with the surface's own normal, and
  the sun comes from `sunParse` rather than the worldspawn (which has no light
  keys), both in the game's units. The one approximation is the fill light: the
  game has no ambient term, and the fill is the bake's median in shade, standing
  in for the light grid that lights props. Five maps carry a second lightmap (drone,
  nightclub, nuketown_2020, overflow, slums), stacked below the first.
- **Not dumped yet**, each a kind the backend does not claim, so its stage skips
  and says so: `fx` and `destructibledef` (mp_la's police car and the `*_radiant`
  vehicles do not place). `weapon` is dumped, for the catalogue only: no map's
  export names a weapon yet, and no map zone ships hands (below).
- **Weapons: 37 guns in the catalogue, from four kinds of zone**
  ([reverse/t6-weapons](../../reverse/t6-weapons/README.md)). `common_mp.ff` holds
  every gun; **`common_patch_mp.ff` rebalances 70 of them** and adds the
  Peacekeeper, so `catalog --dump bo2` dumps it over the base zone; the view hands
  are in the seven `faction_*_mp.ff` (18 pairs, `c_<country>_mp_<faction>_<sleeve>_viewhands`;
  no weapon file names a `handModel`); `patch_mp.ff`'s `mp/statstable.csv` is the
  menu, which every gun's attachment list matches exactly and whose slot wins (the
  crossbow is a `rifle` and a secondary). Left out: dual wield, the Wager KAP-40,
  the killstreaks and the ballistic knife (its fire clip moves `tag_origin`, as
  BO1's does). The first default class carries the MTAR (`tar21_mp`) and
  TEAM_ALLIES is the SEALs, so the rig and a world's default hands are
  `c_usa_mp_seal6_longsleeve_viewhands`.
- **An attachment is an `attachment` and an `attachmentunique`**: the first scales
  any gun's numbers, the second (`au_<gun>_<attachment>`) gives one gun its clips,
  fire sounds, hide tags and model. Both arrays on a weapon are indexed by
  attachment type. What each becomes is [reference.md](reference.md#black-ops-ii-weapons);
  the models are not mounted yet, because they hang by an offset from `j_gun`
  rather than from a joint of their own.
- **Six damage steps, not two**, and the engine reads two: the first and the last
  are written, so a middle plateau (the AN-94's 33) becomes a ramp. Open.
- **A clip names its own sounds**: `sndnt#<alias>` notetracks, and an empty
  `notetrackSoundMap` on every gun (`viewmodel.notetrack_sounds`).
- **Sound is outside the zone.** The `soundbank` holds the aliases; every
  recording is an entry of a `.sabl` (PCM) or `.sabs` (FLAC) bank file in
  `<game>/sound/`, keyed by a hash of its source path (`t6/sab.py`). All 16 worlds
  carry their ambience (`sound.world`, from Black Ops' `script_struct` emitters),
  and `catalog/sounds/t6/mp/` the footsteps, the hit marker and the zombies'
  sounds. Everything plays some 30 dB quieter than BO1's, because the game's
  master bus compresses and the engine's does not
  ([audio](audio.md#black-ops-ii-t6)), which is left unmodelled for now.
- **`game: t6`.** Every BO2 world declares it (the exporter writes it, and
  `ensure_world_game` added it to the 16 on disk), so each loads the t6 sound bank.
  The catalogue has no BO2 bodies, hands or weapons yet, so a t6 world's players
  are dressed and armed as Black Ops' — its bodies and clips, the CIA's arms, the
  M16 — part by part until each of BO2's own is built (`CAST_STAND_IN` in
  `@3d/shared/game/cast.ts`, the one place that says so). TranZit's walkers are an
  actor kind of their own, `zombie_transit` (`t6/zm_transit_basic`).
- **Clips are IW5's pools** ([reference](reference.md#black-ops-ii-xanims)): the
  backend dumps `xanim` with IW5's writer, checked against BO1's own copies of the
  zombie clips. No prop animates yet: which clip a prop plays is in the map's
  compiled animated-model scripts, which nothing reads for T6.
- **Path nodes are Black Ops', in the map zone's `GameWorldMp`**, and every map
  has them: 11,350 nodes on the 15, the entity lump's `node_*` entities in count,
  order, type and x/y/z. `t6/dumpers/pathdata.py` is T5's writer over T6's
  16-byte link. What differs from T5, read from the symbolised server
  ([reverse/cod-pathdata § T6](../../reverse/cod-pathdata/README.md#t6-black-ops-ii)):
  `nodeType` drops the two wide covers and puts `AMBUSH`/`EXPOSED` after
  `COVER_PILLAR`; a link has a `flags` byte, whose 0x10 marks a redundant link
  every search skips (left out of `nav.bin`: 56–68% of the links on carrier,
  dockside, drone, overflow and socotra, none elsewhere); and most traversals are **negotiation hints**, a begin with
  no animscript and a spawnflag the bot turns into the player's own move
  (LADDER, MANTLE, JUMP, FALL). A bot takes only those. How each maps is
  [navigation.md](navigation.md#black-ops-ii-from-the-map-zone).
- **Game objects.** T6's gametype lists are not read yet (`ALLOWED_BY_GAME` is
  empty), so every `script_gameobjectname` entity is left in every mode and named
  in the log.
- **The loading screen is named by code, not a table.** The game registers the
  material `loadscreen_<zone name>` as a level loads (`UI_SetLoadingScreenMaterial`,
  read from the symbolised X360 build: [reverse/t6-loadscreen](../../reverse/t6-loadscreen/README.md)).
  There is no `<map>_load.ff`: 14 maps' materials are in `code_post_gfx_mp.ff`,
  Nuketown's in `dlc0_load_mp.ff`, which the backend names in `loadscreen_zones`;
  the `loadscreen` dump writes only those pictures, whole (one BC1 level from an
  `.ipak`). Ten of them are 1024² and Nuketown's 2048²: 16:9 pictures squashed
  into a square, which the game stretches over the screen, so every one is
  written at 640x360 (`loadscreen_size`). The map-select preview is another
  picture, `mp/mapstable.csv`'s `menu_mp_<map>_map_select_final`, not imported.
  `--loadscreen-only` re-extracts just the picture.
- **The minimap** is an image in the map's own zone (`pictures = "zone"`). It is
  the image the `compass_map_<map>` material names, which is not always
  `compass_map_<map>`: mp_nuketown_2020's is `compass_map_mp_nuketown2020`.
- `games.json`'s `bo2` names `common_mp.ff` as the one companion: the `common.ff`
  beside the maps is the campaign's.
- **Six maps have a 150–460 km shell.** Each one's `water_ocean_<map>_distant`
  is a dozen triangles of flat sea out to the horizon (carrier, dockside, hijacked,
  meltdown, nightclub, socotra), as crisis-bo1's is. Pool water
  (`water_pool_*`, `mtl_water_karma_pool`) has no colour map and renders as a
  flat grey.
- **`mp_village` is MW3's zone name too**, so `export mp_village` refuses and
  asks for the world (`village-bo2`).

### The 15 maps

All 15 export and pass `pnpm check` (2026-09-26, with the lightmap and the
mantle kind; mantles are onto/over). Placements are the props (the vehicles that did not export are
destructibles, skipped); triggers are `gameplay.world`'s, volumes `volumes.world`'s.
Every spawn lands on an opaque pixel of the minimap through the exported frame,
and on each map every spawn has collision 0.6–1.9 m under it (T6 spawn origins
sit about 1 m up). Time and peak memory are one export, five at once.

| World         | Placements (assets) | Skipped | Spawns (dm/tdm/dom/ctf/dem/sd, other) | Triggers | Volumes |      Mantles | Ladders | Shell textured | Time | Peak RSS |
| ------------- | ------------------- | ------: | ------------------------------------- | -------: | ------: | -----------: | ------: | -------------- | ---: | -------: |
| carrier-bo2   | 3403 (304)          |       0 | 289: 31/85/48/42/65/18                |        4 |     114 | 175 (146/29) |       3 | 218/218        | 2:50 |   0.7 GB |
| dockside-bo2  | 3131 (397)          |       8 | 317: 25/79/49/42/66/18, res 38        |        7 |     137 | 236 (166/70) |       0 | 380/380        | 2:58 |   0.8 GB |
| drone-bo2     | 4650 (390)          |       6 | 268: 25/79/43/42/61/18                |       19 |     135 |  156 (94/62) |       1 | 421/421        | 2:42 |   0.9 GB |
| express-bo2   | 3701 (291)          |       0 | 293: 31/86/53/44/61/18                |        8 |     153 |  112 (90/22) |       1 | 345/345        | 2:04 |   1.0 GB |
| hijacked-bo2  | 2453 (362)          |       0 | 284: 30/85/46/40/65/18                |        3 |      79 | 136 (125/11) |       8 | 225/226        | 2:20 |   0.7 GB |
| la-bo2        | 5164 (494)          |      16 | 284: 28/82/49/41/66/18                |       34 |     145 | 227 (162/65) |       1 | all            | 2:45 |        — |
| meltdown-bo2  | 6657 (444)          |       7 | 271: 24/78/48/40/63/18                |       16 |     168 |  108 (108/0) |       4 | 506/507        | 5:23 |   1.1 GB |
| nightclub-bo2 | 5670 (496)          |       2 | 299: 31/85/52/46/67/18                |       13 |     131 |   99 (80/19) |       2 | 578/578        | 2:49 |   1.1 GB |
| nuketown-bo2  | 3139 (382)          |       0 | 291: 32/88/55/40/58/18                |        6 |      80 |   47 (25/22) |       2 | 317/317        | 2:10 |   0.9 GB |
| overflow-bo2  | 6308 (463)          |       0 | 326: 28/82/47/41/61/18, res 49        |       18 |     188 |  175 (173/2) |       1 | 705/705        | 5:14 |   1.0 GB |
| raid-bo2      | 4713 (339)          |       8 | 278: 27/81/48/43/61/18                |       10 |      97 | 158 (125/33) |       0 | 339/341        | 1:59 |   0.9 GB |
| slums-bo2     | 2882 (343)          |      10 | 280: 28/82/48/40/64/18                |        5 |     228 |   100 (97/3) |       0 | 711/711        | 4:23 |   0.9 GB |
| socotra-bo2   | 4779 (349)          |       6 | 283: 27/81/44/46/67/18                |       13 |     133 | 154 (115/39) |       4 | 792/792        | 3:57 |   1.0 GB |
| turbine-bo2   | 3218 (288)          |       3 | 321: 20/77/45/40/64/18, res 57        |       47 |     154 | 292 (238/54) |       0 | 226/226        | 4:07 |   0.7 GB |
| village-bo2   | 6214 (440)          |       5 | 294: 32/84/52/44/64/18                |       11 |     143 |   99 (86/13) |       1 | 692/692        |   ~3 |        — |

The untextured shell materials are the pool water above. No shell misses a colour
map; props miss one texture on three maps (express, nightclub, overflow).

### Zombies: TranZit (`transit-bo2`)

The research, with its evidence: [reverse/t6-zombies](../../reverse/t6-zombies/README.md).

- **One world, not three.** `zm_transit.ff` holds the whole map (one `gfxworld`,
  clipmap, entity lump and path graph). The survival locations (Bus Depot, Town,
  Farm) and the grief arenas are entities the scripts keep or delete by a
  `script_string` token `<gametype>_<location>` (`zclassic_transit`,
  `zstandard_town`), and by `script_gameobjectname` (`zclassic`) as MP does.
- **Zombies runs on the MP engine**: the path nodes are in `GameWorldMp`, as the
  MP maps' are, not BO1's `GameWorldSp`.
- **The `gump` zones are streamed prop models.** The map zone places every prop
  but names 454 of its models under a comma; each is held by exactly one of ten
  `zm_transit_gump_<area>.ff`, which the client loads as a player enters an
  area's `gump_triggers`. So maps.json's `common` lists the ten gumps (with
  `common_zm.ff`, `code_post_gfx_zm.ff` and `so_zclassic_zm_transit.ff`).
- **A gump model's materials are the map zone's**, named under a comma, so the
  model's own writer sees no texture: the pack stage takes the colour map from
  the material dump instead (`pack.add_colour_maps`). Without it 741 of 901 prop
  materials drew white.
- **The `so_*` zones are mode overlays**: an `addonmapents` each, with that
  mode's AI spawners, and for grief (`so_zencounter`) 1,206 structs and two brush
  models. Only `so_zclassic` is a companion, for the classic mode's models.
- **The loading screen** is `loadscreen_<map>_<gametype>_<location>` in
  `code_post_gfx_zm.ff`: maps.json's `loadscreen` names the default session's,
  `zm_transit_zclassic_transit` (`zm/gametypestable.csv`'s `YES` row, which
  `test_t6.py` checks), and `loadscreen_zones` reads `code_post_gfx_{mode}.ff`.
- **No minimap**: there is no `compass_map_zm_transit` and no `minimap_corner`.
- **The traversals are TranZit's own animscripts** (`zm_mantle_over_40`, the
  vaults over a car and a counter, the drops and climbs): rows of
  `ANIMSCRIPT_KINDS["bo2"]`, each checked against its pairs' rise.
- **Size.** 728 x 597 m and 93 m high; 383k drawn triangles in the shell (62.6 MB
  `world.glb`), 10,909 prop placements over 535 models (155 MB), 221,500
  collision triangles, 5,584 path nodes and 43,140 links. Export: 3:19 alone,
  1.25 GB peak RSS.
- **The zombies are catalogue actors**, `t6/zm_transit_basic` and the clip set
  `t6/zombie` (`python3 -m scripts.cod actors --game bo2`,
  [pipeline](pipeline.md#actors)): the ten bodies and four heads TranZit's three
  spawners dress, weighted as the game picks, and BO1's clips again, their roles
  read from the AI's text state machine (`animstatedefs/zm_transit_basic.asd`)
  rather than a script ([reference](reference.md#black-ops-ii-tranzits-walkers)).
  No actor kind names them yet: `t6` is not a `GameKey`, and zombies runs on
  theater only.
- **Not exported yet**: the bus (a `script_vehicle` on 290 vehicle nodes), the
  windows (`zbarrier_*` entities), and the perks, wall buys and box, which are
  structs a script spawns models at; see the phase 2 survey in the research.

## Ghosts (IW6)

- `scripts/cod/iw6/` walks a zone in Python the way the game's loaders do, and
  its backend (`iw6/backend.py`) writes the [dump tree](pipeline.md#the-dump-tree),
  with `_game: "iw6"`. `scripts/cod/backends.py` picks the backend from the
  fastfile's header, so `export` takes a Ghosts map like any other. How the
  format was established: [reverse/iw6-zone](../../reverse/iw6-zone/README.md).
- **What is dumped so far.** `gfxworld`, `image`, `mapents`, `material`,
  `xmodel`, `xanim`, `scriptfile`, `rawfile` and `clipmap`, all whole; `weapon`
  and `attachment` in part (below); plus the zone's asset listing
  (`zone_source/<zone>.zone`), which the backend writes beside every dump. `export` runs stages 1–11 and writes `world.world`, so
  a Ghosts map loads with its shell, decals, props, collision, mantles, ladders,
  its own baked lighting, its `.vision` grade, its minimap, its first-person
  viewmodel and the bodies other players are drawn as. Stage 12 skips itself and
  says so: the effects need `fx`.
- **The weapons are in `common_core_mp.ff`.** 129 weapon files, 46 of them guns
  a player carries, against exactly one in `common_mp.ff` — which is why
  `games.json` names that zone for Ghosts and no other game has a third
  companion. It is a large zone, so every Ghosts export now spends about 90 s
  and 2 GB of scratch walking it. Each weapon is written as the IW5 dump's
  `WEAPONFILE` infostring, under IW5's key spellings, so nothing downstream
  needs a per-game key table: **481 of OAT's 773 keys**, and what is missing is
  either absent from IW6's own structs or unrecoverable through the emulated
  loader ([reference.md](reference.md#ghosts-keeps-its-weapons-in-a-zone-of-their-own)).
  A clip role is read through IW6's own 124-slot enum, not IW5's 42
  ([pitfalls.md](pitfalls.md#viewmodels)).
- **Attachments are reached through the weapons, not the asset list.** All 63
  `ATTACHMENT` entries in that zone's listing are aliases to attachments a
  weapon already loaded, so the walk records none;
  `iw6/dumpers/attachment.py` follows `WeaponCompleteDef.scopes` /
  `underBarrels` / `others` and writes all 66 in the JSON shape
  `scripts/cod/attachments.py` already reads. `catalog --dump ghosts` asks for
  them, which it does through the same backend chooser an export uses; IW4 and
  T5 are not asked, because those zones have no such asset type and their
  backends refuse the kind rather than writing an empty dump
  (`catalog.ATTACHMENT_GAMES`).
- **The view hands and the whole roster come out of `common_core_mp.ff`.** Every
  `viewhands_*` in the game is there — five `us_rangers` camo variants, a
  juggernaut's and a hostage's — so stage 8 packs the map's hands from a
  companion zone rather than from the map. `python3 -m scripts.cod catalog --dump
ghosts` builds **39 weapons and 66 attachments** out of the same zone, and
  `worlds/prisonbreak-ghosts` names `iw6/iw6_ak12_mp` out of it
  ([pipeline.md](pipeline.md#the-shared-asset-catalogue)). Three readings differ
  from MW3's:
  - **A killstreak's copy of a weapon is spelled by its icon.** MW3 gives the
    Juggernaut's four `death_juggernaut`; Ghosts names every killstreak icon
    `icon_ks_<streak>_hud`, which rejects six of the seven duplicates in the
    roster. The seventh, Safeguard's `iw6_magnumhorde_mp`, is the Magnum's own
    icon on a 1000-damage pistol and is named in `catalog.NOT_SELECTABLE`.
  - **The fire selector is an attachment.** Six of the 66 carry an `ammoGeneral`
    of their own whose `fireType` is what the rifle fires while they are
    fitted — the only thing in the data that says so, and something MW3 never
    needed (its four `ammoGeneral` blocks are all an underbarrel weapon's).
  - **A segmented reload has two flags.** IW6 declares both `bSegmentedReload`
    (the UTS-15) and `bMultipleReload` (the FP6), and only the first has an OAT
    key; the dumper writes either as `segmentedReload`, or the FP6 would load
    five shells in one pump.

  Twelve of the 39 offer exactly sixteen attachments, which is
  `MAX_ATTACHMENT_SLOTS` — the wire's four-bit slot with no headroom left.

- **Every player clip is spelled differently, and the role table is per game.**
  The `pb_`/`pt_` clips are in `common_mp.ff`, as on MW3, but almost none of the
  names are MW3's, so `characters.CLIP_ROLES_BY_GAME` holds a set per game
  ([reference.md](reference.md#characters)). Three readings decide the Ghosts
  set, and each is a judgement rather than a lookup:
  - **The four-way run is the `pb_hold_run*` family**, not the per-class
    `pb_combatrun_<direction>_loop_<class>` one — which is complete for `_smg`,
    `_lmg`, `_sniper` and `_shotgun` but has **no `_assault` forward clip at
    all**. One stride clock drives all four directions
    ([rendering.md](../engine/rendering.md#player-characters)), so mixing the
    two families slides a strafe's feet against a run's; `_hold` is the generic
    class in Ghosts' own naming (`pb_sprint_hold` beside `pb_sprint_assault`)
    and its set is the only complete one. The per-class runs are unused.
  - **The standing torso clips are spelled `mp_`, not `pt_`.** `mp_stand_reload`
    and `mp_core_stand_fire_ads` are 153-bone asset-type-1 clips keying the same
    joints as `pt_stand_shoot_auto`: torso clips in everything but the prefix.
    Read only the `pt_` names and the conclusion is that Ghosts ships neither a
    standing reload nor an ADS fire, and the zone appears to agree.
  - **Mantling is `mp_mantle_<inches>_{up,over}`**, 16 to 64, with `_idle`,
    `_knife`, `_run` and `_shield` variants on the middle heights. 40 is taken,
    as MW3's `mp_mantle_up_39` is; the engine stretches whichever it is given.

  A weapon's `playerAnimType` still picks a class, but IW6's list is not IW's:
  its machine guns are typed `autorifle`, its four shotguns `other`, and it adds
  `minigun`, `riotshield` and a `_bullpup` spelling of three classes, so
  `ANIM_TYPE_SUFFIX_BY_GAME` is per game too. The `_lmg` clips the zone ships are
  therefore never selected — no Ghosts weapon is typed for them.

- **A map ships one faction's bodies.** mp_prisonbreak's own zone has seven
  `mp_body_*` — five camos of `us_rangers_assault_a`, an infected and a
  juggernaut — and no Federation body at all, so `characters.SIDES` has nothing
  to split on and the export names each character for itself rather than
  inventing an allies/axis pair. The other side is in the per-loadout streaming
  zones (93 `mp_body_<character>_<class>_<variant>_tr.ff`), which an export does
  not walk. Ghosts also names no head after a body — its rangers wear any of the
  interchangeable `head_mp_head_*` — so `HEADS_ARE_A_BODYS_BY_GAME` says to take
  a head no body claims instead of pairing by name.
- **The pictures are zone images, not archives.** Ghosts ships no `.iwd`, so
  neither picture stage can read one (`backends.py`'s `pictures`): the compass
  image is an ordinary image in the map's own zone, and the loading screen one in
  `<map>_load.ff`, a small zone stage 10 walks for its images alone. A run that
  reaches neither keeps the `minimap.png` already beside the world rather than
  deleting the HUD map with it ([pitfalls.md](pitfalls.md#geometry)).
- **The entity lump holds no MP spawns.** Ghosts creates them somewhere other
  than the mapents: not one entity in any of the 21 MP zones is an
  `mp_<mode>_spawn`, so `export_metadata.json` reports none and no
  `gameplay.world` is written. (What the lump does carry everywhere is the
  minimap: exactly two `minimap_corner` entities in all 21.) The lump does hold the triggers and the game-mode
  objects, but under numeric keys `entities.IW6_KEY_NAMES` does not name yet (on
  mp_prisonbreak, `476` reads as a radius, `272` as a height, `27614` as
  `script_gameobjectname` and `27658` as `script_label`); naming one asks for the
  evidence the keys already there were held to. Which modes a map ships is read
  instead from its per-mode constant-baseline rawfiles (`metadata.MODE_ASSETS`),
  since Ghosts ships no config stringtable per mode.
- **Worldspawn: the sun is read, the ambient is not.** Its keys are
  script-string numbers of its own, and each of the three sun keys was settled
  against the map's own lightmap rather than by the shape of its value
  ([reference.md](reference.md#entities-and-worldspawn)): **761** is the
  direction the baked sun-visibility mask follows, **760** the colour of the
  baked highlight lobe, and **759** the sun's intensity, which that lobe's
  brightness tracks across nine zones. A second key repeats each value
  (32081, 32066, 32069), so both spellings are tried. `sunlight` runs 0.2 to 10
  with a median of 4 against IW's 1.2, so `LIGHT_SCALE_BY_GAME` divides it by 3.
  **No ambient key is established**, so a Ghosts world takes the house ambient
  and its own lightmap carries the real one.
- **The lightmap is read whole, and it is not IW5's.** A page is a pair of
  images holding three things: a BC4 sun-visibility mask at twice the page's
  resolution, and a half-float RGBA image carrying the page's ambient colour
  stacked over its highlight colour. The export sums the two lobes into `assets/lightmap.png` and leaves
  the sun to the engine's own light. A map has one or two pages, each its own
  size, and each surface names its own (`GfxSurface.laf.fields.lightmapIndex`,
  31 for none) — so the pages are stacked into one image and the shell's
  lightmap UVs are moved into them ([reference.md](reference.md#lightmaps)).
- **Per-instance prop lighting is not exported.** Three things a static model
  could be lit by, and what the zones hold:
  - per-vertex `ambientColor`/`highlightColor`
    (`GfxStaticModelDrawInst.vertexLightingInfo`), on almost nothing — 15 of
    mp_prisonbreak's 8,139 placements, 0 of mp_strikezone's 13,569, 1,030 of
    mp_frag's 8,779, about 1% across the 21 MP zones;
  - its own lightmap rectangle (`modelLightmapInfo`), on **none**:
    `lightmapIndex` is `0xFFFFFFFF` on every placement of both maps checked;
  - `groundLighting`, four floats on **every** placement and genuinely varied
    (1,687 distinct values over mp_frag's 8,779, luminance median 1.0 and max
    4.2, so on the lightmap's own scale). What it is was not established — the
    name says the light where the model meets the ground, and the rest of a
    model's light comes from the light grid, which nothing here reads.

  So the data for a per-placement light exists and nothing exports it. The
  engine end is smaller than it looked: instancing can carry a value per
  placement, and what is missing is a DSL property for it and a shader path that
  adds it as irradiance rather than tinting the albedo.
  What each game carries and a recommended order: [reference.md](reference.md#prop-lighting).

- **Render state** comes from each state-bits entry's raw `loadBits`, which keep
  IW5's layout; the zone's D3D11 state objects are derived from them. The
  technique enum lost BUILD_FLOAT_Z and BUILD_SHADOWMAP_COLOR, so UNLIT is 0x2 and
  LIT 0x7, and PC repeats its 103 techniques four times (standard, instanced,
  subdivision patch, no displacement) for 412 slots. Blended world materials use
  D3D11's dual-source factors (`one`/`invsrcalpha1`). How all of it was
  established: [reverse/iw6-zone](../../reverse/iw6-zone/README.md#render-state).
- **The dump skips comma-named materials.** They are headers naming another
  zone's material, and the map is dumped after its companions.
- **Two-pass layer blends.** Besides single-pass generated materials (`*108_11`,
  with a weight per layer in vertex RGBA), a map pairs a `*r…` base
  (`srcalpha/zero`) with a `*a…` pass (`srcalpha/one`) over the same triangles,
  both weighted by what their shader computes. This engine draws one layer, so
  `*r…` is drawn opaque and `*a…` dropped (`materials.SURFACES_BY_GAME`).
- **Decals** are still the `unlit` technique sets, less the `unlit_atest` ones,
  which are distant vista cards. Lit blended overlays (`cameraRegion`
  `litDecal`) stay in the shell with their sort keys, as on IW5. No world
  material has a polygon-offset state.
- **The colour map is the texture named `colorMap`.** A `revealMap` shares its
  semantic and can sort first.
- **Texture slots and long constant names** are recognised by `R_HashString`
  of the name (`iw6/dumpers/material.py`); unknown ones keep hash and stored part.
- **Normals** are three 10-bit fields (`shell.UNIT_VEC_BY_GAME`).
- **Images** are DDS, finest level only. Colour maps are BC1–3, which Pillow
  reads; float probes and BC6H skies it does not.
- **Entity keys** are script-string numbers, but not IW5's (`97` is the
  classname, `430` the origin, `392` the model). `detect_keys` finds them from
  the values; `IW6_KEY_NAMES` names those and the two the prop stage reads.
- **Brush models** are placed as on IW5, by `"*N"` entities. On mp_prisonbreak,
  all 7,380 vertices of its 18 rendered brush models lie within their models'
  own bounds, and within origin plus bounds once placed. Every `cmodels[N].info`
  points at the _game's_ global `clipMap_t`, not at a ClipInfo of its own, and
  means "the map's" ([reference.md](reference.md#collision)). mp_frag has one
  brush model with collision and no placer, which is counted and skipped.
- **Models** are written as the IW5 backend writes them, from the zone's own skeleton and
  weights ([reverse/iw6-zone](../../reverse/iw6-zone/README.md#skeletons-and-skinning)).
  Comma-named models, like comma-named materials, are left to their own zone;
  a map's model naming a companion's material takes that material's textures.
  Subdivision surfaces are written as their base cage.
- **A skeleton can belong to an earlier model.** Ghosts ships a camo variant as a
  whole XModel whose bone arrays point at the first variant's bytes instead of
  following it in the stream — four of the five `viewhands_us_rangers_*` do —
  so the walker resolves such a pointer where it was streamed rather than
  reading it as absent ([pitfalls.md](pitfalls.md#viewmodels)).
- **`mv/<name>` models** are placed where the clipmap lists `<name>`, at the
  same origin, so a folder in a model name is kept through packing, and
  `props.py` takes the listing of `<name>` as the placement's.
- **Surfaces without colour.** A reactive-motion surface keeps piece indices in
  its colour bytes, and a `VERTCOL_NONE` one (every static-model `m_` surface)
  none at all. Both are written white, and on a flag material with alpha 0, so
  they stand still rather than waving at full strength.
- **Flag wind.** `flag` sets carry IW5's `flagParms` alone and use IW5's shader.
  `flagext_wv…` sets add per-material waves (`flagWave<n>Parms`), whose
  amplitudes are mostly a fortieth of IW5's fixed ones or less, so the ported
  shader would throw them about. They are left still until the engine takes the waves
  (`materials.FLAG_TECHSETS_BY_GAME`,
  [reverse/iw6-zone](../../reverse/iw6-zone/README.md#flag-wind)).
- **Animated props** work as on IW5: numbered compiled scripts, clips of asset
  type 2. mp_dart's 40 roof vents turn. Ghosts adds clips of asset type 7 (two
  scripted events on mp_prisonbreak), whose translations are unverified.
- **Companion zones.** `common_mp.ff` holds shared world textures,
  `common_core_mp.ff` every weapon and its models and clips, and
  `code_post_gfx_mp.ff` the engine's `$white` and `$black`; `games.json` names
  all three, and an explicit export passes them with `--common`. Only the first
  is referenced by a map, so the other two would never be found by the default
  lookup — which would also take `common.ff`, the campaign's.
- **mp_strikezone holds its stadium twice**, intact and destroyed, one above the
  other; the map's event swaps between them. It is not a placement fault.
- **Path nodes** are a `PATHDATA` (type 22) in `<map>_path.ff`, beside the map,
  read by the emulated loader. The entity nodes come first, then one node per
  path zone; entity keys 52 (animscript), 640 (target) and 542 (spawnflags) are
  confirmed by it. Five maps have dynamic node groups, stored in their parent
  entity's frame ([reference.md](reference.md#path-nodes)). The `pathdata` dumper
  (`iw6/dumpers/pathdata.py`) reads it for the world's `nav.bin`
  ([navigation.md](navigation.md#ghosts-and-aw-from-the-path-zone)).

## Advanced Warfare (S1) — walkable, lit, armed and cast; props unlit

- `scripts/cod/s1/` walks an S1 zone the
  same way `scripts/cod/iw6/` walks a Ghosts one, and shares three modules with
  it outright: the block model and pointer rules (`iw6/zone.py`, IW6's spec over the
  shared core in `scripts/cod/zone/`), what a walk
  keeps (`iw6/records.py`) and the DXGI and DDS half of `iw6/images.py`. The
  container is IW6's with 0x4000 blocks and LZ4 chunks instead of one zlib
  stream, and every asset struct is close enough that the walk is a port. How
  the format was established, and what is left to do:
  [reverse/s1-zone](../../reverse/s1-zone/README.md) and its
  [PLAN.md](../../reverse/s1-zone/PLAN.md).
- **What is dumped.** `gfxworld`, `image`, `mapents`, `clipmap`, `rawfile`,
  `material`, `xmodel`, `xanim` and `stringtable` whole, so `export` writes the
  shell, the props, the collision, the climbing, the minimap, the metadata,
  `gameplay.world` and `world.world`. `weapon` is written by key and
  `attachment` as its edits, neither whole. `scriptfile`, `fx` and `sound` have
  no writer, and a kind with no writer is **absent** rather than empty, so the
  stages that read one do not run at all.
- **Its model vertex is Ghosts' `GfxPackedVertex`**, float position and all.
  The X360 build's `XSurface.quantizeScale` and 24-byte quantised vertices are
  not in the PC zones; the xmodel dumper holds every position to S1's own
  `unknown0` copy of it and every LOD 0 to `XModel.bounds`, and stops on a
  mismatch ([reverse/s1-zone](../../reverse/s1-zone/README.md#the-models)).
- **A map's own copy of a model is named `<model>@<map>`**, and `@` is not a
  character `@3d/api` serves; `pack.served_path` spells the packed file so it
  is ([pitfalls](pitfalls.md#geometry)).
- **Its entity keys are numbered, and its numbers are its own**
  (`entities.S1_KEY_NAMES`, 25 of the 102 keys the fourteen zones use), read off
  the stock prefabs an AW map shares with an imported MW2, MW3 or Ghosts one
  ([reverse/s1-zone](../../reverse/s1-zone/README.md#the-entity-keys)). The
  worldspawn light keys are named in `worldfile.WS_KEYS_S1`, on IW's scale, and
  the sun's direction and colour check out against the map's own lightmap.
  `_color` is not named, so the fill light takes the house ambient colour; nor
  is `northyaw`, because no AW map needs one -- every compass image lies at the
  engine's default north, and 36816, the key shaped like it, is not it.
- **The lightmap is Ghosts'**: a pair per page, a BC4 sun mask at twice the page
  and a half-float secondary holding the ambient lobe stacked over the highlight
  lobe, one to three pages a map. `lightmap.PAGED_GAMES` reads both games the
  same way ([reverse/s1-zone](../../reverse/s1-zone/README.md#the-lightmap)).
  **Props are not lit by it yet**: a static model is lit one of three ways,
  mostly from a light grid nothing decodes.
- **Two gametype overlays are world surfaces**: the Horde-mode dome over the
  whole map and the Hardpoint zone outlines, script_brushmodels whose techset is
  the only one carrying `hilite_z_edges`. `SURFACES_BY_GAME` drops that
  techset.
- **The spawn points are not entities.** Not one `mp_*_spawn` is in any of the
  fourteen entity lumps; they are `MapEnts.spawnList`, 44-byte records named by
  zone script strings, which the mapents dumper appends to `<map>.ents` as the
  entities they stand for. That gives each map 200-359 spawns over 8-11 modes,
  and the world `spawn` is an `mp_tdm_spawn_allies_start`, 0-0.8 m above the
  floor on all fourteen -- where the lone `info_player_start` was 17, 23 and 46 m
  up on `mp_venus`, `mp_recovery` and `mp_levity`. Most maps also park one `dd`
  and one `sab` spawn 73-460 m up for modes they do not run, and four tag spawn
  sets with a targetname (`first_map_spawns`, `ocean_spawn`) that nothing reads
  yet ([reverse/s1-zone](../../reverse/s1-zone/README.md#the-entity-keys)).
- **`world { game: s1 }`**, on all fourteen worlds, selects AW's own cast: its
  default weapon is the Bal-27 (`CLASS_DEFAULT` in `mp/classtable.csv`) and its
  hands the default costume's.
- **Weapons are composites and attachments are edits.** A `gunModel` has no
  geometry of its own: its receiver, barrel, sight and stock are `,`-references
  into a per-gun `mp_vm_<gun>_tr.ff`, and `composite.py` assembles them onto the
  receiver's skeleton. An attachment is a list of edits to `WeaponDef` by byte
  offset, all 697 of which land on a member of their declared type. 31 of the 33
  guns build (the SAC-3 and XMG are always akimbo, and the engine draws one gun);
  the index holds 206 weapons of the wire's 256. `patch_common_mp.ff` rebalances
  nothing and only adds 143 DLC weapon files, so the catalogue is built from base
  `common_mp` ([reverse/s1-zone](../../reverse/s1-zone/README.md#the-weapons)).
- **A clip's translation key means something else**: it adds to the model's own
  `tagPositions`, not by asset type
  ([reference.md](reference.md#animations)). Read IW's way, AW's type-1 body
  clips sink the head into the chest.
- **A player is a costume, not a body model**: eleven items (shirt, head,
  pants, gloves, gear...) resolved through string tables that only
  `english/eng_patch_code_post_gfx_mp.ff` carries, each item a model from its own
  part zone (`mp_shirt_*_tr.ff` and so on, about 2,500 of them). The cast is the
  default costume and the 18 bot costumes, built by `catalog --dump aw` rather
  than harvested from maps
  ([reverse/s1-zone](../../reverse/s1-zone/README.md#the-characters)).
- **Its `GfxStateBits.loadBits` is six words where IW6's is three**: the
  rasterizer state, the 64-bit depth/stencil state, and one blend state per
  render target. Reading the first three under IW6's rules **swaps
  `less_equal` and `disabled`** on every material and changes nothing else, so
  it cannot be spotted in a render. The material dumper rebuilds the three
  D3D11 states the zone itself caches from the same words and refuses to write
  if they disagree
  ([reverse/s1-zone](../../reverse/s1-zone/README.md#the-state-bits)).
- **Its generated (`*`) materials blend every layer in one pass**, unlike IW6's
  `*r`/`*a` pair, so there is no second pass to drop -- but the layer weights
  are in vertex RGBA just the same (`LAYER_WEIGHTS_BY_GAME` is `"generated"`).
- **Five texture-slot hashes and three texture semantics have no name.** The
  dump writes the number, as it does for any slot a game does not share.
- **No `.iwd` archives at all**, so `Backend.pictures` is `"zone"`, as Ghosts'
  is. The streamed images are in `imagefile<N>.pak` beside the fastfile, a span
  per `GfxImage.streams` entry, each carrying the fastfile payload's own LZ4
  framing rather than IW6's single zlib stream.
- **Its contents bits are Ghosts', and it says so itself.** The X360 server
  build carries the engine's `infoParms[]` as data, so nothing is guessed from
  `clip_*` names. **The row is 20 bytes, not IW6's 24** — read at 16 the table
  still yields real keyword names one in every five, with another row's numbers
  beside them ([reference.md](reference.md#collision)).
- **Its surface-type field is six bits, not five.** AW names 52 surfaces
  (`cushion` is `0x03400000`), inserts `metal_grate` at 14 and moves `cushion`
  to the end, so 17 of IW's 31 indices mean something else and reading it IW's
  way renames most of a map's surfaces into other real ones.
- **Soup clips are walls**, as on Ghosts: 5,336 of mp_prison's 65,739 soup
  triangles, mostly `clip_nosight_metal` and `clip_nosight_rock`.
- **A static model's footprint has no world collision**, the same holes the
  shell has, because a building that is one static model carries its own
  collision, which `props.world` gives it as a hull.
- **Both companion zones are dumped, and named rather than defaulted**:
  `games.json` lists `common_core_mp.ff` and `common_mp.ff`, because the default
  list would add `common.ff`, which is `S1ffu100` and which `ff.py` does not
  read. A map's own model can borrow its LOD surfaces from a companion
  (`,metal_scrap_debris_01_lod0101`), so the companion's dump keeps the surfaces a
  map names; every map places every prop it references.
- **Path nodes** are a `PATHDATA` (type 27) in `<map>_path.ff`, IW6's struct
  with `pathVisBulletBlockers` and 32 `pathAbilities` names added, and IW6's
  `nodeType` numbers. No MP map fills `pathAbilities` or a node's `pathAbility`
  (bar one name on mp_instinct), and the "angles given" spawnflag is 0x80000
  rather than IW's 0x8000. `s1/paths.py` walks it (it began in
  [reverse/cod-pathdata](../../reverse/cod-pathdata/README.md)) and closes on all
  16 path zones; the `pathdata` dumper reads it for the world's `nav.bin`
  ([navigation.md](navigation.md#ghosts-and-aw-from-the-path-zone)).

## Adding a game

Check, in this order: which backend can walk the zone (`zonecode/` where OAT's
ZoneCode describes the game, else one of its own); the vertex stride and layout; the technique
enum's UNLIT/EMISSIVE/LIT indices (then watch `check_state_flags`); what its
technique-set and material names mark as non-surfaces and decals; where vertex
colour keeps layer weights; the IWI header version; the contents bits
(re-derive from the zone's `clip_*` materials); the worldspawn key spellings and
light scale; what its lightmap pages hold, and how many there are; how soup
indices address vertices. Add the game to `GAMES`,
`TECHNIQUES_BY_GAME`, `SURFACES_BY_GAME`, `shell.LAYER_WEIGHTS_BY_GAME`,
`pack.RGB_IS_LAYER_WEIGHTS_BY_GAME`, `CONTENTS_BITS_BY_GAME`,
`LIGHT_SCALE_BY_GAME`, `worldfile.WS_KEYS_BY_GAME` where its worldspawn keys are
numbers, `lightmap.convert` where its lightmap is not IW4's,
`shell.UNIT_VEC_BY_GAME`, `FLAG_TECHSETS_BY_GAME`,
`animations.SCRIPTS_BY_GAME`, `metadata.ZONE_GAMES` (and `MODE_ASSETS` where a
map does not say which modes it ships in a stringtable) and, where its entity
keys are numbers, `entities.KEY_NAMES_BY_GAME`. For the players it draws:
`characters.CLIP_ROLES_BY_GAME`, `ANIM_TYPE_SUFFIX_BY_GAME` and
`HEADS_ARE_A_BODYS_BY_GAME`, none of which any two games have so far shared.

A 32-bit game OAT's ZoneCode describes takes a `zonecode.backend.Backend` and a
`dumpers/` registry, as IW4 and T5 did. Any other needs a backend of its own, as
Ghosts and Advanced Warfare have: an object with the interface `backends.py`
describes, added to `backends.BACKENDS`, which writes each kind in the
[dump tree](pipeline.md#the-dump-tree)'s schema. `scripts/cod/iw6/dumpers/` is
the pattern: one writer per kind. `scripts/cod/xmodel_glb.py` writes a model LOD
in the dump's GLB layout and
`xanim.encode` a compiled clip, from plain data, for any such backend.
[Husky](https://github.com/Scobalula/Husky) has independent GfxWorld readers
for Black Ops 1–3, useful for cross-checking struct layouts.
