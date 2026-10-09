# Effects

How a Call of Duty map's particle effects — sandstorms, smoke, fire, falling
ash — get from the game into a world, and how their meaning was established.
The field-by-field meaning is in [reference.md](reference.md#effects-fx); the
engine side is in [rendering.md](../engine/rendering.md#effects).

**Status.** MW3 (IW5) effects export and render: `dome-mw3` carries 60
placements of 23 effect definitions, and its sandstorm renders tan and low over
the hills, matching a screenshot of the real game. Black Ops (T5) effects export
and render too: `russianbase-bo1` carries 284 placements of 27 effects, 51 of them
repeating, including its falling snow (particle clouds); seen in the browser but
not yet against the real game.
MW2 (IW4) and the other Black Ops maps have their placements in
`export_metadata.json` but no effect definitions yet (see
[below](#what-is-still-missing)).

## Exporting a map's effects

### What it needs

An `fx` dump: one lossless JSON per effect at `fx/<name>.json`, in game units
([the dump tree](pipeline.md#the-dump-tree)). The IW5 backend writes it
(`scripts/cod/iw5/dumpers/fx.py`), from the zonecode walk. It names an elem's
type from IW5's own `FxElemType` in the load program rather than a hand-kept
list. Without one (MW2, Black Ops, Ghosts), stage 12 says so and skips.
Nothing else is needed: materials and images come from the same backend's
other writers.

### What a full export does

Stage 12 of `python3 -m scripts.cod export <map>` (`export.py`
`export_effects`, `fx.py`, `worldfile.write_fx_world`):

1. **Dump.** `fx`, `material` and `image` from the map's fastfile **and** its
   companion zones. Most effects live in `common_mp.ff`: of the 232 `fx`
   entries in `mp_dome.ff`, only 83 are defined there; the other 149 are
   references (a leading comma in `--list`).
2. **Placements.** The metadata stage has already parsed
   `maps/createfx/<map>_fx.gsc` into `export_metadata.json` (`fx.effects`, the
   `loadfx` alias table, and `fx.placements`). `createOneshotEffect` and
   `createLoopEffect` placements are effects; `createLoopSound` ones are sounds
   and are counted, not exported. A loop effect (only Black Ops' maps have them)
   is written with its one wait as both `delay` and `repeat`: Black Ops' `loopfx`
   (`clientscripts/mp/_fx.csc`) plays it, waits that long, then polls every quarter
   second until the last play has finished before starting the next.
3. **Closure.** Starting from the placed effects, follow every child —
   `effectOnDeath`, `effectOnImpact`, `effectEmitted`, and RUNNER elements.
   dome's 11 placed effects pull in 12 more. A child that was not dumped is
   named in the log: it would otherwise play as nothing.
4. **Convert** to engine units (metres, seconds, RGBA in 0..1, velocities in
   metres per millisecond). The conventions this depends on are in
   [reference.md](reference.md#data-conventions).
5. **Materials.** For each material an element draws, read its dump for the
   colour map, the literal blend factors, `featherParms`, and whether its
   technique set is `_nofog`. Convert the colour maps to PNG, losslessly — an
   additive or faint sheet carries its shape in brightness, where JPEG ringing
   shows. An image the zones name by reference only, shipping no pixels
   (`fxt_smk_puff` on russianbase), is read from the `.iwd` search path instead.
   `featherParms` becomes the runtime's soft-particle depth: a sheet fades out
   where it meets the scene behind it.
6. **Write** `assets/fx/effects.json` (the library; `_version` 4) and
   `assets/fx/textures/`, then `fx.world`: one `fx { source: … }` and one
   `effect` per placement, with placement angles through `props.engine_euler`
   like any prop. `world.world` gets `include "fx.world"`.

`--effects-export-only` runs stage 12 alone from a fresh dump of the map's and
its companions' effects, materials and images, leaving every other file in the
world as it is (a full re-export would undo the props harvest).

**Black Ops** differs in what it writes, not in the stage. The T5 dumper
(`scripts/cod/t5/dumpers/fx.py`) writes T5's own type names, its trim, pivot,
wind and packed atlas; the converter bakes the level's global wind
(`wind_global_vector` in the fx script's dvars) into each elem's life and spawn
interval, unpacks the atlas, and reads each technique set's shader parameters
(`output`, `fogFade`, `falloff`, `eyeOffset`). The library records its `game`, and
the runtime follows that game's conventions where the two differ
([reference.md](reference.md#black-ops-t5)).

`--effects-only` rewrites `fx.world` alone from the committed metadata and the
library already on disk, with no game files. It is byte-identical to what the
full export wrote.

### What comes out, for dome

```
fx.world                      60 placements of 23 effects (committed)
assets/fx/effects.json        the library: 23 effects, 8 materials (gitignored)
assets/fx/textures/*.png      7 sheets (gitignored)
```

`pnpm check worlds/dome-mw3` reports `60 effect placement(s) of 11`: placements
and the distinct effects they name.

## How the meaning was established

A dumped `FxElemDef` is a hundred numbers with no documentation. Their meaning
was read from the game's own executable and shaders, after a first attempt built
on inference went wrong in seventeen separate ways. The sources, the method, each
wrong turn and the test that now guards it, and the tools to check it all again
are in [reverse/iw5-fx](../../reverse/iw5-fx/README.md).

## What is still missing

- **Other games.** An `FxEffectDef` dumper for IW4, and for T6 (whose
  `FxElemDef` is byte-identical to T5's; its placements are in compiled scripts).
- **Impacts.** `FxImpactTable` and IW5's `SurfaceFxTable` have no dumper either,
  and nothing in the engine casts a hit ray yet.
- **Lighting** by `lightingFrac`, and occlusion fading.
- **Element types:** clouds, sparks, models (falling debris), lights, decals,
  sounds, trails. Each is counted and logged when skipped, never approximated.
- **Weapons.** Muzzle flashes need `viewFlashEffect` / `worldFlashEffect` from
  the weapon dump (already there, as names) and the catalogue-level effect
  library they would draw from.
- **The other 41 worlds.** Their placements are committed; each needs a full
  export to gain the definitions.
