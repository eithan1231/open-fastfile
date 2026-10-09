# Actors

An **actor** is a creature a game server runs that is not a player: a walker, a
dog, anything a gametype spawns in numbers. It has a kind, a brain, a capsule,
health and a blow, and nothing else. It has no class, no weapon, no input queue
and no prediction, and a snapshot carries it in twelve bytes.

| Where                                   | What                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `shared/src/game/actors/kinds.ts`       | `ActorKindDef` and `ACTOR_KINDS`: a kind as data                                    |
| `shared/src/game/actors/actor.ts`       | `ActorId`, `ActorSpec` (a spawn), `ActorState` (the wire), `ActorStateView`         |
| `shared/src/game/actors/assets.ts`      | A kind's catalogue creature read (`actorAssetsFor`), and one actor's `actorLook`    |
| `shared/src/game/actors/pose.ts`        | `poseActor`: a state and a look to its clips, on both ends                          |
| `shared/src/game/actors/sounds.ts`      | Which sound roles two snapshots of an actor mean, and its own noise between them    |
| `shared/src/game/bots/brains/zombie.ts` | The first actor brain: the seeker, plus `attack` within reach                       |
| `shared/src/net/messages/actors.ts`     | `ActorState`'s layout, and `MAX_SNAPSHOT_ACTORS`                                    |
| `shared/src/rig/actorRig.ts`            | `buildActorRig`: a catalogue body with its head rebound, playing the kind's clips   |
| `shared/src/rig/actorPoser.ts`          | Puts a rig into `poseActor`'s pose, for the client and the server                   |
| `game-server/src/actors.ts`             | `Actors`: one match's actors, owned by `Match`                                      |
| `game-server/src/bodies.ts`             | `Bodies.actor(kind)`: a scratch rig per body of each kind's creature, and its boxes |
| `client/src/net/actors.ts`              | `ActorsView`: drawn beside the scene, interpolated like a peer                      |
| `client/src/net/actorRigs.ts`           | `ActorRigs`: the rigs actors wear, kept between them and sharing each body's clips  |
| `client/src/engine/audio/actors.ts`     | `ActorVoices`: an actor's sounds, played from its snapshots                         |

## Why not a bot

A bot is a match member: a `Player` with the player's capsule, a weapon, the
soldier's clips, and its whole `PlayerState` in every snapshot. That is right for
something that should play like a person, and wrong twice over for a horde:

- **The wire.** A player's state is most of a hundred bytes, every tick. Twenty-four
  of them is a datagram of nothing else, and a dog does not have a weapon to send.
- **The body.** A bot is a soldier-sized capsule playing soldier clips. A dog is
  not either.

