// The first-person viewmodel: assembling the rig from a weapon GLB (skeleton,
// gun, clips, definition) and a pair of view hands.
//
// Which weapon and which hands is no longer a world's answer — see the retirement
// case below — but the assembly is unchanged, and it is the part with the traps in
// it (joints grafted by name, a gun hung from `tag_weapon`).

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { parseWorldFile } from "@3d/shared/dsl/parser.js";
import { resolveWorld } from "@3d/shared/dsl/resolve.js";
import { buildViewmodelRig, readWeaponDef, WEAPON_FORMAT_VERSION } from "../src/scene/viewmodel.js";
import type { GltfAsset } from "../src/scene/assets.js";
import { codFovToVertical, copyLights } from "../src/engine/viewmodel.js";

function resolve(source: string) {
  const { ast } = parseWorldFile(source);
  return resolveWorld(ast.statements);
}

describe("the viewmodel node", () => {
  // It is retired. A world no longer says what a player holds — a gametype does,
  // out of the shared catalogue (docs/engine/scripting.md) — so the rig below is
  // built from a cast rather than from a world file.
  it("is retired, and the error says where the decision went", () => {
    const { world, diagnostics } = resolve(`viewmodel { weapon: "iw5/iw5_m4_mp", hands: "assets/viewmodel/delta.glb" }`);
    expect(diagnostics.map((d) => d.code)).toContain("node-retired");
    expect(diagnostics.find((d) => d.code === "node-retired")!.message).toContain("packages/shared/src/game/");
    expect(world).toBeUndefined();
  });
});

/** A skinned mesh whose every vertex hangs from `bone` (one triangle). */
function meshOn(bones: THREE.Bone[], bone: number, name: string): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([bone, 0, 0, 0, bone, 0, 0, 0, bone, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setIndex([0, 1, 2]);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = name;
  mesh.bind(new THREE.Skeleton(bones), new THREE.Matrix4());
  return mesh;
}

function chain(names: string[]): THREE.Bone[] {
  const bones = names.map((n) => Object.assign(new THREE.Bone(), { name: n }));
  for (let i = 1; i < bones.length; i++) {
    bones[i - 1]!.add(bones[i]!);
  }
  return bones;
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    version: WEAPON_FORMAT_VERSION,
    weapon: "gun_mp",
    roles: { idle: "gun_idle" },
    clips: { gun_idle: { duration: 1 / 30, looped: true, notes: [] } },
    times: {},
    clipSize: 30,
    fireType: "Full Auto",
    adsZoomFov: 50,
    motion: {},
    hideBones: ["tag_sight_off"],
    ...overrides,
  };
}

/** A weapon GLB as loaded: hands' joints with the gun grafted on, the gun's two surfaces, one idle clip. */
function weapon(def = definition()): GltfAsset {
  const [origin, view, weaponTag, gun, sight] = chain(["tag_origin", "tag_view", "tag_weapon", "j_gun", "tag_sight_off"]);
  view!.position.set(0, 1.5, 0);
  const scene = new THREE.Group();
  scene.add(origin!, meshOn([gun!, sight!], 0, "body"), meshOn([gun!, sight!], 1, "folded sight"));
  scene.userData.viewmodel = def;
  void weaponTag;
  // All its keys at t = 0: what the loader makes of a one-frame idle.
  const idle = new THREE.AnimationClip("gun_idle", -1, [new THREE.VectorKeyframeTrack("tag_weapon.position", [0], [0.4, 0, 0])]);
  return { scene, clips: [idle] };
}

function hands(): GltfAsset {
  const [origin, view] = chain(["tag_origin", "tag_view", "tag_weapon"]);
  const scene = new THREE.Group();
  scene.add(origin!, meshOn([view!], 0, "glove"));
  return { scene, clips: [] };
}

