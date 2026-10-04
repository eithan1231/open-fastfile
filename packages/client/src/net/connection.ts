// The client's end of a match: open a data channel to the game server we were
// sent to, send a tick's input, and hand back what the server says about
// everyone.
//
// It finds nothing for itself any more. The api runs matchmaking, so a player
// arrives here with a game id, the id the api issued them and the key that
// proves it — all out of one `matchReady` event. That is why there is no server
// list here and no picking by world: being in a game is a decision the authority
// made, not one a browser makes.
//
// One raw binary channel, matching the server (@3d/shared/net/packet.ts): the
// leading byte says which message it is, so there is no name-to-handler table
// on either end and no way for the two to disagree about one.
//
// Multiplayer is additive. Every failure here — an unreachable server, a refused
// handshake, a dead channel — leaves the game exactly as it plays offline,
// because the client simulates itself either way. Nothing in this file may
// surface an error screen.

import geckos, { type ClientChannel } from "@geckos.io/client";
import { decodePacket, encodePacket, MessageType, PROTOCOL_VERSION } from "@3d/shared/net/packet.js";
import { REDUNDANT_INPUTS, roundRenderFrac, type InputStep } from "@3d/shared/net/messages/input.js";
import { after } from "@3d/shared/net/seq.js";
import type { PlayerInput } from "@3d/shared/sim/input.js";
import type { MovementState } from "@3d/shared/sim/movement.js";
import type { PlayerState } from "@3d/shared/sim/player.js";
import type { GameEvent } from "@3d/shared/net/messages/events.js";
// SHOTTRACE (docs/engine/diagnostics-shottrace.md)
import type { ShotTraceMessage } from "@3d/shared/net/messages/shotTrace.js";
import type { JoinedMessage } from "@3d/shared/net/messages/session.js";
import type { ClassTiming } from "@3d/shared/game/classes.js";
import { engineName } from "./engineName.js";
import type { PlayerSnapshot, SnapshotMessage, SnapshotPresence } from "@3d/shared/net/messages/snapshot.js";
import type { ActorState } from "@3d/shared/game/actors/actor.js";

/** Milliseconds between join attempts. geckos gives no delivery guarantee, so we ask until answered. */
const JOIN_RETRY_MS = 250;
/** After this long with no `joined`, stop asking. The player is simply offline, which is a fine way to be. */
const JOIN_TIMEOUT_MS = 10_000;

/** Two seconds of inputs at 60 Hz. Past this a correction is worth less than the replay costs. */
const MAX_SENT = 120;

export interface ConnectionEvents {
  /**
   * We are in: the tick rate to step at, the gametype to resolve a side and a
   * peer's body against, and the rules a HUD has to have to mean anything.
   *
   * The whole message rather than the three fields it happens to need today: a
   * field added to `joined` is then a field this end already has, instead of a
   * signature every layer between here and the UI has to widen.
   */
  onJoined: (joined: JoinedMessage) => void;
  /**
   * One authoritative tick.
   *
   * `tick` is the server's own count, passed on rather than dropped because a peer
   * is drawn *between* two ticks: a shot has to name the moment it was aimed at in
   * the server's clock, and a local arrival time means nothing to anyone else.
   *
   * `self` is the receiving player's own authoritative state, and it is the
   * correction. It used to be filtered out here — "the local player is simulated
   * here and never adopted from the wire" — which was true while the server
   * believed whatever a client claimed. It is the server's answer now, so it comes
   * through, with `pending`: every input sent since the server's `ack`, to be
   * replayed on top of it.
   */
  onSnapshot: (snapshot: Correction) => void;
  /**
   * SHOTTRACE: the server's account of one round this player fired. Optional and
   * off by default at the other end too — a server started without `SHOT_TRACE`
   * sends none of these, and then this is never called.
   */
  onShotTrace?: (trace: ShotTraceMessage) => void;
  /**
   * The server's answer about the class this player asked for: in their hands
   * now, waiting for their next spawn, or refused (`ClassTiming`).
   */
  onClassChosen?: (index: number, timing: ClassTiming) => void;
  /**
   * The match could not be joined — an unreachable server, a refused join, one
   * that never answered — and nothing more will be tried. The world plays on
   * offline, so whoever was waiting to be spawned should stop waiting.
   */
  onOffline?: () => void;
  onClosed: () => void;
}

