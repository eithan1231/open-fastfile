// One game server: it hosts the games the authority gives it, on whatever maps
// those games are on.
//
// It decides nothing about who plays. The api says a game exists, on what map
// and with which players; this process loads that map, stands the game up,
// admits the people on the roster, and says when it is over. Several games run
// here at once, and a map is loaded when the first game needs it and unloaded
// when the last one ends (worlds.ts).
//
// What it does with the simulation, for now, is watch. Clients simulate
// themselves and are believed; this process re-simulates their inputs and
// reports how far the two have drifted apart. See match/match.ts.
//
// Nothing here reads the disk. The worlds and their collision
// meshes all arrive from @3d/api over HTTP, which is what lets these be deployed
// in bulk with nothing mounted.
//
//   pnpm --filter @3d/game-server dev

// tsyringe reads the constructor metadata the compiler emits, which needs the
// Reflect polyfill loaded before any decorated class is resolved. This is the
// process entry point, so it is imported first here and nowhere else.
//
// **Every injected dependency is named with `@inject(Thing)`**, even where the
// parameter type already says so. `tsx` runs this process and esbuild under it
// does not implement `emitDecoratorMetadata`, so an inferred parameter type
// never reaches the container: the tsconfig sets the flag, `pnpm typecheck`
// passes, every test passes, and the process dies on its first resolve with
// `TypeInfo not known for "GameServer"`. There is an assertion for it in
// tests/container.test.ts.
import "reflect-metadata";

import { container } from "tsyringe";
import { GameServer } from "./server.js";

const server = container.resolve(GameServer);

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

    // A held data channel should not keep the process alive indefinitely.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

await server.start();