What an actor reuses is everything that is not a player: the brains and the
motor (`game/bots/`), the planner and the graph (`nav/`), `stepMovement` with the
kind's own capsule and speeds (`MovementParams`), and hit boxes on a posed rig.
Where it goes is not a player's business either: it is stopped by other clip,
walks other links, and crosses a traversal another way ([where it goes](#where-it-goes)).

## A kind

`ActorKindDef` is `MovementParams` (`radius`, `height`, `walkSpeed`, `runSpeed`)
plus:

- `health`, which a spawn may override (`ActorSpec.health`): a gametype prices it
  per round;
- `melee { damage, reach, cooldown, swing }`: a blow of `damage` lands on a player
  whose feet are within `reach` horizontally (and a metre vertically) of the
  actor's, and swings begin no more often than `cooldown` ([melee](#melee));
- `corpse`: seconds a dead one lies before it is taken out, never less than its
  fall lasts;
- `body?`: the catalogue creature it is drawn and shot as, `{ game, id }` naming
  `catalog/actors/<game>/<id>/` ([its creature](#its-creature)). A kind without
  one, or whose entry this catalogue lacks, is drawn as its capsule, moves at
  `walkSpeed` (a walker) or `runSpeed`, and is shot as an upright box of its
  size, a hit counting as `torsoUpper`.
- `sounds?`: what it sounds like, as roles mapped to aliases in one game's
  catalogue bank ([its sound](#its-sound)). Absent, it is silent.

**The zombie** is `t5/zombie_ger`, Kino der Toten's honour guard. It keeps the
player's capsule (0.3 m by 1.7 m) rather than the entry's `size` (the aitype's
32 by 72 in box, 0.41 m by 1.83 m): the graph's nodes were stood and its parts'
corridors sampled with a player's body, and the game's links pass close enough
to walls that a wider one would rub.
Its health is the aitype's 150, and the blow's numbers are placeholders a gametype
has not priced yet. **The TranZit zombie** (`zombie_transit`) is the same row with
another game's creature and sounds (`t6/zm_transit_basic`).

**Adding a kind** is a row appended to `ACTOR_KINDS` — never inserted, because a
kind travels as its index — and a brain for it in `BRAINS` if none fits. Every
kind walks the game's links ([where it goes](#where-it-goes)), which were
compiled for a human-sized AI: a kind much wider will be sent down links it does
not fit, and the follower calls it stuck and shuts the link for the match, for
every actor in it. Sixteen kinds fit the wire's four bits.

The creature roles (`CREATURE_ROLES` in `sim/characterDef.ts`) are `idle`,
`walk`, `run`, `attack`, `die`, `sprint`, and a climb per gait — `climb`,
`climbRun`, `climbSprint`, read from a clip set's `windowClimb` roles — each
posing the whole body. A look missing a role falls back to one it has
(`poseActor`; a sprint to a run before a walk, a sprinter's climb to a runner's
before a walker's).

## Its creature

A catalogue actor entry ([pipeline](../cod/pipeline.md#actors)) is several bodies,
several heads, a clip set whose roles list every variant the game picks among, and
one hitbox sidecar for all of them. `actorAssetsFor(kind.body, catalogue)` reads
it on both ends into `ActorAssets`: the files as `CatalogRef`s, and per role every
variant as an `ActorClip` — its name, length, root-motion ground speed and the
times of its `fire` notes. The entry's own `roles` replace the clip set's list for
that role (Kino's goose step), and the set's `death` is the engine's `die`. The
server gets the numbers from the catalogue index it already fetched
(`Weapons.catalogue`), so timing a blow needs no GLB and no three.js.

**Who wears what is drawn, not sent.** `actorLook(assets, seed, id)` picks a body
by `bodyWeights` (three in four honour guards wear `body2`), a head by
`headWeights` (uniform when absent), and one variant of each role, from
`hashString(`${seed}:${id}`)` — the match seed is `hashString(map)` on both ends.
The draws are made in a fixed order (body, head, then `CREATURE_ROLES` in order,
a role the look lacks still consuming its draw), so appending a role changes
nobody's walk. The hash is mixed through MurmurHash3's finaliser before seeding:
ids count up by one, and xorshift's first draw from two neighbouring FNV hashes is
correlated (0.2, measured) — runs of a dozen zombies in the same body.

Both ends must hold the same catalogue for their looks to agree, as they must for
a player's body; `catalogHash` covers the weapons only, so a server and a client
built from different actor exports would draw different walks without refusing
each other.

**A rig** is `buildActorRig`: the chosen body cloned, the head's meshes rebound
onto its joints by name (the exporter grafts the union of every head's joints into
each body, so any head fits any body), and the clips its skeleton keys. The
client builds one per look and keeps it (below). A server keeps one scratch rig per body, with no head
— a head adds no joint and stops no bullet — and poses each actor wearing it in
turn, handing `ActorPoser` that actor's look on every call.

## Its sound

An actor is heard by what its snapshots already say, so its sound costs no wire —
the rule a peer's footsteps follow ([audio](audio.md#diegetic-sound-costs-no-wire)).
A kind names its roles (`ActorKindDef.sounds`: a game, and an alias per role); what
a role _means_ is `game/actors/sounds.ts`, once for every kind:

| Role                | When                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `spawn`             | an id above any this browser has seen appears, after its first snapshot                                 |
| `attack`, `swing`   | the action turns to `attack`, or its phase starts over while it stays there                             |
| `death`             | it starts to fall                                                                                       |
| `ambient`, `sprint` | on its own while alive, every `VOCAL_GAP` (3–8 s), drawn from its id; `sprint` for a runner or sprinter |

A new id is an arrival only when it is above the highest seen, and never in the
first snapshot of a match: an id appearing is also a player joining late, or an
actor coming back into the nearest 64, and neither is a spawn. The gap between its
own noises is this engine's choice and not a game's; the games' vocals are script
loops and animation notetracks, which nothing plays yet.

`client/src/engine/audio/actors.ts` plays each at the actor's mouth (nine tenths
of its height) on `sfx`, through `AudioSystem.playAt` with the kind's game, so a
creature of one game keeps its own recordings on another game's map, as a weapon
does, and is culled by the alias' own distance. Its bank is asked for as it is
first seen, so its first swing is not the one that waits for the table.

`pnpm catalog` resolves every kind's roles against **its own game's** bank and
exits non-zero on one it lacks.

## Gait

A CoD zombie is a walker, a runner or a sprinter, which the script decides per
zombie as the rounds go on. `ActorSpec.gait` is `walk` (the default), `run` or
`sprint`; it travels on the wire and picks the look's clip for `move`.

**Its speed is its clip's.** CoD moves an AI by its animation's root motion, so a
zombie's speed is whatever its walk covers: 0.58 to 1.21 m/s for the seven walks,
1.66 to 2.75 for the five runs, 3.54 and 3.61 for the sprints
([reference](../cod/reference.md#ai-bodies-black-ops-zombies)). `Actors.spawn`
gives each actor `MovementParams` of its own — the kind's capsule, both speeds set
to its gait clip's `rootMotion.speed` — so the motor's walk and run are one speed.
A clip that stands, or a kind with no creature, falls back to the kind's speeds.

**It rides over kerbs a player's walk would clear** (`MovementParams.rideKerbs`).
A player's step up is made at the length of one tick's move, 5 cm at a walk; a
walker's is a centimetre, which sets the capsule down on a thin threshold's corner
rather than past it, and it slid back off every tick — theater's foyer held a
walker for ten seconds. An actor's step reaches a body's radius ahead at least,
and stands on the corner when it lands on one. A player's step is untouched, and
pinned bit for bit by tests/movementParams.test.ts.

**Its cycle turns with the ground covered**, not with time: each tick adds the
distance moved over the distance one cycle of the clip covers (`speed × duration`),
so at its own speed the clip plays at its natural rate and the feet do not slide,
and a zombie slowed by a corner slows its legs too. Standing, the cycle holds, so
it walks on from the same foot. Below half the clip's speed the idle fades in
(`poseActor`), which is what starting and stopping look like.

## Melee

A swing begins when the brain's goal is `attack`, the target is in reach and the
last swing began at least `max(cooldown, its clip's length)` ago. It plays the
look's `attack` variant from the start, and **a blow lands on each of that clip's
`fire` notes**, as CoD's melee loop calls `melee()` on each
([reference](../cod/reference.md#ai-bodies-black-ops-zombies)) —
`ai_zombie_attack_v4` hits once at 0.27 s, `_v2` five times over 7.2 s, a run
attack as early as 0.1 s — each only if the target is still in reach.

**Which swing** is the look's: drawn from `ActorAssets.swings[gait]`, which is
`attack` plus `walkAttack` for a walker, or plus `runAttack` for a runner or
sprinter — the pool CoD's `pick_zombie_melee_anim` draws from. CoD draws again
for every swing; here one is drawn per actor, because a fresh draw per swing
would have to reach the client, and the wire has no room left to say which. The
swing is played on the spot, however much its clip walks. It ends at the clip's end, or
as soon as the target leaves reach, dies, or the brain wants something else; one
cut short holds the next back by the kind's cooldown only, so a zombie that drew
the seven-second clip is not left standing for six seconds once its quarry steps
back in. A kind with no attack clip swings for `swing` seconds and lands its one
blow as it starts.

## Where it goes

An actor moves by the source game's AI rules, not a player's, in three ways.

**It collides on the `ai` channel.** `Actors` is handed
`CollisionWorld.view(presence, "ai")` (`Playing.actorCollision`): the solid
world and every clip whose `blocks` names `ai`, and not the clip that names only
`player` ([collision](collision.md#channels)). The same presence, so a door part
stops it while present and a window's AI clip does too, until a script removes it.

**It walks the game's own links.** The graph's verdict on a link is a player's:
the bake walked it with the player's capsule, collision and moves. An actor goes
by an actor's instead (`actorMover`, [navigation](navigation.md#movers)): every
link the game compiled — a walk, or a traversal whose kind has a motion — trusted
as the game compiled it for its AI, whatever our player made of it. Each match
holds an actors' planner beside the bots', over the same graph with blocked links
of its own; a removable part's actor links are found against the `ai` channel,
so a window clip shuts the climb through its window and a player clip shuts
nothing. A script's blockers go to both.

**It crosses a traversal by playing it.** Its motor walks to a traversal link's
begin, stands, and hands the link over (`Motor.traversal`). The runtime then
moves the body from where it stands to the end node's feet, ignoring collision,
and faces along the link:

- a link whose animscript the set has a clip for (`zombie_jump_down_190`, in its
  `traversals`) plays that clip. It takes the clip's length, and the body follows
  the clip's root path stretched onto the link's ends (`stretched`), so it
  crouches, leaps and falls as the clip does rather than sliding down a line;
- a climb (`MANTLE_OVER`, `MANTLE_ON`) its look has a clip for takes that clip's
  length, moved in a straight line;
- anything else — a quad's wall drop, which no walker's set plays — is moved in a straight line at the actor's speed across, and down
  in the time a body would fall, and is drawn walking (`move`).

The first two are `traverse` on the wire, the phase the crossing's progress, so a
client plays the same clip in step with the body it moves. Which clip is
`ActorState.traversal`: 0 for the gait's climb, or the jump's index in the set's
`traversals` plus one, sent in the six bits the speed takes otherwise (a traverse
never reads a speed).

At the end it stands on the end node's feet with no velocity and tells the motor
(`traversed`), which goes on from there. Nothing thinks for it in between: the
brain is not asked, no swing begins, and one that dies part-way falls where it is.

## A tick

`Match.step` steps the actors **after the players' inputs and before health**
(`stepActors`), so a blow that kills starts its victim's countdown on the same
tick, and a brain sees players where this tick left them. In spawn order:

1. A dead actor is taken out once its `corpse` time is up, and does nothing else.
2. A living one is thought for by its brain, through the bots' `BotDriver` over
   the actor: its `BotSelf.id` is its key (`#a` and the id), its side undefined,
   and it is not asked until the world's graph is baked — it stands, as a bot
   does.
3. It is stepped through `stepMovement` with its kind's capsule at its gait's speed,
   against the `ai` channel. One crossing a traversal is moved along it instead, and one whose
   motor has just handed it a traversal begins crossing it
   ([where it goes](#where-it-goes)); neither is thought for, falls or swings.
4. Below the world's kill plane it dies, `outOfWorld`, past a script's say.
5. It is pushed out of the actors it yields to ([crowding](#crowding)).
6. Its gait cycle turns by the ground it covered ([gait](#gait)).
7. Its swing goes on, lands or ends, or one begins ([melee](#melee)); a blow is
   queued as `melee`, by nobody.

A brain asks for a blow with the goal `attack { target }`. The motor only stands
and faces the target; the blow is the runtime's, because it is the kind's number
and cooldown and not the brain's. A bot given `attack` stands and faces, and hits
nothing.

## Crowding

Two living actors never stand in one place (`Actors.separate`). Right after its
step, an actor is pushed out of every capsule it overlaps among those it **yields
to**: every older actor, which has already been stepped this tick, and any actor
crossing a traversal, which nothing moves. The younger always yields, so one pass
in spawn order settles a crowd the same way on every run, and the oldest in a
crush is never held: a queue at a window always moves.

- The push is at most `SEPARATION_SPEED` (4 m/s), so a pile at one spawn point
  spreads over a few ticks. Feet exactly on top of one another go each their own
  way round, by the id's golden angle; one way for all would line them up.
- The world has the last word on where it lands (`resolveCapsule` on the `ai`
  channel), and the velocity into the other body is taken off, as a wall's would
  be, so one held head-on fades to its idle rather than marching on the spot.
- Walking straight into one, as two on one link do, the push leans to its own
  right, so it steps round rather than being shoved back down the link.
- **A push is not being stuck.** It tells the motor (`Motor.jostled`), which
  measures the leg's progress afresh from where it was left. Without that, a
  walker shoved half a metre back cannot win it back inside the follower's 30
  ticks, and a link it was queueing on is shut for every actor in the match.

Players are not in it: an actor still walks through a player and a player
through it. A dead one stops nobody.

## Damage

Both ways go through the match's one damage queue, so a hook that hurts something
never recurses.

- **An actor hitting a player** is `melee` with `by` null and the actor in
  `DamageEvent.actor`, which `playerDamage` sees and `playerDeath` is handed as a
  fifth argument. `by` is null because an actor is nobody: the death is a suicide
  by the kill feed's rule (`isSuicide`), scores no side a point, and reads as the
  victim and how. A gametype that pays for kills does so in its own hooks.
- **A player hitting an actor**: a round is traced against the players and then
  the actors, nearest wins, each judged where the shooter saw it (an actor keeps
  half a second of history, as a player keeps a second). The cost is the weapon's
  arithmetic (`shotDamage`), then the `actorDamage` hook has the last word, as
  `playerDamage` does. A hit that cost something
  draws the shooter a hit marker. The one that kills fires
  `actorDeath(ctx, actor, by, cause, location)`, once.

**A dead actor** lies playing its `die` variant for its kind's `corpse` seconds, or
as long as the fall lasts if that is longer, and is then taken out; `actors.remove` takes one out at once, dead or alive. A body lying
there stops no round and takes no more damage.

## The wire

`ActorState` is 96 bits: a 16-bit id, the kind's index (4), the feet quantised to
1/64 m over ±1024 m across and ±256 m up (17 + 15 + 17), yaw (8), the gait (2),
the action (`idle | move | attack | die | traverse`, 3), speed along the ground
(6, an eighth of a metre a second up to 8 m/s: it only fades the idle in) and the
phase (8). For `traverse` the speed's six bits carry `traversal` instead — which
jump clip plays, which the client cannot see for itself — so the action goes
before them and the reader knows which it is reading. `dead` is not sent: it is exactly `action === "die"`, and the reader
derives it. The phase is through the idle clip's loop for `idle`, the gait cycle
for `move`, through the swing or the fall for `attack` and `die`, and through the
climb or the jump for `traverse` — each a share of the look's own clip (a two-second idle,
the player's stride and a one-second fall for a kind with none).

A snapshot's actors are their own array after the players, eight bits of count,
so a snapshot with none grows by one byte. **Appearing is a spawn and
disappearing a despawn**; there is no other message for either. Past
`MAX_SNAPSHOT_ACTORS` (64, 768 bytes) each player is sent the 64 nearest them,
nearest first, and one who is seated but not spawned the 64 oldest. An actor
beyond the quantised range is drawn at its edge while the server simulates it
where it is.

An actor's id counts up from 1 and is never reused in a match; the 65,536th
spawn throws.

## Determinism

The rules bots follow, and for the same reason: two runs of one match must play
out the same (`game-server/tests/actors.test.ts` runs one twice). A brain's rng is
seeded from the match seed and the actor's key; its clock is the tick; thinks are
scheduled by tick and offset by the actor's id; actors are stepped in spawn order,
after bots; and `Math.random` and `Date.now` are banned over `game/`.

## Drawing one

`client/src/net/actors.ts` owns a root added straight to the scene, beside the
world, for the reason corpses do (CLAUDE.md): the built world's matrices are
frozen and its shadow map is not redrawn, so it updates its own matrices and no
actor casts a shadow. Each actor keeps the last two snapshots and is drawn one
tick behind the newer, feet and yaw interpolated, posed from the newer's action
and phase. `WorldSession`'s "actor bodies" step loads the creature of each kind the
gametype's scripts declare they may spawn (`Script.actors`) — the clip file, every
body and every head, through the session's `AssetStore` at
`assetUrl.ts`'s URLs — and hands `ActorsView` the kits with the seed. Each actor is
then a rig of the body and head its look names, posed by `ActorPoser` with its
look's clips; one whose body did not load, or whose kind has none, is its capsule,
lying down once dead. A kit that will not build is said once and dropped, and the
rest of its kind are capsules. Leaving a world drops the kits; the files are the
store's to free.

**A rig outlives the actor wearing it.** A round spawns and kills a creature every
second or two, and building each from nothing — the body cloned, the head rebound,
every clip's tracks copied, about 3 MB for a zombie — was a stutter the browser
paid for in garbage collection. So `ActorRigs` keeps a gone actor's rig for the next
one in the same body and head, and every rig on one body shares the clips the first
fitted (`FittedClips`): clips are read-only, and each rig's mixer binds its own. What
is kept is bounded by the most actors that ever stood at once, and is let go — mixer
and bone textures, the rig's only GPU memory of its own — when the kits change or the
match ends.

With no peers to take it from, a shot names the tick the actors were drawn at, so
it is judged where the shooter saw them.

## Known rough edges

- **An actor's sound is six roles and a timer.** The clips carry the games' own
  sound notetracks (`sndnt#zmb_attack_whoosh` at the swing, `sndnt#fly_step_zombie`
  on every footfall, the vocals by name), and none of them is played: a swing
  whooshes as it starts rather than on its note, and a zombie's feet are silent.

- **One swing per actor.** CoD picks a swing afresh each time; an actor here
  swings the one its look drew, every time ([melee](#melee)).
- **A swing's clip does not move it.** The walk and run swings carry 1.1–2.7 m/s of
  root motion and `attack_forward` up to 0.48 m/s, none of it played: the motor
  stands for `attack`, so a zombie marches on the spot while it swings.
- **Actors and players pass through each other.** Actors keep apart from one
  another ([crowding](#crowding)), but a zombie can still stand inside a player.
- **Crowding is greedy, not planned.** Nothing routes a zombie round a crowd; it is
  pushed and steps round. One standing still on a narrow walk (a brain that failed,
  an idle one) holds the younger ones behind it for as long as it stands there.
- **No actor rides a ragdoll.** A dead actor plays `die`; it has no physics body.
- **A climb is a straight line.** The body is moved from begin to end at an even
  rate while its climb plays, whatever the clip's own root motion does over the
  sill; nothing checks the two agree. A jump down follows its clip's path.
- **A crawler would jump like a walker.** The traverse scripts give a legless
  zombie its own `crawl_jump_down_*`; there is no crawler yet to need them.
- **Nodes and part corridors are a player's.** Where a node stands, whether it is
  usable, and which links a part's corridor fills were all measured with a
  player's body on a player's collision; only the links themselves are the
  actor's own.
