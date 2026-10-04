// A digest of what a world's ids mean, for the join handshake.
//
// Entity ids are positional (`ResolvedObject.id` counts in declaration order),
// and so is a solid's bit in the snapshot's presence bitset. Two ends holding
// different world text would address different things by the same number and
// say nothing. This is what they compare instead: every id-bearing node's id,
// name, tags and what it is, in order. A game server refuses a join whose
// hash disagrees (docs/engine/scripting.md, "Two things to know").
//
// FNV-1a, as `catalogHash` is: it only has to catch two ends disagreeing, not
// an adversary.

import type { ResolvedWorld } from "../dsl/resolved.js";

interface Addressed {
  id: number;
  name?: string;
  tags: readonly string[];
}

/** One node as the hash reads it. Positions are left out: they move nothing an id names. */
function line(kind: string, node: Addressed, what = ""): string {
  return `${kind}|${node.id}|${node.name ?? ""}|${node.tags.join(",")}|${what}\n`;
}

export function worldHash(world: ResolvedWorld): string {
  let text = `${world.name}\n`;
  for (const object of world.topLevelObjects) {
    text += line("o", object, `${object.asset ?? ""}|${object.modes?.join(",") ?? ""}`);
  }
  for (const trigger of world.triggers) {
    text += line("t", trigger, trigger.target ?? "");
  }
  for (const mantle of world.mantles) {
    text += line("m", mantle);
  }
  for (const ladder of world.ladders) {
    text += line("l", ladder);
  }
  for (const effect of world.effects) {
    text += line("e", effect);
  }
  for (const sound of world.sounds) {
    text += line("s", sound);
  }
  for (const point of world.points) {
    text += line("p", point, point.target ?? "");
  }
  for (const solid of world.solids) {
    text += line("d", solid, `${solid.part}|${solid.modes?.join(",") ?? ""}`);
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
