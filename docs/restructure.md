# Restructure plan

A proposal, for approval before any code moves. When a stage lands, what it
establishes moves into the page for its area (`docs/engine/rendering.md`,
`docs/server/README.md`, CLAUDE.md), and this file shrinks; when the last stage
lands it is deleted.

## Why

Three measured problems and one structural one, which causes the three.

| Measured on theater-bo1 (headless, so relative) | Now         | Without the cause |
| ----------------------------------------------- | ----------- | ----------------- |
| Frame rate with effects on                      | 27 fps      | 73 fps            |
| First frame after load (cold shader cache)      | 1.5 s stall | none              |
| Frame time added by the 32 scripted lights      | +3.7 ms     | —                 |

- **The effects' soft-particle depth pass re-renders the whole scene** with its
  real, lit materials into a render target every frame. That doubles the draw
  calls, and the frame is CPU-bound on three's per-draw work (culling 18%,
  uniform upload ~25% of the main thread). Being a render target, it also needs
  a second variant of every scene shader, which the load-time prewarm never
  compiles: 49 programs compile synchronously on the first frame.
- **The lights** are three's built-in punctual lights, unrolled into every lit
  shader and evaluated for every pixel whether it is reachable or not.

The structural problem: the engine has no designated place for a rendering
feature, a per-game rule, or a step of the frame, the tick or the load. So each
feature wires itself in through whatever is nearest — `App`, a one-slot hook, a
global shader rewrite on import — and the costs and orderings it brings are
visible nowhere. The audits found the same pattern on the server.

## Rules

These are what the stages establish, and what review holds new work to.

1. **Each concern has one owner, and features plug in rather than wire through.**
   A new rendering feature is a pass or a shader patch; a new per-frame system is
   an entry in the update list; a new tick step is a phase. None of them is a new
   field and three new calls in `App` or `Match`.
2. **Order is code, not comments.** The frame, the tick and the load are each a
   named, ordered list. Where one step needs another first, the list says so and a
   test pins it.
3. **The engine does not know which game a world came from.** Game semantics are
   translated into general engine data at one boundary: the exporter
   (`scripts/cod/<game>/`), or at most one load-time adapter per subsystem for data
   already exported. `game` may name a namespace (which sound bank, which catalogue
   folder); it may not be a branch condition in `engine/` or `scene/`. Enforced by
   a lint rule.
4. **No module changes global state on import.** Global shader changes are
   installed by the renderer that owns them, once, where they can be seen.
5. **Cost is part of done.** The profiler reports time per pass; `pnpm perf <world>`
   reports load time, first-frame stall, steady frame time, draw calls and
   programs, and a change that moves them says so in its review.
6. **One job per file.** A soft `max-lines` lint warning (600) prompts the
   question; a long file that is one detailed concept (the movement step, the
   weapon state machine) is allowed to stay long.

## Target structure

### 1. Rendering — `client/src/engine/render/`

