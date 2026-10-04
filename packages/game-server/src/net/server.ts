// The realtime transport: geckos.io, which is WebRTC data channels — UDP, with
// the option of unreliable delivery, which is what player input and snapshots
// want.
//
// One raw binary channel, not geckos' named events. A datagram says what it is
// itself — @3d/shared/net/packet.ts puts a MessageType byte at the front — so
// the transport underneath does not need channel names, and both ends share one
// encode/decode instead of a name-to-handler table each.
//
// No game logic here: this turns datagrams into Match calls and Match state into
// datagrams, and nothing else. The simulation is in match.ts, which is why it can
// be tested without opening a socket.
//
// -- Several games, one socket -----------------------------------------------
//
// A process hosts several games, so nothing may be sent to "everyone": a `leave`
// is addressed to the game it happened in, because a client drops any player id
// it sees in one, and a player in another game must never be named at it.
//
// A channel is not an identity any more either. The api issues a player's id and
// the key that proves it, so this file maps a socket onto a (game, player) pair
// rather than using the socket's own id — which is what lets a player reconnect
// and still be the same player to everyone else.
//
// -- On geckos and reliability ----------------------------------------------
//
// geckos' `reliable` option is resend-and-dedupe, not delivery you can count on,
// and it is not available on the raw path at all. So nothing here assumes a
// message arrives:
//
//   join    the client re-sends until it sees a `joined`. Admitting is
//           idempotent, so a duplicate costs a reply and nothing else.
//   chooseClass
//           re-sent until a `classChosen` answers. A player is admitted by
//           `join` and only spawned by this: until then they are seated, sent
//           snapshots, and not in the match — nobody sees them and nothing can
//           shoot them. Idempotent too: the same index is the same answer.
//   leave   a hint. Snapshot membership is authoritative — a client drops any
//           player missing from the latest snapshot — so a lost `leave` heals
//           itself on the next tick instead of leaving a ghost standing there.
//   refused a join that will not be answered says so, rather than leaving the
//           client to time out after ten seconds of silence it cannot tell from
//           a dead network.

import geckos, { type GeckosServer, type ServerChannel } from "@geckos.io/server";
import type { Server as HttpServer } from "node:http";
import { inject, singleton } from "tsyringe";
import { decodePacket, encodePacket, MessageType, PROTOCOL_VERSION } from "@3d/shared/net/packet.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import { inputsOf } from "@3d/shared/net/messages/input.js";
import type { ClassTiming } from "@3d/shared/game/classes.js";
import { config } from "../config.js";
import { Games, type GameInstance } from "../games.js";
import { Weapons } from "../weapons.js";
// SHOTTRACE (docs/engine/diagnostics-shottrace.md)
import type { ShotTraceMessage } from "@3d/shared/net/messages/shotTrace.js";
import { type FiredShot } from "../match.js";
import { BULLET_RANGE as SHOT_RANGE } from "@3d/shared/sim/weaponDef.js";

/** The `join` this server answers, as the packet decoder hands it over. */
type JoinMessage = Extract<ReturnType<typeof decodePacket>, { type: typeof MessageType.join }>["message"];

/** A socket, once it has said who it is. */
interface Seat {
  channel: ServerChannel;
  gameId: string;
  playerId: PlayerId;
  /** Which engine they predict in, from their join, for when they spawn. */
  engine: string;
}

/**
 * The transport, attached to an http server and taking orders from `Games`.
 *
 * Not a LoopBase: it has a lifecycle but no period — the ticking is
 * `TickLoop`'s, so that the thing which owes a clock and the thing which owns
 * the sockets are not the same object.
 */
@singleton()
export class NetServer {
  private io: GeckosServer | undefined;

  /** Ours rather than geckos' connectionsManager, keyed by socket id. */
  private readonly seats = new Map<string, Seat>();

  constructor(
    @inject(Games) private readonly games: Games,
    @inject(Weapons) private readonly weapons: Weapons,
  ) {}

