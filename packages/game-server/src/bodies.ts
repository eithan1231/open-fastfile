// The bodies this instance can trace a shot against, fetched from the authority
// at boot.
//
// The third-person half of `weapons.ts`, and built the same way for the same
// reasons. A server judges a shot against a skeleton rather than against a
// capsule (docs/engine/collision.md), so it has to pose the body the client drew
// and read where the bones ended up — which means holding the same GLBs the
// browser holds, over the same public catalogue route.
//
// It reads `Weapons`' catalogue rather than fetching the index again, because one
// read behind both is what stops what a player is dressed in and what they hold
// coming from two different rebuilds.

import "./gltfGlobals.js";

import { inject, singleton } from "tsyringe";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";
import { castFor, type CastCharacter, type CatalogRef } from "@3d/shared/game/cast.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import { castFilePath } from "@3d/shared/protocol/routes/catalog.js";
import { buildCharacterRig, readCharacterSet, type CharacterRig, type CharacterSet, type GltfAsset } from "@3d/shared/rig/character.js";
import { BoundHitboxes, readHitboxes, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import { CharacterPoser } from "@3d/shared/rig/poser.js";
import { ActorPoser } from "@3d/shared/rig/actorPoser.js";
import { buildActorRig } from "@3d/shared/rig/actorRig.js";
import { actorAssetsFor } from "@3d/shared/game/actors/assets.js";
import { ACTOR_KINDS, type ActorKindDef, type ActorKindId } from "@3d/shared/game/actors/kinds.js";
import { Api } from "./api.js";
import { Weapons } from "./weapons.js";

/**
 * Every game a body can belong to. A `Record` over `GameKey` rather than a list,
 * so a fifth game fails to compile here rather than quietly loading none of its
 * bodies.
 */
const GAMES = Object.keys({ iw4: 0, iw5: 0, iw6: 0, t5: 0, t6: 0, s1: 0 } satisfies Record<GameKey, number>) as GameKey[];

const loader = new GLTFLoader();

/** Where a body is kept: the game its entry belongs to, and its id. What `BodyView.get` is asked with. */
function bodyKey(character: CastCharacter): string {
  return `${character.body.game}/${character.id}`;
}

/** The files of one load, so a clip set fetched for one body is not fetched again for the next. */
type Files = Map<string, Promise<GltfAsset>>;

/**
 * One body, posed and shot at.
 *
 * **One rig per character id, not per player.** Posing is immediately followed by
 * reading the bones, so a scratch rig per body is enough — and there are 26 bodies
 * against any number of players. Whoever poses one reads it before anything else
 * poses it again.
 *
 * The poser is here for the same reason and one more: it binds a mixer to *this*
 * rig's bones, so it could not be shared anyway, and it keeps nothing between calls
 * (every action is paused and placed by phase), so one per rig serves every shot.
 */
export interface LoadedBody {
  /** The catalogue id, which is what a cast names a body by. */
  id: string;
  game: GameKey;
  rig: CharacterRig;
  /** Poses `rig` from a `MovementState`, exactly as the client poses the body it draws. */
  poser: CharacterPoser;
  boxes: BoundHitboxes;
}

/** One body of an actor kind, posed and shot at: a player's `LoadedBody`, posed from an `ActorState`. */
export interface LoadedActorRig {
  rig: CharacterRig;
  poser: ActorPoser;
  boxes: BoundHitboxes;
}

/**
 * One actor kind's bodies, in its catalogue entry's order, so `ActorLook.body`
 * indexes them. A scratch rig per body rather than per actor, for the reason there
 * is one per character; and no head, because each body already carries every
 * head's joints (the exporter grafts their union) and a head's mesh stops nothing.
 */
export interface LoadedActorBody {
  kind: ActorKindId;
  bodies: readonly LoadedActorRig[];
}

/**
 * The questions a shot asks of the bodies.
 *
 * An interface because `Match` holds it: a match built with no instance behind it
 * still has to answer, exactly as `CatalogueView` lets one be built with no
 * catalogue.
 */
export interface BodyView {
  get(game: string, id: string): LoadedBody | undefined;
  /** An actor kind's body, or undefined for a kind with none, which is shot as its capsule. */
  actor?(kind: ActorKindId): LoadedActorBody | undefined;
}

/** What a match plays with when nothing loaded any bodies for it. */
export const NO_BODIES: BodyView = { get: () => undefined };

@singleton()
export class Bodies implements BodyView {
  private bodies = new Map<string, LoadedBody>();
  private actors = new Map<ActorKindId, LoadedActorBody>();

  constructor(
    @inject(Api) private readonly api: Api,
    @inject(Weapons) private readonly weapons: Weapons,
  ) {}

  /** The body a cast named, or undefined where this instance could not build it. */
  get(game: string, id: string): LoadedBody | undefined {
    return this.bodies.get(`${game}/${id}`);
  }

  actor(kind: ActorKindId): LoadedActorBody | undefined {
    return this.actors.get(kind);
  }

  /** How many bodies a shot can land on here. Zero is a hosted match nobody can be hit in. */
  get size(): number {
    return this.bodies.size;
  }

  /**
   * Load every body the catalogue holds, for every game it holds one for.
   *
   * Eager, and not narrowed to one game: an instance is told its map when a game
   * is ordered rather than at boot, and a shot must not wait on an HTTP fetch. It
   * is 26 bodies and about 30 MB of GLB on this disk, against a single map's BVH.
   *
   * Never fatal, as `Weapons.load` is not. An instance that loaded no bodies
   * still hosts a walkable match, and this is said loudly because "nobody here
   * can be shot" reads as a netcode fault and is not one. Runs after
   * `Weapons.load`, whose catalogue it reads.
   */
  async load(): Promise<void> {
    const started = Date.now();
    const files: Files = new Map();
    const loaded = new Map<string, LoadedBody>();
    // A body is keyed by the game it belongs to, which is not always the game
    // asking: one whose cast is borrowed (`castFor`'s stand-in) names another
    // game's bodies, and they are built once, whichever game asks first.
    const claimed = new Set<string>();
    let skipped = 0;

    await Promise.all(
      GAMES.map(async (game) => {
        // The same cast a client builds, asked for with no side so it widens to
        // every body of the game: which one a player wears is decided per player,
        // and this instance may be ordered onto any map. Asking `castFor` rather
        // than spelling the catalogue's folders again is what keeps the files
        // this fetches the files the browser fetches.
        const found = castFor({ game, gametype: defaultGametype }, this.weapons.catalogue);
        const characters = found?.characters.filter((character) => !claimed.has(bodyKey(character)));
        if (!found || !characters?.length) {
          return;
        }
        characters.forEach((character) => claimed.add(bodyKey(character)));
        const cast = { ...found, characters };

        let clips: GltfAsset;
        let set: CharacterSet;
        try {
          clips = await this.gltf(cast.animations, files);
          set = readCharacterSet(clips.scene.userData);
        } catch (err) {
          // Said once per game rather than once per body: every body of a game
          // plays the one clip set, so they would all fail with this message.
          skipped += cast.characters.length;
          console.warn(`! ${game}'s player clips will not load, so none of its ${cast.characters.length} bodies can be shot: ${reason(err)}`);
          return;
        }

        await Promise.all(
          cast.characters.map(async (character) => {
            try {
              loaded.set(bodyKey(character), await this.build(character.body.game as GameKey, character, set, clips, files));
            } catch (err) {
              skipped += 1;
              console.warn(`! body ${bodyKey(character)} will not load, so nobody wearing it can be shot: ${reason(err)}`);
            }
          }),
        );
      }),
    );

    this.bodies = loaded;
    this.actors = await this.loadActors(files);

    if (loaded.size === 0) {
      console.warn("! no player bodies loaded: a shot here can hit nobody, which reads as a netcode fault rather than as an empty catalogue");
      return;
    }
    console.log(`bodies: ${loaded.size} ready in ${Date.now() - started}ms${skipped > 0 ? `, ${skipped} skipped` : ""}`);
  }

  /**
   * Every actor kind that names a body. A kind whose files will not load is shot
   * as its capsule, and said so once: never fatal, as a player's body is not.
   */
  private async loadActors(files: Files): Promise<Map<ActorKindId, LoadedActorBody>> {
    const loaded = new Map<ActorKindId, LoadedActorBody>();
    await Promise.all(
      ACTOR_KINDS.map(async (kind) => {
        if (!kind.body) {
          return;
        }
        try {
          const body = await this.buildActor(kind, kind.body, files);
          if (body) {
            loaded.set(kind.id, body);
          }
        } catch (err) {
          console.warn(`! actor kind ${kind.id}'s body will not load, so it is shot as its capsule: ${reason(err)}`);
        }
      }),
    );
    return loaded;
  }

  /** Every body of a kind's catalogue creature, or undefined where the catalogue holds none. */
  private async buildActor(kind: ActorKindDef, ref: NonNullable<ActorKindDef["body"]>, files: Files): Promise<LoadedActorBody | undefined> {
    const assets = actorAssetsFor(ref, this.weapons.catalogue);
    if (!assets) {
      return undefined;
    }
    const [clips, boxes, ...bodies] = await Promise.all([
      this.gltf(assets.clips, files),
      this.hitboxes(assets.hitboxes),
      ...assets.bodies.map((b) => this.gltf(b, files)),
    ]);
    const rigs = bodies.map((body, i) => {
      const rig = buildActorRig(`${kind.id}/${i}`, assets, clips.clips, body);
      const bound = new BoundHitboxes(rig, boxes);
      if (bound.size === 0) {
        throw new Error(`none of its ${boxes.length} box(es) name a bone body ${assets.bodies[i]!.file} has`);
      }
      return { rig, poser: new ActorPoser(rig), boxes: bound };
    });
    return { kind: kind.id, bodies: rigs };
  }

  /** One body: the files a cast names for it, plus the boxes derived from its own skin weights. */
  private async build(game: GameKey, character: CastCharacter, set: CharacterSet, clips: GltfAsset, files: Files): Promise<LoadedBody> {
    // Beside the body GLB, in the same entry, written by `scripts.cod hitboxes`.
    const sidecar = { ...character.body, file: `${character.id}.hitboxes.json` };
    const [body, head, weapon, boxes] = await Promise.all([
      this.gltf(character.body, files),
      this.optional(character.head, files),
      this.optional(character.weapon, files),
      this.hitboxes(sidecar),
    ]);

    const rig = buildCharacterRig(character.id, set, clips.clips, body, head, weapon);
    const bound = new BoundHitboxes(rig, boxes);
    // A body whose boxes name bones it does not have is one bullets pass through.
    // Refused here, where it is one line in the log, rather than in a match.
    if (bound.size === 0) {
      throw new Error(`none of its ${boxes.length} box(es) name a bone this body has`);
    }
    return { id: character.id, game, rig, poser: new CharacterPoser(rig), boxes: bound };
  }

  private optional(ref: CatalogRef | undefined, files: Files): Promise<GltfAsset | undefined> {
    return ref === undefined ? Promise.resolve(undefined) : this.gltf(ref, files);
  }

  /**
   * One GLB, fetched at most once per load.
   *
   * Keyed by the path a client would fetch it at, because a game's clip set and
   * its world weapon serve every body of that game: without this, one load would
   * parse the same 5 MB of clips fifteen times over.
   */
  private gltf(ref: CatalogRef, files: Files): Promise<GltfAsset> {
    const key = castFilePath(ref);
    const existing = files.get(key);
    if (existing) {
      return existing;
    }
    const loading = this.parse(ref);
    files.set(key, loading);
    return loading;
  }

  private async parse(ref: CatalogRef): Promise<GltfAsset> {
    const bytes = await this.file(ref);
    // parseAsync wants an ArrayBuffer of exactly the glb; a Uint8Array off the
    // wire may be a view into a larger buffer.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const gltf = await loader.parseAsync(buffer, "");
    // `clips`, not `animations`: `GltfAsset` is the shape the client's AssetStore
    // hands `buildCharacterRig`, and the loader's own result is not it.
    return { scene: gltf.scene, clips: gltf.animations };
  }

  /** `readHitboxes` throws on anything it does not understand; `build`'s caller catches it. */
  private async hitboxes(ref: CatalogRef): Promise<Hitbox[]> {
    return readHitboxes(JSON.parse(new TextDecoder().decode(await this.file(ref))));
  }

  /** The route is public, so this needs no token — but it is still this process's one link out. */
  private file(ref: CatalogRef): Promise<Uint8Array> {
    return this.api.client.catalogFile({ kind: ref.kind, game: ref.game, id: ref.id, rest: ref.file });
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
