// Expands `include "path"` statements into a single merged statement list.
//
// Deliberately isomorphic (no node:fs / node:path): the caller supplies
// every file's source as a plain `{ path: contents }` map — built by walking
// a directory for the headless CLI, or fetched in one request by the Vite
// dev plugin for the browser — and this module only does string path math
// and parsing. That's what lets the exact same code validate a world in
// Node and rebuild it live in the browser.
//
// Every position in the AST carries its own originating file (see
// ast.ts's Position), so diagnostics produced later by schema validation or
// the resolver — which see one merged statement list with no notion of
// "current file" — still point at the right file automatically.

import type { Statement, WorldFile } from "./ast.js";
import { isIncludeNode } from "./ast.js";
import type { Diagnostic } from "./diagnostics.js";
import { error } from "./diagnostics.js";
import { parseWorldFile } from "./parser.js";

export interface LoadResult {
  /** Include-expanded top-level statements, ready for schema validation + resolve. */
  statements: Statement[];
  diagnostics: Diagnostic[];
}

/** Minimal POSIX-style path join + normalize — no node:path dependency. */
export function joinPath(baseDir: string, relative: string): string {
  const combined = relative.startsWith("/") ? relative : `${baseDir}/${relative}`;
  const parts = combined.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else {
        out.push("..");
      }
    } else {
      out.push(part);
    }
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function loadWorld(entryPath: string, sources: Record<string, string>): LoadResult {
  const diagnostics: Diagnostic[] = [];
  const includedOnce = new Set<string>([entryPath]);

  function parseFile(path: string): WorldFile {
    const source = sources[path]!;
    const { ast, diagnostics: fileDiags } = parseWorldFile(source, path);
    diagnostics.push(...fileDiags);
    return ast;
  }

  // One stack for the whole expansion, pushed and popped: copying it per level
  // allocated a new array for every included file.
  function expand(path: string, stack: string[]): Statement[] {
    const ast = parseFile(path);
    const dir = dirOf(path);
    stack.push(path);
    const out: Statement[] = [];

    for (const stmt of ast.statements) {
      if (!isIncludeNode(stmt)) {
        out.push(stmt);
        continue;
      }

      const targetPath = joinPath(dir, stmt.path);
      if (stack.includes(targetPath)) {
        diagnostics.push(error(`circular include: ${[...stack, targetPath].join(" -> ")}`, stmt.pathSpan, "circular-include"));
        continue;
      }
      if (includedOnce.has(targetPath)) {
        continue;
      } // a diamond include, already expanded elsewhere — header-guard style
      if (sources[targetPath] === undefined) {
        diagnostics.push(error(`included file not found: "${targetPath}"`, stmt.pathSpan, "include-not-found"));
        continue;
      }

      includedOnce.add(targetPath);
      out.push(...expand(targetPath, stack));
    }
    stack.pop();
    return out;
  }

  if (sources[entryPath] === undefined) {
    diagnostics.push(
      error(
        `world file not found: "${entryPath}"`,
        { start: { file: entryPath, line: 1, col: 1, offset: 0 }, end: { file: entryPath, line: 1, col: 1, offset: 0 } },
        "entry-not-found",
      ),
    );
    return { statements: [], diagnostics };
  }

  const statements = expand(entryPath, []);
  return { statements, diagnostics };
}