Done in stages 1 and 2 ([the frame](engine/rendering.md#the-frame)); the
per-frame update list that runs before the passes followed in stage 4
(`app/frame.ts`).

### 2. The game boundary

- **Effects** — done in stage 3. The four runtime branches on the library's game
  (fade rounding, tail roll, billboard facing, atlas range) are the element and
  library properties `facing`, `rolls`, `atlas.ranged` and `fadeQuantise`.
  `scripts/cod/fx.py` writes them (library version 5); `readFxLibrary` derives
  them for a version-4 library, the one place in the engine that reads a game.
  A lint rule bans comparing a game key in `engine/` and `scene/`; audio's
  comparisons of one bank's game with another's are namespaces and untouched.
- **Layer blending** already works this way: general modes (`blend`, `multiply`,
  `add`, `test`) the exporter writes. Another game's blending maps onto these or
  adds a general mode; it never becomes a per-game path.
- **The grade** is already general data. Nothing imports a game's own tone curve
  yet; when one is, it arrives as a general `curve` in the grade block rather
  than a per-game path. Not built ahead of a world that needs it.
- **Lights** are general (`range`, `cone`); the Black Ops translation lives in
  `scripts/cod/lights.py`. The falloff shape currently taken from T5 and applied
  to every game becomes a light property if a second shape is ever needed.

### 3. The client app layer — `client/src/app/`

Done in stage 4. `App.ts` (1,308 lines) is the composition root (361, half of
it the UI's command table): it builds the pieces below, hands each the others it
needs, and owns nothing else.

| Owner                 | Owns                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `Systems`             | every page-lifetime engine object, built once and wired to the renderer                                 |
| `GameContent`         | the weapon registry, the cast catalogue and the gametype: one live holder, read at use                  |
| `CurrentWorld`        | the mounted session, written by the loader and read by everything that outlives it                      |
| `FrameUpdates`        | the per-frame update list (`frame.ts`), named and ordered as the passes are, each step timed            |
| `ScreenRouter`        | the only writer of `ui.screen` (a test holds it to that)                                                |
| `WorldLoader`         | the serialised load queue and its generation, entering and leaving, and hot reload                      |
| `MatchController`     | connection, roster, tick rate, the snapshot fan-out, **one** teardown list                              |
| `PauseController`     | view mode, prompt, pause, pointer lock, waiting to be spawned                                           |
| `Settings`, `Toaster` | quality, sensitivity, volume; the toast timer                                                           |
| `Presenters`          | HUD, minimap, crosshair cone, use focus: one entry in the update list                                   |
| `WeaponViewmodel`     | hands, carried and drawn weapon, swap following                                                         |
| `dev/`                | `DevTools` composing `Inspector`, `Overlays`, `NavDebug` and `StatsReadout`, each over one `DevContext` |

The `Engine` bag is gone: `WorldSession` takes `Systems`, `GameContent`, the
`WeaponViewmodel` and the dev tools, each a live object, and keeps the mount
pipeline and the world's assets only. Hot reload went to the loader rather than
the dev tools, since a reload is a load. `uiBridge.ts` no longer reaches
three.js (the quality levels are their own module, and a test walks the bridge's
imports) and re-exports the lobby modes rather than computing them.

### 4. The game server — `game-server/src/match/`

`match.ts` (2,550 lines, about fifteen jobs) becomes a folder, with the tick as a
phase list:

`outbox.expire → scripts.start → bots.think → per member: inputs.take → use → step → combat.fire → drift.record → interactions → fall-out → actors.step → health → occupancy → scripts.tick → physics → parts.flush → history → snapshot`

Extracted in order of ease: `EventOutbox`; `InputQueue` (with drift); `ScriptHost`
(`first(hook)` / `each(hook)`, replacing eight copies of "first script with an
opinion wins", and one context per tick instead of several per hit); `Rewinder`
(lag compensation, target computed once per shot); `MatchNav` (an explicit poll
in place of a getter that builds planners as a side effect); `Classes`;
`BotDriver` (sharing its turn code with `Actors`); `Combat` (shots, damage queue,
health). `Member` (20 fields mixing transport, simulation, classes and bots)
splits along the same lines. `net/server.ts` keeps transport only: stepping
games and the shot-trace diagnostic move out.

### 5. Shared

- `sim/movement.ts` (1,134 lines) is the one grab-bag: ladder steering and the
  mantle move next to their volumes (`ladder.ts`, `mantle.ts`, whose header
  already claims them), step-slide collision becomes `stepSlide.ts`, the gait
  clocks `gait.ts`. Deterministic and replayed, so the existing tests and a
  replay comparison guard it.
- `collision/world.ts`: the prop-hull grid becomes `hullIndex.ts`.
- `resolve.ts`, `schema.ts`, `player.ts`, `weapon.ts` and the large client debug
  views are long but cohesive, and stay.

## Defects found by the audit

Checked against the code. Each is fixed in the stage that moves its code, with a
test.

| Defect                                                                                                          | Where                        | Status                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A dropped match connection is never cleared, so a reload never rejoins and input is sent into a dead channel    | `App.ts` 697–709             | **fixed in stage 4** (`MatchController.disconnect`, with a test)                                                                                  |
| Lag-compensation counters count once per candidate player, not per shot, so `/healthz` grows with roster size   | `match.ts` 2344, 2187        | confirmed                                                                                                                                         |
| A world entered before the weapon catalogue loads keeps an empty registry for the session, hot reloads included | `App.ts` 400, `WorldSession` | **fixed in stage 4** (`GameContent`, read at use)                                                                                                 |
| Layers and flag wind on one material: the second overwrote the first                                            | `layers.ts`, `flag.ts`       | **fixed in stage 1** (patch composer, with a test); a blend replacement deliberately starts with no patches                                       |
| A grade change on hot reload kept old shader programs                                                           | `grade.ts`                   | **fixed for the world in stage 2** (the output pass is keyed on the grade); the viewmodel's materials can still keep the last grade until rebuilt |
| `SceneDepth` is never disposed                                                                                  | `fx/system.ts`               | **gone in stage 2**: the depth pass no longer exists                                                                                              |
| Effects judged against last frame's camera                                                                      | `App.frame` order            | **fixed in stage 4** (the update list, with a test)                                                                                               |
| A runtime quality change misses the viewmodel's shadow filter and anisotropy                                    | `quality.ts`                 | **fixed in stage 4** (`RenderPass.scene`, `applyQualityTo`, with a test)                                                                          |
| Leaving a match fires no trigger-leave or script hook                                                           | `match.ts` 906               | by reading                                                                                                                                        |

Checked and **not** a defect: "a seated player gets no snapshots" — seated
players are members, so the game still sends.

## Stages

Each stage is behaviour-neutral unless it says otherwise, and stops for your
review before the next. The gate for every stage: typecheck, lint, all tests,
and `pnpm perf` plus screenshots on theater-bo1, russianbase-bo1 and dome-mw3
compared with the stage before.

0. **Measurement** — done: `pnpm perf` and a signed-in `pnpm shots`
   ([debugging](engine/debugging.md#performance)).

   Baseline at Stage 0 (`pnpm perf worlds/<slug>/_shots.json`, RTX 4070 Ti headless):

   | World           | Load  | Stall   | Late programs | FPS   | Draws |
   | --------------- | ----- | ------- | ------------- | ----- | ----- |
   | theater-bo1     | 8.6 s | 1478 ms | 49            | 27.6  | 2528  |
   | russianbase-bo1 | 5.7 s | 1002 ms | 45            | 40.1  | 2026  |
   | dome-mw3        | 4.5 s | 521 ms  | 30            | 103.8 | 560   |

   Every world stalls after load, not only theater: the prewarm misses programs
   on all of them.

1. **Rendering structure** — done. Pixel-identical on all three worlds; frame
   rate unchanged within run-to-run noise (theater varies by about ±1.5 fps).

   | World           | Stall         | Late programs | Load        |
   | --------------- | ------------- | ------------- | ----------- |
   | theater-bo1     | 1478 → 171 ms | 49 → 0        | 8.6 → 8.4 s |
   | russianbase-bo1 | 1002 → 69 ms  | 45 → 0        | 5.7 → 6.8 s |
   | dome-mw3        | 521 → 35 ms   | 30 → 0        | 4.5 → 5.2 s |

   The prewarm now does a first frame's work at load, so loading takes up to a
   second longer and the first frames of play do none of it.

2. **Rendering fix** — done. The world is drawn once, into a target that keeps
   its depth; an output pass tone-maps, grades and fogs it in three's own order;
   effects draw after it and test against that depth.

   | World           | FPS (stage 1 → 2) | Draws       |
   | --------------- | ----------------- | ----------- |
   | theater-bo1     | 27 → 68           | 2528 → 1278 |
   | russianbase-bo1 | 40 → 102          | 2026 → 1036 |
   | dome-mw3        | 103 → 233         | 560 → 292   |

   Pixels: 3–13% changed, mostly by a level or two. Edges are resolved before
   tone mapping, so high-contrast silhouettes differ by a pixel; glass, blended
   in linear light now, is slightly clearer.

3. **Game boundary** — done. Effects read properties, not a game (§2); the
   exporter writes them and one adapter reads the libraries already on disk;
   the lint rule holds `engine/` and `scene/` to it. Pixel-identical on all
   three worlds; frame rate and load unchanged within noise (dome, the noisiest
   at over 200 fps, measured 194–236 across three runs).
4. **Client app layer** — done (§3), with the four app-layer defects below.
   Pixel-identical but for the viewmodel, whose textures now get the quality
   level's anisotropic filtering (it was never applied to them). Frame rate,
   stall and load unchanged within noise. Found on the way and fixed: joining a
   match's channel cleared "waiting to be spawned", so a click on the joining
   prompt could start play before a class was chosen; and a session the api
   signed out showed the sign-in screen over a still-running world.
5. **Game server.** §4, with its defects.
6. **Shared.** §5.
7. **Then features again, placed:** clustered local lights (a fixed light loop,
   lights culled per screen cluster, switching a light is a data write, which is
   what power needs); and draw calls (1,260 for one view of theater — the biggest
   lever left once the depth pass is gone).

Stages 1–3 and 4–6 do not depend on each other and could be interleaved;
in order they keep each review to one area.

## Decisions for you

1. **The uncommitted work on theater.** The exporter, DSL and lightmap work is
   sound and could be committed now. The 32 scripted lights cost about a quarter of a
   frame until stage 7: keep them in theater, or remove them from its world file
   until clustered lights exist?
2. **Stage 2's look.** Moving the grade to a final pass grades the effects and
   anything drawn after the world consistently, which is closer to the games, but
   pixels change. Acceptable, given a screenshot review?
3. **Scope.** All seven stages, or the rendering half (0–3) first and the rest
   after?
