# 3D Designer

A browser 3D engine for walkable worlds. Worlds are plain-text `.world` files
under `worlds/<slug>/`: Call of Duty maps imported by a Python pipeline, plus
the gameplay a human layers over them. The direction is a multiplayer game.

**Creating or editing a world:** read **`worlds/AUTHORING.md`**, the complete
reference for the format. Validate with `pnpm check worlds/<slug>` and fix
everything it reports.

**Importing or fixing a Call of Duty map:** read **`docs/cod/README.md`**, then
`pitfalls.md`. Most failures there look plausible rather than broken (inside-out
faces, props at the origin, a lightmap in the wrong channel). Geometry piled up
at the world origin is a brush-model placement problem, not a rendering bug.

**Changing the engine:** read the rest of this file, then the `docs/engine/`
page for the area: [rendering](docs/engine/rendering.md),
[collision](docs/engine/collision.md), [player](docs/engine/player.md),
[physics](docs/engine/physics.md), [scripting](docs/engine/scripting.md), [audio](docs/engine/audio.md),
[navigation](docs/engine/navigation.md), [actors](docs/engine/actors.md), [ui](docs/engine/ui.md), [debugging](docs/engine/debugging.md).

**Changing either server, matchmaking, or how they are deployed:** read
**[docs/server/README.md](docs/server/README.md)** — the two-server topology, the
routes, matchmaking and the lobby's three states, the boot order, the env vars,
the two images and the compiled `dist/` they run rather than `tsx`, and the two
halves of reaching a game server from a browser — the handshake and the
candidates — either of which fails silently on its own.

## Where things live

A pnpm workspace of four packages. Two of the splits are load-bearing.

`@3d/shared` exists because the direction is a server-authoritative multiplayer
game: the client predicts its own movement, the server re-simulates it to check,
and the code that has to agree lives in one place rather than two.

The two servers are split because they want opposite deployments. `@3d/api` is
the authority and owns everything that outlives a request — `worlds/` on a
volume, users and played games in SQLite — and there is one of it. It also does
the matchmaking: it decides that a game exists, who is in it and where it runs.
`@3d/game-server` hosts those games, holds nothing that survives them and reads
nothing off disk, so it can be started in bulk from an image, an `API_URL` and a
token. It is not tied to a map either: it loads whatever world an order names and
unloads it when the last game on it ends.

**Both servers are wired the same way.** Everything in either that outlives a
request is a tsyringe singleton, resolved once in its `index.ts`, and every
long-lived pass is a `LoopBase` from `@3d/shared/lifecycle/` so that the two
shutdowns are one implementation. **Name every injected dependency with
`@inject(Thing)`**, even where the parameter type already says so: `tsx` runs
both processes and esbuild under it ignores `emitDecoratorMetadata`, so an
inferred type never reaches the container — it typechecks, every test passes,
and the process dies on its first resolve. Each package's
`tests/container.test.ts` is the guard.