  /** The geckos server, once started. `advertise` is the only other caller. */
  get server(): GeckosServer | undefined {
    return this.io;
  }

  /** geckos attaches to the http server, so this has to happen before listen(). */
  attach(http: HttpServer): void {
    const io = geckos({
      // The handshake is plain HTTP from the client's origin; the data channel
      // that follows is UDP on a port from this range. Both have to be reachable,
      // and a blocked range fails as a silent ICE timeout rather than an error.
      cors: { origin: config.clientOrigin, allowAuthorization: true },
      portRange: config.udpPortRange,
      // Reachable is not the same as advertised: with no stun, the candidates
      // this offers are the box's own interfaces, which behind a NAT no browser
      // can route to. geckos defaults this to none. See config.ts.
      iceServers: config.iceServers,
    });

    io.addServer(http);

    io.onConnection((channel: ServerChannel) => this.onConnection(channel));

    this.io = io;
  }

  close(): void {
    this.io?.server?.close();
    this.seats.clear();
    this.io = undefined;
  }

  /** Everyone in one game. The only kind of broadcast there is now. */
  private inGame(gameId: string): Seat[] {
    return [...this.seats.values()].filter((seat) => seat.gameId === gameId);
  }

  private part(seat: Seat, why: string): void {
    const game = this.games.get(seat.gameId);
    if (!game?.match.has(seat.playerId)) {
      return;
    }
    console.log(`  - player ${seat.playerId} ${why} game ${seat.gameId} (${game.match.size - 1} left)`);
    game.match.leave(seat.playerId);
    for (const other of this.inGame(seat.gameId)) {
      send(other.channel, encodePacket(MessageType.leave, { id: seat.playerId }));
    }
  }

  private onConnection(channel: ServerChannel): void {
    const socket = String(channel.id);
    // A refused join is re-sent every 250 ms until the client gives up, so the
    // reason for refusing it is worth saying once rather than forty times.
    let refused = false;
    const refuse = (reason: string): void => {
      send(channel, encodePacket(MessageType.refused, { reason }));
      if (!refused) {
        refused = true;
        console.warn(`  ! a join on socket ${socket} was refused: ${reason}`);
      }
    };

    channel.onDisconnect(() => {
      const seat = this.seats.get(socket);
      this.seats.delete(socket);
      if (seat) {
        this.games.get(seat.gameId)?.choosing.delete(seat.playerId);
        this.part(seat, "left");
      }
    });

    channel.onRaw((data) => {
      // A datagram off the network is untrusted input. decodePacket throws on
      // anything malformed precisely so this can drop it, rather than decode
      // garbage into a player's position.
      let packet;
      try {
        packet = decodePacket(toBytes(data));
      } catch {
        return;
      }

      switch (packet.type) {
        case MessageType.join:
          this.join(channel, socket, packet.message, refuse);
          return;
        case MessageType.input: {
          const seat = this.seats.get(socket);
          if (seat) {
            const match = this.games.get(seat.gameId)?.match;
            for (const input of inputsOf(packet.message)) {
              match?.receive(seat.playerId, input);
            }
          }
          return;
        }
        case MessageType.chooseClass: {
          const seat = this.seats.get(socket);
          if (seat) {
            this.chooseClass(seat, packet.message.index);
          }
          return;
        }
        default:
          // joined, snapshot, leave, refused and classChosen are ours to send, not to receive.
          return;
      }
    });
  }

