// The messages themselves (src/net/packet.ts and src/net/messages/): that each
// round-trips, that what it loses it loses within its declared precision, and
// that a malformed packet throws instead of decoding into a plausible player.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { decodePacket, encodePacket, MessageType } from "../src/net/packet.js";
import { roundTrip } from "../src/net/codec/schema.js";
import { inputMessage, inputsOf, REDUNDANT_INPUTS, roundDt, roundInput, roundRenderFrac, type InputPacket } from "../src/net/messages/input.js";
import { MAX_SPAWNS_PER_SNAPSHOT, MAX_SNAPSHOT_EVENTS, type GameEvent } from "../src/net/messages/events.js";
import type { SnapshotMessage } from "../src/net/messages/snapshot.js";
import type { JoinedMessage, JoinMessage } from "../src/net/messages/session.js";
import { DEFAULT_COMBAT_RULES } from "../src/game/rules.js";
import { CLASS_TIMINGS } from "../src/game/classes.js";
import { CollisionWorld } from "../src/collision/world.js";
import { RAGDOLL_SEGMENTS } from "../src/sim/ragdollBones.js";
import { idleInput, type PlayerInput } from "../src/sim/input.js";
import { MAX_HEALTH, Player } from "../src/sim/player.js";
import { WeaponController } from "../src/sim/weapon.js";
import type { WeaponDef } from "../src/sim/weaponDef.js";
import { MAX_ATTACHMENT_SLOTS, MAX_FITTED_ATTACHMENTS, WeaponRegistry, type WeaponEntry } from "../src/sim/weaponRegistry.js";
import { weaponDef } from "../testing/weaponDef.js";

/** A player with a weapon, on a floor, so a snapshot has something real in it. */
function setupPlayer(over: Partial<WeaponDef> = {}) {
  const root = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40));
  floor.position.set(0, -0.5, 0);
  floor.userData.collide = true;
  root.add(floor);
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const player = new Player(collision);
  const weapon = new WeaponController(weaponDef(over));
  weapon.ready();
  player.equip(weapon);
  return { player, weapon, collision };
}

