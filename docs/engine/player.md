# The player

How a player moves and fights, and the data that makes that happen.

The code is `packages/shared/src/sim/`, in **`@3d/shared`** rather than the
client, because a server re-simulates every player's input to check it and must
run byte-for-byte the same step. Nothing in there imports three.js or touches a
device: `packages/client/src/engine/controls/firstPerson.ts` is the only part
that reads a keyboard and moves a camera, and it lives in the client.

```
keyboard, mouse ─▶ FirstPersonControls ─▶ PlayerInput ─▶ Player.step ─▶ PlayerState
                   (controls/firstPerson)  (input.ts)     (player.ts)     │
                   polled per frame,                                      ├─▶ camera (local, interpolated)
                   stepped per tick                                       ├─▶ Viewmodel (local, drawn)
                                                                          └─▶ the game server, with the input
                                                                              that produced it (net/connection)
```

| File                                      | What                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `shared` `sim/input.ts`                   | `PlayerInput`: one step's command                                      |
| `shared` `sim/movement.ts`                | `stepMovement`: which move owns a step, and the sprint rule            |
| `shared` `sim/movementState.ts`           | `MovementState`, the body, and the numbers more than one move reads    |
| `shared` `sim/movementEnv.ts`             | `MovementEnv` and `Carry`: what a step is made in, and with            |
| `shared` `sim/moves/walk.ts`              | Walking, running, jumping, falling and landing                         |
| `shared` `sim/stepSlide.ts`               | The end of a free step: the move, the step up and down, the ground     |
| `shared` `sim/stance.ts`                  | Standing, crouched and prone: the hull, the eye, and where a body fits |
| `shared` `sim/view.ts`                    | The caps a move puts on the view, for the step and the camera alike    |
| `shared` `sim/gait.ts`                    | The stride clock and the pose blends                                   |
| `shared` `sim/moves/ladder.ts`            | The world's ladders, the grab and the climb                            |
| `shared` `sim/weapon.ts`                  | `WeaponController` and `WeaponData`: the held weapon's state machine   |
| `shared` `sim/weaponDef.ts`               | `WeaponDef`: what a weapon _is_, read off the exporter's GLB           |
| `shared` `sim/weaponRegistry.ts`          | The catalogue: every weapon both ends can build, and its `hash`        |
| `shared` `sim/player.ts`                  | `Player`: steps both on one input; `snapshot` / `restore`              |
| `shared` `sim/capsule.ts`                 | `CapsuleWorld`: the three.js-free view of collision a step gets        |
| `shared` `sim/moves/mantle.ts`            | The world's mantle volumes, the query a step makes, and the move       |
| `client` `engine/controls/firstPerson.ts` | Devices → `PlayerInput`, the held pose, the camera                     |

## State for the network

