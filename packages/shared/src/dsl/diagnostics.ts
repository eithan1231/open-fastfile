// Diagnostic formatting shared by the parser, schema validator, resolver,
// the in-browser error screen, and the headless `pnpm check` CLI.
//
// The goal is that every error an AI ever sees while authoring a .world file
// looks like a compiler error: file:line:col, the offending source line, a
// caret under the exact span, and — for typos in keys/types — a "did you
// mean" suggestion. That is the whole feedback loop the AI iterates against.

import type { Span } from "./ast.js";

export type Severity = "error" | "warning";

export interface Diagnostic {
  message: string;
  span: Span;
  severity: Severity;
  /** Optional short code, e.g. "unknown-property". Useful for tests. */
  code?: string;
}

export function error(message: string, span: Span, code?: string): Diagnostic {
  return { message, span, severity: "error", code };
}

export function warning(message: string, span: Span, code?: string): Diagnostic {
  return { message, span, severity: "warning", code };
}

export interface FormatOptions {
  filename?: string;
  /** ANSI color the output. Off by default so it's safe for file/browser sinks. */
  color?: boolean;
}

/**
 * Render one diagnostic as a compiler-style excerpt:
 *
 *   dome-mw3/props.world:14:5: error: unknown property "colide" on model (did you mean "collide"?)
 *      14 |     wdith: 2.1
 *          |     ^^^^^
 */
export function formatDiagnostic(source: string, diag: Diagnostic, opts: FormatOptions = {}): string {
  return formatWithLines(source.split("\n"), diag, opts);
}

/** The body of `formatDiagnostic`, over a source already split into lines. */
function formatWithLines(lines: string[], diag: Diagnostic, opts: FormatOptions): string {
  const { start, end } = diag.span;
  const lineText = lines[start.line - 1] ?? "";
  const gutter = String(start.line);
  const pad = " ".repeat(gutter.length);

  const sameLine = start.line === end.line;
  const caretStart = start.col - 1;
  const caretLen = sameLine ? Math.max(1, end.col - start.col) : Math.max(1, lineText.length - caretStart);

  const location = `${opts.filename ?? start.file}:${start.line}:${start.col}`;
  const header = `${location}: ${diag.severity}: ${diag.message}`;
  const codeLine = `${gutter} | ${lineText}`;
  const caretLine = `${pad} | ${" ".repeat(caretStart)}${"^".repeat(caretLen)}`;

  return [header, codeLine, caretLine].join("\n");
}

/**
 * Format diagnostics that may span several files (after `include`
 * expansion) — looks up each diagnostic's source text by the file recorded
 * on its own span, so a formatted line always matches the file it points at.
 */
export function formatDiagnosticsAcrossFiles(sources: Record<string, string>, diags: Diagnostic[]): string {
  // Split each file once, not once per diagnostic: a generated `props.world` is
  // megabytes, and a bad export reports hundreds of diagnostics against it.
  const lines = new Map<string, string[]>();
  const linesFor = (file: string): string[] => {
    let split = lines.get(file);
    if (!split) {
      lines.set(file, (split = (sources[file] ?? "").split("\n")));
    }
    return split;
  };
  return diags.map((d) => formatWithLines(linesFor(d.span.start.file), d, {})).join("\n\n");
}

export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

// ---------------------------------------------------------------------------
// "Did you mean" suggestions for unknown node types / property keys
// ---------------------------------------------------------------------------

/** Classic iterative Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const al = a.length;
  const bl = b.length;
  if (al === 0) {
    return bl;
  }
  if (bl === 0) {
    return al;
  }

  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // Both rows are filled for every index before they are read: `prev` by the
      // seed loop or the previous iteration, `curr` from 0 upwards by this one.
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl]!;
}

/**
 * Find the closest candidate to `name` within a reasonable edit-distance
 * budget (scaled to word length so short words don't match everything).
 */
export function suggestSimilar(name: string, candidates: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  const maxDist = lower.length <= 4 ? 1 : lower.length <= 7 ? 2 : 3;

  for (const candidate of candidates) {
    const dist = levenshtein(lower, candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return bestDist <= maxDist ? best : undefined;
}

export function didYouMean(name: string, candidates: Iterable<string>): string {
  const suggestion = suggestSimilar(name, candidates);
  return suggestion ? ` (did you mean "${suggestion}"?)` : "";
}
