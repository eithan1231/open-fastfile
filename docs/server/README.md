# The two servers

`@3d/api` is the authority. `@3d/game-server` hosts the games it is given, on
whatever maps those games are on, and there are many of them.

```
                    browser (@3d/client)
                   /                    \
      worlds, assets,                    inputs, snapshots
      the bundle, /api/*                 (WebRTC data channel)
                 /                        \
          @3d/api  <-- worlds, /api/* --  @3d/game-server  x N
          (one)     --  orders (SSE)  -->     (many)
             |
        worlds/ on a volume, SQLite
```

The split is a deployment fact, not a layering one. One process owns state that
outlives a request — `worlds/` on disk, users in SQLite — and is the only thing
that needs a volume. The others own a match: they hold nothing that survives it,
read nothing off disk, and so can be started in bulk from an image, an `API_URL`
and a token. `eslint.config.js` enforces that they never import each other; they
talk over HTTP, and the day one of them reaches past that for a convenience is
the day the split stops being real.

## What the api serves

| Route                                             | Declared in                      | Who calls it                              |
| ------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| `GET /worlds-manifest.json`                       | `protocol/routes/worlds.ts`      | the client's menu                         |
| `GET /worlds/<slug>.json`                         | `protocol/routes/worlds.ts`      | client and game server                    |
| `GET /worlds/<slug>/<relPath>`                    | `protocol/routes/worlds.ts`      | client and game server                    |
| `GET /api/health`                                 | `protocol/routes/health.ts`      | anyone; a game server at boot             |
| `GET /api/catalog`                                | `protocol/routes/catalog.ts`     | client and game server, at boot           |
| `GET /api/catalog/<kind>/<game>/<id>/<file>`      | `protocol/routes/catalog.ts`     | the client, when a weapon is drawn        |
| `POST /api/auth/register` · `login` · `logout`    | `protocol/routes/auth.ts`        | the client's sign-in screen               |
| `GET /api/auth/me`                                | `protocol/routes/auth.ts`        | the client, at boot                       |
| `GET /api/loadouts`                               | `protocol/routes/loadouts.ts`    | the client, at sign-in                    |
| `POST /api/loadouts/<i>[/select]`                 | `protocol/routes/loadouts.ts`    | Create a Class; the in-match class menu   |
| `GET /api/events`                                 | `protocol/routes/matchmaking.ts` | the client, as an `EventSource`           |
| `POST /api/matchmaking/queue[/leave]`             | `protocol/routes/matchmaking.ts` | the client, on Find Game                  |
| `POST /api/lobbies[/:code/join\|map\|start\|end]` | `protocol/routes/matchmaking.ts` | the client, for a private match           |
| `POST /api/lobbies/leave`                         | `protocol/routes/matchmaking.ts` | the client, leaving any lobby             |
| `GET /api/servers`                                | `protocol/routes/servers.ts`     | the matchmaker only — see below           |
| `POST /internal/game-servers/heartbeat`           | `protocol/routes/servers.ts`     | a game server, with its token             |
| `GET /internal/game-servers/<id>/events`          | `protocol/routes/games.ts`       | a game server: its orders                 |
| `POST /internal/games/<id>/ready` · `report`      | `protocol/routes/games.ts`       | a game server, about one game             |
| `GET /*`                                          | `api/src/routes/client.ts`       | the built client, if `CLIENT_DIST` is set |

All three loadout routes answer with **all five classes and the chosen index**,
not with the part that changed. A save is reconciled against the catalogue and
can come back without the attachment it was sent with (`src/loadouts.ts`), and
there is no second call to discover that.

`/api/servers` used to be public, because a browser picked its own match by
world. It does not any more: a player is handed the one server their game is on,
in a `matchReady` event, so enumerating the fleet is the matchmaker's business
and nobody else's.

## How a route is declared

Every row above except the last is one `defineRoute` in
`@3d/shared/protocol/routes/`, and both ends are built from it. A declaration
carries the method, the path, who may call it, a schema for the path params, one
for the request body and one for the response. `protocol/api.ts` names them all
in `API_ROUTES`; `protocol/route.ts` is the mechanism and knows no route of this
api at all. It is the same three-layer split as `shared/src/net/`.

What each end gets from that:

- **The client** is `createApiClient(...)` — a method per table entry, which
  builds the URL, sends the body and **parses the response against the schema**.
  An api that has drifted fails at the boundary naming the field, rather than
  three layers deeper as an `undefined`.
- **The api** mounts each one with `Mount.route` (`api/src/routes/mount.ts`),
  which applies the service token to a `service` route, resolves the session on a
  `user` one, parses the path params, 404s a URL the contract cannot name, 400s a
  body that does not validate, and leaves the handler to answer the question and
  nothing else.

Adding a route is therefore: declare it under `routes/`, add a line to
`API_ROUTES`, and mount it in the `RouteGroup` for its area
(`api/src/routes/`) — or a new group, registered in `api/src/app.ts`. The third step is not optional — `api/tests/routeTable.test.ts`
is keyed by the table, so an unmounted route fails to compile.

**An event stream is declared too, but has no client method.** `events(schema)`
is a third result kind beside `json` and `bytes`, and `createRouteClient` removes
those keys from the generated client entirely: a request/response method for a
stream would buffer until the stream closed, which is never. What both ends share
is the schema, not the transport — the api writes with `streamSSE`
(`api/src/events.ts`), the browser reads with `EventSource`
(`client/src/net/events.ts`), and the game server reads with `fetch` plus its own
frame parser (`game-server/src/net/sse.ts`), because it has to send a token and
`EventSource` cannot. Nothing about this reaches `@3d/shared`'s
`platform.d.ts`, and adding `body` to `HttpResponse` would undo that.

Three details that look like they could be tidier and cannot:

- **The schemas are `zod/mini`, not `zod`.** A route's schemas are built at module
  load, so the client cannot tree-shake away the ones it never calls: classic zod
  put +24 KB gzip in the browser bundle, and mini does the same checks for +6 KB
  (measured, both). That is why a constraint is spelled
  `z.string().check(z.minLength(1))` here. Mini's failures name the field but not
  the expected type — its detailed messages are in a locale that costs 75 KB gzip
  to load — so a check whose message is worth reading passes its own `error:`.

- **Path params are strings in both directions**, and a params schema refuses a
  value rather than converting one. A route that wants a number declares
  `z.string().regex(...)` and its handler converts, which keeps one type for
  `:page` at both ends.
- **`matchRoutePath` parses the params, not Hono.** Hono captures neither a param
  with a literal suffix (`:slug.json`) nor `*`, and it matches `/worlds/:slug.json`
  against `/worlds/anything` besides. The pattern registered with it is only wide
  enough to reach the handler; what a path _means_ stays in the declaration.
- **It also decodes them, once more than the host router has.** That is what turns
  `%2e%2e%2f` into `../` — the form an encoded traversal actually arrives in, and
  the only form a path guard can refuse. See "A slug is not a path" below.

### A slug is not a path

