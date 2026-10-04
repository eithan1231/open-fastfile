# Replicated dynamics

Everything in the world that moves and is not scenery: a corpse today, and a
grenade, a rocket and a care package on the same machinery afterwards.

The layer exists because those four are one problem. Each is a rigid body that the
server is the authority on, that every client has to agree about, and that a client
wants to predict. Solving it once is the same argument `@3d/shared/sim/` is built
on — a client predicting and a server replaying must get identical values out of
identical inputs, and two implementations of that are a divergence with nobody to
notice it.

## The two policies

`sim/entityKinds.ts` is the whole of it. A kind names four things, and the last
three decide how it is replicated:

|                   | `serverSimulates` | `correctEvery` | Gameplay reads         | Example                             |
| ----------------- | ----------------- | -------------- | ---------------------- | ----------------------------------- |
| **Cosmetic**      | false             | 0              | never                  | a corpse                            |
| **Authoritative** | true              | a few ticks    | the server's copy only | a grenade, a rocket, a care package |

A **cosmetic** entity agrees everywhere because every client starts from identical
bytes and takes the same number of steps. There is nothing to correct _to_, and
nothing in the game is wrong if it drifts — so the server spends nothing on it: it
decides the spawn, says it once, and never simulates one.

An **authoritative** entity agrees because the server says so. Clients simulate it
too, so that throwing something looks immediate, and adopt a corrective transform
when one arrives — which is exactly what `reconcile.ts` already does for the player
one layer up. Nothing in the game may read a client's copy.

Today there is one kind and it is cosmetic, so **no game server builds a physics
world at all**. `Match` builds one lazily, on the first spawn of a kind whose policy
says it simulates, and nothing reaches that yet. The correction path is declared and
exercised by nothing, deliberately: the shape is settled before the first kind that
depends on it, the way `ServerHooks` already handles hooks it has not built.

## Three things have to be identical, and each has a guard

Rapier promises the same simulation on every machine given the same version, the
same initial conditions and the same order of construction. Each is something a
caller can break.

**The same version** is an exact pin in `pnpm-workspace.yaml` — not a caret, which
is the mechanism by which two machines quietly get different engines. It is
`@dimforge/rapier3d-deterministic-compat`: the plain build says in its own README
that it does _not_ guarantee cross-platform determinism, and is about 8% faster for
it. `shared/tests/physicsDeterminism.test.ts` holds a reference hash of a fixed
600-step simulation, and **bumping the engine is defined as the act of re-recording
that constant**.

**The same initial conditions** is the wire. A spawn crosses it quantised and every
end — the server included — simulates the value it decoded, never the value it
meant. That is `roundRagdollSpawn`, and it is the rule `roundInput` already states
for a player's input in `net/packet.ts`.

