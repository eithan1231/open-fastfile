# Shot traces: where a round went, twice

**This is a temporary diagnostic and it is meant to be deleted.** Every file it
adds and every line it weaves into an existing one carries the token
`SHOTTRACE`, so `grep -rn SHOTTRACE` is the complete footprint. The last section
of this page is the checklist for taking it out again.

## What it shows

Press `G` in a dev build. Every round the local player fires is drawn twice:

- **cyan** — the trace this client made of its own shot, against its own
  collision world and against the peers as they are _drawn_;
- **magenta** — the trace the game server made of the same shot, sent back to the
  player who fired it and to nobody else.

Each half is a line from the eye to where the round stopped, with a small cross
at the impact; a round that met nothing gets the line and no cross. The last
eight rounds are kept and fade over six seconds, so a burst can be read shot by
shot. The stats line adds how many are held and **how far apart the two answers
were on the last paired round** — that number is the whole point of the exercise.

`no server trace` there means one of two things: the game server was started
without `SHOT_TRACE`, or that round's packet was lost (the message is
unreliable, deliberately — a lost diagnostic is a line that is not drawn, never a
line drawn wrongly).

## What a divergence means

The two ends are **not** expected to agree, and where they disagree is the
information:

| What you see                                         | What it is                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The two lines coincide, including on a wall          | Both ends traced the same ray against the same geometry.                                                                                                                                                                                           |
| They coincide on walls but part on a body            | Lag compensation. The server rewinds each peer to the moment the shooter was drawing them (`Match.rewind`); this client draws them interpolated one tick behind the newest snapshot. The gap is roughly the peer's speed times the shooter's ping. |
| They part on a **wall**                              | Two different collision worlds. That is a bug — the same mesh, the same `"shots"` channel, the same BVH ([collision.md](collision.md#a-bullet-and-a-player-collide-with-different-things)).                                                        |
| They leave along different rays at all               | The aim itself disagrees: the view kick, the quantised input, or a correction the client has not replayed.                                                                                                                                         |
| The client says `player` and the server says `world` | Something on the server's side of the map stopped the round the client thought reached a body.                                                                                                                                                     |

## How each half is built

**The client's.** `packages/client/src/engine/shotTraceView.ts`.

- A shot is detected by watching `WeaponData.fired` advance across a frame,
  exactly as `Shots.fire` detects one. Not by subscribing to
  `WeaponController`'s `shot` event: `Player.equip`/`equipById`/`restore` each
  replace the controller, so a subscription is dropped in silence on every weapon
  change and every correction. A controller that is not the one being watched
  resets the watermark rather than reporting a burst.
- The ray is `aimAngles` then `aimDirection` — the same two calls, in the same
  order, that the server makes and that `firstPerson.placeCamera` points the
  camera with — off the simulation's own angles and the weapon's **view** kick.
  The gun kick is not in it: it rocks the model and decides nothing
  ([player.md](player.md#recoil-is-two-kicks)). The origin is the feet plus
  `eyeHeight(movement)`, the eye as the stance has it.
- The kick it uses is the one sampled on the **previous** frame, not this one:
  a round leaves before its own recoil moves the view
  ([player.md](player.md#trace-then-kick)). The sample is per frame where the
  server's is per step, so a frame that ran several ticks traces the later rounds
  along a kick a tick or two stale — hundredths of a degree, against the whole
  impulse that ordering is about.
- The map is traced on the `"shots"` channel, not the one a capsule walks into.
- The peers are traced with `BoundHitboxes` — the server's own class, over the
  server's own sidecars — against the rigs `RemotePlayers` posed this frame. No
  rewind, because that is the half of the disagreement worth seeing.
- The nearest of the map and the peers wins, as in `Match.traceShot`.

One honest caveat: the view runs **per frame**, not per tick. At 60 Hz they are
the same thing. On a frame that spent two or more ticks, the second round is
traced from the angles the _last_ tick left — a fraction of a degree, and it
shows up as a small client-side wobble rather than as a server disagreement.

**The server's.** `packages/game-server/src/shotTrace.ts`, gated on
`SHOT_TRACE`. `Match.shotsThisTick` already holds everything wanted —
`FiredShot { shooter, ordinal, from, direction, result }` — so this only maps it
onto a message and addresses it to whoever fired.

It is a **message type of its own**, not an entry in the snapshot's event tail,
and size is not the reason. The tail is capped at seven events on a byte budget
that `packages/shared/tests/netPackets.test.ts` spells out in prose, and the one
event a shot already produces (`HitEvent`) fires only where health actually fell
— so a **miss produces nothing at all**, and a miss is the interesting case here.

## Pairing, and why it is by ordinal

`ShotTraceMessage.ordinal` is `WeaponData.fired` after that round left. The
client pairs the server's answer with its own by that number and never by arrival
order: a burst puts several of these in flight over an unreliable channel, and
pairing on arrival would draw one round's divergence against another's — a wrong
number that looks entirely plausible. An ordinal this end has no trace for is
kept on its own, because "the server fired a round we did not" is a reading.

## Turning it on

```sh
SHOT_TRACE=1 pnpm dev:game-server    # beside `pnpm dev`
```

Unset — the default, and what `.env.example` ships — the server sends nothing at
all and the branch that would send it never runs. The client's own half still
works with the server off; only the magenta line is missing. Seeing a peer at all
takes two clients, so this is `pnpm dev:mp` with two players ([one tab each](../server/README.md#one-tab-per-player))
([debugging.md](debugging.md#hit-boxes)).

## What is _not_ verified

The drawing itself. It was built without a browser: the geometry, the colours and
the fade have tests for what they are fed, and none for what they look like.

## How to remove this

`grep -rn SHOTTRACE packages docs .env.example` lists the marked lines below;
`grep -rn -i shottrace packages` also finds the unmarked ones. Other work has
landed on top of it, so this is a hand edit, not a revert.

**Delete these files outright — nothing else refers to them:**

| File                                            | What it is             |
| ----------------------------------------------- | ---------------------- |
| `docs/engine/diagnostics-shottrace.md`          | this page              |
| `packages/shared/src/net/messages/shotTrace.ts` | the message            |
| `packages/shared/tests/shotTrace.test.ts`       | its test               |
| `packages/client/src/engine/shotTraceView.ts`   | the view               |
| `packages/client/tests/shotTraceView.test.ts`   | its test               |
| `packages/game-server/tests/shotTrace.test.ts`  | the server half's test |

**Then undo these edits, each marked `SHOTTRACE` at the line:**

| File                                      | Touch points                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/net/packet.ts`       | the `shotTrace` import; the entry in `Messages`; the entry in `SCHEMAS`; `shotTrace: 6` in `MessageType` — see below.                                                                                           |
| `packages/client/src/net/connection.ts`   | the `ShotTraceMessage` import; `onShotTrace?` in `ConnectionEvents`; the `case MessageType.shotTrace` in `receive`.                                                                                             |
| `packages/client/src/app/dev/overlays.ts` | the two imports; the `shotTraces` field; the line in the constructor; the line in `afterBuild`; the line in `reset`; the call in `update`; `toggleShotTraces` and `serverShotTrace`; the two pushes in `stats`. |
| `packages/client/src/app/dev/devTools.ts` | the `shotTraces` toggle in `bind`; `serverShotTrace`.                                                                                                                                                           |
| `packages/client/src/app/match.ts`        | `onShotTrace:` in the `Connection` events.                                                                                                                                                                      |
| `packages/client/src/input/bindings.ts`   | `"shotTraces"` in the `Action` union; the `shotTraces` entry in `DEFAULT_BINDINGS`. `G` goes back to being free.                                                                                                |
| `packages/game-server/src/shotTrace.ts`   | the whole file; its import and the `if (config.shotTrace)` in `tick.ts`; `NetServer.sendTo` if nothing else uses it.                                                                                            |
| `packages/game-server/src/config.ts`      | the `shotTrace` field.                                                                                                                                                                                          |
| `docs/engine/debugging.md`                | the `Shot traces (temporary)` section under its `<!-- SHOTTRACE -->` marker.                                                                                                                                    |
| `.env.example`                            | the commented-out `SHOT_TRACE` block.                                                                                                                                                                           |

**And these, which are not marked:**

- `packages/client/tests/connection.test.ts`: `onShotTrace: vi.fn()` in the
  `Connection` events, or it stops typechecking.
- `packages/client/src/engine/audio/weapons.ts`: two doc comments that name
  `ShotTraceView`; reword them to name `Shots.fire` alone.

**The type byte.** Delete `shotTrace: 6` and leave every later entry
(`chooseClass: 7`, `classChosen: 8`, …) at its number, with a one-line comment
that `6` is retired. Do not renumber to close the gap: the numbers are the
format, renumbering changes the meaning of every later message for no gain, and
an unused byte costs nothing — `decodePacket` already throws on it.

**Bump `PROTOCOL_VERSION`** in `packet.ts` all the same. A server still built
with the diagnostic sends byte `6` to a client that no longer knows it, and two
builds that disagree about the message table must refuse each other at the
handshake rather than drop packets later.

The one number both ends must agree on — a bullet's reach — is **not** duplicated:
`BULLET_RANGE` lives in `@3d/shared/sim/weaponDef.ts` and both the server's trace
and this view import it. It predates this diagnostic's removal and stays behind,
which is correct: a client predicting a shot needs it whether or not anything is
being drawn. Two spellings of it would have made every clean miss report a
phantom divergence in the very tool built to measure divergence.