Three of the api's routes end up joining a piece of a URL to `WORLDS_ROOT`, which
is the whole of its directory-traversal surface. It is closed in one place rather
than guarded at each of them, because a guard at each of them is a guard somebody
adds a fourth route without:

1. **The contract says what a slug and an asset path _are_**
   (`protocol/routes/worlds.ts`), as allowlists rather than lists of refusals. A
   list of refusals has to enumerate every escape — `..`, a backslash, a NUL, an
   encoding that survives one decode, a unicode lookalike — and is wrong the first
   time one is missed. `mount.ts` answers 404 when a URL fails them, and
   `src/worlds/paths.ts` applies the same schemas again at the filesystem.
2. **`src/worlds/paths.ts` is the only module that joins one to a path**, and it
   proves the result: the _real_ path, symlinks resolved, must still be inside the
   directory it was built from. That is what catches a symlink planted inside a
   world, which no amount of string checking can. A symlinked world _folder_ stays
   allowed — that is the operator's own layout, and its real path becomes the base
   everything inside it is measured against.
3. **ESLint keeps the rest of `@3d/api` away from `node:fs` and `node:path`**, so
   there is nowhere else a path can be built. The exceptions are the paths that
   come from the environment rather than from a request: `config.ts`, `db/`, and
   `routes/client.ts`.

The two checks are independent on purpose, and each is tested where it lives:
deleting either one fails a test of its own rather than being covered by the
other. The refusals are tested directly (`tests/paths.test.ts`) because a route
test cannot pose them — `/worlds/w/../../etc/passwd` never reaches a handler at
all, since URL parsing collapses the dot segments first, so such a test passes
whether the guard works or not. The encoded form is the one that arrives, and
`tests/worlds.test.ts` covers it.

Everything under `src/worlds/` is async (`node:fs/promises`). One api process
serves every world's text and every asset of an imported map, so a synchronous
read there is the event loop waiting on a disk. `createReadStream` is the
exception that proves it: a stream is already the asynchronous form, and it is
what keeps a 40 MB `.glb` off the heap.

In dev, Vite proxies all of these to the api rather than serving worlds itself.
That is deliberate: there used to be two implementations of the world routes, one
for dev and one for production, and a comment asking them to agree. Now a
developer and a deployed client hit the same code. The consequences to know:
**`pnpm dev` starts two processes**, and `pnpm preview` and `pnpm shots` need
`pnpm dev:api` beside them — `dist/` carries no manifest, no sources and no
assets.

## Matchmaking

The api decides who plays what, where. A game server is told.

### A lobby's three states

```
open, no startsAt    waiting for enough people
open, startsAt       counting down; the map is settled and on screen
closed               its game is running
```

A **private** lobby opens with no map at all: its host chooses one from inside it
(`POST /api/lobbies/<code>/map`), so that everybody already there watches the
choice being made rather than arriving at whatever was decided before they were
invited. `startLobby` refuses a lobby with no map.

**Host commands are a private lobby's, and only while it waits.** Map, gametype
and start all pass one guard (`Matchmaker.hostCommand`): the lobby exists, the
caller is its host, it is private, and it is neither counting down nor closed —
everyone has seen what they are about to load, and swapping it underneath them is
worse than making them wait. `end` passes the same guard minus the last clause. A
public lobby's "host" is only whoever the queue put there first, and its map,
rules and start are the playlist's. A map is a `worldSlug` at the route and a
world in the manifest at the matchmaker, and is checked against the gametype
(`admitsMap`) wherever either one is set, at creation included.

A game ending puts the lobby back to `open` **with the same people in it**, so
the countdown arms again on the next tick. A lobby is a room you stay in, not a
queue artifact that is consumed — which is why nothing clears its membership
except someone leaving.

**A private lobby's host can stop it** (`POST /api/lobbies/<code>/end`): a
countdown goes back to waiting with its map kept, and a running game ends for
everyone in it — the instance is sent `gameEnd` and the lobby reopens exactly as
a report would reopen it. That is how a private match changes map between rounds.
A host who leaves hands the lobby to whoever has been in it longest, because a
private lobby only its host can start is otherwise a room nobody can use.

**Leaving a match is leaving its lobby.** The client's Leave Game calls
`/api/lobbies/leave`; a player who went to the menu while still a member would be
counted in a game they had left, and pulled back to the lobby — or into a public
lobby's next round — when it ended. The same goes the other way: a `left` event
the client did not ask for takes it out of whatever match it was in.

An invite is the page's own URL with `?join=<code>` (`client/src/app/invite.ts`).
It is read once at boot and taken off the address bar, so a reload does not
join again.

`matchmaker.tick()` runs every `MATCHMAKING_INTERVAL_MS` and does one pass:

1. Each queued player joins an open public lobby with room, or opens one.
2. A lobby at `LOBBY_MIN_PLAYERS` with no countdown **arms** one: it picks a map
   from `MATCHMAKING_MAPS`, reserves an instance with room — preferring one that
   already has that map loaded — and sets `startsAt`. Room is
   `matchmaking/placement.ts`'s: an instance's games are the larger of what its
   heartbeat reports and the lobbies this api has ordered onto it, plus the
   lobbies counting down on it, against the `maxGames` it heartbeats — and its
   players the same way against `maxPlayers`, the lobby's own included. A
   heartbeat alone is ten seconds stale and would hand every lobby armed in one
   tick the same slot. The map is settled here
   rather than at the end so that players see it for the whole thirty seconds.
   The whole playlist is always available, because any instance can load any map;
   what can block a countdown is a fleet with no room, which is a degradation and
   not an error.
3. A countdown that has run out **commits**: a `games` row as `starting`, the
   lobby `closed`, and a `gameCreate` down that instance's stream. The reserved
   instance is checked again first — live, and still with room — and the game is
   placed afresh, or the countdown disarmed, if it is not.
4. A lobby that drops below the minimum **disarms** and forgets the map.
5. `POST /internal/games/<id>/report` **reopens** the lobby. A report of
   `{ status: "refused" }` is an instance that would not host the game (full, a
   map that would not load, a gametype it does not know, a game that threw): the
   lobby reopens at once rather than at the ready timeout, and that instance is
   passed over for that lobby for 30 s. So do a private
   host ending it, and the pass noticing that the game's instance has stopped
   heartbeating (a crashed instance reports nothing, and a closed lobby can be
   neither joined nor started). Those are the only paths back to the lobby
   screen: a client does not get to decide a game is over because its data
   channel dropped.

A private lobby is never filled by the queue and never arms itself; its host
starts it, however few people are in it. That is the difference between an invite
and a queue. Its code is six unambiguous characters because it is read aloud.

### Who holds what

**In memory**, in the api, and so true of one api process: the queue, the
lobbies, and the registry of live game servers. Deliberately — a lobby whose
players all disconnected while the api restarted is not state worth recovering.

**In SQLite**: users, sessions, and the games that were played. Migrations run on
open (`api/src/db/database.ts`), so a fresh clone needs no setup and a `dbPath`
of `:memory:` hands a test a database that already has its tables. A password is
argon2id (`api/src/auth/passwords.ts`), which carries the parameters it was
hashed with, so raising them later does not invalidate a row.

