# Collision

How the player is kept out of walls, and why there are three colliders rather
than one.

The code is in **`@3d/shared`**, not the client: `collision/world.ts` (queries),
`collision/hulls.ts` and `collision/hullIndex.ts` (prop hulls and their grid) and `collision/source.ts` (a map's authored
collision mesh). That is deliberate. The client predicts its own movement and
the server re-simulates it to check, so both have to resolve the same capsule
against the same triangles — two implementations would drift, and the drift
would surface as rubber-banding that is painful to attribute.

What stayed in the client is only the part that is about drawing:
`packages/client/src/scene/collision.ts` fetches the mesh through the
`AssetStore` and hides it behind an invisible material. A game server fetches the
same file from `@3d/api` (`packages/game-server/src/collision.ts`) and skips
both.

three.js is used here as a geometry library, not a renderer — `BufferGeometry`
as a container and `Line3`/`Box3`/`Matrix4` for the maths. No `WebGLRenderer`
is constructed and no DOM is touched, which is what lets it run in Node.
Measured on mp_dome: the collision glTF parses in ~8 ms and its 120,366
triangles become a BVH in ~130 ms.

## The player

A capsule, moved by `@3d/shared`'s `sim/movement.ts` ([player](player.md)),
which reaches collision only through the `CapsuleWorld` interface in
`sim/capsule.ts` — that is what keeps the simulation itself free of three.js.
Resolution is three-mesh-bvh's character-controller technique: shapecast the
capsule, and push its segment out of every triangle closer than the radius.
Repeated each frame, it settles onto what it stands on.

### Ground