| Path                           | What                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **`packages/shared/`**         | **`@3d/shared` — everything both ends run.** Isomorphic: no DOM, no Node                                                      |
| `shared/src/dsl/`              | `.world` text → `ResolvedWorld` (plain data). Synchronous, no three.js                                                        |
| `shared/src/protocol/`         | The HTTP contract, declared once per route: `route.ts` the mechanism, `routes/` the declarations, `api.ts` the table          |
| `shared/src/protocol/routes/`  | One file per area — path, auth, params, input and output schemas. Both ends are built from these                              |
| `shared/src/protocol/events/`  | The SSE event shapes, declared once: what a player hears, and what a game server is told to do                                |
| `shared/src/worlds/`           | `WorldSource` and the one loader over it — the only caller of the DSL pipeline                                                |
| `shared/src/sim/`              | The player a client predicts and a server replays: movement, weapon, `PlayerInput`/`PlayerState`                              |
| `shared/src/net/`              | The binary wire format: `codec/` the mechanism, `messages/` the descriptions, `packet.ts` the entry point                     |
| `shared/src/lifecycle/`        | `LoopBase`: start/stop, a pass, a period. `FixedRateLoop` where the period is a contract. Both servers loop on it             |
| `shared/src/game/`             | Gameplay: gametypes declared as data, and the scripts that run them. Who a player is, and which spawns a mode wants           |
| `shared/src/nav/`              | Bot navigation: `nav.bin`'s reader, the bake against movement collision, the graph, A\*, the follower, a match's shut links   |
| `shared/src/game/bots/`        | Bots in three layers: objective (script), goal (brain), input (motor). Server-run: the api and client may not import it       |
| `shared/src/game/actors/`      | Creatures that are not players: kinds as data, the spawn and the twelve-byte `ActorState`, and `poseActor` for both ends      |
| `shared/src/collision/`        | The capsule query, the bullet trace, prop hulls, a map's collision mesh. **three.js allowed**                                 |
| `shared/src/rig/`              | A third-person body: its skeleton, its clips, the head and weapon rebound onto it. **three.js allowed** — a server poses one  |
| `shared/src/physics/`          | Everything dynamic and replicated: the Rapier world, the entity registry, a corpse's sixteen boxes. **three.js and Rapier**   |
| **`packages/api/`**            | **`@3d/api` — the HTTP authority.** Node only, and no three.js. One of these                                                  |
| `api/src/index.ts`             | `reflect-metadata`, then `container.resolve(ApiServer)`. The only place a signal is handled                                   |
| `api/src/server.ts`            | `ApiServer`: the boot order, and the only thing `index.ts` starts                                                             |
| `api/src/app.ts`               | `App`: the Hono app, built from the route groups in order, so a test mounts it with `app.request()`                           |
| `api/src/routes/`              | One file per area. `mount.ts` turns a route declaration into a handler — auth, params, body, status codes                     |
| `api/src/worlds/`              | What a world is on disk: the reader, the manifest and its cache, and `paths.ts` — the only place a URL becomes a file         |
| `api/src/registry.ts`          | Which game servers are live. In memory, so true of one api process                                                            |
| `api/src/matchmaking/`         | The queue, the lobbies, the decisions, and the loop that drives them                                                          |
| `api/src/auth/`                | Who is calling: `service.ts` the fleet's token, `sessions.ts` a player's cookie, `users.ts` the rows, `passwords.ts` argon2id |
| `api/src/catalog.ts`           | The catalogue it serves — every kind — and the weapon registry a stored class is read against. One cached read behind both    |
| `api/src/loadouts.ts`          | A player's five classes, and what a stored one means against the catalogue as it stands today                                 |
| `api/src/db/`                  | drizzle + SQLite: users, sessions, and the games that were played. Migrated on open                                           |
| **`packages/game-server/`**    | **`@3d/game-server` — the games it is given.** Node only. Many of these                                                       |
| `game-server/src/server.ts`    | `GameServer`: the boot order, and the only thing `index.ts` starts. Every service below it is a tsyringe singleton            |
| `game-server/src/worlds.ts`    | The maps loaded right now, refcounted by game: loaded on order, unloaded when the last game on one ends                       |
| `game-server/src/api.ts`       | Its link to the authority: the world source, the api client, the token                                                        |
| `game-server/src/net/`         | geckos.io (WebRTC data channels), as one raw binary channel over `@3d/shared/net`                                             |
| `game-server/src/match.ts`     | The players, the fixed tick, and the drift between a client's claim and our replay. No transport, so a test drives it         |
| `game-server/src/collision.ts` | The BVH, built from a mesh fetched over HTTP rather than read off disk                                                        |
| `game-server/src/nav.ts`       | `NavBaker`: each loaded world's graph, baked in slices between ticks. Bots stand still until it is done                       |
| `game-server/src/bots.ts`      | The seam a bot's input comes through: a `BotController` per bot, written once a tick before the drain                         |
| `game-server/src/actors.ts`    | One match's actors, owned by `Match`: spawned by scripts, thought for by brains, stepped after the players, shot and hitting  |
| **`packages/client/`**         | **`@3d/client` — the browser game.** `index.html` and `vite.config.ts` live here                                              |
| `client/src/scene/`            | `ResolvedWorld` → three.js objects: models, characters, viewmodel, baking, instancing                                         |
| `client/src/engine/`           | Renderer, controls, shadows, grade, quality, picking, debug views, viewmodel, particle effects (`fx/`), sound (`audio/`)      |
| `client/src/input/`            | Keyboard, mouse and pointer lock → named actions (`bindings.ts`)                                                              |
| `client/src/net/`              | The match: finding a game server, the data channel, the other players as characters (or capsules)                             |
| `client/src/net/actors.ts`     | The actors, drawn beside the scene like corpses and interpolated like peers: a posed rig, or the kind's capsule               |
| `client/src/app/`              | Wiring: `App` (page lifetime), `WorldSession` (one loaded world), dev tools, the UI bridge                                    |
| `client/src/ui/`               | Preact: menus, loading/error/pause screens, HUD, dev overlay                                                                  |
| `client/vite/`                 | The `worlds/` watcher. The routes themselves are proxied to `@3d/api`                                                         |
| `scripts/`                     | `check.ts` (`pnpm check`), `cod/` (the CoD importer, Python). Stays at the root                                               |
| `reverse/`                     | Reverse-engineering: one folder per question, its write-up, and the tools to check it again                                   |
| `worlds/`                      | One folder per world; `assets/` beside the `.world` files. `_*.json` stays out of builds                                      |
| `worlds/catalog/`              | What belongs to no one world: weapons, attachments, props, bodies, hands, clips, sounds. Served at `/api/catalog`, gitignored |