**Presence is the event stream.** A browser gives no other liveness signal, so a
player with no open stream for `LOBBY_PRESENCE_TIMEOUT_MS` is dropped from their
lobby. Without that, a closed tab stands in the roster forever.

<a id="one-tab-per-player"></a>**One stream per player.** Opening `/api/events`
displaces any stream that player already had: the old one is sent `displaced`
and closed, and its client stands down — out of its world and its match, onto a
screen whose Play Here opens a stream again and so displaces the other in turn.
Two tabs of one player would otherwise both follow every `matchReady` into the
same seat, and the game server, which lets a second socket for a seated player
replace the first, would hand it back and forth. So seeing two players needs two
_players_: a second browser or a private window, signed in as someone else.

### Two events, both full snapshots

`/api/events` opens with the player's whole lobby and `/internal/game-servers/<id>/events`
opens with every game that instance should be running. Never deltas:
`EventSource` reconnects on its own and nothing replays what was missed, so a
leading snapshot is what makes a reconnect self-healing.

"Whole" includes the game. A player whose lobby's game is standing is sent its
`matchReady` again right after the lobby, so a tab reloaded mid-match goes
straight back into it; the client ignores a repeat of a game it is already in.
Every member of a closed lobby is on its game's roster, since a closed lobby
cannot be joined, so the ticket is always one the instance admits.

An instance treats `hello` as the whole list both ways: it stands up what is on
it and drops what is not — a game the api ended while the stream was down, or
every game, after the api restarted and forgot its lobbies. It never stands up a
game it has already ended, because a `hello` sent before its report landed still
names it.

`startsAt` is an **absolute instant**, not a remaining count, so the client ticks
its own countdown off one event instead of the api pushing one a second to
everyone in every lobby.

**`/api/events` is declared `public`, not `user`.** `EventSource` reports a 401
as an `error` with no status — indistinguishable from a dropped connection — and
then reconnects forever, so an expired session would become a 401 flood nobody
could see. The handler resolves the cookie itself and answers an in-band
`unauthenticated` event, which the reader can act on by closing the stream.

### The session is a cookie

HttpOnly, `SameSite=Lax`, argon2id-hashed passwords, rows in `sessions` so that
signing out and revoking are one operation. A cookie rather than a bearer token
for one concrete reason: `EventSource` can send no headers, and the event stream
is the whole point of being signed in. Same-origin `fetch` sends it with no help,
so `RouteClientOptions` needed nothing new.

## Both servers start and stop the same way

Every long-lived piece of either process is a `LoopBase`
(`@3d/shared/lifecycle/loop.ts`): it starts, does a pass on a period, and stops
without leaving a timer holding the process open. A game server's tick,
heartbeat, orders stream, housekeeping and navigation baker are each one; so is
the api's matchmaking pass. `start()` resolves once the loop is really running and `stop()`
once it has drained, so a shutdown is the same operation on each and neither
`index.ts` knows what any of them do — and because the delay is _awaited_ rather
than scheduled, a pass that overruns costs period rather than queueing another
behind itself. `FixedRateLoop` is the exception for the one case where the period
is a contract: the simulation tick, which every client accumulates against.

Both processes are wired with **tsyringe**. Everything that outlives a request is
a `@singleton()`, resolved once at the root — `ApiServer` and `GameServer`
respectively — which is what lets a test resolve the same graph against an
in-memory database. **Name every injected dependency with `@inject(Thing)`**:
`tsx` runs both processes and esbuild under it ignores `emitDecoratorMetadata`,
so an inferred parameter type never reaches the container. It typechecks, the
unit tests pass, and the process dies on its first resolve. `tests/container.test.ts`
in each package is the guard.

## Booting a game server

In order, because each step needs the one before:

1. **Config.** A missing `SERVICE_TOKEN` is fatal in production; in dev both ends
   fall back to a fixed token and say so loudly.
2. **Wait for the api** (`/api/health`), retrying with backoff, then giving up
   rather than sitting there looking healthy.
