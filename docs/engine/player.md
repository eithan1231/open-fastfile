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
| `shared` `sim/input.ts`                   | `PlayerInput`: one step's command, and the sprint rule                 |
| `shared` `sim/movement.ts`                | `MovementState` and `stepMovement`: walking, running, jumping, capsule |
| `shared` `sim/weapon.ts`                  | `WeaponController` and `WeaponData`: the held weapon's state machine   |
| `shared` `sim/weaponDef.ts`               | `WeaponDef`: what a weapon _is_, read off the exporter's GLB           |
| `shared` `sim/weaponRegistry.ts`          | The catalogue: every weapon both ends can build, and its `hash`        |
| `shared` `sim/player.ts`                  | `Player`: steps both on one input; `snapshot` / `restore`              |
| `shared` `sim/capsule.ts`                 | `CapsuleWorld`: the three.js-free view of collision a step gets        |
| `shared` `sim/mantle.ts`                  | The world's mantle volumes, and the one query a step makes of them     |
| `client` `engine/controls/firstPerson.ts` | Devices → `PlayerInput`, the held pose, the camera                     |

## State for the network

Everything that changes as a player plays is one plain object,
`Player.snapshot()`, a `PlayerState`: `movement` (feet, velocity, view angles,
ground and jump timers), `weapon` (`WeaponData`), and **which** weapon that is —
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
run, jump, fire, aim and use held, reload and swap pressed. Angles are absolute,
not deltas, so a lost command cannot skew the aim. A server that holds a player's
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
changes weapon is followed. A server re-anchoring to a client's claim uses
`reanchor`, which takes movement alone: a claim carries no weapon, and restoring
a made-up `PlayerState` from one would disarm the player every tick.

## One step

`Player.step(input, dt)` runs the weapon first and then movement. The weapon
reads only the input. Movement asks the weapon whether a sprint may run
(`WeaponController.sprinting`). Nothing else connects the two.

`stepMovement`'s capsule and speeds are `MovementParams`, and a player never
passes any: the default is `PLAYER_MOVEMENT`, bit for bit what the step was
before it had parameters (`tests/movementParams.test.ts` holds a digest of it).
An actor's kind passes its own ([actors](actors.md)). Friction's floor is the
lower of `STOP_SPEED` and the walk speed, or a body slower than 1.5 m/s could
never overcome it.

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

