# 3D Designer

> [!WARNING]
> This project was written primarily with AI. It is very experimental and will
> have bugs. Modern Warfare 3 is the best-supported game so far; the others may
> be primitive or buggy. Black Ops II's zombies mode is also functional, through
> private matches.

A browser 3D engine for walkable worlds, written as plain text. A world is a
`.world` file: glTF models, a collision mesh, lights, spawns and triggers. Most
of one is generated — Call of Duty maps imported by a Python pipeline — and what
a human writes over it is the gameplay. The app parses, validates and renders it
as a first-person scene, and multiplayer is playable on top of it.

## Multiplayer

Multiplayer works for simple PvP and for primitive zombies. The server is
authoritative: it compensates for lag and validates every interaction a client
claims. There is one central server, `@3d/api`, which owns the worlds, the
accounts and the matchmaking, and any number of game servers, which host the
matches. Game servers hold no state of their own, so they can be deployed around
the world, close to the players they host, to cut latency.

## Previews

![Dome, from Modern Warfare 3](docs/previews/mw3-dome.png)

_Dome (Modern Warfare 3): the most feature-complete multiplayer map._

![Kino der Toten, Black Ops zombies](docs/previews/bo1-zombies.png)

_Black Ops zombies: the game mode partly works and needs tweaking._

**[More previews →](docs/previews/README.md)**

## Quick start

```
pnpm install
pnpm dev:mp
```

Open the printed URL and pick a world. Click to play; walk with WASD, look with
the mouse, `Space` to jump, `Shift` to run, `Tab` for an orbiting dollhouse view.
`Esc` releases the pointer and opens the pause menu (quality, controls, back to
the menu).

That starts three processes: the client's dev server; `@3d/api`, which serves
the worlds and their assets and does the matchmaking; and a `@3d/game-server`,
which hosts the games it is given. The client proxies to the api, and a match
needs the game server. `pnpm dev` starts only the first two, which is enough to
walk a world alone. See **[docs/server/README.md](docs/server/README.md)** for
the topology, and `.env.example` for every setting.

To serve the dev server beyond localhost, put `DEV_HOST=0.0.0.0` and
`DEV_ALLOWED_HOSTS=your.host` in `.env.local` (copy `.env.example`). It serves
the imported game assets to anyone who can reach it.

## Editing a world

See **[worlds/AUTHORING.md](worlds/AUTHORING.md)** for the format. A map's
geometry, props and lighting are written by the importer below; what you edit by
hand is the gameplay over them — spawns, triggers and behaviours. Validate
without a browser:

```
pnpm check worlds/<slug>
```

With `pnpm dev:mp` (or `pnpm dev`) running, saving a `.world` file updates the
browser immediately and keeps your camera position.

## Importing Call of Duty maps

`scripts/cod/` converts maps from the Call of Duty games you own on Steam (MW2,
MW3, Black Ops, Black Ops II, Ghosts and Advanced Warfare) into worlds. See
**[docs/cod/](docs/cod/README.md#export-maps-from-your-own-games)** for setup,
then:

```
python3 -m scripts.cod doctor            # where your games are, and what is missing
python3 -m scripts.cod maps --game mw3   # the maps your install holds
pnpm export:cod mp_dome                  # one map -> worlds/dome-mw3
```

## Development

```
pnpm test        # vitest
pnpm typecheck   # every package, plus @3d/shared's isomorphism check
pnpm lint        # ESLint, including the layer boundaries
pnpm shots <poses.json> --compare DIR   # screenshot regressions
pnpm test:py     # pytest for the importer
pnpm build       # production build to dist/
```

[CLAUDE.md](CLAUDE.md) is the map of the engine's structure;
[docs/engine/](docs/engine/) holds the rationale for rendering, collision, the
UI and the debug tools.
