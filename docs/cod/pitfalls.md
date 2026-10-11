# Pitfalls

Almost every problem in this pipeline produced a result that loaded, rendered
and was wrong. Each entry is the symptom you will see, the cause, and what now
guards against it. Where the guard is an assertion, it prints in the export log.

## Method

The expensive mistakes were reasoning mistakes, and they repeat:

- **Check that a test could have failed before believing it passed.** Two
  "independent" measurements that agree may be one measurement (a 1:2 pixel
  ratio "confirms" any 1:2 pair of sizes). A classifier checked only on
  blended materials cannot show it misclassifies opaque ones.
- **Ask what a statistic would look like under the opposite hypothesis.** RGB
  channels correlating at 0.993 means _no_ colour, not colour data; the
  lightmap was in the alpha.
- **Read the fact before inferring it.** Blending, cutouts, shadow casting and
  texture slots were all guessed from histograms while the material JSON
  stated them. Scale was measured off a minimap while the fastfile held the
  coordinates.
- **A note in a document is not a guard.** A trap written down here was
  repeated in new code anyway. Anything that produces a plausible wrong result
  gets an assertion.
- **Identical per-item statistics across all items mean broken attribution**
  (overlapping vertex ranges gave every material the same 49.5%).
- **Share of geometry is not importance.** 2.8% of mp_estate's triangles, a
  missing texture, turned out to be the cladding of the map's centrepiece house.
- **One map is not a game.** "IW4 does this and IW5 does not" was concluded
  from one IW5 map that happened not to.
- **"The inputs are missing" is not "the inputs cannot be reconstructed."**
- **When judging a render, suspect the client first.** Use a fresh browser, and
  compare with `pnpm shots` from `hold` poses; a pixel diff between two
  free-falling first-person runs measures the camera (57% "difference" that was
  0.55%).

## Extraction

**An image comes out as an older, different picture.** Two `.iwd` archives in
one folder can hold the same file, and the game takes the **highest-named**
(`iw_23.iwd` patches `iw_02.iwd`): MW3 has seven such images, among them
`loadscreen_mp_dlc` and `playercard_scanlines_512` (DXT1 in `iw_04`, 24-bit
colour in `iw_23`). `iwd.read(..., newest=True)` asks for the game's order and
the IW5 image dumper uses it; the loadscreen, minimap and streamed-sound readers
still take the lowest-named, which is what their golden exports were made with.