`hipDuckedMin`/`Max` and the prone pair are exported and dormant: the game blends
its three stance pairs on view height and this engine has no stance, so only the
standing pair is reachable. `turnAdd` is 0 on all 135 catalogue weapons.

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
- **The camera interpolates position and the view kick, but not the aim.** It
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
`stepMovement` against the same collision, and compares its answer to the state
the client claimed alongside each input. It corrects nothing yet; it measures.
The rest, including the two known reasons the two ends disagree today, is in
[docs/server/README.md](../server/README.md#the-match).

## What a player can do

Movement is Quake's, as CoD's is: keys add acceleration towards a target speed
and friction takes it away, so speed carries through landings and stops take a
moment. The numbers are at the top of `player/movement.ts`.

- **Walk** at 3.2 m/s in any direction. A diagonal is no faster.
- **Run** at 5.8 m/s, only while holding run **and** moving forward (the sprint
  rule, `wantsSprint`), and only while the weapon is sprinting: firing, aiming
  or reloading drops the player to a walk until it is done. Empty-handed, the
  sprint rule alone decides.
- **Sprint to fire.** The trigger takes the weapon out of a sprint, and the round
  leaves when the sprint-out is done — the weapon file's own `sprintOutTime`,
  0.2 s on a pistol against 0.3 s on most rifles, so the cost of sprinting is a
  number each weapon carries rather than one rule for all of them. A press made
  during the sprint is banked and spent on that tick (`FIRE_STATES`), so a tap
  and a held trigger come out the same. The sights are the other way: they may
  start coming up _during_ the sprint-out, so aiming out of a run is one motion
  and firing out of one is not.
- **Jump**: 5.5 m/s up against 18 m/s² of gravity, a 0.84 m jump lasting
  0.61 s. Holding jump jumps again on each landing. A press up to 0.15 s before
  touching down still jumps (the buffer), and so does one up to 0.12 s after
  walking off a ledge (coyote time), which also covers the resolver's
  one-frame `grounded` dropouts on triangle soup.
- **In the air** the keys only nudge (a twentieth of the ground's acceleration), and
  letting go keeps the takeoff's speed.
- **Landing from a jump** (not from a fall) halves the target speed and raises
  friction, recovering over 0.5 s, like CoD's `jump_slowdownEnable`.
- **Hitting a ceiling** ends the jump there.
- **Stairs and ledges** up to 0.46 m (IW5's 18 units) are walked up: the
  capsule's rounded bottom slides up anything under its 0.3 m radius, and a
  move blocked by something taller is made again from 0.46 m up and set down
  on it (`stepUp`, IW5's step-slide move at 0x424a30). Only standing players
  step, and players climbing a ladder upward; a step never goes past 0.46 m,
  never through a low ceiling, and never where sliding along a wall would do.
  See [collision](collision.md).
- **And back down the same height** (`stepDown`). A move along a slope is
  horizontal, so walking _down_ one ends in the air every tick and gravity needs
  two or three ticks to bring the capsule back — `grounded` flickered for those,
  and with it the ground friction, the ground acceleration, and the `airborne`
  pose blend, so a body walking down a hill crossfaded between falling and
  walking several times a second. A step that started on the ground and ended off
  it, with nothing carrying the player upward, stands on whatever is within
  0.46 m below. Walking off a kerb therefore sticks to it, as the games do; a
  takeoff never reaches it (a jump clears `grounded` before the move), and
  anything taller than a step is still a fall.
- **Mantle** a ledge between 0.35 m and 1.45 m by jumping into it, where the
  world declares a `mantle` volume. See below.
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

Not there yet: crouch and prone, fall damage, aiming slowing the walk (the
weapon file's `adsMoveSpeedScale` is not exported), and shots that hit anything.

## Mantling

Climbing is **authored, not detected**. The engine never looks at geometry for a
ledge; it tests the player against `mantle` volumes the world declares, which is
how the games do it — imported maps carry about 70 each, from the brushes their
clipmap marks `0x01000000` (`scripts/cod/mantle.py`). A hand-authored world gets
mantles by declaring them ([AUTHORING.md](../../worlds/AUTHORING.md)).

A volume is an oriented box **around** what it marks — on dome-mw3, the crate or
the sill with about 0.4 m to spare on every side — with its **top level with the
surface the player ends on**. `sim/mantle.ts` holds them and answers the one
question a step asks: from here, facing this way, is there anything to climb,
and can the capsule get there? The volume answers the first half and the world's
collision the second, in three steps:

1. **The face.** Any of the four sides. The player must be within their radius of
   the box and facing into a side within 60°; the climb goes straight in through
   that side, whichever way they are looking inside that cone. At a corner, the
   side they are further outside of wins. That is the games' model: a trace
   ahead hits a mantle brush, and the side it hits sets the direction.
2. **The ledge.** Rays straight down (`CapsuleWorld.groundBelow`), every 5 cm
   along the climb, find the first surface within 15 cm of the box's top. It has
   to begin within 0.3 m of the front of the capsule, and its height — not the
   box's — sets the rise. `onto` lands a radius past the edge, or as far in as
   the ledge goes if it is narrower. `over` lands a radius past the ledge's far
   edge and falls from there; with no room there it climbs onto the ledge instead,
   which is why `MantleState.over` comes from the result, not the volume.
3. **The path.** Straight up to the ledge's height, then straight across to the
   landing. Both legs are tested with `CapsuleWorld.overlapsCapsule` every half
   radius; anything in the way — a beam overhead, a window's mullion — refuses
   the climb, and the press becomes an ordinary jump. Half a radius apart, the
   most anything can reach into the swept shape unseen is under a centimetre.

The volume query itself needs no geometry library, so this lives in `sim/`
rather than `collision/` and reaches the BVH only through `CapsuleWorld`. Both
ends answer it by running the same code over the same world file and the same
collision mesh.

A jump press is checked against the volumes _before_ it becomes a jump, so a jump
into a ledge climbs it. It is deliberately not gated on being grounded: in the
games a mantle can start from a jump or a fall, and the volume is what decides
whether there is anything there.

Five things about the climb itself are load-bearing:

- **It never breaks collision, and never resolves it either.** The path is
  checked before the climb starts, and nothing it was checked against moves (a
  built world is static; other players are not colliders). Resolving mid-climb
  would only nudge the capsule off the corner it hugs, and off the line a server
  replays. Gravity, friction and the keys are off too — the player is on rails
  until it ends. Looking around still works: the view is absolute in the input,
  so refusing it would only make the camera fight the mouse.
- **It is a pure function of (feet, target, time left).** Which leg the player
  is on follows from their feet: below the target's height is the rise, level
  with it is the traverse. Each step covers the share of the remaining path that
  `dt` is of the time remaining, which is exactly constant speed. That is what
  lets a server replaying the same inputs land in the same place rather than
  approximately there, at any tick rate.
- **It is slow.** About 0.03 m a tick, against `FirstPersonControls`'s 1 m
  teleport threshold, so the camera interpolates a climb like any walk.
- **The timings are the games' own.** 0.33 s at the shortest climb to 0.83 s at
  the tallest, interpolated, because `mp_mantle_up_21` through `_57` are named in
  inches and rise monotonically. `MAX_CLIMB` is 57 in for the same reason: past
  that there is no animation, so the climb is refused rather than played at the
  wrong height. **Making mantling faster than the original is a change to
  `MANTLE_TIME_LOW` and `MANTLE_TIME_HIGH` and nothing else.**
- **It sends geometry, never a volume id.** `MovementState.mantle` is nullable
  (one bit when nobody is climbing) and carries a target position, the time left,
  the rise and one bit for `over`. Entity ids are positional, so a client and a
  server on different world text would address different volumes; a position and
  a timer cannot. `over` is on the wire because a snapshot has the climb but not
  the volume, and the two kinds' heights overlap — there is no guess a peer could
  make instead.

**The weapon goes away for it**, as for a ladder
([below](#the-weapon-on-a-climb)). No weapon file declares a mantle clip — none
of 156 dumped MW3 weapon files — and no `viewmodel_*mantle*` asset exists, so the
viewmodel only plays its putaway. The body clips live in `common_mp.ff` with
every other `pb_`/`pt_` clip; `characterAnimator.ts` scrubs one from the
simulation's clock so the body arrives at the top when the capsule does.

Open, and worth knowing before trusting a map:

- **320 of the 3,006 imported volumes are over 2 m tall** — a whole wall — and
  none of them is an `over`. Those exceed `MAX_CLIMB`, so they refuse rather than
  animate, and what the maps meant by them has not been settled in game.
- **The volume's top is the landing surface for 84% of them** by the exporter's
  own check, which reads brush bounds only and no triangle soup, so the real
  figure is higher. The climb traces for the surface within 15 cm of the top, so
  a volume further off than that climbs nothing.
- **Every side of a volume is climbable**, where the games may allow only the
  sides whose material says so. The exporter collapses a brush's side materials
  into one `kind`, so the per-side answer is not in the world file. On
  dome-mw3 every volume climbs from at least one side and five from three or
  more; whether the games allow each of those has not been checked in game.
- **A server adopts a client's claimed mantle state**, as it adopts the rest of
  their movement: phase 1 believes the client and corrects nothing. A climb is
  the largest single thing that trust buys, and validating one belongs with the
  correction loop rather than before it.
- **Two clips, not ten.** One step-up and one vault, stretched to whatever climb
  they are playing, instead of the games' seven height-indexed clips plus three
  vaults.

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
numbers. The constants are in game units at the top of the ladder section of
`sim/movement.ts`; `reverse/iw5-ladders/` has the derivation.

**Grabbing** (`checkLadder`) is a box trace every step. The probe is the body
with 6 units off each side and 8 off the bottom, swept 8 units ahead standing or
30 in the air, along the view — or, once climbing in the air, straight back into
the ladder, so looking away does not let go. It grabs when it meets a ladder
side and the player is in the air, or standing and pushing forward; a first
grab checks a second probe straight in along that side's normal. The side's
normal is kept as `LadderState.facing` and never refreshed while climbing.
`sim/ladder.ts` sweeps the probe against the ladder boxes with plain numbers, so
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
and once their feet are within 0.46 m of its top the step-up sets them on it,
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
(`ladderYaw`, the game's `bg_ladder_yawcap`). The step applies it to the input
and `FirstPersonControls` to the mouse movement no step has spent yet, so the
camera stops at the cap rather than swinging past it and back.

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

A climb — a ladder or a mantle — **puts the weapon away**. The games change to
no weapon for both (IW5 0x42a270, with one mantle type excepted that we have not
identified): a quick putaway, nothing in hand for the length of it, and the same
weapon back afterwards. `Player.step` does the same, in the shared simulation
because `WeaponData` is on the wire and a server replays it:

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
