// The bodies a shot is traced against, fetched the way this process really
// fetches them: over the catalogue route, out of the real api.
//
// A stub of the route would prove only that this file agrees with itself — and
// the thing worth proving is that 25 boxes derived by `scripts.cod hitboxes`
// still name bones the GLB on disk actually has. So the catalogue tests stand a
// real api up over the repo's own `worlds/`, exactly as apiIntegration.test.ts
// does, and skip where no catalogue has been built (it is gitignored).

import "reflect-metadata";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { testApp } from "@3d/api/testing/app.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { readHitboxes } from "@3d/shared/rig/hitboxes.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { Api } from "../src/api.js";
import { Bodies, type LoadedBody } from "../src/bodies.js";
import type { Weapons } from "../src/weapons.js";

/** `Bodies` asks the api for one file and the weapons for one view; these are those. */
function bodiesOver(client: Pick<ApiClient, "catalogFile">, catalogue: CatalogueView): Bodies {
  return new Bodies({ client } as unknown as Api, { catalogue } as unknown as Weapons);
}

const EMPTY: CatalogueView = catalogueViewOf({ version: 1 }, new WeaponRegistry([]));

interface Real {
  client: ApiClient;
  catalogue: CatalogueView;
  /** Every body the catalogue holds, over every game, which is what `load` should build. */
  characters: number;
}

/** The catalogue this checkout actually holds, or null where none has been built. */
async function realCatalogue(): Promise<Real | null> {
  const { app } = testApp();
  const client = createApiClient({ fetch: app.request.bind(app) as HttpFetch });
  const index = await client.catalogIndex();
  const catalogue = catalogueViewOf(index, new WeaponRegistry(index.weapons as WeaponEntry[]));
  const characters = (["iw4", "iw5", "iw6", "t5", "s1"] as const).reduce((n, game) => n + catalogue.charactersFor(game).length, 0);
  return characters === 0 ? null : { client, catalogue, characters };
}

/** One real load, shared: it is every body of every game, and nothing below mutates them. */
let once: Promise<(Real & { bodies: Bodies }) | null> | undefined;

function realBodies(): Promise<(Real & { bodies: Bodies }) | null> {
  once ??= realCatalogue().then(async (real) => {
    if (!real) {
      return null;
    }
    const bodies = bodiesOver(real.client, real.catalogue);
    await bodies.load();
    return { ...real, bodies };
  });
  return once;
}

/**
 * How wide this body is at head height, in metres, measured off its own boxes.
 *
 * Two traces along one line from opposite ends: each reports where it first
 * enters a box, so what is left between them is the body. A measurement rather
 * than an assertion about one bone, because a ghillie's hood is reached through
 * `back_mid` from one side and `j_head` from the other.
 */
function widthAtHead(body: LoadedBody): number {
  body.rig.root.updateMatrixWorld(true);
  const head = new THREE.Vector3();
  body.rig.root.getObjectByName("j_head")!.getWorldPosition(head);
  const from = { x: head.x - 3, y: head.y, z: head.z };
  const to = { x: head.x + 3, y: head.y, z: head.z };
  const near = body.boxes.trace(from, to);
  const far = body.boxes.trace(to, from);
  return near === null || far === null ? 0 : 6 - (near.fraction + far.fraction) * 6;
}

describe("an instance that has loaded no bodies", () => {
  it("answers, rather than throwing, before `load` has run", () => {
    const bodies = bodiesOver({ catalogFile: () => Promise.reject(new Error("no api yet")) }, EMPTY);

    expect(bodies.size).toBe(0);
    expect(bodies.get("iw5", "mp_body_delta_elite_assault_aa")).toBeUndefined();
  });

  it("answers the same way after a load that fetched nothing at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies = bodiesOver({ catalogFile: () => Promise.reject(new Error("502")) }, EMPTY);

    // Never fatal: an instance whose catalogue is empty still hosts a walkable
    // match, which is what a deployment with no catalogue has always had.
    await expect(bodies.load()).resolves.toBeUndefined();
    expect(bodies.size).toBe(0);
    expect(bodies.get("iw5", "anyone")).toBeUndefined();
    // Said out loud, because "nobody here can be shot" reads as a netcode fault.
    expect(warn.mock.calls.flat().join(" ")).toContain("no player bodies loaded");
    warn.mockRestore();
  });
});

