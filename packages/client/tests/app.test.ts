// The app layer's orderings and ownership, pinned: the frame's update list, the
// one writer of `ui.screen`, a dropped match connection, the catalogue arriving
// after a world, and the UI bundle staying free of three.js.

import * as fs from "node:fs";
import * as path from "node:path";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { FrameUpdates, UPDATES, type UpdateName } from "../src/app/frame.js";
import { FramePipeline } from "../src/engine/render/pipeline.js";
import { applyQuality, QUALITY } from "../src/engine/quality.js";

const SRC = path.join(__dirname, "../src");

/** Every .ts/.tsx under `dir`, as paths relative to `SRC`. */
function sources(dir: string): string[] {
  return fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(rel) : /\.tsx?$/.test(entry.name) ? [rel] : [];
  });
}

describe("the frame's update list", () => {
  const at = (name: UpdateName) => UPDATES.indexOf(name);

  it("runs effects after the camera has moved and zoomed for this frame", () => {
    expect(at("effects")).toBeGreaterThan(at("controls"));
    expect(at("effects")).toBeGreaterThan(at("viewmodel"));
  });

  it("moves the listener and the shadow fit after the controls, and reads posed bones last", () => {
    expect(at("listener")).toBeGreaterThan(at("controls"));
    expect(at("shadows")).toBeGreaterThan(at("controls"));
    expect(at("local sound")).toBeGreaterThan(at("controls"));
    expect(at("dev")).toBeGreaterThan(at("others"));
  });

  it("runs the steps in the list's order, whatever order they were filled in", () => {
    const updates = new FrameUpdates();
    const ran: UpdateName[] = [];
    for (const name of [...UPDATES].reverse()) {
      updates.use(name, () => void ran.push(name));
    }
    updates.run(1 / 60);
    expect(ran).toEqual([...UPDATES]);
  });
});

describe("the app's ownership", () => {
  it("writes ui.screen only from the screen router", () => {
    const writers = sources("app")
      .concat(sources("ui"))
      .filter((file) => /\bscreen\.value\s*=[^=]/.test(fs.readFileSync(path.join(SRC, file), "utf8")));
    expect(writers).toEqual(["app/screens.ts"]);
  });

  it("keeps three.js out of everything the UI bundle imports through the bridge", () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) {
        return;
      }
      seen.add(file);
      const text = fs.readFileSync(file, "utf8");
      expect(text, `${path.relative(SRC, file)} imports three`).not.toMatch(/from\s+["']three["']/);
      for (const [, spec] of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
        visit(path.resolve(path.dirname(file), spec!.replace(/\.js$/, ".ts")));
      }
    };
    visit(path.join(SRC, "app/uiBridge.ts"));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("quality", () => {
  it("reaches a pass's own scene, not only the world's", () => {
    const texture = new THREE.Texture();
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const passScene = new THREE.Scene().add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const pipeline = new FramePipeline();
    pipeline.use("viewmodel", { scene: passScene, render: () => {} });
    const renderer = {
      setPixelRatio: () => {},
      shadowMap: { type: THREE.PCFShadowMap },
      capabilities: { getMaxAnisotropy: () => 16 },
    } as unknown as THREE.WebGLRenderer;
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    applyQuality("high", renderer, [new THREE.Scene(), ...pipeline.scenes()], {});
    vi.unstubAllGlobals();
    expect(texture.anisotropy).toBe(QUALITY.high.anisotropy);
  });
});

describe("the catalogue", () => {
  it("is read from the live holder, so a world mounted before it arrives still sees it", async () => {
    vi.resetModules();
    const { WeaponRegistry } = await import("@3d/shared/sim/weaponRegistry.js");
    const registry = new WeaponRegistry([]);
    vi.doMock("../src/net/catalog.js", () => ({ loadCatalog: async () => ({ weapons: registry, catalogue: {} }) }));
    const { GameContent } = await import("../src/app/content.js");
    const content = new GameContent({} as never);
    const before = content.weapons;
    // What a session holds is the content itself, never `content.weapons` taken at mount.
    const held = { content };
    await content.load();
    expect(held.content.weapons).toBe(registry);
    expect(held.content.weapons).not.toBe(before);
    vi.doUnmock("../src/net/catalog.js");
  });
});

describe("a hot reload", () => {
  it("re-enters the mounted world once for a burst of its own changes, and not for another world's", async () => {
    vi.useFakeTimers();
    const { WorldLoader } = await import("../src/app/worldLoader.js");
    const { CurrentWorld } = await import("../src/app/currentWorld.js");
    const current = new CurrentWorld();
    const invalidated: string[] = [];
    const invalidate = (url: string): boolean => {
      invalidated.push(url);
      return true;
    };
    current.session = { slug: "dome", assets: { invalidate } } as never;
    const loader = new WorldLoader(current, () => current.session!, {} as never, {} as never, {} as never, {} as never, {} as never);
    const entered: [string, boolean][] = [];
    loader.enter = async (slug: string, reload = false) => void entered.push([slug, reload]);
    loader.sourceChanged("dome/world.world");
    loader.sourceChanged("dome/assets/world.glb");
    loader.sourceChanged("theater/world.world");
    vi.runAllTimers();
    expect(entered).toEqual([["dome", true]]);
    expect(invalidated).toHaveLength(2);

    // Left before the quiet period ran out: nothing comes back.
    loader.sourceChanged("dome/world.world");
    current.session = undefined;
    vi.runAllTimers();
    expect(entered).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("a match connection", () => {
  it("is let go of when it drops, so a hot reload rejoins and no input is sent into it", async () => {
    vi.resetModules();
    const made: { events: { onClosed: () => void }; sent: number; closed: boolean }[] = [];
    vi.doMock("../src/net/connection.js", () => ({
      Connection: class {
        sent = 0;
        closed = false;
        constructor(readonly events: { onClosed: () => void }) {
          made.push(this);
        }
        connect() {
          return true;
        }
        send() {
          this.sent++;
        }
        close() {
          this.closed = true;
        }
      },
    }));
    const { MatchController } = await import("../src/app/match.js");
    const clearable = () => ({ clear: () => {} });
    const firstPerson = { onTick: undefined as undefined | ((...args: unknown[]) => void), player: { setFallOut: () => {} } };
    const systems = {
      firstPerson,
      remotes: { ...clearable(), renderTick: () => undefined },
      actors: { ...clearable(), renderTick: () => undefined },
      actorVoices: clearable(),
      corpses: clearable(),
      footsteps: clearable(),
      weaponAudio: clearable(),
    };
    const parts = {
      content: { weapons: { hash: "h" } },
      current: { world: undefined },
      worlds: { enter: async () => {} },
      pause: { awaitSpawn: () => {}, spawned: () => {} },
      screens: { current: "world" },
      hud: clearable(),
      classes: clearable(),
    };
    const match = new MatchController(systems as never, parts as never);
    await match.enter({ gameId: "g", playerId: "p", authorizationKey: "k", serverUrl: "http://x" }, "map");
    expect(made).toHaveLength(1);

    made[0]!.events.onClosed();
    firstPerson.onTick?.({}, 1 / 60, {});
    expect(made[0]!.sent).toBe(0);

    match.afterReload();
    expect(made).toHaveLength(2);
    vi.doUnmock("../src/net/connection.js");
  });
});