describe("packets", () => {
  it("round-trips a join and a joined exactly", () => {
    const join: JoinMessage = {
      protocol: 1,
      gameId: "g-7f3a",
      playerId: "abc123",
      authorizationKey: "k".repeat(32),
      catalogHash: "1a2b3c4d",
      worldHash: "0badf00d",
      engine: "firef",
    };
    expect(decodePacket(encodePacket(MessageType.join, join))).toEqual({ type: MessageType.join, message: join });

    const joined: JoinedMessage = {
      tickRate: 60,
      gametype: "default",
      rules: { maxHealth: DEFAULT_COMBAT_RULES.maxHealth, timedRespawn: true },
      eventId: 4321,
      spawned: true,
      classes: false,
    };
    expect(decodePacket(encodePacket(MessageType.joined, joined))).toEqual({ type: MessageType.joined, message: joined });
    // A gametype that brings the dead back itself, at the most health the wire carries.
    const scripted = { ...joined, rules: { maxHealth: MAX_HEALTH, timedRespawn: false } };
    expect(decodePacket(encodePacket(MessageType.joined, scripted)).message).toEqual(scripted);
  });

  it("round-trips choosing a class, and the answer", () => {
    expect(decodePacket(encodePacket(MessageType.chooseClass, { index: 4 }))).toEqual({ type: MessageType.chooseClass, message: { index: 4 } });
    for (const timing of CLASS_TIMINGS) {
      expect(decodePacket(encodePacket(MessageType.classChosen, { index: 2, timing })).message).toEqual({ index: 2, timing });
    }
  });

  it("round-trips a refusal, so a join that will not be answered says why", () => {
    const message = { reason: 'it asked for game "g-7f3a", which we do not host' };
    expect(decodePacket(encodePacket(MessageType.refused, message)).message).toEqual(message);
  });

  it("round-trips an input within its quantization, and exactly once pre-rounded", () => {
    const input: PlayerInput = {
      yaw: 1.2345678,
      pitch: -0.4,
      forward: 1,
      right: -0.5,
      run: true,
      jump: false,
      crouch: false,
      prone: true,
      fire: true,
      ads: false,
      reload: true,
      swap: false,
      use: true,
    };
    const claim = { x: 1.5, y: 2.25, z: -3.75 };
    // A tick at the top of its range and a fraction that is not a round number:
    // both are the moment a shot was aimed at, and both are quantized.
    const message: InputPacket = { seq: 65535, dt: 1 / 60, input, claim, drawn: { tick: 65534, frac: roundRenderFrac(0.37) }, earlier: [] };
    const back = decodePacket(encodePacket(MessageType.input, message));
    expect(back.type).toBe(MessageType.input);
    expect(back.message).toMatchObject({ seq: 65535 });

    // The claim rides with the input that produced it, so the server needs nothing
    // but `seq` to line the two up.
    const decoded = back.message as InputPacket;
    expect(decoded.input.use).toBe(true);
    expect(decoded.input.swap).toBe(false);
    expect(decoded.claim).toEqual(claim);
    // An input that drew nobody says so in a bit, rather than naming tick 0.
    const alone = decodePacket(encodePacket(MessageType.input, { ...message, drawn: null })).message as InputPacket;
    expect(alone.drawn).toBeNull();

    // The symmetry rule: what a sender predicts with survives the wire untouched.
    const rounded = roundTrip(inputMessage, {
      seq: 12,
      dt: roundDt(1 / 60),
      input: roundInput(input),
      claim,
      // The rule reaches the moment a shot was aimed at too: a client tracing with
      // an unrounded fraction disagrees with the server about where the target was.
      drawn: { tick: 4242, frac: roundRenderFrac(0.37) },
      earlier: [],
    });
    expect(decodePacket(encodePacket(MessageType.input, rounded)).message).toEqual(rounded);
  });

  it("repeats the inputs before the newest, each with its own moment, and numbers them", () => {
    const claim = { x: 1, y: 0, z: 2 };
    // Across the wrap, so the implicit seqs are worked out the way `after` reads them.
    const packet = roundTrip(inputMessage, {
      seq: 1,
      dt: roundDt(1 / 60),
      input: roundInput({ ...idleInput(0.5, 0), forward: 1 }),
      claim,
      drawn: { tick: 902, frac: roundRenderFrac(0.25) },
      earlier: [
        { dt: roundDt(1 / 60), input: roundInput({ ...idleInput(0.4, 0), fire: true }), drawn: { tick: 900, frac: roundRenderFrac(0.75) } },
        { dt: roundDt(1 / 50), input: roundInput(idleInput(0.45, 0.1)), drawn: null },
      ],
    });
    const back = decodePacket(encodePacket(MessageType.input, packet)).message as InputPacket;
    expect(back).toEqual(packet);

    const inputs = inputsOf(back);
    expect(inputs.map((i) => i.seq)).toEqual([65535, 0, 1]);
    // A fire inside a repeated input is judged at the moment *it* was built at.
    expect(inputs[0]).toMatchObject({ drawn: packet.earlier[0]!.drawn, claim: null });
    expect(inputs[1]!.drawn).toBeNull();
    expect(inputs[0]!.input.fire).toBe(true);
    expect(inputs[1]!.dt).toBe(packet.earlier[1]!.dt);
    // Only the newest carries a claim: the others' were measured when they were.
    expect(inputs[2]!.claim).toEqual(back.claim);
  });

  it("round-trips a snapshot of several players, weapon and all", () => {
    const { player } = setupPlayer();
    player.place({ x: 3.5, y: 0, z: -12.25 }, 1.1, -0.2);
    player.step({ ...idleInput(1.1, -0.2), forward: 1, fire: true }, 1 / 60);

    const message: SnapshotMessage = {
      tick: 4_000_000_000,
      ack: 7,
      presence: null,
      players: [
        { id: "a", state: player.snapshot() },
        {
          id: "b",
          state: {
            movement: player.snapshot().movement,
            weaponIndex: null,
            attachments: [],
            weapon: null,
            slot: 1,
            spareIndex: 3,
            spareAttachments: [2],
            armed: 5,
            swapping: false,
            stowed: false,
            team: 1,
            health: 100,
            dead: false,
            respawnIn: 0,
            points: 1_048_575,
          },
        },
      ],
      actors: [],
      // A zombies match's round and a second counter, below zero.
      counters: [12, -3],
      // Both kinds at once: the two write different fields after a shared kind
      // and id, so a reader that ignored the kind would decode the second from
      // the first one's bits and answer plausibly.
      events: [
        { kind: "hit", id: 9, lethal: true },
        { kind: "death", id: 10, victim: "b", killer: "a", cause: "bullet" },
        { kind: "death", id: 11, victim: "a", killer: null, cause: "outOfWorld" },
        // A script's own, whose fields are a string, two nullable numbers and a
        // nullable player — nothing else in the tail is shaped like it, and
        // `undefined` is not one of the things it may carry: absent is null on the
        // wire and stays null.
        { kind: "announce", id: 12, what: "flagTaken", team: 1, value: 30, player: null },
        { kind: "announce", id: 13, what: "roundStart", team: null, value: null, player: null },
        { kind: "announce", id: 14, what: "purchase", team: null, value: 750, player: "a" },
      ],
    };
    const back = decodePacket(encodePacket(MessageType.snapshot, message));
    expect(back.type).toBe(MessageType.snapshot);
    const decoded = back.message as SnapshotMessage;
    expect(decoded.tick).toBe(4_000_000_000);
    expect(decoded.ack).toBe(7);
    expect(decoded.players.map((p) => p.id)).toEqual(["a", "b"]);
    expect(decoded.events).toEqual(message.events);
    expect(decoded.players[1]!.state.weapon).toBeNull();
    expect(decoded.players[1]!.state).toMatchObject({ slot: 1, spareIndex: 3, spareAttachments: [2], armed: 5 });

    const original = message.players[0]!.state;
    const wire = decoded.players[0]!.state;
    // f32 positions: exact to a float's precision, not to a double's.
    expect(wire.movement.feet.x).toBeCloseTo(original.movement.feet.x, 5);
    expect(wire.movement.grounded).toBe(original.movement.grounded);
    expect(wire.weapon!.state).toBe(original.weapon!.state);
    expect(wire.weapon!.ammo).toBe(original.weapon!.ammo);
    expect(wire.weapon!.clip?.role).toBe(original.weapon!.clip?.role);
  });

  /**
   * The list of fitted slots is the one variable-length thing in a player's
   * state, so it is the one that can silently truncate. It does not: over the
   * cap the encoder throws and the packet is never sent.
   */
  it("round-trips every fitted set the wire allows, and refuses one too many", () => {
    const { player } = setupPlayer();
    const state = player.snapshot();
    const fitted = Array.from({ length: MAX_FITTED_ATTACHMENTS }, (_, i) => i + MAX_ATTACHMENT_SLOTS - MAX_FITTED_ATTACHMENTS);
    const message: SnapshotMessage = {
      tick: 1,
      ack: 0,
      presence: null,
      players: [{ id: "a", state: { ...state, attachments: fitted } }],
      actors: [],
      counters: [],
      events: [],
    };

    const back = decodePacket(encodePacket(MessageType.snapshot, message)).message as SnapshotMessage;
    expect(back.players[0]!.state.attachments).toEqual(fitted);

    const tooMany = { ...message, players: [{ id: "a", state: { ...state, attachments: [...fitted, 0] } }] };
    expect(() => encodePacket(MessageType.snapshot, tooMany)).toThrow(/exceeds/);

    const offTheEnd = { ...message, players: [{ id: "a", state: { ...state, attachments: [MAX_ATTACHMENT_SLOTS] } }] };
    expect(() => encodePacket(MessageType.snapshot, offTheEnd)).toThrow(/cannot carry/);
  });

  /**
   * The shot counter is the one field on the wire that a server *reads a decision
   * out of* rather than merely relaying: it learns that a shot happened by
   * replaying an input and watching this advance. So it has to survive the wire
   * exactly, survive a `restore`, and keep counting from where it was left — a
   * field that reset to zero on every correction would report a burst of 65535
   * the next tick, which is a plausible enough number to reach a kill feed.
   */
  it("carries the shot counter through a restore, and a replay of the same inputs reaches the same count", () => {
    const firing: PlayerInput = { ...idleInput(0, 0), fire: true };
    const { player } = setupPlayer({ clipSize: 30 });
    for (let i = 0; i < 30; i++) {
      player.step(firing, 1 / 60);
    }
    const state = player.snapshot();
    expect(state.weapon!.fired).toBeGreaterThan(2);

    const message: SnapshotMessage = { tick: 1, ack: 0, presence: null, players: [{ id: "a", state }], actors: [], counters: [], events: [] };
    const wire = (decodePacket(encodePacket(MessageType.snapshot, message)).message as SnapshotMessage).players[0]!.state;
    expect(wire.weapon!.fired).toBe(state.weapon!.fired);

    // A second player corrected to that state, as a client adopting a snapshot is.
    const { player: corrected } = setupPlayer({ clipSize: 30 });
    corrected.restore(wire);
    expect(corrected.snapshot().weapon!.fired).toBe(state.weapon!.fired);

    // And replaying the same inputs from it counts the same rounds, which is the
    // property a server's re-simulation depends on.
    for (let i = 0; i < 30; i++) {
      player.step(firing, 1 / 60);
      corrected.step(firing, 1 / 60);
    }
    expect(corrected.snapshot().weapon!.fired).toBe(player.snapshot().weapon!.fired);
    expect(player.snapshot().weapon!.fired).toBeGreaterThan(state.weapon!.fired);
  });

  it("round-trips a snapshot with no players", () => {
    const empty: SnapshotMessage = { tick: 0, ack: 0, presence: null, players: [], actors: [], counters: [], events: [] };
    expect(decodePacket(encodePacket(MessageType.snapshot, empty)).message).toEqual(empty);
  });

  it("round-trips a world's presence bits, and costs one bit for a world with none", () => {
    // Twelve solids, the first and the last three present: two bytes, the tick they last changed on, and a length.
    const presence = { since: 65535, bits: [0b0000_0001, 0b0000_1110] };
    const doors: SnapshotMessage = { tick: 70000, ack: 3, presence, players: [], actors: [], counters: [], events: [] };
    expect(decodePacket(encodePacket(MessageType.snapshot, doors)).message).toEqual(doors);
    const none = encodePacket(MessageType.snapshot, { ...doors, presence: null }).length;
    // 16 + 10 + 2 × 8 = 42 bits past the null's one: five or six bytes, by where they start.
    const more = encodePacket(MessageType.snapshot, doors).length - none;
    expect(more).toBeGreaterThanOrEqual(5);
    expect(more).toBeLessThanOrEqual(6);
  });

  it("is far smaller than JSON, which is the entire point", () => {
    // Armed out of a catalogue, as a player in a match is: both weapons then
    // travel as an index, which a player holding a weapon no registry lists
    // (`setupPlayer`) spends one bit on instead of nine.
    const { collision } = setupPlayer();
    const entry = (id: string): WeaponEntry => ({ id, game: "iw5", display: id, slot: "primary", def: weaponDef(), attachments: [] });
    const player = new Player(collision, new WeaponRegistry([entry("one_mp"), entry("two_mp")]));
    player.equipWeapons({ weapon: "iw5/one_mp", attachments: [] }, { weapon: "iw5/two_mp", attachments: [] });
    // Long enough for the weapon to be up and its idle clip playing: the state a player spends most ticks in.
    for (let i = 0; i < 240; i++) {
      player.step(idleInput(1, 0.2), 1 / 60);
    }
    expect(player.snapshot()).toMatchObject({ weaponIndex: 0, spareIndex: 1, weapon: { state: "idle", clip: { role: "idle" } } });
    const input: InputPacket = {
      seq: 1,
      dt: 1 / 60,
      input: idleInput(1, 0.2),
      claim: player.snapshot().movement.feet,
      drawn: { tick: 900, frac: 0.5 },
      earlier: [],
    };
    const snapshot: SnapshotMessage = {
      tick: 1,
      ack: 1,
      presence: null,
      players: [{ id: "abc12345", state: player.snapshot() }],
      actors: [],
      counters: [],
      events: [],
    };

    // Budgets, so that a carelessly added field shows up as a failing test rather
    // than as a packet that no longer fits a datagram. 62 bytes covers an 8-byte
    // id, 32½ bytes of movement (mostly the six f32s of position and velocity),
    // 12 of weapon and 13 bits saying which weapon it is and where — the id being
    // the one field paying for itself in nothing. The paragraphs below are what
    // has been added since, and why each earns its place; they are what takes the
    // budget to the numbers asserted at the end.
    //
    // Which weapon is held costs 9 bits (a nullable index into the catalogue)
    // plus 2 for an empty attachment list, against the ~72 a name would have cost
    // here and in every snapshot after it. That is the whole reason the wire
    // carries an index and `catalogHash` makes a mismatched catalogue loud.
    //
    // The attachments were a byte of slot flags until the catalogue grew lists of
    // eleven; a counted list of slot indices is 6 bits for the one attachment a
    // player usually fits and 14 for the three the wire allows, and it does not
    // widen again when a weapon starts offering a twelfth.
    //
    // The last two bits are `swapping` and `stowed`, which are here rather than
    // kept client-side because a server replaying a swap or a climb has to reach
    // the same hand (sim/player.ts).
    //
    // Movement's last byte and a half is the ladder and jump bookkeeping: whether
    // a ladder is held, the lock, the time since a jump, and whether jump was down.
    //
    // Then two bytes for the pose blends, `gait` and `airborne`. Each is a smoothed
    // boolean — how much of a gait is under way, how far off the ground the pose is —
    // and they are here because the transitions they smooth are what a body is drawn
    // *between*, so a hit box traced against a posed skeleton needs the same answer
    // the client drew. Deriving them from speed was measured and rejected: a player
    // crosses IDLE_SPEED in one tick, so a speed-keyed crossfade lasts 17 ms.
    //
    // Then two more for the direction of travel — forward and right, in the player's
    // own frame, each smoothed. Not derivable from the velocity, which is already
    // here: the *direction* of a vector is discontinuous where the vector passes
    // through zero, and that is every stop and every change of heading. Taken
    // straight from the velocity, reversing out of a run swapped one leg clip for
    // another between two frames and stopping swapped it for the idle, a full 2.0 of
    // weight in a single tick either way. Nothing instantaneous can fix that — a
    // reversal crosses zero in about three ticks — so the smoothing is in the state,
    // and a body drawn through the transition means a hit box traced through it too.
    //
    // Then one byte for `stride`, the run-cycle phase. It is here for the same
    // reason `swapping` is: a bullet is traced against a posed skeleton, and a
    // phase each end integrated on its own frame times would put a peer's legs in
    // two places. 8 bits is 1/256 of a cycle, ~7 ms of stride.
    //
    // `team` costs 1 bit in a free-for-all and 4 on a side — an index into the
    // gametype's `teams`, which both ends already hold, against ~48 bits for a
    // name. It fits in the padding the rest of the layout already had, which is
    // why the total did not move when it was added.
    //
    // The weapon's `span` is 12 bits and does move it, by a byte. It is what
    // `timer` started at, and it is here because a countdown cannot say how far
    // through a state anything is: a third-person body's torso plays a reload clip
    // stretched to fit `reloadTime`, and `(span - timer) / span` is the only way to
    // place it. Derivable from nothing else in the state, which is the test any
    // field has to pass to be on the wire at all.
    //
    // `fired` is the other two bytes, and the newest. It is a shot counter rather
    // than a shot flag because the server learns that somebody fired by replaying
    // their input and watching it advance — so it has to survive a correction and
    // keep counting, and the same number says *which* shot it was, which is what a
    // seeded cone and a recoil kick will key on. Sixteen bits so that wrapping is
    // rare and, when it happens, both ends wrap at the same place.
    //
    // Health is the last four bytes, and the only ones that have moved the
    // snapshot since `fired`: ten bits of health, one for `dead`, and a byte for
    // the time left of a respawn. Ten bits rather than a byte because
    // `CombatRules.maxHealth` is a gametype's to set and 255 is a number a mode
    // could plausibly want; the clock is here rather than derived because a
    // client cannot count a countdown it was never told the start of. An input
    // carries none of it: a client never predicts its own health, so there is
    // nothing to claim.
    //
    // The snapshot's event tail is *not* in this number, and that is the point of
    // it: an empty tail is a three-bit count that fits in the padding this layout
    // already had, so a quiet tick — which is nearly all of them — costs exactly
    // what it did before events existed. What a tail costs when it carries
    // something is measured in the test below, where it belongs: it is variable,
    // and a ceiling on it would be a ceiling on how much can happen in a tick.
    //
    // The spread and the kick are the last seven bytes, and the only ones since
    // health to move the snapshot. They were a client's drawing effect and are
    // simulation now: a shot goes along the player's intent *plus* the kick, and
    // the server is the end that decides what it hit — so a client predicting a
    // different kick would watch its own crosshair argue with its hit markers.
    // Ten bits of cone, twelve of gun-kick angle each way and eleven of gun-kick
    // speed, then the view kick's twelve of angle and **sixteen of speed** each
    // way — 112 bits exactly. They land on a byte boundary on purpose, so the
    // event tail below still costs what it did. The view kick's speed is on the
    // wire because a round sets a speed rather than an angle (sim/recoil.ts): a
    // correction that dropped it would leave a corrected client's view hanging
    // where the server's was still falling. An input carries none of it, which is
    // the whole of C3 — a client sends its intent and never its aim.
    //
    // An input is 9 bytes of command plus 12 of claim: where the client's feet
    // came to rest, three f32s, which is all the server measures its own answer
    // against.
    //
    // One byte more for the weapon on a player's back and the count of times they
    // have been armed (`PlayerState.armed`): seven bits, so a weapon a server
    // hands over mid-life is rebuilt rather than guessed at.
    //
    // And one byte for the actors' count, which is all they cost when there are
    // none: twelve bytes each when there are (net/messages/actors.ts).
    //
    // The use key is one bit of an input.
    //
    // Twenty bits of a player's purse (`PlayerState.points`), a million, in
    // every snapshot for every player — state and not an event, so a price shown
    // and a price charged agree on every tick — and four for the count of the
    // gametype's counters, which is all they cost in a gametype with none. Three
    // whole bytes together, so the tail after them costs what it did.
    //
    // Two bits of an input's count of repeated inputs fit the slack of its last
    // byte, so a client with nothing outstanding sends what it did. In play it
    // repeats `REDUNDANT_INPUTS` (two) of them, 94 bits each — twelve of `dt`, 57
    // of command and 25 of the moment it was aimed at, with no seq and no claim —
    // which is 24 bytes more, the price of a lost datagram costing no input.
    expect(encodePacket(MessageType.input, input).length).toBeLessThanOrEqual(27);
    const repeated = { ...input, earlier: Array.from({ length: REDUNDANT_INPUTS }, () => input) };
    expect(encodePacket(MessageType.input, repeated).length).toBeLessThanOrEqual(51);
    expect(encodePacket(MessageType.snapshot, snapshot).length).toBeLessThanOrEqual(94);

    // Still most of an order of magnitude, which is what justifies the machinery.
    // An input's margin is the narrower of the two: its claim is three f32s, and
    // JSON spends fewer characters on a round number than the wire spends bits
    // on any number at all.
    expect(encodePacket(MessageType.input, input).length * 6).toBeLessThan(JSON.stringify(input).length);
    expect(encodePacket(MessageType.snapshot, snapshot).length * 5).toBeLessThan(JSON.stringify(snapshot).length);
  });

  /**
   * The budget above is a *quiet* snapshot, and it is exactly the same number it
   * was before the tail existed: an empty tail is a three-bit count, and it fits
   * in the padding the layout already had. That is what makes the assertion
   * above still the one that matters — almost every tick is quiet.
   *
   * What a tail costs when there is something in it is asserted here instead,
   * because it is variable and there is no single number to put a ceiling on. A
   * hit marker is nineteen bits — a kind, an id and whether it killed. A death
   * is twenty-one, and nearly all of it is the two player ids — the same ~72 bits a
   * snapshot already spends naming each player, and the same per-match slot
   * number would fix both at once.
   *
   * The seven the count can express cost 146 bytes over a quiet one. That is not
   * near anything: a datagram has well over a kilobyte, and a twelve-player
   * snapshot is about 1,012 bytes with no tail at all. The kind field is two
   * bits, which is the four kinds there are.
   *
   * **An announcement is the cheap one**, which is what lets it be repeated for
   * twice a death's window: five bytes for a bare name, fifteen for a nine-letter
   * one with a side and a number on it — against twenty-one for a death, which is
   * mostly its two player ids.
   *
   * **A spawn is the one that is actually large.** A hundred and five bytes, two
   * thirds of it the sixteen quaternions describing the pose a corpse starts from,
   * against twenty-one for the death that caused it. That is what
   * `MAX_SPAWNS_PER_SNAPSHOT` is for and why deaths have no such cap: two spawns
   * and five deaths is 314 bytes of tail, so a twelve-player snapshot on the worst
   * tick a match can have is about 1,330 — still inside a datagram, and
   * deliberately measured rather than assumed.
   *
   * The two worst-case figures are bounds rather than equalities, and that is not
   * slack: the tail is bit-packed onto the end of the players, so where it starts
   * — and therefore whether it needs one more byte — depends on how many players
   * the snapshot carried.
   */
  it("costs nothing for a quiet tail, three bytes for a hit marker and twenty-one for a death", () => {
    const { player } = setupPlayer();
    const state = player.snapshot();
    const quiet: SnapshotMessage = { tick: 1, ack: 1, presence: null, players: [{ id: "abc12345", state }], actors: [], counters: [], events: [] };
    const size = (events: GameEvent[]): number => encodePacket(MessageType.snapshot, { ...quiet, events }).length;

    // The ids are eight characters because that is what the api mints
    // (api/src/matchmaking/ids.ts); a death's cost is mostly them.
    const death: GameEvent = { kind: "death", id: 2, victim: "abc12345", killer: "zyx54321", cause: "bullet" };
    const spawn: GameEvent = {
      kind: "spawn",
      id: 4,
      entity: 7,
      what: "ragdoll",
      tick: 900,
      ragdoll: {
        victim: "abc12345",
        origin: { x: 1, y: 2, z: 3 },
        rotations: RAGDOLL_SEGMENTS.map(() => ({ x: 0, y: 0, z: 0, w: 1 })),
        velocity: { x: 1, y: 0, z: -2 },
        knock: { x: 0, y: 0.2, z: -1.4 },
        segment: 3,
        impulse: { x: 40, y: 10, z: -5 },
      },
    };

    expect(size([])).toBe(encodePacket(MessageType.snapshot, quiet).length);
    // Two or three, by where the tail starts. Here it is three.
    expect(size([{ kind: "hit", id: 1, lethal: false }])).toBe(size([]) + 3);
    // Twenty-one: the two ids, and three bits of cause.
    expect(size([death])).toBe(size([]) + 21);
    expect(size([{ kind: "announce", id: 5, what: "go", team: null, value: null, player: null }])).toBe(size([]) + 6);
    // Fourteen or fifteen, by where the tail starts: a name is bytes and
    // everything around it is bits, 117 of them. Here it is fifteen.
    expect(size([{ kind: "announce", id: 5, what: "flagTaken", team: 1, value: 3, player: null }])).toBe(size([]) + 15);
    // The expensive one, and the reason it is capped per tail.
    expect(size([spawn])).toBe(size([]) + 105);
    expect(size(Array.from({ length: MAX_SNAPSHOT_EVENTS }, (_, i) => ({ ...death, id: i + 1 })))).toBeLessThanOrEqual(size([]) + 146);
    // The worst tail a match can produce, which is what the cap makes it.
    const busiest: GameEvent[] = [
      ...Array.from({ length: MAX_SPAWNS_PER_SNAPSHOT }, (_, i) => ({ ...spawn, id: i + 1 })),
      ...Array.from({ length: MAX_SNAPSHOT_EVENTS - MAX_SPAWNS_PER_SNAPSHOT }, (_, i) => ({ ...death, id: i + 3 })),
    ];
    expect(size(busiest)).toBeLessThanOrEqual(size([]) + 314);

    // And the count is a hard edge rather than a widening field: an eighth event
    // throws here rather than arriving as a differently shaped packet.
    expect(() => size(Array.from({ length: MAX_SNAPSHOT_EVENTS + 1 }, (_, i) => ({ ...death, id: i + 1 })))).toThrow(/exceeds/);
  });

  it("throws on a malformed packet instead of decoding garbage", () => {
    expect(() => decodePacket(new Uint8Array(0))).toThrow();
    expect(() => decodePacket(new Uint8Array([200]))).toThrow(/unknown message type/);

    const good = encodePacket(MessageType.snapshot, {
      tick: 1,
      ack: 1,
      presence: null,
      players: [{ id: "a", state: setupPlayer().player.snapshot() }],
      actors: [],
      counters: [],
      events: [],
    });
    for (let cut = 1; cut < good.length; cut++) {
      expect(() => decodePacket(good.subarray(0, cut))).toThrow();
    }
  });

  it("survives random bytes: it either throws or decodes, never returns junk silently", () => {
    let decoded = 0;
    for (let i = 0; i < 2000; i++) {
      // Wide enough to reach a whole input packet, the longest of the fixed-size
      // messages: a range that could never hold one would make this vacuous.
      const bytes = new Uint8Array(1 + (i % 72));
      for (let b = 0; b < bytes.length; b++) {
        bytes[b] = (i * 31 + b * 17) & 0xff;
      }
      try {
        const packet = decodePacket(bytes);
        // Whatever came back must at least be one of the known types.
        expect(Object.values(MessageType)).toContain(packet.type);
        decoded++;
      } catch {
        // Expected for most inputs.
      }
    }
    // The test would pass vacuously if nothing ever decoded.
    expect(decoded).toBeGreaterThan(0);
  });
});