> The reason it has to be sent rather than recomputed is worth stating plainly.
> `CharacterPoser` is a pure function of a snapshot and two machines posing the same
> body land within a nanometre of each other ([rendering.md](rendering.md#player-characters)).
> That is ample for a hit box and nothing at all for sixteen jointed boxes in
> contact, where a nanometre of initial condition is a different pile of bodies a
> second later. The pose is also downstream of `Quaternion.slerp`, which is `acos`
> and `sin` — both of which Rapier's own documentation names as _not_ cross-platform
> deterministic. The quantised wire is where that stops. Decoding uses `sqrt`, which
> IEEE-754 requires to be correctly rounded.

**The same order of construction** is written down rather than emergent: the map
first, then entities in ascending spawn id, then each kind's own bodies, colliders
and joints in their arrays' order. Events arriving on one snapshot are buffered and
sorted, never inserted as they were read — two players dying on the same tick is
exactly the case where a server iterating its roster and a client reading a packet
disagree.

## Stepping

`PhysicsWorld.step(tick)` advances **to** a tick, not by a frame. An entity's age is
`tick - spawnTick`, so a client that missed snapshots catches up exactly and one that
calls twice for a tick steps once. Past a second of arrears it gives up and declares
itself at the tick, which is an entity in the wrong place rather than a frame that
takes a second.

> **Never drive this from a render loop's accumulator.** The one in
> `engine/controls/firstPerson.ts` caps catch-up and then zeroes itself — "better a
> lost moment than a spiral" — which is right for a player the next snapshot corrects
> and permanent for anything here. The client steps corpses in `onSnapshot`, once per
> server tick.

Gravity is `GRAVITY` from `sim/movement.ts`, the games' own 18 m/s², not 9.81: a body
that falls at a different rate from the player who shot it reads as a bug.

## The map

`three-mesh-bvh` cannot be handed to Rapier, so the map's triangles go in a second
time as a trimesh with a QBVH over them. **Measured: dome-mw3 is 88,168 triangles in
about 75–115 ms** — its `shots` tree, which is what stops a bullet.

It is paid **per physics world rather than per map**, because a Rapier collider
belongs to one world: two games on one map build it twice, even though they share
the one `ResolvedWorld` and the one BVH off `WorldRegistry`.

Which of the map's two trees a kind takes is a claim about what it is modelling
(`CollisionWorld.mapSurfaces`). A corpse takes `shots`: what stops a bullet is what a
body can be _seen_ to rest on, and a corpse lying on an invisible railing reads worse
than one that slides off a real one. The mirror of that is a thing to expect rather
than debug — **a body can fall through a gap a living player cannot walk through**,
because `clip_player` over a window stops a player and stops nothing here.

**A removable part is a collider of its own** ([collision](collision.md#removable-parts)):
one trimesh per present part, added after the map in ascending order by
`loadTerrain(collision, set, presence)`. `setPart(index, on)` removes or rebuilds
one at a tick boundary, after that tick's step, and both ends do it at the same
tick: a game server where a script's change is applied (`MatchParts.flush`), a
client before stepping past the tick the snapshot's `presence.since` names. A
part that comes back is built again after everything already in the world, so
two ends agree on the order only if they saw the same changes — a late joiner
builds the world as it stands, which for a cosmetic body is a difference nobody
can see.

Prop hulls are not in yet, so a corpse can sink into a crate. Doing it properly means
one merged static trimesh rather than 2,842 QBVH builds (interchange-mw3's placement
count).

## A corpse

Sixteen segments and fifteen joints, in `sim/ragdollBones.ts`. Every one of the 26
exported bodies has all sixteen bones, and `game-server/tests/ragdollTable.test.ts`
is what keeps that true of the 27th.

**The colliders are the body's own hit boxes.** A corpse is made of the volumes it
was being shot at a moment earlier, which means a new export gets a ragdoll with no
work at all — the boxes are already derived from its skin weights
(`scripts/cod/hitboxes.py`). A hit box is in its bone's own space, in inches
([collision.md](collision.md#where-the-boxes-come-from)); `BindPose.worldOf` already
carries the rig's `unit-scale`, so the number 0.0254 appears nowhere in the
conversion.

Which bones a segment swallows is **derived by walking the real skeleton**, not
written down — `hitLocationOf`'s rule with sixteen roots instead of thirty. That is
what puts `j_hiptwist_le` on a thigh, which reads like a pelvis joint and is a child
of `j_hip_le`; a hand-written table had it in the trunk.

**Masses are explicit anthropometric fractions of 72 kg**, never volume × density.
Three ghillie bodies skin a hood to `j_head` and derive a head 0.49 m across, and a
density-derived mass would give them a twelve-kilogram skull and a corpse that lands
face first every time. The same box is the only one with a size cap, and the cap is
on the **collider only** — the hit box is untouched, because that is a question about
who dies and this is a question about whether a chin goes through the floor.

**Damping is the main dial on how a corpse reads**, and it is per segment. Joint
limits say where a limb may go; damping says how fast it gets there, and limits
alone give a body that reaches its stops and snaps between them — flailing, which is
the commonest way a ragdoll looks wrong. Legs are damped three times as hard as
arms, and that asymmetry is the shape of a fall: a body knocked backwards should go
over about its feet in one piece, where loose legs fold at the knee and the corpse
sits down into a heap. Arms stay loose because an arm _should_ trail.

`game-server/tests/corpseKnock.test.ts` measures it, against each limb's own root
rather than against the hips — a rigidly rolling body moves a foot most of a metre
relative to its pelvis in world axes, so measuring there says a rigid leg is
flailing.

Two pieces of Rapier behaviour the whole thing rests on, both measured in
`shared/tests/physicsDeterminism.test.ts` because neither is in the JS docs:

- **A spherical joint's limits are per angular axis, not a cone and a twist.** They
  live on the raw joint set (`physics/joints.ts` owns the one cast), and ±θ on all
  three axes admits θ·√3 about a diagonal — so a table written as "a 45° cone" would
  be half again as loose as it read.
- **`setContactsEnabled(false)` on every joint is a requirement, not tuning.**
  Adjacent segments touch by construction, and contact resolution between two bodies
  a joint already holds fights the joint: 0.020 rad of movement with contacts against
  3.137 without. It looks exactly like a joint limit set to zero and is not one.

## What a round does

Two things, and they travel as two fields, because one number cannot do both jobs.
Big enough to throw a body, a single impulse at the bone that was hit tears the limb
off its joint; small enough to look right on the limb, it moves the body not at all.

- A **body knock** — a speed along the round given to every segment, which carries
  the corpse backwards and makes it fall the way it was shot.
- A **local knock** — a further speed given only to the segment that was hit, which
  is the snap. Expressed as a speed rather than a force so that it is the same
  visible whip wherever it lands; the same impulse is 61 m/s into a 0.44 kg hand and
  1.7 m/s into a 16 kg chest.

A sniper head shot is then the sequence you would want, and
`corpseKnock.test.ts` asserts it: the head goes first and furthest, the chest follows
through the neck, the hips after that, and the feet move least.

**The body knock is shared out by height** — a quarter at the soles, nearly double at
the crown. Given to every segment equally it merely slides the body backwards, feet
and all, and which way it then topples is decided by whatever lean the last animation
frame happened to have: a hand shot measured a metre _toward_ the shooter. Weighted,
it is a torque about the feet instead, which is what a round does to somebody
standing up.

Three things have gone wrong here and each is worth knowing about:

- **`setLinvel` assigns rather than adds.** Applying the impulse before the
  velocities silently wiped it off the only segment it was meant for, and no shot
  moved anything at all. `startRagdoll` owns the order now so no caller can get it
  wrong again.
- **A corpse used to spawn inside the floor.** A body's hit boxes reach about 1.4 cm
  below the sole it stands on — harmless for a hit box, not for a collider. Rapier
  ejected it and the hips rose 10 cm on every death, before anything had been shot.
  `SPAWN_LIFT` is the two centimetres that takes it away.
- **A corpse made of somebody already falling tunnels.** Thirty metres of drop is
  33 m/s, which is over half a metre per step and further than most floors are
  thick. `RAGDOLL_CCD_PREDICTION` is the soft continuous collision that catches it.

## Drawing one

`client/net/corpses.ts` owns a root beside the scene, like `engine/fx/` and
`net/remotePlayers.ts`, and drives its own matrices. The body is **handed over, not
rebuilt**: the rig `RemotePlayers` is drawing is already the one `bodyIndex` chose
from that player's id, which is the body the server traced the killing round against.

There is **no death clip**, and there should not be one — `CHARACTER_ROLES` has none
because the source games have none. CoD multiplayer deaths are ragdolls.

The engine inlines its wasm as base64, so it is ~2.9 MB of JavaScript. It is fetched
in `WorldSession.mount`'s `"physics"` step through the only dynamic `import()` in the
client, and `client/tests/physicsChunk.test.ts` fails if anything in the static graph
reaches it for its value. It has already happened once: one `import` in
`net/corpses.ts` put the whole engine in the bundle a menu is drawn from, and the
only reason anybody noticed was reading a build log.

## What a grenade would add

An entry in `sim/entityKinds.ts` with `serverSimulates: true` and a `correctEvery`, a
spawn payload beside `ragdollSpawn`, a branch in the event codec, a `projectile`
value in `TraceChannel` — which [collision.md](collision.md#a-bullet-and-a-player-collide-with-different-things)
already anticipates by name — and the client predicting its own throw and adopting
the corrections.

**If it needs a change to `physics/world.ts` or `net/messages/entities.ts`, the seam
was drawn in the wrong place.**

## Tuning it

Everything that decides how a death _feels_ is a named constant in
`sim/ragdollBones.ts`, and they are the only numbers in that file chosen by eye
rather than measured:

| Dial                                        | What it changes                                          |
| ------------------------------------------- | -------------------------------------------------------- |
| `SEGMENT_ANGULAR_DAMPING`                   | How much each limb flails. The first thing to reach for. |
| `SEGMENT_JOINTS`' limits                    | How far each joint may open. Per axis, not a cone.       |
| `BODY_KNOCK_PER_DAMAGE`, `MAX_BODY_KNOCK`   | How far a corpse is thrown.                              |
| `LOCAL_KNOCK_PER_DAMAGE`, `MAX_LOCAL_KNOCK` | How hard the bone that was hit snaps.                    |
| `KNOCK_AT_FEET`, `KNOCK_AT_HEAD`            | How much it topples against how much it slides.          |

`corpseKnock.test.ts` is what says whether a change made it better or merely
different. Its bounds are regression guards rather than targets — they are wide
enough for taste to move inside.

## Known rough edges

- **The bend axis of an elbow and a knee is convention, not measurement.** A CoD bone
  runs along its own local X, so the bend is Y or Z, and `SEGMENT_JOINTS` says Z. It
  is wrong in the cheapest way to find — an arm that folds sideways — and it is one
  field per joint to change. The limb excursions measure sane, which is weak evidence
  and not proof.
- **A corpse sinks into props**, which have no colliders in the physics world yet.
- **The numbers above have been measured, not watched.** Every claim on this page is
  held up by a test. Whether a corpse _looks_ right is a judgement only a screen can
  make, and the dials are laid out above for exactly that reason.