Tests live with their package (`packages/*/tests/`), placed by what they import
rather than by what they are about. `pnpm test` runs all four as one vitest
workspace.

## The pipeline

```
source text
  → dsl/tokenizer.ts  → Token[]
  → dsl/parser.ts     → WorldFile (never throws; records a Diagnostic and recovers)
  → dsl/loader.ts     → include-expanded Statement[] (callers pass pre-read sources)
  → dsl/resolve.ts    → ResolvedWorld
      └─ runs dsl/schema.ts first and returns early on any error
  → scene/scene.ts    → THREE.Group (models fill in asynchronously via BuiltScene.pending)
  → app/WorldSession  → collision, instancing, frozen matrices, shadows, quality
```

Those two steps have **exactly one caller**:
`shared/src/worlds/load.ts`'s `loadResolvedWorld`, over a `WorldSource`. The
browser, a game server and `pnpm check` differ only in which source they hand it
— `httpWorldSource` (shared) or `fsWorldDirSource` (`@3d/api`). Schema validation is
inside `resolveWorld`; don't add a third call, and don't add a second caller.

`resolve.ts` is the semantic core. It is split into `resolved.ts` (the
`Resolved*` types) and `resolveUtil.ts` (AST readers). One thing in it is
load-bearing:

- **A group is the only nesting, and it resolves depth-first** with cycle
  detection, memoized per node. A placement's world position is its enclosing
  group's origin plus its own `at:`, rotated into that group's frame, and
  `ResolvedObject` comes out flat.

`WorldSession.mount` runs the load as named steps in order. Each step's comment
says what it depends on: models before collision, collision before instancing,
instancing before freezing matrices, the content bounds before the shadow fit.

## Boundaries (enforced)

Two mechanisms, because neither sees the whole picture. The tsconfigs police
_globals_ — what a file may reach for without importing it — and ESLint polices
_imports_. Both are checked in CI by `pnpm typecheck` and `pnpm lint`.

