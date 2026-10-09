# Authoring `.world` files

This is the complete reference for the world description language. Most of a
world is **generated** — `python3 -m scripts.cod export` writes the geometry,
props, spawns and lighting of an imported Call of Duty map — so what you
usually write by hand is the gameplay layered over it: spawns, triggers and
behaviours. Validate any edit with:

```
pnpm check worlds/<slug>
```

Fix every error it prints (each one names a file, line, and column) and
re-run until it says `ok`. Then `pnpm dev` and open the world to look at it.
If you're iterating with the dev server already running, just keep editing
and saving — the browser updates automatically without losing your camera
position.

## The idea

A world is one or more plain-text `.world` files under `worlds/<slug>/`, with
one file named `world.world` as the entry point. It declares the **assets** a
map is built from, places them with **model** nodes (usually inside a
**group**), points at a **collision** mesh, and layers the gameplay —
**spawn** points, **trigger** volumes, script **point**s, removable **solid**s
and **behaviours** — over the result.

A generated file says so in its header and is rewritten wholesale by the next
export; hand edits belong in `_overrides.json` or in a file of your own that
`world.world` `include`s.

---

## Axes and units

- **+X = east, +Z = south, +Y = up.**
- Lengths default to **meters**. You can write `12cm`, `1200mm`, `4ft`,
  `48in` and they're converted automatically.
- Angles default to **degrees**. You can write `1.57rad`.
- Numbers can be negative (`-1.5`) but units never have a space before them:
  `12cm` not `12 cm`.

---

## Syntax

```
world { name: "My World" }

asset crate { source: "assets/props/crate.glb", hull: 0 }

group props {
  at: 0 0 0
  model { asset: crate, size: 1 1 1, at: 4 0 -2, collide: hull }
}
```

- **Nodes** look like `type name { ...properties and nested nodes... }`.
  The name is optional for most types (`model { asset: crate }` is valid) but
  required for `asset`, since other nodes refer to it by name.
- **Properties** look like `key: value` or `key: value value value` (a
  vector — `at: 4 0 -2` is three numbers, x then y then z).
- Put a **comma** between properties written on the same line
  (`at: 0 0 0, rotate: 90`). A newline also ends a property, so this works
  too without commas:
  ```
  model {
    asset: crate
    rotate: 90
  }
  ```
  Do **not** rely on a bare space to separate two properties on one line —
  `radius: 2 height: 3` (no comma) will be misread as `radius` having two values.
- **Comments**: `// like this` to end of line. `# like this` also works, as
  long as what follows doesn't look like a color code.
- **Colors** are `#rgb` or `#rrggbb`. There is nothing an alpha channel would
  do here, and `#rgba`/`#rrggbbaa` are rejected rather than silently ignored.
- **Booleans** are `true`/`false` or `on`/`off`.
- **References** are a bare name (`crate`), naming a node declared elsewhere in
  the world — today an `asset`.
- **`include "path.world"`** at the top level splices another file's
  top-level nodes in at that point. Paths are relative to the including
  file. A file included from two places is only included once (no need to
  guard against that yourself); a file that includes itself, directly or
  through a chain, is an error.

Run `pnpm check` early and often — it reports **every** problem in a file
at once (not just the first), with a `did you mean "width"?`-style
suggestion for typo'd node types and property names.

---

## Node reference

### `world` (top level, no name, at most one per world)