describe("the simulation over the wire", () => {
  it("carries a player's whole state: a decoded copy steps in lockstep with the original", () => {
    // The binary counterpart of the JSON lockstep tests in movement.test.ts and
    // weapon.test.ts. A quantized field cannot be compared with toEqual, so this
    // asserts the divergence stays within the format's declared precision over a
    // run long enough for an unsent field to show up as drift.
    const a = setupPlayer();
    const b = setupPlayer();
    a.player.place({ x: 0, y: 0, z: 0 }, 0.3, -0.1);

    const input = { ...idleInput(0.3, -0.1), forward: 1, run: true };
    for (let i = 0; i < 60; i++) {
      a.player.step(input, 1 / 60);
    }

    const packet = encodePacket(MessageType.snapshot, {
      tick: 1,
      ack: 1,
      presence: null,
      players: [{ id: "a", state: a.player.snapshot() }],
      actors: [],
      counters: [],
      events: [],
    });
    const wire = (decodePacket(packet).message as SnapshotMessage).players[0]!.state;
    b.player.restore(wire);

    // Both now step the same inputs. If anything that matters to the step were
    // missing from the schema, the two would part company here.
    const script: PlayerInput[] = [
      { ...input, fire: true },
      { ...input, fire: true, ads: true },
      { ...input, forward: 0, reload: true },
      { ...idleInput(0.9, 0.2), jump: true },
    ];
    for (let i = 0; i < 240; i++) {
      const step = script[Math.floor(i / 60)]!;
      a.player.step(step, 1 / 100);
      b.player.step(step, 1 / 100);
    }

    const x = a.player.snapshot();
    const y = b.player.snapshot();
    // Positions: the f32 the snapshot carried, integrated for 2.4 s of play.
    expect(y.movement.feet.x).toBeCloseTo(x.movement.feet.x, 3);
    expect(y.movement.feet.y).toBeCloseTo(x.movement.feet.y, 3);
    expect(y.movement.feet.z).toBeCloseTo(x.movement.feet.z, 3);
    expect(y.movement.velocity.x).toBeCloseTo(x.movement.velocity.x, 3);
    expect(y.movement.grounded).toBe(x.movement.grounded);
    expect(y.movement.jumpFrom === null).toBe(x.movement.jumpFrom === null);
    // The weapon's state machine is discrete: it must agree exactly, or a field
    // it branches on is missing from the schema.
    expect(y.weapon!.state).toBe(x.weapon!.state);
    expect(y.weapon!.ammo).toBe(x.weapon!.ammo);
    expect(y.weapon!.pressed).toBe(x.weapon!.pressed);
    expect(y.weapon!.reloadQueued).toBe(x.weapon!.reloadQueued);
    expect(y.weapon!.burstLeft).toBe(x.weapon!.burstLeft);
    expect(y.weapon!.clip?.role).toBe(x.weapon!.clip?.role);
  });
});
