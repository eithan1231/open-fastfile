# Scripting

Gameplay lives in `packages/shared/src/game/`: gametypes declared as data, and the
scripts that run them. This page is why it is shaped the way it is, and what is
built versus declared.

One script decides who a player is, and two places ask it:
`client/src/app/WorldSession.ts` when a world is mounted, and
`game-server/src/match/match.ts` when a player joins. That was the whole of it for one
pass, and deliberately so: moving the decision out of the world files without
changing the answer is what let the two `.world` files be deleted with nothing to
see.

Combat is the second pass, and the first one a script can change the outcome of:
`combatRules` sets the numbers, `playerDamage` and `playerDeath` hear about a hit
and a kill, and `damage`, `score`, `spawn`, `setTeam` and `publish` do something.

Saying something out loud is the third, and the first pass a _client_ half does
anything with: `tick` is a gametype's own clock, `publish` reaches a browser, and
`event` is where a name becomes a sound ([below](#what-a-gametype-says-out-loud)).

Classes are the fourth: `classRules` says who may choose one and when a choice
takes effect, `classChoice` has the last word on each, and `arm`, `setLoadout`
and `setClassChange` hand a player weapons, or a verdict, themselves
([below](#classes-in-a-match)).

Bots are the fifth: a script adds bots and gives them objectives, and a brain on
the game server decides what each does about its objective
([below](#bots)). `matchStart` and `playerJoin` came with them, because a
gametype's bots have to be added somewhere and people put on the other side.

Actors are the sixth: creatures a script spawns that are not players — a kind,
a brain and a dozen bytes on the wire each — with `ctx.actors` to spawn and
command them and `actorDamage` and `actorDeath` to hear them hurt
([below](#actors), and [actors](actors.md) for the runtime).

Areas and the use key are the seventh: every `trigger` is an area a player's
feet can be in (`triggerEnter`, `triggerLeave`, `ctx.zonesOf`, `ctx.occupants`),
and a trigger or solid with `use` is something the use key reaches — `usable`
says whether it can be used now, `interact` does it, and `prompt` says so in the
browser ([below](#areas-and-the-use-key)).

A script's own numbers are the eighth: `init` gives a script state that lasts the
match ([below](#a-script-keeps-its-own-state)), `addPoints` and `setCounter` keep
numbers every client reads and the HUD shows, and `respawn` and `endMatch` let a
gametype say when somebody comes back and when the game is over
([below](#points-counters-and-the-end-of-a-game)).

`send` and `request` are what is left: both are **declared and not built**, and
both throw when a script calls one rather than doing nothing, so a script that
tries to talk to another script — or to ask the server for something — fails
loudly instead of believing it worked.

## Why a world stopped deciding

A world used to declare its own people. `characters.world` listed the bodies a map
shipped and `viewmodel.world` named one pair of hands and one gun, which had three
consequences:

- **a body could only be worn on the map that packed it.** 42 worlds shipped
  ~17 MB of cast each to use about 1 MB of it;
- **a peer's body was picked by hashing their player id** against whatever the
  current map happened to carry, because there were no teams to pick by;
- **the server's default weapon was whatever the map named**
  (`game-server/src/match/`), so what a player carried was a property of the
  scenery.

None of that survives teams and killing, which is the direction. And the data for
it is already exported and already ignored: 9,463 `spawn` nodes across 42 worlds
carry `mode:` and `team:` — dome alone has 219 over 7 modes — and
`spawnPoints(world, { mode, team, start })` in `sim/worldRules.ts` was written to
consume them. `Spawns.place` asks for neither.

So the catalogue holds the people (`docs/cod/pipeline.md#the-shared-asset-catalogue`)
and a gametype chooses among them.

## Where it lives, and why not a package

`@3d/shared/game/`, as a tier-one subtree beside `sim/`.

`sim/` is the precedent, and CLAUDE.md gives its reason: _the code that has to
agree lives in one place rather than two._ A cast derivation that must match in a
browser with no server, in a browser with one, and on a game server is that
sentence exactly.

The deciding practical argument is that **the isomorphism guarantee comes free**.
`packages/shared/tsconfig.json` typechecks this package with `lib: ["ES2022"]` and
`types: []`, so a stray `document.` or `process.` in a script is a build failure,
and tier one also bans three.js — which a script _should_ be banned from, since a
script decides and `scene/`/`engine/fx/` draw. A separate package would buy no
capability and have to re-earn all of that, plus a `package.json`, a `tsconfig`, a
vitest project and an ESLint block.

The api's concern is answered by import granularity rather than by a package
boundary: `@3d/api` imports `game/gametypes/registry.js` — plain data — exactly as
it already imports `sim/loadout.js`. It never imports a script.

That split is load-bearing rather than tidy. `game/registry.ts` imports every
script as a _value_ for its `SCRIPTS` table, so an api reaching for `gametype()`
there would pull the whole script table, and everything a script transitively
imports, into the authority's bundle. So the gametype table lives in
`game/gametypes/registry.ts` and `game/registry.ts` re-exports it, and
`eslint.config.js` bans `@3d/shared/game/registry.js` and
`@3d/shared/game/scripts/**` from `packages/api/src/**` — because "the api never
imports a script" was a convention that nothing checked, and it was already being
broken by `scripts/catalog.ts`.

Promoting a subtree to a package later is mechanical. Un-picking a package that
should not have existed is not.

## Declaration and behaviour are split

The same split a route already has: `protocol/routes/` says what a route **is**
and `api/src/routes/` **implements** it.

|             | Where              | What                                                                             |
| ----------- | ------------------ | -------------------------------------------------------------------------------- |
| Declaration | `game/gametypes/`  | `GametypeDecl`: id, display, teams, `spawnMode?`, `maps?`, `games?`. Plain data  |
| Behaviour   | `game/scripts/`    | A `Script`: an id, optional restrictions, and a server half and/or a client half |
| The tables  | `game/registry.ts` | `GAMETYPES` and `SCRIPTS`, plus `gametype()`, `admits()`, `scriptsFor()`         |
| Bots        | `game/bots/`       | Brains, the motor and `BRAINS`. Server-run; a script names a brain by id         |
| Actors      | `game/actors/`     | `ACTOR_KINDS`: a creature's capsule, speeds, health and blow. Plain data         |

This is what lets `@3d/api` validate a lobby's gametype and build a game order
having imported no logic at all.

## How a gametype reaches a game

A world used to decide, and now nobody in the world does — so the chain is worth
writing down, because five things had to learn the same name:

```
lobby (api)         `Lobby.gametype`, DEFAULT_GAMETYPE at open;
                    the host sets it, validated with `gametype()` and `admitsMap()`
  → game order      `GameOrder.gametype`, a name and never a copy of the table
  → instance        `Games.create` resolves it, refuses a name it does not know,
                    then checks `admits()` now the world's `game:` is resolved
  → `Match`         `Playing.gametype`, which is what every script hook is handed
  → `joined`        the id, so the browser resolves a side and dresses a peer the
                    same way the server does
```

**The admission check is split on purpose.** `admits(decl, map, game)` needs the
source game a world was imported from, which lives in its `world { game: }` and
_not_ in the worlds manifest — so the authority would have to resolve world text
to check a `games` restriction. Instead it checks what a slug can answer
(`admitsMap`) and the instance, which has the resolved world, checks the rest. A
gametype restricted to a game it is not being played on is refused by the instance,
one restricted to maps by the api, and neither pretends to do the other's half.

**A name, not a declaration.** `GAMETYPES` is compiled into both ends, so sending
the table would let them disagree about what a gametype _is_ while agreeing about
what it is called. An end that does not know the name says so: the instance
refuses the game and keeps hosting, and the browser — already admitted — warns and
keeps the default rather than refusing a match the server has accepted.

## Nothing is loaded from disk

`SCRIPTS` is a compiled-in table reached by name, as `NODE_TYPES` is for a node
type and `API_ROUTES` for a route. **A world names a behaviour; it never ships
one.**

That is not a style preference. A game server holds nothing that survives a game
and reads nothing off disk, which is what lets it be started in bulk from an image
and a token (`docs/server/README.md`). Evaluating TypeScript out of `WORLDS_ROOT`
would turn the worlds volume into an execution surface across the whole fleet.

## A client script cannot be authoritative

There are two context types, and a script half gets exactly one.

`ServerContext` has the verbs that change things: `setTeam`, `spawn`, `damage`,
`score`, `addPoints`, `setCounter`, `respawn`, `endMatch`, `publish`, `arm`,
`setLoadout`, `setClassChange`, `bots`, `actors`, `nav` and `send` — and four
reads the client has no equivalent of, `memory`, `state`, `zonesOf` and
`occupants`, because a browser knows where other players are only as late as its
last snapshot. `ClientContext` has **none of them** — only reads,
`say(alias)`, and `request(command)`, which is a question whose outcome arrives in
a later snapshot or not at all.

`say` is the one thing a client half _does_, and it is shaped so that it cannot
become anything else: **there is no position to give it.** A script may say
something out loud, and it may not make a noise somewhere. The sound is
`THREE.Audio` at the listener — no panner, no attenuation, no direction — on `ui`
or `voice` and on none of the three channels that belong to things which are
somewhere. So the loudest lie a cheated client script can tell is a sound in its
own browser.

So "validate server scripts so a client cannot cheat" is not a validator here, it
is a **missing vocabulary**: a cheated client script can only lie to itself,
because the words for lying to anyone else do not exist in its type. It is the
same shape `sim/` already uses — the simulation sees collision through
`CapsuleWorld` and never `collision/world.ts`, which is what keeps three.js out of
it. Here the narrow type is what keeps authority out of the browser.

It is enforced twice: by the types, and by `@3d/client` being unable to import a
server half.

## Determinism

A hook both ends run must be a pure function of what it is handed, for the reason
`resolveWeapon` must be: a client predicting and a server replaying have to get
identical values out of identical inputs, and a divergence here reads as a physics
bug rather than as a seeding bug.

- The clock is `GameView.now`, which is `tick / tickRate` — so a client three
  frames behind reads the same value for the same tick.
- Randomness is `GameView.seed` through `game/random.ts` (xorshift32, and the
  FNV-1a `hashString` that picks a body from a player id).
- **`Math.random` and `Date.now` are banned** over `packages/shared/src/game/**`
  by `eslint.config.js`. They are in `lib: ["ES2022"]`, so `types: []` does not
  catch them; this is the one rule the tsconfig cannot give.

`castFor` is the current example: same inputs, deep-equal cast, which is what lets
`pnpm dev` (no game server) dress its players exactly as a real match does.

## Two scripts talking

Point to point — `send(to, message)` and `receive(from, message)` — and
**server-only**.

Not a bus: a bus makes every script a dependency of every other with undefined
ordering. `SCRIPTS` declaration order is the order, so it is written down rather
than discovered. A `send` is delivered at the **end of the current hook** and never
re-entrantly, so a cycle is a queue that drains rather than a stack that overflows,
and the queue is capped per tick the way `Match` already caps its input queue.

Declared, not built.

## What is built

| Hook                  | State                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.cast`         | **Built.** `castFor` — the bodies a side may wear, the clips, the hands, the default weapon                                                                                                                                             |
| `server.init`         | **Built.** Once per match, as the match is built and before any other hook of that script: its return is `ctx.memory` on every server hook after                                                                                        |
| `server.playerSpawn`  | **Built**, and a deliberate no-op: the default gametype names no `spawnMode` and assigns no team, so `spawnPoints` widens to the `{ start: true }` `Spawns.place` already asks for. The capability is wired; the behaviour is unchanged |
| `server.combatRules`  | **Built.** Asked once at match start, merged over `DEFAULT_COMBAT_RULES`, and sent to every client in `joined`                                                                                                                          |
| `server.playerDamage` | **Built.** `Callback_PlayerDamage`: the last word before health moves, and where a hit is refused or re-priced                                                                                                                          |
| `server.playerDeath`  | **Built.** `Callback_PlayerKilled`, fired once on the tick health reached zero, with who did it and the cause                                                                                                                           |
| `server.classRules`   | **Built.** Asked once at match start, merged over `DEFAULT_CLASS_RULES`; `customClasses` reaches every client in `joined`                                                                                                               |
| `server.classChoice`  | **Built.** The last word on every class a player asks for, first choices included                                                                                                                                                       |
| `server.tick`         | **Built.** Once per tick, after health and before the physics step, and skipped while nobody is playing. A gametype's own clock                                                                                                         |
| `server.matchStart`   | **Built.** Once, on the match's first step, whether or not anybody is there yet. Where a gametype adds its bots                                                                                                                         |
| `server.playerJoin`   | **Built.** A player or a bot is in the roster and on a side, and not yet spawned: a side set here is the side spawned on                                                                                                                |
| `server.playerLeave`  | **Built.** A player or a bot is leaving the match: after a `triggerLeave` for everything they were in, and while `ctx.player(id)` still answers. Where a script lets go of what it keeps per player                                     |
| `server.botObjective` | **Built.** Asked each time a bot thinks: an answer replaces its objective. For a script that would rather look than remember                                                                                                            |
| `server.actorDamage`  | **Built.** The last word before an actor's health moves, as `playerDamage` is a player's                                                                                                                                                |
| `server.actorDeath`   | **Built.** Fired once, on the tick an actor's health reached zero, with who did it, the cause and where                                                                                                                                 |
| `server.publish`      | **Built.** An `Announcement` into the snapshot tail, to everybody, repeated for `ANNOUNCE_REPEAT_SECONDS`                                                                                                                               |
| `client.event`        | **Built.** Called in every browser for every announcement, with the side resolved back to a name and `say` to answer with                                                                                                               |
| `server.triggerEnter` | **Built.** A living player's feet entered a trigger this tick; once per entry, after health and before `tick`                                                                                                                           |
| `server.triggerLeave` | **Built.** Their feet left it, they died, or they left the match                                                                                                                                                                        |
| `server.interact`     | **Built.** The use key's rising edge, with the thing the server found in that player's focus                                                                                                                                            |
| `usable`              | **Built.** On the script itself, not a half: both ends ask it whether a thing can be used now and whether it must be looked at                                                                                                          |
| `client.prompt`       | **Built.** What the prompt says while a thing is in this browser's focus; `{key}` becomes the bound key                                                                                                                                 |
| everything else       | **Declared.** Each member names what would build it                                                                                                                                                                                     |

What is still declared after that: `receive`/`send` (nothing sends), and
`ClientContext.request` (the reliable `command` message it rides on is specified
with pickups).

## What a gametype says out loud

The audio design ([audio.md](audio.md#what-the-scripting-layer-gets)) splits sound
three ways, and **feedback is the scripting layer's** — because what a gametype
says out loud is most of what makes one gametype different from another. It is
also the only kind that needs a _delivered_ message, which is why this is where
the wire grew a field.

**A script says what happened, never which file.** `publish({ what: "flagTaken",
team })` is the whole of what crosses; the client half of that same script turns
it into an alias. A server naming a `.webm` would be a server that has to know
which bank a browser built, for which game, in which build.

**One broadcast, localised at each end.** `publish` has no recipient. An
announcement carries the side it is about, every client hears it, and each reads
that side against its own `ctx.self` — so "we have the flag" and "the enemy has
the flag" are one event rather than two addressed messages the server had to
split. One about a single player — who bought a door, who was refused — carries
that `player` too, read the same way: everybody is told, and the script says the
purchase only where `event.player` is `ctx.self`. A player who is not in the match
throws, as a side that does not exist does. The side travels as an **index** into the gametype's `teams`, as
`PlayerState.team` does, and is a name again by the time a script sees it.

**The retention is a death's argument taken further.** A kill feed line that never
arrives is contradicted by a scoreboard the player can open; "the enemy has the
flag" is contradicted by nothing. So an announcement is repeated for a second
against a death's half — affordable because it is the smallest event on the wire
(five bytes bare, fifteen with a name, a side and a number) and because the tail
gives up its _oldest_ first, so the kind held longest is the first dropped under
pressure rather than one crowding a death out. The reasoning in full is in
`net/messages/events.ts`.

**A malformed announcement throws**, as `setTeam` does for a side that does not
exist: a name that is empty or longer than the field carrying it, a side the
gametype has not got, a `value` that is not an integer the wire can hold. A
_flood_ does not — more than `MAX_ANNOUNCEMENTS_PER_TICK` in one tick is dropped
with one warning, because a throw there would take every other game on that
process's tick with it.

**An alias nothing exported fails twice, on purpose.** `pnpm catalog` resolves
every alias every script declares in `Script.sounds` against the sound banks that
were built and **exits non-zero** on one nothing holds — the same check, in the
same place, as a cast naming a file that is not on disk. At run time a browser
warns once per alias and plays nothing. Silence that looks like success is the
failure mode the whole audio layer is written against, so it is loud in
development and harmless in play.

**The worked example remembers nothing, because it needs nothing.**
`scripts/countdown.ts` counts a match in — five lines and a round sting, one per
second — and the whole schedule is a pure function of two numbers it is handed:
`ctx.now`, the match clock, and the earliest `PlayerView.since`, which is when
somebody first arrived. Nothing is remembered between ticks, so two runs of the
same match announce on the same ticks and a test can say so without a clock. What
that costs is written down where it happens: the first player leaving mid-count
re-anchors it. A clock that has to survive its own players keeps state instead
([below](#a-script-keeps-its-own-state)).

## A script keeps its own state

`server.init(ctx)` is asked once per match, as the match is built and before any
other hook of that script, and whatever it returns is handed back as
**`ctx.memory`** — the same object, on every server hook of that script, for the
life of the match. Two matches on one game server get one each. A script with no
`init` sees `memory` undefined. The context itself is one object per script for
the life of the match too, and reads the match live: `ctx.now` and `ctx.players`
on a context kept from an earlier hook are today's. `defineScript<S>` keeps the state's type inside
the script, so its hooks are typed against `ServerContext<S>` while the script
table holds plain `Script`s.

It is allowed because of where it lives, and the rule is that it stays there:

- **Server-only and never replicated.** A client half has no `memory` to read, so
  nothing both ends run can depend on it: `usable` and `prompt` still answer from
  `GameView` alone, and state a browser must agree on goes through the snapshot
  as a counter, points or a solid's presence.
- **Changed only inside hooks, and hooks are asked on ticks.** Two runs of one
  match change it on the same ticks in the same order, so determinism is kept as
  long as its randomness is too — a script that draws keeps a `seeded` rng in its
  state, seeded from `ctx.seed` in `init` (`game/random.ts`), and never
  `Math.random`, which the lint bans here anyway.
- **It is the script's, not the engine's.** What the engine acts on — a side, a
  bot's objective, a solid's presence, a class timing — the engine keeps, whoever
  asked for it; `memory` is for what only the script reads: a round, a phase, when
  the next spawn is due.

## Points, counters and the end of a game

Two kinds of number every client sees, and two verbs for a gametype that decides
for itself who comes back and when it ends.

- **Points** are a purse per player. A gametype that declares `points: true`
  gets `ctx.addPoints(id, delta)` and `ctx.points(id)`, and every end reads
  `PlayerView.points`. A spend that would go below zero throws — the price check is
  the script's, and a negative purse is one that was skipped — as does a fraction
  or a gametype without `points`. The purse stops at `MAX_POINTS` (2²⁰ − 1).
- **Counters** are the gametype's own match-wide numbers, named in its
  declaration's `counters` (at most `MAX_COUNTERS`, 15). The server sets one with
  `ctx.setCounter(name, value)` and both ends read it with
  `GameView.counter(name)`. A name not declared throws, and so does a value that
  is not an integer in ±2²³. They start at 0.
- **A side's score** is not one of them: `score(team, delta)` is still kept on the
  game server only ([below](#health-death-and-score)).

Points and counters travel in the snapshot as state, not as events — twenty bits
of points on every player, and the counters as a four-bit count and 24 bits each
— so a late joiner and a lost datagram converge on the next snapshot, and a HUD
needs no event to learn a round began ([ui](ui.md#points-and-counters)). A
gametype that declares neither pays four bits a snapshot for the empty count, and
twenty per player for a purse that stays 0.

**`respawnDelay: null`** in `CombatRules` means the engine never brings anybody
back: the dead stay dead, and a browser shows them waiting rather than counting
down. **`ctx.respawn(id)`** brings one back now, as the countdown would have — a
spawn from `playerSpawn`, full health, armed afresh — and returns false for
somebody alive or not here. It works with a number too, for a gametype that wants
both.

**`ctx.endMatch(reason)`** says the game is over. The game server stops hosting
it within a second — `Games` reports the ending as `over` and tells the api, which
returns its players to their lobby — and `reason` goes to the log. It is
idempotent, the match plays on until it is dropped, and nothing tells a client
why: `publish` first.

## Bots

A bot is a match member whose input a game server writes
([server](../server/README.md#navigation-and-bots)); a client sees it as a
player, and nothing on the wire changed for it. What decides that input is three
layers, each the only place its question is answered:

| Layer  | Decides                          | Vocabulary                                                                                                        | Where                            |
| ------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Script | What the bot is **for**          | `Objective`: `none`, `hunt {targets?}`, `goto {point \| node}`, `hold {point, radius}`, `follow {id}`             | `game/scripts/`, via `ctx.bots`  |
| Brain  | What it wants **now**            | `Goal`: `idle {look?}`, `look {point}`, `attack {target}`, `moveTo {point, run?, arrive?, look?, track?, route?}` | `game/bots/brains/`, in `BRAINS` |
| Motor  | The **input** that gets it there | `PlayerInput`, and a status: `idle`, `moving`, `arrived`, `noPath`, `stuck`                                       | `game/bots/motor.ts`             |

The split is what lets bots grow into objective-driven players per gametype
without any layer knowing about the others' vocabulary: a capture-the-flag
script orders `goto` the flag and `follow` its carrier, a brain for that mode
decides when to break off and fight, and neither cares how a ladder is climbed.

### What a script has

- **`ctx.bots.add({ brain, team?, objective?, params? })`** adds one and returns
  its id (`#b` and a count, never reused). It joins as a player does:
  `playerJoin`, a side (the one named, else the balancing default), a spawn from
  `playerSpawn`, the gametype's weapon. A brain or a side nobody declared throws.
  `remove(id)`, `ids()` in the order they were added, and
  **`order(id, objective | null)`**, which the engine keeps (the brain reads it
  there) and which makes the bot think at once. Null is `none`, which each brain
  reads as its own instinct.
- **`botObjective(ctx, bot)`**, the hook, for a script that would rather answer
  from what it sees each time a bot thinks than remember what it ordered. An
  answer replaces the objective; nothing leaves it.
- **`ctx.state(id)`**: feet, yaw, alive, health and side, as a copy. On
  `ServerContext` and not on `GameView`, because a hook both ends run must not
  read positions: a browser has them only as of its last snapshot.
- **`ctx.world.setPresent(tagOrName, on)`** removes (false) or restores (true)
  every `solid` with that name or tag, and `ctx.world.isPresent` reads it. The
  change is queued and applied at the end of the tick, in one fixed order: the
  match's collision view (which reads the presence, so a capsule and a bullet
  pass on the next tick), the physics colliders, the part's navigation blocker
  (so bots replan), and the snapshot's presence bits, which every client adopts
  to hide the meshes and follow in its own collision and physics. A name or tag
  no solid carries throws; so does restoring a solid a living player stands in,
  since pushing them out is not built. The engine keeps the presence, as it keeps
  an objective, because the engine is what acts on it. A gametype's `mode` seeds it
  (`presenceFor`), so a solid carrying `mode:` starts absent outside those modes.
- **`ctx.nav`**: `ready`, `nearestNode(point, maxDy?)`, and the blockers of
  [navigation](navigation.md#a-matchs-state) — `addBlocker(id, box | {links}, on?)`
  and `setBlocked(id, on)`. Doors will use the same two. A blocker added before
  the world's graph is baked is kept and applied the moment it is.
- **`PlayerView.bot`**, on both ends (a bot's id says so), so any hook can tell
  a bot from a person. `countdown` counts people only.

**`matchStart` is not gated on people; `tick` still is.** A match exists from
the moment its game is ordered, seconds before anybody has loaded the map, and
`matchStart` fires on its first step, so a gametype's bots are on the map
before the first player arrives rather than appearing around them. `tick` stays
skipped in a room with nobody in it, since there is still nobody to announce
anything to, and a room of bots is empty. A bot thinks, and `botObjective` is
asked, whether or not there are people.

**Sides.** The default side still balances by head count, bots included. A
gametype whose sides are bots-versus-people puts them there itself: `chase` adds
its horde with `team: "horde"` and puts every person on the survivors in
`playerJoin`. A mode that fills empty seats with bots would balance differently
— by people first, bots making up the difference — and would say so in its own
`playerJoin`.

### Brains

A brain is `{ id, period?, init(self, rng, params), think(ctx, self, memory) }`
(`game/bots/brain.ts`):

- **`period`** is seconds between thinks, rounded to whole ticks, and each bot is
  offset by its index so a match's bots spread over the ticks. A bot also thinks
  at once when it spawns and when it is ordered. Between thinks the motor carries
  the last goal out every tick.
- **`init`** makes one bot's memory, on its first think. **Memory is
  server-only**: nothing a brain remembers is replicated.
- **`think`** returns the goal. It is handed a `BrainContext` — the `GameView`,
  `state(id)` and the graph (`nav.route(from, to)`, `nearestNode`, `nodeFeet`) —
  which has **no verbs**: a brain changes nothing but its own goal and memory.
  `self` is the bot's id, index, side, objective, movement and the motor's last
  status, which is how a brain hears that a goal failed.

A brain may ask for a route to decide between targets and hand it over in
`moveTo.route`, so the motor does not plan the same path twice. `track` keeps the
point on a player's feet between thinks, which is what a chase needs.

**Determinism.** Two runs of one match must play out the same (tested on dome).
A bot's `rng` is ``seeded(hashString(`${seed}:${id}`))``; its clock is `ctx.now`;
thinks are scheduled by tick; bots are asked in the order they were added; and
ties are broken by roster order. `Math.random` and `Date.now` are banned here as
over the rest of `game/`.

**Server-only, by lint.** The api and the client may not import
`game/bots/**` (`eslint.config.js`). A script names a brain by id for this
reason: the script table is imported by the browser, and a value import of a
brain would pull the motor and the brains into its bundle.

**Seeing where one can go.** `K` in a development build draws the graph the
motor plans over, baked in the browser from the same file and collision, with the
reason for every link it will not take ([debugging](debugging.md#navigation)).

**Writing one.** A file in `game/bots/brains/` exporting `defineBrain<Memory>({ … })`,
one line in `BRAINS` (`game/bots/registry.ts`), and a test in
`packages/shared/tests/game/bots.test.ts` that drives it with a `BotDriver` over a
made-up graph. It should give every objective a meaning, since a script may
order any bot anything, and read `self.motor.status` to notice a goal it cannot
reach.

### The first brain, and the first gametype with bots

**`seek-nearest`** is a zombie's. Every half second it lists the living players
it hunts — every opponent, or the `hunt` objective's targets — nearest first in a
straight line, and asks for a route to each of the first three; the first it can
reach is its quarry, tracked to within 1.5 m, where it stops and faces them. With
nobody reachable it stands still. A quarry the motor reported `noPath` or
`stuck` on is passed over for three seconds. It never fires, so it deals no
damage. `goto` and `hold` are places and `follow` is a chase that stops 2.5 m off.

**`zombie`** is the seeker with a blow, written for actors: four times a second,
a living player it is hunting within `reach` of its feet (and a metre up or down)
is `attack`ed; anyone further is chased as the seeker chases, stopping at 0.7 of
the reach so the chase ends in range. `params.reach` is the actor's kind's, and
`params.run: false` makes a walker. The motor stands and faces for `attack`; the
blow itself is the actor runtime's ([actors](actors.md#a-tick)), so a bot given
this brain stands in front of its quarry and hits nothing.

**`chase`** (`gametypes/chase.ts`, `scripts/chase.ts`): survivors and a horde,
on team deathmatch's spawns so each side starts at its own end. `matchStart` adds
eight `seek-nearest` bots to the horde. Its `games:` names only the games whose
worlds carry navigation so far, and widens as each game's exporter lands
([cod/navigation.md](../cod/navigation.md)). A
private lobby's host picks it with **Mode** in the lobby, which cycles through
`GAMETYPES`, past any whose `maps` leave the lobby's map out (`admitsMap`); on a
map of another game the instance refuses the game.

## Actors

A creature a script spawns that is not a player ([actors](actors.md) has why, and
the runtime). A script has:

- **`ctx.actors.spawn({ kind, at, look?, brain, objective?, params?, health?, gait? })`**,
  which returns its id: counting up from 1, never reused in a match. `kind` names a
  row of `ACTOR_KINDS` and `brain` one of `BRAINS`; either unknown throws. `at` is
  where its feet go and `look` a point to face. `health` overrides the kind's,
  which is how a gametype prices a round. `params` reach the brain over the kind's
  own `reach`. `gait` is `walk` (the default), `run` or `sprint`: which clip it
  moves in, and so how fast ([actors](actors.md#gait)).
- **`Script.actors`**, declared beside `sounds`: every kind the script may spawn.
  A browser loads the creatures of these kinds only, so a kind spawned and not
  declared is drawn as its capsule. What it sounds like is the kind's, not the
  script's ([actors](actors.md#its-sound)).
- **`remove(id)`** takes one out at once, dead or alive; **`order(id, objective)`**
  (or null) as for a bot; **`damage(id, amount, by, cause?)`**, queued like
  `ctx.damage`; **`ids()`** in spawn order, the dead still lying included; and
  **`state(id)`**: kind, feet, yaw, alive and health, as a copy.
- **`actorDamage(ctx, actor, amount, by, location, cause)`**, the hook: the last
  word on a hit, returning a `DamageVerdict` like `playerDamage`. A refused hit
  draws the shooter no marker.
- **`actorDeath(ctx, actor, by, cause, location)`**, once per death. The actor then
  lies for its kind's `corpse` seconds and is taken out, unless `remove` takes it
  first.

A blow an actor lands on a player is `melee`, **by nobody** — `by` is null, and
the actor is `DamageEvent.actor` beside it, which `playerDeath` is handed as its
fifth argument. A kill is therefore nobody's kill as far as the engine's scoring
goes; what one is worth is the gametype's to say.

`GameView` carries no actors: a hook both ends run must not read positions, and a
count alone has not been needed.

## Areas and the use key

A world says only where its volumes are and which can be used, and how they are
reached (`use: near | touch`, [AUTHORING](../../worlds/AUTHORING.md#trigger-name-top-level-or-inside-a-group-optional-name)).
What being in one means, and what using one costs or does, is the gametype's.
There are two questions, and the engine answers both.

**Occupancy: whose feet are in which trigger.** Every trigger, `use` or not,
because an area and a flag need nothing more. A game server tests each living
player's feet against the triggers its mode admits once a tick
(`game-server/src/occupancy.ts`, over `inside` in `game/volumes.ts`), after
health and before `tick`, and tells every script what changed: `triggerLeave`
then `triggerEnter`, player by player in roster order. A player who dies leaves
everything they were in, and so does one who leaves the match: a `triggerLeave`
for each, then `playerLeave`, while `ctx.player(id)` still answers.
`ctx.zonesOf(id)` is the tags of the triggers they are in — an area is every
trigger sharing a tag — and `ctx.occupants(tag)` who is in any trigger carrying
one. Actors have no occupancy: nothing has asked where one is.

**Focus: what the use key would reach.** One pure function,
`focusOf` in `game/focus.ts`, that both ends run on the same inputs: a browser
every frame from its predicted player, for the prompt, and a game server from
the input's view angles on the key's rising edge. The candidates are the
triggers with `use` in this mode and the present solids with `use`
(`usableThings`). A `touch` thing needs the player's body to overlap it; a
`near` one needs the eye within reach of its centre — being inside is not
needed — and a clear trace to it through the match's collision view, so a part a
script has removed no longer blocks. Where several qualify a score ranks them:
nearer the crosshair, then nearer. The numbers are Call of Duty's
([cod/reference](../cod/reference.md#the-use-rule)) and live in one place,
`USE_RULE`.

**`usable(view, thing, player)`** is the script's say in that, and it sits on the
`Script` rather than on either half because both ends run it: null for "not now"
(nothing in focus, no prompt), `{ look: true }` for a thing that must be looked
at as well as reached, and nothing for no opinion, which is usable from any
angle. It is handed a `GameView`, so it may read `view.isPresent` — the solids as
the last tick left them, the snapshot's bits in a browser — and the roster and
clock, and nothing either end would disagree about.

**`interact(ctx, thing, player)`** is what a press does, and it is everything a
press does: a price, spending it, `ctx.world.setPresent(thing.target, false)`. It
is asked once per press — the key is a level on the wire and the server takes
its edge, so holding it or a re-sent input presses nothing twice — after every
input of the tick is spent, and only for the thing the **server's** focus found.
Nothing on the wire names a thing; a client that wanted to use something out of
reach would have to move its player there, and the server replays that.

**`prompt(ctx, thing)`** is the client half's: what the browser shows while a
thing is in focus, with `{key}` where the bound key's name goes, or null for
nothing. No prompt text crosses the wire, so a price shown and a price charged
agree only if both halves read it from one pure function in the script module —
which is the reason `usable` is not a half either. With no script to ask, a
usable thing says "Press {key} to use" ([ui](ui.md#the-use-prompt)).

## Health, death and score

The shape is Call of Duty's rather than an analogy of it. **The engine owns the
field, the trace and the arithmetic; a script owns the numbers.**

`CombatRules` (`game/rules.ts`) is those numbers — `maxHealth`, `regenDelay`,
`regenRate`, `friendlyFire`, `respawnDelay`, `damageScale` — and `shotDamage`
beside it is the arithmetic: the weapon's own falloff over `damage.maxRange` to
`minRange` (in **CoD units**, 39.37 to the metre), times `locationDamage[location]`,
times the gametype's scale. A weapon whose file declared no ballistics gets an
ordinary rifle's 30 rather than nothing, because every field of `WeaponDef.damage`
is optional and zero is a gun that fires and never hurts anybody.

Two things about it are load-bearing:

- **`damage()` is a queue, never a stack.** A hook that damages somebody, whose
  death hook damages a third, drains one at a time after the current hook returns.
  It is the rule `send` was specified with before either existed, and the reason it
  was written down there.
- **A side's score is the server's alone.** `score(team, delta)` is kept on the
  game server and not sent, because nothing reads it yet; a free-for-all has no
  side for it at all. A number per player is `addPoints`
  ([below](#points-counters-and-the-end-of-a-game)), for a gametype that
  declares `points`.

**Every hit and every death has a cause** (`game/damage.ts`) — `bullet`,
`outOfWorld`, `fall`, `explosion`, `melee` (an actor's blow), or `script` for a
script's `damage` that named none. The cause says _how_; who is responsible is a separate field, because the
two vary independently: a grenade is an explosion whoever threw it, and a fall is
nobody's. A death nobody else earned — `by` null, or the victim themselves — is a
**suicide** (`isSuicide`), scores nobody a point, and reaches the kill feed as the
victim and how ("fell out of the world"). A neutral car's blast is a script's
`damage(id, n, null, "explosion")`; a player's own grenade names them as `by`.

`fall` and `explosion` are declared and nothing deals them yet. `outOfWorld` is
built: passing a world's kill plane in a match is a death rather than the
teleport back to the spawn a world walked offline gets
([player](player.md#state-for-the-network)). It is **past a script's say** —
`playerDamage` is not asked, because a player it refused would hang under the map
for the rest of the match — and it leaves no corpse, since nobody is down there
to see one fall. `playerDeath` still hears it.

## Classes in a match

A player chooses a class in the match, not before it, and the game server holds
them to it; a gametype says how. Everything here is enforced by `Match` and
nothing by the client, which only says which of its classes it wants, by number.

`ClassRules` (`game/classes.ts`), asked once through `classRules`:

- **`customClasses`** — false and nobody chooses: the class menu is not offered,
  a player spawns on joining, and every choice is refused. They carry what a
  script arms them with, or the gametype's default weapon.
- **`grace`** — seconds after a spawn in which a change takes effect at once.
  Call of Duty's rule for a player who picked wrong and noticed as they landed.
- **`change`** — what a change past the grace does: `now`, `nextSpawn` or
  `refuse`. A change made while dead is always `nextSpawn`, the soonest there is.

Per player, a script says more:

- **`setClassChange(id, timing)`** — `now` lets this player change ad hoc,
  `refuse` stops them; `null` hands them back to the rules. The engine keeps it,
  since the engine applies it.
- **`classChoice(ctx, request)`** — the hook, and the last word on every request,
  the first one included. It is told what the engine would do (`request.timing`)
  and may change it. A refused first choice still spawns the player, as one with
  no class.
- **`arm(id, weapons)`** — these weapons in hand now, mid-life, or at their next
  spawn if they are dead. Once: the spawn after that arms their class again.
- **`setLoadout(id, weapons)`** — what they spawn with from now on instead of
  their class, until `null`. Their choices still count, and are what they get
  back.

A script's weapons are any weapons: no game or slot rule applies, because a
script handing out a rocket launcher as a primary means it. A weapon the
instance's catalogue does not hold, or an attachment it does not offer, throws.

**None of it can desync.** A snapshot carries both of a player's weapons and
`armed`, a count of the times the server handed them weapons, so a client sees
every re-arm as a new count and rebuilds both from what the server says
([player](player.md#state-for-the-network)) — it never predicts a change, and a
choice sent twice re-arms nobody.

## Teams are state now, and the verb is not

`PlayerState.team` carries a side as an **index into the gametype's `teams`** —
three bits against a name's ~48, resolvable because both ends already hold the
same `GametypeDecl`. `Match.join` assigns the smallest side, earliest on a tie:
deterministic, so a test can assert it and two runs of the same joins agree.

Two things follow that are worth knowing before building on it:

- **`ServerContext.setTeam` moves the side and nothing else.** Where they respawn
  follows on their next death, since `playerSpawn` is asked then; what they are
  wearing does not follow at all, because a body is chosen once at join and a
  bullet is traced against that skeleton.
- **Nothing dresses or arms by side yet, on purpose.** `Match.castFor` is called
  with no team and `WorldSession` passes `undefined`, so both ends resolve the
  same cast. Narrowing on one end only would put a different body on a peer than
  the body the server thinks they are wearing — and since a bullet is traced
  against a posed skeleton, that is a hit box in the wrong place, not a wardrobe
  bug. The gametype has to reach the browser in `joined` first.

`castFor` returns `undefined` — and the caller draws capsules — for a
hand-written world (no `game:`), a game with no catalogue built, or a catalogue
missing that game's clips or hands. Narrowing by side is deliberately inexact, for
the reason `spawnPoints` widens a spawn query: Ghosts' two rangers carry no faction
at all, so asking for `allies` there falls back to every body rather than to
nothing.

## Two things to know before building on this

**A world id means something on the wire only because the join checks the
world.** `ResolvedObject.id` is a positional dense ordinal, and so is a solid's
bit in the snapshot's presence bitset, so two ends holding different world text
would address different things by the same number and say nothing. `join`
carries `worldHash` (`worlds/hash.ts`: every id-bearing node's id, name, tags and
what it is, in order) and a game server refuses a join whose hash is not its
own, as it refuses a stale weapon catalogue. The presence bits are the first
thing to rely on it; an `EntityId` may go on the wire on the same terms. A
script still reaches the world through `GameView.world`, built locally on each
end.

**A body has one specific weapon's joints baked into it.**
`scripts/cod/characters.py` grafts the joint tree of whichever gun the viewmodel
stage chose, so a peer holds _that_ gun and not the one their loadout names, until
run-time joint grafting exists. Each catalogue character records `bakedWeapon` so
there is something to check against when it does.
