# Debugging a world

The dev tools live in `packages/client/src/app/devTools.ts` and are bound only in development
builds (`pnpm dev`). Their readouts are the debug overlay (`packages/client/src/ui/debug/`).

| Key     | Tool                                                                                          |
| ------- | --------------------------------------------------------------------------------------------- |
| `` ` `` | Inspector: hover to read what is under the cursor (the crosshair while walking), click to pin |
| `C`     | Collider view: off → proxies + clip brushes → everything that collides                        |
| `M`     | Climb view: mantle volumes and ladders as boxes, and the ones you could climb highlighted     |
| `B`     | Hit boxes: the volumes a shot is traced against, on the peers wearing them                    |
| `N`     | Surface view: the collision coloured by what CoD says each triangle is made of                |
| `K`     | Navigation: off → the graph bots walk → the graph and every link the bake turned down         |
| `G`     | Shot traces: where a round went, client's answer against the server's (temporary — see below) |
| `L`     | A sky marker per directional light                                                            |
| `H`     | Hide every model. If frame time collapses, the cost is the graph, not pixels                  |
| `T`     | Pause / resume animation (skeletal clips, flag wind and the viewmodel)                        |
| `V`     | Show / hide the viewmodel                                                                     |
| `P`     | Copy a pose link for the current camera (walk mode)                                           |
| `Q`     | Cycle quality (also in the pause menu)                                                        |
| `Tab`   | Walk ↔ dollhouse                                                                              |

`M` is its own toggle rather than a third `C` mode on purpose: a mantle volume
is **not** a collider, and putting it under collider view would imply it stops
you ([collision.md](collision.md#what-is-deliberately-not-a-collider)).

`C`'s third state draws a world's removable parts in orange, and only the ones
present in this match: what it draws is what the view a player steps through
collides with ([collision](collision.md#removable-parts)). It follows a part
coming or going.

What it draws, and why each half is there:

- **Every volume** as a wireframe box, coloured by the kind the source map named
  — `onto` blue, `over` yellow, unnamed grey. Unnamed is the ordinary case, not a
  fault: no Black Ops volume names a kind and nor does a third of Modern
  Warfare's. A volume's **top edges are drawn brighter**, because the top face is
  the surface you land on; a bright edge that does not sit on the ledge is a map
  breaking the convention the exporter assumes.
- **The volume you could climb right now**, highlighted in green and drawn
  through walls, with the path the capsule would take (up from your feet, then
  across) and a cross where your feet would come down. This asks
  `MantleVolumes.find` — the same call `stepMovement` makes, with the same body
  and the same collision — so it cannot disagree with what pressing jump does.
  That is the half worth having: **a box you are standing at that stays
  unhighlighted is the answer to "why did that not climb?"** — facing the wrong
  way, no ledge within reach, a ledge the wrong height, or something in the
  capsule's way (a post, a beam overhead).

- **Every ladder** as an orange box: all bright where every side can be climbed,
  and only the named side bright where the node names one (`face`).
- **The ladder the grab check meets** from where you stand, highlighted in green
  through walls. This asks `ladderAhead`, the probe `stepMovement` sweeps (along
  the view; straight back into the ladder once climbing in the air). Highlighted
  but not grabbed means one of the other conditions: standing without pushing
  forward, within 0.3 s of a jump, or off a ladder and not yet back on the ground.

With it on, the stats line adds the volume count and either the live climb's
rise in metres (and `over` for a vault), or `no climb here`; in a world with
ladders, also `on a ladder`, `ladder ahead` or `no ladder ahead`.

The stats line gives world, feet position, fps, draw calls and triangles
of the previous frame (both passes), mode and quality; the second line is
CPU/GPU frame time, the scene graph's node count, and the viewmodel's weapon,
state, ammunition, ADS fraction and playing clip.

## Surfaces

`N` colours the collision mesh by the surface type the map's own materials
carry — `metal`, `dirt`, `concrete` and the rest of
[collision.md](collision.md#what-a-surface-is-made-of). One material per name,
hashed from the name, so a surface is the same colour on every map; `default`
is deliberately flat grey, because it is the answer for a face that says
nothing rather than a colour anyone chose.

Its own toggle rather than a fourth `C` mode, for `M`'s reason turned around:
this **is** the collider geometry, but what it shows is not what stops you. It
is the one fact about a map that only a footstep can hear, so the only check is
to look — walk onto the gantry and see whether it is the colour metal is.

Turning it on prints the triangle histogram to the console, and that histogram
is the acceptance test for an export: **a map that is all `default` means no
face's material was read, and a map that is all one kind means it was read from
the wrong place.** Both play perfectly. The stats line carries the number of
kinds and what is under your feet _now_, from the same `surfaceAt` a footstep
asks, so a colour you disagree with can be read off at the spot.

A world whose collision carries no surfaces at all — every hand-written world,
and every imported map not re-exported since the surface pass — says so and
draws nothing.

## Navigation

`K` draws the world's navigation graph as a game server would bake it
([navigation.md](navigation.md)), and it is baked here, in this tab: the
world's `nav.bin` is fetched through the session's `AssetStore` and `NavBake`
runs against this client's own collision with the world's mantles and ladders,
at the match's tick rate. Nothing is sent by a server, and a view nobody pressed
`K` for fetches nothing and bakes nothing.

The bake is seconds of CPU, so it runs 4 ms a frame (`NAV_SLICE_MS` in
`app/devTools.ts`): several times its CPU time in wall time, and the stats line
says `baking nav… 42%` meanwhile. Turning the view off pauses it. The nodes are
drawn at once where the file puts them, dimmed, and move onto their snapped feet
with the links when the bake is done. A world reload bakes again, against the
new collision, if the view is on.

- **Nodes** are a post and a cross at the feet: light grey for a place to walk
  through, blue for cover and concealment, orange for a traversal's ends. A node
  with a facing has a tick toward it. An **unusable** node is a larger cross by
  why: magenta for no ground (with a line down as far as the snap looked), red for
  inside something, yellow for one in a moving frame.
- **Links** go dim at their source to bright at their target, a few centimetres
  to their own right, so the two directions of a pair sit side by side and a
  one-way drop reads as one line. Green is a walk link the file brings from its
  source (`GAME`), teal one derived at load; both are VALID.
- **Traversals** are arcs over what they cross, coloured by kind: yellow step
  up, orange mantle on, deep orange mantle over, purple jump down, pink jump
  across, lilac jump up, light orange ladder up, rust ladder down. An INVALID one
  is red. All of them are drawn in both modes.
- **The second press** adds the INVALID walk links: dark red for a candidate
  the probe turned down (most of them, and ordinary: a pair across a wall), bright
  red for one the probe passed and the walk failed, grey for an unusable end.

When it finishes it logs the counts, the CPU and wall time, and a legend: every
colour with its count and hex, and the INVALID links by reason. With it on, the
stats line adds the graph's size and **the node you stand by**, with its links
out and the reason for each invalid one (`node #212 cover_crouch: 5 links out, 2
invalid (RISE, STUCK)`) — the answer to "why will a bot not go there?" without
picking a line.

A link a present removable part holds shut is magenta, whatever it would
otherwise be: the view bakes against the base with every part absent, as a game
server does, and marks each present part's links as a match's blockers hold them
([navigation](navigation.md#removable-parts)). A door opening turns its links back.

It shows the graph, not a bot's plan. The path a bot is walking lives on the game
server; drawing it will take a dev-only message from the server
([navigation.md](navigation.md#open)).

## Hit boxes

`B` draws every other player's hit volumes as wireframe boxes, coloured by the
location a hit on each counts as — head and helmet pink, neck orange, torso blue,
arms yellow, legs green, the gun grey — and through walls, because a box derived
from a limb's own vertices sits within a millimetre of the skin it describes.
The head is the one given a colour of its own; it is what people open this to
check.

Nothing else shows them. A player is _moved_ as a capsule and _shot_ as a
skeleton, so collider view draws the capsule and the volumes a bullet actually
meets are invisible
([collision.md](collision.md#a-bullet-hits-a-bone-not-a-capsule)).

Two things make it worth trusting:

- **The boxes are read off the rig that was just posed.** `net/remotePlayers.ts`
  interpolates a peer to the moment it is drawn at and updates its matrices, and
  the view takes each bone's `matrixWorld` as it stands — the same discipline `M`
  keeps by asking `MantleVolumes.find`. A view that posed a body of its own would
  be a view of a different body, and so worse than none.
- **A box stays in its bone's space, in inches.** A CoD body hangs from a
  `unit-scale` root of 0.0254 and the bone's world matrix carries it, so the
  corners are transformed and nothing is converted. A box drawn a fortieth of its
  size is what converting to metres looks like.

The boxes come from `<id>.hitboxes.json` beside each body in
`worlds/catalog/characters/<game>/<id>/`, fetched through the session's
`AssetStore` the first time a body is seen **with the view open** — a view nobody
pressed `B` for costs nothing. A sidecar that is missing or will not parse warns
once and that body is drawn without boxes; it can never take a frame down.

The stats line adds `N hit boxes on M bodies`, and both halves are worth reading:
boxes with no bodies means nobody is wearing one, a body with no boxes means its
sidecar did not load.

Like the bodies themselves, this **takes two clients to see** — nothing draws a
body for the local player, so it is `pnpm dev:mp` with two players ([one tab each](../server/README.md#one-tab-per-player))
([rendering.md](rendering.md#player-characters)).

## What the inspector reports

A ray hits a mesh, but a `model`'s meshes come from inside a glTF and carry no
authored identity. `engine/picking.ts` walks up to the nearest ancestor that
`packages/client/src/scene/` tagged: `userData.model`, `name`, `source`,
`collideMode` and, on an animated model, `animation`, all set in `models.ts`.
**A new node type must set these**, or it reports as whatever
untagged mesh was hit. Hidden colliders are skipped unless collider view is on
(see [collision.md](collision.md)).

The sun marker reads DirectionalLights from the built scene, not from
`ResolvedWorld.lights`: a world with no lights gets the default rig, which
never appears in the resolved list. Markers follow the camera, because a
directional light is at infinity.

## Pose links

`#<slug>@x,y,z,yaw,pitch[,hold]` in the URL enters that world at that camera.
Degrees, feet position in metres. `hold` freezes the player (no gravity, input
or collision) and pauses animation until a movement key is pressed, so a link
renders identically every time (`T` resumes animation without moving). `P`
writes one to the clipboard, the address bar and a toast.