/**
 * One input as it went out, kept so it can be replayed on top of a correction —
 * and re-sent in the next datagrams' `earlier`, with the moment it was aimed at.
 */
export interface SentInput extends InputStep {
  seq: number;
}

/** One authoritative tick, as the client is given it. */
export interface Correction {
  tick: number;
  /** The last input of ours this server had applied. Everything after it is still ours to replay. */
  ack: number;
  /** Our own state, authoritative. Undefined before `joined`, or if the server has forgotten us. */
  self: PlayerState | undefined;
  /** Everyone else, to be drawn. */
  others: PlayerSnapshot[];
  /** The actors this server tells us about, to be drawn. */
  actors: ActorState[];
  /** The inputs sent after `ack`, oldest first: what prediction has to redo. */
  pending: readonly SentInput[];
  /** Which of the world's solids are present, or null for a world with none. */
  presence: SnapshotPresence | null;
  /** The gametype's counters, in its declaration's order. */
  counters: number[];
  /**
   * What happened since the last snapshot, and only what *this* client has not
   * been told yet: a death rides in the tail of every snapshot for half a second,
   * so the same event arrives about thirty times and is passed on once.
   */
  events: readonly GameEvent[];
}

/** Where the match is and who we are in it, exactly as the `matchReady` event gave it. */
export interface MatchTicket {
  gameId: string;
  playerId: string;
  authorizationKey: string;
  /** A whole URL: a fleet behind one proxy is reached by path, one with a certificate each by name. */
  serverUrl: string;
}

export class Connection {
  private channel: ClientChannel | undefined;
  private id: string | undefined;
  private joinTimer: ReturnType<typeof setInterval> | undefined;
  private joinDeadline = 0;
  /** Wraps at 16 bits, which is what the wire carries. */
  private seq = 0;
  /**
   * What has been sent and not yet acknowledged, oldest first.
   *
   * Bounded rather than unbounded: at 60 Hz this is two seconds of inputs, and a
   * server that has not acknowledged something for two seconds is not going to.
   * Replaying more than that would cost more than the correction is worth.
   */
  private readonly sent: SentInput[] = [];
  /**
   * The newest event id seen, which starts as the counter `joined` named. Nothing
   * at or below it is passed on again.
   */
  private lastEvent: number | undefined;
  private closed = false;
  /** The class asked for and not yet answered, and the timer asking again. */
  private choosing: { index: number; timer: ReturnType<typeof setInterval> } | undefined;

  /**
   * `catalogHash` is the digest of the weapon catalogue this client loaded. A
   * game server refuses a join whose hash disagrees with its own, because a
   * snapshot names a weapon by its index in that catalogue — two ends holding
   * different ones would put the wrong gun in everybody's hands, silently.
   */
  constructor(
    private readonly events: ConnectionEvents,
    private readonly catalogHash: string,
    /** `worldHash` of the world this client mounted: a server holding other text refuses the join. */
    private readonly worldHash = "",
  ) {}

  get connected(): boolean {
    return this.id !== undefined;
  }

  /**
   * Join the match this ticket names. Resolves either way: a false return is
   * "we could not get there", which leaves the world playable and is not an
   * error screen.
   */
  connect(ticket: MatchTicket): boolean {
    if (this.closed) {
      return false;
    }

    // geckos takes an origin and a port separately, with no path component —
    // which is exactly why a reverse proxy that maps instances by path is not
    // one of the options open to us. See docs/server/README.md.
    let url: URL;
    try {
      url = new URL(ticket.serverUrl);
    } catch {
      console.warn(`the match named an unusable server url: ${ticket.serverUrl}`);
      return false;
    }
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);

    const channel = geckos({ url: `${url.protocol}//${url.hostname}`, port });
    this.channel = channel;

    channel.onConnect((error) => {
      if (error || this.closed) {
        console.warn("game server connection failed; playing offline", error?.message ?? "");
        this.stopJoining();
        this.events.onOffline?.();
        return;
      }
      channel.onRaw((data) => this.receive(data));
      channel.onDisconnect(() => this.handleClosed());
      this.startJoining(ticket);
    });

