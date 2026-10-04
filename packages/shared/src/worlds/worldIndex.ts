// Addressing a world's objects at runtime, by id, name or tag.
//
// A pure derivation over `ResolvedWorld` — no scene graph, no three.js — because
// the server needs it more than the client does: it holds a `ResolvedWorld` and a
// collision BVH and has no scene graph at all. The client keeps one beside its
// built scene (`BuiltScene.nodes` maps the same ids to three.js objects).

import type { EntityId, ResolvedObject, ResolvedPoint, ResolvedSolid, ResolvedTrigger, ResolvedWorld } from "../dsl/resolved.js";
import { UNASSIGNED_ENTITY_ID } from "../dsl/resolved.js";

/** One kind of world node that has no geometry, by name and by each of its tags. */
export interface KindIndex<T> {
  /** Declaration order, as the world lists them. */
  readonly all: readonly T[];
  /** Authored `name:`. The later of two nodes sharing one wins, as for objects. */
  readonly byName: ReadonlyMap<string, T>;
  /** Every node carrying the tag, in declaration order. A node with several tags is under each. */
  readonly byTag: ReadonlyMap<string, readonly T[]>;
}

export interface WorldIndex {
  /** Dense and id-ordered: `objects[id].id === id`. */
  readonly objects: readonly ResolvedObject[];
  /** Authored `name:`, which the DSL already keeps unique across a world's files. */
  readonly byName: ReadonlyMap<string, EntityId>;
  /** A group handle, deliberately *not* unique: every `explodable_barrel` at once. */
  readonly byTag: ReadonlyMap<string, readonly EntityId[]>;
  /** The world's volumes. */
  readonly triggers: KindIndex<ResolvedTrigger>;
  /** The world's tagged positions. */
  readonly points: KindIndex<ResolvedPoint>;
  /** The collision parts that can be absent. */
  readonly solids: KindIndex<ResolvedSolid>;
}

/** Every object in the world, in declaration order. */
export function worldObjects(world: ResolvedWorld): ResolvedObject[] {
  return [...world.topLevelObjects];
}

/** Append `value` under each of `tags`. */
function addTags<V>(byTag: Map<string, V[]>, tags: readonly string[], value: V): void {
  for (const tag of tags) {
    const tagged = byTag.get(tag);
    if (tagged) {
      tagged.push(value);
    } else {
      byTag.set(tag, [value]);
    }
  }
}

function indexKind<T extends { name?: string; tags: readonly string[] }>(all: readonly T[]): KindIndex<T> {
  const byName = new Map<string, T>();
  const byTag = new Map<string, T[]>();
  for (const node of all) {
    if (node.name !== undefined) {
      byName.set(node.name, node);
    }
    addTags(byTag, node.tags, node);
  }
  return { all, byName, byTag };
}

export function indexWorld(world: ResolvedWorld): WorldIndex {
  const objects = worldObjects(world);
  const byName = new Map<string, EntityId>();
  const byTag = new Map<string, EntityId[]>();

  // Sorting by id rather than trusting the walk order keeps the dense invariant
  // true of the *ids*, not of however `worldObjects` happened to concatenate.
  objects.sort((a, b) => a.id - b.id);

  for (const object of objects) {
    if (object.id === UNASSIGNED_ENTITY_ID) {
      // Emission is the only place an id is spent, so an object that reached a
      // world without one is a resolver bug, not bad input.
      throw new Error(`object "${object.name ?? object.asset ?? "<anonymous>"}" reached the world with no id`);
    }
    if (object.name !== undefined) {
      byName.set(object.name, object.id);
    }
    addTags(byTag, object.tags, object.id);
  }

  return {
    objects,
    byName,
    byTag,
    triggers: indexKind(world.triggers),
    points: indexKind(world.points),
    solids: indexKind(world.solids),
  };
}

/** The object with this id, or undefined for a dynamic (server-minted) one. */
export function objectAt(index: WorldIndex, id: EntityId): ResolvedObject | undefined {
  return index.objects[id]?.id === id ? index.objects[id] : undefined;
}