describe("buildViewmodelRig", () => {
  it("rebinds the hands to the weapon's joints, by name", () => {
    const rig = buildViewmodelRig(weapon(), hands());
    const glove = rig.root.getObjectByName("glove") as THREE.SkinnedMesh;
    expect(glove.parent).toBe(rig.root);
    expect(glove.skeleton.bones[0]).toBe(rig.root.getObjectByName("tag_view"));
    expect(rig.eye.name).toBe("tag_view");
  });

  it("hides every surface on a hidden joint, and nothing else", () => {
    const rig = buildViewmodelRig(weapon(), hands());
    expect(rig.root.getObjectByName("folded sight")!.visible).toBe(false);
    expect(rig.root.getObjectByName("body")!.visible).toBe(true);
  });

  /**
   * A weapon file hides an attachment by naming the one tag it hangs from, and
   * everything the attachment is made of hangs below that: `tag_acog_2` carries
   * a `tag_reticle_acog`, `tag_shotgun` four masterkey joints, `tag_gp25` the
   * launcher's own. Hiding only the named bone left a Modern Warfare 2 rifle
   * wearing every unfitted attachment's odds and ends at once.
   */
  it("hides what hangs under a hidden joint too", () => {
    const [origin, view, weaponTag, gun, scope] = chain(["tag_origin", "tag_view", "tag_weapon", "j_gun", "tag_acog_2"]);
    const [reticle] = chain(["tag_reticle_acog"]);
    scope!.add(reticle!);
    void weaponTag;
    void view;
    const scene = new THREE.Group();
    scene.add(
      origin!,
      meshOn([gun!, scope!, reticle!], 0, "body"),
      meshOn([gun!, scope!, reticle!], 1, "scope"),
      meshOn([gun!, scope!, reticle!], 2, "reticle"),
    );
    scene.userData.viewmodel = definition({ hideBones: ["tag_acog_2"] });

    const rig = buildViewmodelRig({ scene, clips: [new THREE.AnimationClip("gun_idle", 1, [])] }, hands());
    expect(rig.root.getObjectByName("scope")!.visible).toBe(false);
    expect(rig.root.getObjectByName("reticle")!.visible).toBe(false);
    expect(rig.root.getObjectByName("body")!.visible).toBe(true);
  });

  it("gives a one-frame clip its real length, leaving the store's copy alone", () => {
    const asset = weapon();
    expect(asset.clips[0]!.duration).toBe(0); // three's own reading: looping it would divide by zero
    const rig = buildViewmodelRig(asset, hands());
    expect(rig.clips.get("gun_idle")!.duration).toBeCloseTo(1 / 30);
    expect(asset.clips[0]!.duration).toBe(0);
  });

  it("refuses a file it cannot play", () => {
    expect(() => buildViewmodelRig(weapon(definition({ version: 0 })), hands())).toThrow(/format/);
    expect(() => buildViewmodelRig(weapon(definition({ roles: { idle: "gun_idle", fire: "absent" } })), hands())).toThrow(/absent/);
    expect(() => readWeaponDef({})).toThrow(/not a weapon/);
  });

  /**
   * A weapon GLB carries the hands skeleton of the game *it* came from, and the
   * two games' hands differ by a joint or two. Refusing the weapon over that
   * left a player empty-handed whenever their class named a gun from the other
   * game, which is half the catalogue.
   */
  it("takes a joint the hands bring that its own rig has never heard of", () => {
    const stray = hands();
    const [lost] = chain(["tag_knife_attach2"]);
    lost!.position.set(1, 2, 3);
    stray.scene.add(lost!, meshOn([lost!], 0, "stray"));

    const rig = buildViewmodelRig(weapon(), stray);
    const grafted = rig.root.getObjectByName("tag_knife_attach2");
    expect(grafted).toBeTruthy();
    expect(grafted!.position.toArray()).toEqual([1, 2, 3]);
    expect((rig.root.getObjectByName("stray") as THREE.SkinnedMesh).skeleton.bones[0]).toBe(grafted);
  });
});

describe("copyLights", () => {
  it("shares the sun's shadow, so the rig is shaded where the world is", () => {
    const world = new THREE.Group();
    const sun = new THREE.DirectionalLight(0xffffff, 20);
    sun.position.set(30, 70, -90);
    sun.castShadow = true;
    world.add(sun, sun.target, new THREE.AmbientLight(0xddeeff, 3));
    world.updateMatrixWorld(true);
    const copies = copyLights(world);
    const copy = copies.find((l): l is THREE.DirectionalLight => l instanceof THREE.DirectionalLight)!;
    expect(copy).not.toBe(sun);
    expect(copy.shadow).toBe(sun.shadow); // the same map and matrix, never rendered by the overlay
    expect(copy.castShadow).toBe(true);
    expect(copy.position).toEqual(sun.position);
    expect(copies.some((l) => l instanceof THREE.AmbientLight)).toBe(true);
  });
});

describe("the viewmodel's field of view", () => {
  it("is the game's cg_fov 65, horizontal at 4:3, as a vertical angle", () => {
    expect(codFovToVertical(65)).toBeCloseTo(51.08, 2);
    expect(codFovToVertical(90)).toBeCloseTo(73.74, 2);
  });
});