- **`@3d/shared` is isomorphic**, in three tiers:
  - `dsl/`, `protocol/`, `worlds/`, `sim/`, `net/`, `lifecycle/`, `game/`, `nav/` — no DOM,
    no Node, **no three.js**.
    `packages/shared/tsconfig.json` typechecks them with `lib: ["ES2022"]` and
    `types: []`, so a bare `document.` or `process.` is a build failure.
  - `collision/` and `rig/` — the same, **except three.js is allowed**
    (`tsconfig.collision.json`, `tsconfig.rig.json`). three-mesh-bvh needs
    `BufferGeometry` as a container and `Line3`/`Box3`/`Matrix4` for the capsule
    maths; a rig needs a scene graph and an `AnimationMixer`, because a player is
    _moved_ as a capsule and _shot_ as a skeleton, so a server judging a shot has
    to pose the same body the client drew. That is three as a geometry and
    animation library: no renderer is constructed, no DOM is touched, so both
    still run in Node.

  - `physics/` — the same, **plus Rapier** (`tsconfig.physics.json`). Everything
    dynamic and replicated is here, because a corpse, a grenade, a rocket and a
    care package are one mechanism: a rigid body created from an authoritative
    spawn, stepped once per server tick on _both_ ends, and — where gameplay reads
    it — corrected by the server. Two implementations of that would diverge, and a
    diverged grenade is a player killed by an explosion that happened somewhere
    else. three.js on `rig/`'s terms, because a ragdoll reads a skeleton's bind
    pose and writes bone transforms back; Rapier as a physics library and never as
    a loop, with `world.timestep` fixed at `1 / tickRate` and `step()` called
    exactly once per tick. See [docs/engine/physics.md](docs/engine/physics.md).

    None of the three is a licence to widen. Each has its own tsconfig naming
    exactly one subtree, and three is the number there is an argument for — adding
    a fourth means writing down what it is for, because a quietly widening
    `types: []` is how the isomorphism invariant dies. **Rapier is banned outside
    `physics/`**, including in both servers and the client, which reach it through
    that subtree: a second module holding the engine is a second set of
    integration parameters and a second construction order, which is how two
    machines stop agreeing about where a grenade landed.

  `game/`, `sim/` and `nav/` carry one rule of their own, in `eslint.config.js`
  rather than a tsconfig: **`Math.random` and `Date.now` are banned there.** A
  script hook runs on both ends and must be a pure function of what it is handed
  — a client predicting and a server replaying have to agree — and both of those
  are in `lib: ["ES2022"]`, so `types: []` cannot catch them. Randomness comes
  from `GameView.seed` through `game/random.ts`, and the clock from
  `GameView.now`, which is `tick / tickRate`. A navigation bake takes its time
  budget from its caller, so its graph never depends on how it was sliced.

  The host globals the package does rely on are declared, one at a time, in
  `packages/shared/src/platform.d.ts`. That file is the complete list; anything
  not in it is a build failure, which is the point. It is also why `lifecycle/`
  can live here: a loop needs timers, an `AbortSignal` and somewhere to report a
  failed pass, and each is declared as the narrow shape this package uses rather
  than pulled in as Node's or the DOM's whole type. `fetch` is deliberately _not_
  in it: `protocol/http.ts` names the shape this package uses and every caller
  injects its own, which is also what lets a test fake a response with an object
  literal. See [docs/server/README.md](docs/server/README.md).

- **Packages point down.** `@3d/shared` imports none of the others. Neither
  server imports `@3d/client`, and `@3d/client` imports neither server — not at
  run time, and not at build time either, now that Vite proxies the world routes
  instead of re-serving them. There is no exception any more; there used to be one
  for `vite.config.ts`.
- **The two servers are siblings, not layers.** `@3d/api` and `@3d/game-server`
  may not import each other; they talk over HTTP. They are separate deployments,
  and the day one reaches past HTTP for a convenience is the day that stops being
  true. The one exception is `packages/game-server/tests/`, which stands both ends
  up to prove they agree — a test against a mock of the api would only agree with
  itself.
