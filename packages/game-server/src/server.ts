// The process, as one object with a start and a stop.
//
// Everything below is a singleton the container built; this is only the order
// they come up in, and that order is the part with real constraints:
//
//   1. the api, because there is nothing to host without it, and then what a
//      game is made of — the weapons, the bodies posed to judge a shot, and the
//      physics engine a game builds its dynamics with;
//   2. the transport attached to the http server, because geckos has to attach
//      before listen();
//   3. the advertised candidate, because it is each *connection's* candidate
//      list this changes, so it must be in place before anyone connects;
//   4. listening, because the api hands this address to players — it has to be
//      reachable before it is advertised;
//   5. the loops: the tick, housekeeping, the navigation baker (which a world's
//      load queues its bake on) and the heartbeat, which is what advertises it;
//   6. the orders stream last, because an order arriving before any of the above
//      is an order this process cannot yet carry out.
//
// Stopping runs the same list backwards. Nothing here knows what a game is.

import { inject, singleton } from "tsyringe";
import type { GameOrder, ServerEvent } from "@3d/shared/protocol/events/server.js";
import { Api } from "./api.js";
import { Bodies } from "./bodies.js";
import { Weapons } from "./weapons.js";
import { config } from "./config.js";
import { Games } from "./games.js";
import { Heartbeat } from "./heartbeat.js";
import { Housekeeping } from "./housekeeping.js";
import { HttpServer } from "./http.js";
import { Identity } from "./identity.js";
import { NavBaker } from "./nav.js";
import { advertise } from "./net/advertise.js";
import { OrderStream } from "./net/events.js";
import { Physics } from "./physics.js";
import { NetServer } from "./net/server.js";
import { TickLoop } from "./tick.js";

@singleton()
export class GameServer {
  private running = false;

  constructor(
    @inject(Identity) private readonly identity: Identity,
    @inject(Api) private readonly api: Api,
    @inject(Weapons) private readonly weapons: Weapons,
    @inject(Bodies) private readonly bodies: Bodies,
    @inject(Physics) private readonly physics: Physics,
    @inject(HttpServer) private readonly http: HttpServer,
    @inject(NetServer) private readonly net: NetServer,
    @inject(Games) private readonly games: Games,
    @inject(TickLoop) private readonly tick: TickLoop,
    @inject(Housekeeping) private readonly housekeeping: Housekeeping,
    @inject(NavBaker) private readonly baker: NavBaker,
    @inject(Heartbeat) private readonly heartbeat: Heartbeat,
    @inject(OrderStream) private readonly orders: OrderStream,
  ) {}

  async start(): Promise<void> {
    console.log(`game server ${this.identity.id}: taking orders from ${config.apiUrl}`);

    // Nothing below holds the process open until `listen()` does, and every
    // delay in @3d/shared/lifecycle releases its timer on purpose — so a boot
    // that is merely *waiting* (for the api, for a world) would drain the event
    // loop and exit instead. This anchor is what makes boot a step the process
    // sits through; the http server holds it from `listen()` onwards.
    const anchor = setInterval(() => {}, 1 << 30);

    try {
      await this.api.awaitReady();

      // After the api answers and before anything can join: a join carries the
      // client's catalogue hash and is refused against this one. The bodies read
      // the catalogue the weapons just fetched, so they come second.
      await this.weapons.load();
      await this.bodies.load();

      // Before the orders stream, because a game builds whatever dynamics it needs
      // as it is created and an order can arrive the instant that stream opens.
      // After the bodies, because a corpse is one of them posed.
      await this.physics.load();

      this.net.attach(this.http.server);
      this.advertiseIfForwarded();

      await this.http.listen();

      await this.tick.start();
      await this.housekeeping.start();
      await this.baker.start();
      await this.heartbeat.start();

      this.orders.onOrder((event) => this.obey(event));
      await this.orders.start();

      this.running = true;
    } finally {
      clearInterval(anchor);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Orders first: nothing new should arrive while the rest is coming down.
    await this.orders.stop();
    await this.heartbeat.stop();
    await this.baker.stop();
    await this.housekeeping.stop();
    await this.tick.stop();
    this.net.close();
    await this.http.close();
  }

  /** What the api tells this instance to do. The only orders there are. */
  private async obey(event: ServerEvent): Promise<void> {
    switch (event.type) {
      case "hello":
        // Everything this instance should be running. An instance holds nothing
        // that survives it, so the authority's list wins — both ways: what is on
        // it is stood up (`create` is idempotent), and what is not is dropped.
        for (const id of this.games.retain(new Set(event.games.map((order) => order.gameId)))) {
          console.log(`  * game ${id} dropped: the api no longer lists it`);
        }
        for (const order of event.games) {
          await this.stand(order);
        }
        return;
      case "gameCreate":
        await this.stand(event.game);
        return;
      case "gameEnd":
        this.games.drop(event.gameId);
        return;
    }
  }

  /**
   * Stand a game up and tell the api it is ready.
   *
   * `gameReady` is what releases the players, so it must not be sent until the
   * map is loaded and the game can actually be joined — which is the whole
   * reason `Games.create` is awaited rather than fired off.
   */
  private async stand(order: GameOrder): Promise<void> {
    const game = await this.games.create(order);
    if (!game) {
      this.housekeeping.reportRefusals();
      return;
    }

    console.log(`  * game ${game.id} standing on "${game.map}" (${game.roster.size} on the roster, ${Math.round(game.durationMs / 1000)}s)`);

    try {
      await this.api.client.gameReady({ gameId: game.id });
    } catch (err: unknown) {
      console.warn(`  ! could not tell the api game ${game.id} is ready: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The forwarded address, when there is one to advertise.
   *
   * Declared in `PUBLIC_IP` and never inferred. A browser sends UDP only to
   * addresses that appear as ICE candidates, and behind a NAT every candidate
   * this process gathers for itself is private — so without this, the handshake
   * succeeds and the data channel dies as a silent ICE timeout. See
   * net/advertise.ts and docs/server/README.md.
   */
  private advertiseIfForwarded(): void {
    const io = this.net.server;
    const { min, max } = config.udpPortRange;
    if (!io || !config.publicIp) {
      return;
    }

    // A range cannot be advertised: geckos multiplexes every connection onto one
    // socket and libdatachannel picks that socket's port from the range at
    // random, so the port a player was told would match the forwarded one only
    // by luck.
    if (min !== max) {
      console.warn(`  ! not advertising ${config.publicIp}: UDP_PORT_MIN and UDP_PORT_MAX must name one port, and are ${min}-${max}.`);
      console.warn(`    Players outside this network will connect to nothing, silently. See docs/server/README.md.`);
      return;
    }

    advertise(io, config.publicIp, min);
    console.log(`advertising ${config.publicIp}:${min} beside the interfaces this box can see`);
  }
}