## Screenshots and regressions

```sh
pnpm shots worlds/<slug>/_shots.json --out DIR [--compare BASELINE_DIR]
```

Loads each pose in headless Chromium (on the GPU; `--software` for
SwiftShader), waits until consecutive frames are identical, and saves a PNG.
`--compare` prints the fraction of pixels that changed and the mean change per
channel. The UI is hidden unless `--ui` is passed. Each imported world keeps its
poses in `_shots.json`, and every pose must have `hold`. The script signs in as a
bench account (`BENCH_USER`/`BENCH_PASSWORD`, registered on first use), since a
pose link otherwise lands on the sign-in screen.

## Performance

```sh
pnpm perf worlds/<slug>/_shots.json --out before.json
pnpm perf worlds/<slug>/_shots.json --compare before.json
```

Each pose loads in a fresh headless browser, so no shader is cached from the
last. It reports the load time and its slowest steps; the **stall**, the longest
frame in the three seconds after load, beside the shader programs compiled after
the prewarm — each of those compiled on a frame, which is what a player feels as
a hitch; the steady frame rate with vsync off; and one frame's draw calls and
triangles across every pass. The numbers are only comparable with each other on
one machine, and a change that moves them says so in its review.

## Logs

The console carries one line per load step with its time (`[load]`), and
summaries from collision, instancing, shadows and the renderer. Returning to
the menu logs `[menu] GPU holds N geometries, M textures`; after leaving any
world both should return to the menu's baseline. If they grow, something is not
reaching `AssetStore.dispose()` or `disposeScene()`.

## Hot reload

Saving a `.world` file re-mounts the world and keeps the camera. Changing an
asset (a re-exported `.glb` or texture) invalidates just that file in the
session's `AssetStore`, and world assets are served `no-cache`, so the new
version is fetched without a page reload. If a long-lived tab still shows
something that should be gone, try a fresh browser before theorising.

<!-- SHOTTRACE -->

## Shot traces (temporary)

`G` draws where a round went, the client's own answer beside the server's, and
reports how far apart they were. It exists to diagnose the two ends disagreeing
and **is meant to be deleted**:
[diagnostics-shottrace.md](diagnostics-shottrace.md) ends in the checklist for
removing it, and the server half sends nothing unless `SHOT_TRACE=1`.
