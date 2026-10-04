// The http side: geckos' signalling handshake, and /healthz.
//
// geckos attaches to this server, so the two have a single lifetime and this
// class owns it. Whatever terminates TLS in front of it has to pass
// `/.wrtc/v2/*` through untouched — a rule that denies dot-segments blocks every
// connection while /healthz beside it answers fine. See docs/server/README.md.

import http from "node:http";
import { inject, singleton } from "tsyringe";
import { config } from "./config.js";
import { Physics } from "./physics.js";
import { Games } from "./games.js";
import { Identity } from "./identity.js";
import { WorldRegistry } from "./worlds.js";

@singleton()
export class HttpServer {
  readonly server: http.Server;

  constructor(
    @inject(Identity) private readonly identity: Identity,
    @inject(Games) private readonly games: Games,
    @inject(WorldRegistry) private readonly worlds: WorldRegistry,
    @inject(Physics) private readonly physics: Physics,
  ) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(config.port, () => {
        console.log(`listening on :${config.port} (udp ${config.udpPortRange.min}-${config.udpPortRange.max}), ${config.tickRate} Hz`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url !== "/healthz") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    res.setHeader("Content-Type", "application/json");

    // Two measurements, both here for the same reason: a mechanism is made visible
    // before it is trusted. `players[].drift` is how far ahead of our correction
    // each client is predicting; `rewinds` is how often one asked to be judged
    // against a moment we could not honour as asked. Both being near zero is the
    // expected state, and either being otherwise says something specific.
    res.end(
      JSON.stringify({
        ok: true,
        id: this.identity.id,
        tickRate: config.tickRate,
        physics: this.physics.available,
        worlds: this.worlds.loaded,
        games: this.games.all().map((game) => ({
          id: game.id,
          map: game.map,
          tick: game.match.tick,
          ageSeconds: Math.round((Date.now() - game.createdAt) / 1000),
          players: game.match.report(),
          rewinds: game.match.rewindReport(),
          dynamics: game.match.physicsReport(),
        })),
      }),
    );
  }
}
