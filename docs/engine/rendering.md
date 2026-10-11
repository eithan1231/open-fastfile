# Rendering notes

Why the renderer is set up the way it is. Code comments point here for the
long version.

## The frame

`engine/render/` owns how a frame is drawn, and a rendering feature plugs into
one of its four mechanisms rather than into the viewer's loop or `App`.

- **Passes** (`pipeline.ts`). A frame is the named passes in `PASSES`, in that
  order. A feature fills its slot with `viewer.pipeline.use(name, pass)`; a new
  kind of pass is a new name in the list, which is where its order is decided.
  Each pass is timed under its name (the dev stats' `passes` line), CPU
  submission only.
  1. **world** draws the scene into the frame target (`target.ts`): linear, half
     float, 4× multisampled, keeping its depth as a texture. No material tone-maps
     or fogs here; the shadow map renders inside it when invalidated.
  2. **output** (`output.ts`) draws that onto the canvas in three's own order:
     tone mapping (with the grade), the sRGB encode, then fog from the depth — so
     a fully fogged hill is the sky's colour, as it is when three fogs a material.
     The sky's pixels (depth still 1) pass through untouched, as
     `scene.background` always has. This is the one program the grade is in.
  3. **effects** draws particles onto the canvas after that, in display space
     and untouched by tone mapping, as [effects](#effects) explains; with no world
     depth on the canvas, each tests against the target's depth in its shader.
  4. **viewmodel** draws the hands and weapon over everything, as before.

  A pass that draws a scene of its own names it (`RenderPass.scene`), so what
  reaches every material — a quality level's filtering and shadow filter —
  reaches it as well as the world's.

  What runs before the passes is the frame's update list
  (`app/frame.ts`, `UPDATES`): the same mechanism for the update half — named
  steps in a fixed order, each timed (the stats' `updates` line), where a step
  that needs another first says so. Effects update after the controls and the
  viewmodel, so they are judged from this frame's camera and zoom.

  One scene draw a frame is the point: the effects' soft fade used to draw the
  whole scene a second time to get its depth, which halved the frame rate
  wherever a map had smoke.

- **The scene's contents** (`roots.ts`). `viewer.roots` is the only thing that
  adds to or removes from the world scene: `setWorld` swaps a built world and
  its sky, `keep` adds a root that lives beside every world for the page (peers,
  corpses, actors, sound, the debug overlays). It also holds the world's fog,
  which is deliberately not the scene's: the output pass applies it.
- **Shader patches** (`patches.ts`). A per-material change to a three shader is
  a named `ShaderPatch` added with `addPatch`. A material runs its patches in
  order and keys its program on all of theirs, so two features compose; never
  assign `onBeforeCompile` or `customProgramCacheKey` directly, since the second
  assignment silently drops the first. A material built from another (a clone, a
  blend replacement) starts with none.
- **Chunks** (`chunks.ts`, `grade.ts`). Changes to three's own chunks reach every
  program, so they are installed once by the `Viewer` before any material
  compiles — never on import. The ranged-light falloff is one; the grade is the
  other, set per world, and reaching only the output pass and the viewmodel.

**The prewarm.** The last load step, `viewer.prewarm()`, does a first frame's
work behind the loading screen: each pass compiles its own programs for its own
render target (three keys a program by target, so a pass into a texture needs
variants the canvas does not), then a frame as play would draw it, then one with
culling off and the shadow map invalidated — every object drawn once into the
view and every shadow map, so casters' depth programs compile and every texture
uploads — and then it waits on a GPU fence for all of that to finish. A pass
whose programs it cannot reach that way says how in its own `prewarm`. Whether
it worked is `pnpm perf`'s `late programs` and `stall`
([debugging](debugging.md#performance)).

## Imported materials

An imported map's materials arrive as glTF, which can only say OPAQUE, MASK or
BLEND. The exporter carries the rest of the game's render state in each
material's `extras` (`sortKey`, `blend`, `castsShadow`), which GLTFLoader copies
onto `material.userData`. `packages/client/src/scene/importedMaterials.ts` turns it back into
three.js settings; `packages/client/src/scene/models.ts` applies it per mesh.

**Shadow casting.** three's shadow pass copies `alphaTest` and `map` into its
depth material but ignores blending, so a blended quad shadows its whole
rectangle (a wall decal would shadow the wall it is painted on). MASK cutouts
keep casting. Where the game's own flag is present it wins: it disagrees with
"not blended" in both directions (sky, tool surfaces and `_nocast` props do not
shadow; chainlink and grating do, alpha-tested). DSL worlds use the fallback.

**Shadow side.** three renders a single-sided material's _back_ faces into the
shadow map (the "second depth" trick). That suits closed solids and fails for
what a map shell is made of: thin brush slabs and single-quad panels, which
then cast nothing. Imported geometry became single-sided when the exporter
began honouring `cullFace` (150 of mp_dome's 156 shell materials), so
`setShadowSide` pins `shadowSide = FrontSide` for them.

**Draw order.** CoD draws strictly by `sortKey`: 1 is the opaque world and 6 up
are overlay tiers laid on top (gravel over concrete, graffiti, papers,
puddles). Coplanar triangles have exactly equal depth, so without the key the
winner is decided by rasteriser interpolation and flickers with the view
angle. `applySortKey` sets `renderOrder = sortKey` and a polygon offset of
`-tier` depth-buffer units. The offset's slope factor must be **zero**: the
surfaces are coplanar with what they sit on, so a constant separates them
uniformly, whereas a slope term grows without bound on surfaces seen edge-on
and drags a large ground plane through the walls in front of it. Transparent
overlays stop writing depth so they cannot occlude the tiers above them.

**Blend equations.** Most decals are not alpha blends: on mp_dome's decal pass
20 of 28 multiply, 7 add, 1 screen. `blendedMaterialFor` replaces such a
material with an unlit `MeshBasicMaterial` using the game's equation:

- multiply is `ZERO/SRC_COLOR` (three's `MultiplyBlending`); add is `ONE/ONE`,
  not `AdditiveBlending` (`SRC_ALPHA/ONE`), because 27 of the 28 textures have
  no alpha; screen is `ONE_MINUS_DST_COLOR/ONE`.
- **Unlit**: the result is `decal × wall` and the wall is already lit, so a lit
  decal applies the lighting twice and goes black in sunlight.
- **Not tone mapped, not fogged**, and needing neither: the world pass does
  neither, so the GPU blends `decal × wall` in linear light and the
  [output pass](#the-frame) tone-maps and fogs the product once. Doing either
  per material would be wrong: `ACES(decal) × ACES(wall)` lands a 0.2 decal over
  a 2.0 wall 4.2× too dark at exposure 0.35, and fog mixes toward the sky colour,
  which no decal equation treats as "no effect".
- **Faded by vertex alpha** toward the equation's identity (white for multiply,
  black for add and screen) in the fragment shader, because none of these
  equations reads alpha. Without it every decal shows the hard edge of its quad.
  The material must stay `transparent` or three pins alpha to 1.

Replacements are cached per source material in the world's `AssetStore`, so
every placement shares one and instancing can still pool them.

**Layered materials.** A material carrying the `COD_material_layers` glTF
extension draws up to three more textures over its base colour in one pass,
each weighted per vertex (`scene/layers.ts`). A GLTFLoader plugin resolves the
textures after the root, because the loader clones a material per vertex-colour
variant and a clone carries none of its source's [shader patches](#the-frame). The layers mix right after
`map_fragment`, so the vertex colour, the lightmap and fog apply to the result
once, as in the game's shader. The textures live in a `WeakMap` rather than
`userData`, which `Material.copy` deep-copies through JSON. Each mode and where
its numbers come from: [layered materials](../cod/reference.md#layered-materials).

**Lightmaps.** The atlas is sampled with the second UV set (`channel = 1`;
channel 0 tiles into the hundreds on a map shell), with glTF's vertical
convention (`flipY = false`), clamped, and without mipmaps: neighbouring charts
are unrelated parts of the map, so mip levels bleed them together, and because
the mip level jumps at chart boundaries the result is bright or dark seams.
`lightMapIntensity` is a uniform and is set on every build; `lightMap` is a
compile-time define and only changes when the texture does. The lightmap
mutates materials shared by all placements of the asset, which is right for
the one case it serves (a shell placed once). `LIGHTMAP_SCALE` puts a texel in
the same units as an ambient light, and a lightmapped world gets no automatic
sky fill (the bake already contains it; adding the fill quadrupled mp_dome's
ambient).

**Skinning is baked out** of every still placement. CoD rigs foliage and
vehicles, and a SkinnedMesh cannot be instanced. `scene/bake.ts` resolves the
skin once at load: on interchange-mw3 about 4,100 draw calls became about 500.
An `animate:` placement keeps its rig instead ([animated props](#animated-props)).

**Collision proxies.** A `collide: box` proxy is sized from the asset's measured
bounds (a pivot can be at the base, the centre, or below the geometry), hidden
by material (`HIDDEN_COLLIDER`) because `visible = false` would drop it from the
BVH, and tagged `userData.collider` so picking resolves it to its prop.

## Shadows

`engine/shadows.ts` fits each directional light's shadow frustum **at
runtime**, for two reasons:

- **It needs the finished scene.** `buildScene` returns before the models have
  arrived, so a fit there sees an empty graph on any world made of models.
  `WorldSession` fits after "load assets".
- **It follows the player.** A CoD map's content sphere is 1–2 km across
  against a ~100 m playable area; covering all of it is ~2 m per shadow texel.
  The frustum covers `shadowFocusRadius` around the camera instead.

Three details are load-bearing:

- The authored light **direction** is captured once and kept. Fitting moves
  the light, so re-deriving the direction from its position would walk the sun
  across the sky.
- The focus centre is **snapped to whole shadow texels**, or every shadow edge
  crawls as you walk.
- Both biases are expressed **in texels**, not metres. Acne drifts by
  `texelSize × tan(light-to-normal angle)`, so a bias in metres is right at one
  resolution only. Texel sizes here run from 0.7 cm (a small interior covered
  whole) to 11.7 cm (a CoD map focused at 120 m).

A moving frustum does not make the shadow map dynamic. With a static scene and
light, the map stays correct until the player leaves the region it covers, so
`ShadowFit.update` asks for a re-render only on those crossings. `ShadowPolicy`
is the switch to per-frame fitting once something animates.

## Colour grade

A world's `grade` (a CoD `.vision` film tweak for imported maps) is compiled
into three's tone-mapping stage by overriding `CustomToneMapping`'s GLSL
(`engine/render/grade.ts`), which the [output pass](#the-frame) runs once per
pixel; the viewmodel, drawn straight onto the canvas, tone-maps through the same
chunk. The output pass keys its program on the grade, so a new grade recompiles
it. Its `gamma` is the last step, after tone mapping and the tints and before
three's sRGB encode, so it bends the displayed curve without touching lighting.

## Quality levels

`engine/quality.ts`: low, medium and high set the pixel-ratio cap, shadow type,
shadow map size and focus radius (tuned together: their ratio is the texel
size), the smallest mesh that still casts, and anisotropic filtering (1, 4 and
16, capped by the GPU). The level is remembered per browser. Texture resolution
is fixed at export; a real texture-quality lever needs compressed textures
(KTX2) and a higher export cap.

## Animated props

An `animate:` model loops a glTF clip on its own skeleton; an imported map's
windmills, tarps and foliage play the game's own clips this way (the data:
[docs/cod/reference.md](../cod/reference.md#animations)). Everything else about
a built world stays static, so an animated prop is the exception to each item
in [a static world](#a-static-world), taken one at a time:

- **The rig survives the bake.** `AssetStore` clones a glTF that has clips
  before `bake.ts` flattens it, and keeps both. Still placements clone the
  baked mesh and instance as before; animated ones clone the rig
  (`scene/models.ts`). A rig's bounds are sampled across its clips
  (`scene/animation.ts`), since a SkinnedMesh measures them once at rest and
  a tarp blown sideways would otherwise be culled while on screen.
- **Matrices.** `engine/animator.ts` owns the mixers. It runs after "freeze
  matrices", turns `matrixAutoUpdate` back on for the rigs it plays, and calls
  `updateMatrixWorld` on each rig every frame, since the scene no longer does.
- **Shadows stay at rest.** The shadow map is only redrawn when invalidated, so
  a skinned caster would be frozen in whatever pose it had at that moment and
  jump at every re-fit. Each animated mesh gets a `customDepthMaterial` with
  the skinning chunks removed, which draws the bind pose.
- **Collision is at rest**, as in the game: the BVH is built before the
  animator starts, and `StaticGeometryGenerator` reads the pose the bones are in.
- **Instancing** already skips skinned meshes, so each animated mesh is one
  draw call. dome-mw3's 193 animated props cost 217 draw calls and about
  0.35 ms of mixer updates and 0.3 ms of matrix updates a frame (RTX 4070 Ti).

Copies start at a phase derived from where they stand (`phaseOf`), so a field
of brush does not sway in lockstep and a given pose always renders the same.
A held pose link pauses the animator, which is what keeps `pnpm shots`
reproducible; `T` pauses it in a development build.

**Flag wind** is the other moving thing: the game's `flag` vertex shader,
ported in `scene/flag.ts` and applied at load to any material the exporter
marked with `flag` extras. It depends only on time (`AssetStore.shaderClock`,
advanced by the animator) and per-vertex data, so it instances unchanged. Only
the main pass deforms; shadows keep the rest pose, as above.

## The viewmodel

The first-person hands and weapon (`engine/viewmodel.ts`; the data behind them
is in [docs/cod/reference.md](../cod/reference.md#viewmodels)). They are drawn
in a **pass of their own**: a separate scene and camera, rendered after the
world into the same framebuffer with only the depth cleared (the `viewmodel`
[pass](#the-frame)).

- **It cannot clip into walls**: nothing of the world is in its depth buffer.
- **The static world never sees it.** It is in no built scene, so frozen
  matrices, instancing, the collision BVH, the shadow map, picking, the
  collider view and `H` all pass it by, and none of them needs an exception.
  Its scene is a few dozen nodes and updates its own matrices.
- **Its own field of view.** The guns are posed for the game's `cg_fov` 65
  (horizontal at 4:3, 51.08° vertical); the world camera's 70° vertical would
  shrink and stretch them. Its near plane is 1 cm: hands come that close in a
  reload. Aiming zooms both cameras by the weapon's `adsZoomFov`.
- **The world's grade and exposure** reach it unasked: it draws onto the canvas,
  so its materials tone-map with the renderer's tone mapping, and the grade is
  in that chunk, installed before the viewmodel is built. It has no fog.
- **Lit where the player stands.** Its scene holds copies of the world's sun
  and ambient light, and the rig is drawn at the eye's world position. Each sun
  copy shares its source's `shadow`, so the gun samples the world's own shadow
  map and falls into shade indoors exactly where the walls do. The map is only
  rendered with the world pass (`needsUpdate` is spent by then), so the
  viewmodel never casts into it. What it lacks is the lightmap's bounce light:
  facing away from the sun, it is darker than the wall beside it. The game
  lights it from its light grid, which is not exported.
- **A scope is drawn instead of the weapon, not through it.** A weapon with an
  `adsOverlay` (every sniper rifle, and a fitted thermal) swaps the whole rig for
  one full-screen quad at full aim: the scope picture, multiplied onto the frame
  the world pass left. The picture is a white circle on black with its reticle
  drawn in, so multiplying is what makes the black a tube; it is a square of the
  screen's height, centred, and the quad is the whole screen with the UVs making
  the square — the texture is clamped and its edge is black, so the bars either
  side cost nothing. Nothing about it is tone-mapped: the output pass has already
  written encoded colour, as the game's own 2D pass assumes. It is all or nothing
  at `ads === 1`, as the game is — fading between a gun and a scope would show
  the receiver filling a 15° field of view on the way — and it waits for the
  picture to load rather than aiming at a blank screen. Where the overlay comes
  from: [the importer's reference](../cod/reference.md#viewmodels).
- Two render calls a frame reset `renderer.info` twice, so the viewer turns
  `autoReset` off and resets once per frame; the draw counts cover both passes.

**The rig** (`scene/viewmodel.ts`) is the weapon GLB's skeleton, which carries
the hands' joints with the gun grafted on, wearing the view hands, whose skinned
meshes are rebound to it by joint name. A mesh's bind matrix is identity (the
loader's), so where it hangs in the graph does not move it. Surfaces touching a
hidden joint — **or anything parented under one** — are hidden (`hideByBones`),
as the game skips them: a weapon file names one tag per attachment and the whole
attachment hangs below it.

A joint the hands have and the weapon does not is **copied into the rig** rather
than refused. The weapon carries the hands skeleton of the game it was exported
from, and the two differ: Modern Warfare 3's hands bring a `tag_knife_attach2`
that no Modern Warfare 2 weapon has heard of. Throwing there left a player
empty-handed whenever their class named a gun from the other game.

Fitted attachments hang on the gun's own tags. A model's root joint names the tag
it belongs on, except for the five rigid ones that have no joints at all — see
[the importer's reference](../cod/reference.md#attachments) for where their mount
comes from and why they need OAT's axis change undone.

**Playback.** `engine/player/weapon.ts` (`WeaponController`) runs the weapon: commands
in (`setInput`, `reload`, `raise`, `drop`, `restore`), events out (`play`,
`note`, `shot`, `reloaded`, `state`), no three.js. Its whole state is one plain
`WeaponData` object (`weapon.data`): state, held input, timers, ammo, the ADS
fraction and the clip playing, by role. It is part of the player's state
([player](player.md)): the weapon belongs to the player, which steps it on each
input, and the viewmodel only draws it. [Scripts](scripting.md) are meant to
drive the same commands. States last as long as the weapon file says and each
clip plays at the rate that fits it into its state. The viewmodel mirrors `play`
events on one mixer with short crossfades; a shot restarts the fire clip from
its first frame. ADS is a separate action on `tag_ads`, scrubbed by the ADS
fraction, and can start during the sprint-out clip. The weapon owns the
sprint too: running forward asks for it (the sprint rule in `player/input.ts`), airborne or not (`grounded` drops out
for single frames on any downslope). Reloading, aiming or firing pauses it and
a held sprint comes back once they are done; a new sprint press cancels a
reload. The trigger takes the weapon out of a sprint but does not fire out of one:
the round waits out the weapon's own `sprintOutTime` and leaves on the tick that
ends it, the arms blending up into the shot. **A bolt-action
weapon works its action between shots** (`boltAction` in the weapon file), which
is a state of its own and as blocking as a reload: no shot and no sprint for
`rechamberTime`, though the sights stay up. That is most of the time between two
shots — an MSR's `fireTime` is 0.05 s against its 0.865 s `rechamberTime` — so
one read without it fires as fast as the trigger moves. An emptied magazine
skips it: the empty reload works the bolt itself. **A shotgun is loaded a shell
at a time** (`roundsPerLoad`): a `reloadStart`, then a `reload` per shell, then
a `reloadEnd`, and the trigger breaks out of it after any shell with whatever is
already in the tube — which is the whole point of loading one at a time. A reload pressed
while a shot still holds the weapon (`fireInterruptibleTime`) is queued, not
dropped, and beats the next shot; with aim held, a reload drops the sights in
half of `adsOutTime`. Movement runs only while the weapon is in a sprint state
(`WeaponController.sprinting`, which `Player.step` hands to movement), so each
of those slows the player to a walk for as long as it lasts.
`engine/weaponMotion.ts` adds walk bob, idle sway, lag behind a turning view, a
jolt when the player's vertical speed changes (a jump, a landing) and gun kick
about the eye: the game's formulas are not in the data, so these are
approximations on the weapon file's parameters, seeded so a pose is repeatable.
It is cosmetic and local, so it is not part of `WeaponData`.

A held pose starts the weapon at idle instead of raising it, and neither the
player nor the arms move until it is released, so `pnpm shots` renders it the
same every time. The animation toggle (`T`) stills only the arms: the weapon
runs on, and the arms cut to its current clip when released. The dollhouse
hides it.

## Player characters

The bodies other players are drawn as (`scene/character.ts` builds one,
`@3d/shared/sim/pose.ts` **decides** the pose and `engine/characterAnimator.ts`
draws it, `net/remotePlayers.ts` owns one per peer; the data is in
[docs/cod/reference.md](../cod/reference.md#characters)). They live **beside the
built world, not in it** — a root added straight to the scene, which updates its
own matrices, the same opt-out [animated props](#animated-props) make.

- **The pose is decided in `@3d/shared`, not here.** `poseLayers(movement, weapon)`
  returns which clips carry weight and where in each, as a pure function; the
  animator gives the mixer those weights and phases and turns the aim joint. That
  split exists because a bullet is traced against a posed skeleton: a server has to
  know where a peer's head was, and a pose decided separately on each end is a hit
  box somewhere other than the body on screen.

  **And that makes the mixer itself a pure function**, which is worth more than it
  sounds: every clip is paused and placed by its phase, so nothing about the output
  depends on `dt` or on what was asked before it. A server can therefore pose the
  same rig from the same snapshot with the same three.js and get the same bones —
  so there is no second sampler to write and no two blenders to disagree. It is
  asserted rather than assumed, in `tests/character.test.ts`: the same state twice,
  at three different frame times, and after a detour through a sprint and a mantle,
  all within a nanometre; and two tests that the bones _do_ move, or the rest would
  be vacuous.

  It cost two things. Every clip is **paused** and placed by its phase, so the mixer
  never advances time on its own. And seven fields joined the wire to replace what the
  animator used to remember for itself: `stride` (the run cycle's phase), `gait` and
  `airborne` (the blends, below), `travelForward` and `travelRight` (the heading,
  below), `landing` (already there), and the weapon's `span` —
  what its state timer started at, without which a countdown cannot say how far
  through a reload anything is.

### Blending, without giving up the hit box

Dropping the animator's weight smoothing made the pose reproducible and the game
visibly snappy. Both are had at once now, and the way there was to find out _where_
the snap actually was. Measured, by how much weight moves for an infinitesimal change
of state — 0 is continuous, 2 is a whole clip swapped:

|                             | before | after |
| --------------------------- | ------ | ----- |
| torso hip ↔ sights mid-fire | 4.0    | ~1e-5 |
| standing ↔ moving           | 2.0    | ~1e-5 |
| run ↔ sprint                | 2.0    | ~1e-5 |
| ground ↔ air                | 2.0    | ~1e-5 |
| idle ↔ idleAds              | 2.0    | ~1e-5 |
| torso appearing             | 1.0    | ~1e-7 |
| stopping                    | 2.0    | 0.36  |
| reversing direction         | 2.0    | 0.27  |
| _turning while running_     | _0.0_  | _0.0_ |
| _striding_                  | _0.0_  | _0.0_ |

So it was never blending in general — the four-way run blend and the stride were
already smooth. It was **six discrete switches**, and five of them were a threshold
throwing away a continuous value already on the wire. `ads > 0.5` is the clearest:
`weapon.ads` is a real ramp over the weapon's own `adsInTime`, discarded to pick one
of two clips. `sprintIn`/`sprintOut` are timed states, so their own phase is the ramp.
A torso overlay fades over the first and last `TORSO_FADE` of its state, so a 0.1 s
shot gets 8 ms of it and a 2 s reload 160.

The **seventh** is a change of heading, and it was still there until it was
measured: `runBlend` weighted the four run clips by the _direction_ of travel, and
the direction of a vector is discontinuous where the vector passes through zero.
That is every stop and every change of heading. Reversing out of a run put
`runBack` where `runForward` had been between two frames, and stopping put `idle`
there — 2.0 of weight in a single tick, both. Changing _speed_ never crosses zero,
which is exactly why walking to running was the one transition that always looked
right.

Nothing instantaneous fixes it: a reversal crosses zero in about three ticks, so a
function of the current velocity flips as fast as the velocity does. The smoothing is
`MovementState.travelForward`/`travelRight`, the unit direction of travel walked
towards its target over `TRAVEL_BLEND` **per unit** — so a stop takes one blend and a
reversal, which is twice the distance, takes two. Their _length_ is what the run
clips are weighted by, and the rest goes to the idle: the heading means least in the
middle of a reversal, which is where the legs listen to it least. Measured the same
way, a stop now moves 0.36 and a reversal 0.27.

The sixth, standing ↔ moving, could not be derived. **Keying it on speed was measured
and rejected:** a player accelerating from a standstill crosses `IDLE_SPEED` in a
single tick, so a speed-derived crossfade lasts 17 ms and is no smoother than the
switch it replaced. That one is `MovementState.gait`, a smoothed boolean stepped in
`stepMovement` (`advanceBlends`), with `airborne` beside it rather than derived from
`jumpFrom`, `sinceJump` and `landing` between them — those would each cover one way of
leaving the ground and disagree about walking off a ledge.

Two bytes, `GAIT_BLEND` is the animator's original 0.18 s, and the ramps are stepped
linearly and eased where they are read, so the shaping is one decision in one place.
The pose stays a pure function, so **the hit box is still exactly where the body is
drawn** — a transition is now a quarter-second during which the volume is genuinely
between two poses, identically on both ends.

`tests/pose.test.ts` sweeps every axis at 400 samples and refuses a step, which is
what stops a threshold coming back.

- **One rig per player.** A skeleton cannot be shared, so a `CharacterKit`
  holds the loaded files (which are shared, and the session's `AssetStore` owns
  them) and builds a body when someone joins. Which character a player wears is
  decided from their id, so every client dresses them the same.
- **The bodies are the catalogue's, not the map's.** A world used to list them;
  a gametype chooses them now, out of `catalog/characters/`, so a body can be
  worn in any map of its game — [scripting](scripting.md).
- **Nothing is sent to animate them.** A snapshot already carries the velocity,
  yaw, pitch, whether the player is grounded, and the weapon's own state, and
  the pose follows from those. Legs are idle, a four-way run blended by the
  direction of travel, a sprint, a jump or a landing; a fire or reload clip
  **replaces** the spine and above over them; the aim joint is turned by the
  player's pitch.
- **A torso clip is a mask, not an offset.** A `pt_` clip poses the spine and
  above fully — a reload is where the arms are, not a displacement from where
  they were — and the bones it keys are a subset of the ones a locomotion clip
  keys. They were made additive against their own first frame, which composed a
  reload's arm motion on top of a run's arm swing and drew neither pose. three
  has no bone mask; what it has is one **normalized** blend per property, so an
  overlay at weight `w` beside legs summing to 1 owns `w / (1 + w)` of a shared
  bone. `CharacterPoser.applyTorso` inverts that: the share `poseLayers` asked
  for becomes the weight that produces it, capped just short of 1 because a whole
  share is a weight of infinity.
- **One stride clock for the four run clips.** They are 43 to 56 frames long,
  so letting each run at its own rate slides a strafe's feet against a run's.
  The clock also carries the stride rate, which follows the ground speed.
- **Weights, not `crossFadeTo`.** The target pose is recomputed every frame from
  a state that can change every tick, so a fade started against one target is
  wrong by the time it finishes. Each action's weight walks towards its target,
  and the leg weights are normalised so a blend never mixes in the bind pose.
- **They cast no shadow and are not culled.** `shadowMap.autoUpdate` is off, so
  a moving caster would leave its shadow where the body used to stand; they
  receive the world's, which is where the shade in a map already is. Frustum
  culling is off because a run carries limbs well outside the bind pose's box,
  and there are only ever a handful of bodies.
- **A capsule is still the fallback**, not a leftover: a world that ships no
  bodies gets a capsule at the simulation's own radius and height, which is what
  shows whether a fault is in the state on the wire or the rig over it.
- **They take two clients to see.** Nothing draws a body for the local player,
  and `pnpm shots` cannot show one: a shot presses no keys and the world it
  loads has joined no match. `pnpm dev:mp` with two players ([one tab each](../server/README.md#one-tab-per-player)) is the check.

## Effects

Particle effects (`engine/fx/`) interpret the game's own effect definitions,
exported by the Call of Duty importer. What each field means, and how that was
established from `iw5mp.exe`, is in
[docs/cod/reference.md](../cod/reference.md#effects-fx) and
[docs/cod/effects.md](../cod/effects.md); this section is how the engine hosts it.

- **Beside the world, never in it.** `FxSystem` owns a scene of its own, which
  the `effects` [pass](#the-frame) draws after the world has been tone-mapped
  onto the canvas. Particles are written in **world space**, so its root and
  meshes never move and need no matrix update — effects sidestep the
  frozen-matrix rules below rather than opting out of them.
- **Simulated on the CPU.** The game's element logic is branchy (per-particle
  ranges, flag-selected frames, runners), so the runtime is one interpreter
  rather than a second copy in a shader. That also makes `seekTo` exact.
- **One draw call per material** (`engine/fx/batch.ts`): an
  `InstancedBufferGeometry` of quads expanded in the vertex shader, as a
  billboard, an oriented sprite or a tail. No shadows: `shadowMap.autoUpdate` is
  off, so a moving caster would leave its shadow behind.
- **Not tone-mapped.** Particle colour is display-referred, like the sky
  (`scene.background`, which three never tone-maps). Through a world's
  `exposure:` it would come out several times too dark. The shader still uses the
  standard prefix, for the output colour-space conversion and fog.
- **Blending is the material's own**, factor for factor, with straight alpha,
  and `keepAlpha` so a sheet never punches through the page. Both halves of the
  game's soft-particle fade are in: near the camera, and where a sheet meets
  geometry. The second reads the frame target's depth (`fx/sceneDepth.ts`),
  which every sheet also tests against in its shader instead of the GPU's depth
  test: the canvas it draws on holds none of the world's depth.
- **Deterministic.** Every random comes from a generator seeded by the placement,
  element and particle, never `Math.random`. A held screenshot pose calls
  `seekTo(POSE_TIME)`: a replay from zero in fixed steps, so the shot is the same
  every run and a particle system does not start empty.
- **The view-space position has to be called `mvPosition`.** The fog chunk reads that
  identifier by name. Anything else fails to compile as soon as a world has fog,
  and a batch whose program never links draws nothing while the system goes on
  simulating — neither typecheck nor the unit tests can see it. Check a shader
  change in the browser console.

Loading is its own step in `WorldSession.mount` ("effects"), after the freeze;
leaving a world calls `FxSystem.clear()`. The browser console reports emitters,
placements, and what was not drawn and why (`[fx] …`).

## A static world

Everything in a built world is static except [animated props](#animated-props);
otherwise only the camera moves. The [viewmodel](#the-viewmodel),
[player characters](#player-characters) and [effects](#effects) move too, but
none is in the built world — the first is drawn in its own pass, the other two
sit beside it in the scene. The renderer is configured for that, and
anything that moves a node must opt back in.

- **`shadowMap.autoUpdate = false`** (`engine/viewer.ts`). Left on, three
  re-renders a byte-identical shadow map every frame: a second full geometry
  pass (~2,300 draws on a large map). The map is invalidated explicitly: after
  a world is built, on a quality change, and when the shadow fit moves.
- **`scene.matrixWorldAutoUpdate = false`** (`engine/viewer.ts`) stops
  `render()` walking the whole graph to recompute transforms; on
  interchange-mw3 that walk was ~18 ms of a 38 ms frame, with every model
  hidden. Setting the flag on a subtree root does not help: in r169
  `updateMatrixWorld` recurses into children regardless.
- **`matrixAutoUpdate = false` on every node** after a build
  (`app/WorldSession.ts`, "freeze matrices"), once all assets and instancing
  batches exist. Readers that need world matrices (picking, collider view)
  update them explicitly.
- **Instancing** (`scene/instancing.ts`) pools repeated props into
  InstancedMeshes after the collision BVH is built from the real meshes.
- **The collision BVH** is built once per load from the finished scene.

[Animated props](#animated-props) opt out of each of these for their own
rigs only. Shadows that follow the animation would need `ShadowPolicy` in
`engine/shadows.ts` switched to per-frame, and the bind-pose depth material
removed.

## Lighting props (not built)

A world's shell can carry a baked lightmap ([lightmaps](#imported-materials));
its props cannot. A prop gets the live sun, shadowed, and the world's `fill`
ambient light, one flat colour for the whole world (a lightmapped world gets no
sky fill, `scene/scene.ts`). So the split between sun and shade is right, but the
light that fills the shade is not: a prop in shade is visibly darker and flatter
than the lightmapped wall beside it. The [viewmodel](#the-viewmodel) and player
bodies have the same problem.

What a source can supply for a prop is one of four shapes, and each is an option
here. Which source carries which is the importer's business: for the Call of
Duty games, [docs/cod/reference.md](../cod/reference.md#prop-lighting).

### The options

| Option                                                            | Data it needs                                                                                                                    | Engine changes                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. A constant light per placement**                             | one RGB per placement, in the lightmap's units: supplied by the source, or sampled from the shell's lightmap below the placement | a `model` property (for example `light:`); `instancing.ts` copies it into a per-instance attribute; a material patch that adds it to indirect irradiance; the importer writes it                                                                                                                                            |
| **B. Per-vertex light per placement**                             | a light per vertex per placement, supplied or baked at import                                                                    | a sidecar file, since this is too much data for the DSL; then either a mesh per placement, or a texture per batch indexed by `gl_InstanceID` and `gl_VertexID`; the GLB's vertex order must match the source's                                                                                                              |
| **C. The shell's lightmap, through a UV transform per placement** | a second UV set on the prop (a 0..1 unwrap), plus an offset, scale and atlas page per placement                                  | a per-instance `vec4`, moved into the stacked atlas the way the shell's UVs are; a lightmapped variant of each asset's materials (`lightMap` is a per-material define, and today the lightmap mutates materials every placement shares), cached in `AssetStore` as blend replacements are; a patch to the lightmap UV chunk |
| **D. A light volume sampled in the shader**                       | a grid of light samples over the world: supplied by the source, or probes the pipeline renders from the lit shell                | a 3D texture per world in `AssetStore`; every lit material patched to sample it by world position; a step that builds the probes                                                                                                                                                                                            |

| Option | Runtime cost                                                                                                                                                                           | What it gets right                                                                                                                   | What it gets wrong                                                                                                                                                                | Size         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| A      | 12 bytes per placement; instancing and the draw-call count are unchanged; one more shader program per material                                                                         | the level of indirect light on each prop, which is what is missing; the sun and shade across a prop still come from live shadows     | the indirect light does not vary across a large prop (a building's base and its roof) or with facing, unless the value is widened to an ambient cube or L1 SH (6 or 4 RGB values) | small: days  |
| B      | a mesh per placement costs a draw call each, and props are instanced because they once cost ~8 ms of CPU a frame; the texture form keeps instancing, at vertices × instances × 4 bytes | exact wherever the source has the data                                                                                               | a source rarely has it for more than a few props; for the rest, a bake of our own is a guess                                                                                      | medium–large |
| C      | no new texture, since the shell's atlas is already loaded under the same URL; 16 bytes per placement; one more batch wherever an asset has both lightmapped and other placements       | exact wherever the source lit a prop this way                                                                                        | only as many props as the source lit this way                                                                                                                                     | medium       |
| D      | one 3D-texture fetch per fragment; for example, 128×128×32 L1 probes at half float is ≈13 MB; instancing is kept                                                                       | light that varies across a prop and with facing; it also lights the viewmodel, player bodies and corpses, which no other option does | a coarse grid leaks light through thin walls, and a rendered probe sees only what the lightmap holds                                                                              | large        |

### What the engine already allows

Instancing does not stand in the way. three r169 draws per-instance attributes
routinely, and `engine/fx/batch.ts` already uses them. An attribute does not
depend on any matrix, so the frozen matrices of [a static world](#a-static-world)
do not affect it. three's depth shader reads no colour, so the shadow map is
unchanged. Both points come from reading r169's source; neither has been run.

`instanceColor` is not the right carrier as it stands. r169 multiplies it into
the vertex colour, which is the albedo (`color_vertex`), so it would scale the
sun as well. The value has to enter as irradiance, the way
`lights_fragment_maps` adds a lightmap texel. That means an attribute of our
own, or `instanceColor` re-routed, plus a [shader patch](#the-frame). The real
gaps are:

- **The DSL has no property for it.** `ResolvedObject` and `models.ts` would
  carry the value to `instancing.ts`.
- **A single placement is not instanced** (`MIN_INSTANCES`), so it needs the
  value some other way. A batch of one is the simplest fix.
- **Blend replacements must be skipped.** They are unlit decals. The patch
  composes with flag wind and layers through `engine/render/patches.ts`.
- **The `fill` ambient would count twice.** A three `AmbientLight` reaches every
  material, so props that carry their own light need it excluded.

### The order the engine side suggests

A is the foundation: it is the smallest, keeps instancing, and its per-instance
path is what C and D build on (C carries a UV transform on it instead of a
colour; D can start as A with the value taken from the volume at each
placement's origin). B is the one that fights instancing, so it is worth doing
only where A visibly fails and a source really has per-vertex light. Which of
them a given game can feed, and in what order to build them for the imported
games, is in [docs/cod/reference.md](../cod/reference.md#prop-lighting).

### What needs verifying on the engine side

- **The shader patch**, with flag wind, blend replacements, the fill light and a
  single placement, each checked in the browser console. A program that fails to
  link draws nothing, as [effects](#effects) warns.
- **The result, by eye**, before and after on a lit world, with
  `pnpm shots --compare`.