3. **Load its world** through the worlds URLs.
4. **Build collision** from the world's `collision.glb`, fetched the same way. A
   world that installs nothing is **refused**: this process corrects players, and
   a correction computed against no geometry puts one under the map and keeps
   them there. It used to be a warning — see "The match" below.
   A world with a `navigation` node has its `nav.bin` fetched the same way and
   its graph **queued to bake**, which nothing waits for — see
   [Navigation and bots](#navigation-and-bots).
5. **Listen** — geckos' signalling and `/healthz` on `GAME_PORT`, the data channel
   on the UDP range.
6. **Tick**, at `TICK_RATE`, stepping every game and sending each player in each
   its snapshot.
7. **Heartbeat** into the registry, every 10s.
8. **Subscribe** to `/internal/game-servers/<id>/events`. Last, and it has to be:
   the api cannot be told to host anything on an instance it has never heard of,
   and the heartbeat is what introduces one.

`pnpm world <slug>` runs steps 1–4 and prints what came back, which is the way to
tell "this map is broken" from "this map does not draw". It needs the api
running. For a world on disk with no api involved, `pnpm check worlds/<slug>` is
the faster loop.

## The games

**One process, several games, any number of maps.** An instance is not tied to a
world: it is told a map when a game is ordered, loads it then, and unloads it
when the last game on it ends. `src/worlds.ts` is that registry, and the count it
keeps is games rather than players — two games on one map share the one
`ResolvedWorld` and the one collision BVH, and the second `release` is what frees
them. `src/games.ts` holds the games themselves, along with each one's roster and
the predicate that says when it is over.

The load is why `Games.create` is awaited and why `gameReady` is sent after it.
A player is told where to go only once the api has heard `gameReady`, so the
first game on a cold map pays its load inside a window that already exists
rather than putting a player in front of a server that is still parsing. It is
not free — a large imported map is a few hundred ms of parse and about half a
second of BVH — which is what the "already has it loaded" preference in the
matchmaker is for.

A map that will not load refuses its game rather than taking the instance down,
and leaves nothing behind, so the next order for it is a real retry. Every
refusal — that, a full instance, an unknown gametype, a map the gametype is not
played on — is reported as `refused` straight away by Housekeeping, as is a game
that threw on its tick, and retried until the api hears like any other report.

A game ends when its `durationSeconds` runs out, or when it is empty and
`GAME_JOIN_GRACE_SECONDS` have passed since it was created. Empty means no
people: a game with only bots left in it is over. The grace window is
doing real work: players are told about a game before they have loaded the world,
so one is legitimately empty for several seconds, and "empty ends it" with no
window would end every game the instant it was created. Then a report goes back
to the api, which reopens the lobby — retried once a second until the api hears,
because a report lost to a blip would leave its players in a game that is over.

**A player is admitted by an id the api issued and a key the api gave them**, not
by their socket — which is what lets them reconnect and still be the same player
to everyone else, and what stops anyone dropping into a game they were not put
in. The roster lives in `games.ts` and not in `Match`, which is the simulation
and has no business holding secrets. A second socket presenting a seated
player's identity displaces the first rather than feeding one input queue from
two.

Nothing is sent to everyone on the instance any more. A `leave` goes to the game
it happened in, because a client drops any player id it sees in one, and a player
in another game must never be named at it.

## The match

`src/match/` holds one game's players and its tick. `Match` (`match/match.ts`)
is the composition and the only thing the rest of the server calls; each concern
is a module beside it, and **a new one is a module and a phase, not a field and
three calls in `Match`**:

| Module         | What                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `phases.ts`    | The tick, as a named, ordered list. Each phase's comment says what it needs before it; a test pins the order   |
| `playing.ts`   | What a match is handed to play: the map, the gametype, the catalogue, the bodies, the navigation               |
| `clock.ts`     | The tick it is on and the rate it runs at: the one "now" every module reads                                    |
| `roster.ts`    | Who is in it, and what a `Member` is: a simulated player and the parts below that hang off one                 |
| `inputs.ts`    | One member's `InputQueue`: the seq check, the cap, the ack, the use key's edge, and the drift                  |
| `drain.ts`     | The drain: each queued input stepped, its shots fired, its drift measured, a use press found                   |
| `scripts.ts`   | `ScriptHost`: every hook asked through `each` or `first`, each script handed its own context                   |
| `context.ts`   | What a script or a brain is handed, built once per match and read live                                         |
| `verbs.ts`     | The verbs of a `ServerContext`, each over the module that carries it out: all a script may change              |
| `cast.ts`      | Who a player is, as the scripts' `cast` answers: the body a shot is traced against, the default weapon         |
| `classes.ts`   | A member's class, when a change takes effect, and what scripts say over it. The one place weapons are equipped |
| `spawns.ts`    | Where a member is put: joining, respawning, and where a script says                                            |
| `shots.ts`     | The rounds a tick fired: the cone, the trace against the map, players and actors, and what each cost           |
| `rewind.ts`    | Lag compensation: the moment a shooter was drawing, clamped and counted once per shot                          |
| `damage.ts`    | The one queue every hit drains through, deaths and the corpses they leave, and the tick of health              |
| `outbox.ts`    | Events riding the snapshot tail until they expire, and `publish`                                               |
| `scores.ts`    | Each side's score, each player's points, the gametype's counters                                               |
| `zones.ts`     | Whose feet are in which trigger, and the `triggerLeave` and `triggerEnter` as it changes                       |
| `nav.ts`       | The world's graph once baked, this match's blocked links, the planners. Polled once a tick                     |
| `bots.ts`      | Adding and ordering bots, and writing their input once a tick                                                  |
| `actorTick.ts` | The actors' phase of the tick, and what each snapshot says about them (`../actors.ts` is the creatures)        |
| `use.ts`       | What a use press had in focus, and `interact` once the drain is done                                           |
| `dynamics.ts`  | The physics world a match builds the first time something needs one, stepped once a tick                       |

The tick is `phases.ts`'s list, in this order: `records → nav → start → bots →
inputs → interactions → fall out → actors → health → occupancy → scripts →
physics → parts → history → snapshot`. `tick.ts` is what runs it: `GameTick` steps
every game, each in its own try, and hands `net/server.ts` the packets for each
seat.

`Match` takes no socket and no
geckos type — `net/server.ts` is the adapter, and the split is what lets
`tests/match.test.ts` drive a whole match with no port bound, the same trick the
api's `App` plays by holding a Hono a test can `request()` without a socket. It needed no changes to host several games at
once: it was already keyed by a player id it did not mint.

**Who is in charge.** This server is. A client still steps its own player and its
own camera and never waits for us, so there is no input latency at any ping — but
what it produces is a _prediction_. It sends what it did (`InputMessage.input`)
and where it thinks that put it (`InputMessage.claim`); we re-simulate the same
input through the same `stepMovement` against the same collision, and **our answer
is the one in the snapshot**. The claim is evidence, never adopted.

The client takes that answer whole, replays every input we had not yet applied on
top of it, and settles the leftover difference into its camera over ~100 ms — so a
correction reads as a slight settle rather than a snap, and the simulation is
exactly ours the instant the snapshot lands. See "Prediction and correction" below.

**What was deleted, and why it was there.** The server used to `reanchor` to every
claim — adopting the client's own account of where it ended up — and only
_measure_ the gap. That was deliberate: a correction loop built on an unmeasured
divergence is one nobody can debug, so the divergence was made visible first. It
also kept the measurement honest for free, because each step was replayed from
where the client said the last one finished, so `DriftReport` held one step's
error rather than a running sum. It had to: two trajectories left to run free
never rejoin, and a wall is where that bites — one side stops against it, the
other keeps sliding, and the figure then records only that something happened
once, minutes ago.

**Correcting changes that calculus rather than breaking it.** The client now
rejoins _us_ on every snapshot, so the figure stays a per-step error without us
discarding our own answer to get one. What it measures has changed: no longer "do
the two simulations agree" but "how far ahead of the correction is this client
predicting" — small for an honest client precisely because it is being corrected,
and a validator's input rather than a diagnostic. It is on `/healthz` and in a
throttled log line past `DRIFT_WARN_METRES`. `mean` is still the field that
catches a _systematic_ mismatch, which `max` cannot tell from one bad tick.

What the tick does, per player:

- Drains **at most 4 queued inputs**, so sending faster buys no extra movement,
  and drops anything past 16 queued rather than growing without bound.
- **Takes each `seq` once, in order.** geckos' channel is unordered and never
  retransmits, so `Match.receive` drops any input not newer (`@3d/shared/net/seq.ts`)
  than the newest it has — `ack` never goes back — and every datagram repeats the
  client's last `REDUNDANT_INPUTS` unacknowledged inputs (`InputPacket.earlier`,
  each with its own `renderTick`, none with a claim), so a lost one costs no input.
- **A game that throws on its tick ends**, alone: `GameTick.run` catches it,
  `Match.fail` marks it, and Housekeeping drops and reports it as `errored`.
- Steps with the **client's own `dt`**, clamped to two ticks. Re-simulating the
  step they actually took is the whole point; the wire's 0.25 s ceiling is far
  too generous to hand to gravity.
- **Compares every claim and adopts none.** We own where a player spawns, which
  is the other half of owning the correction: arriving through a pose link or
  keeping a position across a hot reload now snaps you to our idea of you. It did
  not use to — the first claim was taken as given and every one after it
  re-anchored us, because a client that is believed anyway may as well be believed
  about where it started.
- Sends every player the whole world, every tick. A delta against the last acked
  snapshot is the obvious next compression and drops into `messages/snapshot.ts`
  as a changed-field bitmask.

### Things that happened, not things that are

A snapshot says what _is_ — where everyone stands, their health, what they hold —
so a lost one costs nothing, because the next tick says it again. A hit marker and
a kill are not like that: they happen once, and no later state repairs a missing
one.

They ride in a short tail on the snapshot rather than in a reliable message of
their own, because geckos' `reliable` is resend-and-dedupe and not delivery — a
retry with a promise attached. So the tail does the retrying explicitly, and a
monotonic id lets the receiver throw the duplicates away. `joined` carries the
count as it stands at that moment, which is what stops somebody joining an hour
into a match from reading every id as ancient and ignoring it.

Retention is per event, not per kind. A hit marker goes to the shooter for one
tick: its value is immediacy, and repeating it would misreport _when_. A death is
broadcast for half a second, because a kill feed that silently drops a line is
permanently wrong about the match.

The tail is capped, and the cap keeps the **newest** — the oldest entries are the
ones that have already been sent most often.

**Which of a world's removable parts are present is state, so it is sent whole.**
A world with `solid` nodes puts `presence` on every snapshot: one bit per solid,
in resolve order, and `since`, the tick the last change was applied at. A client
adopts the bits as they stand and brings its physics to `since` before applying
them, so a lost snapshot costs a tick of lag and never a missed door. A world
with no solids sends `null` and pays one bit. The bits are positional, which is
why `join` checks the world ([below](#the-wire)) and why `matchReady` names the
gametype: its `mode` decides which solids start present, and a browser builds
the world before it has joined.

### Lag compensation

A client draws other players one tick behind the newest snapshot and interpolated
between the last two it holds, so when it puts a crosshair on someone it is aiming
at where they **were** — by its own ping plus that interpolation. To judge a shot
at all, this server has to be able to put the world back that way.

- **The client names the moment.** `InputMessage.renderTick` (the low 16 bits) and
  `renderFrac` are what `RemotePlayers.renderTick()` reports: the server tick this
  client last drew peers at, and how far past it. Only the client knows.
- **Per input, not per tick.** A tick that drains four queued inputs rewinds four
  times, each to its own moment. That is why the fields are on the input.
- **Low bits are enough**, because the tick named is always in the past:
  `current - ((current - renderTick) & 0xffff)` recovers it, wrap-safe for anything
  inside 32768 ticks against a window of sixty. A client cannot express "the
  future" at all — a tick ahead of the clock comes out ~65536 behind and the window
  catches it, which is a better guarantee than a check.
- **`src/history.ts` keeps the ring**: one second of `MovementState` per player,
  preallocated and overwritten, recorded _after_ each tick's inputs are spent so a
  slot holds what that tick's snapshot carried. It keeps `MovementState` rather
  than a packed record so that a rewind can interpolate with `lerpMovement` — the
  same function the client drew with. Two implementations of "where was this player
  between two ticks" is exactly the disagreement that puts a hit where nobody was.
- **The window is a quarter of a second** (`MAX_REWIND_SECONDS`), and the ring is
  four times that on purpose: the ring is never the binding constraint, so a tick
  that has aged out can only mean a drifted clock or a lying client, which keeps
  those distinguishable from ordinary lag.
- **A rewind is never refused.** One that cannot be honoured is clamped to the
  nearest moment that can be, and counted in `rewinds` on `/healthz` — a refused
  shot is indistinguishable from a miss to the player who fired it and impossible
  to account for afterwards, while a clamped one resolves against a _more current_
  world, which is the conservative direction.

**It favours the shooter, deliberately.** "I put the crosshair on him and it
counted" holds at any ping. The victim pays: they can be killed up to a
quarter-second after breaking line of sight on their own screen — the shot-round-a-
corner complaint. Every shipped shooter makes this trade, because resolving against
the present makes a 60 ms player lead a sprinting target by about 35 cm. The
shooter themself is **not** rewound: their own eye comes from this server's replay
of that very input, which is current with it. Only other players move back.

`tests/rewind.test.ts` is the one that matters. It reconstructs what the shooter's
client would have drawn from the snapshots the match actually produced, and asserts
the rewind reproduces it **exactly** rather than closely — both sides ran the same
interpolation over the same states, so anything but equality means the history is
not holding what the snapshots said. It also asserts the negative, because a rewind
that quietly returned the present would pass any "is it close" check at walking
pace.

### Prediction and correction

The client's half, in `net/connection.ts` and `engine/controls/firstPerson.ts`:

- **Every input is kept until it is acknowledged.** `Connection` holds a ring of
  the last two seconds of `{ seq, input, dt }`, copied rather than referenced —
  `FirstPersonControls` refills one `PlayerInput` in place every tick, so keeping
  the reference would replay the newest command for every unacked step.
- **A snapshot is split into three things**: our own authoritative state, everyone
  else's, and the inputs sent after `ack`. Our own state used to be filtered out
  ("the local player is simulated here and never adopted from the wire"), which
  was true while the server believed whatever we claimed.
- **`reconcile` takes the whole `PlayerState`**, not just the movement: the server
  owns the ammo and the weapon in hand, so adopting half would leave the client
  predicting a magazine nobody else believes in. Then it replays each pending
  input with **its own `dt`**, through the same `player.step` the prediction used.
- **The view angles need no special case.** Replaying re-applies the client's own
  `yaw`/`pitch`, because they travel _in_ the inputs being replayed — so after a
  correction the player is looking exactly where they were looking, and a
  correction cannot fight the mouse. With nothing left to replay the server's
  angles stand, and they came from the client's last input anyway.
- **Only the camera is smoothed.** The difference between what was drawn and what
  turns out to be true decays exponentially (~100 ms) and is added to the drawn
  position alone. Past `TELEPORT_DISTANCE` it snaps instead: a respawn is a
  placement, and sliding the camera across the map is worse than cutting to it.
- Which inputs are still outstanding is a **16-bit comparison that wraps**. A
  plain `>` is right for eighteen minutes and then wrong for one frame, when every
  input a client has ever sent looks unacknowledged at once.

`SnapshotMessage.ack` is that player's own last applied `seq`, so the array of
states is built once and only the ack varies.

### What will show up as drift

- **Props are the collision a client is mostly touching.** An imported map's
  clipmap stops you at the level's walls; everything you actually bump into — a
  car, a crate, a railing — is a `model` placement with a hull. Those are built
  from the resolved world rather than from a scene graph, through the same
  `hullGeometryFrom` the client uses, so the two ends agree by construction. A
  hull that fails to load is counted and named at boot, because a prop solid on
  the client and absent here reads as a netcode problem and is not one.
- **The server holds a weapon now, if the catalogue has one.** It used to hold
  none — `WeaponDef` was read off the world's viewmodel GLB in the client's
  `scene/`, so `sprintAllowed` was always true here while the client dropped to a
  walk to fire, aim or reload, and drift rose through every fight. A game server
  loads `GET /api/catalog` at boot (`src/weapons.ts`) and equips each player on
  join, so both ends now run the same weapon state machine on the same numbers.
  **An instance whose catalogue is empty still hosts**, unarmed, and says so
  loudly at boot — because "everyone is unarmed" reads as a netcode fault and is
  not one.

### The wire

One raw binary channel, not geckos' named events: `@3d/shared/net/packet.ts`
puts a `MessageType` byte at the front, so a datagram says what it is and both
ends share one encode/decode.

A game order carries the **gametype** the lobby chose, as a name in `GAMETYPES`
and never a copy of the table — both ends compile it in, so sending the
declaration would let them disagree about what a gametype is while agreeing what
it is called. An instance that does not know the name refuses that game and keeps
hosting the others, the same way it refuses a map that will not load. The full
chain, and why its admission check is split between the two servers, is in
[scripting](../engine/scripting.md#how-a-gametype-reaches-a-game).

A game order carries each player's **five classes** — for each, the game it is
built from, the two weapons and what is fitted to each, by name, exactly as the
api stored them. All five, because the class is chosen in the match rather than
before it (below). Unresolved on purpose: the instance has its own catalogue and reconciles against that when it
equips them (`Player.equipLoadout`), and that is the reconciliation that decides
what is in their hands, so doing it in the api as well would only be one
process's opinion about another's catalogue. A weapon the instance does not hold
leaves that slot empty, and a player whose class arms them with nothing falls
back to the gametype's default weapon (`@3d/shared/game/cast.ts`), which a world
has no say in — see [scripting](../engine/scripting.md). A weapon from another
game than the class's, or in a category that belongs to the other slot, is
refused by the same rule (`mayCarry`, `@3d/shared/sim/weaponCategory.ts`) at
both ends.

**A joined player is seated, not spawned.** `join` admits them to the game — they
receive snapshots from then on — but they are not in the `Match` until they send
`chooseClass { index }`. The server looks that index up in its own copy of the
order's classes, so nothing the client sends names a weapon. Seated players are
counted in `GameInstance.choosing`, so a game in which everyone is still choosing
is not over for being empty. A gametype whose scripts forbid custom classes
(`ClassRules.customClasses`) has nothing to wait for, and spawns them at `join`.

A `chooseClass` from a player already spawned is decided by `Match.chooseLoadout`
— at once, at their next spawn, or refused, by the gametype's `ClassRules`, a
script's per-player word, the grace after a spawn, and the `classChoice` hook
([scripting](../engine/scripting.md#classes-in-a-match)) — and nothing the client
does can bring it forward. Every respawn re-arms fresh. Both are answered with
`classChosen { index, timing }`. The class menu cannot edit a class mid-match:
the order's copy was made when the game started.

**Weapons handed over mid-life are never guessed at.** A snapshot carries both
of a player's weapons and `armed`, a count of the times they have been handed
weapons, so a client sees a server re-arm them — a respawn, a class taking
effect, a script's `arm` — as a new count, and rebuilds both from the state
([player](../engine/player.md#state-for-the-network)).

`joined` answers with `{ you, world, tickRate, gametype, spawned, classes }` —
`spawned` false for a player who has yet to choose a class, true for one
rejoining a game that already has them or one in a gametype without classes, and
`classes` whether the class menu is offered at all. The gametype is there
because a browser cannot otherwise resolve `PlayerState.team` — a three-bit index
into that gametype's `teams` — or ask `castFor` what a player of that side wears.
Both ends have to reach the same answer from the same gametype: a peer dressed by
one end and not the other is not a wardrobe bug once bullets are traced against a
posed skeleton, it is a hit box in the wrong place.

`join` carries `{ protocol, gameId, playerId, authorizationKey, catalogHash, worldHash }` —
a game, not a world, because one instance hosts several, and since protocol 4 a
digest of the weapon catalogue the client loaded. A snapshot names a weapon by
its _index_ in that catalogue, and an attachment by its _slot_ in that weapon's
own list, so two ends holding different ones arm everybody wrongly and say
nothing; the digest covers both orders for that reason. A mismatch is refused
exactly as a protocol mismatch is, and separately from it because a catalogue
changes whenever a weapon or an attachment is added and the protocol does not.
`worldHash` (`@3d/shared/worlds/hash.ts`) is the same check for the world: a
snapshot's presence bits and anything else addressed by a world id are positions
in the world's own lists, so a browser holding different world text is refused
and told to reload rather than shown the wrong doors. One consequence
worth knowing: a client on protocol 2 produces a length prefix this layout reads
as garbage, so `decodePacket` throws and the datagram is dropped before anything
can read the version out of it. The clean "it speaks protocol 2" refusal only
works between builds that already agree on the layout; client and server ship
together, so that is accepted rather than worked around.

A refused join is answered with `refused` and a reason. It costs one datagram and
saves the client ten seconds of silence it cannot tell from a dead network — a
bad key, a full game and an unknown game all look identical without it.

Nothing assumes delivery. geckos' `reliable` is resend-and-dedupe rather than
delivery, and it is not on the raw path at all, so:

- **`join`** is re-sent by the client every 250 ms until a `joined` answers.
  `Match.join` is idempotent, so asking twice costs one reply.
- **`chooseClass`** is re-sent the same way until a `classChosen` for that
  index answers. A repeat that arrives after the spawn is the class already in
  hand, which changes nothing — and in particular re-arms nobody, or a repeat
  would be a free refill.
- **`leave` is a hint.** Snapshot membership is authoritative — a client removes
  anyone absent from the newest snapshot — so a lost `leave` heals on the next
  tick instead of leaving a body standing in the map.

## Navigation and bots

**The graph is baked as a world loads, and nothing waits for it.** A world whose
text has a `navigation` node has its `nav.bin` fetched through the same world
source as its collision, and `WorldRegistry` queues its bake against that
collision on `NavBaker` (`src/nav.ts`). The world is handed back, `gameReady` is
sent and players join as before; `LoadedWorld.nav.graph` appears when the bake is
done (`ready`), and one line is logged: nodes usable, links valid and invalid,
traversals, and the time in slices against the wall time. A file that is missing
or will not decode is a warning and a world with no graph; it does not fail the
load. Like the collision, the graph is shared by every game on the map, and
unloading the map cancels a bake still running.

The bake is seconds of CPU (5.2 s on dome) and this process hosts several games
on one event loop, so it runs in slices of `NAV_SLICE_MS` (5 ms), with one turn
of the event loop between slices for the tick's timer to fire in. A tick waits
behind at most one slice, and the bake has whatever the ticks leave, so its wall
time is close to its CPU time. A slice cannot stop inside one link's simulation,
and the few longest take up to 34 ms on dome, so a tick is occasionally that
late. One bake runs at a time, oldest first. There is no cache and no worker
thread: a map's bake is paid again on every load.
[navigation](../engine/navigation.md#on-a-game-server) has the engine's side.

**A bot is a match member.** A gametype's script adds one by naming a brain
(`ServerContext.bots.add`, [scripting](../engine/scripting.md#bots)), which
comes to `Match.addBot({ controller, team?, loadout?, objective? })` with a
`BotDriver` as the controller: the brain, its memory and a motor, all in
`@3d/shared/game/bots/`. `addBot` joins it the way `join` joins a player:
`playerJoin`, a side (the one given, or the balancing default), a spawn from the
gametype, a class or the gametype's weapon. It returns the bot's id: `#b` and a
count in base 36 (`botId`, `isBotId` in `@3d/shared/net/messages/fields.ts`). `#`
is outside the api's player-id alphabet, so a bot can never collide with a
player. `removeBot(id)` takes one out.

Each tick, before the inputs are drained, `MatchBots.think` hands each bot's controller
(`src/bots.ts`) a `BotTurn` — its movement, the match's `NavPlanner`, its
objective (asking the scripts' `botObjective`), and the match's `BrainContext` — and queues the input it writes as a client's would arrive: `dt` one
tick, rounded as the wire rounds it, `seq` counting up, and `renderTick` the last
tick stepped with `renderFrac` 0. That last one matters for its shots: a bot sees
the world as the previous tick left it, and a `renderTick` of 0 would be clamped
to the rewind floor, a quarter of a second back. From there a bot is stepped,
shot, killed and respawned by the same code as a player, and snapshotted with
everyone else, so a client sees one as a player and **nothing on the wire
changed**. Until the world's graph is baked a bot's controller is not asked and it
is given an idle input, so it stands still but is still stepped. A controller
that throws is logged once, and that bot stands still for the rest of the match.

**An actor is not a member.** A script spawns one with `ctx.actors.spawn`
(`src/actors.ts`, owned by `Match`), and it is stepped after the players each
tick with the bots' brains and motor over it — but it has no seat, no input queue
and no `PlayerState`: a snapshot carries it in its own array of twelve-byte
`ActorState`s, and past 64 each player is sent the nearest. A game with only
actors in it is empty. [actors](../engine/actors.md) has the runtime.

What a bot is not:

- **Not a person.** `Match.humans` counts members that are not bots, and is what
  `Games.finished` calls empty, what the heartbeat reports as this instance's
  players, what gates the scripts' `tick` hook, and what `full` compares with the
  lobby size. A bot keeps no game alive and takes nobody's seat.
- **Not measured.** It claims nothing, so no drift is recorded for it, and it has
  no `sentTick`, so the implausible-rewind check never applies to it.

The default side (`sideFor`) still balances by every member, bots included: a
gametype that adds bots puts people and bots on their sides itself (`chase` does
it in `playerJoin`), and one that fills empty seats with bots would balance
people first. `PlayerView.bot` tells a script which is which, and the countdown
counts people only.

**`matchStart` fires on the first step, people or not**, which is where a
gametype adds its bots: they are on the map before the first player has loaded
it. `tick` is still skipped while there are no people.

## Env

Every variable, with its default, is in `.env.example`. Both servers read
`.env.local` through node's `--env-file-if-exists`, wired into their `dev` and
`start` scripts — `--env-file` is not permitted inside `NODE_OPTIONS`, so the
existing `NODE_OPTIONS="--import tsx"` idiom could not have carried it.

The ones that bite:

- **`PUBLIC_IP` is what makes an instance reachable at all**, and its absence is
  invisible until someone outside the LAN tries to play. See above.
- **`UDP_PORT_MIN`/`MAX` name one port, and must differ per instance on a host.** Two game servers
  sharing the default 20000–20100 does not error — it fails as a silent ICE
  timeout, which is the same symptom as a firewall. Hosting several games in one
  process is one fewer reason to need two instances on one host.
- **`MAX_PLAYERS` is the instance's total, across all its games**, and is what
  stops a loaded one being handed more work. A single game's cap is the api's
  `LOBBY_SIZE`, which arrives with each order.
- **`PUBLIC_URL` is a whole URL**, not a host and a port, and the matchmaker
  hands it to a player verbatim. See above for why it cannot carry a path.
- **`NAV_SLICE_MS` is how long the navigation bake may hold the event loop**
  before yielding (default 5). Keep it well under a tick: one longer than a tick
  makes the fixed-rate tick drop a pass. It does not change how long a bake
  takes.

## Deployment

One image per server, each built from the repo root because that is where the
lockfile and the four manifests live:

```sh
docker build -f packages/api/Dockerfile         -t 3d-designer-api .
docker build -f packages/game-server/Dockerfile -t 3d-designer-game-server .
```

`.forgejo/workflows/publish.yaml` does both on a push to `master`: git-cliff
reads the conventional commits and names the next version, both images are built
and pushed under it and under `latest`, and the git tag is created last — a tag
is a claim that a release exists, so it is made once the images are really
there. Both carry the same version, because the api and the fleet it orders
about are one release.

**The api image carries no worlds and no database.** `WORLDS_ROOT` is `/worlds`
and `DB_PATH` is `/data/server.sqlite`, both mounted over, which is what lets a
map be re-exported — or a new one added — without rebuilding anything. It does
carry the client bundle, at `CLIENT_DIST`, because this process is the only
origin a browser talks to. **The game server image carries nothing at all**
beyond itself: no volume, no world, no map. It is an image, an `API_URL` and a
`SERVICE_TOKEN`, and it fetches the rest.

`NODE_ENV=production` is set in both, which is what makes a missing
`SERVICE_TOKEN` fatal rather than a warning, and what puts `Secure` on the
session cookie. Ports are the defaults: `9208` for the api, `9300` and **one**
UDP port for a game server — see `UDP_PORT_MIN`/`MAX` above for why it has to be
one and why two instances on a host cannot share it.

### Compiled, not run through tsx

Both images run `node --conditions=dist dist/index.js`. Three things follow from
that, and each has a way of failing quietly if it is undone:

- **`--conditions=dist` is what points `@3d/shared` at its compiled output.**
  Its `exports` map has two branches per subpath: `dist` for `./dist/**/*.js`
  and `default` for `./src/**/*.ts`. The polarity is deliberate — dev, vitest,
  vite and every `tsx` script get the default and so need no flag and no config
  of their own, and the one place that wants compiled JavaScript asks for it.
  Drop the flag and node is handed TypeScript, which it refuses out loud.
- **`dist/` mirrors `src/` file for file**, rather than being bundled, because
  two modules resolve paths from their own location: `src/config.ts` walks three
  levels up for the repo root, and `src/db/database.ts` two for the migrations
  it applies on open. A bundle collapses those depths and moves both targets.
- **The build configs turn `emitDecoratorMetadata` off**, and this is the one
  that bites. `tsconfig.json` has it on for the typechecker, but esbuild — which
  is what runs both processes under `tsx`, in dev and under vitest — ignores it,
  so the code is written for a container that sees only what `@inject()` names.
  tsc honours it, and tsyringe then reads `design:paramtypes` for parameters
  nobody meant to inject: `Games`' `now: () => number = Date.now` becomes an
  attempt to resolve `"Function"`, and the process dies on its first resolve
  with every test still passing. Emitting no metadata is what keeps dev and
  production one set of semantics rather than two.

### What the images install

`pnpm install --prod --filter-prod @3d/api...` — and the same for the game
server. **`--filter-prod`, not `--filter`**: `@3d/api` is a _dev_ dependency of
`@3d/game-server`, because that package's tests stand both ends up to prove they
agree, and a plain filter follows that edge. That is how a game server ends up
shipping SQLite, argon2 and the api's own routes.

The api's install also passes `--ignore-scripts`, and the game server's must
not. better-sqlite3 ships a prebuilt binary for every platform it supports
inside its own tarball, so there is nothing to run; node-datachannel's is
fetched by its install script from the project's GitHub releases, so there is.
The Dockerfiles say the rest.

The images are amd64, and the runner is arm64. Every stage that only compiles is
pinned to `$BUILDPLATFORM` and runs natively — the servers' `tsc`, the client's
`vite build` — and what remains under emulation is package downloads, which is
also why neither native dependency may be allowed to fall back to building from
source.

## The registry

In memory, in the api, which makes it true of one api process — as are the queue
and the lobbies beside it. A second api would need a store all of them could see;
that is a real limitation, written down rather than discovered. Entries expire 30s after the last heartbeat rather than being removed
on shutdown, because the failure worth surviving is the one where a game server
does not get to say goodbye.

## Reaching a game server from a browser

Two problems, not one, and solving the first on its own looks like success right
up until nothing connects. The handshake is HTTP and has to match the page's
scheme; the data channel is UDP and has to be _advertised_, not merely open.

### The handshake

A page served over HTTPS cannot POST geckos' signalling to a plain-HTTP game
server: mixed content blocks it. The data channel that follows is DTLS and would
have been fine — it is only the handshake, but the handshake is what sets the
connection up. Dev never meets this, because dev is `http://localhost`.

So an instance needs TLS of its own, and `PUBLIC_URL` is what it advertises. Two
ways to give it one, both infrastructure choices rather than code ones:

1. **A name per instance**, `PUBLIC_URL=https://gs-7.game.example`, terminated by
   a reverse proxy or by a certificate each. Needs a wildcard cert and DNS per
   instance. This is what the current deployment does.
2. **Relay signalling through the api**, which keeps one origin but puts the
   authority in the connection path.

**A path per instance is not one of them.** `https://game.example/gs/7/*` mapped
onto each is the obvious third, and geckos' `ClientOptions` takes a `url` and a
`port` with no path field at all. `net/connection.ts` splits the advertised URL
into exactly those two, which is the whole reason it can — and `GameServerInfo.url`
stays one opaque string so the other two need no change to the contract.

Whatever terminates the TLS has to pass `/.wrtc/v2/*` through untouched. A rule
that denies dot-segments — nginx ships one in more than one stock config — blocks
every connection while `/healthz` beside it answers fine.

### The candidates

A handshake that succeeds proves nothing about the data channel. A browser sends
UDP only to addresses that appear as ICE candidates — it does not probe and does
not guess — and a game server builds that list by enumerating its own interfaces.
It has no idea it is behind a NAT, no idea what its public address is, and no
idea a port was forwarded. So behind one it offers `192.168.x`, `172.17.x` and a
bridge for every docker network on the box, the browser tries all of them, and
the connection dies. The port is open; the address was never written down.

There is no hole-punching to fall back on. The geckos client POSTs its answer
straight after `setLocalDescription`, before trickle gathering has produced
anything, and there is no route for it to send candidates later — so the server
holds an answer with no remote candidates at all and can never check outward.
Traffic starts browser → server or it does not start.

So the forwarded address is **declared**, in `PUBLIC_IP`, and
`net/advertise.ts` pushes it onto every connection's candidate list beside the
ones gathered. It is ranked below them, so a player on the LAN still takes the
direct route. `PUBLIC_IP` defaults to resolving `PUBLIC_URL`, which is the same
address by definition, and a private result disables the whole thing — which is
what dev wants, and what a host whose own interface carries its public address
wants too.

**`UDP_PORT_MIN` and `UDP_PORT_MAX` must therefore name one port.** geckos sets
`multiplex`, so libdatachannel shares a single socket across every connection and
picks that socket's port from the range **at random**: 20506 out of 20500–20510,
measured. A range and a forwarded port agree by luck. The boot log refuses to
advertise anything until the two are equal, because the alternative is telling
every player a port nothing is listening behind.

#### Why not STUN

STUN is the usual way to learn that address, and `ICE_SERVERS` is there for it —
off by default. It reports the mapping a NAT made **for the STUN server**, which
is a candidate any peer can use behind a cone NAT and worthless behind a
symmetric one, where each destination gets its own mapping. A static port forward
has neither problem: it is an unconditional inbound rule, the same for every
source, so the address is simply true and needs no third party to discover, no
round trip at gather time, and no relay.

Which NAT you are behind is a question with an answer, and it is easy to get
wrong: ask **two STUN servers on different IP addresses** and compare the port
each reports. Asking `stun.l`, `stun1.l` and `stun2.l.google.com` proves nothing —
all three resolve to one address.

TURN remains the general escape hatch and belongs in `ICE_SERVERS` too, but it
relays every packet of a 60 Hz game through a third host, so it is a fallback and
not a plan.

#### How it fails

Silently, which is why all of this is written down. The client awaits the data
channel with no timeout, so `onConnect` never fires, `startJoining` is never
reached, and the ten-second join timeout never starts either. No error, no
warning, no refusal — a player alone in a world that plays exactly as it does
offline. From outside, two requests tell you which half is broken:

```sh
curl -sX POST https://<server>/.wrtc/v2/connections          # → { id, localDescription }
curl -s https://<server>/.wrtc/v2/connections/<id>/additional-candidates
```

A failure on the first is the handshake. A second that answers with nothing but
private addresses is this.

## Other couplings worth knowing

- **`CLIENT_DIST`, `WORLDS_ROOT` and `DB_PATH` are resolved against the repo
  root**, not the working directory. `pnpm --filter @3d/api start` runs in
  `packages/api`, where a sensible-looking `CLIENT_DIST=packages/client/dist`
  would otherwise resolve to nothing and 404 the entire bundle in silence.
- **Manifest thumbnails are root-absolute** (`/worlds/<slug>/assets/…`), built in
  `src/worlds/manifest.ts`. Fine while the api serves the page, and broken the day
  the client is served from a CDN separate from it.
- **`@3d/shared` injects the host's `fetch`** rather than reaching for a global.
  It is typechecked with no DOM and no `@types/node`, so it has no `fetch` type at
  all; `protocol/http.ts` names the shape it uses and callers pass theirs in.
  `platform.d.ts` stays a short, honest list, a test can fake a response with an
  object literal, and Hono's `app.request` satisfies the same type — which is how
  the game server's integration test runs against the real routes with no socket.
- **The api never imports three.js**, nor `@3d/shared/collision`. The process that
  serves every asset request has no capsules to resolve, and eslint says so.
- **`fsWorldDirSource` takes a directory, not a slug**, because
  `pnpm check ../elsewhere/my-world` names one that answers to no worlds root.
  Its caller vouches for that directory — `worldDir(root, slug)` for a request, a
  shell argument for the CLI — and everything read _inside_ it still goes through
  `worldFile`, world text included.
