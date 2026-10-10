// One loaded world: its scene, its assets, and the order they are brought up in.
//
// A session lives from entering a world to leaving it. A hot reload of the same
// world re-mounts the same session, which keeps its AssetStore so only changed
// files are fetched again. Leaving the world disposes it, freeing its GPU memory.

import * as THREE from "three";
import type { EntityId, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { indexWorld, type WorldIndex } from "@3d/shared/worlds/worldIndex.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import type { Player } from "@3d/shared/sim/player.js";
import { type WeaponId, type WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { attachmentModelUrl, overlayImageUrl, weaponModelUrl } from "../net/catalog.js";
import { AssetStore, type GltfAsset } from "../scene/assets.js";
import { buildScene, contentBounds, disposeScene, type BuiltScene } from "../scene/scene.js";
import { instanceModels } from "../scene/instancing.js";
import { buildViewmodelRig, type FittedAttachment } from "../scene/viewmodel.js";
import { CharacterKit, readCharacterSet, type CharacterSource } from "../scene/character.js";
import type { CatalogueView } from "@3d/shared/game/catalogueView.js";
import type { CastChoice, CatalogRef } from "@3d/shared/game/cast.js";
import type { GameView, PlayerView } from "@3d/shared/game/context.js";
import { scriptsFor } from "@3d/shared/game/registry.js";
import { hashString } from "@3d/shared/game/random.js";
import { counterIndex } from "@3d/shared/game/matchValues.js";
import { castFilePath } from "@3d/shared/protocol/routes/catalog.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { Animator } from "../engine/animator.js";
import type { FxSystem } from "../engine/fx/system.js";
import { buildFx } from "../scene/fx.js";
import type { AudioSystem } from "../engine/audio/system.js";
import { buildSounds } from "../scene/sounds.js";
import type { CollisionView, CollisionWorld } from "@3d/shared/collision/world.js";
import { presenceFor, presentNamed, type Presence } from "@3d/shared/worlds/presence.js";
import type { SnapshotPresence } from "@3d/shared/net/messages/snapshot.js";
import type { FirstPersonControls } from "../engine/controls/firstPerson.js";
import type { DollhouseControls } from "../engine/controls/orbit.js";
import type { Vec3 } from "@3d/shared/sim/movement.js";
import { applyWorldRules } from "@3d/shared/sim/worldRules.js";
import type { ShadowFit } from "../engine/shadows.js";
import type { Viewer } from "../engine/viewer.js";
import { copyLights, type Viewmodel } from "../engine/viewmodel.js";
import type { RemotePlayers } from "../net/remotePlayers.js";
import type { Corpses } from "../net/corpses.js";
import type { ActorKit, ActorsView } from "../net/actors.js";
import { ACTOR_KINDS, type ActorKindId } from "@3d/shared/game/actors/kinds.js";
import { actorAssetsFor } from "@3d/shared/game/actors/assets.js";
import { catalogRefUrl } from "../scene/assetUrl.js";
import type { PhysicsWorld } from "@3d/shared/physics/world.js";
import type { DevTools } from "./devTools.js";
import { worldBaseUrl } from "./worldLoader.js";

export interface Engine {
  viewer: Viewer;
  animator: Animator;
  /** The world's particle effects. Owns a root beside the scene, so a world change replaces it. */
  fx: FxSystem;
  /** What the world sounds like. Owns a root beside the scene, like `fx`, and for a sharper reason (engine/audio/system.ts). */
  audio: AudioSystem;
  collision: CollisionWorld;
  /** The collision as the match has it: each mount hands it this world's presence. */
  live: CollisionView;
  firstPerson: FirstPersonControls;
  dollhouse: DollhouseControls;
  shadowFit: ShadowFit;
  viewmodel: Viewmodel;
  /** The other players: they wear the world's own characters, so a world change re-dresses them. */
  remotes: RemotePlayers;
  /** The bodies on the floor. Owns a root beside the scene, like `fx` and `remotes`. */
  corpses: Corpses;
  /** The creatures a game server runs. Owns a root beside the scene; a world change reloads their bodies. */
  actors: ActorsView;
  /** Every weapon this build can name, so a world's viewmodel is built from the shared definition. */
  weapons: WeaponRegistry;
  /**
   * The catalogue the cast is chosen out of, and the gametype choosing.
   *
   * A function, like `loadout`: the catalogue arrives over HTTP a moment after
   * the page does, and a world can be mounted before or after that.
   */
  cast: () => { catalogue: CatalogueView; gametype: GametypeDecl };
  /**
   * The class the player spawns with, read when a world is mounted.
   *
   * A function rather than a value because the classes arrive over HTTP a moment
   * after the page does, and a world can be mounted before or after that.
   */
  loadout: () => Loadout;
  dev: DevTools;
}

/** Where the camera goes once the world is up. */
export type Arrival =
  { kind: "spawn" } | { kind: "keep"; feet: Vec3; yaw: number; pitch: number } | { kind: "pose"; feet: Vec3; yaw: number; pitch: number; hold: boolean };

/** One body of a cast, with whichever of its files loaded. */
interface LoadedBody {
  id: string;
  body?: GltfAsset;
  head?: GltfAsset;
  weapon?: GltfAsset;
}

/**
 * A fetched cast.
 *
 * Per body rather than one flat list, which the flat version had to index with
 * `files.slice(1 + i * 3, 4 + i * 3)`: a body with no head shifted every body
 * after it by one, silently, onto somebody else's face. The stride is gone.
 */
interface CastAssets {
  animations: GltfAsset | undefined;
  bodies: LoadedBody[];
}

interface Mount {
  world: ResolvedWorld;
  /** Which solids and `mode:` models exist, from the gametype's mode; the snapshot updates the solids. */
  presence: Presence;
  built: BuiltScene;
  arrival: Arrival;
  box?: THREE.Box3;
  texelSize?: number;
  /**
   * Who the players are, chosen by the gametype's script rather than declared by
   * the world. Undefined where this deployment cannot dress anyone — a
   * hand-written world, or a game with no catalogue built — and peers stay
   * capsules, which is what a world without a `characters` has always done.
   */
  cast?: CastChoice;
  /** The view hands, fetched alongside the models. */
  hands?: Promise<GltfAsset | undefined>;
  /** The clip file and every body's files, fetched alongside the models. */
  characters?: Promise<CastAssets>;
}

export class WorldSession {
  readonly assets = new AssetStore();
  /** The map's view hands, worn by whichever weapon is in hand. */
  private hands: GltfAsset | undefined;
  /** Copies of the world's lights for the viewmodel's own pass, made once per world. */
  private lights: THREE.Light[] = [];
  /** Every carried weapon's models, by `rigKey`, so a swap redraws without a fetch. */
  private readonly carried = new Map<string, { weapon: GltfAsset; attachments: FittedAttachment[] }>();
  /** The `rigKey` currently drawn, or null for empty hands. What `followSwap` compares against. */
  private drawn: string | null = null;
  /**
   * The `Player.armed` count whose weapons have been fetched and drawn. A server
   * handing over weapons mid-life — a respawn, a class taking effect, a script's
   * `arm` — reaches this end as a new count in a snapshot, and `followSwap` is
   * what notices.
   */
  private armedSeen = -1;
  private built: BuiltScene | undefined;
  /**
   * This world's physics, or undefined where the engine did not load.
   *
   * Held here rather than on `Corpses` because it is the *world's*: a second kind
   * of dynamic thing would share it, and leaving a world has to free it whatever
   * happens to be in it.
   */
  private physics: PhysicsWorld | undefined;
  private resolved: ResolvedWorld | undefined;
  private indexed: WorldIndex | undefined;
  /** This mount's presence: the same object the collision view reads. */
  private presence: Presence | undefined;
  /** The drawn nodes of each solid, by its index: shown and hidden, never rebuilt or pooled. */
  private partNodes: THREE.Object3D[][] = [];
  /** A bitset the wrong size for this world, said once rather than every tick. */
  private presenceWarned = false;

  constructor(
    readonly slug: string,
    private readonly engine: Engine,
  ) {}

  get world(): ResolvedWorld | undefined {
    return this.resolved;
  }

  get root(): THREE.Group | undefined {
    return this.built?.root;
  }

  /** How this world's objects are addressed by id, name or tag. Undefined until a mount finishes. */
  get index(): WorldIndex | undefined {
    return this.indexed;
  }

  /** The scene node built for one object, or undefined once the session is torn down. */
  nodeFor(id: EntityId): THREE.Object3D | undefined {
    return this.built?.nodes.get(id);
  }

  /**
   * Build `world` and bring it up. Replaces whatever this session had mounted.
   * `onStep` hears each step's name and place (0-based, of `count`) before it
   * runs, and may return a promise to yield (so a loading screen can paint).
   */
  async mount(world: ResolvedWorld, arrival: Arrival, onStep?: (step: string, index: number, count: number) => void | Promise<void>): Promise<void> {
    const { viewer, animator, fx, audio, collision, live, corpses, firstPerson, dollhouse, shadowFit, remotes, actors, dev } = this.engine;
    const { player } = firstPerson;

    // Each step depends on the ones above it; the comment says on what.
    const steps: [string, (m: Mount) => void | Promise<void>][] = [
      [
        "release old scene",
        () => {
          this.releaseScene();
          this.assets.disposeRetired();
        },
      ],
      // The grade is compiled into every shader, so it must precede the materials.
      ["grade", (m) => viewer.setGrade(m.world.grade)],
      [
        "build",
        (m) => {
          m.presence = presenceFor(m.world, this.engine.cast().gametype.mode);
          m.built = buildScene(m.world, worldBaseUrl(this.slug), this.assets, m.presence);
          this.built = m.built;
          this.resolved = m.world;
          this.indexed = indexWorld(m.world);
          const sky = m.world.sky ? new THREE.Color(m.world.sky) : null;
          viewer.roots.setWorld(m.built.root, { background: sky, fog: sky ? new THREE.FogExp2(sky, 3 / (m.world.visibility ?? 300)) : null });
          // Who is in this world is a gametype's answer now, not the world's.
          // Everything it names lives in the shared catalogue, so nothing here is
          // relative to the map — which is what lets a body be worn anywhere.
          // The carried weapon is still fetched in the viewmodel step, because
          // which one it is depends on the player's class.
          m.cast = this.chooseCast(m.world);
          if (m.cast) {
            m.hands = this.assets.gltf(castFilePath(m.cast.hands));
            m.characters = this.fetchCast(m.cast);
          }
        },
      ],
      // Models load asynchronously; everything below needs their meshes.
      [
        "load assets",
        async (m) => {
          await Promise.all(m.built.pending);
        },
      ],
      // Before instancing, which moves meshes into batches the BVH build would miss.
      [
        "collision",
        (m) => {
          collision.rebuild(
            m.built.root,
            m.world.solids.map((solid) => solid.part),
          );
          collision.setHulls(m.built.hulls.geometries, m.built.hulls.placements);
          this.presence = m.presence;
          this.presenceWarned = false;
          live.presence = m.presence;
          const stats = collision.hullStats;
          console.info(`[collision] ${stats.instances} prop hulls over ${stats.assets} shared asset BVHs`);
        },
      ],
      [
        // After collision, which is the step that produced the geometry this one
        // reads. The import is dynamic and is the only one in this bundle: the
        // engine inlines its wasm as base64 and is about 2.9 MB of JavaScript, so
        // it belongs in a chunk fetched while a world loads rather than in the
        // bundle a menu is drawn from.
        //
        // Never fatal. A world whose physics did not come up still plays, exactly
        // as it did before there were any; the bodies simply stand where they died.
        "physics",
        async (m) => {
          try {
            const [{ initPhysics }, { PhysicsWorld }, ragdoll] = await Promise.all([
              import("@3d/shared/physics/engine.js"),
              import("@3d/shared/physics/world.js"),
              import("@3d/shared/physics/ragdoll.js"),
            ]);
            await initPhysics();
            const physics = new PhysicsWorld(firstPerson.tickRate);
            physics.loadTerrain(collision, "shots", m.presence);
            this.physics = physics;
            corpses.setWorld(physics, ragdoll);
            // The boxes a corpse is made of, through the session's own store — so
            // they are cached with every other asset and freed with them, which is
            // the invariant every asset in this engine is held to. The ordinary
            // client has never fetched a `.hitboxes.json` before; only the debug
            // view did.
            corpses.setSidecars(this.assets);
          } catch (error) {
            console.warn(`[physics] unavailable (${error instanceof Error ? error.message : String(error)}); nobody will fall over`);
          }
        },
      ],
      // After collision, which reads every collide mesh while it is still visible;
      // before instancing, which must never pool a part into a batch it cannot hide.
      [
        "parts",
        (m) => {
          this.partNodes = partNodesOf(
            m.built.root,
            m.world.solids.map((solid) => solid.part),
          );
          this.partNodes.forEach((nodes, i) => {
            for (const node of nodes) {
              node.visible = m.presence.has(i);
            }
          });
        },
      ],
      [
        "instancing",
        (m) => {
          const stats = instanceModels(m.built.root);
          // Collision-only meshes have served their purpose; stop the renderer walking them.
          let hidden = 0;
          m.built.root.traverse((obj) => {
            if (obj.userData.collider === true || obj.userData.collisionMesh === true) {
              obj.visible = false;
              hidden++;
            }
          });
          console.info(
            `[render] instanced ${stats.instances} meshes into ${stats.batches} batches  ·  ${stats.removedNodes} nodes removed  ·  ${hidden} collider meshes hidden`,
          );
        },
      ],
      // Nothing in a built world moves: compute every matrix once (see viewer.ts).
      [
        "freeze matrices",
        (m) => {
          m.built.root.updateMatrixWorld(true);
          m.built.root.traverse((obj) => {
            obj.matrixAutoUpdate = false;
          });
        },
      ],
      // After freezing, which it undoes for the rigs it plays; after collision,
      // which is built from those rigs at rest (docs/engine/rendering.md#animated-props).
      [
        "animation",
        (m) => {
          animator.attach(m.built.animated, this.assets.shaderClock);
          if (animator.count) {
            console.info(`[animation] ${animator.count} placements playing ${new Set(m.built.animated.map((a) => a.clip)).size} clips`);
          }
        },
      ],
      // Particles live in their own root beside the world and are written in
      // world space, so the freeze above does not reach them and none of the
      // static-world rules apply. After it all the same, so a failed fetch
      // cannot leave a half-built world behind.
      [
        "effects",
        async (m) => {
          const built = await buildFx(m.world, worldBaseUrl(this.slug), this.assets);
          if (!built) {
            return;
          }
          fx.attach(built.placements, built.library, built.build);
          const skipped = [...fx.skippedCounts].map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ");
          console.info(`[fx] ${fx.emitterCount} emitter(s) over ${built.placements.length} placement(s)` + (skipped ? ` — not drawn: ${skipped}` : ""));
        },
      ],
      // Ambience lives in its own root beside the world, written in world space
      // and driven by itself, so the freeze above does not reach it — and must
      // not, since a `PositionalAudio` in the built world plays at the origin
      // for ever (docs/engine/audio.md#the-frozen-matrix-trap).
      //
      // Never fatal, like the physics step: a world whose audio would not load
      // still plays, exactly as every world did before there was any.
      [
        "sound",
        async (m) => {
          try {
            const built = await buildSounds(m.world, worldBaseUrl(this.slug), this.assets);
            if (!built) {
              return;
            }
            audio.attach(built);
            const { placements, resolved } = audio.ambienceCount;
            const missing = placements - resolved;
            const tables = built.banks.map((bank) => Object.keys(bank.library.aliases).length).join(" + ");
            console.info(`[sound] ${resolved} placement(s), ${tables} alias(es)` + (missing ? ` — ${missing} unresolved` : ""));
          } catch (error) {
            console.warn(`[sound] ${error instanceof Error ? error.message : String(error)}; this world is silent`);
          }
        },
      ],
      // What the player carries, drawn in its own pass — so none of the steps
      // above apply to it; after the freeze only so the world's lights it copies
      // have their final matrices.
      [
        "viewmodel",
        async (m) => {
          if (!m.cast || !m.hands) {
            return;
          }
          const hands = await m.hands;
          if (!hands) {
            return; // the store has warned
          }
          this.hands = hands;
          this.lights = copyLights(m.built.root);

          // The player's class wins, and the gametype's default is what a player
          // with no class — or one naming nothing this catalogue holds — falls
          // back to. Something names a weapon so that walking into a world armed
          // is not conditional on having built a class.
          const carried = this.carry(m.cast.defaultWeapon);
          this.armedSeen = player.armed;
          await this.fetchCarried(player);
          // Equipping brings the weapon up (Player.equip). A held pose is a
          // screenshot and a hot reload keeps going, so neither plays that raise:
          // a frozen player never steps it, and would hold its first frame.
          const first = m.arrival.kind === "spawn" || (m.arrival.kind === "pose" && !m.arrival.hold);
          if (!this.showHeld({ ready: !first })) {
            return;
          }
          console.info(`[viewmodel] ${carried} in ${m.cast.hands.file}`);
        },
      ],
      // Other players wear the catalogue's bodies, chosen by the gametype: the kit
      // is built here, once, and a body is built from it whenever someone joins.
      // Nothing below it depends on it — nobody has joined yet — and it never
      // fails a load.
      [
        "characters",
        async (m) => {
          if (!m.cast || !m.characters) {
            remotes.setKit(undefined);
            return;
          }
          try {
            const kit = buildCharacterKit(m.cast, await m.characters);
            remotes.setKit(kit);
            console.info(`[characters] ${kit.names.join(", ")} with ${kit.set.weapon} (${kit.set.animType})`);
          } catch (e) {
            remotes.setKit(undefined);
            console.warn(`[characters] ${e instanceof Error ? e.message : String(e)}; peers are drawn as capsules`);
          }
        },
      ],
      // The bodies of the actor kinds that have one, from the catalogue. A kind
      // whose files do not load is drawn as its capsule; nothing waits on this.
      ["actor bodies", async () => actors.setKits(await this.fetchActorKits(), hashString(this.slug))],
      ["debug views", (m) => dev.afterBuild(m.built.root)],
      [
        "camera",
        (m) => {
          applyWorldRules(player, m.world);
          const a = m.arrival;
          if (a.kind === "spawn") {
            player.respawn();
          } else {
            player.place(a.feet, a.yaw, a.pitch);
          }
          if (a.kind === "pose") {
            firstPerson.setFrozen(a.hold);
          }
          // After placing, never before: an arrival must not inherit the last
          // position's interpolation or the mouse movement made while loading.
          firstPerson.arrive();
          m.box = contentBounds(m.built.root);
          dollhouse.frame(m.box);
          viewer.setFar(farPlaneFor(m.world));
          viewer.setExposure(m.world.exposure);
        },
      ],
      // Needs the finished content bounds (engine/shadows.ts).
      [
        "shadows",
        (m) => {
          const fit = shadowFit.build(m.built.root, m.box!, {
            focusRadius: viewer.qualitySettings.shadowFocusRadius,
            mapSize: viewer.qualitySettings.shadowMapSize,
          });
          shadowFit.update(viewer.camera);
          m.texelSize = fit.texelSize;
          console.info(
            `[shadows] ${fit.lights} directional  ·  ${fit.focused ? "focused" : "whole-world"} radius ${fit.radius.toFixed(0)}m  ·  ${(fit.texelSize * 100).toFixed(1)}cm per texel`,
          );
        },
      ],
      // After the fit: the shadow-caster threshold is measured in shadow texels.
      [
        "quality",
        (m) => {
          viewer.applyQuality(m.built.root, m.texelSize);
        },
      ],
      // Last, once everything a frame draws is in the scene: every pass's programs
      // (engine/render/pipeline.ts). An optimisation only, so a failure must not
      // stop the world coming up.
      [
        "compile shaders",
        async () => {
          try {
            await viewer.prewarm();
          } catch (e) {
            console.warn("Shader prewarm failed; continuing without it", e);
          }
        },
      ],
    ];

    const mount = { world, arrival } as Mount;
    const timings: string[] = [];
    for (const [i, [name, step]] of steps.entries()) {
      await onStep?.(name, i, steps.length);
      const start = performance.now();
      await step(mount);
      timings.push(`${name} ${Math.round(performance.now() - start)}ms`);
    }
    console.info(`[load] ${this.slug}: ${timings.join("  ·  ")}`);
  }

  /**
   * The server's word on which solids are present, off a snapshot. What changed
   * goes from the physics world (at the tick it changed on the server, which the
   * snapshot names, so every end's corpses meet the same colliders), the drawn
   * meshes and the shadow map; the collision view reads the presence itself.
   */
  applyPresence(wire: SnapshotPresence | null, tick: number): void {
    const presence = this.presence;
    if (!presence || !wire) {
      return;
    }
    let changed: number[];
    try {
      changed = presence.assign(wire.bits);
    } catch (error) {
      if (!this.presenceWarned) {
        this.presenceWarned = true;
        console.warn(`[parts] ${error instanceof Error ? error.message : String(error)}; this world's solids stay as they are`);
      }
      return;
    }
    if (changed.length === 0) {
      return;
    }
    if (this.physics) {
      this.physics.step(tick - ((tick - wire.since) & 0xffff));
      for (const i of changed) {
        this.physics.setPart(i, presence.has(i));
      }
    }
    for (const i of changed) {
      for (const node of this.partNodes[i] ?? []) {
        node.visible = presence.has(i);
      }
    }
    // One redraw: the shadow map never updates by itself (engine/viewer.ts).
    this.engine.viewer.invalidateShadows();
  }

  /** Leave the world: free its scene and every asset it loaded. */
  dispose(): void {
    this.releaseScene();
    this.resolved = undefined;
    this.indexed = undefined;
    this.presence = undefined;
    this.assets.dispose();
    this.engine.viewer.roots.setWorld(undefined);
  }

  /** Let go of the built scene and everything attached to it. The highlight borrows its geometry, so it lets go first. */
  private releaseScene(): void {
    this.engine.dev.beforeSwap();
    this.engine.animator.clear();
    this.engine.fx.clear();
    this.engine.audio.clear();
    this.engine.remotes.setKit(undefined);
    this.engine.actors.setKits(new Map());
    // Before the scene goes. A Rapier world is wasm memory that no garbage
    // collector frees, so leaving a world without this is a leak no `dispose()`
    // can find — the same argument the AssetStore invariant makes about textures.
    this.engine.corpses.setWorld(undefined);
    this.engine.corpses.setSidecars(undefined);
    this.physics?.free();
    this.physics = undefined;
    this.dropWeapon();
    this.partNodes = [];
    if (this.built) {
      disposeScene(this.built);
    }
    this.built = undefined;
  }

  /**
   * This world as a script addresses it: the one place the browser builds a
   * `GameView`, so the cast at mount and an announcement mid-match cannot
   * disagree about what a script is looking at.
   *
   * `world` is passed rather than read back, because the cast is chosen inside
   * the mount step that resolves it. `now` is the match clock — `tick / tickRate`,
   * the same number the server's is — and 0 offline, where nothing is ticking.
   */
  gameView(world: ResolvedWorld, now = 0, players: readonly PlayerView[] = [], values: MatchValues = NO_MATCH_VALUES): GameView {
    const { catalogue, gametype } = this.engine.cast();
    const byId = new Map(players.map((p) => [p.id, p]));
    // The mounted world's index, which is the same object every time: a world
    // never changes for the life of a session, and `indexWorld` walks every
    // object in it. Built here only for a world that is not the mounted one,
    // which is the cast being chosen inside the step that resolves it.
    const index = world === this.resolved && this.indexed ? this.indexed : indexWorld(world);
    // The snapshot's bits once the collision step has adopted them; before it,
    // what the mode seeds, which is what the server starts from too.
    const presence = (): Pick<Presence, "has"> => (world === this.resolved && this.presence ? this.presence : presenceFor(world, gametype.mode));
    return {
      world: index,
      game: world.game,
      map: this.slug,
      gametype,
      catalogue,
      now,
      // The map's slug, as a game server seeds it from `playing.map`: one world
      // draws one sequence wherever it is being played.
      seed: hashString(this.slug),
      players,
      player: (id) => byId.get(id),
      isPresent: (tagOrName) => presentNamed(index, presence(), tagOrName),
      // The snapshot's, in the declaration's order; 0 before the first one says.
      counter: (name) => values.counters[counterIndex(gametype, name)] ?? 0,
    };
  }

  /**
   * Who the players in this world are, as the gametype's scripts answer it.
   *
   * The same call a game server makes, with the same inputs, so a client with no
   * server to join dresses everyone exactly as a real match does — which is what
   * `pnpm dev` is. The first script with an opinion wins; none means capsules.
   */
  private chooseCast(world: ResolvedWorld): CastChoice | undefined {
    const { gametype } = this.engine.cast();
    // Nobody is in the world at mount, and the cast reads neither the clock nor
    // the roster.
    const view = this.gameView(world);
    for (const script of scriptsFor(gametype.id, this.slug)) {
      // No team offline: nothing has assigned one, so the cast is every body the
      // gametype admits and a peer's id picks among them, as it does today.
      const chosen = script.client?.cast?.(view, undefined);
      if (chosen) {
        return chosen;
      }
    }
    return undefined;
  }

  /**
   * The catalogue creature of every actor kind this gametype's scripts may spawn
   * (`Script.actors`), by kind: its clips, and each body and head it may wear. Said
   * once per kind that does not load. A world whose scripts spawn nothing fetches
   * nothing: a creature is megabytes, and most matches have none.
   */
  private async fetchActorKits(): Promise<Map<ActorKindId, ActorKit>> {
    const kits = new Map<ActorKindId, ActorKit>();
    const { catalogue, gametype } = this.engine.cast();
    const wanted = new Set(scriptsFor(gametype.id, this.slug).flatMap((script) => script.actors ?? []));
    const file = (ref: CatalogRef) => this.assets.gltf(catalogRefUrl(ref));
    await Promise.all(
      ACTOR_KINDS.map(async (kind) => {
        if (!kind.body || !wanted.has(kind.id)) {
          return;
        }
        try {
          const assets = actorAssetsFor(kind.body, catalogue);
          if (!assets) {
            return; // not in this catalogue: its capsule
          }
          const [clips, bodies, heads] = await Promise.all([file(assets.clips), Promise.all(assets.bodies.map(file)), Promise.all(assets.heads.map(file))]);
          if (!clips || bodies.every((body) => !body)) {
            return; // the store has warned
          }
          kits.set(kind.id, { assets, clips: clips.clips, bodies, heads });
        } catch (e) {
          console.warn(`[actors] ${kind.id}'s body: ${e instanceof Error ? e.message : String(e)}; drawn as its capsule`);
        }
      }),
    );
    return kits;
  }

  /** Every body's files, fetched together. A body that fails to load is dropped, not fatal. */
  private async fetchCast(cast: CastChoice): Promise<CastAssets> {
    const file = (ref: CatalogRef | undefined): Promise<GltfAsset | undefined> =>
      ref === undefined ? Promise.resolve(undefined) : this.assets.gltf(castFilePath(ref));
    const [animations, ...bodies] = await Promise.all([
      file(cast.animations),
      ...cast.characters.map(async (character): Promise<LoadedBody> => {
        const [body, head, weapon] = await Promise.all([file(character.body), file(character.head), file(character.weapon)]);
        return { id: character.id, body, head, weapon };
      }),
    ]);
    return { animations, bodies: bodies as LoadedBody[] };
  }

  /**
   * Equip the player: their class, or the gametype's default when the class arms
   * them with nothing this catalogue holds. Returns what they ended up carrying,
   * for the log.
   */
  private carry(fallback: WeaponId | null, loadout: Loadout = this.engine.loadout()): string {
    const player = this.engine.firstPerson.player;
    player.equipLoadout(loadout);
    if (player.weaponId !== null) {
      return `class ${loadout.name}`;
    }
    if (fallback === null) {
      return "nothing (this gametype names no default weapon)";
    }
    player.equipById(fallback);
    return player.weaponId === null ? `nothing ("${fallback}" is not in the catalogue)` : fallback;
  }

  /**
   * Fetch a model for every weapon the player carries and everything fitted to
   * it, so a swap draws immediately rather than after a round trip.
   *
   * Both weapons, not just the one in hand: the second is one keypress away, and
   * a two-megabyte fetch between the putaway and the raise would show as the
   * hands coming up empty.
   */
  private async fetchCarried(player: Player): Promise<void> {
    const wanted = player.carrying.filter((held) => held.id !== null);
    await Promise.all(wanted.map((held) => this.fetchWeapon(held.id!, held.fitted)));
  }

  private async fetchWeapon(id: WeaponId, fitted: readonly number[]): Promise<void> {
    const entry = this.engine.weapons.entry(id);
    const url = weaponModelUrl(id);
    if (!entry || url === undefined || this.carried.has(rigKey(id, fitted))) {
      return;
    }
    const wanted = entry.attachments.filter((_, slot) => fitted.includes(slot));
    const [weapon, ...models] = await Promise.all([
      this.assets.gltf(url),
      ...wanted.map((a) => (a.model ? this.assets.gltf(attachmentModelUrl(entry.game, a.model)) : Promise.resolve(undefined))),
    ]);
    if (weapon) {
      this.carried.set(rigKey(id, fitted), { weapon, attachments: wanted.map((entryFor, i) => ({ entry: entryFor, asset: models[i] })) });
    }
  }

  /**
   * Draw whatever the player is holding now.
   *
   * Called on every frame the held weapon changes, which is what makes a swap
   * visible: the rig is per weapon *and* per fitted set, so it is rebuilt rather
   * than re-posed — `Viewmodel.clear` disposes the skeletons of the one it had.
   */
  showHeld(options: { ready?: boolean } = {}): boolean {
    const player = this.engine.firstPerson.player;
    const weapon = player.weapon;
    const parts = this.carried.get(rigKey(player.weaponId, player.fitted));
    if (!weapon || !parts || !this.hands) {
      this.drawn = null;
      this.engine.viewmodel.clear();
      return false;
    }
    try {
      const rig = buildViewmodelRig(parts.weapon, this.hands, { def: weapon.def, attachments: parts.attachments });
      // The scope picture is read from the *resolved* definition, not the GLB's:
      // it is what a fitted optic changes, and an ACOG on a sniper rifle removes.
      const overlay = weapon.def.adsOverlay;
      this.engine.viewmodel.attach(rig, this.lights, weapon, overlay ? this.assets.picture(overlayImageUrl(weapon.def.game, overlay)) : undefined);
      this.drawn = rigKey(player.weaponId, player.fitted);
      if (options.ready) {
        weapon.ready();
      }
      return true;
    } catch (e) {
      this.dropWeapon();
      console.warn(`[viewmodel] ${player.weaponId ?? "?"}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * Redraw if the player is holding something other than what is drawn: a swap,
   * or weapons a server handed over. Cheap when neither, which is every frame but
   * one.
   *
   * Handed-over weapons may not have been fetched — a class chosen in the match,
   * a script's rocket launcher — so they are fetched first and drawn when they
   * arrive, unless something newer was handed over meanwhile.
   */
  followSwap(): void {
    const player = this.engine.firstPerson.player;
    if (this.hands && player.armed !== this.armedSeen) {
      const armed = (this.armedSeen = player.armed);
      void this.fetchCarried(player).then(() => {
        if (this.hands && this.armedSeen === armed) {
          this.showHeld();
        }
      });
      return;
    }
    if (this.drawn !== null && rigKey(player.weaponId, player.fitted) !== this.drawn) {
      this.showHeld();
    }
  }

  /** The bodies belong to the world they came from, like the weapon. */
  private dropWeapon(): void {
    this.engine.viewmodel.clear();
    this.engine.firstPerson.player.equip(undefined);
    this.carried.clear();
    this.hands = undefined;
    this.drawn = null;
  }
}

/**
 * The drawn nodes of each named part: every node carrying `userData.part` (a
 * shell's `extras.part`) outside the collision mesh, by the part's index in
 * `parts`. Each mesh under one is marked `renderPart`, which instancing skips.
 */
function partNodesOf(root: THREE.Object3D, parts: readonly string[]): THREE.Object3D[][] {
  const index = new Map(parts.map((part, i) => [part, i]));
  const found: THREE.Object3D[][] = parts.map(() => []);
  root.traverse((node) => {
    const i = typeof node.userData.part === "string" && !node.userData.collisionMesh ? index.get(node.userData.part) : undefined;
    if (i === undefined) {
      return;
    }
    found[i]!.push(node);
    node.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.userData.renderPart = i;
      }
    });
  });
  return found;
}

/** A rig is per weapon *and* per fitted set: the same gun with an ACOG is a different thing to draw. */
function rigKey(id: WeaponId | null, fitted: readonly number[]): string {
  return `${id ?? ""}|${fitted.join(",")}`;
}

/** Every file a `characters` names, the clip file first, in the order buildCharacterKit expects them back. */
function buildCharacterKit(cast: CastChoice, loaded: CastAssets): CharacterKit {
  const { animations } = loaded;
  if (!animations) {
    throw new Error(`${cast.animations.file} did not load`); // the store has warned
  }
  const sources: CharacterSource[] = loaded.bodies
    .filter((one): one is LoadedBody & { body: GltfAsset } => one.body !== undefined)
    .map((one) => ({ name: one.id, body: one.body, head: one.head, weapon: one.weapon }));
  if (sources.length === 0) {
    throw new Error(`none of this cast's ${cast.characters.length} character bodies loaded`);
  }
  return new CharacterKit(readCharacterSet(animations.scene.userData), animations.clips, sources);
}

/**
 * A far plane beyond the fog: an imported map declares 600 m of `visibility`,
 * which a 200 m plane cuts a visible line across.
 */
function farPlaneFor(w: ResolvedWorld): number {
  return Math.max(200, (w.visibility ?? 0) * 1.5);
}

/** A match's own numbers as the snapshot carries them (`SnapshotMessage.counters`). */
export interface MatchValues {
  readonly counters: readonly number[];
}

/** Offline, or before the first snapshot: nothing counted. */
export const NO_MATCH_VALUES: MatchValues = { counters: [] };