Everything that changes as a player plays is one plain object,
`Player.snapshot()`, a `PlayerState`: `movement` (feet, velocity, view angles,
ground and jump timers, the [stance](#stance) and the eye's way to it), `weapon` (`WeaponData`), and **which** weapon that is —
`weaponIndex` into the weapon catalogue plus `attachments`, the slots the fitted
ones occupy in that weapon's own list, `swapping`, and `stowed` (the weapon is
away for a climb, see [below](#the-weapon-on-a-climb)). The weapon on their
back travels too (`spareIndex`, `spareAttachments`, and `slot` for which of the
two is in hand), with `armed`, a count of the times the player has been handed
weapons. A server re-arming somebody mid-life — a respawn, a class taking effect,
a script's `arm` — changes that count, and `restore` rebuilds both weapons fresh
from the state rather than keeping a spare the client had emptied. A swap the
client mispredicted corrects by `slot` alone and keeps both magazines. It
is JSON-safe: no three.js values and no `Infinity`. That is what a server sends to peers, and
`restore` is how a client adopts a correction. `tests/player.test.ts` runs a
JSON copy in lockstep with the original, and `tests/movement.test.ts` does the
same for movement alone, so a field left out of the state fails a test.

`PlayerInput` is the other half: absolute view angles, the movement axes, and
run, jump, crouch, prone, fire, aim and use held, reload and swap pressed. Angles
are absolute, not deltas, so a lost command cannot skew the aim; `crouch` and
`prone` are levels for the same reason, and whether a key holds or toggles one is
the client's business ([below](#stance)). A server that holds a player's
state and replays their inputs reproduces what the player saw.

**`use` is a level, and the server takes its edge.** Nothing in the step reads
it. It is held on the wire for every tick the key is down — a tap between two
ticks still reaches one, as a reload does — and the game server keeps whether
the last input spent held it, so a press is the input where it goes from up to
down however long it is then held, and a lost datagram delays a press rather than
eating it. On that input the server works out the player's focus from where they
stood and the input's own angles, and hands it to the gametype's `interact`
([scripting](scripting.md#areas-and-the-use-key)). Bots and actors never set it.

Not in the state, on purpose:

- **World rules**: the spawn point, the kill plane, the mantle volumes and the
  ladders (`setSpawn`, `setKillPlane`, `setMantles`, `setLadders`, all applied
  by `sim/worldRules.ts`). They come with the world, not the player. What
  passing the kill plane _does_ is `setFallOut`: `respawn` puts a player walking
  a world on their own back on the spawn, and `die` — both ends of a match —
  holds them where they fell for the game server to kill, `outOfWorld` and
  nobody's. The hold is derived from where they are rather than kept, so a
  client replaying from a correction stops at the same step the server did. The climb
  _under way_ is player state and is on the wire; the volumes and ladders it
  could have started from are not.
- **Local presentation**: the camera, the held pose (`FirstPersonControls`),
  the view's turn, the viewmodel's clips, sway and bob
  (`engine/viewmodel.ts`, `engine/weaponMotion.ts`). A peer derives its own
  from the state it receives. Both kicks are state rather than presentation, for
  the two different reasons [below](#recoil-is-two-kicks).
  Which weapon is held **is** in the state now, and is the one field that is not
  self-describing: it travels as an index into the weapon catalogue
  (`sim/weaponRegistry.ts`), because a name would cost ~72 bits in every snapshot
  for every player where an index costs 9. Both ends fetch the same catalogue over
  HTTP, and a game server refuses a join whose `catalogHash` disagrees with its
  own — the failure that guards against is a player silently holding the wrong gun.
  `Player`'s own API stays in ids (`equipById`, `weaponId`); only the state is in
  indices.

`restore` rebuilds the weapon when the state names a different one, so a peer who
changes weapon is followed. `reanchor` is the movement half of it. A server calls
neither for a client's claim: a claim is the feet alone, compared and never
adopted.

## One step

`Player.step(input, dt)` runs the weapon first and then movement. The weapon
reads only the input. Movement asks the weapon two things: whether a sprint may
run (`WeaponController.sprinting`), and whether it is aimed or firing
(`braced`), which holds a prone body still. Nothing else connects the two.

**The step is `stepMovement(state, input, dt, env, carry)`** (`sim/movement.ts`).
`env` is what the step is made in and does not change while a world is loaded
(`MovementEnv`, `sim/movementEnv.ts`): the collision `world`, the `mantles` and
`ladders` the world declares, and the `body` — a `MovementParams`, the capsule,
its two speeds and its `footing`. A player's is `PLAYER_MOVEMENT`
(`tests/movementParams.test.ts` holds a digest of its step); an actor's kind names
its own ([actors](actors.md)). `carry` is what is in the hands, as far as movement
cares: whether it lets a sprint run, and whether it is `braced`.

The step returns the stance it held the player to against the keys it was given,
or null (`Player.forcedStance`). Nothing in the simulation reads it; it is for
whoever turned a key into the input.

**Exactly one move owns a step**: `state.move` is `walk`, `mantle` or `ladder`,
a union, and each is a module under `sim/moves/` that the step dispatches to.
A move's own fields (a mantle's ledge, a ladder's facing) exist only while it is
the one under way, on the wire as in the state. Every free step ends in
`sim/stepSlide.ts`, which moves the capsule, keeps it out of the world, steps it
up and down, and says whether it ends on the ground.

## Recoil is two kicks

Call of Duty's weapon files carry two recoil families, and reading them as one is
the mistake that reads as "this gun has no recoil":

- **`*GunKick*`** rocks the weapon _model_ in the player's hands. It is a
  second-order system — an impulse into a speed, an acceleration cap, and two
  decays — and it draws nothing but the viewmodel. `engine/weaponMotion.ts` adds
  it to the rig's pose.
- **`*ViewKick*`** punches the player's **aim** off target and walks it back at
  `ViewKickCenterSpeed`. It is first-order: a shot adds an angle and the rate
  brings it home. This is the recoil a player fights, and it is the one a shot's
  direction is bent by — `aimAngles(intent, viewKick)` in `sim/recoil.ts` is the
  single definition of it, read by `FirstPersonControls.placeCamera` on one end
  and by `Shots.fire` on the other.

### Trace, then kick

A bullet is away before the weapon has recoiled, so a round fired on a step is
traced along the view kick as it stood **before** that step's own impulse — which
is also the aim the player last saw drawn. It has to be said out loud because
`Player.step` runs the state machine and `stepRecoil` in one call: by the time
`Shots.fire` sees `fired` advance, the kick already carries the impulse of
the very round it is about to trace. `Match.step` copies the kick before stepping
and hands that copy down. Left as it was, a scoped L96's first round left over
four degrees above its own crosshair — nearly four metres at fifty, on a rifle
whose whole point is the first round.

The camera is deliberately the other way round: `placeCamera` reads the kick as
it stands now, because the view genuinely does move — that is what view kick is.
Only the bullet is held to the older aim. The client's `ShotTraceView` traces
along the kick as of the previous frame, for the same reason and with the same
answer ([diagnostics-shottrace.md](diagnostics-shottrace.md)).

A step fires at most one round today, but `Shots.fire` takes the shot
counter's difference rather than asking whether it moved, and traces every round
in it along that one pre-step aim: they left within a step of each other, and it
is the last aim their shooter saw. Masked rather than subtracted, because `fired`
is a uint16 on the wire. **The cone below is the same case in the same shape** —
a round is sized by how hot the weapon was before its own `fireAdd` widened it —
but the cone's own draw is per round, because two rounds of a burst share an aim
and must not share a deviation.

## A round leaves in a cone

A bullet does not go down the crosshair. It goes somewhere inside the cone the
weapon's `spread` block allows, and closing that cone is what aiming is for. The
whole model is Modern Warfare 3's own, read out of `iw5mp.exe` — the derivation,
the addresses and a script that checks them again are in
[`reverse/iw5-bullet-spread/`](../../reverse/iw5-bullet-spread/README.md).

Three pieces, all in `sim/recoil.ts`:

1. **`WeaponData.spread` is how hot the weapon is, 0 to 1 — not an angle.**
   `stepSpread` adds `fireAdd` a round and `moveAdd` while moving, and decays at
   `decayRate`. All three of those weapon-file numbers are fractions of the gun's
   own `hipStandMin`→`hipStandMax` range, which is the trap: read as degrees, an
   M4's `fireAdd` of 0.6 takes six rounds to do the two it should and its decay
   is fifteen times too slow. **Neither add runs at a full aim**, so a weapon
   fired down the sights only ever settles.
2. **`shotSpread` turns that into degrees**, as two interpolations rather than
   one. The hip cone runs `hipStandMin`→`hipStandMax` with the heat; the aimed
   cone runs `spread.ads`→`hipStandMax` with it; and the aim fraction mixes the
   two. The consequence is worth knowing: **at full heat the two ends are equal**,
   so a saturated weapon is no more accurate aimed than hip-fired. Aiming stops
   the gun opening; it does not cool it down. What makes aiming accurate is that
   `spread.ads` is 0 on everything but a shotgun and a few pistols.
3. **`spreadDirection` places the round**, drawing a bearing and a radius from
   that shot's own stream (`coneSample`, draws 4 and 5 — after the gun kick's two
   and the view kick's two). The radius is the **raw** draw and deliberately not
   its square root: the game takes no square root, so its cone is centre-weighted
   and the average round lands a third of the way out. Sampled uniformly by area
   — the textbook correction — every weapon would be twice as inaccurate as its
   own numbers describe.

**The hip cone follows the eye, not the stance.** A weapon carries a min and max
for standing, ducked and prone, and `shotSpread` blends between two of the three
pairs by how high the eye is (`eyeHeight`): prone into ducked below the crouched
eye, ducked into standing above it. So the cone tightens across the whole of a
change of stance, and a round fired halfway down is halfway there. A weapon with
no pair for a stance uses the one above it. The server measures the eye after the
step the round was fired on, as it does the rest of the shot.
`turnAdd` is 0 on all 135 catalogue weapons.

### The server owns the cone

Nothing about a shot's deviation crosses the wire. The client sends buttons and a
look direction; **this server decides the cone's width from the weapon's own
numbers and where in it the round goes from a seed it derives itself** — the
player's id hashed, mixed with the round's ordinal. So there is no cone to forge
and no accuracy to send. The client predicts the identical deviation from the
identical seed, which is what lets `ShotTraceView` draw a ray that matches the
server's.

**Aiming faster than the weapon allows is already impossible**, and was before
any of this: `PlayerInput` carries `ads` as a _button_, never a fraction. The
server runs its own `updateAds` against the weapon file's `adsIn`/`adsOut` times
and its own state machine, so a client that claimed to be fully aimed the instant
it right-clicked would be judged by this server's fraction regardless. That is
the same reason rate of fire, magazine and reload gating cannot be forged: the
only thing a client sends is what it pressed.

### Showing it to the player

The crosshair's gap **is** the cone. `App.updateCone` divides the cone's tangent
by the tangent of the camera's half field of view, which makes it a fraction of
half the screen's height, and `hud.cone` carries that to `Reticle.tsx` — so the
widget places its four arms with `calc()` and needs no camera, no field of view
and no resize listener. The camera's live `fov` rather than the resting one, so a
weapon that zooms to aim does not also appear to open its cone.

The crosshair is also the one widget that goes away, and `hud.ads` is why: the
weapon's own aim fraction rides beside the cone, and `ui/hud/Reticle.tsx` fades
the arms out across it, gone by `CROSSHAIR_GONE_BY` of the way down the sights.
Aiming replaces the crosshair with the weapon's sights, so one still on screen at
a full aim is a second reticle floating beside the real one. The hit marker is
deliberately not part of the fade: a scoped shot still has to say that it
counted.

These are the two HUD numbers that are the client's own prediction rather than
the server's answer, against the rule in `app/hud.ts`. It is written by `App` and not
by `Hud` for exactly that reason: it is a pure function of inputs this browser
already has, the server re-simulates it to the same value, and a crosshair that
waited a round trip to open would show the player their accuracy as it was a
tenth of a second ago. Health and ammunition are the opposite case.

Every scoped sniper rifle in Modern Warfare 3 has an `adsGunKickPitch` of exactly
0 and does all of its recoil through `adsViewKick`, so a build that fed the gun
kick to the aim gave a scoped sniper no recoil at all and a hip-fired one a kick
in whichever direction its model happened to be authored.

Both are simulation and both are on the wire. The view kick has to be, because
the server judges the shot; the gun kick is because a corrected client should
rock its gun the way the tick it was given did.

**Neither is ever written into `movement.yaw`.** `viewYaw()` reads the movement
state, `readInput` sends it as `PlayerInput.yaw`, and `stepMovement` assigns it
straight back — so a kick stored there is read as intent on the next tick and
climbs until the gun points at the ceiling. It is added at _read_ time, in
`aimAngles`, and `tests/recoil.test.ts` empties a magazine to prove the mouse is
still where it was left.

### The view is thrown, not stepped

A round does **not** add an angle to the aim. It sets an angular **velocity**,
and `ViewKickCenterSpeed` is the acceleration that brings it back — which is why
those weapon-file numbers are in the hundreds and thousands rather than the ones
and twos an angle would need. The view is thrown, decelerates, turns over and
falls home: the _bounce_ the games have. An angle added outright puts the whole
of a round's kick on a single frame, which reads as a jolt however small it is
made, and that is what this used to be.

The model is Modern Warfare 3's `UpdateKickAngles`, read out of `iw5mp.exe` with
the Xbox 360 build's symbols — which is how the function was found at all, and
how `kickAVel` turned out to be a velocity ([`reverse/iw5-view-kick/`](../../reverse/iw5-view-kick/README.md)).
Per axis, in fixed 5 ms sub-steps: the acceleration opposes **where the view is**
rather than where it is going; a step that travels back toward the aim keeps only
`VIEW_KICK_RETURN` (0.06) of itself; and reaching the aim point zeroes the angle
_and_ the speed rather than swinging through, so a settled weapon is exactly at
rest.

Three things fall out of that, none of them a rule anyone wrote:

- **A magazine climbs, up to the engine's own stop.** One bounce lasts about
  `5 v / a`. A weapon firing faster than its own bounce starts each round part way
  up and walks. `UpdateKickAngles` pins the angle at **±10°** and zeroes the speed
  with it, which is what keeps a weapon whose rounds outrun its own recovery — a
  Desert Eagle is 70 units of throw against only 600 of pull — from walking the
  view off the top of the screen. `VIEW_KICK_LIMIT` is that stop, read from the
  binary rather than guessed.
- **Hip fire does not raise the screen.** Same weapon, same rule: an ACR's hip
  pitch of 10 against 1500 is a 0.034 s bounce inside its 0.085 s between rounds,
  so the view is home before the next one leaves. Its aimed 33 against 1350 is
  0.124 s, which is not. A whole hip magazine moves the aim 2°; the same magazine
  aimed walks 15°.
- **Recovery is quick and does not grow with the burst**, because the fall is the
  weapon's own acceleration over the height it reached — an ACR is home 0.27 s
  after the trigger, whether that was five rounds or thirty.

**`VIEW_KICK_SCALE` is the only tuned number** — degrees a second of thrown view
per unit of a weapon file's `ViewKick` numbers. It scales the impulse and the
acceleration alike, so it moves how far the view travels and never how long it
takes: every timing above is a ratio of two of the games' own numbers and holds
at any scale. Turn that one line to make every weapon kick more or less, in
proportion.

The speed rides on the wire beside the angle (`net/messages/player.ts`), because
a client corrected to a server's snapshot has to resume the same fall.

## The fixed tick

Friction and gravity integrate per step, so the same input stepped at 60 Hz and
at 144 Hz does not land in the same place. A server re-simulating a client has to
take the steps the client took, so the step length cannot be whatever the display
managed. `FirstPersonControls.update` accumulates the frame's `dt` and runs zero
or more fixed steps of `1/TICK_RATE`; the server sends its own rate in `joined`
and `setTickRate` adopts it, so 60 Hz is a default rather than a shared constant.
Nothing under `sim/` changed — it always took `dt` and kept no other clock.

Three things about it are easy to get wrong, and all three are load-bearing:

- **Most frames run no tick.** At 144 Hz with a 60 Hz tick, well over half run
  none. `takePressed` clears as it reads, so reading the devices inside the tick
  would throw away any tap landing on a tickless frame — reload and jump would
  simply not register, occasionally, on a fast display. So devices are polled
  every frame and presses are latched until a tick spends them, which also means
  a tap reaches exactly one tick when a frame runs several.
- **The camera interpolates position, the eye's height and the view kick, but
  not the aim.** It
  draws between the last two ticks by `accumulator / tickDt`, and snaps instead of
  sliding when a tick moved the feet further than a sprint could. The player's own
  angles are the live ones: a tick of latency on aiming is felt immediately, and
  position is not. The **view kick** is interpolated with the position
  (`previousKick`), because it is simulation and moves once a tick while the
  camera is placed every frame — drawn live it is a staircase, and a round's whole
  upward throw lasts about a tick and a half, which is exactly the range where
  that reads as a stutter rather than as a kick. A round is already traced along
  the kick as it stood before its own step, so a camera a fraction of a tick
  behind the simulation is if anything closer to where the round went.
- **The input is rounded before it is stepped.** `roundInput` and `roundDt` from
  `net/messages/input.ts` — the symmetry rule in `net/packet.ts`. Quantized
  fields are lossy, so a client must step the value the server will decode rather
  than the one the mouse produced, or the two diverge over an error the encoding
  invented. This happens whether or not anything is connected, so that being
  online never changes how the game plays.

`arrive()` is what a placement calls: it drops the interpolation state and the
input the devices are holding, since the frame loop is stopped while a world
loads and nothing has drained `takeLook()` in that time.

Below about 20 fps the simulation runs slower than wall time, because the render
loop caps `dt` at 1/20 s. That is not new and it does not desync anything — the
server steps only the inputs it receives, so a slow client moves slowly and
stays consistent — but it does mean tick rate follows frame rate at the bottom
end.

## What the server does with it

`@3d/game-server`'s `match/` replays the same inputs through the same
`stepMovement` against the same collision, and its answer is the one every
snapshot carries: the client takes it whole and replays its unacknowledged inputs
on top. Where the client said its feet came to rest travels with each input and
is only measured against that answer. The rest, including the two known reasons
the two ends disagree today, is in
[docs/server/README.md](../server/README.md#the-match).

## What a player can do

Keys add acceleration towards a target speed and friction takes it away, so
stops take a moment. Every number is the games' own, written in their units
(`sim/units.ts`: one is 2.54 cm) in `sim/movementState.ts`, `sim/moves/walk.ts`
and `sim/stepSlide.ts`; where each comes from, and what was read to find it, is
[reverse/iw5-pmove](../../reverse/iw5-pmove/README.md).

- **The body** is a capsule of radius 15 and height 70, with the eye at 60,
  standing. Crouched and prone it is shorter, and so is the eye: see
  [stance](#stance).
- **Walk** at 190 units a second forward, 0.8 of that sideways and 0.7 backward.
  A diagonal is no faster than its faster axis.
- **Run** at 1.5 times the walk, with one definition for movement, the weapon
  and the pose alike (`wantsSprint`): run held, moving forward, jump not held,
  walking, not in a jump, and standing or with the head room to stand. The
  weapon must allow it as well: firing, aiming
  or reloading drops the player to a walk until it is done. A sprint's sideways
  share is 0.667.
- **Sprint to fire.** The trigger takes the weapon out of a sprint, and the round
  leaves when the sprint-out is done — the weapon file's own `sprintOutTime`,
  0.2 s on a pistol against 0.3 s on most rifles, so the cost of sprinting is a
  number each weapon carries rather than one rule for all of them. A press made
  during the sprint is banked and spent on that tick (`FIRE_STATES`), so a tap
  and a held trigger come out the same. The sights are the other way: they may
  start coming up _during_ the sprint-out, so aiming out of a run is one motion
  and firing out of one is not.
- **Jump** 39 units high, against a gravity of 800 a second squared. A jump is a
  press: made standing, on the ground, on the step the key goes down. A key held, or
  pressed in the air, jumps nothing when the ground comes back, and no jump
  follows another within half a second (`JUMP_REPEAT`). The one allowance is
  for broken ground, which drops a walk for a tick at a time: a press made
  while not rising, with ground within two units under the feet (`JUMP_REACH`),
  is a press made on it. `jumpFrom` is the height
  it took off from, and is what says a player is in a jump rather than a fall.
- **In the air** the keys only nudge (a ninth of the ground's acceleration,
  towards the walk speed whatever is held), and letting go keeps the takeoff's
  speed. A sprint ends at the takeoff.
- **Landing from a jump** costs speed twice — 0.67 for coming down 12 units or
  more, as any fall does, and 0.65 for the jump — and starts a window of 1.8 s
  (`state.landing`) in which friction is raised, by 2.5 times at first and
  wearing off, and a jump is lower by what is left of it. A landing 18 units or
  more above the takeoff costs 0.5 and starts the window at 1.2 s. Timing every
  landing is therefore slower than walking.
- **Hitting a ceiling** ends the jump there.
- **Ground** is what faces up by 0.7 or more (`WALKABLE_NORMAL_Y`, a slope of
  about 45°), within a quarter of a unit of the feet. Steeper is slid down. A
  walk's velocity lies along the ground under it.
- **A step up** is tried when a move on the ground is blocked, or the ground
  under it is steeper than 0.9: the move is made again from up to 18 units
  higher — as high as the head room allows, so a low ceiling shortens a step
  rather than forbidding it — and set down. It is kept only if it got further
  along the way the move was going, so sliding along a ledge is never a step, and
  only onto something that can be stood on. A step in a jump is the same, onto
  nothing higher than the jump itself reaches. Prone, a step is 10 units.
- **A step down**: a walk that leaves the ground stays on whatever is within 9
  units below it. Further is a fall.
- **Every step up or down costs speed**, by how much of 18 units it was: 0.2 for
  a whole one, rising to 1 for none.

Three of those rules are stated for a box and made by a capsule over a resolver
that pushes out of what it overlaps, and [collision](collision.md#ground) says
how: the corner of a ledge under the rounded bottom, a groove between two, and a
ledge met from beside. What does not carry over: velocity is not clipped along a
wall, a kerb under a third of the radius is ridden up without the step's cost,
and a blocked step goes a tenth of the radius past where it was stopped.

- **Crouch and go prone** (`C` and left `Ctrl`). See [stance](#stance).
- **Mantle** a ledge more than 18 and no more than 60 units above the feet by
  holding jump at it, standing, where the world declares a `mantle` volume: from
  the ground, the air or a ladder. See [below](#mantling).
- **Climb a ladder** by walking or falling into one the world declares: the view
  steers it, the strafe keys move along it, and jump pushes off. See below.
- **Falling off the world** (50 m below its lowest floor) respawns the player at
  the world's spawn.
- **Fire, aim, reload**: the weapon's state machine, in
  [rendering](rendering.md#the-viewmodel).
- **Swap weapon** (`1` or `2`): put the held weapon away and bring the other one
  up. See below.

**Aiming** is `input/sensitivity.ts`. Pointer lock is asked for with
`unadjustedMovement`, so what arrives is the device's own counts with no OS
acceleration on them: one count is the finest movement the hardware can report,
and the angle per count is therefore the aim's resolution rather than a taste
setting. It is quoted in the games' own units — `m_yaw` is 0.022° a count and the
sensitivity multiplies it — kept in `localStorage`, and set from the pause menu's
Options panel. The aim is also scaled by the view's zoom
(`FirstPersonControls.setZoom`), so the hand movement that sweeps the crosshair
across the screen is the same at 15° as at 65°; without that, every gain in
magnification is a loss of the same factor in precision.

Not there yet: fall damage, aiming slowing the walk (the
weapon file's `adsMoveSpeedScale` is not exported), and shots that hit anything.

## Stance

A player stands, crouches or lies prone (`sim/stance.ts`). Every rule and number
here is the games', and [reverse/iw5-stance](../../reverse/iw5-stance/README.md)
has where each was read and what it looked like there.

|        | Hull height | Eye | Speed | Acceleration |
| ------ | ----------- | --- | ----- | ------------ |
| Stand  | 70          | 60  | 1     | 9            |
| Crouch | 50          | 40  | 0.65  | 12           |
| Prone  | 30          | 11  | 0.15  | 19           |

**The stance is a target and the eye follows it.** `MovementState.stance` is
where the player is going, and it switches at once: the hull every collision
query is made with (`hullHeight`) and the acceleration change on the step the
stance does. The eye takes 200 ms between standing and a crouch and 400 ms to or
from prone, along a table of heights rather than a line — going prone dips,
bounces and settles — and `MovementState.eyeShift` is which table and how far
along (`eyeHeight`). The stance moves **one step at a time, and only while the
eye is at rest**, so standing to prone is a crouch for 200 ms on the way. Speed
switches with the hull, except to and from prone, where it follows the eye
across. A stance that turns against a table under way turns the eye round where
it is.

**Nothing reads a standing constant for where a player is now.** The hull is
`hullHeight(state, body)` and the eye `eyeHeight(state)`: the camera, a round's
origin, the hip cone, the use key's reach, a part's "is anyone in the way", and a
peer's capsule all ask. `STAND_HEIGHT` and `STAND_EYE_HEIGHT` are left for what
is about a standing body — a spawn, the clearance a navigation link needs.

What the keys ask for, against what the world allows (`stepStance`):

- **Going down needs no room; coming up needs head room** for the taller hull.
  Without it the player stays as they are, and from prone gets as far as a crouch
  if that fits.
- **Jump, pressed crouched or prone, stands the player up** and does not jump.
  Nothing is left of that press; a new one, standing, jumps.
- **A sprint stands a player up at once**, the eye catching up, and so needs the
  room to stand before it starts. **Asking to crouch or lie down ends one**: a
  sprint is not run while either level is held.
- **Prone needs the ground.** Asked for in the air, it waits. A prone body that
  falls with its legs in something, or slides on ground too steep to stand on,
  comes up to a crouch.
- **Going prone starts a landing's grip** (`state.landing`), which is what stops
  a running body sliding as it drops.
- **A ladder is climbed standing** and a lying player cannot take hold of one. A
  mantle is started standing with the eye at rest; during one the stance is the
  mantle's to hold ([below](#mantling)), and only the eye moves.
- **Prone under a weapon that is aimed or firing, the movement keys do nothing**
  (`Carry.braced`).

### Prone blocked

A lying body is longer than its hull, and the hull is all that collides. So
lying down is allowed only where the rest of it fits (`proneFits`): the legs
need a clear run behind the view — shorter against a wall if they fit raised or
laid along the slope — the waist and the feet need ground under them, the torso
may not slope past 45° nor the legs fold too far from it, and nothing may stand
up under the body between the three. Refused, the player stays as they were.

The same test holds everything a lying player then does:

- **The body turns after the view** (`Lying.heading`), at 55° a second while
  crawling, while prone is asked for, or once the view is 80° off it — and no
  further than the turned body fits.
- **The view is held to what the body allows**: turned back by whole degrees
  until the twisted body fits, never more than 85° from the heading, and within
  45° of the torso's pitch, which follows the slope under it (`Lying.torso`).
  The degree is searched for rather than walked to, taking a body that fits at
  one twist to fit at every smaller one, so a view thrown at a wall costs a dozen
  tests and not eighty-five.
- **A crawl that ends where the body does not fit is undone**, position and
  velocity both, so a player cannot back their legs into a wall or over a drop.
  Only a move along the ground is: a fall is never undone, and a body that falls
  with its legs in something comes up to a crouch on the next step.

The games ask all of it with box traces. Here a trace is a ball carried along
its line (`CapsuleWorld.overlapsSweep`) and the ground under a point is a ray
(`groundBelow`), so a narrow gap a box would not enter, a ball's round end does.

**It is the dearest thing a step does.** A body lying still costs what a
standing one does; one whose view is turning asks the fit two to four times a
step, five collision queries each, which is two to four times a standing walk.

### The view caps are one mechanism

A move may cap the view: a ladder in the air, a mantle, and lying prone.
`sim/view.ts` is the one place any of them is applied (`capYaw`, `capPitch`), a function of the state
and the angle asked for. The step applies it to the input, and
`FirstPersonControls` asks `Player.viewYaw` and `viewPitch` the same question of
the mouse movement no step has spent yet, so the camera stops at a cap rather
than swinging past it and back.

### On the wire, and at the keys

`stance` is a union, two bits, with a heading and a torso pitch only when prone;
`eyeShift` is one bit at rest, and a path and twelve bits of clock while the eye
moves. A standing player's state costs three bits for all of it. An input carries
`crouch` and `prone` as two bits.

The keys toggle (`engine/controls/firstPerson.ts`): `C` crouches, left `Ctrl`
goes prone, and the key of the stance already asked for stands. The toggle is a
latch on the client, sent as levels, and it **follows the simulation**: after
each of its own ticks it takes `Player.forcedStance`, so a jump that stood the
player up, or a refusal for want of room, leaves the next press meaning what it
says. A press of run stands the latch up too, which is what lets a sprint start
from a crouch: of the run key and a stance key, the later press wins. It is set from the predicted state on arrival, and to standing by a
death.

Bots and actors never set either level.

### The body in a stance

A body is posed from its stance by the same function on both ends
(`poseLayers` in `sim/pose.ts`), so a peer is drawn crouched or lying and the
hit boxes a shot is traced against are where that body is. Each stance has its
own clips, named in one table (`STANCE_ROLES`, `sim/characterDef.ts`): an idle
and an aiming idle, four directions of travel blended by `travelForward` and
`travelRight` exactly as the run is, and its own fire and reload over the arms
and chest. Only a standing body sprints or takes a landing's dip, and a lying
one is never posed as jumping.

**A change of stance is the eye's own timer.** While `eyeShift` runs, the two
stances its path joins are crossfaded by how far along it is, and the path's own
clip — `standToCrouch` and the other three, named as the paths are — is laid over
the middle of the change, fading in and out over the first and last quarter. The
clip is scrubbed by the path's progress, not played at its own length, so a
rewind poses the moment it rewound to.

**A clip set says which roles it has, and the pose names no other.** The set's
role table travels in its GLB (`CharacterSet.roles`), `CharacterPoser` hands the
roles it holds a clip for to `poseLayers`, and each gap has one answer:

| The set lacks                | The pose uses                                            |
| ---------------------------- | -------------------------------------------------------- |
| a stance's idle              | the next stance up for all of that stance, standing last |
| an aiming idle or aimed fire | the stance's own idle or hip fire                        |
| one direction of travel      | the stance's forward clip, or its idle                   |
| a path's clip                | the crossfade alone                                      |
| a crouched fire or reload    | the standing one                                         |
| a lying fire or reload       | nothing: an upright spine on a flat pelvis is not a pose |
| `sprint`, `jump` or `land`   | the run, the ground pose, no dip                         |

So a set with no stance clips at all poses a standing body in every stance, and
no layer is ever one the presenter has no clip for — weight three would make up
out of the bind pose.

**Where a body is put is one function too** (`placeBody`, `rig/poser.ts`), which
a client draws a peer with and a server places the body it traces a shot at
with. A lying body faces `stance.heading`, not the view, and is tipped about its
own right axis by `stance.torso`, taken up across `crouchToProne`; the aim joint
turns by the pitch left over.

**The stride clock runs at the stance's own pace** (`advanceStride`,
`sim/gait.ts`): one loop takes 1.8 s at a run, 2.2 s at a crouched walk and 3.9 s
at a crawl, each at that stance's top speed and scaled by the speed being made.
The periods are constants, because a step reads no asset; a clip set whose loop
covers a different distance slides by the difference.

**The broad phase knows a lying body is long** (`couldHitBody`,
`rig/hitboxes.ts`). Standing or crouched, a posed body is inside the walking
capsule dropped and widened by `POSE_MARGIN`. Lying, or on either path to or
from it, it is inside a ball of `PRONE_REACH` about the point the simulation
moves — its feet are 1.7 m from there, which the capsule's margin does not
reach. `game-server/tests/poseEnvelope.test.ts` measures both.

Open:

- **Nothing has been seen in game.** The poses have been measured headless and
  drawn as skeletons (`game-server/tests/stancePose.test.ts`), not looked at on a
  body.
- **Getting up turns a body at once.** The heading and the torso belong to the
  lying stance, which is gone on the first step of `proneToCrouch`, so a body
  whose view was turned from it faces the view from that step.
- **A change of stance with no clip of its own crossfades two poses**, and half
  way between standing and crouched a foot dips through the ground.
- **A footstep is still two to a loop**, which is a run's count and not a
  crouched walk's or a crawl's.
- **The first-person weapon does not move with the stance.**
- **Nothing tells a player that prone was refused.**

## Mantling

A mantle is **authored, then found**. A world declares `mantle` volumes
([AUTHORING.md](../../worlds/AUTHORING.md)) — an imported map's are its own
mantle brushes — and a volume is a permission and a direction and nothing more:
where the ledge is, how high it is and whether a body fits there, the world's
collision says. A volume is an oriented box **around** what it marks, a little
proud of it on every side.

When a mantle starts, where its ledge is, how long it takes, how it ends and
what it holds of the view, the stance and the weapon are the games', in their
units: [reverse/iw5-mantle](../../reverse/iw5-mantle/README.md) has where each
was read. The way the capsule travels between the start and the end is not
theirs, and [has its own heading](#the-path-is-not-the-games).

**When.** Every step jump is down — pressed or held, so a key held while
walking or jumping into range starts one with no press at that moment — by a
body **standing with its eye at rest**: not crouched, not prone, not on the way
between. On the ground, in the air or on a ladder alike. It is asked after the
stance and before the ladder and the jump, so a press into a ledge mantles
rather than jumps, and a mantle from a ladder lets go of it with `ladderLock`
set. A key still down when a mantle ends does not jump: a jump is a press.

**The question** is `MantleVolumes.find` (`sim/moves/mantle.ts`), in three parts:

1. **The face.** A line as tall as the body, 0.1 thick, is swept along the
   view's yaw from 14.9 units behind the feet — as far back as the body's front
   is ahead — to 20 units past that front. The first volume side it enters is
   the mantle's direction: **straight in through the side, not along the
   view**, and the view must be within 60° of that. A volume has only to stand
   somewhere in the body's height; its own height is read for nothing else. **A
   probe that starts inside a volume finds nothing**, so a body deep in one, or
   with another just behind it, has no mantle. A body standing on a volume's
   top is not in it: half a unit under the top still counts as on it.
2. **The ledge.** The body's own ball, radius 15, is carried 16 units forward
   along that direction from 60, then 40, then 20 units above the feet, and
   from there let down. The first height it gets forward from untouched, to
   come to rest on ground, has found the ledge: **16 units ahead of the feet
   wherever the body stood, more than 18 above them and no higher than the
   ball was carried**. Lower is a step's. The two lower heights are for a sill
   under a lintel. A crouched body must fit on the ledge or there is no
   mantle, and where a standing one does not, the mantle is made crouched.
3. **Onto or over.** A volume whose `kind` is `over` asks for a vault: on 31
   units past the ledge, to end 18 below it. It is one if the body makes that
   run and that drop touching nothing — so not with a wall in the run, and not
   with a floor within 18 units under its far end. Otherwise, and for every
   other volume, the mantle ends on the ledge.

The ledge is measured from the feet, so a wall too tall from the ground comes
into reach from the top of a jump with the key still down.

The games trace boxes. Here a trace is a ball carried along its line
(`CapsuleWorld.overlapsSweep`); how far down it gets is found by halving, and
what it came down on is asked of the resolver. **Ground is the resolver's
`grounded`, not the slope of the contact**: a ball let down past the edge of a
level top, or onto the higher of two steps, rests on a corner, where a flat box
would be standing on the top — the same rule that lets a walking body stand on
an edge ([collision](collision.md)). The ledge's height is that corner's, so
the feet rest a little under it. A corner the ball slipped past round its side
but a box's flat underside would have met is too high, and refused. What a ball
cannot do is feel under the box's corners: a top that reaches only those is
not found.

The volume test is plain numbers and everything else goes through
`CapsuleWorld`, so this lives in `sim/` and both ends answer it by running the
same code over the same world file and the same collision mesh.

**It costs nothing where there is nothing.** A step with jump held and no
volume within a metre is a lookup in a grid of 8 m cells. Beside a volume it is
a few lines of arithmetic per volume, and collision is asked only once a face
is met within the 60°: two sweeps where nothing is ahead, three against a wall
too tall, ten queries to refuse what the ball rests on — once, however many
heights would have come down on it — and some forty a step where there is a
ledge and no clear path to it. `packages/game-server/tests/mantleWorld.test.ts`
pins how many of an imported map's volumes can be mantled at all.

### The path is not the games'

The games move a mantling player along a clip's root motion with collision off.
Here **a mantle never moves the capsule through the world, and never leaves it
inside it**. The path is straight up to the ledge's height, straight across
onto it, and for a vault on across and straight down. Before the mantle starts
every leg is tested with `CapsuleWorld.overlapsCapsule` every half radius — half
a radius apart, the most anything can reach into the swept shape unseen is
under a centimetre — first with the standing hull, then with the crouched one.
The tallest that makes it is the hull the mantle is made in. **A ledge with no
clear path to it is no mantle**, decided at the start, so none stops half way;
the key is then an ordinary jump.

What that costs against the games: a climb past something the capsule would
clip (a mullion, a beam) is refused where they make it; the path is two or
three straight legs at a steady speed where theirs is a curve, mostly up
first; and the feet start where they are rather than being moved the few units
that make the clip end on the ledge.

Six things about the move itself are load-bearing:

- **It never resolves collision.** The path was tested before it started, and
  nothing it was tested against moves (a built world is static; other players
  are not colliders). Resolving mid-mantle would only nudge the capsule off the
  corner it hugs, and off the line a server replays. Gravity, friction and the
  keys are off too: the player is on rails until it ends.
- **It is a function of the feet and the move.** A mantle has two parts, each
  with its own time: onto the ledge, and — a vault — over it. Which part it is
  in follows from the time left, and which leg of the part from the feet. Each
  step covers the share of what is left of the part that `dt` is of the time
  left of it, which is a steady speed along each. So a server replaying the
  same inputs lands in the same place at any tick rate, and a state adopted
  from a snapshot carries on from where its feet are.
- **Its time is the row's.** The ledge's height picks the nearest of seven rows
  (`MANTLE_ROWS`), and the row times the move, sets how it ends and says
  whether the weapon stays out:

  | Ledge, units | Onto it, ms | Vault after, ms | Speed on the ledge, u/s | Vault's end, u/s forward / down | Weapon |
  | ------------ | ----------- | --------------- | ----------------------- | ------------------------------- | ------ |
  | 57           | 833         | 233             | 19.6                    | 138 / 131                       | away   |
  | 51           | 800         | 233             | 20.4                    | 138 / 131                       | away   |
  | 45           | 600         | 400             | 34.1                    | 78 / 79                         | away   |
  | 39           | 600         | 400             | 34.1                    | 78 / 79                         | away   |
  | 33           | 500         | 400             | 39.7                    | 78 / 79                         | away   |
  | 27           | 433         | 467             | 38.8                    | 67 / 80                         | out    |
  | 21           | 333         | 467             | 44.2                    | 67 / 80                         | out    |

  The step that starts a mantle is its first, so one lasts exactly its time.

- **It ends moving.** Onto a ledge: on it, on the ground, with the row's speed
  along the mantle. Over one: in the air 31 units past the ledge and 18 below
  it, with the vault's speed forward and down, and the next step is a fall.
- **It holds the view and the stance.** The view's yaw stays within 60° of the
  mantle's direction, through [the one mechanism](#the-view-caps-are-one-mechanism)
  a ladder and a prone body use, so the camera stops at the cap; the pitch is
  free. A mantle made crouched crouches the body on its first step, and the
  step returns `crouch` for as long as it lasts — the forced stance a client's
  toggle follows. Its last step returns `stand` where there is the room to,
  and the keys' own stance stands the body up from there; on a ledge with only
  a crouch's room it returns `crouch`, and the body stays down.
- **It sends geometry, never a volume id.** The `mantle` variant of `move`
  carries the ledge (a position), the direction (a yaw, 16 bits), the row
  (3 bits), `over` (1) and the time left (9 bits over the longest mantle, 2 ms):
  125 bits, only while somebody mantles. Entity ids are positional, so a client
  and a server on different world text would address different volumes; a
  position and a clock cannot. The row travels as its index and not as a
  height, so a rounded copy cannot fall in another row; `over` travels because
  no ledge height says it.

**The weapon stays out for the two lowest rows and goes away for the rest**
([below](#the-weapon-on-a-climb)). The body plays one clip for the way onto the
ledge and one for a vault's part after it, each scrubbed by how far through its
part the move is (`mantleProgress`), so the body arrives when the capsule does.

Open, and worth knowing before trusting a map:

- **Nothing has been seen in a browser.** Every rule is from the games' code
  and every test is headless.
- **Every side of a volume climbs, and a vault is the volume's to ask for.**
  The games read both off the face the probe met. A world file carries one
  `kind` for the whole volume and nothing per side, so a side the map meant to
  refuse climbs, and a volume that names no kind never vaults.
- **A volume that stands far proud of its obstacle cannot be climbed.** The
  probe starts 14.9 units behind the feet, and inside a volume it finds
  nothing: the games' rule, which a box fitted loosely round a brush turns into
  a ledge that does nothing.
- **Nothing shows that a mantle is available.** `find` is the test a hint
  would draw from.
- **Two clips, not ten.** One onto a ledge and one over it, each stretched to
  its row's time, where the games have a clip a row and three vaults.
- **A server replays a mantle from the input, like the rest of a player's
  movement**, against its own copy of the volumes. A client whose mantle the
  server's replay did not start is corrected out of it on the next snapshot.

## Ladders

A ladder is **authored, not detected**, like a mantle: the world declares
`ladder` nodes ([AUTHORING.md](../../worlds/AUTHORING.md)), and an imported map's
come from the brushes its clipmap flags as ladders (`surfaceFlags & 0x8`,
`scripts/cod/ladder.py`). Unlike a mantle volume, **the box is the ladder
itself**: in every map a ladder is a thin player-clip brush of its own, so it is
already a wall in `collision.glb`, and the node adds only the permission to
climb it ([collision](collision.md#what-is-deliberately-not-a-collider)).

Everything below is IW5's own code, read from `iw5mp.exe` —
`PM_CheckLadderMove` (0x4230d0), `PM_LadderMove` (0x423380), the jump off
(0x416780), the view cap (0x420990) — and BO1 runs the same code with the same
numbers. The constants are in game units under "The climb" in
`sim/moves/ladder.ts`; `reverse/iw5-ladders/` has the derivation.

**Grabbing** (`checkLadder`) is a box trace every step. The probe is the body
with 6 units off each side and 8 off the bottom, swept 8 units ahead standing or
30 in the air, along the view — or, once climbing in the air, straight back into
the ladder, so looking away does not let go. It grabs when it meets a ladder
side and the player is in the air, or standing and pushing forward; a first
grab checks a second probe straight in along that side's normal. The side's
normal is kept as `LadderState.facing` and never refreshed while climbing.
`sim/moves/ladder.ts` sweeps the probe against the ladder boxes with plain numbers, so
the grab needs no geometry library; the one thing it cannot see is a wall between
the player and a ladder, which no map builds.

Every side of a ladder is climbable unless the node names one (`face`), because
that is what the maps say: 147 of 154 ladder brushes flag all six faces. A trace
stops at the first surface, so a side that cannot be climbed also hides a ladder
behind it.

**Not grabbing:** within 0.3 s of a jump; and after coming off a ladder any way
but a jump, **not until the player has touched the ground** (`ladderLock`, the
game's pm_flags 0x1000).

**Climbing** (`climbLadder`) replaces walking, on the ground too:

- **Forward climbs, and the view says which way.** Vertical speed is
  `forward × clamp((sin pitch + 0.25) × 2.5, −1, 1) × ½ × 190 u/s`: 2.41 m/s at
  full tilt, 0.625 of that looking level, still at about 14.5° down, and full
  speed down from about 40° down. Backward is the same, reversed.
- **Strafe moves along the ladder** at a fifth of 190 u/s, along the view's right
  laid onto the ladder's plane — slower when looking at the ladder side-on.
- The velocity is approached at 9× the wanted speed per second. **Letting go
  of a key stops its half of the climb at once**: forward released, the player
  stops rising or descending; strafe released, they stop moving along the
  ladder. That is how the game plays; its code decays both (vertical at
  gravity, which from full speed takes 0.12 s, sideways at 16× a second), and
  the stop is the one deliberate simplification of it. **There is no gravity**,
  so a player who lets go of everything stays where they are.
- **Off the ground**, velocity away from the ladder is removed, and a mostly
  vertical climb is held against it at 50 u/s. That push is what carries a player
  over the top.
- **Collision still runs.** A ladder is steered, not a rail, so the capsule is
  resolved every step like walking; the tests climb over the top of a ladder
  against real boxes and check the capsule never sinks into anything.

The speeds are CoD's `g_speed` (190 u/s) shares, not shares of our walk speed:
the body clips' own root motion (1.77 m/s up, 1.38 m/s down) sits with the
game's numbers, not with ours.

**Getting off:** at the top, the push presses the player against the ladder,
and once their feet are within a step of its top the step up sets them on it,
as the game does; the probe then clears the ladder and they let go. **From the
top**, walk backward off the edge: falling past the ladder facing it, the
probe catches the climb side. Walking forward at a ladder from its landing
grabs its back for a moment, as the game does — every side is climbable — but
the ladder's top stands a step above the landing (0.37 m on dome), so the
step-up sets the player on it and the grab lets go at once; keep walking and
they drop off the far side. Where a step meets a capsule rather than the
game's box, the capsule can be set down on the ledge's corner; that is kept
when what is left is under 0.24 m, which its rounded bottom then climbs. At
the bottom, let go of forward while standing. **Jump** pushes off: a new press (holding jump does not throw a
player off), at least 0.5 s after the last jump, gives three quarters of a jump's
rise and 128 u/s along the ground — along the view when looking away from the
ladder, mirrored off it when looking at it, so always away.

**The view is capped** at 100° from facing the ladder while in the air on one
(`ladderYaw`, the game's `bg_ladder_yawcap`), through
[the one mechanism](#the-view-caps-are-one-mechanism) a prone body's caps use.

**On the wire**, `MovementState` carries `ladder` (nullable: one bit, and a yaw
while climbing), `ladderLock`, `sinceJump` (stopping at 0.5 s, the longest rule)
and `jumpHeld` (for the new-press rule). Geometry and timers, never a ladder id,
for the reason the mantle gives.

**The body** faces the ladder whatever the view does (`bodyYaw`), and plays
`pb_climbup` or `pb_climbdown` by the sign of the vertical speed — the games'
only two ladder clips, both whole-body loops. The clip is placed by the feet's
height against its root motion (37.1 in a loop up, 39.9 down), so the hands stay
on the rungs at any speed, and a still climber holds a pose. No weapon file
mentions a ladder (0 of 156 MW3, 0 of 1,194 MW2), and the weapon is away anyway.

Open:

- **Nothing has been seen in game.** Every number is read from code; how the top
  and bottom feel is inferred from it.
- **`g_speed` is not in `iw5mp.exe`**, so 190 u/s is the series' usual default
  rather than a value read from MW3.
- **A tilted ladder loses its tilt**: 56 flagged faces lean, and a node's box
  turns about Y only.
- **The body does not turn its head** toward the view on a ladder; the game
  twists it up to 75°.

## The weapon on a climb

A climb **puts the weapon away**: a ladder always, and a mantle onto any but the
two lowest rows of [its table](#mantling), which keep it in the hands, firing
and all. That is one rule, `stowsWeapon(move)` (`sim/movement.ts`), read off the
move itself. Away means a quick putaway, nothing in hand for the length of it,
and the same weapon back afterwards with a quick raise. `Player.step` does it
in the shared simulation, because `WeaponData` is on the wire and a server
replays it:

- While climbing, the trigger, the sights and a sprint are not asked for, a
  reload is not started, a swap is not started, and a putaway that has not
  started does (`quickDrop`).
- When the climb ends, the weapon comes back with `quickRaise`. A swap the climb
  interrupted finishes instead: the other weapon comes up, as it would have.
- Whether a climb is under way is read from the state the step **starts** from,
  so a client and a server replaying it decide it on the same tick.

**`stowed` is in `PlayerState`** for the reason `swapping` is: a lowered weapon
waiting for a climb to end is not derivable from anything else.

## Two weapons, and the swap

A player carries a **class**: a primary and a secondary, each with what is fitted
to it (`shared/sim/loadout.ts`). The api stores five per player and puts the
chosen one in the game order; offline, the client equips it the same way, and a
world's own `viewmodel { weapon: }` is what a player with no class falls back to.

`Player` holds both and one index into them. Swapping spans two ticks, and that
is the whole of its difficulty:

1. `input.swap` starts it: the held weapon plays its putaway (`quickDrop`, which
   is the clip CoD uses for exactly this) and `swapping` goes true.
2. When that putaway leaves the weapon `lowered`, `step` hands over — the other
   slot becomes the held one and plays `quickRaise`.

**`swapping` is in `PlayerState`** because of step 2. A peer needs no help: their
`weaponIndex` names the new weapon the moment it is in hand, and a snapshot
carries the raise like any other clip. A **server replaying the local player's
inputs** does, though — it steps the same ticks from the same state and has to
end up holding the same gun, and "this putaway is a swap" is not derivable from
anything else. One bit, and `tests/loadout.test.ts` is what says so.

A class names its attachments (`acog`) and the simulation numbers them (slot 3).
The two spellings are deliberate: a snapshot goes out sixty times a second so it
carries the number, and a stored class outlives the catalogue that handed the
numbers out, so it carries the name. `fittedSlots` is where they meet.

## The local player

`FirstPersonControls` polls the devices once a frame and builds a `PlayerInput`
once a tick, from latches the poll filled — see the fixed tick above for why the
two are not the same moment. A press counts even if the key was released before
the poll (`takePressed`), so a quick tap is not lost.

It steps the player unless a pose is held (a `hold` pose link: looking is
allowed, anything else waits until a movement key), and puts the camera at the
eye. A held pose accumulates no time either, so releasing one does not spend a
backlog of ticks at once. `turn` is the view's change from the mouse alone, and
is measured per frame rather than per tick because the viewmodel's sway is drawn
per frame — so a spawn or teleport never swings the gun.
