# Navigation

How a bot finds its way: a world's `nav.bin` ([nav-format.md](nav-format.md))
plus the world's movement collision become a graph at load, A* plans over it,
and a follower turns the plan into the same `PlayerInput` a player sends.

The code is `@3d/shared/nav/`, in tier one: no three.js, no DOM, no Node, and
no `Math.random` or `Date.now`. It runs on a game server, and in a browser for
the `K` debug view, which bakes the same file against the client's own collision
([debugging](debugging.md#navigation)).

**Status.** The runtime is built and tested: the bake, A\*, the follower and the
per-match blocked state. A game server bakes a world's graph as the world loads,
and a bot is a match member whose input its brain and motor write
([below](#on-a-game-server)). Scripts give bots objectives and brains turn them
into goals ([scripting](scripting.md#bots)); the motor, which turns a goal into
input over this graph, is [below](#the-motor). Nothing about it has been seen in
game.

| Module        | What                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `format.ts`   | `nav.bin` → typed arrays. The file's reader and nothing else                                      |
| `vocab.ts`    | The standard node types, link kinds, traversal kinds and ability bits                             |
| `bake.ts`     | `NavBake`, the resumable job from a file and a world to a graph; `bakeNav` runs one to the end    |
| `snap.ts`     | A node's feet on our floor, or why it has none                                                    |
| `derive.ts`   | The candidate pairs for derived walk links                                                        |
| `probe.ts`    | The cheap corridor check a candidate passes before it is simulated                                |
| `validate.ts` | The definitive check: a link walked in simulation                                                 |
| `follow.ts`   | `followPath`: a path, one tick of input at a time. The bake and a bot both use it                 |
| `graph.ts`    | `NavGraph`, the baked result, immutable and shared by every game on a world; `components`         |
| `grid.ts`     | 4 m cells over X and Z: nearest node, nodes within a radius, links through a box                  |
| `astar.ts`    | `NavSearch`: A\* in seconds, honouring abilities, blockers and per-kind cost scales               |
| `dynamic.ts`  | `NavMatchState`: one match's blocked counts per link, its blockers and the epoch that says replan |
| `parts.ts`    | The links each removable part shuts while present, found once per world after the bake            |
| `mover.ts`    | Whose verdict on a link a planner goes by: a player's (the bake's) or an actor's                  |

## The model

**The file holds game truth; everything that depends on our collision is
computed here.** Where a node's feet are, whether it is usable, which walk links
exist, whether each link can be crossed and what it costs: none of it is in the
file, so a change to collision never needs the graph re-exported.

**Movement collision only.** The bake reaches the world through
`CapsuleWorld.resolveCapsule`, `overlapsCapsule` and `groundBelow`, and through
`stepMovement`, which uses the same three, but never `traceRay`. What stops a
bullet may then change (the planned split of what props stop shots from what they
stop players) without changing what a bot can walk.
`tests/navBake.test.ts` bakes against a world whose `traceRay` throws.

**One definition of walkable.** A link is VALID when the follower a bot uses
walked it in simulation, with `stepMovement` at the match's tick and the
world's mantle volumes and ladders exactly as a player gets them
(`sim/worldRules.ts`'s `movementRules`). So if a link validates, a bot can walk
it, and nothing else decides that.

**One graph per world, one state per match.** `NavGraph` is immutable once
baked. A match's changes, such as a door or a link a bot got stuck on, are
counts in `NavMatchState`, never writes to the graph.

**Deterministic.** Everything is visited in index order and ties break by
index. The bake takes its time budget from the caller (a clock and a slice, or a
count of work units), and the result never depends on it. Two bakes are equal
byte for byte however they were sliced (tested).

## Snapping

A node flagged `FLOOR_Z` is settled onto our floor within ±0.25 m. Any other
node was authored above the floor, so it is searched for straight down from a
step (`STEP_HEIGHT`) above its position, up to `SNAP_SEARCH` = 2.5 m below it.
A node is unusable if:

- nothing is found in reach;
- a body standing there overlaps something above a step's height. Below a step
  is the step-up's business: a capsule's rounded bottom on a slope or at the
  foot of a stair would otherwise count as inside;
- it is `DYNAMIC`, which no version-1 file can place.

A body against a wall (cover nodes are placed at one) is pushed out and kept if
it moved under 0.35 m (`SNAP_NUDGE`). A traversal's begin with nothing straight
below it is over the lip it leaves from — the game places a jump down's begin
where its clip starts, which can be just past the edge — so it stands on the
highest ground within a body's radius (`RADIUS`) of it, moved there. Collision is triangles, so "inside" means
touching them: a node deep inside a large solid touches none and stands on
whatever is below it.

Measured on entity-lump nodes, which are authored above the floor:

| Map       | Nodes | Usable | Height above the snapped floor: median / p95 / max | Unusable              |
| --------- | ----- | ------ | -------------------------------------------------- | --------------------- |
| dome      | 511   | 508    | 0.67 / 0.98 / 1.30 m                               | 2 no ground, 1 inside |
| mogadishu | 1,323 | 1,319  | 0.71 / 0.93 / 1.68 m                               | 4 inside              |
| terminal  | 1,150 | 1,147  | 1.11 / 1.12 / 2.04 m                               | 2 no ground, 1 inside |

No usable node needed more than 2.04 m, so 2.5 m finds every floor there is.
The nodes it does not reach float 3.6–5.2 m over nothing in our collision
([cod/navigation.md](../cod/navigation.md#at-load)); a longer search would put
them on a floor they were never meant for.

## Derived walk links

With `DERIVE_WALK_LINKS`, every usable pair within `DERIVE_RADIUS` = 6.5 m
horizontally and `DERIVE_MAX_DY` = 3.25 m vertically is a candidate. That is
the source games' own rule. They link every pair their compiler can trace
within those bounds, with no cap per node. So there is no collinear pruning, and
the cap is 24 per node (`DERIVE_NEIGHBOURS`): a pair is in if either end has the
other among its 24 nearest. Each pair makes two directed candidates, less any
the file already links, and each direction is judged on its own. The foot of a
ledge is a wall one way and a drop the other.

## The probe

A candidate is walked in simulation only if its corridor could be walked at all.
`probe.ts` samples the ground every 0.25 m along the straight line between the
two feet. Each sample searches down from a step above the previous sample's
ground, as a walker finds it. A direction is rejected for:

| Reason    | What the probe found                                                             |
| --------- | -------------------------------------------------------------------------------- |
| `GAP`     | Nothing to stand on within reach below a sample                                  |
| `BLOCKED` | A body standing on a sample overlaps something above a step's height             |
| `RISE`    | A rise of more than a step between two samples, walking this way                 |
| `DROP`    | A drop of more than 3.25 m                                                       |
| `LEVEL`   | The ground under the line does not arrive at the target's height (another level) |

Just past a ledge the body is tested at the ledge's height for about its own
width, because a walker is still up there and has not yet fallen to the foot of
the wall. One profile serves both directions when the forward walk arrives; when
it does not, the way back is walked from the other end.

It may only be wrong one way, passing too much, and it very nearly never is:
99.9% of what it passes validates on dome and 99.7% on mogadishu.

## Validation

`validate.ts` stands a scratch player on the link's start and lets
`followPath` drive `stepMovement` towards its end at `dt = 1 / tickRate`:

- **Pass:** the follower says it arrived: standing on the ground within 0.4 m
  horizontally and 0.6 m vertically of the end.
- **Fail:** `STUCK`, when the follower gives up
  ([below](#the-follower)); `TIMEOUT`, when the time limit runs out, which is
  1.5 × the horizontal length at walking speed, plus 0.83 s per metre of height,
  plus 1.5 s on a traversal, plus 30 ticks; `FELL`, when it falls 4 m below both
  ends.
- **Cost** is the simulated time, in seconds.
- **Requires** is what the player had to do: `WALK` always; `MANTLE` if a mantle
  ran, `LADDER` if a ladder was held, `JUMP` if it took off, `DROP` for a fall
  of more than 1 m. The target node's own abilities are added.

A traversal of a kind our player has no move for (`SPECIAL`, `UNKNOWN`) and a
link touching an unusable node are INVALID without being simulated
(`NO_MOVE`, `NODE`).

## The follower

`followPath(movement, cursor, graph, out)` is pure: it keeps its state in the
cursor, reads the movement state without changing it, and never looks at the
world. What it cannot see, such as a ledge or a mantle volume, it finds the way
a player does, by walking into it. **Blocked** means the last step moved the feet
less than 30% of what the velocity asked, measured along the velocity. A body
jittering against a ledge moves, but not forward.

| Link                                          | Input                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| walk                                          | Face the next node, forward; run beyond 2 m of where the path stops. A node mid-path is passed within 0.6 m, or once past it along its link within 1.2 m                                                      |
| `STEP_UP`, `MANTLE_*`, `JUMP_UP`, `JUMP_DOWN` | Walk at the end; when blocked, press jump for one tick. With a mantle volume there the press climbs; without one it is a jump. A jump down walks off its edge, and presses only where a railing is in the way |
| `JUMP_ACROSS`                                 | Run if it is longer than 2.4 m, else walk; take off on the ground past the run-up, or when blocked. A path that stops is braked for as far out as the skid is long                                            |
| `LADDER_UP`                                   | Face along the link, forward, pitch 0.6 rad (full climbing speed); over the top, walk to the end                                                                                                              |
| `LADDER_DOWN`                                 | Back off the top facing the ladder; on it, pitch −60° and forward; standing at the foot, let go of forward, which lets go of the ladder                                                                       |
| a ladder grabbed on any other link            | Jump off it towards the target, or let go of forward if standing                                                                                                                                              |

A path's end is reached within 0.4 m horizontally and 0.6 m vertically,
standing. A node before a traversal is passed only that close too, so a
traversal starts about where it was validated from.

**Stuck** is the follower's own verdict, and a bot's motor should treat it as
the bake does:

- no 5 cm closer to the target in 30 ticks on the ground or a ladder;
- four jumps at an obstacle with no progress between them;
- a flight that has not landed after 3 s;
- a link it has no move for.

A mantle and a flight do not count. Both end by themselves: a mantle may climb
away from the target first (onto a wall, to drop off its far side), and a
running jump may pass over the target and land beyond it. Back on the ground,
progress is measured afresh from where the player came down.

## A\*

`NavSearch` is one per graph and caller, reused. Its per-node arrays are
stamped with a generation number rather than cleared, so a query costs what it
expands, not the size of the map. A link is usable when all of these hold:

- the bake did not rule it out (status ≠ INVALID);
- no blocker holds it shut this match;
- the mover has every ability it requires;
- its target is usable.

An actor's mover (`NavSearchOptions.mover`, [below](#movers)) replaces the first and
third with a mask of its own. Costs are the simulated seconds, or the mover's,
scaled per kind if asked (`scales`). The
heuristic is the straight-line distance at running speed. The open set is a
binary heap that breaks ties in f by the lower node index. A query stops after
5,000 expansions (`capped`). The result is the node ids and the link ids between
them.

## A match's state

`NavMatchState` holds a blocked count per link, so blockers that overlap add up
and opening one door never opens a link another still shuts. It also holds an
`epoch` that moves whenever any link opens or shuts.

- `addBlocker(id, shape, on)` takes either the links themselves or an upright
  box turned about Y. For a box, the links it shuts are found through a link
  grid: each link's corridor is the segment between its feet, grown by the
  body's radius sideways and its height upward.
- `setBlocked(id, on)` opens or shuts a blocker.
- A path records the epoch it was planned at. Only when the epoch has moved does
  `pathOpen(links, from)` need to check what is left of it.
- A file's `START_DISCONNECTED` links start behind `#start-disconnected`.

Scripts use the same seam directly (`ServerContext.nav.addBlocker` and
`setBlocked`, [scripting](scripting.md#what-a-script-has)) for obstacles they
invent. A world's own doors come through its removable parts, below.

### Removable parts

A `solid` is a part of the world's collision that can be absent
([collision](collision.md#removable-parts)), and a match changes which are present
while it runs. The graph is not rebuilt for it:

- **Baked once, with every part absent.** A game server bakes against
  `view(basePresence(world))`, so a door's links are in the graph and valid
  however any game on the map has it. One bake serves every game and mode.
- **Each part's links, once per world, after the bake** (`linksThroughParts`):
  the links whose corridor the part fills, sampled as the probe's `BLOCKED` test
  samples, every 0.25 m along the line between the feet with the body standing on
  the base's ground, against the part alone. Both ends of a link are sampled, so a
  node standing inside a part loses all its links. It errs towards shutting: a
  link beside a door that is shut too is a detour, and one through it left open is
  a bot walking into a wall. A part only ever shuts; one that is a floor adds no
  link the bake did not already find.
- **Each match holds one `{ links }` blocker per part**, `part:<name>`, shut while
  the part is present. A script's `world.setPresent` flips it with `setBlocked` at
  the tick boundary, which moves the epoch, so a bot mid-path replans at once the
  same way it does for any other blocker.

## Movers

The bake's verdict (`status`, `requires`, `cost`) is a player's: our player walked
the link in simulation. That is the one definition of walkable for a bot, and the
wrong one for a creature the source game moved by other rules. So the graph is
walked by a **mover** (`nav/mover.ts`): a validity mask and a cost per link over
the same link ids, chosen per planner.

- **`PLAYER_MOVER`**: no mask. The bake's verdict and abilities, the simulated
  cost, and the follower's moves over traversals. Every bot.
- **`actorMover(graph)`**: built once per graph and shared. A link is an actor's
  when both its ends are usable nodes and either the game compiled it (the file's,
  flagged `GAME`) as a walk or as a traversal of a kind with a motion (not
  `SPECIAL` or `UNKNOWN`) — trusted as compiled for the game's own AI, whatever
  our player made of it — or it is some other link (one derived at load) the bake
  found `VALID`. Its cost is the link's length at a run, plus 1.5 s for a
  traversal, which the actor's runtime crosses itself
  ([actors](actors.md#where-it-goes)).

**Same ids, so blockers mean the same links**, but each mover has its own
`NavMatchState`: a match holds a bots' planner and an actors' planner. A
removable part's links are found for each against its own collision and over its
own links (`linksThroughParts(…, valid)`; `WorldNav.partLinks` and
`actorPartLinks`), so a window's AI-only clip shuts an actor's climb through it
and nothing of a bot's, and a door shuts both. A script's blockers go to both
states; a link a mover got stuck on is shut for that mover only.

A mask rather than a second graph or a second bake because the file is the same
file and the nodes the same nodes: only the verdict differs, and a mask is that
difference and nothing else.

## The motor

`game/bots/motor.ts`: the last of a bot's three layers, and the one that uses
everything above. A brain hands it a goal (`idle`, `look`, or `moveTo` a point);
it plans with A\* through the match's `NavPlanner` (`game/bots/planner.ts`: the
graph, the match's blocked links and one `NavSearch` every bot in the match
shares) and walks with `followPath`, the follower the bake validated every link
with.

- **Points become nodes in one place.** `NavPlanner.nearestNode` takes the
  usable node nearest a point horizontally, within 1.5 m of its height
  (`GROUND_DY`) and 8 m across (`GROUND_REACH`). A player's feet are on the floor
  and so are a node's, so this allows a slope and a step and not a storey. A
  path is planned node to node, and its last leg walks straight from the end node
  to the point (the cursor's `goal`), which is where a player standing off the
  graph is reached.
- **When it plans again.** A new goal whose end node is the one already being
  walked to keeps the path and moves the point. Another end node plans again,
  and so does the match's epoch moving with a link on what is left of the path
  shut (`pathOpen`). Never in the air, in a mantle, on a ladder, or on a traversal
  link with a path in hand: a move is never left half made.
- **Planned again part-way along a walk link, it keeps that link** (`onward`):
  the new path runs from the link's end, with the link first and its progress
  carried over. Planned from wherever it stood, a quarry on the move — whose
  nearest node changes as they go — would tip it between two routes of about one
  cost round the same pillar every think, and it would turn back and forth on the
  spot without ever getting far enough along either to be called stuck.
- **A tracked point** (`moveTo.track`) is copied from that player's feet every
  tick, not only when the brain thinks. When it has moved half a metre, the
  follower's progress on the last leg is measured afresh, so a quarry walking away
  is not "stuck".
- **Arriving.** Within the goal's `arrive` (at least the follower's 0.4 m)
  horizontally and 1 m vertically, standing, it stops and faces the point (or the
  goal's `look`). It stays stopped until the point is 0.5 m further off.
- **Stuck.** The follower's verdict ([above](#the-follower)) blames a link only
  when the bot entered it from that link's own start. That link is shut for the
  rest of the match (`stuck:<link>` in `NavMatchState`), for every bot in it, and
  the motor plans around it at once. Stuck on the first leg (walking onto the
  graph from wherever it stood, which is not the path's start node) or the last
  (straight to the point), the straight line is to blame and not a link: it walks
  to the path's own start or end node first (a detour, once per path) and tries
  the leg again from there. Stuck on the first link after walking to its start, the
  link is blamed like any other. Stuck again otherwise, it stands, says `stuck`,
  and waits for the brain's next goal. So does `noPath`. A brain reads both in
  `self.motor.status`.
- **Input.** What `followPath` writes, with running turned off where the goal
  says walk. It never fires. For `attack { target }` it stands and faces the
  target's feet and says `arrived`; the blow is an actor's runtime's
  ([actors](actors.md#a-tick)).
- **Whose capsule.** An actor walks with its kind's capsule and speeds
  (`MovementParams`) over the game's links (its mover's), so the graph is exact
  only for kinds the size the game compiled them for.
- **Whose traversals.** A planner whose mover animates traversals (an actor's)
  has the motor walk to a traversal's begin, stand, and hand the link over
  (`Motor.traversal`) instead of pressing a player's keys at it; the runtime says
  `traversed` once across, and the path goes on from the link's end. It may plan
  again on the way to the begin, since it is never part-way through a move there.

## Budgets

The bake is CPU-bound in the collision queries, and nearly all of it is the
simulation. Profiled on dome, 75% of the validation is `resolveCapsule`,
a step's overlap tests are most of the rest, and the follower itself is under
1%. Measured in the game server's tests (`navBake*.test.ts`), on one core. Only
dome's bake runs in a plain `pnpm test`; the others take a minute or more and
run with `NAV_BAKE_ALL=1`:

| Map         | Pairs → candidates → past the probe → valid | Links simulated | Ticks     | Snap   | Derive + probe | Validate | Total  |
| ----------- | ------------------------------------------- | --------------- | --------- | ------ | -------------- | -------- | ------ |
| dome        | 3,471 → 6,940 → 4,147 → 4,144               | 4,151           | 212,532   | 50 ms  | 0.86 s         | 4.45 s   | 5.4 s  |
| mogadishu   | 12,148 → 24,295 → 14,062 → 14,023           | 14,065          | 734,397   | 35 ms  | 2.5 s          | 14.8 s   | 17.4 s |
| prisonbreak | none: the file's 13,754 links               | 13,478          | 708,045   | 73 ms  | 6 ms           | 34.9 s   | 35.0 s |
| prison      | none: the file's 45,686 links               | 44,906          | 2,291,928 | 122 ms | 6 ms           | 97.2 s   | 97.3 s |

That is about 20 µs per simulated tick and 50 ticks per link on dome. A file
that ships its source's walk links (`HAS_GAME_WALK_LINKS`) has no probe to
filter them, so every link is simulated, and on prisonbreak's denser collision a
tick costs about 50 µs ([cod/navigation.md](../cod/navigation.md#the-games-own-links)).
On a game server the bake runs in slices between the ticks, so its wall time is its CPU time plus
whatever the ticks take: dome's, through the real load path, is 5.2 s of slices
over 5.3 s (`tests/bots.test.ts`). Bots stand still for that long after a map
loads. How to bring it down is an open decision. The candidates are:

- validating lazily behind the probe, which passes very little that fails;
- baking on a worker thread;
- caching a graph per world and collision.

A slice cannot stop inside one link's simulation. Most links take well under a
millisecond, but a link that runs to its time limit takes longer: on dome the
longest takes 34 ms, and four take more than a 60 Hz tick. A tick waiting behind
one of those is late by that much.

The spawn points on both maps all lie by a node in the largest strongly
connected component: 495 of 508 usable nodes on dome, and 1,317 of 1,319 on
mogadishu. A spawn is grounded first, since spawn origins are authored above the
floor (about 2 m on dome).

## On a game server

`game-server/src/nav.ts` and `worlds.ts`; [docs/server](../server/README.md#navigation-and-bots)
has the rest of the server's side.

- **Baked as the world loads, never waited for.** `WorldRegistry` fetches the
  world's `navigation.source` beside its collision, decodes it, and queues a
  `NavBake` against that collision with `movementRules(world)` at the server's
  tick rate. The world is returned at once and its games are joinable. A missing
  or undecodable file is logged and the world has no graph; the load does not
  fail.
- **One slice at a time.** `NavBaker` is a loop that runs the oldest bake for
  `NAV_SLICE_MS` (5 ms) and then waits one turn of the event loop, where any
  timer that came due fires. The tick is one of those timers, so it waits behind
  at most one slice. The result is the same graph as a bake run in one go
  (tested).
- **Shared like the collision.** Every game on the map reads the one graph.
  Unloading the map cancels a bake still running.
- **One `NavMatchState` per match,** built on the first tick after the graph
  exists, with a blocker for each removable part. A match that started during
  the bake gets one when the bake finishes.
- **A bot stands still until then.** Its controller is not asked, and it is given
  an idle input each tick so that it is still stepped (falls, lands, can be shot).
  On a world with no graph it stands still for good.
- **A bot's controller is a `BotDriver`** (`game/bots/driver.ts`): its brain,
  the brain's memory and a motor. The match hands it a `BotTurn` each tick — its
  movement, the planner, its objective and a lazily built `BrainContext` — and
  queues the input it writes. The match's `NavPlanner` replaces the plain graph
  and state it had before, and is what `Match.navigation` returns.

## Open

- **Nothing has been seen in game**; every verdict here is the simulation's.
  The `K` view draws those verdicts ([debugging](debugging.md#navigation)).
- **A bot's path is not drawn.** The `K` view shows the graph, which the client
  bakes for itself; the path a bot is walking exists only on the game server.
  Showing it needs a dev-only message (`navDebug`, behind `NAV_DEBUG=1`) carrying
  each bot's remaining node ids, which nothing sends yet.
- **A stuck link is shut for the whole match.** The follower's verdict is
  deterministic (players do not collide with each other, and a push out of another
  actor restarts the measure — [crowding](actors.md#crowding)), so a link one bot could
  not cross another would not either; but a verdict caused by a bad start (a bot
  standing oddly after a fall) shuts a link that was fine. Nothing re-opens one.
- **A slice cannot stop inside one link's simulation** ([above](#budgets)), so a
  tick is occasionally late by up to one long link while a map bakes. Accepted
  for now.
- **A bot's input goes through the server's input rounding.** A bot stepped from
  rounded angles walks a link very slightly differently from the validation. It
  is well inside the arrival radius, but it is not the same run.
- **The follower's thresholds are feel numbers:** blocked at 30%, 30 ticks,
  four tries, a 3.5 m run-up. Each was set against real traversals
  ([cod/navigation.md](../cod/navigation.md#at-load)), not read from a game.
