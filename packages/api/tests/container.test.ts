// That the container can actually build this process.
//
// This exists because of a failure mode that every other check in the repo
// misses. tsyringe resolves a constructor dependency either from an explicit
// `@inject(Thing)` or from the type metadata `emitDecoratorMetadata` emits — and
// `tsx`, which runs this process, uses esbuild, which does not implement that
// flag. So a service whose dependencies are only *typed* typechecks, passes
// every unit test that constructs it with `new`, and then dies on the first
// resolve with `TypeInfo not known for "ApiServer"`.
//
// Resolving the real root catches a class with no decorator at all. It does not
// catch a *parameter* whose `@inject` is missing — see the second test. Between
// them, every singleton below the root is constructed, so a missing `@inject`
// anywhere in the graph fails here rather than at boot: every singleton below it is
// constructed, so a missing `@inject` anywhere in the graph fails here rather
// than at boot. Nothing is started — `ApiServer.start()` is what binds a port,
// and this only builds the object.

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { Sessions } from "../src/auth/sessions.js";
import { Config } from "../src/config.js";
import { Sqlite } from "../src/db/database.js";
import { Matchmaker } from "../src/matchmaking/matchmaker.js";
import { Registry } from "../src/registry.js";
import { ApiServer } from "../src/server.js";
import { testApp } from "../testing/app.js";

/** A Config the real one cannot be: this must not open the developer's own database. */
const memory = (): Config => ({ ...new Config(), dbPath: ":memory:" });

describe("the container", () => {
  it("builds the whole process, every @inject resolved", () => {
    container.clearInstances();
    const root = container.createChildContainer();
    root.registerInstance(Config, memory());
    expect(() => root.resolve(ApiServer)).not.toThrow();
  });

  it("has an explicit @inject on every constructor parameter in the graph", () => {
    // The trap this file exists for, tested directly. Resolving catches a class
    // with no decorator at all; it does not catch a *parameter* whose `@inject`
    // is missing, because tsyringe then builds a sparse argument list, `map`
    // skips the hole, and the service is constructed with `undefined` in it.
    expect(undecorated(ApiServer)).toEqual([]);
  });

  it("hands the same singleton to everyone who asks", () => {
    const { container: scope } = testApp();
    // The point of the container here: the matchmaker, the routes that command
    // it and the stream a player reads all have to be looking at one lobby list.
    // A second Matchmaker would publish into nothing.
    expect(scope.resolve(Matchmaker)).toBe(scope.resolve(Matchmaker));
    expect(scope.resolve(Registry)).toBe(scope.resolve(Registry));
    expect(scope.resolve(Sqlite)).toBe(scope.resolve(Sqlite));
    expect(scope.resolve(Sessions)).toBe(scope.resolve(Sessions));
  });

  it("gives each test app a process of its own", () => {
    // testApp() clears the root container's instances, so one test's in-memory
    // database and lobbies cannot leak into the next. See testing/app.ts.
    const first = testApp();
    const second = testApp();
    expect(second.matchmaking).not.toBe(first.matchmaking);
    expect(second.db).not.toBe(first.db);
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