- **A bot's brain runs on a game server only.** `@3d/shared/game/bots/` is
  lint-banned in `@3d/api`, the client and the root tooling (`noBrains`): nothing
  a brain remembers is replicated, and a script names a brain by id so that the
  script table a browser imports pulls none of it in
  ([scripting](docs/engine/scripting.md#bots)).
- **`@3d/api` has no geometry to do**, so three.js, `@3d/shared/collision`,
  `@3d/shared/physics` and Rapier itself are banned there. It serves world text and streams files; the process handling
  every asset request should not carry a BVH library.
- **A slug becomes a path in exactly one module.** `api/src/worlds/paths.ts` is
  the only place a piece of a URL is joined to `WORLDS_ROOT`, and the rest of
  `@3d/api` may not import `node:fs` or `node:path` at all — bar the three whose
  paths come from the environment rather than a request (`config.ts`, `db/`,
  `routes/client.ts`). That is the whole of the directory-traversal surface, in
  one place rather than a guard each new route has to remember —
  [docs/server/README.md](docs/server/README.md#a-slug-is-not-a-path).
- **Cross a package by name**, never by climbing out with `../`.
- **The simulation sees collision through an interface.** `sim/` may import
  `sim/capsule.ts`'s `CapsuleWorld`, never `collision/world.ts` itself — that is
  what keeps `sim/` free of three.js.
- **Layers point down inside the client too.** `engine/`, `scene/`, `input/` and
  `net/` never import `ui/` or `app/`. `net/` is transport only: `app/` decides
  when to connect, and the UI is told nothing.
- **The UI sees only `app/uiBridge.ts`**: signals of plain data and a set of
  commands. No three.js values; gameplay input stays in
  `packages/client/src/input/`.

## Invariants

- **Every `Position` carries its own `file`**, so a diagnostic from an
  `include`d file points at that file. Never build a `Span` without it.
- **`ResolvedObject` is a flat list.** A group's transform is baked into each
  child during resolve.
- **Picking relies on tags.** A node's `userData.model`/`name`/`source`/
  `collideMode` is what the inspector reports. Hidden colliders set
  `userData.collider = true` and are hidden by material, never by `visible`
  (the BVH skips invisible meshes). See [collision](docs/engine/collision.md).
- **Assets belong to a session, not to a world.** A session's `AssetStore` owns
  every model, texture and derived material it loaded — the world's own and the
  catalogue's alike — keyed by the URL it loaded them from; `dispose()` on leaving
  frees them all. A hot reload keeps the store and invalidates only the changed
  URL. **Nothing caches assets at module level**, so leaving a world frees its GPU
  memory even for a catalogue model the next world would have wanted: re-fetching
  one costs a warm HTTP cache, and not freeing it costs a leak no `dispose()` can
  find. `client/src/scene/assetUrl.ts` is the only place either kind becomes a URL,
  because a second spelling of one file silently stops invalidating it.
- **Nothing in a built world moves, except `animate:` rigs and flag-wind
  vertices.** Particle effects move too, but they are not in the built world:
  `engine/fx/` writes them in world space under a root of its own, beside the
  scene, so none of the list below applies to them. **Corpses are the same
  exception in the same shape** — `client/net/corpses.ts` owns a root beside the
  scene and drives its own matrices, and its bodies never entered the built world
  to be frozen in the first place. **Actors are the same again** —
  `client/net/actors.ts` owns a root beside the scene, interpolates and poses its
  own bodies, and none of them casts a shadow. **So is sound**, for a sharper reason: a
  `THREE.PositionalAudio` writes its panner from `updateMatrixWorld`, so one added
  to the built world plays at the world origin for ever and says nothing about it
  ([audio](docs/engine/audio.md)). Everything else relies on these, and `engine/animator.ts` undoes
  each for its own rigs only:
  1. `scene.matrixWorldAutoUpdate = false` (`engine/viewer.ts`): the animator
     updates its rigs' matrices itself;
  2. `matrixAutoUpdate = false` on every node (`WorldSession`, "freeze
     matrices"): re-enabled on the rigs it plays, after the freeze;
  3. `shadowMap.autoUpdate = false` (`engine/viewer.ts`): animated meshes cast
     from their bind pose;
  4. skinning baked out at load (`scene/bake.ts`): `AssetStore` keeps an
     unbaked rig beside it for an asset with clips;
  5. instancing by geometry and material (`scene/instancing.ts`), which skips
     skinned meshes;
  6. the BVHs are built once per load (`collision/world.ts`), from rigs at
     rest; a match changes only which parts are present, never a tree. A
     removable part's render meshes are the one thing a match shows and hides
     (`visible`), and instancing never pools them.

  `ShadowPolicy` in `engine/shadows.ts` is the switch for shadows that move.
  Details and measurements: [rendering](docs/engine/rendering.md). The
  first-person viewmodel moves too, but in a pass of its own that none of
  this touches (`engine/viewmodel.ts`).

## Extending the DSL

In this order, since each step assumes the previous:

1. `dsl/schema.ts`: register the node in `NODE_TYPES` and any property in
   `PROPERTY_KINDS`.
2. `dsl/resolve*.ts`: read it with the helpers in `resolveUtil.ts` and add a
   field to the relevant type in `resolved.ts`.
3. `packages/client/src/scene/`: turn it into three.js objects, tagged for picking.
4. `tests/`: parse a snippet and assert on diagnostics or resolved values.
5. `worlds/AUTHORING.md`: a feature not documented there does not exist for a
   world author. Add or extend a worked example for new capabilities.

## Known rough edges

- **A model's `size` is declared, not measured.** The resolver is synchronous
  and runs before any `.glb` is read, so the exporter writes the footprint out
  and nothing verifies it against the file.
- **`until:` on an `asset` is parsed but not used.** Nothing culls by distance
  yet, and worlds exported before the fix carry the wrong value.
- **A world that names catalogue entries is not self-contained.** `pnpm check` on
  an imported map now needs a catalogue built for its game, and one built from a
  different set of maps reports entries it has never heard of. A hand-written world
  using only `source:` is unaffected.
- **A catalogue body has one weapon's joints baked into it.**
  `scripts/cod/characters.py` grafts the gun the viewmodel stage chose, so a peer
  holds _that_ gun and not the one their class names. Each entry records
  `bakedWeapon` so there is something to check against when run-time grafting
  lands.
- **The view hands are chosen per game, not per side.** A gametype names one pair
  for a whole game, so 21 of 42 imported worlds show a different pair than they
  used to name. The catalogue holds all 46; picking per side is what teams will do.
- **Riot shields and Ghosts' knife-only weapon draw nothing.** Their `adsUp`/
  `adsDown` roles name one-frame clips that move no bone, which the catalogue
  writes as no animation at all, so `buildViewmodelRig` throws "not in the file"
  and `WorldSession` leaves the player unarmed (iw4, both iw5 copies, iw6, and
  `iw6_knifeonly_mp`). AW's build drops such a role (`catalog.s1_without_still_clips`);
  the other games' builds do not yet.
- **`pnpm shots` cannot reach a world.** A pose link lands on the sign-in screen
  (`client/src/app/App.ts`) and the script has no sign-in step, so it waits until it
  times out. Pixel diffs are the acceptance test three parts of the asset migration
  wanted, and this is why they were not taken.
- **Zombies has never been seen or heard in a browser.** Its whole round loop is
  proved headless on theater-bo1 (`game-server/tests/zombiesNav.test.ts`), but no one
  has looked at an actor's pose, the prompt or the tally on screen, or listened to a
  zombie, a round sting or a purchase — for either game's horde.
- **Black Ops II borrows Black Ops' bodies.** `t6` has its own weapons and view
  hands in the catalogue but no bodies yet, so its players wear `t5`'s bodies and
  clips until they are built (`CAST_STAND_IN` in `shared/src/game/cast.ts`).
- **Only theater-bo1 and pentagon-bo1 carry the new gameplay data.** The exporter
  now writes a `solid` for every removable brush model, but every other world's
  `collision.glb` predates that split. A `--gameplay-only` rewrite of one before a
  `--collision-only` export names parts its glb lacks, and `pnpm check` does not
  read the glb to say so.
- **`catalogHash` covers weapons only.** A client and a server built from different
  actor exports draw different creatures and do not refuse each other.
- **Only russianbase-bo1 draws its terrain layers.** Every other Black Ops world's
  `world.glb` predates the layer export and draws each layered surface as its base
  alone, so blends show as hard seams until its shell is re-exported. Black Ops
  II, Ghosts and AW keep their layers elsewhere, and none of the three is read
  yet ([layered materials](docs/cod/reference.md#layered-materials)).
- **An actor walks a graph measured for a player.** Which nodes are usable and which
  links a part's corridor fills were sampled with a player's capsule.

## Writing comments

- A comment explains a constraint, an invariant or a non-obvious decision, in
  five lines or fewer, next to the code it guards.
- History belongs in commit messages, not in comments or docs.
- Each fact is explained in one place and linked from others. Long rationale
  goes in `docs/`.
- A trap that produces a plausible wrong result gets an assertion or a test,
  not a paragraph.

## Commands

Run from the repo root; each delegates to the package that owns it.

- `pnpm dev`: the client (Vite, :5173) **and `@3d/api` (:9208)**, in parallel.
  Vite proxies `/worlds*` and `/api/*` to the api, so both are needed. Env comes
  from `.env.local` at the repo root (not committed; `.env.example` documents
  every variable) — `vite.config.ts` points `envDir` back at it, and the servers
  read it through `--env-file-if-exists`.
- `pnpm dev:mp`: the same, plus a `@3d/game-server`, which is what multiplayer
  needs. `pnpm dev` deliberately does not start one: a client with no game server
  to join plays exactly as it does offline.
- `pnpm dev:client` / `pnpm dev:api` / `pnpm dev:game-server`: one at a time.
  A game server needs the api running; it fetches its world from it.
- `pnpm check [worlds/<slug>]`: validate one world or all, no browser. The
  argument is relative to your shell; with none, it finds `worlds/` itself.
- `pnpm test`: vitest across all four packages.
  `--project shared|api|game-server|client` to slice.
- `pnpm typecheck`: every package, including `@3d/shared`'s isomorphism check.
- `pnpm lint` / `pnpm format`: ESLint (including the boundaries) / Prettier.
- `pnpm build`: typecheck, lint, and the client into `packages/client/dist/`.
- `pnpm shots <poses.json> [--compare DIR]`: headless screenshots and pixel
  diffs. Needs `pnpm dev:api` beside it, like `pnpm preview`.
- `pnpm catalog [<game>/<weapon>] [attachment...]`: load `worlds/catalog/` through
  `WeaponRegistry` and report it — every weapon and the `catalogHash`, or one
  weapon and what each attachment does to its numbers. It also resolves every cast
  a gametype can produce and **exits non-zero** on one naming a file that is not
  built: no world names a pair of view hands any more, so this is where that check
  lives. No browser, no server.
- `pnpm world <slug>`: load one world the way a game server does — over HTTP,
  through the api — and report what came back, collision included. Needs
  `pnpm dev:api`. For a world on disk, `pnpm check` is the faster loop.
- `pnpm db:generate`: regenerate the server's SQLite migrations after editing
  `packages/api/src/db/schema.ts`.
- `python3 -m scripts.cod doctor` / `maps [--game g]`: where each game's files were
  found (`--game-dir`, `$COD_<GAME>_DIR`, the gitignored `cod.config.json`, then
  Steam's install and downloaded depots, `--use` choosing between them), each
  folder's role (MW2, MW3, BO1 and BO2 read zones only from 32-bit builds), and what
  an export still lacks; and every map zone an install holds. What an install holds is `scripts/cod/games.json`; `maps.json` is only the
  record of the repo's own worlds.
- `pnpm export:cod <map> | --game mw2 | --all`: import CoD maps (see `docs/cod/`).
  `--gameplay-only` rewrites a world's spawns and triggers from its committed
  `export_metadata.json`, needing no game files at all.
- `python3 -m scripts.cod catalog`: build `worlds/catalog/`, the shared asset
  catalogue both ends fetch from `/api/catalog`. This one **does** need game
  files: it is built from a game's own companion zone and from nothing else,
  because a world names its weapon rather than packing it. Kept out of git.
  **Sound is the one documented exception**, twice over: its bank is a different
  companion zone (`localized_common_mp.ff` — `common_mp.ff` holds no sound at
  all), and sixteen player footsteps and landings exist only in map zones, so the
  build takes the union with one and proves the overlap identical —
  [docs/cod/pipeline.md](docs/cod/pipeline.md#the-sound-bank).
- `python3 -m scripts.cod actors`: build the creatures an actor kind is drawn as
  (`worlds/catalog/actors/` and their clip sets under `animations/`), from Black
  Ops' zombies zones. Needs game files, like `catalog`; `--no-dump` rebuilds from
  dumps already made — [docs/cod/pipeline.md](docs/cod/pipeline.md#actors).
- `python3 -m scripts.cod harvest [--kinds ...] [--prune] [--dry-run]`: move what
  belongs to no one map out of `worlds/*/assets/` and into `worlds/catalog/` — the
  cast by default, props when asked for by name. Needs no game files: the GLBs are
  already exported. `--prune` then deletes the per-world copies nothing names any
  more, and refuses to remove anything the catalogue does not hold byte-for-byte.
- `python3 -m scripts.cod hitboxes [--dry-run]`: derive a per-bone hitbox for every
  body in `worlds/catalog/characters/`, from the GLBs' own skin weights, into
  `<id>.hitboxes.json` beside each. Needs no game files. Names any box larger than
  its location plausibly should be — three ghillie bodies skin a hood to `j_head`
  and derive a 0.49 m head.
- `python3 -m scripts.cod migrate [--dry-run] [--retire-cast]`: bring the worlds already on disk
  up to date with a DSL change, from each world's committed
  `export_metadata.json`. Needs no game files, and is idempotent. This is the one
  build step allowed to read that file; the engine never may.
- `pnpm test:py` / `pnpm lint:py`: pytest and ruff for `scripts/cod/`. Python
  tooling stays at the repo root and is run from there — never through
  `pnpm -r`.

**No world content is in the client build.** `pnpm build` writes the bundle and
nothing else: not `assets/` (that was 3.8 GB), and not the manifest or the
sources either. `@3d/api` serves all three, from whatever `WORLDS_ROOT` points
at, in dev and in production alike — Vite proxies to it rather than keeping its
own copy of those routes, so there is one implementation instead of two that have
to agree. The consequences to know about: `pnpm dev` starts two processes, and
`pnpm preview` and `pnpm shots` need `pnpm dev:api` beside them or they have no
worlds at all.
