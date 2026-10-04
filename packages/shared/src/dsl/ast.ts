// Abstract syntax tree for the .world DSL.
//
// Every node and value carries a `span` back into the source text so that
// diagnostics (parse errors, schema violations, unresolved references) can
// point at the exact offending characters. This is what makes the DSL
// self-correctable by an AI: it can read `line 14, col 3` and fix its own
// output without a human in the loop.

export interface Position {
  /** Path of the file this position is in, as given to loadWorld/parseWorldFile. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
  /** 0-based absolute character offset into the source string. */
  offset: number;
}

export interface Span {
  start: Position;
  end: Position;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export interface NumberValue {
  kind: "number";
  value: number;
  /** Raw unit suffix as written, e.g. "cm", "deg". Undefined = bare number. */
  unit?: string;
  span: Span;
}

export interface StringValue {
  kind: "string";
  value: string;
  span: Span;
}

export interface ColorValue {
  kind: "color";
  /** Normalized lowercase hex including leading '#', e.g. "#8a5a2b". */
  value: string;
  span: Span;
}

export interface BoolValue {
  kind: "bool";
  value: boolean;
  span: Span;
}

/**
 * A bare identifier or dotted path, e.g. `oak`, `living.south`, `table.top`.
 * A single-segment path is used both as a plain identifier value (material
 * names, enum-like words) and as a same-scope reference; the resolver
 * decides which based on context.
 */
export interface RefValue {
  kind: "ref";
  path: string[];
  span: Span;
}

export type Value = NumberValue | StringValue | ColorValue | BoolValue | RefValue;

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface PropertyNode {
  kind: "property";
  key: string;
  keySpan: Span;
  /** One or more space-separated values, e.g. `size: 6 4.5` -> two numbers. */
  values: Value[];
  span: Span;
}

export interface IncludeNode {
  kind: "include";
  path: string;
  pathSpan: Span;
  span: Span;
}

export interface ObjectNode {
  kind: "node";
  type: string;
  typeSpan: Span;
  name?: string;
  nameSpan?: Span;
  body: Statement[];
  span: Span;
}

export type Statement = PropertyNode | IncludeNode | ObjectNode;

export interface WorldFile {
  statements: Statement[];
  span: Span;
  source: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// Small helpers used by schema.ts / resolve.ts
// ---------------------------------------------------------------------------

export function isObjectNode(s: Statement): s is ObjectNode {
  return s.kind === "node";
}

export function isPropertyNode(s: Statement): s is PropertyNode {
  return s.kind === "property";
}

export function isIncludeNode(s: Statement): s is IncludeNode {
  return s.kind === "include";
}
