// That the container can actually build this process.
//
// This exists because of a failure mode that every other check in the repo
// misses. tsyringe resolves a constructor dependency either from an explicit
// `@inject(Thing)` or from the type metadata `emitDecoratorMetadata` emits — and
// `tsx`, which runs this process, uses esbuild, which does not implement that
// flag. So a service whose dependencies are only *typed* typechecks, passes
// every unit test that constructs it with `new`, and then dies on the first
// resolve with `TypeInfo not known for "GameServer"`.
//
// Resolving the real root here is what catches it: every singleton below the
// root is constructed, so a missing `@inject` anywhere in the graph fails here
// rather than at boot. Nothing is started — `GameServer.start()` is what opens
// sockets, and this only builds the object.
//
// Resolving is not enough on its own, though, and that is what the last test is
// for. With no `design:paramtypes` to fall back on, tsyringe builds a service's
// argument list out of the `@inject`s alone — so an undecorated parameter is a
// *hole* in that array, `Array.prototype.map` skips holes, and the service is
// constructed with `undefined` in its place rather than throwing. It then dies
// on first use, at boot, a long way from here.

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { Api } from "../src/api.js";
import { Bodies } from "../src/bodies.js";
import { Games } from "../src/games.js";
import { GameServer } from "../src/server.js";
import { Heartbeat } from "../src/heartbeat.js";
import { NavBaker } from "../src/nav.js";
import { WorldRegistry } from "../src/worlds.js";

describe("the container", () => {
  it("builds the whole process, every @inject resolved", () => {
    const root = container.createChildContainer();
    expect(() => root.resolve(GameServer)).not.toThrow();
  });

  it("hands the same singleton to everyone who asks", () => {
    const root = container.createChildContainer();
    // The point of the container here: the heartbeat reports what `Games` and
    // `WorldRegistry` actually hold, rather than being handed a callback that
    // describes them. A second instance of either would report nothing.
    root.resolve(GameServer);
    expect(root.resolve(Games)).toBe(root.resolve(Games));
    expect(root.resolve(WorldRegistry)).toBe(root.resolve(WorldRegistry));
    expect(root.resolve(Api)).toBe(root.resolve(Api));
    // `Games` hands its `Bodies` to every match it stands up, so a second one
    // would be 26 rigs nothing ever loaded.
    expect(root.resolve(Bodies)).toBe(root.resolve(Bodies));
    // Every world's bake is queued on the one baker the server starts and stops;
    // a second would be a queue nothing ever runs.
    expect(root.resolve(NavBaker)).toBe(root.resolve(NavBaker));
  });

  it("has an explicit @inject on every constructor parameter in the graph", () => {
    // The trap this file exists for, tested directly. Resolving does not catch a
    // missing `@inject`: with no `design:paramtypes` under esbuild, tsyringe
    // builds a sparse argument list, `map` skips the hole, and the service is
    // constructed with `undefined` in that slot rather than throwing.
    expect(undecorated(GameServer)).toEqual([]);
  });

  it("describes an instance that has loaded nothing as idle, not as unusable", () => {
    const root = container.createChildContainer();
    const info = root.resolve(Heartbeat).describe();

    // An empty `worlds` is what a fresh instance advertises, and the matchmaker
    // reads it as a hint rather than a filter — so this instance can still be
    // given any map. See api/src/matchmaking/matchmaker.ts.
    expect(info.worlds).toEqual([]);
    expect(info.players).toBe(0);
    expect(info.maxPlayers).toBeGreaterThan(0);
    expect(info.id).toMatch(/^gs-/);
  });
});
/** A class the container can be asked for. Its `length` is the parameters it must be given. */
type Injectable = abstract new (...args: never[]) => unknown;

/**
 * Every constructor parameter that tsyringe will have to supply, and the token
 * naming it — walked from `root` through the whole graph below it.
 *
 * `Ctor.length` stops at the first defaulted parameter, which is exactly right:
 * a parameter with a default is one the container is not being asked for.
 */
function undecorated(root: Injectable): string[] {
  const missing: string[] = [];
  const seen = new Set<Injectable>();
  const walk = (ctor: Injectable): void => {
    if (seen.has(ctor)) {
      return;
    }
    seen.add(ctor);
    const tokens = (Reflect.getOwnMetadata("injectionTokens", ctor) ?? {}) as Record<string, unknown>;
    for (let i = 0; i < ctor.length; i++) {
      const token = tokens[i];
      if (token === undefined) {
        missing.push(`${ctor.name}, parameter ${i}`);
      } else if (typeof token === "function") {
        walk(token as Injectable);
      }
    }
  };
  walk(root);
  return missing;
}
