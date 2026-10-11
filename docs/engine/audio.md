# Audio

What a world sounds like: the map's own ambience, the sound a player's own body
and weapon make, and the things a gametype says out loud. This page is the
design and the reasons behind it. The field-by-field meaning of an exported
alias is in [../cod/audio.md](../cod/audio.md); the scripting vocabulary is in
[scripting.md](scripting.md).

**Status.** All three kinds are built. Ambience plays, a body is heard by what it
is doing, a weapon is heard firing, reloading and arriving somewhere
([below](#a-weapon-is-heard-through-aliases-the-weapon-file-named)), and a
gametype can say something out loud
([below](#what-the-scripting-layer-gets)). The map
knows what it is made of ([below](#surfaces)). The DSL nodes, the exporter behind
them ([../cod/audio.md](../cod/audio.md)), the client engine that sounds them and
the shared catalogue ([below](#where-sound-lives)) are done: dome-mw3's 77
placements of 23 aliases start, attenuate and pan, against its own table with the
catalogue's 1,330 aliases behind it. Everything diegetic is built on top of that
seam rather than beside it — `sim/footsteps.ts` and `sim/weaponSounds.ts` decide
what happened, `engine/audio/footsteps.ts` and `engine/audio/weapons.ts` play it
through `AudioSystem.playAt` and `playAtListener` — and feedback comes the
same way rather than by a path of its own: `ClientContext.say` is
`playAtListener` with no position to give it. This page was written first,
once, so that nine pieces of work agree about the same shape rather than each
deriving it.

`packages/client/src/engine/audio/` is where it lives: `library.ts` the alias
table and the weighted picker, `requests.ts` what one alias in one place comes
to, `mixer.ts` the channels, `voices.ts` the pool, `ambience.ts` a world's
placements, `footsteps.ts` a body's own noise, `weapons.ts` what it is holding,
`actors.ts` what a creature is doing, `system.ts` the root, the listener and the
seam. The half of either that is
_decision_ rather than playback is `@3d/shared/sim/footsteps.ts` and
`@3d/shared/sim/weaponSounds.ts`, for the reason the whole of `sim/` is shared.
The build half — fetching the table and decoding its clips into the session's
`AssetStore` — is `scene/sounds.ts`, beside `scene/fx.ts` and for the same
reasons.

## The three kinds, which want opposite things

Sound splits three ways, and the split is not a taxonomy — each kind has a
different answer to _where does it come from_, _who decides it happened_, and
_what happens when it is lost_.

|              | Example                                        | Positioned  | Raised by                    | Lost means                      |
| ------------ | ---------------------------------------------- | ----------- | ---------------------------- | ------------------------------- |
| **Ambience** | wind on a fence, a generator, gulls            | yes, fixed  | the world file, at load      | silence until the world reloads |
| **Diegetic** | footsteps, a rifle, a landing, an impact       | yes, moving | state both ends already hold | one missed step; nothing        |
| **Feedback** | a countdown, "enemy has the flag", a hitmarker | **no**      | a script, through an event   | a player never told             |

Ambience is the cheapest: it is in the world file, it never changes, and it is
started once and left running. Diegetic sound is the interesting one, because
**nothing about it goes on the wire** — see [below](#diegetic-sound-costs-no-wire).
Feedback is the only kind that needs a delivered message, which is why it is the
one the scripting layer owns.

## Why three.js, and which parts of it

Three things were looked at: three.js' own `Audio`/`PositionalAudio`, Howler.js,
and raw Web Audio.

**three.js**, and only the parts of it that are a thin wrapper over Web Audio:

- `THREE.AudioListener` — an `AudioContext`, a master `GainNode`, and the
  listener's position and orientation. It is worth having for the orientation
  maths alone: the listener's forward and up vectors have to be written
  per-frame, `AudioListener.positionX.value` and the deprecated
  `setPosition`/`setOrientation` are not interchangeable across browsers, and
  three already carries that difference.
- `THREE.PositionalAudio` — a `PannerNode` per voice. This is what a footstep,
  a gunshot and a wind loop are.
- `THREE.Audio` — no panner at all, straight into the mixer. This is what a
  countdown and an announcement are. A feedback sound is not "a positional
  sound at the listener": it must not be attenuated, must not be panned, and
  must not duck when the player turns their head.
- `THREE.AudioLoader` is **not** used. It decodes into a buffer and hands it
  back, with no notion of who owns it — and an asset here belongs to the
  session's `AssetStore`, not to whoever asked for it (see
  [below](#a-decoded-buffer-is-an-asset)).

Howler.js was rejected for one reason that matters and one that follows from it.
It keeps its own cache of decoded audio, keyed by URL, at module level — which
is exactly what CLAUDE.md's _nothing caches assets at module level_ invariant
exists to prevent, and leaving a world would no longer free what it loaded. Its
3D panner is also its own, so the listener would be updated from Howler's idea
of the camera rather than from ours, and the two would drift.

### Three things three.js decides, and one it must not

`PositionalAudio` refuses to write its panner at all while the voice is stopped,
and ramps it over a frame once it is playing. Both are right for a source that
moves and wrong for one that starts somewhere: positioned first and played second
it plays at the origin until the next frame, and played first it sweeps in from
the origin over the first. So a voice is played, then positioned, then its panner
is snapped — and the test asserts the panner's three numbers rather than trusting
any of that.

### The frozen-matrix trap

`PositionalAudio` extends `Object3D` and writes its world position into the
`PannerNode` from `updateMatrixWorld`. This repo turns exactly that off:
`scene.matrixWorldAutoUpdate = false` in `engine/viewer.ts`, and
`matrixAutoUpdate = false` on every node in `WorldSession`'s freeze step. A
`PositionalAudio` added to the built world would therefore play **at the world
origin, forever**, and it would do so silently — a plausible wrong result, which
is the kind this codebase asks for an assertion rather than a paragraph.

So audio owns **a root of its own beside the scene**, exactly as `engine/fx/` and
`client/net/corpses.ts` already do, and drives its own matrices. Nothing audio
owns ever enters the built world, so none of the freeze rules apply to it and
none of them have to be undone for it.

## Aliases, not files

A sound is named by an **alias** and never by a file, which is Call of Duty's own
model and the right one here for reasons that are not historical:

- **One alias is several files.** `step_run_plr_dirt` is four recordings, picked
  between per step. A footstep that is one file is a machine gun of the same
  click.
- **An alias carries its own playback.** Volume and pitch as ranges to sample
  from, the distance it carries, whether it loops, and which mixer channel it
  belongs to. That is data, exported once, rather than a number written at each
  call site.
- **A name survives a re-export.** A world file naming `emt_wind_dome_flap_ext`
  keeps meaning after the clips behind it are re-encoded, moved into the
  catalogue, or replaced.

An alias table is `sounds.json`, and it is `fx/effects.json`'s shape exactly:
one library file per source, holding a closure, beside a directory of the media
it names. The same argument applies — an alias names clips, so shipping one node
per alias would be thousands of nodes for a fact the exporter already knows.

```
assets/sounds/sounds.json        the alias table
assets/sounds/clips/**.webm      the audio, at the game's own paths
```

### The shape of an alias

Already in engine units — metres and seconds — like everything the exporter
writes:

```jsonc
{
  "_version": 1,
  "game": "iw5",
  "aliases": {
    "step_run_plr_dirt": {
      "clips": [{ "file": "footsteps/foot_dirt01", "weight": 1 }, ...],
      "volume": [0.85, 1.0],     // sampled per voice
      "pitch": [0.95, 1.05],     // playbackRate, sampled per voice
      "range": [4, 22],          // metres: full volume within, silent beyond
      "loop": false,
      "spatial": true,           // false ⇒ THREE.Audio, no panner
      "delay": 0,                // seconds before it starts
      "flags": 6817,             // the game's raw word; only bit 0 is read
      "channel": "ambience",     // absent unless the game named a mixer group
      "with": "gear_rattle_plr_land"  // a layer alongside; absent when none
    }
  }
}
```

The first eight keys are always there. `channel` and `with` are **absent**
rather than null where the game says nothing, because there is nothing for them
to say, and every pair is an envelope over the alias' own variants. The
field-by-field derivation is in
[../cod/audio.md](../cod/audio.md#the-shape-of-a-row).

`weight` is an **unnormalised** weight and not a probability: the dump carries
3.0 beside 0.2 beside 1.0. The picker normalises across an alias' own clips, so
a table that happens to sum to 1 and one that sums to 9 pick alike.

`with` is `secondaryAliasName`, and it is a layer that genuinely plays — 619
aliases name one, over 1,414 entries. A landing pulls the gear rattling on the player's back; a rifle
pulls its mechanical layer and, past its own range, a distant-report tail. So
playing an alias may play another alias with it, one level deep, and that is the
exporter's closure to resolve rather than a call site's to remember.

**`range` is two numbers and both are load-bearing.** The first is the
`PannerNode`'s `refDistance`, inside which a sound is at full volume. The second
is its `maxDistance`, and here it is a **hard cap rather than the end of a
curve**: a voice whose source is further than `max` from the listener is never
started at all. A footstep across the map is not a very quiet footstep — there is
no voice, no buffer fetched, and no panner allocated. `distanceModel` is
`linear`, because `inverse` (Web Audio's default) never actually reaches zero and
a footstep heard faintly from 200 m is a bug that sounds like a setting.

The game's own `distMin`/`distMax` are in **CoD inches, 39.37 to the metre** —
the same units as map geometry, established against mp_dome's own 84 × 79 m
playable box. Divided by that, every alias lands where it should: a fence flap
reaches 19 m, another player's footstep 10–30 m, a rifle 51 m before it hands
over to a `_fardist` tail, and a map-wide ambient bed 635 m.

**`spatial` is derived from that distance, not from a flag.** IW5 spells "never
attenuate this" as an absurd `distMax` — 25,000 inches for a map's ambient bed,
2,500,000 (63 km) for the player's own rifle — and that is the game saying _this
is not somewhere in the world_. So those become `THREE.Audio` with no panner, and
anything with a real distance becomes `THREE.PositionalAudio`. The threshold is
25,000 in, and the whole bank is the argument for it: below the line the values
are a dense continuum over 70 of them, and at or above it there are six, all
round ([../cod/audio.md](../cod/audio.md#how-far-a-sound-carries)). The exporter
applies it once and writes a boolean; nothing downstream re-derives it. Scaling
a `_plr` rifle naively would give a 63 km sphere, which is a wrong answer that
sounds exactly like a right one until two players stand apart.

**The `_plr` infix is not itself the test, and the dump is emphatic about it.**
Of the 1,040 `_plr` entries in the MW3 bank, 666 carry an ordinary short
distance. Every `weap_*_plr` is at 2,500,000 and every `Land_plr_*` at 1,000 in
(25 m) — a landing is positional. Among dome's own `step_*_plr_*`, six are at
25,000 and four are not, and **`step_run_plr_dirt`, the worked example
throughout this page, is one of the four, at 1,000 in.** Whatever that is in the
game's data, the family cannot be read off its name.

**The alias `flags` word is not decoded.** OpenAssetTools names no bits for it in
any IW game, so only bit 0 has evidence — looping, by correlation over 15,871
entries: every `ambient_*`, every `emt_*` but a single one-shot named as one, and
no footstep, landing or weapon fire. That bit is read; the raw word is carried;
nothing else in it is interpreted. Guessing the rest is how you get a plausible
wrong result, and 2D-versus-3D — the one thing a flag would have been useful for
— is answered better by the distance above.

## Where sound lives

Two sources, two homes, following the split the pipeline already has:

- **The catalogue** holds what belongs to no one map: footsteps, landings,
  weapons, bullet impacts and body foley. In the games these are in a _companion_
  zone — `localized_common_mp.ff` for IW5, 7,387 aliases — which is **not** the
  zone the weapon catalogue is built from: `common_mp.ff` holds no sound asset at
  all. `catalog.py` builds it, and it comes to 1,330 aliases and 730 clips, 5.9 MB
  ([../cod/pipeline.md](../cod/pipeline.md#the-sound-bank)). Feedback is in it one
  name at a time and not as a family: three are asked for by name today, and the
  other 330-odd `mp_*` rows are battle chatter and killstreak lines in six
  languages — a root nothing asks for is how 161 MB of
  voiceover gets shipped, so `FEEDBACK_ALIASES` grows entry by entry as the
  scripting layer names one.
- **A world** holds its own ambience: the emitters and beds in the map's own
  zone, and the `createLoopSound` placements from its `export_metadata.json`.
  These are `assets/sounds/` beside `assets/fx/`, written by the export.

**The sound catalogue needs one map zone as well, and that is a documented
exception.** Everywhere else the catalogue is built from a game's companion zone
and from nothing else. Sixteen aliases break it: `step_run_plr_*`,
`step_sprint_plr_*` and six of the `Land*` family are absent from
`localized_common_mp.ff` and present, byte-identical, in _every_ map zone
(checked across aground, dome, paris, seatown and village). Those sixteen are the
player's own footsteps and landings — precisely where the first footstep work
looks — so a catalogue built the usual way has a hole exactly where it will be
noticed last. The build takes the union with one map zone and asserts the overlap
is identical rather than trusting it. **That assertion is vacuous today and is
kept anyway**: measured, a map zone and the bank are _disjoint_ — a map zone
references what the bank defines rather than redefining it — so there is nothing
for them to disagree about until a zone stops being disjoint, which is the day it
would be silently wrong. The claim doing the real work is the byte-identity of
the sixteen across map zones, and that one is checked too
([../cod/audio.md](../cod/audio.md#the-shared-catalogue)).

### Two tables, and which one wins

A name is resolved against the world's own table first and the catalogue's
second, and that order is measured rather than arbitrary. **Ten of the aliases a
map zone defines are genuinely different recordings from one map to the next** —
eight `emt_*`, `emt_mtl_chainlink_rattle_ext` among them, and two
`fx_electransformer_spark_*` — so a world that ships one has to keep its own, or
dome's fence rattles with paris' recording the moment that name reaches the
catalogue. The catalogue is the fallback, and it holds what no map has at all.

`engine/audio/library.ts`'s `SoundBank` is the pair — one table, and where _its_
clips are fetched from — because which table held a name is what decides where
its clips come from. `scene/assetUrl.ts` is still the only place either becomes a
URL, with the branch it always said it would grow:

```
/worlds/<slug>/assets/sounds/sounds.json         a world's table
/worlds/<slug>/assets/sounds/clips/**.webm       and its clips
/api/catalog/sounds/<game>/mp/sounds.json        the catalogue's bank
/api/catalog/sounds/<game>/mp/clips/**.webm      and its clips
```

**A weapon brings its own game's bank.** A world loads the catalogue's bank for
the game it was imported from, and a weapon may come from another: a rifle of one
game carried onto a map of a second has none of its aliases in the world's bank,
and a name nothing holds plays nothing. So a sound may say which game it belongs
to (`PlaySpec.game`); `AudioSystem` fetches that game's bank the first time it is
asked (`prepare`, called as soon as a weapon is seen, so the first shot is not
the one that waits) and looks in it first, then the world's tables. First,
because a name two games share is two recordings, and the rifle keeps its own.

A world's own ambience clips are fetched and decoded at load, as they were. The
catalogue's are not: nothing knows in advance which surfaces a player will walk
on, so a footstep fetches its own the first time it is played — into the same
`AssetStore`, freed on leaving the world like everything else.

### Two places a clip can be

`soundFile` is one of two things, and only one of them is in the fastfile:

- **Loaded** (59%) — PCM in the zone, which the existing `LoadedSoundDumperIW5`
  writes out as WAV. This is every footstep, weapon and impact. Not uniformly
  44.1 kHz mono: dome's own clips run 22.05 to 48 kHz and one is stereo.
- **Streamed** (41%) — not in the zone at all. The alias carries a `dir` and a
  `name`, which resolve into the game's `.iwd` archives at `sound/<dir>/<name>`,
  **case-insensitively** (`iw_11.iwd` spells it `sound/`, `iw_34.iwd` spells it
  `Sound/`). Also `.wav`, bar 197 of 6,163. Every map-wide ambient bed is here,
  so the ambience half of the design does not work from zone dumps alone.
  `scripts/cod/iwd.py` is the way in; it is the same search path the minimap and
  loading screen already come from.

Two more traps in the dump, both of which fail as silence rather than as an
error:

- **A leading comma on a name means "defined in another zone."** A map zone
  spells a shared clip `,footsteps/foot_dirt01.wav` where the common bank spells
  it plainly. Strip it before resolving, or every map-zone footstep resolves to
  nothing.
- **Alias names are case-inconsistent** in the game's own data
  (`Land_plr_carpet` beside `land_plr_ceramic`). Keys are lower-cased and matched
  case-insensitively; there are no collisions in the bank.

A third thing a `soundFile` can be is **nothing**: `null.wav` is half a second at
−91 dB, and 1,532 aliases name it — every `step_scrape_*`, every `*_flesh`,
`weap_putaway`. It is exported like any other clip rather than dropped, because
four `gear_rattle_*_breath` rows mix it _with_ three real recordings, where it is
a one-in-four chance of no breath.

`harvest` is the escape hatch it already is: an ambience alias that turns out to
be shared between maps moves into the catalogue without either end learning a new
rule, because `scene/assetUrl.ts` is still the only place either becomes a URL.

## The DSL

Two nodes, mirroring `fx` and `effect` for the same reasons they exist:

Built. `worlds/AUTHORING.md` is the author's reference; this is what a consumer
needs to know.

```
sounds { source: "assets/sounds/sounds.json" }

sound "wind" {
  alias: emt_wind_dome_flap_ext   // a bare identifier, required
  at: 12.4 3.0 -8.1               // exactly 3, or absent entirely
  volume: 0.8                     // optional, scales the alias'; defaults to 1
  range: 4m 18m                   // optional, exactly 2 lengths, overrides the alias'
  delay: 0                        // optional seconds; negative starts it already running
  tag: "ambience"                 // optional, a quoted string
}
```

`sounds` is the library, one per world (a second is a `duplicate-sounds`
warning), because an alias names clips and may name another alias as a layer, and
the exporter ships that closure as a unit. `sound` is a placement: where the
sound is, and which alias it plays. It nests in a `group` and nowhere else, and a
group's transform is baked into its `at` during resolve like every other
placement.

**A placement with no `at` is the world's bed** — non-positional, played at full
volume everywhere, which is what a map's stereo ambience track is. So
`ResolvedSound.position` is `Vec3 | undefined` and **`undefined` is not the
origin**: a bed inside a group stays position-less rather than inheriting the
group's. Anything reading it has to tell the two apart or it will pin the map's
ambience to a point in space.

On `ResolvedWorld` the library is `soundLibrary` and the placements are `sounds`
— the plural-of-node-name slot was already taken by the list, as it is for
`effects` and `triggers`.

Four diagnostics, all for things that would otherwise be silent:
`no-sound-library` (a `sound` with no table; reported once per world, not once
per emitter), `sound-bad-range` (max below ref, so silent everywhere — the
placement is dropped), `bad-alias-ref` (a dotted name), and `duplicate-sounds`.

Two things about `alias` being a bare identifier rather than a quoted string,
since `effect`'s `fx:` is a string for a rationale that applies here word for
word:

- It constrains alias names to `[A-Za-z_][A-Za-z0-9_-]*`. **Checked, not
  assumed:** all 7,623 aliases dumped from IW5's MP bank and map zones are legal
  identifiers, zero exceptions. A later game that is not gets this changed to a
  string; there is nothing else holding it.
- `no-sound-library` being an _error_ forecloses a world naming a catalogue alias
  without a table of its own. That is exactly what `harvest` moving shared
  ambience into the catalogue will eventually want, so it is the one rule here
  expected to be relaxed rather than kept.

## Diegetic sound costs no wire

A footstep is **never sent**. This is the design decision the rest of the
diegetic work follows from.

Every input to a footstep is already on both ends: a player's position, velocity
and stance ride in every snapshot, and `PlayerState.fired` is a 16-bit shot
counter that already advances once per round. So a client works out that a
footstep happened the same way the server would — and since neither end has to
tell the other, there is nothing to lose, nothing to repeat, and no retention
policy to pick.

That only works if the derivation is **deterministic and shared**, which is what
`@3d/shared/sim/` is for and why the step cadence goes there rather than into the
client:

**The cadence already exists, and nothing new goes on the wire to get it.**
`sim/gait.ts` keeps a `stride` clock: a 0→1 phase, advanced by
`dt * rate / STRIDE_PERIOD` where `rate` is `speed / RUN_SPEED` clamped to
`STRIDE_RATE_RANGE`, reset on a mantle or a ladder, and held — not zeroed — when
a grounded player is below `IDLE_SPEED`. It is already `MovementState`, already
`PlayerState.stride` on the wire, and already what the legs are animated from.

So a footstep is **the stride phase crossing a footfall**, and that one sentence
buys every property the cadence needs:

- **Running is faster than walking for free**, because `rate` already scales with
  speed. Nothing here sets a per-gait interval.
- **The sound lands on the visible footfall**, because the leg animation is
  driven from the same phase. A separately-accumulated distance would drift
  against the legs and look wrong in a way nobody could name.
- **A slowed player's steps slow with them**, because speed drives the clock.
  None of it is a special case. What this does _not_ buy, and an earlier draft of
  this page claimed it did, is silence for a player pressed into a wall: the
  resolver puts the capsule back without touching the velocity, so a player
  running at a wall keeps the velocity — and the stride, and the footsteps — of a
  player running. The legs are drawn running on the spot too, which is what the
  games do, so this is left alone rather than special-cased. Measured on dome:
  ten seconds of sprinting into a wall is 34 footsteps and 4 m of travel.
- **Both ends already agree**, because the phase is simulation state a server
  replays and a snapshot carries. A remote player's footsteps come from watching
  their `stride` advance in exactly the way the local player's come from
  watching their own.

A grounded check is required, and is the one thing the sentence does not give:
the clock keeps running while airborne, deliberately, so that a player who hops
mid-sprint lands back into the stride they left; without the check they tread the
air. `sim/footsteps.ts`'s `FootstepWatcher` is where both live.

**Which phases are the footfalls is six, not two.** 0 and ½ was the guess, and it
was wrong by a factor of three: `stride` is a phase into the _run clip_
(`sim/pose.ts` hands it to every locomotion clip as a fraction of that clip's own
duration), and a CoD run loop is three double-steps long. Measured by posing
`worlds/catalog/animations/<game>/autorifle` and finding where each ball joint
settles:

| Clip                                    | Plants at                     |
| --------------------------------------- | ----------------------------- |
| iw5 `pb_combatrun_forward_loop_assault` | .129 .283 .463 .621 .796 .958 |
| iw5 `pb_combatrun_left_loop_assault`    | .113 .271 .442 .600 .792 .942 |
| iw5 `pb_combatrun_right_loop_assault`   | .142 .300 .471 .642 .808 .971 |
| iw5 `pb_sprint_assault`                 | .129 .292 .475 .617 .858 .975 |
| iw6 `pb_hold_run`                       | .129 .300 .454 .629 .783 .963 |

Six, evenly spaced, the first an eighth of a cycle in — across two games and both
gaits — so the constant is a count and one offset (`FOOTFALLS_PER_CYCLE`,
`FIRST_FOOTFALL`) rather than a table, and the worst clip is 0.02 of a cycle off
it, which is 6 ms at a sprint. It stays `STRIDE_PERIOD`-relative rather than
clip-derived because `stepMovement` is pure and asset-free; re-deriving it after a
re-export is re-running that measurement, not reading a file at run time. **It is
still the one number here that wants ears**: an analyser can count steps a second
and cannot say whether they land on the beat.

- The alias prefix comes from the gait, and the gaits are the bank's
  own rather than this engine's: `prone` (3.0 m), `walk` (10.2 m), `run`
  (30.5 m), `sprint` (35.6 m), and `scrape` (3.0 m, and `null.wav` on almost
  every surface). **There is no `crouch` family**, so what a crouching player
  plays is this engine's decision and not the game's — an open question rather
  than an omission.

  The simulation has **two** speeds to put on those five: `WALK_SPEED` with
  nothing held, which is what the legs play the _combat run_ at, and `RUN_SPEED`
  with the run key, which is the sprint clip. So the walk speed is the bank's
  `run` and the run speed is its `sprint`, and `walk` is what is left underneath — a
  landing's slowdown, a strafe into a wall, the first ticks off a standstill.
  `prone` and `scrape` are **unreachable**: a gait is chosen by speed alone, so a
  crouched or prone player's steps are the `walk`'s, and there is no slide. The thresholds
  (`gaitFor`) sit _between_ the two plateaus rather than on them, because
  `accelerate` stops exactly at its target and a threshold there is decided by
  the last bit of a float — twice a second, for ever.

- Which of an alias' clips is picked, and the volume and pitch sampled for it,
  come from a seeded stream, so a screenshot or a replay reproduces it and
  `Math.random` never appears. `stepStream(seed, ordinal, index)` has
  `shotStream`'s shape and for the same reason: `sim/` is handed a number rather
  than a player id, because it knows nothing about ids and may not reach
  `game/random.ts` to hash one.

  **A peer's steps agree across every client and your own do not have to.** A
  peer's are derived from the snapshots themselves — the server's own tick states,
  arriving identically everywhere, carrying a `tick` every client agrees on — so
  the same step draws the same recording in every browser. Your own are played
  through `_plr` aliases nobody else hears, so their ordinal is a counter this
  client keeps; it only has to stop consecutive steps drawing the same recording.
  Deriving a peer's per _frame_, off the interpolated body, would have made each
  client's draw times part of the answer.

**Landings.** The transition is `grounded`, and `MovementState.landing` is **not**
the test although it is the obvious one: it is a jump's alone, so it misses every
fall that began by walking off something. One sound on the tick the feet touch —
not one per tick of the recovery — gated on how fast the body was actually
falling, because `grounded` can drop for a tick or two over imported triangle
soup and that is not a landing.

**The bank has no jump.** Nothing in IW5's whole 7,387-alias bank is a jump, an exert or a
grunt; `gear_rattle_*` covers landing, mantling, walking, running, sprinting and
prone, and a takeoff is silent. So a jump makes no sound here, and that is the
game's answer rather than a gap. A landing pulls `gear_rattle_plr_land` as its
`with` layer, which is the rattle a body makes arriving.

**Surfaces.** The surface is what is under the foot at the moment the step
lands, and it is built: CoD carries a surface type in each face's
`surfaceFlags`, the collision export writes it into `collision.glb` per vertex,
and `CapsuleWorld.surfaceAt` answers with a name out of
`@3d/shared/sim/surfaces.ts` — which is where a footstep reads it, because
`sim/` may not import `collision/`. The names are the game's own, so an alias is
spelled by concatenation (`step_run_plr_` + `metal`) rather than by a table
here. Every one of the 31 has a footstep alias; `default` is one of them, and it
is what a `caulk` face and a hand-written world both answer.
See [collision.md](collision.md#what-a-surface-is-made-of).

### Your own footsteps and everybody else's are different sounds

Two families, `step_<gait>_plr_<surface>` for the listener's own boots and
`step_<gait>_<surface>` for everybody else's. That split is real and is what the
engine plays. What it is **not** is the test for whether a sound is positional —
see the correction below, which cost one wrong paragraph in this file already.

**Gait decides how far a stranger's footstep carries**, and this is the game's
own answer to _footsteps must not be heard across the map_. Measured over all 194
step and landing aliases in IW5's bank, third-person distances are uniform per
gait to the inch:

| Gait                    | `distMax` | Carries    | Against Dome's 84 m                        |
| ----------------------- | --------- | ---------- | ------------------------------------------ |
| `step_walk_<surface>`   | 400 in    | **10.2 m** | a twelfth of the map                       |
| `step_run_<surface>`    | 1,200 in  | **30.5 m** | a third                                    |
| `step_sprint_<surface>` | 1,400 in  | **35.6 m** | a little over a third                      |
| `Land_<surface>`        | 1,600 in  | **40.6 m** | a landing is the loudest thing a body does |

So sprinting is both faster _and_ louder than walking, and a walking enemy is
inaudible from three times closer than a sprinting one. That is a tactical rule
the game already tuned, arriving for free from the alias table — no constant in
this repo sets it, and a re-export moves it.

### `_plr` is not the test for non-positional

The obvious rule — _the `plr` infix means "your own body", so play it flat_ —
is wrong, and the data says so unambiguously. Of 1,040 `_plr` entries, 666 carry
ordinary short distances:

| Alias               | `distMax` |                                                                                    |
| ------------------- | --------- | ---------------------------------------------------------------------------------- |
| `step_walk_plr_*`   | 25,000 in | all 32, non-positional                                                             |
| `step_run_plr_*`    | **split** | 26 at 25,000; 7 at 1,000 (bark, brick, carpet, cloth, concrete, default, **dirt**) |
| `step_sprint_plr_*` | 1,500 in  | all 32 — _below_ the non-positional threshold                                      |
| `Land_plr_*`        | 1,000 in  | all of them. A landing is positional even when it is yours                         |

`step_run_plr_dirt` is the trap in miniature: it is the canonical first case any
footstep work reaches for, it is the one dome's own zone carries, and it is one
of the seven that break the pattern.

**So the engine does not consult `spatial` for a sound it attaches to the local
player.** A sound emitted at the listener is played through `THREE.Audio`,
always, whatever the alias says — because a `PannerNode` at zero distance has no
well-defined direction and attenuates by nothing anyway, so the positional path
buys nothing and risks an unstable pan. `spatial` governs sounds placed _in the
world_; who is emitting governs the rest. That rule makes the game's own
inconsistency here irrelevant rather than something every call site has to
remember.

### Walking from gravel onto metal

There is nothing to cross-fade. A footstep is a one-shot: each step asks what is
under the foot _at the instant it lands_, and plays that. Step onto the gantry
and the next step is metal; there is no state to transition out of, and no two
surfaces are ever playing at once.

The only sounds that would need a transition are continuous ones — a slide, a
ladder climb, a prone drag — and the answer there is the one the game uses: a
three-part alias (`_start`, `_loop`, `_end`, which is how `foot_slide_npc_*` is
shaped in the dump), where changing surface ends one and starts the other. None
of those exist yet, and the shape is written down here so the first one does not
invent its own.

### A weapon is heard through aliases the weapon file named

A weapon's sounds are **carried**, never spelled from its id, and the M4 is why:
`m4_mp` in Modern Warfare 2 and `iw5_m4_mp` in Modern Warfare 3 are both
`weap_m4carbine_*` in the bank. A prefix rule works on most of a game's 53 guns
and silently fails on the rest, which is exactly the plausible-wrong-result this
repo asks for data about. The weapon file already says it, across some thirty
keys — `catalog.py`'s closure has been following them since the bank was built —
and `WeaponDef.sounds` is those names carried through to both ends:

| Field                    | Weapon-file key                    | What it is                                           |
| ------------------------ | ---------------------------------- | ---------------------------------------------------- |
| `fire` / `firePlayer`    | `fireSound` / `fireSoundPlayer`    | somebody else's round leaving, and your own          |
| `emptyFire*`             | `emptyFireSound*`                  | the trigger on an empty magazine                     |
| `reload` / `reloadEmpty` | `reloadSound` / `reloadEmptySound` | a peer's whole reload, as one alias                  |
| `melee` / `meleePlayer`  | `meleeSwipeSound*`                 | the knife                                            |
| `impact`                 | `impactType`                       | a **prefix**: `bullet_large` + `_` + a surface       |
| `notes`                  | `notetrackSoundMap`                | `{notetrack: alias}` — which of a clip's notes sound |

That changes a `WeaponEntry`, so it moved `CATALOG_VERSION` to 4. It does **not**
move `WEAPON_FORMAT_VERSION`: a world's own viewmodel GLB carries the same extras
and the field is additive and optional, so a map exported before this reads as a
weapon that makes no noise — which is a behaviour this already has to have, for
the reason below. Bumping it instead would refuse all 42 committed viewmodels
until every world was re-exported.

An attachment's overrides merge `sounds` key by key, like `roles` and `times`,
and there is exactly one thing that needs it: a silencer replaces the two fire
aliases and nothing else, so a silenced M4 keeps its own reload, its own
notetracks and its own impacts. IW5 says so in the weapon file's
`soundOverrides` table; IW4 says it by shipping `m4_silencer_mp` as a whole file,
and the existing diff picks it up for free.

**Ghosts has no weapon sounds at all**, and that is the reason every field is
optional. Measured: all 130 IW6 weapon files carry a `notetrackSoundMap` and an
`impactType`, and **not one carries a `fireSound`** — the emulated loader
resolves them away ([../cod/games.md](../cod/games.md)) — and no IW6 sound bank
is built either. So an IW6 weapon is **silent**, at two layers: no alias to
spell, and no bank to hold the ones it does spell. Silent and never a fallback:
borrowing another gun's rifle would be a wrong sound where nothing is an honest
one.

### A round leaving, and the report that follows it

`PlayerState.fired` is a 16-bit counter that advances once per round, and a
client reads a shot out of it the way the server reads one out of its own replay
— wrap-safe, and every round between two observations rather than the first.
`sim/weaponSounds.ts`'s `WeaponWatcher` is that, and `sim/footsteps.ts`'s
`FootstepWatcher` is its shape: an observer holding the last state it saw, one
per player, the local one stepped per frame and a peer's per snapshot.

Two things it has to refuse. A **new weapon** starts its counter at zero, so the
watcher is keyed on whatever identifies the weapon — the controller for your own,
the catalogue index for a peer's — and a different key resets rather than
reports. And a **respawn** does the same without changing that key, so a count
above `MAX_SHOTS_PER_OBSERVATION` (16) is read as bookkeeping: the fastest weapon
here fires one round in the 50 ms a frame or a snapshot covers, so sixteen is far
above anything real and far below 65,506.

**The distant report is data and not a mechanism.** `weap_m4carbine_fire_npc`
reaches 50.8 m and names `weap_medium_fardist_6` as its `with` layer, which
reaches 508 m; `requests.ts` already plays a layer with its own range rather than
the primary's. So a shot beyond its own distance is not swapped for a tail —
**the shot is culled by the same hard `maxDistance` a footstep is, and the tail
is what is left**. Measured on dome, two browsers in one game: a shooter 60.9 m
away gave the listener one voice per round and it was `weap_medium_fardist_b20`;
nothing here looks at a distance to decide that.

Your own shot goes through `playAtListener` — flat, for the reason every `_plr`
sound is. The game's own row agrees for once (`weap_*_fire_plr` is at 63 km), but
the engine does not consult it.

### Your own reload is a sequence and a peer's is one sound

Both are the game's own answer rather than a simplification.

**Your own** is the notetracks of the clip that is playing. `WeaponClipInfo.notes`
already carries every notetrack with its time into the clip — it has since the
viewmodel work — and `notetrackSoundMap` says which of them are sounds, so
`weap_m4carbine_clipout_plr` at 0.37 s, `_clipin_` at 1.23 and
`_chamber_close_` at 1.73 play and `viewmodel_small`, `reload_vm` and
`interruptible` do not, with no keep-list per game. The crossing rule is `footfallsCrossed`'s:
half-open at the last observation and closed at this one, so
a note sounds once however many frames straddle it.

### A predicted playhead is not monotonic

**`clip.time` goes backwards in ordinary play, and that is the wire rather than a
bug.** It travels as `quant(0, 32, 14)` (`net/messages/player.ts`), a grid of
about 2 ms. A correction restores the server's _quantised_ playhead and the
client replays from there, so a predicted one is snapped up or down by up to half
a step on every snapshot — twenty times a second, and visible on almost every
frame because the clip only advances on a tick while the watcher reads it every
frame. Measured against the last observation, each of those snaps re-crossed
every notetrack behind the playhead: one ACR reload arriving as twenty-odd
voices, growing as the playhead passed each note.

So a backwards playhead is read three ways, and telling them apart is the whole
of `WeaponWatcher.notes`:

| It went back by            | What happened               | What sounds                                       |
| -------------------------- | --------------------------- | ------------------------------------------------- |
| ≤ `CLIP_TIME_GRAIN`        | the wire's grid, not motion | nothing; the playhead is **held where it was**    |
| more, and the clip loops   | a loop came round           | the tail of the old pass plus the head of the new |
| more, and it does not loop | the clip started again      | nothing yet; what it crosses **from there**       |

The last row is the one place a sound is deliberately lost. A clip that has
genuinely started again — a reload sprint-cancelled and asked for again, or a
shotgun's next shell, which `startSegment` replays with `restart: true` rather
than by looping — is indistinguishable here from a correction that snapped
further than the grain, and of the two wrong answers a notetrack missed is the
one that is not a machine gun. Only notetracks at or before the playhead when the
restart is noticed are lost, which in practice is one at 0.0.

This is not a rule about weapons, and it is not a rule about playheads.
**Every observer of _predicted_ state has to be idempotent under correction**,
the way `FirstPerson.smoothing` already is for position. The same defect was
live in two more places. `WeaponWatcher`'s shot counter re-baselined on any
backwards move, so a round the server had not fired yet was put back and heard
again when the replay fired it — it now holds, and only a jump of tens of
thousands (a respawn, a swap) re-baselines. And the footstep watcher: `stride` travels
as `unit`, 8 bits of a cycle, and its baseline was carried backwards with the
snap, so the footfall a snap crossed was trodden again on the way forward —
fifteen extra steps a minute at a jog. There it needs no grain, because
`footfallsCrossed` is already silent going backwards and the only legitimate
reset is a climb or a teleport, both already detected; holding the clock is the
whole of it. Anything added later that derives a sound by differencing a
replicated quantity inherits this problem and should hold its baseline the same
way.

A pass is keyed on the **clip** and not on the role, because several roles name
one clip file — `adsFire` and `idle` are both `viewmodel_l96_idle` — and `play`
already refuses to restart one for another; keyed on the role, a correction that
re-spelled the role it restored would read as a new clip. A genuinely new pass is
measured from **-1** rather than 0, because the interval is half-open at its
start and an L96A1 lifts its magazine at exactly 0.0 — the same number
`WeaponController.play` opens a clip with, said on both sides of the seam.

Nothing here is timed off the state's own span, and it did not need to be: the
notetracks are in the catalogue, in seconds, and the clip's `time` rides in every
snapshot. That also means a reload stretched to fit `reloadTime` keeps its sounds
on its own frames.

**A peer's** is `reloadSound` — one alias, played once on the tick the state is
first seen, whose own `with` layer carries the magazine going back in. The
notetracks are not used for a peer, because every one of them is a `_plr` alias:
playing them would put the listener's own magazine across the map. A peer who
comes into view already reloading starts no sound, because the first observation
of a weapon is a placement and not a transition.

### A bullet arriving

`RayHit` grew a `surface`, filled from the same face the trace answered with —
which is what [collision.md](collision.md#what-a-surface-is-made-of) said it
would when the surface attribute landed. A prop hull carries none (the exporter
writes them for a map's own clipmap), so a prop is `default`, honestly.

The alias is concatenation, as a footstep's is: `impactType` + `_` + the surface,
and **the bank is not square**, which is the whole reason there is a fallback.
Measured over IW5's own rows: `bullet_ap` has all 31 IW surfaces, `bullet_small`
30 (no `snow`) and `bullet_large` 29 (no `snow`, no `water`). So `impactAliases`
answers the exact surface and then the family's `_default`, and the caller plays
the first its bank holds (`AudioSystem.knows`). Six of Modern Warfare 3's guns
carry `impactType shotgun`, for which the bank has **nothing at all** — those are
silent on impact, and that is the data rather than a gap to paper over.

**Only your own rounds, and only against the map.** The client traces the round
it has just predicted — the same ray the server will trace, the aim plus the kick
from _before_ this round, deviated in the weapon's own cone from the same seeded
stream (docs/engine/player.md#trace-then-kick) — so the surface it picks is the
surface the server found, bar the divergence `ShotTraceView` exists to show. A
round that stopped in a body still marks what was behind them: the hit position
is not on the wire, and reproducing the server's rewound hitbox test here would
be a second hit model, which is how two ends stop agreeing about what a round
did. A peer's impacts are not derived at all for the same reason — their ray is
not in any snapshot.

### Being hit, and dying

The event tail already carries both, already de-duplicated by `SeenEvents`, so
nothing is heard twice.

A **hit marker** is feedback: `mp_hit_alert`, on `ui`, flat, never repeated —
sent on the tick it happened to the player who fired and to nobody else. It is
the one announcement anything here asks for by name, which is why it is the one
the catalogue carries; a root nothing asks for is how 161 MB of voiceover gets
shipped.

A **death** is diegetic, and the bank decides what it is. There is no player
death vocalisation in it — every one of the 73 rows with `death` in the name is
an announcer line, in six languages — so a death is
`bodyfall_<surface>_large`, the weight of a body hitting what it fell on, at the
victim's feet with the surface probed the way a footstep probes it. Raised by the
event rather than by the ragdoll settling, because the event is the thing every
client agrees about.

### A creature is heard by its kind

An actor is diegetic too, and derived from the snapshot in the same way: a voice
and a swing as an attack begins, a death as it falls, an arrival, and a noise of
its own every few seconds while it lives. Its kind names the aliases, in one
game's bank, and that game travels with every one of them (`PlaySpec.game`), so a
creature keeps its own recordings on another game's map exactly as a weapon does.
What each role means is [actors](actors.md#its-sound).

## A decoded buffer is an asset

CLAUDE.md's invariant applies unchanged: **assets belong to a session, not to a
world**, and nothing caches them at module level. A decoded `AudioBuffer` is an
asset like a texture — it is the expensive thing, it is keyed by the URL it came
from, and `dispose()` on leaving a world frees it.

So the session's `AssetStore` owns decoded buffers, `scene/assetUrl.ts` is still
the only place a clip becomes a URL, and re-entering a world costs a warm HTTP
cache and a re-decode rather than a leak nothing can find.

Two consequences worth stating:

- **A voice is not an asset.** A `PositionalAudio` is pooled and reused within a
  session; the buffer it is pointed at is owned elsewhere. Killing a voice frees
  nothing and is meant not to.
- **A looping ambience holds its buffer for the life of the world**, which is
  correct and is why ambient beds are the one thing worth streaming rather than
  decoding whole. That is not built in the first pass; a map's beds are a few MB
  of Opus and decoding them is affordable.

## The mixer

One `GainNode` per channel, all into the listener's master gain:

```
master ─┬─ sfx        weapons, impacts, bodies
        ├─ footsteps  its own, because it is the one people turn down
        ├─ ambience   the world's loops and beds
        ├─ voice      announcements, battle chatter
        └─ ui         menus, countdowns, hitmarkers
```

Channels are per-viewer preferences, so they live in `localStorage` and never on
the server — and every read is wrapped, because a private window throws rather
than returning nothing.

An alias' `channel` is not invented by the exporter where the game already says
it: `mixerGroup` carries `weapons` (361 aliases), `ambience` (145) and `mission`
(2), and is null or `max` for the rest. Those three are honoured and the
remainder are assigned by what raises them, which is knowledge the engine has and
the dump does not — a footstep is a footstep because the footstep code played it,
not because of anything in its row.

**The row wins and the caller is the fallback**, never the other way round. The
order matters because getting it backwards is inaudible until somebody moves a
slider: **not one of dome's 23 ambience aliases names a mixer group**, so with
the caller as a fallback the map's whole ambience lands on `ambience`, and with
the caller as an override a `mission` line would land there too. A world's
`sound` placement offers `ambience`; the footstep code will offer `footsteps`.

### Starting at all

An `AudioContext` is created suspended and browsers will not start it without a
user gesture. The client already has two: signing in, and the click that takes
pointer lock. The context is resumed on the first of either, and until then the
system is fully built and running with a suspended context — **not** deferred,
so there is no second code path that only ever runs once and is therefore never
tested.

## Voices are pooled and capped

A total cap, with the quietest-at-the-listener voice stolen when the pool is
full — and only for something louder than it, so a sound nobody would hear never
takes a slot from one somebody would. Two hundred players' footsteps is not a
mixing problem to solve with a limiter; it is a number of `PannerNode`s the
browser will not give us. The hard `maxDistance` cut above does most of this work
for free: dome starts between six and ten of its 77 loops at once, and the rest
cost nothing at all.

A loop starts when the listener comes inside its `maxDistance` and stops when
they leave it, with a little slack on the way out so that standing on the
boundary does not start and stop it every frame. That is the same rule as the
cut rather than a second one, and it is why nothing is started at load.

### Nineteen copies of one clip is a comb filter

Dome has nineteen `emt_mtl_chainlink_rattle_ext` emitters along one fence, all
within earshot of each other and all naming the same rattle. Started together
they are not ambience: they are one rattle nineteen times as loud with a metallic
ring on it. So every looping voice starts part-way into its clip, at an offset
seeded by the **placement** — its alias and its id — which makes the nineteen
nineteen different offsets and makes a world sound the same every time it is
entered. Walking back into earshot restarts a loop at its own offset rather than
at a new one, for the same reason.

## What the scripting layer gets

Diegetic sound is the engine's, because it is derived from state and a script
adding nothing would only cost a hook call per player per step. Feedback sound is
the scripting layer's, because _what a gametype says out loud_ is the whole of
what makes one gametype different from another.

That needed two things that were declared and not built
([scripting.md](scripting.md#what-a-gametype-says-out-loud)): `ServerContext.publish`
had to reach a browser, and `ClientHooks.event` had to be called when it does.
**Both are built**, and a sound is their first consumer rather than a mechanism
invented for it — the event is an ordinary fifth kind in the snapshot tail, which
is also the only wire change any of this audio work made.

A script says _what happened_, never _which file_: `publish({ what: "flagTaken",
team })`, and a client script's `event` hook turns that into an alias. A server
naming a `.webm` would be a server that has to know what a client shipped.

Three things about the sound itself, none of which a call site has to remember:

- **It is flat, whatever the row says.** `say` goes through `playAtListener`, so
  `THREE.Audio` with no panner — the same rule that makes the game's `_plr`
  inconsistency irrelevant ([above](#_plr-is-not-the-test-for-non-positional)).
  Measured: both aliases the countdown names carry an ordinary 15 m `distMax` and
  would have been positional if anything had consulted it.
- **`ui` or `voice`, and nothing else.** A script may say something out loud; it
  may not make a noise in the world, so the three channels belonging to things
  that are _somewhere_ are not in `FeedbackChannel` at all. Turning `voice` down
  silences announcements and nothing else.
- **An alias the bank has not got is loud in development and silent in play.**
  `pnpm catalog` refuses a build whose scripts name one; a browser warns once per
  alias. The catalogue's `feedback` group is three entries now — `mp_hit_alert`,
  which the engine raises, and `ui_mp_timer_countdown` and `mp_bonus_start`, which
  the countdown script says. That is 29 KB of Opus, and `FEEDBACK_ALIASES` still
  grows one name at a time for the reason it always did.