The movement rules are a box's: it stands on a ledge with any of itself over
it, and a trace under it names one plane. A capsule pushed out of triangles has
neither, so `resolveCapsule` says what holds it up in terms that give the same
answers ([player](player.md#what-a-player-can-do) has the rules themselves).

- **`CapsuleResolution.normal` is the contact's direction**, from what the
  capsule touches to its axis, not a face's normal. `radius × (1 − normal.y)` is
  therefore how far above the feet the contact is: how tall the ledge is whose
  corner the bottom rests on.
- **`grounded` is the face rule.** A contact facing up by 0.7 or more is ground.
  So is the corner of a face that level, as far round the bottom as 0.3
  (`SLOPE_NORMAL_Y`): a box would be standing on that face. Past 0.3 the corner
  is beside the capsule, and holds nothing up.
- **What only touches is asked too** (`TOUCH`): pushed off the wall face of a
  corner, the capsule rests against the top face without sinking into it, and
  which of the two a shapecast visits first is nobody's rule.
- **Wedged is ground.** Held up by nothing under it and still pushed up more
  than aside, the capsule is in a groove between two ledges, where a box stands
  on both.
- **Only what is under it lifts it straight up.** A contact facing up by 0.7 or
  more is cleared vertically, so a standing body does not creep downhill; a
  corner further round, and a wall, push along their own direction.
- **`groundBelow` can say what it found**: the face's normal under a point, which
  is what a walk lays its velocity along.

A move that needs a ledge's height takes it from the contact, and one that meets
a corner from beside in the air stands off it as it would a wall
(`sim/stepSlide.ts`).

## Three colliders

1. **The scene BVH.** Every mesh tagged `userData.collide` is merged in world
   space (`StaticGeometryGenerator`) into one geometry with one `MeshBVH`. It is
   rebuilt from scratch on every load and hot reload, after all models have
   arrived and before instancing (which moves meshes into batches the merge
   would miss).
2. **Prop hulls.** An asset with `hull:` gets a positions-only hull geometry and
   BVH **per asset**; each placement is an instance holding only a matrix. A
   query moves the capsule into the placement's local space rather than moving
   the geometry into the world. This is what makes prop collision affordable:
   interchange-mw3 has 2,842 colliding placements over 192 assets, 191k
   triangles shared against 1.74M baked. A uniform grid is the broad phase.

## Removable parts

A world's `solid` nodes name parts of its collision glb (`extras.part = "*N"`,
the same tag on the shell's render meshes) that can be absent: outside the
`mode:` a solid lists, or once a script removes it mid-match. A part no `solid`
names is base, so a world with no solids collides exactly as it always did.

**The trees are built once per load and never rebuilt.** `rebuild(root, parts)`
keeps each named part's triangles out of the base trees and puts them in trees
of their own, split into shots and clip like the map's. A match then sees the
world through `CollisionWorld.view(presence)`, a `CapsuleWorld` that answers
every query against the base plus the parts `presence` (`worlds/presence.ts`)
holds **at the moment of the query**. A change is seen by the next query and
costs nothing else, and two matches on one map hold two views over one set of
trees. Queries walk the trees in one fixed order: the base, then the present
parts ascending, then the prop hulls. Both ends build the same trees from the
same file, so that order is the same on both.

**One tree per part, not one tree for all of them.** Masking is then skipping a
tree rather than testing every triangle a query meets, a ray needs no masked
`raycastFirst`, and the fixed order above is simply the part order. A part's
surfaces are copied by hand as the map's are, and `tests/collisionParts.test.ts`
asserts a part's tree is big enough to be reordered by the BVH and still names
its own material.

`partView(index)` is one part alone, with no base under it: what a navigation
blocker is sampled against ([navigation](navigation.md#a-matchs-state)) and what
refuses to restore a part around a player standing in it. The world's own
queries on `CollisionWorld` see everything, every part and every prop, as the
file draws it; nothing that simulates a player may use them.

**A prop's `mode:` is masked the same way, by mode only.** A hull placement
carries its model's modes, and a view leaves it out of a match whose mode it does
not name. It is fixed per match: a model is never a removable part, so a script
cannot take one away. A browser does not build such a model at all
(`scene/scene.ts`), so it has no hull to mask.

## Hidden colliders

`collide: box` proxies are visible objects with an invisible material (`HIDDEN_COLLIDER`). They cannot be `visible = false`:
`StaticGeometryGenerator` uses `traverseVisible` and would drop them. They set
`userData.collider = true`, which picking uses to resolve a hit to the prop it
stands for, and which `WorldSession` uses to hide them once the BVH is built.
Any new hidden collider must set it.

## Imported map collision

A `collision { source: "assets/collision.glb" }` node loads a map's own
collision, split by the exporter into named groups: `solid`, `soup`, and one
`clip:0x…` group per distinct contents mask. Each carries its decoded bitmask,
clip material names and per-brush triangle ranges in glTF `extras`, so the
inspector can name the single brush you walked into (`clip_player`,
`blocks player, ai`, a 22 m box) rather than "somewhere in a 3 km mesh". MW3
maps carry 1,300 to 4,600 invisible walls; without this they are
indistinguishable from import bugs.

A group may carry `collides: false`: drawn and named, kept out of the BVH.
Black Ops' soup ships an AI and vehicle navigation hull that would otherwise be
an invisible wall through the middle of the map.

## What a surface is made of

Every face of a Call of Duty map says what it is made of, and the engine carries
it through so that a footstep can be spelled with it. `CapsuleWorld.surfaceAt`
is the query — the same downward search `groundBelow` makes, returning the name
rather than the height, so the two can never name different triangles.

**The names are `@3d/shared/sim/surfaces.ts`, not `collision/`**, because they
are the answer rather than the machinery: `sim/` may not import `collision/` at
all, and `sim/` is where a footstep picks its alias. A surface is a plain string
both ends agree on, and the index into that list is the wire value.

The list is CoD's own `surfaceTypeNames[]` — 31 entries, `default` first —
with two appended. **Black Ops' table is not IW's**: its last two entries are
`player` and `tallgrass` where IW3/IW4/IW5/IW6 have `riotshield` and `slush`
(OpenAssetTools `T5/Weapon/WeaponStrings.h`). The exporter maps each game's own
index into the shared list, so a Black Ops lawn does not come out a riot shield.

Three answers, and they are three different facts:

| Answer      | Means                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| a name      | the face's material named a surface type                                                                                                              |
| `"default"` | something is there and says nothing: a hand-written world, a map exported before this, or a `caulk` face — a brush side nothing was ever meant to see |
| `null`      | nothing under the point at all                                                                                                                        |

`default` is never an error. It is also what the game itself does: CoD's own
footstep reads the flags off whatever its trace hit, and a player-clip brush
laid over a floor has no surface type either.

### How it survives the trip to the BVH

The exporter writes **one surface index per vertex**, as a `_SURFACE` attribute
beside `POSITION` (`scripts/cod/collision.py`), and joins the surface to the
weld key so that a floor meeting a wall no longer shares that corner. Which
triangles the weld collapses is unchanged — a triangle is one face and so one
surface — only how many vertices survive: mp_dome goes from 64,772 to 94,888,
and its `collision.glb` from 2.27 to 2.7 MB, for the same 120,366 triangles.

Per vertex rather than per triangle, and rebuilt in `collision/surfaces.ts`
rather than carried by the merge, because two mechanisms sit in the way and both
fail as a **plausible** answer:

- `StaticGeometryGenerator` will copy a named attribute, but only while _every_
  mesh in the tree has one — `mergeBufferGeometries` throws on a set whose
  geometries do not all hold the same attributes, and the mixed set is the
  ordinary case (a world with no surfaces, a prop hull, a map that predates
  this). So the copy is made by hand, and a mesh with nothing to say leaves
  zeros, which is `default`.
- `MeshBVH` **reorders the geometry's index** as it builds, from about a hundred
  triangles up. A raycast's `faceIndex` therefore counts triangles in the tree's
  order and not in the merge's, so a per-triangle table built from the merge
  names some other triangle's material. That one was found by probing mp_dome's
  spawn points and getting `concrete` on its dirt yard; `tests/surfaces.test.ts`
  holds it down, and asserts its own fixture is big enough to provoke the
  reorder.

Vertices are moved by neither, so a surface attached to one survives both.

### What mp_dome came out as

120,366 triangles, thirteen kinds: metal 46.5%, `default` 30.2% (almost all
`caulk`, 16,077 of 16,213 unnamed brush faces), wood 9.3%, concrete 5.3%, dirt
4.9%, plaster 2.3%, then gravel, rock, plastic, glass, asphalt, ceramic and
foliage. Over its 220 spawn points the query answers concrete 113, dirt 104 and
plaster 3, and never `default`. Probed from above, `metal` centres on (3, 2) and
reaches 11.5 m up — the central gantry — and `plastic` (the radome cloth) covers
the same footprint from 20 m. dome-mw3 is the only map re-exported so far
(`pnpm export:cod mp_dome --collision-only`); every other imported map answers
`default` everywhere until it is.

## A bullet hits a bone, not a capsule

A player is _moved_ as a capsule and _shot_ as a skeleton. Each bone a hit can land
on carries a box, and nineteen locations name what a hit on each counts as
(`sim/hitLocations.ts`) so a weapon can multiply its damage per location — CoD's own
`AttLocationDamage`, in its order, because a hit names a location by index.

**About thirty joints carry a box; every other one folds into its nearest boxed
ancestor.** The 52 exported bodies carry 265 distinct joints between them and most
are facial detail (`j_nasolabial_ri_3`), cloth (`j_coatfront_le`) or mount points
(`tag_acog_2`). A box per lip joint is a hundred ray tests inside a volume the head
already covers — but a vertex weighted to a lip joint still has to reach the head's
box, or part of a body becomes unhittable. `tests/hitLocations.test.ts` reads all 52
real skeletons and asserts every non-`tag_` joint resolves.

These same boxes are also what a corpse is _made of_: a ragdoll's sixteen
colliders are the body's own hit volumes, so the shape a round met a moment ago is
the shape that falls over, and a new export gets a ragdoll with no work at all. See
[physics.md](physics.md#a-corpse) — and note the one number the two uses disagree
about, which is the cap on a ghillie body's head.

### Where the boxes come from

`python3 -m scripts.cod hitboxes` derives them from **the bodies' own skin weights**:
per vertex, the joint that influences it most, folded to its nearest boxed ancestor,
accumulated in that bone's own space via the skin's `inverseBindMatrices`. No game
files, and the volumes come from the mesh the client actually draws — so a hitbox
cannot disagree with the body on screen.

Four things to know:

- **A box stays in its bone's space, in the rig's own units.** A CoD body hangs from
  a `unit-scale` root of 0.0254, so bone space is inches; the engine poses a box by
  that bone's world matrix, which already carries the scale. `MIN_THICKNESS` is
  therefore in inches, and writing metres would ask for half a millimetre.
- **A character is two files.** `characters.py` puts everything neck-down in the body
  and ships the head as a model rebound to the body's bones at run time. Derive from
  the body alone and there is **no head box at all** — the one volume that decides
  most fights.
- **Cloth inflates a box.** The three `mp_body_ally_ghillie_*_sniper` bodies skin a
  hood to `j_head` and derive a 0.49 m head, against 0.29 m for an ordinary body.
  The exporter _names_ any box past what its location plausibly should be — calibrated
  against the 26 bodies on disk, so an ordinary one is silent — rather than clamping
  it, because a silently shrunk box is a worse lie than a large one.
- **CoD ships its own boxes and they are still worth dumping.**
  `XModelCollSurf_s` is an AABB per bone with a `partClassification` byte per bone,
  and `scripts/cod/iw6/walkers.py` already walks past both. That is a fidelity check
  against this rather than a replacement for it — and it needs one open question
  answered first (`docs/cod/reference.md#collision`: which classification byte is
  the head is not established).

## A prop's collision comes from wherever the prop does

A `model` placement collides against its asset's own mesh, and since props moved to
the shared catalogue an asset's `source` is relative to **either** the world folder
or its catalogue entry, depending on whether `catalog:` is set. Two things resolve
that, and they must agree:

| End    | Where                          | How                                                          |
| ------ | ------------------------------ | ------------------------------------------------------------ |
| Client | `client/src/scene/assetUrl.ts` | spells a URL: world base, or `catalogFilePath`               |
| Server | `game-server/src/collision.ts` | world file off the `WorldSource`, catalogue file off the api |

`buildPropCollision` is handed the **asset**, never a bare path, precisely so that
neither end can quietly assume the wrong root. It did assume it once: every prop on
every imported map resolved to a world-relative path that no longer exists, so a
game server collided with none of them (dome-mw3: 133 assets, 1,223 placements, all
missing) while every client collided with all of them. Under a server that only
_measured_ drift that was invisible; under one that corrects, it is a player
standing on a rock being told they are falling, every tick.

Two smaller traps live here for the same reason:

- **Reads are deduplicated by `assetFileKey`, not by `source`.** Two catalogue
  entries may each ship a `model.glb`, and keying on the basename hands one of them
  the other's geometry — a prop with someone else's collision and nothing to say
  why. (The client never had this bug: its `AssetStore` is keyed by URL.)
- **`collision.test.ts` guards on the catalogue, not on `assets/props`.** The old
  guard named a per-world directory that stopped existing when props moved, so the
  one test that would have caught all of this skipped silently instead of failing. A
  guard that degrades into a skip is worse than no test.

## A bullet and a player collide with different things

What stops a player is not what stops a bullet, and the difference is most of a
map's invisible geometry. So the clipmap is built as **two trees**, not one:

| Tree      | Built from                                                  | Queried by               |
| --------- | ----------------------------------------------------------- | ------------------------ |
| `bvh`     | `solid`, the `soup` shell, any `clip:` with the `solid` bit | `traceRay`, and capsules |
| `clipBvh` | every other colliding `clip:` group                         | capsules only            |

`blocksShots` in `collision/source.ts` is the one place that decides, and it
reads the exporter's own decoded `blocks` list rather than re-deriving a bit mask
— four of IW4/IW5's contents labels were guessed wrong, and `solid` is one of the
two that is right in every game.

**Two trees rather than one plus a second for shots**, because the shot set is
most of the clipmap: 88k of dome-mw3's 118k triangles, 296k of interchange's 394k.
Building a separate tree for it would have cost that again. Split by what each
group stops, every triangle is in exactly one tree and the totals are unchanged —
dome is 88,168 + 30,536 = 118,704, exactly what the merged tree held. A capsule
pays one extra tree walk, over the smaller of the two.

It matters more than it sounds. Firing level from 40 start spawns in four
directions, a bullet that ignores the clip tree outreaches one that does not on
110 of 160 traces on dome-mw3 (14.6 m on average) and 126 of 160 on
interchange-mw3 (5.1 m). Traced against the movement mesh, about three shots in
four stop at nothing you can see.

`traceRay` takes a `TraceChannel` for the cases still to come — a `sight` trace
wants `ai_nosight`, a rocket wants the `projectile` clips — so that adding one is
a new branch here rather than a new parameter at every call site.

## Channels

A player and an actor are stopped by different clip, as a bullet and a player
are. The source games' AI walks through a player-only clip (a ladder's, a
roof's) and is stopped by AI-only clip (a boarded window, a ledge only players
may reach), so a capsule query names who it is for: `CollisionWorld.view(presence,
channel)` and `partView(index, channel)`, where the channel is `player` (the
default) or `ai`.

| Channel  | Trees, in order                                           |
| -------- | --------------------------------------------------------- |
| `player` | `bvh`, `clipBvh`; each present part's shot and clip trees |
| `ai`     | `bvh`, `aiBvh`; each present part's shot and ai trees     |

`aiBvh` is every group `blocksAi` (`collision/source.ts`) takes and the shot tree
does not: a `clip:` group whose decoded `blocks` name `ai`, **including those
with `collides: false`**, which is how an exporter writes clip no player collides
with. What stops a bullet stops everyone, so the shot tree serves both.

- **The players' trees are untouched.** `aiBvh` is a second copy of the clip that
  names both, not a split of `clipBvh`, so a player's pushes, overlaps and ground
  are byte for byte what they were (`tests/collisionChannels.test.ts`). It costs
  that copy's memory.
- **Built only when asked**: `rebuild(root, parts, { ai: true })`. A game server
  asks (`buildServerCollision`), since any game on a map may run actors; a client
  never simulates one and does not. An `ai` view of trees never built throws,
  rather than answering "nothing there" everywhere.
- **Parts mask both.** A part's `ai` tree is masked by the same presence, so a
  door stops an actor while present, and an AI-only part — which a player's view
  sees as empty, `partBounds(i)` undefined — stops only actors
  (`partBounds(i, "ai")`).
- **Prop hulls stop both.** They are a model's collision shape, which the games'
  AI respects too.
- **A ray ignores it.** `traceRay` reads its own `TraceChannel`, so a bullet traced
  through an actor's view is the bullet traced through a player's.

### One trace does not walk the hull grid like a capsule does

Prop hulls are bucketed into 8 m cells. A capsule's step spans one to four of
them, so `HullIndex.near` takes every cell in the step's bounding **rectangle**. A
bullet is a long thin segment, and the same rule costs (length / 8 m)² cells: a
200 m shot touches ~625 of them and collects most of a map's placements —
interchange has 2,842 — which is slower than having no grid at all.

`HullIndex.along` is a 2D DDA along the line instead: O(length) cells. On the
test fixture it is the difference between 486 candidates and 80. Nothing about the
answer changes, which is why `CollisionWorld.traceCandidates` exists — a count is
the only thing that can see this go wrong.

## What is deliberately not a collider

**Mantle volumes.** A world's `mantle` nodes mark where a player may climb
([player.md](player.md#mantling)). They are not in any BVH and must not be: a
volume encloses the ledge it marks, so one that collided would be an invisible
wall round every ledge in the map. They are not in `collision.glb` either — the
exporter writes them as world-file nodes precisely so that nothing can sweep
them into a collision mesh by accident. `sim/moves/mantle.ts` holds them, and asks the
collision the rest through `CapsuleWorld`: where the ledge is
(`groundBelow`, a ray straight down) and whether the capsule fits on the way
(`overlapsCapsule`, which treats touching as clear). A lying body's legs are
asked with the one query that is not upright, `overlapsSweep`: a ball carried
along a line, which also counts a surface the line passes clean through
([player.md](player.md#prone-blocked)).

The game's own mantle brushes carry contents `0x01000000`, which blocks nobody,
so `scripts/cod/collision.py` already drops them from the collision mesh. That
is correct and load-bearing rather than incidental:
`scripts/cod/tests/test_mantle.py` asserts `blocks_player(MANTLE) is False`.

**Ladders are colliders, and the permission is not.** A ladder in a CoD map is a
thin player-clip brush of its own (contents `0x08010000`), so it is already in
`collision.glb`'s clip group and stops a player like any wall — which is what
the game does, and what a climb presses against. The `ladder` node says only
that touching it is a grip ([player.md](player.md#ladders)). No triangle in the
BVH knows it is a ladder: the grab check sweeps its probe against the node's box
with plain numbers, so the collision layer needs no per-face flags.

## Seeing it

Collider view (`X`, dev builds) has three states: off; proxies and clip
brushes; and everything the BVHs were actually built from, plus every prop hull
at its placement. The second is an interpretation of the scene graph; the third
reads `CollisionWorld.debugSurfaces()` and cannot disagree with what stops you.

Surface view (`N`) reads the same call and colours it by surface type instead,
which is the only way anyone can check that a metal gantry came out `metal` —
a footstep on the wrong material sounds like a footstep. See
[debugging.md](debugging.md#surfaces).
