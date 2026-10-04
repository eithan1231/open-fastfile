// The process, as one object with a start and a stop.
//
// Everything below is a singleton the container built; this is only the order
// they come up in. There is less to order here than in a game server — nothing
// in this process has to attach to a socket before it listens — but the shape is
// the same one, and so is the shutdown:
//
//   1. the app, because the routes have to exist before anything can reach them;
//   2. listening, because that is what makes this process the authority;
//   3. the matchmaking pass last, because a game it commits to is an order sent
//      to an instance, and an instance can only reach us once we are listening.
//
// Stopping runs the list backwards.

import { serve, type ServerType } from "@hono/node-server";
import { inject, singleton } from "tsyringe";
import { App } from "./app.js";
import { Config } from "./config.js";
import { MatchmakingLoop } from "./matchmaking/loop.js";

@singleton()
export class ApiServer {
  private server: ServerType | undefined;

  constructor(
    @inject(Config) private readonly config: Config,
    @inject(App) private readonly app: App,
    @inject(MatchmakingLoop) private readonly matchmaking: MatchmakingLoop,
  ) {}

  async start(): Promise<void> {
    this.announce();

    this.server = serve({ fetch: this.app.hono.fetch, port: this.config.port }, ({ port }) => {
      console.log(`listening on :${port}`);
    });

    await this.matchmaking.start();
  }

  async stop(): Promise<void> {
    await this.matchmaking.stop();

    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private announce(): void {
    const { worldsRoot, dbPath, clientDist, matchmaking } = this.config;
    console.log(`worlds: ${worldsRoot}`);
    console.log(`database: ${dbPath}`);
    console.log(`matchmaking: ${matchmaking.maps.join(", ")} — ${matchmaking.minPlayers}+ players, ${matchmaking.countdownSeconds}s countdown`);
    if (clientDist !== undefined) {
      console.log(`client: ${clientDist}`);
    }
  }
}
