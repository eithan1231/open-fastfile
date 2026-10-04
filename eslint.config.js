// Flat ESLint config. Deliberately minimal: TypeScript already does the heavy
// lifting (strict, noUncheckedIndexedAccess, noUnusedLocals), so the job here is
// the rule the compiler can't express — the architectural boundaries, now both
// between packages and between the layers inside @3d/client.
//
// The global side of the same rules is the tsconfigs: @3d/shared is typechecked
// with neither the DOM lib nor ambient @types, so a bare `document.` or
// `process.` is a build failure there. What tsconfig *cannot* see is imports,
// which is what this file is for — notably that three.js is fine in
// @3d/shared/collision and banned everywhere else in that package.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Packages are crossed by name, never by climbing out with `../`. */
const noRelativeEscape = {
  regex: "(^|/)\\.\\./(\\.\\./)*(packages)/",
  message: "Cross a package boundary by name (@3d/shared, @3d/api, @3d/game-server), not with a relative path.",
};

const noThree = (where, instead) => ({ group: ["three", "three/*"], message: `${where} ${instead}` });

/**
 * Rapier lives in exactly one place. Everything dynamic and replicated is
 * simulated on both ends, and a second module that reaches for the engine
 * directly is a second set of integration parameters and a second construction
 * order — which is how two machines stop agreeing about where a grenade landed.
 */
const noRapier = (where) => ({
  group: ["@dimforge/*"],
  message: `${where} the physics engine is @3d/shared/physics's alone — reach it through that.`,
});

/**
 * The two servers are siblings, not layers: one is the authority and the other
 * is one of many instances of it, and they are deployed separately. Linking them
 * would make that a lie the day someone reaches past HTTP for a convenience.
 */
const noSibling = (pkg, from) => ({
  group: [pkg, `${pkg}/**`],
  message: `${from} reaches ${pkg} over HTTP, never by import — they are separate deployments.`,
});

/**
 * The script table, which is a *value* import and therefore a bundle.
 *
 * Named on its own because the two files this is kept out of are kept out of it
 * for different reasons — and one of them, `scripts/catalog.ts`, is allowed it:
 * a CLI that exits is not a deployment, and checking what the scripts name is
 * the whole of what it does with them.
 */
const noScripts = {
  // The api decides that a game exists, who is in it and where it runs. It never
  // runs one. `game/registry.ts` imports every script as a *value*, so reaching
  // for `gametype()` there would pull the whole script table into the authority's
  // bundle — which docs/engine/scripting.md says must not happen and nothing else
  // would catch. The data-only half is the way in.
  group: ["@3d/shared/game/registry", "@3d/shared/game/registry.js", "@3d/shared/game/scripts", "@3d/shared/game/scripts/**"],
  message: "@3d/api may not import a script. Gametype data lives in @3d/shared/game/gametypes/registry.js.",
};

/**
 * The bots' brains and motor: server-run, and nobody else's business.
 *
 * A brain decides what a bot does and only a game server has bots. The api
 * runs no game, and a browser sees a bot only as the player it moves — nothing a
 * brain remembers is replicated, so a client holding one could only guess. A
 * script names a brain by id for this reason, so the script table a browser
 * imports pulls none of it in.
 */
const noBrains = (who) => ({
  group: ["@3d/shared/game/bots", "@3d/shared/game/bots/**"],
  message: `${who} may not import a bot's brain or motor: they run on a game server only (docs/engine/scripting.md, "Bots").`,
});

/**
 * What a process that reads world *text* may not import: @3d/api, and the
 * repo-root tooling that reads worlds through it. Built per package so that each
 * message names the package it is reported in.
 */
const textOnlyImports = (who, does) => [
  { group: ["@3d/client", "@3d/client/**"], message: `${who} may not import the browser runtime.` },
  noSibling("@3d/game-server", who),
  noThree(`${who} ${does};`, "collision geometry belongs in @3d/game-server."),
  {
    group: ["@3d/shared/collision", "@3d/shared/collision/**", "@3d/shared/rig", "@3d/shared/rig/**", "@3d/shared/physics", "@3d/shared/physics/**"],
    message: `${who} has no capsules to resolve, no bodies to pose and nothing to simulate — all three belong in @3d/game-server.`,
  },
  noRapier(`${who} ${does};`),
  noBrains(who),
  noRelativeEscape,
];

/**
 * What @3d/api may not import, named once: the block below that adds the
 * filesystem rule *replaces* this one for the files it covers (flat config
 * overrides a rule rather than merging it), so it has to repeat these in full.
 */
const apiImports = [...textOnlyImports("@3d/api", "serves world text and files"), noScripts];

/**
 * The repo-root tooling (`pnpm check`, `pnpm catalog`), which reads worlds
 * through @3d/api and so shares its bans on geometry — but **not** its ban on
 * the script table.
 *
 * `pnpm catalog` resolves every cast a gametype can produce and every alias a
 * script can say, and refuses a build that names a file or a sound nothing
 * exported. It cannot do the second without the table, and the reason the api
 * may not hold one — a long-lived authority carrying every script it will never
 * run — is not true of a process that prints a report and exits.
 */