  private join(channel: ServerChannel, socket: string, message: JoinMessage, refuse: (why: string) => void): void {
    const { protocol, gameId, playerId, authorizationKey, catalogHash } = message;

    if (protocol !== PROTOCOL_VERSION) {
      refuse(`it speaks protocol ${protocol}, we speak ${PROTOCOL_VERSION}`);
      return;
    }

    // A snapshot names a weapon by its index in the catalogue, so two ends
    // holding different ones arm everybody wrongly and say nothing. Refused for
    // the same reason a protocol mismatch is, and separately from it because a
    // catalogue changes whenever a weapon is added and the protocol does not.
    if (catalogHash !== this.weapons.hash) {
      refuse(`its weapon catalogue is ${catalogHash}, ours is ${this.weapons.hash}`);
      return;
    }

    const game = this.games.get(gameId);

    if (!game) {
      refuse(`it asked for game "${gameId}", which we are not hosting`);
      return;
    }

    // Entity ids and the presence bits are positions in the world, so a client
    // holding different world text would read them as other things, silently.
    if (message.worldHash !== game.worldHash) {
      refuse(`its world "${game.map}" is ${message.worldHash}, ours is ${game.worldHash}: reload the page`);
      return;
    }

    // The key, not the socket, is what makes this player this player.
    if (!this.games.admits(gameId, playerId, authorizationKey)) {
      refuse(`player "${playerId}" is not on game "${gameId}"'s roster, or presented the wrong key`);
      return;
    }

    if (!game.match.has(playerId) && game.match.full) {
      refuse(`game "${gameId}" is full (${game.match.humans})`);
      return;
    }

    // A second socket for a player already seated displaces the first, rather
    // than quietly feeding one player's input queue from two. Channel ids used
    // to make this impossible; api-issued ones do not.
    for (const [otherSocket, seat] of this.seats) {
      if (otherSocket !== socket && seat.gameId === gameId && seat.playerId === playerId) {
        console.log(`  ~ player ${playerId} reconnected; dropping their old connection`);
        this.seats.delete(otherSocket);
        seat.channel.close();
      }
    }

    // Seated, not spawned: they choose a class first (`chooseClass`). A player
    // already in the match — a reconnect — stays exactly as they were. In a
    // gametype with no classes to choose there is nothing to wait for, and they
    // spawn now, armed by the gametype.
    const classes = game.match.classRules.customClasses;
    const fresh = !game.match.has(playerId) && !game.choosing.has(playerId);
    // A new socket counts its inputs from the start again; a repeated join on
    // the same one must not forget what it has already sent.
    if (this.seats.get(socket)?.playerId !== playerId) {
      game.match.resetInputs(playerId);
    }
    this.seats.set(socket, { channel, gameId, playerId, engine: message.engine });
    if (!classes && !game.match.has(playerId)) {
      game.choosing.delete(playerId);
      game.match.join(playerId, undefined, message.engine);
      console.log(`  + player ${playerId} spawned in game ${gameId}, which has no classes to choose (${game.match.size} in it)`);
    } else if (fresh) {
      game.choosing.add(playerId);
      console.log(`  + player ${playerId} admitted to game ${gameId}, choosing a class`);
    }
    const spawned = game.match.has(playerId);
    game.joined = true;

    // Answered every time, not only the first: the client repeats its join until
    // this arrives, and a lost reply is why it would still be asking.
    send(
      channel,
      encodePacket(MessageType.joined, {
        you: playerId,
        world: game.map,
        tickRate: game.match.tickRate,
        gametype: game.match.gametype.id,
        rules: game.match.rules,
        // Where their de-dupe starts. Read at the moment of the join rather than
        // kept anywhere: everything they will be told about is issued after this.
        eventId: game.match.eventCursor,
        spawned,
        classes,
      }),
    );
  }

  /**
   * A class, by its index among the ones the api stored for this player. Spawns
   * someone still choosing; for someone playing, the gametype decides when it
   * takes effect (`Match.chooseLoadout`).
   *
   * The index is the whole of what a client gets to say, which is the point:
   * the class it names is the api's copy from the game order, and what it may
   * carry is `Player.equipLoadout`'s rule — never the client's.
   */
  private chooseClass(seat: Seat, index: number): void {
    const game = this.games.get(seat.gameId);
    const loadout = game?.roster.get(seat.playerId)?.loadouts[index];
    if (!game || !loadout) {
      return;
    }
    let timing: ClassTiming;
    if (game.choosing.has(seat.playerId)) {
      if (!game.match.has(seat.playerId) && game.match.full) {
        return; // no room to spawn into; they are still choosing, and may ask again
      }
      game.choosing.delete(seat.playerId);
      timing = game.match.join(seat.playerId, loadout, seat.engine, index);
      const as = timing === "refuse" ? "without a class (refused)" : `as "${loadout.name}"`;
      console.log(`  + player ${seat.playerId} spawned in game ${game.id} ${as} (${game.match.size} in it)`);
    } else {
      // Already playing — or a re-sent choice that already spawned them, which is
      // the class in hand and changes nothing (`chooseLoadout` says so).
      timing = game.match.chooseLoadout(seat.playerId, loadout, index);
    }
    send(seat.channel, encodePacket(MessageType.classChosen, { index, timing }));
  }

