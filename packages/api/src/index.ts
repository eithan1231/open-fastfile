// The HTTP authority.
//
// One of these, however many game servers there are. It owns worlds/ on disk,
// serves the three world URLs and the built client, holds the registry of which
// game servers are live, and is the matchmaker: it decides that a game exists,
// who is in it and which instance hosts it.
//
//   pnpm --filter @3d/api dev
//
// The topology, the env vars and the deployment shape: docs/server/README.md.

import "reflect-metadata";

import { container } from "tsyringe";
import { ApiServer } from "./server.js";

const server = container.resolve(ApiServer);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal}: shutting down`);

    void server.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );

    // An event stream held open by a browser should not keep the process alive.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

await server.start();