const toolImports = textOnlyImports("The repo-root tooling (scripts/*.ts)", "reads world text through @3d/api");

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "worlds/**", "**/*.world", ".venv/**", ".cache/**", ".work/**", ".claude/worktrees/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      curly: ["error", "all"],
    },
  },

  {
    // Unused *parameters* are load-bearing in a few callbacks (Vite's
    // `_event`), so match tsconfig's convention of an underscore prefix
    // rather than banning them outright.
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  {
    // Standalone Node tooling — `scripts/shots.mjs` and friends. These are run
    // with `node`, never bundled, so the Node globals are real here. The .ts
    // scripts get theirs from tsconfig instead.
    files: ["**/scripts/**/*.mjs", "*.config.js"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly" },
    },
  },

  {
    // @3d/shared, tier one: the language, the wire contracts, the simulation and
    // the service lifecycle both servers loop on. Isomorphic *and* three.js-free
    // — a server steps this code every tick and must not pay for a geometry
    // library to do it.
    files: [
      "packages/shared/src/dsl/**/*.ts",
      "packages/shared/src/protocol/**/*.ts",
      "packages/shared/src/worlds/**/*.ts",
      "packages/shared/src/sim/**/*.ts",
      "packages/shared/src/net/**/*.ts",
      "packages/shared/src/lifecycle/**/*.ts",
      "packages/shared/src/game/**/*.ts",
      "packages/shared/src/nav/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*"], message: "@3d/shared must stay isomorphic — Node-only code belongs in @3d/api or @3d/game-server." },
            noThree("this tier of @3d/shared is plain data;", "three.js belongs in @3d/shared/collision, @3d/shared/rig or @3d/client."),
            noRapier("this tier of @3d/shared is plain data;"),
            {
              group: ["@3d/client", "@3d/client/**", "@3d/api", "@3d/api/**", "@3d/game-server", "@3d/game-server/**"],
              message: "@3d/shared is the bottom layer and imports nothing above it.",
            },
            {
              group: ["../collision/*"],
              message: "The simulation talks to collision through the CapsuleWorld interface (sim/capsule.ts), not the implementation.",
            },
            noRelativeEscape,
          ],
        },
      ],
    },
  },

  {
    // @3d/shared/game, /sim and /nav: the subtrees both ends *run*.
    // Tier one's import rules already apply above; this adds the one rule the
    // tsconfig cannot give.
    //
    // A hook or a step both ends run must be a pure function of what it is
    // handed, for the reason `resolveWeapon` must be: a client predicting and a
    // server replaying have to get identical values out of identical inputs, and
    // a divergence here reads as a physics bug rather than as a seeding bug. It
    // is truer of sim/ than of game/ — sim/ *is* the code the client predicts
    // with and the server re-simulates, and a shot's spread cone is the case in
    // point. `Math.random` and `Date.now` are both in `lib: ["ES2022"]`, so
    // `types: []` does not catch them: a script takes its randomness from
    // `GameView.seed` through game/random.ts and its clock from `GameView.now`,
    // and the simulation takes its randomness from the shooter's own seed
    // through sim/recoil.ts and its clock from the `dt` it is stepped with. nav/
    // plans the paths a bot's inputs come from, and two runs of one match must
    // plan the same ones: a time budget is the game server's, handed in.
    files: ["packages/shared/src/game/**/*.ts", "packages/shared/src/sim/**/*.ts", "packages/shared/src/nav/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Both ends run this — seed game/random.ts with GameView.seed, or draw from a shot's own stream (sim/recoil.ts).",
        },
        { object: "Date", property: "now", message: "Both ends run this — use GameView.now (tick/tickRate) or the step's own dt, not a wall clock." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "Date", message: "Both ends run this — use GameView.now (tick/tickRate) or the step's own dt, not a wall clock." },
      ],
    },
  },

  {
    // @3d/shared, tier two: the subtrees that may use three.js. Still no Node,
    // still isomorphic — three is a geometry library in collision/ and a scene
    // graph plus an animation mixer in rig/, never a renderer. A server poses the
    // body it traces a bullet against, which is why rig/ is here and not in the
    // client.
    files: ["packages/shared/src/collision/**/*.ts", "packages/shared/src/rig/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*"], message: "@3d/shared/collision and /rig run in the browser too — file access belongs in @3d/api." },
            noRapier("collision/ and rig/ describe a world at rest;"),
            {
              group: ["@3d/client", "@3d/client/**", "@3d/api", "@3d/api/**", "@3d/game-server", "@3d/game-server/**"],
              message: "@3d/shared is the bottom layer and imports nothing above it.",
            },
            noRelativeEscape,
          ],
        },
      ],
    },
  },

  {
    // @3d/shared, tier three: the one subtree that may use Rapier.
    //
    // Everything dynamic and replicated is here, and it is here rather than in
    // either end for the reason sim/ is: a grenade the client predicts and the
    // server judges has to be one simulation, not two that agree by inspection.
    // Still isomorphic, still no Node, and three.js is allowed on rig/'s terms —
    // a ragdoll reads a skeleton's bind pose and writes bone transforms back.
    //
    // The `Math.random`/`Date.now` ban that covers sim/ and game/ applies here in
    // spirit and not in rule: a physics step's only clock is the fixed timestep it
    // is given, and its only randomness is a spawn's own quantised payload. Rapier
    // itself is the one thing here that may not be a pure function of its inputs,
    // which is exactly what tests/physicsDeterminism.test.ts pins down.
    files: ["packages/shared/src/physics/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*"], message: "@3d/shared/physics runs in the browser too — file access belongs in @3d/api." },
            {
              group: ["@3d/client", "@3d/client/**", "@3d/api", "@3d/api/**", "@3d/game-server", "@3d/game-server/**"],
              message: "@3d/shared is the bottom layer and imports nothing above it.",
            },
            noRelativeEscape,
          ],
        },
      ],
    },
  },

  {
    // @3d/api is the HTTP authority: a Node process that reads world *text* off
    // disk and streams files. It has no geometry to do, and three.js in the
    // process that serves every asset request is a cost with no payer — so the
    // ban covers @3d/shared/collision too, which is one import away from it.
    //
    files: ["packages/api/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: apiImports }],
    },
  },

  {
    // The repo-root tooling reads worlds through @3d/api, so it shares that
    // package's bans — bar the script table, which `pnpm catalog` exists to
    // check. See `toolImports`.
    files: ["scripts/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: toolImports }],
    },
  },

  {
    // The filesystem lives in src/worlds/, and a request handler may not reach
    // it. This is the other half of the WorldPath brand in src/worlds/paths.ts:
    // the brand stops a proved path being confused with any other string, and
    // this stops a handler skipping the proof by joining one itself. Between
    // them, a slug or a URL remainder becomes a filesystem path in exactly one
    // module — which is the only way a directory traversal can be ruled out
    // rather than repeatedly guarded against.
    //
    // The exceptions are the paths that come from the *environment* rather than
    // from a request: config.ts resolves WORLDS_ROOT/DB_PATH/CLIENT_DIST,
    // db/database.ts finds its migrations, and routes/client.ts checks the
    // built bundle is there before handing serveStatic a root of its own.
    files: ["packages/api/src/**/*.ts"],
    ignores: ["packages/api/src/worlds/**/*.ts", "packages/api/src/config.ts", "packages/api/src/db/*.ts", "packages/api/src/routes/client.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...apiImports,
            {
              group: ["node:fs", "node:fs/*", "node:path"],
              message: "Reach the filesystem through src/worlds/ — a slug or a URL remainder becomes a path only in src/worlds/paths.ts.",
            },
          ],
        },
      ],
    },
  },

  {
    // @3d/game-server is the other Node process: it simulates, so three.js is
    // fair game here. It reads nothing off disk — its world comes from the api
    // over HTTP — and it never links against the api to get it.
    files: ["packages/game-server/src/**/*.ts", "packages/game-server/scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@3d/client", "@3d/client/**"], message: "@3d/game-server may not import the browser runtime." },
            noRapier("@3d/game-server simulates through @3d/shared;"),
            noSibling("@3d/api", "@3d/game-server"),
            noRelativeEscape,
          ],
        },
      ],
    },
  },

  {
    // The client never links against either server, at build time or at run
    // time: it talks to them over the wire. There used to be an exception here
    // for the worlds Vite plugin; the plugin now only watches a directory, and
    // Vite proxies the routes instead of re-serving them.
    files: ["packages/client/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@3d/api", "@3d/api/**", "@3d/game-server", "@3d/game-server/**"],
              message: "The client reaches both servers over the wire (@3d/shared/protocol), never by import.",
            },
            noRapier("the client draws what it is told;"),
            noBrains("@3d/client"),
            noRelativeEscape,
          ],
        },
      ],
    },
  },

  {
    // Layering inside the client, unchanged: the engine, scene building, input
    // and the net client know nothing about the UI or the app that wires them
    // together. net/ is a transport over @3d/shared/net — app/ owns the policy
    // of when to connect, and the UI hears about none of it.
    files: ["packages/client/src/engine/**/*.ts", "packages/client/src/scene/**/*.ts", "packages/client/src/input/**/*.ts", "packages/client/src/net/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/ui/*", "**/app/*"], message: "engine/, scene/, input/ and net/ may not import the UI or the app layer." }] },
      ],
    },
  },

  {
    // The UI sees plain data and commands through app/uiBridge.ts, and nothing
    // else of the game: no three.js objects, no engine state, no gameplay input.
    files: ["packages/client/src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noThree("src/ui/ renders plain data;", "convert three.js values in src/app/ first."),
            { group: ["@3d/shared/**"], message: "src/ui/ talks to the game only through app/uiBridge.ts." },
            {
              group: ["**/engine/*", "**/scene/*", "**/dsl/*", "**/input/*", "**/app/*", "!**/app/uiBridge.js"],
              message: "src/ui/ talks to the game only through app/uiBridge.ts.",
            },
          ],
        },
      ],
    },
  },
);
