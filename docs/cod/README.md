# Importing Call of Duty maps

`scripts/cod/` turns a map from Modern Warfare 2 (IW4), Modern Warfare 3 (IW5)
or Black Ops (T5) into a world under `worlds/<map>-<game>/`: the rendered
shell, its decals, every prop (animated ones with the map's own clips, and
flag-shader cloth and grass), the map's own collision, its lighting, grading
and spawn, its minimap, the first-person viewmodel (the map's view hands, and
the name of the catalogued weapon they hold), the third-person characters other players are
drawn as (the map's own bodies and heads, holding that weapon, with the game's
player clips), and everything else the zone says about gameplay
(`export_metadata.json`). 87 maps are imported today, 2 of them Black Ops zombies
maps and 15 Black Ops II; `scripts/cod/maps.json` lists them. Ghosts (IW6) is being added: so far an export writes its shell,
decals, props, collision, lighting, minimap, viewmodel, characters and
`export_metadata.json`, and its weapons and attachments are in the shared
catalogue; it does not yet build the effects
([games.md](games.md#ghosts-iw6)). Black Ops II (T6) is being added: an export
writes its shell, decals, props, collision, climbing, minimap and
`export_metadata.json`, textured from its `.ipak` packs, but no lighting,
animation, sound, effects or catalogue yet
([games.md](games.md#black-ops-ii-t6--walkable-textured-and-lit)).

| Read                           | For                                                                        |
| ------------------------------ | -------------------------------------------------------------------------- |
| This file                      | Setting up, configuring your installs, and running an export               |
| [pipeline.md](pipeline.md)     | What each stage does, what comes out, and `_overrides.json`                |
| [reference.md](reference.md)   | The data: coordinates, vertices, materials, lightmaps, collision, entities |
| [games.md](games.md)           | What differs between IW4, IW5, T5 and IW6                                  |
| [effects.md](effects.md)       | Particle effects: how they export, and how their meaning was established   |
| [audio.md](audio.md)           | Sound: the alias table, the clips behind it, and what each field means     |
| [navigation.md](navigation.md) | Path nodes: what each game's AI navigation data becomes in a `nav.bin`     |
| [pitfalls.md](pitfalls.md)     | Every trap that produced a plausible wrong result, and its guard           |

Most failures in this pipeline do not error. They import a map that renders and
is wrong: inside-out faces, props at the origin, a lightmap in the wrong channel.
When something looks off, read [pitfalls.md](pitfalls.md) before theorising.

## Export maps from your own games

You need the games, on Steam, on Linux, Windows or macOS. Nothing here is a game
file: the importer reads your install and writes worlds you keep to yourself
([legality](#legality)).

| Key      | Game                    | Steam folder                      | Notes                                                             |
| -------- | ----------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `mw2`    | Modern Warfare 2 (2009) | `Call of Duty Modern Warfare 2`   | needs a 32-bit build ([below](#32-bit-builds)); Steam's is 64-bit |
| `mw3`    | Modern Warfare 3 (2011) | `Call of Duty Modern Warfare 3`   | needs a 32-bit build; Steam's is 64-bit                           |
| `bo1`    | Black Ops               | `Call of Duty Black Ops`          | needs a 32-bit build; Steam's still is one                        |
| `bo2`    | Black Ops II            | `Call of Duty Black Ops II`       | needs a 32-bit build; Steam's still is one                        |
| `ghosts` | Ghosts                  | `Call of Duty Ghosts`             | needs extra files ([below](#ghosts-and-advanced-warfare))         |
| `aw`     | Advanced Warfare        | `Call of Duty Advanced Warfare`   | some maps need an extra file                                      |
| `cw`     | Black Ops Cold War      | `Call of Duty Black Ops Cold War` | being added; needs an Oodle decoder                               |

### Set up Python

Python 3.12 or newer (tested on 3.12, the version `.python-version` names), and **ffmpeg** with the libopus
encoder on your `PATH`: every sound is transcoded to Opus. From the repository
root, on Linux or macOS:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r scripts/cod/requirements-dev.txt
```

On Windows (PowerShell or cmd):

```bat
py -3 -m venv .venv
.venv\Scripts\python -m pip install -r scripts\cod\requirements-dev.txt
```

`requirements.txt` is what an export needs (Pillow, and capstone for Ghosts);
`-dev` adds pytest and ruff. The examples below say `python3`; use the venv's
interpreter (`.venv/bin/python`, `.venv\Scripts\python`) or activate it first.
The struct layouts every walk needs ship in [`scripts/cod/data/`](../../scripts/cod/data/README.md);
there is nothing to build.

### Say where your games are

Usually you do not: the importer finds each game in your Steam libraries
(`libraryfolders.vdf` under `~/.local/share/Steam`, `~/.steam/steam`, the
Flatpak's, `Program Files (x86)\Steam` or the registry's `SteamPath`, and
`~/Library/Application Support/Steam`), both its install under
`steamapps/common/<folder>` and the depots `download_depot` wrote under
`steamapps/content/app_<app>/depot_<depot>` (on Linux,
`ubuntu12_32/steamapps/content` under the Steam folder). Run `doctor` to see what
it found.

Where that is not enough, a game's folders come from the first of these that
names any, and that source is the whole answer:

1. `--game-dir <game>=<dir>` on `export`, `catalog`, `actors`, `maps` or
   `doctor` (repeatable);
2. `$COD_<GAME>_DIR` (`COD_BO1_DIR`), a list separated by `:` (`;` on Windows);
3. `cod.config.json` at the repository root (gitignored), or the file
   `$COD_CONFIG` names;
4. Steam, as above.

Copy [`cod.config.example.json`](../../cod.config.example.json), whose
`_comment` documents every key:

```json
{
  "games": {
    "bo1": "D:/Games/Black Ops (32-bit copy)",
    "mw3": { "use": "depots" },
    "mw2": ["/depots/depot_10182", "/depots/depot_10183"]
  },
  "iw6_durango": "/path/to/the/server/build",
  "iw6_durango_types": "/path/to/durango_types.json",
  "s1_layout_x360": "/path/to/layout.json"
}
```

A game is a folder, a list of folders, or an object with any of `dirs` (the
same), `exe` and `use`. Several folders are one install: every path the game is
read from (`zone/english`, `main`, ...) is looked up in each, in order, which is
how MW2 and MW3 work from their depots. What an install holds, relative to its
root, is [`scripts/cod/games.json`](../../scripts/cod/games.json). `exe` is read,
never run, for the code tables of wavelet-compressed images; without one those
images are skipped and counted. `$STEAM_CONTENT` and `$STEAM_COMMON` are no
longer read.

### Check, list, export

```sh
python3 -m scripts.cod doctor              # where each game was found, and what is missing
python3 -m scripts.cod maps --game mw3     # the map zones your install holds; * has a world already
python3 -m scripts.cod export mp_dome      # one map -> worlds/dome-mw3
python3 -m scripts.cod export mp_seatown --game mw3 --world seatown-mine
python3 -m scripts.cod catalog --dump mw3  # the weapons, view hands, bodies and sounds the worlds name
```

`doctor` prints one line per check, each problem with its fix, and exits non-zero
unless every game it found can be exported. `export` takes any map zone your
install holds: a map
[`maps.json`](../../scripts/cod/maps.json) lists (the repo's own worlds) keeps its
world name there, and any other goes to `<name>-<game>` (`mp_crash_snow` in MW2
is `crash-snow-mw2`) unless `--world` names one. `--game` picks between games
that ship one zone name (`mp_village` is MW3's and BO2's), and alone exports every
`maps.json` map of that game. A world names its weapons and cast rather than
carrying them, so build the catalogue for each game you export from;
`python3 -m scripts.cod actors` builds the zombies.

Then `pnpm dev:mp` (the client, the api and a game server), open the printed
URL and pick the world. `pnpm check worlds/<slug>` validates one without a
browser.

### 32-bit builds

MW2, MW3, Black Ops and Black Ops II are walked with 32-bit struct layouts, which
cannot read a 64-bit build's zones: those store 8-byte pointers. Steam now ships
MW2 and MW3 as 64-bit builds, and could do the same to the other two. You have
two ways to give the importer a 32-bit build:

- **A full 32-bit install**, anywhere: name its folder as the game's
  (`"bo1": "D:/Games/Black Ops"`). Steam's own Black Ops and Black Ops II are
  still such installs, so they need nothing.
- **The Steam depots of the 32-bit build**, downloaded from the Steam console
  (`steam://open/console`). Steam writes each to
  `steamapps/content/app_<app>/depot_<depot>`, where the importer finds MW2's and
  MW3's on its own. Black Ops' and Black Ops II's read their folders as one tree
  (the `.ipak` packs and sounds beside the zones), so copy their depots into one
  folder and name that.

Every folder is classified: a **64-bit build** holds `steam_api64.dll` or a
PE32+ exe, a **32-bit build** a 32-bit exe or `steam_api.dll`, and a depot with
neither is **unknown**. Zones, archives and companions are read only from
folders that are not 64-bit builds, and a 64-bit install still lends its exe,
whose tables are the same. `doctor` lists each folder with where it came from and
what is read from it, and `doctor` and `export` stop with the commands below when
only a 64-bit build holds the zones.

Which kind detection picks is `use`: `auto` (the default) takes a 32-bit Steam
install if there is one, else the depots, keeping a 64-bit install for its exe;
`install` takes only the install; `depots` only the depots. Set it as
`"use": "depots"` in the game's config entry, or with `--use <game>=depots`.

The depots and the manifests the pipeline was built against (games.json's
`depots`):

| Game  | Steam console                                      | Holds                                                                  |
| ----- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `mw2` | `download_depot 10180 10182 4063260329988186194`   | main/ (the .iwd archives)                                              |
| `mw2` | `download_depot 10180 10183 8707803059832053468`   | zone/english and main/                                                 |
| `mw3` | `download_depot 42680 42683 6381783964590594065`   | zone/english (the base multiplayer and Spec Ops maps)                  |
| `mw3` | `download_depot 42680 42682 2661317971072643596`   | main/ and zone/dlc (Terminal, Aground, Courtyard)                      |
| `mw3` | `download_depot 42690 42698 5997898371746217629`   | zone/dlc (the five Collection maps)                                    |
| `mw3` | `download_depot 42690 42691 4104640605720756125`   | the 32-bit iw5mp.exe (optional: read for wavelet images)               |
| `bo1` | `download_depot 42700 42702 6257032900290287777`   | zone/Common (every map) and main/                                      |
| `bo1` | `download_depot 42700 42703 8741537774138455205`   | zone/English (the zombies maps' en_ zones) and main/                   |
| `bo1` | `download_depot 42710 42704 2396700113547373447`   | BlackOpsMP.exe (optional: read for wavelet images)                     |
| `bo2` | `download_depot 202970 202972 44054127954755624`   | base.ipak and sound/                                                   |
| `bo2` | `download_depot 202970 202973 131606837976547528`  | mp_carrier, mp_dockside, mp_drone, mp_overflow, mp_socotra and so.ipak |
| `bo2` | `download_depot 202970 202974 8534031140633404768` | patch.ipak and sound/ (the campaign's depot)                           |
| `bo2` | `download_depot 202970 202975 855173471322016522`  | en_base.ipak                                                           |
| `bo2` | `download_depot 202970 212931 1794283193511346342` | the en_ zones of the five maps in 202973                               |
| `bo2` | `download_depot 202990 202992 6516382015411692772` | the other multiplayer maps, common_mp.ff and mp.ipak                   |
| `bo2` | `download_depot 202990 203001 5470996728109450714` | the multiplayer en_ zones                                              |
| `bo2` | `download_depot 202990 219091 3185257489268655163` | mp_nuketown_2020 and dlc0.ipak                                         |
| `bo2` | `download_depot 212910 212912 7173492351802578203` | zm_transit, its companions and zm.ipak                                 |
| `bo2` | `download_depot 212910 212921 8942509767028602311` | the zombies en_ zones                                                  |

For MW3 the manifest matters: only some revisions are 32-bit, and only some carry
the DLC maps; not `6067691797475126381` for 42682 (the ID one downgrade guide
gives), which predates Terminal and has no `zone\`. MW2's 32-bit multiplayer exe
(depot 10184) is not listed because its 32-bit manifest is not known; the 64-bit
`iw4mp.exe` in the Steam install serves. The Black Ops and Black Ops II rows are
the 32-bit builds installed today, recorded in case Steam replaces them; their
lists are every depot of the multiplayer and zombies apps that holds zones,
packs or sounds, which is more than any one map needs.

### Ghosts and Advanced Warfare

Two games need files the repository does not ship, because they are derived from
development builds rather than from the retail game:

- **Ghosts** reads some asset types through the loaders of the game's Xbox One
  server build (`iw6mp64_dh_server_durango.exe` and `.map`), interpreted with
  capstone and never run, and the type table generated from that build's `.pdb`
  (`durango_types.json`, by
  [`reverse/iw6-zone/pdbtypes.py`](../../reverse/iw6-zone/README.md#reproducing)).
  Name the folder as `iw6_durango` and the table as `iw6_durango_types`. A Ghosts
  export stops at once, saying which is missing.
- **Advanced Warfare** maps whose zones hold sound submixes, reverb presets or
  impact effects need a struct layout derived from the X360 build
  (`s1_layout_x360`, from
  [`reverse/s1-zone`](../../reverse/s1-zone/README.md#struct-layouts)); the PC
  layout leaves those structs out. Most maps need none. One that does stops at
  the first such asset, naming the file and the key.

Black Ops Cold War reads its zones with [ooz](https://github.com/powzix/ooz), an
Oodle decoder, built by `reverse/tools/ooz/build.sh`; name another build as `ooz`.

## Running an export

From the repository root:

```sh
python3 -m scripts.cod export mp_hardhat     # one map -> worlds/hardhat-mw3
python3 -m scripts.cod export --game mw2     # every MW2 map maps.json lists
python3 -m scripts.cod export --game bo2     # every Black Ops II map (2-5 minutes each)
python3 -m scripts.cod export --all          # every map maps.json lists
python3 -m scripts.cod export village-bo2    # a world's name: mp_village is MW3's and BO2's
```

A map in no install's configured folders still takes explicit paths, which
bypass the configuration entirely:

```sh
python3 -m scripts.cod export mp_seatown --zone <zones dir> --search "<main>;<main>" --out worlds/seatown-mw3
```

An export takes about a minute and prints each stage's counts. Read the log: the
pipeline's own checks (winding, technique index, brush-model placement,
unresolved textures) report there. Then validate with `pnpm check worlds/<slug>`.

`--climbing-only` rewrites just `mantle.world` and `ladder.world` from a fresh
clipmap dump, `--volumes-only` just `volumes.world`, and `--loadscreen-only` just
`assets/loadscreen.jpg` (and `export_metadata.json`'s `images` to match). `--metadata-only` (with a map, `--game` or `--all`) re-extracts just
`assets/minimap.png`, `export_metadata.json` and `minimap.world` from two small dumps, in seconds
per map, and leaves every other file alone. `--viewmodel-only` and `--characters-only` do the same for
`assets/viewmodel/` and `assets/characters/` (both stages run either way — a
character holds the weapon the viewmodel stage picks). Neither writes a world
file: who a player is comes out of the shared catalogue now, so both stages stage
their files in `assets/` and `harvest` puts them there (see
[pipeline.md](pipeline.md#the-shared-asset-catalogue) and
[scripting.md](../engine/scripting.md)).

A re-export overwrites the world's generated `world.world`, `props.world`,
`minimap.world`, `volumes.world`, `mantle.world`, `ladder.world`, `fx.world`,
`export_metadata.json` and `assets/`. Hand tuning belongs in `_overrides.json`, which is re-applied every
time (see [pipeline.md](pipeline.md#overrides)). Scratch dumps go to
`.cache/cod/<slug>/` and are deleted afterwards unless you pass `--keep-work`.

### Looking inside a zone

Nothing in the pipeline needs this. `python3 -m scripts.cod.zonecode <file.ff>
--listing -` prints every asset an IW4, IW5 or T5 zone holds. An export's
`--keep-work` keeps every dump it made under `.cache/cod/<slug>/`, and
`python3 -m scripts.cod decode-image <out dir> <file.iwi|.dds ...>` turns its
images into PNG.

## Tests

`pnpm test:py` runs the pipeline's unit tests and `pnpm lint:py` runs ruff, both
through the `.venv` [set up above](#set-up-python) (`scripts/venv-python.mjs`
finds its interpreter on every platform). The few tests that read an installed
game find it as an export does, and skip when it is not there.

A pipeline refactor should reproduce a previous export: export the same map
before and after into a scratch worlds root and compare them with `equiv`
([pipeline.md](pipeline.md#proving-an-export-equivalent)).

## Legality

These are the publishers' assets. Extracting from games you own for private use
is ordinary modding practice; redistributing them is not. That is why every
imported world's `assets/` is gitignored, and why a public build or dev server
should not serve them.