| Property      | Type                                            | Default                             |
| ------------- | ----------------------------------------------- | ----------------------------------- |
| `name`        | string                                          | `"Untitled World"`                  |
| `description` | string                                          | —                                   |
| `category`    | string                                          | — (the picker's "Other" group)      |
| `game`        | `iw4` \| `iw5` \| `iw6` \| `t5` \| `t6` \| `s1` | — (not imported from a game)        |
| `ambient`     | color                                           | — (no extra ambient fill light)     |
| `sky`         | color                                           | — (no sky color, no fog)            |
| `visibility`  | number                                          | `300` (ignored unless `sky` is set) |
| `exposure`    | number                                          | `1.05`                              |

`category` groups the world in the main menu's picker. It is prose, and yours to
choose: imported maps write `"MW3 Multiplayer"`, `"BO Zombies"` and the like.

**`game` is the engine's, and `category` is the reader's.** It names which Call of
Duty the world was imported from, spelled as that game's **zone key** — the same
token the shared asset catalogue puts in its paths (`catalog/<kind>/<game>/<id>`,
`docs/cod/pipeline.md#the-shared-asset-catalogue`) — so a world and a catalogue
entry can be compared without a table mapping one spelling to the other. It is
what decides which game's player bodies and animation clips a world's players are
drawn with, and which game's catalogue sound bank its footsteps and landings come
from, so a world that declares none draws its peers as capsules and walks in
silence. `t6` is Black Ops II: its catalogue has no bodies, hands or weapons yet, so
its players are dressed and armed as Black Ops' (`t5`) until it does.

```
world {
  name: "Dome (MW3)"
  category: "MW3 Multiplayer"
  game: iw5
}
```

Like every enum in this format it is a bare word, not a string: `game: iw5`, not
`game: "iw5"`. An imported map gets it from the exporter; a hand-written world
has no game and should leave it out.

`sky` sets both the background color and an exponential fog of that same
color, so distant geometry fades into the sky instead of cutting off sharply.
It also contributes ambient sky light: a `HemisphereLight` (sky color above,
a muted earth tone below) that fills in shadowed faces whenever the world
declares its own `light`s — declaring any light switches off the engine's
default outdoor rig (see `light` below), and without `sky` or `ambient`
there'd be nothing left to light a surface facing away from every declared
light at all, which renders it pure black. `visibility` is roughly the
distance at which fog fully obscures things — it should comfortably exceed the
map's own diagonal, or its far edge will fog in visibly early.

`exposure` is the renderer's overall tonemapping exposure — lower it if a
world reads as washed out/overexposed, raise it if it reads too dark. It's a
single global multiplier, not a per-light control; if only specific lights
are too bright, adjust their own `intensity` instead.

### `grade` (top level, no name, at most one per world)

Colour grading: a tint per luminance zone, plus how far each zone is pulled
toward grey. This is the knob for a world's _tone_ — its overall colour
character — as distinct from its lighting, which is what `light` and
`exposure` control.

| Property            | Type            | Default |
| ------------------- | --------------- | ------- |
| `light-tint`        | 3 numbers (RGB) | `1 1 1` |
| `medium-tint`       | 3 numbers (RGB) | `1 1 1` |
| `dark-tint`         | 3 numbers (RGB) | `1 1 1` |
| `desaturation`      | number, 0–4     | `0`     |
| `desaturation-dark` | number, 0–4     | `0`     |
| `gamma`             | number, above 0 | `1`     |

The three tints are linear RGB multipliers applied after tone mapping,
blended smoothly by each pixel's luminance: `dark-tint` at black,
`medium-tint` at mid-grey, `light-tint` at white. `desaturation` is how far
bright pixels are pulled toward their own luminance and `desaturation-dark`
the same for dark ones — they are separate because a cool, slightly grey
shadow with saturated highlights is a very different look from the reverse.

Desaturation runs 0–4: `0` leaves colour alone and `1` is fully grey. Values
above 1 are accepted but behave as fully grey — past that, a blend toward grey
starts coming out the other side into complementary colours, which is not
something any grade wants.

Omitting the node leaves rendering exactly as it was; a `grade { }` with no
properties is the identity grade.

`gamma` is the last step: a curve applied to the finished colour as
`colour^(1/gamma)`. `1` is neutral; above 1 lifts the midtones and shadows
without moving black or white, below 1 deepens them. Where `exposure` scales
everything, including what is already bright, `gamma` is the knob for a world
whose dark interiors read too black while its highlights are fine. Values
outside 0.5–2.5 draw a warning; 0 or below is ignored.

```
grade { gamma: 1.2 }
```

Beyond that, a `grade` models tint and desaturation only. Overall contrast and
inversion are deliberately not modelled — use `exposure` for brightness. If
you are porting a grade from a source that has those as separate controls,
check they sit at their neutral values first.

Tints are **absolute multipliers on a 0–2 scale, where 1 is neutral** — so
`1 1 1` leaves a zone untouched, below 1 darkens it, above 1 lifts it. They
are used exactly as written, with no rescaling, so a value outside 0–2 is
almost always a units mistake (an 0–255 colour pasted in, say) and the
validator warns about it.

Because they are absolute, a grade changes brightness as well as colour: a
midtone of `1.08 1.09 1.10` is a deliberate 8% lift. Expect the brightest
highlights to clip — that is part of the look these values describe, not a
fault. `exposure` remains the right control for a world that is globally too
dark or too bright.

A warm-highlight / cool-shadow grade, the most common kind:

```
grade {
  light-tint: 1.59238 1.56238 1.40199
  medium-tint: 1.07764 1.0866 1.09892
  dark-tint: 0.706566 0.904928 1.05143
  desaturation: 0.191536
  desaturation-dark: 0.0538634
}
```

Red highest in `light-tint` warms the highlights; blue highest in
`dark-tint` cools the shadows. Invert the two for a warm-shadow look, or set
all three to the same hue for a straight colour cast.

### `asset <name>` (top level, name required)

A glTF/GLB model, declared once and placed by any number of [`model`](#model-name-optional-name-inside-a-group)
nodes (`worlds/interchange-mw3/` places 232 assets 8,420 times).

| Property  | Type                                              | Default      |
| --------- | ------------------------------------------------- | ------------ |
| `source`  | string — path to a `.glb`/`.gltf`                 | **required** |
| `catalog` | string — a catalogue entry, `<kind>/<game>/<id>`  | —            |
| `until`   | number — metres                                   | —            |
| `hull`    | `0`                                               | —            |

`source` is a path **relative to the world's folder**, exactly like a
material's `texture:` — put the file in `assets/` and write
`source: "assets/chair.glb"`. `pnpm check` reports a `source` that doesn't
point at a file.

```
asset chair { source: "assets/chair.glb" }
```

**`catalog` says which root `source` hangs off.** With it, `source` is the file
*inside* a catalogue entry rather than a path in the world:

```
asset com_barrel { catalog: "props/iw5/com_barrel_lod0", source: "com_barrel_lod0.glb" }
```

That is how a prop is shared between maps. `worlds/catalog/` holds the things that
belong to no one world (`docs/cod/pipeline.md#the-shared-asset-catalogue`), and an
imported map names ~300 props out of it rather than packing its own copies — which
is 643 MB across the 41 maps on this disk.

An asset always has a `source:`; `catalog:` only changes where it is looked for.
Two failures worth telling apart, and `pnpm check` does: a missing world file
wants the map re-exported, while a missing catalogue entry wants the catalogue
rebuilt (`python3 -m scripts.cod harvest`).

**One consequence to know about.** A world that names catalogue entries is no
longer self-contained: `pnpm check` on it needs a catalogue built for its game, and
a catalogue built from a different set of maps will report entries it has never
heard of. A hand-written world that only uses `source:` is unaffected.

**`until`** is the distance in metres beyond which the model should not be
drawn. Imported worlds carry the game's own value. The engine parses it but
does not cull by it yet, so today it has no visible effect.

**`hull: 0`** makes the asset's own mesh its collision shape, for placements
that say `collide: hull`:

```
asset streetlight { source: "assets/props/streetlight.glb", hull: 0 }
```

Use it wherever a bounding box would be a poor stand-in for the shape, which
is most thin or open props: a fence post, a railing, a lamp post, a tree. A
box around a 13.7 m streetlight is a 13.7 m tall wall of invisible air. Assets
with no `hull` fall back to a box, so leaving it out is always safe.

### `collision` (top level, no name, at most one per world)

The world's own collision mesh, used instead of colliding against whatever
happens to be visible.

| Property | Type                              | Default      |
| -------- | --------------------------------- | ------------ |
| `source` | string — path to a `.glb`/`.gltf` | **required** |

```
collision { source: "assets/collision.glb" }
```

This exists for **imported** maps, where the original game authored collision
separately from its geometry. A lot of it has no visible counterpart at all:
`worlds/interchange-mw3/` contributes 4,632 volumes that block the player and
are never drawn — the map boundary, the invisible walls over low cover, the
ledges you cannot walk off. It also _excludes_ scenery the game never collided
against. Neither can be recovered from render geometry.

The mesh is never drawn; it only feeds collision. A world that declares one
will usually also set `collide: false` on its shell, so the visible geometry
stops contributing a second, less accurate set of surfaces.

Build it with `python3 -m scripts.cod export` (see `docs/cod/README.md`). A
world without one has no clipmap: the only solid things in it are the prop
hulls its `model` placements carry. Named pieces of it can be made removable
with [`solid`](#solid-name-top-level-optional-name).

### `navigation` (top level, no name, at most one per world)

The world's path-node graph: where a bot may go, and the special moves (a
mantle, a jump down, a ladder) that join one place to another.

| Property | Type                         | Default      |
| -------- | ---------------------------- | ------------ |
| `source` | string — path to a `nav.bin` | **required** |

```
navigation { source: "assets/nav.bin" }
```

The file is a **node graph** in the engine's own binary format, specified in
[docs/engine/nav-format.md](../docs/engine/nav-format.md): nodes (places, some
with a facing, such as cover), the traversals between pairs of them, and
whatever links the source compiled. It holds the source game's truth only.
Where a node really stands, which walk links exist and what walking one costs
are all worked out when the world loads, against its `collision`, so a change to
the collision never needs the graph rebuilt. `K` in a development build draws
what the load makes of it, with the reason for every link a bot will not take
([debugging](../docs/engine/debugging.md#navigation)).

**A world without one simply has no bot navigation.** Nothing else about it
changes. `pnpm check` decodes the file and prints its node, link and traversal
counts, warns when the file is missing, and fails the world when it does not
decode. Imported maps get theirs from `python3 -m scripts.cod export`, and
`--nav-only` rebuilds it from the committed `export_metadata.json`
([docs/cod/navigation.md](../docs/cod/navigation.md)). Like the collision mesh,
it lives in `assets/`, so it is not in git.

### Who the players are — not a world's to say

A world used to declare its own people: a `viewmodel` named the hands and the gun,
and a `characters` listed the bodies other players were drawn as. **Both are
retired**, and a world that still declares one gets an error from `pnpm check`
telling it so.

They moved because they were never the map's business. A body a map packed could
only be worn on that map, so 42 imported worlds shipped ~17 MB of cast each to use
about 1 MB of it; and what a player *carried* was a property of the scenery. Who a
player is is now chosen by the gametype being played, out of the shared asset
catalogue — see [docs/engine/scripting.md](../docs/engine/scripting.md) and
`pnpm catalog`, which lists every cast a gametype can produce.

Nothing replaces them in the world file. The one thing a world still says is
which game it came from ([`world { game: }`](#world-top-level-no-name-at-most-one-per-world)), because
that is what decides whose bodies and whose clips its players are drawn with.


### `minimap` (top level, no name, at most one per world)

A top-down picture of the world for the HUD map, which sits in the top-left
corner while walking. The map turns so the player always faces up. The
player's arrow stays fixed in the centre.

| Property | Type                                                                      | Default      |
| -------- | ------------------------------------------------------------------------- | ------------ |
| `source` | string — the image (any format the browser shows)                         | **required** |
| `at`     | 2 lengths `x z` — the ground point under the image's centre               | **required** |
| `size`   | 2 lengths `width depth` — the ground the image covers                     | **required** |
| `rotate` | angle — turns the image's top away from north, as `rotate:` turns a shape | `0`          |
| `range`  | length — how far the HUD map reaches from the player to its edge          | `40`         |

The image is laid flat on the ground like a `plane`. At `rotate: 0` its top
edge faces north (−Z) and its right edge faces east (+X). It has no height, so
on a multi-storey world every floor shares the one picture.

```
minimap {
  source: "assets/minimap.png"
  at: 5.08 -24.587
  size: 103.632 103.632
  rotate: -90
}
```

An imported map writes this into `minimap.world` from the game's own compass
image and the two `minimap_corner` entities that place it
(`worlds/dome-mw3/minimap.world`). Its top usually faces +X, hence
`rotate: -90`. A world without a `minimap` shows no map.

### `model <name>` (optional name, inside a group)

A glTF/GLB asset placed in the world.

| Property                                      | Type                                                                 | Default      |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------ |
| `asset`                                       | name of a declared [`asset`](#asset-name-top-level-name-required)    | **required** |
| `size`                                        | 3 numbers — declared footprint                                       | **required** |
| `at`, `rotate`, `scale`, `collide`, `visible` | placement, see below                                                 |              |
| `lightmap`                                    | string — path to a baked lighting texture                            | —            |
| `lightmap-intensity`                          | number                                                               | `1`          |
| `decal`                                       | bool — coplanar overlay, biased out of the depth fight               | `off`        |
| `animate`                                     | string — the name of an animation clip in the asset's glTF           | —            |
| `tag`                                         | 1–8 strings — shared group handles, see below                        | —            |
| `mode`                                        | 1 or more strings — the game modes it exists in, see [Modes](#modes) | every mode   |

`decal: on` is for geometry that lies **flat on another surface** — an imported
map's stains, scorch marks, tyre tracks and painted signage. Coplanar triangles
have genuinely equal depth, so which one draws is decided by rasteriser noise
and changes with the viewing angle: the overlay flickers in and out as you turn.
`decal: on` biases it forward with a polygon offset and stops it writing depth,
so it settles on top and layers correctly with other decals. Use it only for
overlays that sit on something else; on ordinary geometry it will make the model
poke through whatever is meant to occlude it.

A model does not name a file directly — it references an `asset` declared at
the top level, the same way a shape references a `material` by name. Declare
the file once, place it as often as you like:

```
asset chair { source: "assets/chair.glb" }

group hall {
  at: 0 0 0
  model { asset: chair, size: 0.5 0.9 0.5, at: 1 0 2 }
}
```

`lightmap` is baked lighting: a texture added to whatever the scene's lights
already contribute, sampled through the asset's **second UV set**
(`TEXCOORD_1`) rather than the UVs its colour maps use. A greyscale map is
fine and usually what you want — it contributes intensity, leaving hue to the
scene's own lights. It only means anything
for an asset exported with that second set — an imported game map is the case
it exists for, where most of the light you see was baked at map-build time and
the live sun is a small part of the picture. Use `lightmap-intensity` to dial
it against the world's own lights.

`lightmap-intensity: 1` means a fully white texel contributes what
`light { type: ambient, intensity: 1 }` would, so it is directly comparable to
the intensities you give the world's own lights.

Two caveats worth knowing before you reach for it:

- The texture is attached to the **asset's** materials, so two `model`s sharing
  one `asset` necessarily share a lightmap. That suits the case it is built for
  — a map shell placed exactly once.
- A mesh with no second UV set is skipped rather than lit wrongly, and the
  console says so. If a whole asset lacks one, nothing happens and you get a
  warning naming it.

Two things about a model are worth stating, and both are deliberate:

- **`size` does not resize it.** It is the footprint you _declare_: resolution
  is synchronous and runs long before the `.glb` is fetched, so the size is
  stated rather than measured, and nothing checks it against the file. The
  asset draws at its natural size; use `scale` to actually resize it.
- **`material:` is ignored.** A glTF carries its own materials and textures,
  and overriding the whole asset with one flat material would throw away the
  look you imported it for.

**`collide: box` is usually what you want on scenery.** It collides against a
box measured from the asset's _actual_ bounds when it loads — not the `size` you
declared, because a model's pivot is wherever its artist left it (some sit on
their base, some are centred, some hang below their origin entirely). Two
reasons to prefer it:

- **Cost.** Imported meshes carry detail that has no business in a collision
  hull. One imported map's props came to 1.19M triangles at full mesh
  collision and about 11.5k as boxes — mostly razorwire barbs, container door
  fittings and vehicle panel lines nobody should ever snag on.
- **Safety.** Under `box`, none of the asset's own geometry enters the collision
  BVH at all, which sidesteps two failure modes of imported meshes: a nested
  mesh being counted twice, and a single non-indexed mesh aborting the merge and
  taking down collision for the whole world.

Use `collide: true` when the shape genuinely matters to movement — a staircase
you climb, a walkway you cross — and `collide: false` for litter and foliage.

```
asset desk { source: "assets/desk.glb" }
asset lamp { source: "assets/lamp.glb" }

group study {
  at: 0 0 0
  model desk1 { asset: desk, size: 1.6 0.75 0.8, at: 0 0 -1 }
  model { asset: lamp, size: 0.3 0.5 0.3, at: 0 0.75 -1 }
}
```

Note the `model`'s own name names the _placement_, while `asset:` names the
geometry — one asset placed twice is two names and one file.

#### Animated models

`animate:` loops one of the animation clips inside the asset's glTF, by name:

```
asset windmill { source: "assets/windmill.glb" }

group farm {
  model { asset: windmill, size: 2.5 15 6.5, at: 12 0 -40, animate: "windmill_spin_med" }
  model { asset: windmill, size: 2.5 15 6.5, at: 30 0 -44 }
}
```

The second windmill stands still: animation is per placement, not per asset.
The clip must animate the asset's own skeleton (a glTF `skin`); a name the file
does not contain leaves the model still and the console lists the clips it does
have. `pnpm check` cannot catch that, because it never opens the asset.

What to expect of an animated placement:

- **Copies do not move in lockstep.** Each one starts at a different point in
  its loop, chosen from where it stands, so the same world always looks the
  same.
- **It collides in its rest pose**, and its **shadow stays in its rest pose**.
  Both are computed once per load, as they are for everything else.
- **It costs a draw call of its own.** A still model is batched with every
  other copy of its asset; an animated one cannot be. A few hundred are fine.
- **A held pose link (`,hold`) stops time**, so screenshots reproduce; `T`
  (development builds) pauses and resumes animation.

Imported Call of Duty maps animate their windmills, pump jacks, tarps and
swaying foliage this way, with the clips the map itself plays;
`worlds/dome-mw3/props.world` is the worked example.

A model cannot sit at the top level — wrap it in a `group`, the same as any
other shape. Every imported Call of Duty world (`worlds/*-mw2`, `*-mw3`,
`*-bo1`) is a worked example: the map's shell is a `model` inside a `group`,
its props are thousands more in an `include`d `props.world`, and its collision
comes from a top-level `collision` node.

### `group <name>` (optional name, inside a group or top level)

A group is a positioning frame, not a visible object: give it `at`/`rotate` and
its children are placed relative to it, inheriting its rotation. Groups nest,
and each child's world transform is baked in during resolve, so the result is a
flat list. It is the only nesting the language has, and every `model` lives in
one.

### `light <name>` (optional name, inside a group or top level)

| Property    | Type                                            | Default |
| ----------- | ----------------------------------------------- | ------- |
| `type`      | `directional` \| `point` \| `spot` \| `ambient` | `point` |
| `at`        | 3 numbers                                       | `0 0 0` |
| `intensity` | number                                          | `1`     |
| `color`     | color                                           | white   |
| `shadows`   | bool                                            | `false` |

If a world declares **no** lights at all, a default hemisphere + sun
lighting rig is used instead, so a world with no `light` nodes still renders
reasonably. `intensity: 1` is a sensible baseline for any light type — you
don't need to reason about lux or candela, the engine's internal scaling
handles that.

### `spawn` (top level, no name, any number)

| Property | Type                                                                             | Default                 |
| -------- | -------------------------------------------------------------------------------- | ----------------------- |
| `at`     | 3 numbers — eye position                                                         | the origin, 1.7m up     |
| `look`   | 3 numbers — a point to face                                                      | one meter north of `at` |
| `mode`   | 1 or more strings — the game modes this point belongs to (`"tdm"`, `"dom"`, ...) | any mode                |
| `team`   | string — the side it belongs to (`"allies"`, `"axis"`, ...)                      | any side                |
| `start`  | bool — a round-start point, for the opening spawn of a match                     | `off`                   |

One bare `spawn` is all most worlds need, and it behaves exactly as it always
has. A world may also declare **many**, qualified by mode and side, which is what
an imported multiplayer map does — it is why everyone in a match does not start
standing inside each other:

```
spawn { mode: "tdm", team: "allies", start: on, at: -6.5 -7.2 -41.4 }
spawn { mode: "tdm", team: "axis",   start: on, at: 21.3 -9.6  12.7 }
```

A spawn with no `mode` belongs to every mode, one with several (`mode: "tdm" "dm"`)
to any of them, and one with no `team` to every side. When a game asks for a combination the map never anticipated, the engine
widens the request rather than finding nothing — so an unfamiliar mode still gets
somewhere to put a player. The **fallback** every world has is the first
unqualified `spawn`, or the first one declared if they are all qualified.

### `trigger <name>` (top level or inside a group; optional name)

A volume something can be inside. A trigger **draws nothing and does nothing on
its own** — the world file says where it is and what to call it, and the game
decides what being inside one means. Give it a `name` or a `tag` so something can
refer to it.

| Property | Type                                                                 | Default       |
| -------- | -------------------------------------------------------------------- | ------------- |
| `at`     | 1–3 numbers — the volume's centre (a cylinder's base)                | `0 0 0`       |
| `size`   | 3 numbers — a box's full extents                                     | — (see below) |
| `radius` | number — a sphere's reach                                            | — (see below) |
| `height` | number — with `radius`, a vertical cylinder standing on `at`         | —             |
| `rotate` | 1 number (yaw) or 3                                                  | `0`           |
| `tag`    | 1–8 strings — shared group handles                                   | —             |
| `target` | string — a tag this trigger points at, see [Targets](#targets)       | —             |
| `mode`   | 1 or more strings — the game modes it exists in, see [Modes](#modes) | every mode    |
| `use`    | `near` or `touch` — it can be used, and how it is reached            | —             |

Give **either** `size` (a box) **or** `radius` (a sphere); both, or neither, is
an error. A trigger inside a `group` takes that group's origin and rotation like
anything else placed in one.

```
trigger bombsite_a { at: 12 0 -4, size: 6 3 6, tag: "bombzone" }
trigger well { at: 0 0 0, radius: 4, height: 10 }
```

A player is **in** a trigger when their feet are inside the volume, and every
trigger answers that — a zone or a flag needs nothing more. **`use`** marks one
that can also be _used_, and says how a player reaches it:

- `touch` — the player's body touching the volume is enough.
- `near` — the player's eye is within reach (1.83 m) of the volume's centre, with
  nothing solid in between. Being inside is not needed, which matters for a thin
  volume such as a door's; keep the centre clear of the wall it is mounted on.

That it can be used is all the world says. Whether it must also be looked at,
the price, the prompt, whether it is usable right now and what using it does all
belong to the game's script, so none of them is a property here.

**An area is every trigger sharing a tag.** One box rarely fits a room that turns
a corner, so give each box the same tag and treat the tag as the area:

```
trigger { at: 4 0 -2, size: 6 3 4, tag: "balcony_zone" }
trigger { at: 9 0 -6, size: 3 3 8, tag: "balcony_zone" }
```

### `point <name>` (top level; optional name)

A tagged position with a facing, for whatever the game's script wants one for:
where a creature appears, where a player is sent back to, where a crate may
land. A `spawn` is the engine's — it is where players start — and a `point` is
the script's. It draws nothing.

| Property | Type                                                         | Default                 |
| -------- | ------------------------------------------------------------ | ----------------------- |
| `at`     | 3 numbers — the position                                     | **required**            |
| `look`   | 3 numbers — a point to face, as a `spawn`'s                  | one metre north of `at` |
| `tag`    | 1–8 strings — shared group handles                           | —                       |
| `target` | string — a tag this point points at, see [Targets](#targets) | —                       |
| `mode`   | 1 or more strings — the game modes it exists in              | every mode              |

A point sits at the top level only, so `at` and `look` are world positions.

```
point { at: -12 0 30, look: -12 0 28, tag: "foyer_spawners" "zombie" "riser" }
```

### `solid <name>` (top level; optional name)

A piece of the world's [`collision`](#collision-top-level-no-name-at-most-one-per-world)
mesh that **can be absent**: a wall that exists in only some modes, or a door
that the game's script removes when it opens. A part no `solid` names is simply
part of the map and always there.

| Property | Type                                                     | Default      |
| -------- | -------------------------------------------------------- | ------------ |
| `part`   | string — the part's name in the collision mesh (`"*12"`) | **required** |
| `tag`    | 1–8 strings — shared group handles                       | —            |
| `mode`   | 1 or more strings — the game modes it exists in          | every mode   |
| `use`    | `near` or `touch` — as a trigger's                       | —            |

```
solid { part: "*12", mode: "sd" "dd" }
solid { part: "*37", tag: "backstage_door" }
```

The part names come from the exporter, which splits such pieces out of the
collision mesh and writes these lines for them; you rarely write a `part` by
hand. A world with a `solid` must declare a `collision`, and two solids may not
name the same part — both are errors. A solid with no `mode` is present in every
mode, and a script can still remove it and put it back during a match.

### `mantle <name>` (top level or inside a group; optional name)

Where a player may **climb**. A mantle volume is a box **around** the thing to
be climbed — the crate, the wall, the sill — reaching a little past it on every
side, with **its top level with the surface they end on**. A player at any of its
four sides, facing in, climbs straight in through that side.

The volume is permission, not geometry: the engine finds the actual ledge in the
world's collision, straight ahead of the player and within 15 cm of the box's
top, and lands them on it. So the obstacle itself must be something that
collides, and a volume with nothing solid under its top edge climbs nothing. A
climb is also refused when the player would not fit — a beam overhead, a post on
the sill — so a volume never lets anyone through a wall.

Like a `trigger`, it draws nothing. Unlike every other volume in this file, it is
**not a collider**: a mantle volume that collided would be an invisible wall
round every ledge in the map.

| Property | Type                                                 | Default |
| -------- | ---------------------------------------------------- | ------- |
| `at`     | 1–3 numbers — the box's centre                       | —       |
| `size`   | 3 numbers — the box's full extents; `y` is the climb | —       |
| `rotate` | 1 number (yaw) or 3                                  | `0`     |
| `kind`   | `onto` or `over`                                     | `onto`  |
| `tag`    | 1–8 strings — shared group handles                   | —       |

`at` and `size` are both required, and `size`'s height must be above zero: a
volume with no height names no surface to climb to.

`kind` says which climb it is — `onto` ends standing on the surface, `over`
vaults across it and comes down the far side. An `over` with no room on the far
side is climbed onto instead. It is **optional, and usually absent**: the imported maps carry
it only where the source brush named it, which is not on every imported map
(Black Ops maps exported before its face flags were read have none). Absent
means `onto`.

> The game's own name for `onto` is `mantle_on`. It is spelled `onto` here
> because `on` is a boolean in this file (`shadows: on`), so `kind: on` would
> arrive as `true`.

```
// A waist-high wall you climb onto, turned to follow the wall it sits on. The
// wall itself is 0.3 m thick and 1.1 m long: the box reaches 0.2 m past it.
mantle { at: -18.4 0.7 -15.2, size: 1.5 1.09 0.7, rotate: 45, kind: onto }

// A railing you vault straight over.
mantle balcony_rail { at: 3 1.1 -8, size: 2.4 0.95 0.4, kind: over, tag: "balcony" }
```

Imported maps get these from the game's own mantle brushes, written to
`mantle.world` by the exporter — about 70 per map. They are in a file of their
own rather than in `gameplay.world` because `--gameplay-only` rewrites that one
from `export_metadata.json`, which has nothing about them in it.

### `ladder <name>` (top level or inside a group; optional name)

Where a player may **climb a ladder**. Unlike a mantle volume, the box **is the
ladder**: its extents are the ladder's own, and it should sit exactly where
something the player cannot walk through already stands. A player walking into
it (or falling onto it) grabs it; looking up climbs, looking down descends, the
strafe keys move along it, and jump pushes off. At the top, the climb carries
them over the edge onto whatever is there, so **put the landing level with the
box's top** and within a player's reach behind it. The full behaviour is in
[docs/engine/player.md](../docs/engine/player.md#ladders).

The node is permission, not a wall: **the ladder must also collide** — in an
imported map it does already, as the player-clip brush the node was made from.
In a hand-made world, give it a collider of the same size (a model with
`collide: true`, or a box in your `collision` mesh). A ladder with nothing solid
behind it is climbed into thin air, and one players can walk through is grabbed
from inside.

Like a `trigger`, it draws nothing.

| Property | Type                                                                  | Default    |
| -------- | --------------------------------------------------------------------- | ---------- |
| `at`     | 1–3 numbers — the box's centre                                        | —          |
| `size`   | 3 numbers — the box's full extents, all above zero                    | —          |
| `rotate` | 1 number (yaw) or 3; only the yaw is used                             | `0`        |
| `face`   | `front`, `back`, `left` or `right` — the one side that can be climbed | every side |
| `tag`    | 1–8 strings — shared group handles                                    | —          |

`face` names a side in the box's own frame, before `rotate`: `front` is the side
facing −Z (where a yaw of 0 looks), `back` +Z, `left` −X, `right` +X. Leave it out
and every side can be climbed — which is how the games build almost every
ladder, the back included. A side that cannot be climbed still stops a player's
reach, so it hides a ladder behind it.

```
// A 5 m ladder up the side of a water tower, climbed from the south (+Z) only.
// The box is 0.2 m thick, as the games make them; the tower's walkway, which
// collides, is level with its top.
ladder tower_ladder { at: 12 2.5 -30, size: 0.8 5 0.2, face: back }
```

Imported maps get these from the game's own ladder brushes (a handful per map),
written to `ladder.world` beside `mantle.world` and for the same reason.

### `fx` (top level, no name, at most one per world)

The **effect library** a world draws from: one JSON file holding every effect
definition its `effect` placements name, and the effects those name in turn.

| Property | Type                                | Default      |
| -------- | ----------------------------------- | ------------ |
| `source` | string — path to the library, `.json` | **required** |

```
fx { source: "assets/fx/effects.json" }
```

The library is written by the Call of Duty importer from the game's own effect
definitions; there is no format for authoring one by hand yet. See
[docs/cod/effects.md](../docs/cod/effects.md).

### `effect <name>` (top level or inside a group; optional name)

Where an effect **plays**: a sandstorm, a column of smoke, falling ash. The
definition in the `fx` library says what it looks like; this says where.

| Property | Type                                          | Default      |
| -------- | --------------------------------------------- | ------------ |
| `fx`     | string — the effect's name inside the library | **required** |
| `at`     | 1–3 numbers                                   | `0 0 0`      |
| `rotate` | 3 numbers — the effect's orientation          | `0 0 0`      |
| `delay`  | number — seconds before it starts (see below) | `0`          |
| `tag`    | 1–8 strings — shared group handles            | —            |

A group's origin and yaw apply to an effect inside it, as they do to anything
else. Unlike a `trigger` or `mantle`, an effect keeps **all three** rotation
axes: many effects are aimed — a spray at a wall, a sheet of sand laid flat —
not merely turned.

`fx` is a quoted string rather than a bare name, like `animate`: the effect lives
inside the library file, which the world is checked without reading. **A name the
library does not hold is not an error here** — it is reported in the browser
console when the world loads (`[fx] … unresolved`), and the effect simply does
not play.

`delay` is in seconds. A **negative** delay starts the effect already running, as
if it had been playing that long — which is what keeps a map's ambient effects
from visibly winding up as the world loads.

```
fx { source: "assets/fx/effects.json" }

// A sheet of blowing sand, laid flat and already running.
effect storm_east { fx: "weather/sand_storm_mp_dome_exterior", at: 24.5 -12.3 91.4, rotate: 2 -84 90, delay: -15 }

group courtyard {
  at: 10 0 -20
  effect { fx: "smoke/hallway_smoke_light", at: 0 0.5 2 }
}
```

Effects are drawn, never collided with, and cast no shadow. Imported maps get
them from the map's own effect script, written to `fx.world` (see
[docs/cod/effects.md](../docs/cod/effects.md)).

### `sounds` (top level, no name, at most one per world)

The **alias table** a world draws from: one JSON file holding every sound alias
its `sound` placements name, beside the clips those name in turn.

| Property | Type                                  | Default      |
| -------- | ------------------------------------- | ------------ |
| `source` | string — path to the table, `.json`   | **required** |

```
sounds { source: "assets/sounds/sounds.json" }
```

A sound is named by an **alias** and never by a file, which is the source game's
own model. One alias is usually several recordings — a footstep that is one file
is a machine gun of the same click — and it carries its own playback with it:
the volume and pitch to sample from, how far it carries, whether it loops, which
mixer channel it belongs to. A `sound` placement names one of those and says
only where it plays.

The table is written by the Call of Duty importer from the game's own sound
aliases; there is no format for authoring one by hand yet. See
[docs/engine/audio.md](../docs/engine/audio.md).

### `sound <name>` (top level or inside a group; optional name)

Where an alias **plays**: wind on a fence, a generator, gulls, or the whole
map's ambience at once. The alias says what it sounds like; this says where.

| Property | Type                                                             | Default            |
| -------- | ---------------------------------------------------------------- | ------------------ |
| `alias`  | bare name — the alias inside the `sounds` table                  | **required**       |
| `at`     | 3 numbers — where it plays, or **nothing at all**                | nowhere, see below |
| `volume` | number — scales the alias' own volume                            | `1`                |
| `range`  | 2 lengths — full volume within the first, silent past the second | the alias' own     |
| `delay`  | number — seconds before it starts                                | `0`                |
| `tag`    | 1–8 strings — shared group handles                               | —                  |

**A `sound` with no `at` is the world's bed.** It is not a sound at the origin:
it is non-positional, played at full volume everywhere and never panned, which
is what a map's stereo ambience track is. Everything else takes a position, and
a group's origin and yaw apply to it as they do to anything else — but a bed
inside a group is still a bed, and does not pick up the group's origin.

`alias` is a bare name rather than a quoted string, because that is what an
alias is in the table it indexes. It is spelled `alias` and not `sound` because
the node already is. **A name the table does not hold is not an error here** —
the world is checked without reading the table, exactly as `animate` names a
clip inside a `.glb`; the sound simply does not play.

`range` is two distances and both matter. The first is the distance inside which
the sound is at full volume; the second is a **hard cap** — a source further away
than that is never started at all, rather than played very quietly. A maximum
inside the reference distance would be silent everywhere, so it is an error.

`delay` is in seconds, as an `effect`'s is: a **negative** delay starts the sound
already running, which is what keeps a map's loops from winding up together as
the world loads.

```
sounds { source: "assets/sounds/sounds.json" }

// The map's ambience: everywhere, at full volume, with no position.
sound bed { alias: ambient_dome_ext, volume: 0.6 }

// A fence flapping in the wind, heard from 18 m, already running.
sound flap { alias: emt_wind_dome_flap_ext, at: 12.4 3 -8.1, range: 4m 18m, delay: -3, tag: "ambience" }

group courtyard {
  at: 10 0 -20
  sound { alias: elm_generator_loop, at: 0 0.5 2 }
}
```

Imported maps get these from the map's own zone and ambient script, written to
`sound.world` (see [docs/engine/audio.md](../docs/engine/audio.md)).

### `behaviours` (inside a `model`, no name, at most one per model)

What an object **does**, as against where it is. A block holding one node per
behaviour, so each behaviour's properties stay in its own namespace.

```
model { asset: electricbox, at: -31 -9 -40, size: 0.6 0.8 0.4
  behaviours {
    health { amount: 100 }
    destructible { preset: "toy_electricbox4" }
  }
}
```

| Behaviour      | Property | Type                                                 |
| -------------- | -------- | ---------------------------------------------------- |
| `health`       | `amount` | number — hit points it starts with; must be above 0  |
| `destructible` | `preset` | string — names a destruction definition by name      |

A behaviour says what an object *has*, never what happens to it: what reaching
zero health means is the game's decision, not the world file's. `preset` is a
name carried through for the game to interpret — for an imported map it is the
source game's own `destructible_type`.

This is a block rather than plain properties on the placement for a reason worth
knowing if you add a behaviour: property names are shared across the whole
language, so a bare `type:` on a model would collide with the `type:` that
already belongs to `light`. Inside `destructible { }` there is no such clash.

---

## Names, tags and ids

Three different ways to refer to one thing, and they are not interchangeable.

| Handle | Unique? | Who writes it | What it is for |
| ------ | ------- | ------------- | -------------- |
| `name` | yes, across the whole world | you | referring to one specific object |
| `tag`  | **no** — many objects may share one | you, or the importer | referring to a whole *set* of objects |
| id     | yes | the engine | the address the running game uses |

**`name`** is unique across every file a world includes, and naming two things
the same is an error.

**`tag`** is deliberately the opposite: any number of objects may carry the same
one, and that is the point. It is how you say "all of these are the same kind of
thing" — every explosive barrel, every scoreboard panel — so that something can
later act on the group rather than on one object at a time.

```
model { asset: barrel, at: 3 0 -2, tag: "explodable" }
model { asset: barrel, at: 5 0 -2, tag: "explodable" }
```

An imported Call of Duty map's `tag` is the map's own `targetname`, which works
the same way there: on mp_dome, 21 of its 47 names are shared, one of them by
193 objects.

A node may carry **up to eight** tags, and belongs to each set at once. That is
how one thing is sorted several ways — by the area it serves, by what kind of
thing it is, by how it behaves:

```
point { at: 3 0 -9, tag: "foyer_spawners" "zombie" "riser" }
```

### Targets

**`target`** on a `trigger` or a `point` names a tag, and means "this points at
every node carrying that tag". It is the one cross-reference in the format, and
the world says only that the link exists — what it is _for_ is the script's. An
area's trigger targets the points that serve it; a door's trigger targets the
solids it removes.

```
trigger { at: 0 0 0, size: 8 3 6, tag: "foyer_zone", target: "foyer_spawners" }
point   { at: 3 0 -9, tag: "foyer_spawners" }
```

A `target` naming a tag that no node in the world carries is a **warning**: the
world still loads, and the link simply finds nothing, but it is almost always a
typo or a node lost in a re-export.

### Modes

**`mode`** on a `spawn`, `model`, `trigger`, `point` or `solid` lists the game
modes it exists in — `mode: "dom"` on a flag's trigger, `mode: "gun" "oic"` on
a barrier only two modes want. **No `mode` means every mode.** A node with one is
absent when none of its modes is being played, including when no mode is at all
(free roam). The modes are free strings, spelled the way the gametype that
wants them spells its own; nothing checks them against a list.

Spawns are the one exception to "absent": a game asking for a mode no spawn
names still gets somewhere to put a player (see [`spawn`](#spawn-top-level-no-name-any-number)).

**The id** is not written in a world file at all. The engine numbers every
object as it loads, in the order they appear — descending into each group in
place — so the same file always produces the same ids. You will see one in the dev inspector, next to the name and tags.
It is worth knowing two things about it: it is how the running game refers to an
object internally, and it **changes when you edit the file**, because inserting
an object renumbers everything after it. Use `name` or `tag` to refer to
something durably; the id is for the engine.

---

## Worked examples

- **`worlds/dome-mw3/world.world`** — the shape every world has: a `world`
  header, the map's own `grade`, two `asset`s (the shell and its decals) placed
  in a `group`, a `collision` mesh, and then `include`s for the files below.
  Read this one first.
- **`worlds/dome-mw3/props.world`** — 210 `asset` declarations and 4,625 `model`
  placements. Generated, and the example of what `hull:`, `until:` and
  `collide:` look like at scale.
- **`worlds/dome-mw3/gameplay.world`** — 219 `spawn`s across 7 modes, plus
  `trigger`s. This is the file a human actually edits, and the one
  `--gameplay-only` rewrites.
- **`worlds/dome-mw3/mantle.world`**, **`ladder.world`** — 29 `mantle` volumes
  and 2 `ladder`s, generated from the map's own brushes: what the climbing
  nodes look like in a real map, turned to follow its walls.
- **`worlds/dome-mw3/minimap.world`**, **`navigation.world`** — one node each,
  on its own.

Copying that structure is the fastest way to get something that passes
`pnpm check` on the first try.

### Areas, points and parts

Everything a scripted mode needs from a map, in the generic pieces above. The
world says what is where and what points at what; the script decides that
standing in `foyer_zone` wakes the points it targets, and that using the door
costs something and removes its solid.

```
collision { source: "assets/collision.glb" }

// An area of two boxes: the tag is the area.
trigger { at: 4 0 -2, size: 6 3 4, tag: "foyer_zone" "player_area", target: "foyer_spawners" }
trigger { at: 9 0 -6, size: 3 3 8, tag: "foyer_zone" "player_area", target: "foyer_spawners" }

// The points that area wakes, sorted two more ways by their other tags.
point { at: 12 0 -1, look: 9 0 -1, tag: "foyer_spawners" "walker" }
point { at: 1 0 -9,  look: 1 0 -6, tag: "foyer_spawners" "walker" "riser" }

// A door: a volume to use from nearby, pointing at the part of the collision it removes.
trigger backstage_buy { at: 6 1 -10, size: 2 2.5 1, tag: "door", target: "backstage_door", use: near }
solid backstage { part: "*37", tag: "backstage_door" }
```

Nothing here is priced, prompted or ordered — no cost, no text, no "this area
opens after that one". Those are the script's, so the same map serves any mode
that wants its areas, points and doors.

---

## Known v1 limitations

- There is no way to build geometry in the language itself. Everything visible
  is a `model` pointing at a `.glb`, so new geometry means a new asset file.
- A `model`'s `size` is declared, not measured from the file, and nothing
  checks the two agree.
- `animate:` loops one clip forever. There is no blending between clips, no
  one-shot playback, and nothing can start or stop a clip from the world file.
- A world cannot say anything about who its players are, on purpose: the hands,
  the bodies and the default weapon all come from the gametype and the catalogue
  now. The hands are still fixed for the visit; the weapon is not, since a
  player's class replaces it and `1`/`2` swaps between the two it carries.