  /**
   * Advance every game one tick and send each player in each the verdict.
   *
   * Each game in its own try: a script that throws, or `Match.hurt`'s loop guard,
   * would otherwise throw every tick and starve every game after it in the loop.
   * The one that threw ends (`Match.fail`), and Housekeeping drops and reports it.
   */
  tick(): void {
    for (const game of this.games.all()) {
      if (game.match.failed !== undefined) {
        continue;
      }
      try {
        this.tickGame(game);
      } catch (err) {
        game.match.fail(err);
        console.error(`  ! game ${game.id} threw on its tick, so it is ended:`, err);
      }
    }
  }

  private tickGame(game: GameInstance): void {
    // Still step an empty game: the tick counter is the clock, and a player
    // joining mid-game should not see it restart.
    const { players, actors } = game.match.step();
    if (players.length === 0 && actors.length === 0) {
      return;
    }

    // Everyone seated, spawned or not: a player choosing a class watches the
    // match behind the menu, with no state of their own in it yet.
    for (const seat of this.inGame(game.id)) {
      send(seat.channel, encodePacket(MessageType.snapshot, game.match.snapshotFor(seat.playerId, players)));
    }

    // SHOTTRACE: off unless SHOT_TRACE is set, and then only to whoever fired.
    if (config.shotTrace) {
      this.sendShotTraces(game);
    }
  }

  /**
   * SHOTTRACE: this tick's rounds, each to the player who fired it.
   *
   * Addressed rather than broadcast, for the reason a hit marker is: this is one
   * client's own answer about its own shot, and telling the room where everybody
   * else's bullets went is a wallhack with a debug flag in front of it.
   */
  private sendShotTraces(game: GameInstance): void {
    const shots = game.match.shotsThisTick;
    if (shots.length === 0) {
      return;
    }
    const channels = new Map(this.inGame(game.id).map((seat) => [seat.playerId, seat.channel]));
    for (const shot of shots) {
      const channel = channels.get(shot.shooter);
      if (channel) {
        send(channel, encodePacket(MessageType.shotTrace, shotTracePacket(shot)));
      }
    }
  }
}

/**
 * SHOTTRACE: one `FiredShot` as the wire carries it.
 *
 * A free function, and exported, so a test can assert the mapping without a
 * socket — `Match` is drivable on its own and this is the only part of the
 * diagnostic that is not.
 *
 * A round that met nothing reports the weapon's whole range, because the client
 * draws a line and needs a far end; `met: "none"` is what says the far end is
 * open air rather than a surface.
 */
export function shotTracePacket(shot: FiredShot): ShotTraceMessage {
  const result = shot.result;
  return {
    ordinal: shot.ordinal,
    from: shot.from,
    direction: shot.direction,
    distance: result === null ? SHOT_RANGE : result.distance,
    met: result === null ? "none" : result.kind,
    target: result !== null && result.kind === "player" ? result.id : null,
  };
}

function send(channel: ServerChannel, bytes: Uint8Array): void {
  channel.raw.emit(view(bytes));
}

/**
 * geckos wants an ArrayBuffer, and a Uint8Array off the BitWriter may be a view
 * into a larger one. `finish()` slices, but a caller-supplied buffer need not.
 */
function view(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  throw new TypeError("raw message was not binary");
}
