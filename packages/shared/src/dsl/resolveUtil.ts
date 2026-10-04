// Small helpers shared by the resolvers: reading typed values out of AST
// property nodes, and a little vector maths.

import type { ObjectNode, PropertyNode, Statement, Value } from "./ast.js";
import { isPropertyNode } from "./ast.js";
import type { Vec3 } from "./resolved.js";

/** Where a resolver reports diagnostics. */
export interface Reporter {
  err(message: string, span: Statement["span"], code?: string): void;
  warn(message: string, span: Statement["span"], code?: string): void;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** Rotate a vector around the Y axis by `theta` radians (three.js convention). */
export function rotateY(v: Vec3, theta: number): Vec3 {
  // A copy even at rest: the result belongs to the caller, and returning `v`
  // itself would let them mutate the vector they passed in.
  if (theta === 0) {
    return { ...v };
  }
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

export function findProp(node: ObjectNode, key: string): PropertyNode | undefined {
  let found: PropertyNode | undefined;
  for (const s of node.body) {
    if (isPropertyNode(s) && s.key === key) {
      found = s;
    } // last one wins (schema already warned)
  }
  return found;
}

export function numbersOf(prop: PropertyNode | undefined, convert: (v: number, unit?: string) => number): number[] {
  if (!prop) {
    return [];
  }
  return prop.values.map((v: Value) => (v.kind === "number" ? convert(v.value, v.unit) : 0));
}

export function vecOf(prop: PropertyNode | undefined, convert: (v: number, unit?: string) => number, fallback: [number, number, number] = [0, 0, 0]): Vec3 {
  const n = numbersOf(prop, convert);
  return { x: n[0] ?? fallback[0], y: n[1] ?? fallback[1], z: n[2] ?? fallback[2] };
}

/**
 * A single `rotate:` value means yaw — rotation around the vertical (Y)
 * axis — since that covers the overwhelming majority of authored rotations
 * (facing a piece of furniture a certain way). Three values are a full XYZ
 * euler rotation for the rare case that needs it.
 */
export function rotationOf(prop: PropertyNode | undefined, convert: (v: number, unit?: string) => number): Vec3 {
  const n = numbersOf(prop, convert);
  if (n.length === 1) {
    return vec3(0, n[0]!, 0);
  }
  return vec3(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
}

export function refOf(prop: PropertyNode | undefined): string[] | undefined {
  const v = prop?.values[0];
  return v?.kind === "ref" ? v.path : undefined;
}

export function colorOf(prop: PropertyNode | undefined, fallback: string): string {
  const v = prop?.values[0];
  return v?.kind === "color" ? v.value : fallback;
}

export function boolOf(prop: PropertyNode | undefined, fallback: boolean): boolean {
  const v = prop?.values[0];
  return v?.kind === "bool" ? v.value : fallback;
}

export function stringOf(prop: PropertyNode | undefined, fallback?: string): string | undefined {
  const v = prop?.values[0];
  return v?.kind === "string" ? v.value : fallback;
}

/** Every string value of a multi-valued property, in order. Empty when absent. */
export function stringsOf(prop: PropertyNode | undefined): string[] {
  return prop ? prop.values.flatMap((v) => (v.kind === "string" ? [v.value] : [])) : [];
}

/** A `mode:` list. Undefined when absent, which means every mode — not the same as none. */
export function modesOf(prop: PropertyNode | undefined): string[] | undefined {
  return prop ? stringsOf(prop) : undefined;
}

/** With no `fallback`, an absent property reads as undefined: an enum that is genuinely optional. */
export function enumOf(prop: PropertyNode | undefined): string | undefined;
export function enumOf(prop: PropertyNode | undefined, fallback: string): string;
export function enumOf(prop: PropertyNode | undefined, fallback?: string): string | undefined {
  const v = prop?.values[0];
  return v?.kind === "ref" && v.path.length === 1 ? v.path[0]! : fallback;
}