    return true;
  }

  /**
   * One tick's command, the state it produced, and the moment it was aimed at.
   *
   * `drawnAt` is where this client had other players when it built this input —
   * `RemotePlayers.renderTick()`. Without it the server has no way to judge a shot
   * except against the present, which at any ping is not where the shooter was
   * looking. Undefined when nobody has been drawn yet (no peers, or no snapshot),
   * and then there is nothing to compensate for anyway.
   */
  send(input: PlayerInput, dt: number, claim: MovementState, drawnAt?: { tick: number; frac: number }): void {
    if (!this.channel || this.id === undefined) {
      return;
    }
    this.seq = (this.seq + 1) & 0xffff;
    // The symmetry rule: the fraction the server will decode, not the one this
    // frame measured, so both ends place the target identically.
    const renderTick = (drawnAt?.tick ?? 0) & 0xffff;
    const renderFrac = roundRenderFrac(drawnAt?.frac ?? 0);
    // Before this one is pushed, and from the ring itself: everything in it is
    // unacknowledged as of the last snapshot, and its seqs are consecutive, which
    // is what lets the packet leave them out.
    const earlier = this.sent.slice(-REDUNDANT_INPUTS).map(({ dt, input, renderTick, renderFrac }) => ({ dt, input, renderTick, renderFrac }));
    // Copied, not referenced: `FirstPersonControls` refills one `PlayerInput` in
    // place every tick, so keeping the reference would keep the newest input
    // MAX_SENT times over and replay the same command for every unacked step.
    this.sent.push({ seq: this.seq, input: { ...input }, dt, renderTick, renderFrac });
    if (this.sent.length > MAX_SENT) {
      this.sent.shift();
    }
    this.emit(encodePacket(MessageType.input, { seq: this.seq, dt, input, claim, renderTick, renderFrac, earlier }));
  }

  /**
   * Ask to play a class, by its index among this player's. Re-sent until the
   * server answers, because nothing on this channel is delivered for certain; a
   * later choice replaces an unanswered one.
   */
  chooseClass(index: number): void {
    if (this.id === undefined) {
      return;
    }
    this.stopChoosing();
    const ask = (): void => this.emit(encodePacket(MessageType.chooseClass, { index }));
    ask();
    this.choosing = { index, timer: setInterval(ask, JOIN_RETRY_MS) };
  }

  private stopChoosing(): void {
    if (this.choosing) {
      clearInterval(this.choosing.timer);
      this.choosing = undefined;
    }
  }

  close(): void {
    this.closed = true;
    this.stopJoining();
    this.stopChoosing();
    this.id = undefined;
    this.sent.length = 0;
    // geckos' close assumes a peer connection that came up, and throws on one
    // that never did — a refused handshake, an unreachable server. Thrown from
    // here it would abort whatever was tearing the match down, and leave the
    // player standing in the world of a round that is already over.
    try {
      this.channel?.close();
    } catch (err: unknown) {
      console.warn("[net] closing a channel that never connected:", err instanceof Error ? err.message : String(err));
    }
    this.channel = undefined;
  }

  /**
   * Ask to join, and keep asking. geckos' `reliable` is resend-and-dedupe rather
   * than delivery, and is not on the raw path at all, so the retry lives here.
   * `Match.join` is idempotent, so asking twice costs a reply.
   */
  private startJoining(ticket: MatchTicket): void {
    this.stopJoining();
    this.joinDeadline = Date.now() + JOIN_TIMEOUT_MS;
    const ask = (): void => {
      if (this.id !== undefined) {
        this.stopJoining();
        return;
      }
      if (Date.now() > this.joinDeadline) {
        console.warn("game server never answered the join; playing offline");
        this.stopJoining();
        this.events.onOffline?.();
        return;
      }
      this.emit(
        encodePacket(MessageType.join, {
          protocol: PROTOCOL_VERSION,
          gameId: ticket.gameId,
          playerId: ticket.playerId,
          authorizationKey: ticket.authorizationKey,
          catalogHash: this.catalogHash,
          worldHash: this.worldHash,
          engine: engineName(),
        }),
      );
    };
    ask();
    this.joinTimer = setInterval(ask, JOIN_RETRY_MS);
  }

  private stopJoining(): void {
    if (this.joinTimer !== undefined) {
      clearInterval(this.joinTimer);
      this.joinTimer = undefined;
    }
  }

  private receive(data: unknown): void {
    let packet;
    try {
      packet = decodePacket(toBytes(data));
    } catch {
      return; // untrusted bytes; dropping one datagram costs a tick at most
    }

    switch (packet.type) {
      case MessageType.joined:
        if (this.id === undefined) {
          this.id = packet.message.you;
          this.lastEvent = packet.message.eventId;
          this.stopJoining();
          this.events.onJoined(packet.message);
        }
        return;
      case MessageType.snapshot:
        this.events.onSnapshot(this.correction(packet.message));
        return;
      case MessageType.leave:
        // A hint only. Snapshot membership is what actually removes a player, so
        // a lost leave heals on the next tick instead of leaving a body behind.
        return;
      case MessageType.shotTrace:
        // SHOTTRACE
        this.events.onShotTrace?.(packet.message);
        return;
      case MessageType.classChosen:
        // Only the answer to the newest question: an older one arriving late
        // must not stop the retry of a choice the server has not seen yet.
        if (this.choosing?.index === packet.message.index) {
          this.stopChoosing();
          this.events.onClassChosen?.(packet.message.index, packet.message.timing);
        }
        return;
      case MessageType.refused:
        // Said out loud rather than left as ten seconds of silence the player
        // cannot tell from a dead network. Still not an error screen: the world
        // is up and plays exactly as it does offline.
        console.warn(`the game server refused the join: ${packet.message.reason}`);
        this.stopJoining();
        this.events.onOffline?.();
        return;
      default:
        return;
    }
  }

  /**
   * One snapshot, split into the three things it is: our own state, everyone
   * else's, and the inputs we have sent since the server's `ack`.
   *
   * Acknowledged inputs are dropped here rather than in the caller, because the
   * ring is this object's and a caller that forgot would leak a match's worth of
   * commands.
   */
  private correction(message: SnapshotMessage): Correction {
    const { ack } = message;
    while (this.sent.length > 0 && !after(this.sent[0]!.seq, ack)) {
      this.sent.shift();
    }
    const self = this.id === undefined ? undefined : message.players.find((p) => p.id === this.id)?.state;
    const others = this.id === undefined ? message.players : message.players.filter((p) => p.id !== this.id);
    const fresh = unseenEvents(message.events, this.lastEvent);
    this.lastEvent = fresh.seen;
    return {
      tick: message.tick,
      ack,
      self,
      others,
      actors: message.actors,
      pending: this.sent,
      events: fresh.events,
      presence: message.presence,
      counters: message.counters,
    };
  }

  private handleClosed(): void {
    this.stopJoining();
    this.stopChoosing();
    this.id = undefined;
    this.events.onClosed();
  }

  private emit(bytes: Uint8Array): void {
    this.channel?.raw.emit(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
}

/**
 * The events of one tail this client has not seen, and the watermark to keep.
 *
 * The de-dupe is the whole of what makes a repeated tail safe, so it is here
 * rather than in the app, beside the other thing this file drops as already
 * accounted for (an acked input). `seen` is undefined before `joined`, and then
 * there is no watermark to compare against and nothing to report: an event from
 * before we were in the game is not news.
 *
 * Exported for its test — and it is `after` (@3d/shared/net/seq.ts) that makes it
 * sound over a counter that wraps, which is the case nobody reproduces by hand.
 */
export function unseenEvents(tail: readonly GameEvent[], seen: number | undefined): { events: GameEvent[]; seen: number | undefined } {
  if (seen === undefined) {
    return { events: [], seen };
  }
  const events: GameEvent[] = [];
  let newest = seen;
  for (const event of tail) {
    if (after(event.id, newest)) {
      events.push(event);
      newest = event.id;
    }
  }
  return { events, seen: newest };
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