describe("the bodies this catalogue holds", () => {
  it("are all built, with every one of their boxes bound to a bone", async () => {
    const real = await realBodies();
    if (!real) {
      return; // no catalogue built in this checkout
    }

    expect(real.bodies.size).toBe(real.characters);

    const entry = real.catalogue.charactersFor("iw5")[0]!;
    const body = real.bodies.get("iw5", entry.id)!;
    expect(body.id).toBe(entry.id);

    // Every box, not merely some: `BoundHitboxes` drops one naming a bone this
    // body has not got, so a count short of the sidecar's is a body a bullet
    // passes part of the way through.
    const bytes = await real.client.catalogFile({ kind: "characters", game: "iw5", id: entry.id, rest: `${entry.id}.hitboxes.json` });
    const sidecar = readHitboxes(JSON.parse(new TextDecoder().decode(bytes)));
    expect(sidecar.length).toBeGreaterThan(20);
    expect(body.boxes.size).toBe(sidecar.length);

    // The clips bound too: `animations.glb` holds the union of every skeleton, so
    // a rig that could bind none of them is one that would never move.
    expect(body.rig.clips.size).toBeGreaterThan(10);
  }, 60_000);

  it("stand on their feet, so a box is where the body is and not at the origin", async () => {
    const real = await realBodies();
    if (!real) {
      return;
    }
    const body = real.bodies.get("iw5", real.catalogue.charactersFor("iw5")[0]!.id)!;
    body.rig.root.updateMatrixWorld(true);

    // A skeleton whose bones are all at the origin passes every test that only
    // counts them, so this measures one: a head at about head height above a foot
    // at about ankle height, in metres, off a rig whose own units are inches.
    const head = new THREE.Vector3();
    const ankle = new THREE.Vector3();
    body.rig.root.getObjectByName("j_head")!.getWorldPosition(head);
    body.rig.root.getObjectByName("j_ankle_le")!.getWorldPosition(ankle);
    expect(head.y).toBeGreaterThan(1.4);
    expect(head.y).toBeLessThan(2);
    expect(ankle.y).toBeLessThan(0.3);

    // And the boxes are where those bones are: a line through the chest hits the
    // torso partway along, and the same line a head above the body hits nothing.
    const chest = body.boxes.trace({ x: -3, y: 1.3, z: 0 }, { x: 3, y: 1.3, z: 0 });
    expect(chest?.location).toMatch(/^torso/);
    expect(chest!.fraction).toBeGreaterThan(0.4);
    expect(chest!.fraction).toBeLessThan(0.6);
    expect(body.boxes.trace({ x: -3, y: head.y + 1, z: 0 }, { x: 3, y: head.y + 1, z: 0 })).toBeNull();
  });

  // The failure this guards against is a plausible one. Every body of a game
  // shares a clip set and a world weapon, so handing them all one body's
  // *sidecar* too would load, bind 25 boxes each, and look entirely correct —
  // while putting a ghillie's head where an ordinary one is, which is the 0.49 m
  // against 0.29 m CLAUDE.md names.
  it("each carry their own boxes, so a ghillie is not the shape of a rifleman", async () => {
    const real = await realBodies();
    const ghillie = real?.bodies.get("iw5", "mp_body_ally_ghillie_desert_sniper");
    const rifleman = real?.bodies.get("iw5", "mp_body_africa_militia_assault_a");
    if (!ghillie || !rifleman) {
      return;
    }

    expect(widthAtHead(ghillie)).toBeGreaterThan(0.45);
    expect(widthAtHead(rifleman)).toBeLessThan(0.32);
  });

  it("skip the one body whose hitboxes will not parse, and keep the rest", async () => {
    const real = await realCatalogue();
    if (!real) {
      return;
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = real.catalogue.charactersFor("iw5")[0]!.id;
    const bodies = bodiesOver(
      {
        catalogFile: (params) =>
          params.rest === `${broken}.hitboxes.json`
            ? Promise.resolve(new TextEncoder().encode('{"version":1,"bones":[{"bone":1}]}'))
            : real.client.catalogFile(params),
      },
      real.catalogue,
    );
    await bodies.load();

    // One body refused, and the other twenty-five hosted: `readHitboxes` throwing
    // is by design, and catching it per body is what keeps it from taking the
    // whole instance down.
    expect(bodies.get("iw5", broken)).toBeUndefined();
    expect(bodies.size).toBe(real.characters - 1);
    expect(warn.mock.calls.flat().join(" ")).toContain(broken);
    warn.mockRestore();
  }, 60_000);
});
