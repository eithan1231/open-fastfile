# Sound

How a Call of Duty map's ambience — wind on a fence, a pumpjack, a tarp
flapping — gets from the game into a world, and how each field's meaning was
established. The engine side, and why sound is shaped the way it is, is in
[../engine/audio.md](../engine/audio.md).

**Status.** MW3 (IW5) exports both halves: `dome-mw3` carries 77 placements of
23 aliases and the 27 clips behind them, and the shared catalogue carries 1,330
aliases and 730 clips ([below](#the-shared-catalogue)). Black Ops (T5)
exports both too ([below](#black-ops-t5)), and so does Black Ops II (T6): all 16
worlds carry their ambience, and its catalogue bank 505 aliases
([below](#black-ops-ii-t6)). MW2 (IW4) and Ghosts (IW6) maps have
their placements in `export_metadata.json` but no aliases, for two different reasons ([below](#what-is-still-missing)).

## Exporting a map's sound

### What it needs

**A `sound` and a `loadedsound` dump**: one lossless JSON per
`snd_alias_list_t` at `sound_aliases/<name>.json`, in game units and with
nothing decoded ([the dump tree](pipeline.md#the-dump-tree)); and each PCM clip
the zone loads, as `sound/<its own name>` (a `.wav`). The IW5 backend writes
them (`scripts/cod/iw5/dumpers/sound.py`), from the zonecode walk: the PCM is
what the zone's `SetSoundData` action loads.

**The `.iwd` search path**, because 41% of the bank is not in any fastfile
([below](#two-places-a-clip-can-be)). It is the same search path the minimap and
the loading screen already come from, so `games.json` already names it.

**`ffmpeg` with `libopus` and the WebM muxer.** Without the dumps (MW2,
Ghosts), stage 13 says so and skips.

### What a full export does

Stage 13 of `python3 -m scripts.cod export <map>` (`export.py`
`export_sound`, `sound.py`, `worldfile.write_sound_world`):

1. **Dump.** `sound` and `loadedsound` from the map's fastfile, and `sound`
   alone from its companion zones. The aliases are cheap (dome's whole zone is
   213 of them, 1.5 s); a companion `loadedsound` dump is not, and the clips
   behind a companion alias are the catalogue's job rather than a map's.
2. **Placements.** The metadata stage has already parsed
   `maps/createfx/<map>_fx.gsc` into `export_metadata.json`. The
   `createOneshotEffect` entries there are effects; the `createLoopSound` ones
   are these, each with a `soundalias` and an engine-space `at`.
3. **Closure.** Starting from the placed aliases, follow every
   `secondaryAliasName` — a layer that genuinely plays, as an effect's
   `effectOnDeath` does. An alias named only as a layer and never exported plays
   as nothing, so one that could not be resolved is named in the log. dome's 23
   pull in none.
4. **Convert** to engine units: metres, seconds, and a flat clip list. Every
   field is [below](#the-shape-of-a-row).
5. **Clips.** Each alias entry names one recording, in one of
   [two places](#two-places-a-clip-can-be). Both are transcoded to **mono Opus
   in WebM at 48 kbit/s VBR**, keeping the game's own path minus its extension.
6. **Write** `assets/sounds/sounds.json` (the table; `_version` 1) and
   `assets/sounds/clips/**.webm`, then `sound.world`: one
   `sounds { source: … }` and one `sound` per placement. `world.world` gets
   `include "sound.world"`.

`--sounds-only` rewrites `sound.world` alone from the committed metadata and the
table already on disk, with no game files. It is byte-identical to what the full
export wrote.

### What comes out, for dome

```
sound.world                        77 placements of 23 aliases (committed)
assets/sounds/sounds.json          the table: 23 aliases, 27 clips (gitignored)
assets/sounds/clips/**.webm        27 clips: 28.7 MB of PCM in, 2.1 MB out (gitignored)
```

`pnpm check worlds/dome-mw3` reports `77 sound placement(s) of 23`: placements
and the distinct aliases they name.

## The shape of a row

An alias list is several **entries** — the recordings the game picks between —
and one row here carries one playback for all of them. Every numeric pair is
therefore the **envelope** over the entries, so a variant that was quieter or
lower still falls inside the range sampled from; the single-valued fields come
from the first entry, bar `loop`, which is true if any entry loops.

| Field     | From                              | Units                                                       |
| --------- | --------------------------------- | ----------------------------------------------------------- |
| `clips`   | one per entry                     | `{ file, weight }`; `file` is the game's path, no extension |
| `weight`  | `probability`                     | **unnormalised**, see below                                 |
| `volume`  | `volMin`/`volMax`                 | a multiplier, sampled per voice                             |
| `pitch`   | `pitchMin`/`pitchMax`             | a playback rate, sampled per voice                          |
| `range`   | `distMin`/`distMax`               | **metres** (`units.py`'s 39.37 to the metre)                |
| `loop`    | `flags & 1`                       | bool                                                        |
| `spatial` | derived from `distMax`, see below | bool                                                        |
| `delay`   | `startDelay`                      | **seconds** (the dump is milliseconds)                      |
| `channel` | `mixerGroup`, when it says one    | `weapons`, `ambience` or `mission`; absent otherwise        |
| `with`    | `secondaryAliasName`              | another alias in this table; absent when there is none      |
| `flags`   | `flags`                           | the raw word, undecoded past bit 0                          |

**`probability` is a weight and not a probability.** The MW3 bank carries 3.0
beside 0.2 beside 1.0, and 187 entries at 1.3. Normalising it here would throw
away the only thing it says; the picker normalises across an alias' own clips,
so a table that happens to sum to 1 and one that sums to 9 pick alike.

**Only bit 0 of `flags` is read.** No source names a bit of this word for any
IW game. Bit 0 is looping, by correlation over the whole bank: every
`ambient_*`, every `emt_*`, and no footstep, landing or weapon fire. The raw
word is carried through so that evidence for another bit costs a reader and not
a re-export.

### How far a sound carries

`spatial` is derived from `distMax` and not from a flag, because IW5 has no flag
for it and spells "never attenuate this" as an absurd distance instead. The
threshold is **25,000 inches (635 m)**, and the whole bank is the argument for
it. Every `distMax` across the 15,206 entries of `localized_common_mp.ff`:

| `distMax` (in) | In metres    | Entries | What is there                                   |
| -------------- | ------------ | ------- | ----------------------------------------------- |
| < 600          | < 15 m       | 1,381   | impacts, foley, small emitters                  |
| 600            | 15 m         | 3,983   | the single commonest value in the bank          |
| 601–999        | 15–25 m      | 582     |                                                 |
| 1,000–1,705    | 25–43 m      | 3,500   | other players' footsteps and landings           |
| 1,706–2,799    | 43–71 m      | 568     |                                                 |
| 2,800          | 71 m         | 2,751   | battle chatter, the second commonest value      |
| 2,801–15,999   | 71–406 m     | 1,304   | vehicles, distant explosions                    |
| 16,000–22,000  | 406–559 m    | 37      | `_fardist` weapon tails, artillery, helicopters |
| **25,000**     | **635 m**    | **404** | every `ambient_*` bed, AC-130 fire              |
| 35,000–250,000 | 889 m–6.4 km | 9       | the nuke, one Spec Ops claymore                 |
| **500,000**    | **12.7 km**  | **429** | `elm_*`: dogs, distant gunfire, sirens          |
| **2,500,000**  | **63.5 km**  | **258** | every `weap_*_plr` and `_aki`, and the whole UI |

The gap is structural rather than numeric. Below 25,000 the distribution is a
dense continuum over **70 distinct values**, topping out at 22,000 in; at and
above it there are **six**, all round — 25,000, 35,000, 50,000, 250,000, 500,000
and 2,500,000 — and they hold exactly the four categories that are not anywhere
in particular: the map's own bed, the player's own weapon, the interface, and
the `elm_*` elements a level plays from over the horizon. 14,106 entries fall
below the line and 1,100 at or above it.

Those become `THREE.Audio` with no panner. Anything below becomes
`THREE.PositionalAudio`, whose `maxDistance` is a **hard cap**: past it there is
no voice at all, rather than a very quiet one. A `_plr` rifle taken at face
value is a 63 km sphere, which sounds exactly right until two players stand
apart.

### Two places a clip can be

`soundFile` is a union and only one arm of it is in the fastfile. Across the
MW3 bank, 9,043 entries are loaded and 6,163 streamed:

- **`SAT_LOADED`** — PCM in the zone, which the `loadedsound` dump writes out as
  `sound/<the alias' own path>.wav`. Not uniformly 44.1 kHz mono: dome's 27
  clips are 22.05, 32, 44.1 and 48 kHz, and one of them is stereo, which is why
  the transcode says `-ac 1` rather than trusting the source.
- **`SAT_STREAMED`** — not in the zone at all. The alias carries a `dir` and a
  `name` which resolve into the game's `.iwd` archives at `sound/<dir>/<name>`,
  **case-insensitively**: `iw_11.iwd` spells the folder `sound/` and `iw_34.iwd`
  spells it `Sound/`. All 6,163 resolve that way, and none at all if the case is
  taken literally. They are overwhelmingly `.wav` too — only 197 are `.mp3`.
  `scripts/cod/iwd.py` is the one reader, shared with the minimap and the
  loading screen. Where two archives of one folder hold the same clip it takes
  the **lowest-named**, as the golden exports did, and not the game's own order
  (the highest-named: [pitfalls](pitfalls.md#extraction)). **Open, for the
  user:** two streamed clips differ between archives that way, both
  battlechatter in `localized_english_iw0*.iwd` (`af_1mc_obj_defend_01`,
  `fr_1mc_rmte_sentry_destroyed_01`), and neither is in any closure exported today.

### Two names that are not what they look like

Both fail as silence rather than as an error, so both have a test rather than a
paragraph (`tests/test_sound.py`):

- **A leading comma means "defined in another zone."** A map zone spells a clip
  it shares with the common bank `,footsteps/foot_dirt01.wav`, and an alias it
  layers in `,other_alias`. 400 of mp_dome's 665 entries carry one. It is
  linkage and not part of the name; left on, every lookup misses.
- **Names are case-inconsistent in the game's own data.** dome's own createfx
  script places `emt_wind_grass_Ext` against a zone that defines
  `emt_wind_grass_ext`, and the bank ships `Land_plr_carpet` beside
  `land_plr_ceramic`. Keys are lower-cased and matched without case. There are
  no collisions in the 7,387-alias bank — checked, and `load_dump` raises rather
  than silently shadowing one alias with another if a later game has one.

## The shared catalogue

What belongs to no one map — footsteps, landings, weapons, bullet impacts and
body foley — is built by `python3 -m scripts.cod catalog` into
`catalog/sounds/<game>/mp/`, the
same `sounds.json` + `clips/` shape a world has. The build, its numbers and the
weapon-file reading are in
[pipeline.md](pipeline.md#the-sound-bank); what matters here is where it comes
from, because sound is the one kind whose source is not the companion zone.

**A different zone, and three of them.** IW5's `common_mp.ff` holds not one
sound asset. The bank is `localized_common_mp.ff` beside it, 7,387 aliases; two
more zones are read for their PCM alone, because `misc/pu_weapon02.wav` (every
weapon's pickup) is in `common_mp.ff` and `null.wav` is in the localized code
zone.

**And one map zone, which is the documented exception to "a game's companion
zone and nothing else".** Sixteen aliases are absent from the bank and defined
by every map zone instead:

```
step_run_plr_dirt   step_run_plr_glass  step_run_plr_ladder  step_run_plr_metal
step_run_plr_sand   step_run_plr_snow   step_run_plr_water
step_sprint_plr_metal  step_sprint_plr_snow  step_sprint_plr_water
land_metal  land_sand  land_snow  land_plr_metal  land_plr_sand  land_plr_snow
```

Those are the player's own boots and what they land on, so a catalogue built the
usual way has a hole exactly where the first footstep work looks. The build takes
the union with the first map zone that carries them and **asserts the overlap is
identical** rather than trusting it (`sound.merge_dumps`).

Measured, because both halves of that were worth checking:

- **The overlap is empty.** Across mp_dome, mp_paris, mp_seatown and mp_village,
  not one of a map zone's ~200 aliases is also defined in the bank — a map zone
  _references_ what the bank defines (the leading comma) rather than redefining
  it. So the assertion holds vacuously today, and is a guard for the day a zone
  stops being disjoint rather than a check that catches anything now.
- **The sixteen are byte-identical across every map zone tried** (aground, dome,
  paris, seatown, village), which is the claim that actually carries the union.
  Ten aliases _do_ differ between map zones — eight `emt_*` and two
  `fx_electransformer_spark_*`, all of them a map's own ambience — and none is in
  a family the catalogue takes.

**`null.wav` is silence, and it is exported rather than dropped.** Half a second
at −91 dB, named by 1,532 aliases — every `step_scrape_*`, every `*_flesh`,
`weap_putaway` — which is how IW5 spells "this variant plays nothing". Four
`gear_rattle_*_breath` rows mix it _with_ three real recordings, so it is a
one-in-four chance of no breath; dropped as a missing clip that chance would
become a certainty of one.

### The surfaces the step and landing families cover

The whole list, read off the built table rather than guessed, because mapping
CoD's `surfaceFlags` onto it is the next piece of work:

```
asphalt  asphault  bark  brick  carpet  ceramic  cloth  concrete  cushion
default  dirt  flesh  foliage  fruit  glass  grass  gravel  ice  ladder  metal
mud  paintedmetal  paper  plaster  plastic  riotshield  rock  rubber  sand
slush  snow  water  wood
```

Thirty-three for `step_*` and thirty-four for `land*`, and the two lists are not
the same one: `ladder` is a step surface and not a landing, `damage` and
`dirt_big` are landings and not steps. `asphault` is the game's own misspelling
sitting beside `asphalt`, and both carry real recordings.

**Five gaits, and `crouch` is not one of them**: `walk`, `run`, `sprint`,
`prone`, `scrape`. Every gait covers all 33 surfaces bar `ladder`, which only
`run` has; `scrape` is thinner still (29–30) and is `null.wav` on almost every
surface anyway. Each gait exists twice, `step_<gait>_<surface>` for everybody
else and `step_<gait>_plr_<surface>` for the listener's own boots, and `land*`
the same.

## Black Ops (T5)

Everything above holds for Black Ops, with the differences here. The data is
mp_nuked's zone and `common_mp.ff` together: 10,479 alias entries.

**One asset, both halves.** A T5 zone's sound is a single `soundbank`
(`mpl_nuked.all`, `mpl_common.all`) holding the alias lists and the audio of
every loaded one. There are no `.sab` files on PC; those are Black Ops 2.
The backend's `sound` writes it in IW5's layout, both halves from the walk
(`scripts/cod/t5/dumpers/sound.py`), and its `loadedsound` writes nothing, not
even a listing. The catalogue's bank is
`common_mp.ff` itself: T5 has no localized bank zone. A zombie's sounds and the
round's come from zombie_theater's zones instead, recordings and all, under the
names Black Ops II kept ([pipeline](pipeline.md#black-ops-iis-bank)).

**Almost none of it is PCM.** Of mp_nuked's 568 loaded sounds, 552 are **xWMA**
(format 7) and 16 **Microsoft ADPCM** (format 6):

- xWMA's `dpds` chunk (the bytes decoded by the end of each packet) is
  `snd_asset::seek_table`: `[24576]` for one 4,096-byte packet of 6,144 stereo
  16-bit frames. The byte rate is not stored; it is the packet size over eight
  2,048-sample WMA frames, which gives xWMA's own 6,000 (mono 44.1 kHz, 2,230-byte
  packets) and 12,000 (stereo 48 kHz, 4,096-byte packets).
- The ADPCM is 512 frames a block: 19,456 frames is 38 blocks of 262 bytes,
  exactly the data size.

Both are written as RIFF files at the loaded sound's own `.wav` name, and all
568 decode to the frame count their header gives. A streamed sound is one path
(`sound\mpl\ctf\return_flag.wav`) rather than IW's dir and name; with the
backslashes turned round it is in the `.iwd` archives exactly as IW's are.

**Fixed point, and the scale of each is the grid it was authored on.** Every
common value lands on a round number under one scale and no other:

| Field          | Scale        | Evidence                                                              |
| -------------- | ------------ | --------------------------------------------------------------------- |
| `volMin/Max`   | `v / 65535`  | 46,395 is −3 dB, 41,349 −4, 36,853 −5, 32,845 −6, 58,408 −1, 655 −40  |
| `pitchMin/Max` | `v / 32767`  | 27,553 is 2^(−3/12), 38,966 2^(3/12), 43,738 2^(5/12); 34,396 is 1.05 |
| `probability`  | `p / 255`    | 255, 127, 102 and 51: 1, 0.5, 0.4, 0.2, and nothing else              |
| `distMin/Max`  | inches       | 600, 1,000, 2,100; as IW5                                             |
| `startDelay`   | milliseconds | 100, 200, 250; as IW5                                                 |

**`spatial` is a flag.** Bit 1 of `flags` is set on every `_npc` alias and on
5% of `_plr` ones, on 98% of entries with a range, and on 5 of the 2,974 whose
`distMax` is **0** — which is how T5 spells "not in the world", where IW5 spells
it as an absurd distance. Bit 0 is looping, as on IW5: 74% of loop-named aliases
and no footstep or weapon fire. T6's `SndAliasFlags` does not fit this word (its
bit 7 would be set on every alias), so nothing else is read from it; on T6 itself
it does fit ([below](#black-ops-ii-t6)).

**The engine's names.** A footstep is `fly_step_<gait>_<plr|npc>_<surface>`, a
landing `fly_land_*`, an impact `prj_bullet_impact_<size>_<surface>` and the hit
marker `mpl_hit_alert`. `sound.T5_ENGINE_NAMES` adds each under the name the
engine asks for (`step_run_plr_concrete`, `bullet_large_concrete`,
`mp_hit_alert`) beside the game's own. The step families have 18 surfaces to
IW5's 33.

**A map's ambience is entities, not createfx.** Black Ops places it as
`script_struct`s with a `script_sound`, run by the client's `_audio.csc` by
`script_label`:

- `looper`: a loop at a point, which is what `createLoopSound` is. Exported.
- `line_emitter`: a loop along a line. Exported at its first point.
- `random`: a one-shot every `script_wait_min` to `script_wait_max` seconds —
  birds, gusts, shore laps, and the commonest label on most maps. A `sound`
  node cannot say "every few seconds" yet, so these stay in the entities.

The ambient rooms (`declareAmbientRoom`, a room tone and a reverb switched by
trigger volumes) and `snd_play_auto_fx` (a loop on every placement of one
effect) are in the client scripts and are not read.

## Black Ops II (T6)

What differs from Black Ops, with how each was found in
[reverse/t6-sound](../../reverse/t6-sound/README.md).

**The zone holds the aliases and none of the audio.** A zone's `soundbank`
(`mpl_la.all`, `mpl_common.all`, `zmb_classic_transit.all`) is T5's alias lists;
every recording is an entry of a bank file in `<game>/sound/` — `.sabl` for the
loaded half, `.sabs` for the streamed — keyed by `assetId`, which is `snd_hash`
of the entry's `assetFileName`. A map's aliases reach far outside its own two
files: mp_la's loaded entries are 10,914 of 10,950 in `cmn_root.all.sabl`. So
`t6/sab.py` indexes all 137 files, and the `sound` dump names each entry's bank
file and offset rather than writing any audio. Stage 13 reads the few dozen a
world ships out of the bank when it converts them (`sound.BANKED`).

**On PC it is PCM and FLAC, at 48 kHz.** Every `.sabl` entry is 16-bit PCM and
every `.sabs` entry FLAC — no xWMA, ADPCM or XMA. PCM is given a RIFF header;
FLAC is passed as it is. Both are refused unless their bytes hash to the MD5 the
bank stores for them, and a PCM size or a FLAC STREAMINFO that disagrees with the
entry's rate, channels or frame count is refused too.

**A recording is named by its source path, build code kept**: `raw\sound\amb\x.SL55.pc.snd`
is `amb/x.SL55`. One source can be built twice (`LN55` and `LN65`), and dropping
the code made ten of mp_la's paths name two different recordings.

**`SndAliasFlags` is OAT's layout**, read as two words, and where the banks can
check it they agree on every entry: bit 0 of `flags0` is looping (the bank entry's
own looping byte), bits 15-16 the load type (1 is in a `.sabl`, 2 and 3 in a
`.sabs`), bit 1 is 3D as on T5, and bits 17-21 the volume group, of which
`grp_weapon` (15) and `grp_ambience` (21) become the `weapons` and `ambience`
channels. Volumes, pitches and probabilities are T5's fixed point.

**The ambience is Black Ops' structs**, unchanged: 780 placements of 268 aliases
across the 16 worlds (TranZit 114 of 29, meltdown 98 of 33, carrier and village 17).
TranZit's aliases are not in its map zone but in `so_zclassic_zm_transit.ff`, a
companion maps.json already names. 11 placed aliases on eight MP maps are defined
in no zone (`amb_radio_2`, `amb_eye_scanner` …), and three defined ones name no
recording (`amb_jet_idle` on carrier, `amb_ac` and `amb_space_heaters` on raid):
silent in the game too.

**The catalogue** is `catalog/sounds/t6/mp/`: the footsteps and landings (from a
map zone, as on MW3), the hit marker, and a zombie's sounds and the round's, taken
from TranZit's zones because no companion defines them
([pipeline](pipeline.md#black-ops-iis-bank)). All 16 worlds declare `game: t6`, so
each loads it beside its own ambience: footsteps and landings, and TranZit's
zombie (`zombie_transit`) heard from it wherever it is spawned.

**Everything is quiet, and that is the open question.** BO2's volumes are whole
decibels on the same scale as T5's, but far lower: a map's ambience sits at −29 to
−50 dB (mp_la's median −38) where BO1's sits at −4 to −10, and a footstep at −37.
The game mixes into a master bus that compresses hard (`SndDriverGlobals`: a
pre-gain of 3.43, a threshold of −37.5 dB at 22:1, a make-up of 0.263) and the
engine does not, so the aliases play as their volumes say — some 30 dB below
BO1's. **It is left that way on purpose for now**: modelling the compressor, or
reading more of it out of the binary, is a decision deferred rather than a bug to
fix quietly with a gain. **Nobody has listened to any of it**, in the game or here.

## What is still missing

- **Other games.** Each is a different problem:
  - **IW4** is the small one. Its `snd_alias_t` is field-for-field IW5's,
    `mixerGroup` and all, and the IW4 backend already writes `loadedsound` —
    so it needs IW5's `sound` writer registered for IW4 and nothing else. The
    conventions above should carry over unchanged, but that is **unverified**: nothing has dumped
    an IW4 alias yet.
  - **T5** is exported: [below](#black-ops-t5). What it lacks is the
    `random` emitter and the ambient rooms, and so does **T6**, which also lacks
    a level to play at ([above](#black-ops-ii-t6)).
  - **IW6** is not dumped by `scripts/cod/iw6` at all. It would need a `sound`
    and a `loadedsound` writer in `iw6/dumpers/`, and Ghosts ships no `.iwd`,
    so wherever its streamed half lives is **unestablished**.
- **The feedback bank.** Announcements, countdowns and battlechatter are named
  one at a time in `sound.FEEDBACK_ALIASES` and never as a family: a root nothing
  asks for is how 161 MB of campaign voiceover gets shipped, and `mp_*` alone is
  333 rows of battlechatter and killstreak lines in six languages. Three are
  asked for today: `mp_hit_alert`, which the engine raises itself, and
  `ui_mp_timer_countdown` and `mp_bonus_start`, which the countdown script says
  (29 KB of Opus between them). The list grows as the scripting layer finds
  something else to say, and `pnpm catalog` refuses a build whose scripts name an
  alias this has not pulled in.
- **A map's ambient bed.** The `createLoopSound` placements are the map's
  emitters; a map's stereo bed is named by its ambient script, which the
  metadata stage does not parse. Every bed is `SAT_STREAMED` and reaches the
  `.iwd` path above, so what is missing is the name and not the clip.
- **Staggering identical loops.** dome places 19 chainlink rattles of the same
  15-second recording. Started together they comb-filter. Nothing is baked into
  `sound.world` for it, deliberately: a delay written here would be the same
  offset on every load, where the engine can start each loop at a phase seeded
  per placement.
- **`volumeFalloffCurve`.** Eight named curves in the bank (`$default`,
  `reaction`, `weapon1`, …). Not exported: the engine's `distanceModel` is
  `linear` and nothing reads a curve yet.
- **The other 41 worlds.** Their placements are committed; each needs a full
  export to gain a table.