**Props missing, logged as "did not export".** The asset is defined in a
companion zone (`common_mp.ff`) and referenced with a leading comma. Guard:
companion zones are always dumped and the comma stripped. DLC maps sit away
from theirs; `games.json` passes them. A Black Ops zombies map has a third
companion: the region-dependent models and decals (Pentagon's morgue cadavers,
Kino's lobby doors and flag) are in `English/en_<map>.ff`, which `maps.json`
names as `../English/en_<map>.ff`. The MP maps' `en_` zones hold no models.
A model the map does define can still name one LOD's surfaces with a comma
(MW3's and MW2's team flags); without its companion it is placed at the 0.1 m
default and draws nothing. Guard: the `xmodel` writer takes them from the
companion and warns about any it cannot find
([pipeline](pipeline.md#comma-named-surfaces)).

**A zone type is in the asset listing and nowhere in the walk.** Ghosts'
`common_core_mp.ff` lists 63 `ATTACHMENT` assets and the walk records none:
every one of those entries is an alias to an attachment a weapon already loaded
in full, which is how embedded assets work throughout an IW6 zone
([reverse/iw6-zone](../../reverse/iw6-zone/README.md#pointers-and-handles)).
Counting the listing and concluding the type is missing is the trap. Guard:
`iw6/dumpers/attachment.py` reaches them the way the game does, through
`WeaponCompleteDef.scopes` / `underBarrels` / `others`, and finds 66.

**A Ghosts weapon has no sounds at all.** Its 54 sound aliases are real in the
zone, but the emulated Durango loader resolves each through
`DB_FindXAssetHeader`, which `emulate.py` stubs to zero, so the field is null by
the time anything reads it. Written out as keys they would say "this weapon is
silent". Guard: the weapon dump does not write a sound key at all, so
`Backend.writes` reports them absent rather than empty
([games.md](games.md#ghosts-iw6)).

**Exporting one map rewrote another game's world.** MW3 and Black Ops II both
ship an `mp_village`, and `export mp_village` exported every `maps.json` entry
with that zone name: `village-mw3` was re-exported beside `village-bo2`, which
also undid its props harvest and re-harvested its cast into the catalogue.
Guard: a zone name that is more than one map is refused and the worlds are
named; a world's own name picks one (`test_maps.py`).

**One map exports with no HUD map, and the log says its compass image is in no
dump.** The picture is the image the `compass_map_<map>` material names, and that
need not be `compass_map_<map>`: BO2's `mp_nuketown_2020` draws
`compass_map_mp_nuketown2020`. Guard: the minimap stage also tries every image the
dumped compass material names (`materials.material_images`,
`test_the_minimap_is_the_image_the_compass_material_names`).

## Geometry

**Ground dark on top and lit from below; shadows wrong.** Inside-out faces.
Guard: winding is reversed and `check_winding` verifies it against the normals.

**Copies of objects piled at the world origin, invisible walls nearby.** Brush
models read as world geometry (see [reference.md](reference.md#brush-models)).
Guard: `brushmodels.preflight` refuses a dump that cannot place them.

**One prop missing in the browser, and `pnpm check` calls its file "not found"
though it is on disk.** Advanced Warfare names a map's own copy of a model
`<model>@<map>`, and `@3d/api` serves no path segment with `@` in it, so the
request 404s. Guard: `pack.served_path` spells every packed file the api's way,
and every lookup from a model name goes through it (`test_s1_models.py`).

**Vehicles hovering over their shadows; all props facing one way.** The wrong
entity key chosen as origin or angles. Guard: keys ranked by how many entities
carry them; the log names the rival keys.

**A `.world` value has four numbers where three were written.** Scientific
notation (`1.6e-15`) that the DSL tokenizer splits. Guard: `props.num` never
writes exponents.

**Normals slightly off-length, shading subtly wrong.** A PackedUnitVec decode
that ignores the scale byte. Guard: `check_unit_vectors`.

**Minimap "not axis-aligned with the world"; positions plotted on it land
beside the buildings.** The image's up is CoD +X unless worldspawn sets
`northyaw` (see [reference.md](reference.md#minimap)), and its extent comes from
the two `minimap_corner` entities, not from measuring the picture. Guard:
`test_minimap_up_is_cod_x_by_default`; `export_metadata.json` carries the four
image corners in both frames.

**A world's HUD map disappears after a re-export.** `minimap.world` is written
only when the stage has both a frame and an image, and is removed when it has
not — so any run that cannot reach the picture takes the map with it. It is easy
to arrange: `--metadata-only` dumps no images, and a game whose compass picture
is a zone image rather than an `.iwd` entry (Ghosts) has nowhere else to read it
from. Guard: `export_minimap` falls back to the `minimap.png` already beside the
world, and says so (`minimap.png (kept)`).

## Materials and lighting

**Every surface in a new game has another pass's culling and blend.** The wrong
LIT technique index. Guard: `check_state_flags` against `stateFlags`.

**Two thirds of a Black Ops map untextured.** Generated layer materials are
written under a rewritten filename. Guard: `material_file_stem`.

**Terrain in magenta, cyan and yellow patches; palm fronds magenta.** Layer
weights in vertex RGB (T5), or RGBA of generated materials (IW6). Guard:
`shell.LAYER_WEIGHTS_BY_GAME` and `pack.RGB_IS_LAYER_WEIGHTS_BY_GAME`
(`test_generated_surfaces_lose_their_layer_weights`).

**A shared material stripped of its textures and state (IW6).** A map names a
companion zone's material with a header alone, under a leading comma, and the
map is dumped last. Guard: the IW6 material dumper skips comma names
(`test_material_dump_is_what_materials_py_reads`).

**A reveal mask, dust or thermal map as the colour.** Texture tables are sorted
by hash, and these share the `colorMap` semantic. Guard on IW6: the texture
named `colorMap` (`SurfaceRules.colour_map`). IW4, IW5 and T5 still take the
first ([reference.md](reference.md#materials)).

**Ground and walls see-through; or hard edges at every material transition.**
Vertex alpha treated as opacity everywhere, or nowhere. Guard: transparency
comes from the material's render state only.

**Foliage invisible.** Prop vertex alpha (a wind weight, max 0.11) multiplied
into a 0.5 alpha test. Guard: `pack.neutralize_vertex_colours`.

**Canopies with burnt black edges, or stripped to trunks.** `ge255` mapped to
1/255, or to 1.0 after a 512 px resample. Guard: `ALPHA_CUTOFFS["ge255"] = 0.5`.

**Blank white walls standing in buildings.** Tool surfaces (`caulk_shadow`,
`shadowcaster`), never lit in game, sample white lightmap space. Guard: dropped
by techset. A material sampling near-white over its whole area is almost always
one the game never drew.

**Opaque slabs across every window.** Volumetrics (`falloff` techsets). Guard:
dropped.

**A river painted blue-violet; white cards lying over the ground (IW6).** A
`distortion` material's normal map drawn as colour, and `onlycast` shadow cards
drawn at all (both in mp_prisonbreak's first shell). Guard: both dropped by
`SURFACES_BY_GAME` (`test_iw6_surface_rules`).

**Doorways that cannot be walked through.** `hdrportal_*` exposure planes
across openings, when colliding against render geometry. Guard: dropped as
non-surfaces; collision now comes from the clipmap.

**Half the map unlit, or hard-edged unlit and blown regions.** The lightmap
read from RGB, or from the wrong atlas. Guard: the secondary's alpha, kept at
full resolution.

**Every Black Ops map blown to white.** Treyarch's worldspawn values on a
different scale. Guard: `LIGHT_SCALE_BY_GAME`.

**Every chart of a Ghosts lightmap half green and half blue-grey.** Its
secondary page is the atlas stored twice down the image -- the ambient lobe over
the highlight lobe -- so read as one tall atlas each chart straddles the two.
Guard: the pages are summed, and `lightmap.py` reads the secondary as `height /
2` ([reference.md](reference.md#lightmaps)).

**Half a Ghosts map lit with the other half's light.** Nine of its 21 MP zones
keep two lightmap pages, each a texture of its own with its own chart layout and
its own size, and every surface names the one it uses. Stacked into one image
without moving each surface's UVs, the surfaces on page 1 sample page 0's
charts, which looks like a map lit plausibly but wrongly. Guard:
`shell.move_lightmap_uvs`, from the `lightmapIndex` the IW6 dumper writes.
It walks the **index buffer**, not `firstVertex + vertexCount`: that range
overlaps its neighbours' (three of mp_frag's surfaces declare the same 29
vertices), and a range walk drags other pages' vertices with it -- which shows
up as a count of "shared" vertices larger than the map has
(`test_two_lightmap_pages_stack_and_each_surface_moves_into_its_own`).

**Every MW2 map with house-default lighting.** Quoted entity keys missed by
the parser. Guard: quotes optional; every key spelling tried.

**Decals as vivid opaque patches, black blobs, or grey rectangles at range.**
Engine-side, covered in `packages/client/src/scene/importedMaterials.ts` (`blendedMaterialFor`): a
multiply decal drawn as alpha blend, tone mapped before blending, lit twice, or
fogged. Exposure is not a decal control.

**A colour map reported MISSING on every map of a game, and nothing untextured.**
The texture stage asked for the image of every material the shell names,
including the non-surfaces it then drops: BO2's `wpc/shadowcaster` names an image
`shadow` that no zone holds. A false MISSING on every map hides a real one.
Guard: `materials.surface_images` leaves the dropped materials out.

## Collision

**Invisible slabs stretched across the map, only on big maps.** Soup indices
read without their segment. Guard: segments applied; a map over 65,536
vertices without them is refused.

**Walking into nothing.** Usually the map's own clip brushes, which is correct.
Press `X` to see them; picking one names its contents and clip material.

**Wireframes showing starbursts of lines across the map.** Zero-area triangles
from clipping. Guard: repeated vertices dropped; the export asserts none
survive.

**Every bomb site and radio zone is a wall (Black Ops).** Trigger brush models
carrying SOLID. Guard: only `script_brushmodel` and `glass` collide.

**Streets closed by walls nobody can see, in Team Deathmatch (Black Ops).** The
wager modes' barriers are `script_brushmodel`s the game deletes in every other
mode ([game-mode objects](reference.md#game-mode-objects)). Merged into the
ordinary collision they cut the bot graph and the map. Guard: each is a
collision part with its modes; `export_collision` asserts the base and the parts
add up to every triangle, and `test_a_brush_model_only_some_modes_have_is_its_own_part_and_loses_no_triangle`.

**Soup ground dropped on Black Ops.** Walkable soup is `0x2080` with no SOLID
bit. Guard: soup is classified by its clip bits, not SOLID.

**Invisible walls around shrubs; glass debris you cannot walk over.** A model in
the clipmap's list collides with _something_, not necessarily the player.
Guard: each XModel's own `contents`.

**Models you walk through.** A collision BVH built before async model loads
finished. Engine guard: the scene awaits every pending load before building it.

**Every brush model's walls missing from a Ghosts map's collision.** A
`cmodel_t.info` there points at the game's global `clipMap_t` in the
_executable_, which the loader's own fixup writes and which means "the map's
ClipInfo". Read as a ClipInfo of its own it is an empty struct, so every submodel
reports no brushes and the dump looks merely sparse. Guard:
`clipmap.clip_info` compares it with the clipmap's own `pInfo`
(`test_a_submodel_pointing_at_the_games_global_clipinfo_is_the_maps_own`).

**Every angled wall in a Ghosts map is a box.** A brush's bevel planes live in a
plane array the zone streams long before the clipmap, so nothing wrote them into
the emulated loader's memory and every one read back as a zero normal. A brush
that keeps no bevel is exported as its own bounding box: a rotated wall lands
axis-aligned, filling the space beside it, which reads in game as collision in
the wrong place rather than as collision of the wrong shape. Mantle volumes and
ladders come off the same faces and lost their rotation with it. Guard:
`iw6/dumpers/clipmap.plane` refuses a zero normal, and `Emulator._page` serves
aliased VIRTUAL pages from the zone
(`test_a_bevel_plane_the_zone_streamed_before_the_clipmap_is_still_read`).

**Walking off the edge of a Ghosts map.** Its rock faces are bounded by
_soup_ player-clips, thousands of triangles a map, not by brushes. Classified as
Black Ops' are they would carry `collides: false`. Guard:
`collision.SOUP_CLIPS_COLLIDE_BY_GAME`, and the per-game call is in
[reference.md](reference.md#collision).

## Animation

**A pump jack's arm tears off its beam; tarps collapse or bones fold into the
root.** A clip's rotation composed with the bind rotation instead of replacing
it, or its translation taken as absolute rather than an offset. Guard:
`test_clip_rotations_replace_the_bind_pose_and_translations_add_to_it`; the
evidence is in [reference.md](reference.md#animations).

**An animated prop lies on its side or points along the wrong axis.** A channel
on the root joint written without the model GLB's Z-up → Y-up rotation, which
lives on that joint (`xmodel_glb.py`). Guard: `animations.clip_to_gltf` composes it; same test.

**Every copy of a model plays the same clip where the map mixes two.** The
model's clips looked up by model alone. Guard: the entity's own
`precache_script` decides (`test_each_entity_plays_the_clip_its_own_script_names`).

**Every animated prop on an IW5 map stands still.** IW5's scripts are compiled
and named by number, so none is found by `precache_script`. Guard: every
`.gscbin` is scanned; the export log counts `animated_model` entities left
still and names their models.

**Every animated prop on a Ghosts map stands still.** The byte before the
model's literal in a compiled script is printable there (`|`), so the model was
read as `|com_roofvent2_animated` and matched no entity. Guard: the model is the
name that ends its run
(`test_a_compiled_ghosts_script_names_its_model_after_printable_reference_bytes`).

**Ghosts foliage thrown about, or static canopies swelling.** `flagext` sets
drawn with IW5's fixed waves, which are many times their own amplitude, and
static-model surfaces, which hold no weight, read as full weight. Guards:
`FLAG_TECHSETS_BY_GAME` (`test_only_ghosts_flag_sets_take_iw5s_flag_shader`),
and the IW6 dump writes weightless flag surfaces with alpha 0.

**Rocks and logs missing from a Ghosts map, or never colliding.** Its `mv/`
model names hold a folder, which a lookup by file name loses, and the clipmap
lists them without it. Guard: models are keyed and packed by their path under
`model_export`, and `props.py` matches `mv/<name>` to `<name>`.

**A clip decodes into plausible nonsense.** A misread field shifts everything
after it, and a shifted quantised track is still a smooth curve. Guard:
`xanim.decode` must end exactly at the end of the file, or it raises.

**Flag grass and cloth never move.** The vertex alpha is the wind weight, and
`neutralize_vertex_colours` forces it to 1. Guard: `keep_flag_weights` copies it
to `_FLAG_WEIGHT` first (`test_flag_weights_survive_the_vertex_colour_neutralising`).

**Shadows of animated props jump as you walk; a swinging tarp vanishes near the
screen edge.** Engine-side, in [rendering.md](../engine/rendering.md#animated-props):
the static shadow map redrawn with whatever pose a rig had, and bounds measured
at rest. Guards: the bind-pose depth material and `sampleAnimatedBounds`.

## Viewmodels

**The hands float off the gun and every forearm is twice as long.** A view clip's
translations added to the bind pose, as a prop's are. View clips are asset
type 1, whose translation keys are the translation itself
([reference.md](reference.md#viewmodels)). Guards:
`animations.TRANSLATION_BY_ASSET_TYPE`
(`test_asset_type_1_translations_are_the_translation_itself_not_an_offset`), and
the export refuses a view clip of any other type.

**The hands hold nothing and the gun sits at the rig's feet.** `j_gun` hung from
`tag_weapon` but left listed under the model GLB's `<model>_skel` node too; the loader
attaches a node to whichever parent it meets first. Guard:
`graft_hands_skeleton` requires exactly one parent and moves it
(`test_the_gun_hangs_from_tag_weapon_and_nowhere_else`).

**A foliage rig is chosen as the player's hands.** The xmodel dump's `"type":
"viewhands"` is inferred from bone data, and `foliage_desertbrush_3_animated`
passes. Guard: `view_hands` wants the `viewhands_` name as well
(`test_view_hands_need_the_name_as_well_as_the_type`).

**The hands pack with no bones in them, and a hostage's are worn instead.** A
Ghosts camo variant is a whole XModel whose bone arrays point at the first
variant's bytes rather than following it in the stream, so four of the five
`viewhands_us_rangers_*` dumped as six meshes and no skeleton: they pack, they
render, and nothing can pose them or graft a gun onto them — leaving
`viewhands_gs_hostage`, which alone carried its own, as the only pair a default
would take. Guard: the walker resolves such a pointer with `z.located`, and the
xmodel dumper counts and reports any skinned model that came out with no joints.

**A Ghosts player wears a hostage's hands.** `default_hands` takes the
alphabetically first pair that is not a ghillie's, a sniper's or a juggernaut's,
and `viewhands_gs_hostage` sorts before every `viewhands_us_rangers_*`. Guard:
`SPECIAL_HANDS` names hostages too
(`test_default_hands_are_a_teams_everyday_pair`).

**A weapon exports without its clips.** The weapon file says `viewmodel_M4_idle`,
the asset is `viewmodel_m4_idle`. Guard: `role_clips` matches case-blind and
the log names any clip it cannot find.

**The idle never settles, or the rig goes to NaN.** Every idle is one frame, all
its keys at t = 0, and three gives such a clip duration 0. Guard:
`buildViewmodelRig` takes each clip's length from the weapon definition
(`gives a one-frame clip its real length` in `tests/viewmodel.test.ts`).

**Two rear sights in the sight picture.** The folded `tag_sight_off` drawn over
the raised one; MW3's `hideTags` does not list it. Guard: `hidden_bones` always
adds it (`test_hidden_bones_always_fold_the_backup_sight_when_the_gun_has_one`).

**Every Ghosts weapon plays its melee clip as its reload.** A clip role is a
slot in `weapAnimFiles_t`, and IW6's enum is not IW5's — its RELOAD is 16 where
IW5's is 9, and the 41 slots OAT has a key for are scattered through 124. Read
with IW5's numbers a weapon file names real clips for every role and the wrong
one for most. Guard: `iw6/dumpers/weapon.ANIMS` is IW6's own enum, checked
against its slot names in `test_a_clip_role_names_iw6s_slot_not_iw5s`, and the
AK-12's slots (1 idle, 3 fire, 16 reload, 90 ads_up) match its clip names.

**An attachment override names the wrong attachment.** A row in a weapon's
`animOverrides` names what it applies to as sixteen bits — `scope:3,
underBarrel:2, other:8` — and IW6 stores them with no structure at all, so
widths read wrongly still index a real attachment, of the wrong kind. Guard:
`combination` refuses any row that does not name exactly one attachment the
weapon actually carries (`test_an_override_row_names_exactly_one_attachment`).

**A weapon is refused because its clips move the gun.** Four Ghosts weapons
animate the gun's own root under the hands' `tag_weapon`, which is the gun
swinging in the hands and is what the animator meant; only the rig's root and
the eye may not move, or a clip would carry the camera with it. Guard:
`FIXED_BONES` is `tag_origin` and `tag_view`
(`test_a_clip_that_moves_the_eye_or_the_rigs_root_is_refused`).

**A weapon is refused because it has no `j_gun`.** Ghosts' riot shield roots at
`tag_riotshiled`, and no clip names either — the root is only where the graft
hangs the gun from `tag_weapon`. Guard: `gun_root_joint` takes `j_gun` when the
rig has one and its single root joint otherwise
(`test_the_guns_root_is_read_off_the_rig_when_it_is_not_j_gun`).

**The gun glows in a dark room.** Engine-side: the overlay's sun copy had no
shadow. It shares the world light's shadow, with the rig drawn at the eye's
world position ([rendering.md](../engine/rendering.md#the-viewmodel)). Guard:
`copyLights shares the sun's shadow` in `tests/viewmodel.test.ts`.

## Characters

**A game is declared to ship no player clips at all.** Read with MW3's names,
Ghosts' `common_mp.ff` has no idle, no run and no reload, and stage 9 stops
saying so — while the clips are all there under other names. Guard:
`CLIP_ROLES_BY_GAME`, one table per game, and a stage that names the game it
found no idle for (`test_clip_names_reads_each_games_own_names`).

**A character stands in its bind pose with no standing reload and no ADS fire.**
The role bound to a `pt_` name only, when Ghosts spells those two clips
`mp_stand_reload` and `mp_core_stand_fire_ads` — asset type 1, keying the same
153 spine-up joints as `pt_stand_shoot_auto`, so torso clips in everything but
the prefix. Guard: judge a clip by the joints it keys, not its name
([reference.md](reference.md#characters)); the export reports any role whose
clip drives no joint of the player skeleton.

**A strafing body's feet slide against a running one's.** The four directional
run clips taken from two families because one family is missing a direction —
Ghosts' `pb_combatrun_forward_loop` has every weapon class but `_assault`. One
stride clock drives all four ([rendering.md](../engine/rendering.md#player-characters)),
so they have to be one set. Guard: Ghosts' four come from `pb_hold_run*`, the
only complete family (`test_clip_names_reads_each_games_own_names`).

**Two teams in the same uniform.** A zone that ships one faction, split into an
"allies" and an "axis" by whatever `SIDES` happened to match — or by two camos of
one body. Every Ghosts map is one faction: its bodies are named for themselves
instead, and the export says so in its log.

**A world ships one side, and the other is simply absent.** Twelve of the sixteen
MW2 worlds shipped like that for weeks: the world loads, the team that is there
renders perfectly, and the only sign was a `!!` line nobody read. Two causes,
both naming:

- **A faction missing from `SIDES`.** No body matched, so there was no body to
  export for that side. MW2's allies are `tf141` and its axis the Russian
  `airborne`, and neither was in the table.
- **A head paired by leading words only.** MW2 writes the same family either way
  round — `mp_body_desert_tf141_assault_a` wears `head_tf141_desert_a` — and
  spells the allied one `ally` on a body and `allies` on its head, so the two
  share no leading word at all and scored zero.

Guards: heads are paired on words shared anywhere in the name, ties broken by the
leading run (`test_head_for_reads_mw2s_spellings_of_the_same_family`), and a
chosen body whose head cannot be found now **fails the export** rather than being
skipped (`test_pick_refuses_a_body_it_cannot_find_a_head_for`).

**A body wears a plausible head that is another body's.** The same weak match,
one step short of dropping the character: the militia's `_blk` bodies wore
`head_militia_a_wht`, the one head belonging to the `_wht` body, because the
variant they agree on is the _last_ word of both names; and MW3's
`mp_body_opforce_ghillie_urban_sniper` wore `head_opforce_henchmen_sniper`, which
is `mp_body_opforce_henchmen_sniper`'s own. Guard: the same word-share pairing.
To check a map's pairing against the game's own, dump its rawfiles and read
`zone_source/<map>.zone`: each head is listed under the body that wears it.

**A body packs with six meshes and no joints.** The skeleton-aliasing trap, which
reaches bodies exactly as it reaches view hands — see the entry under
[viewmodels](#viewmodels). Guard: the xmodel dumper's `a skinned model came out
with no joints`; a body with no `j_gun` to hang the weapon from then fails the
export outright, and one with no `torso_stabilizer` is reported as unaimable.

**A zombie's uniform draws white while its face is textured.** Its body wears
materials another zone defines (`,mc/mtl_c_ger_honorguard_zombie_linen`), whose
copy in the map zone is a stub with no texture table, so the xmodel dump names no
colour map for them and packing finds nothing to be missing. Guard:
`actors.fill_colour_maps` reads the companion's material JSON
(`test_a_companion_material_gets_its_colour_map_once_per_image`); see
[reference.md](reference.md#ai-bodies-black-ops-zombies).

**A zombie walks at the wrong pace, or its role table silently loses a variant.**
Clip names written by hand drift from the game's (`_walk_altA` is the clip
`_walk_alta`; `walk7` is `v9` on every map but theater). Guard: the roles are read
out of `_zombiemode.gsc`'s own arrays, comments stripped, and a reference that
matches nothing stops the build (`test_a_role_that_names_nothing_stops_the_build`).

## Effects

Seventeen separate misreadings of `FxEffectDef` each produced a plausible
picture — a blue-grey sandstorm, white clouds, a wall of sand, nothing at all —
before the engine's own code settled them. They are listed with what settled
each and the test that now guards it in
[reverse/iw5-fx](../../reverse/iw5-fx/README.md#the-wrong-turns). The short version: read the decompiled
FX code before reasoning from a render, and count emitters, particles and visible
batches before theorising about a blank one.
