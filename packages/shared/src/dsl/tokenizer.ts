// Hand-written tokenizer for the .world DSL.
//
// Deliberately simple: no regex-based whole-line scanning, so column numbers
// stay exact for diagnostics. Braces are the only structural whitespace-
// insensitive delimiters; newlines matter only insofar as the parser uses
// "same source line" to decide where a space-separated value list ends.

import type { Position } from "./ast.js";
import type { Diagnostic } from "./diagnostics.js";
import { error } from "./diagnostics.js";

export type TokenType = "ident" | "number" | "string" | "color" | "lbrace" | "rbrace" | "colon" | "dot" | "comma" | "eof";

export interface Token {
  type: TokenType;
  /** Raw text as written (identifiers, keywords, punctuation). */
  text: string;
  /** Parsed numeric value, only for type "number". */
  numValue?: number;
  /** Unit suffix, only for type "number" (e.g. "cm", "deg"). */
  unit?: string;
  /** Decoded string contents (escapes resolved), only for type "string". */
  strValue?: string;
  /** Normalized "#rrggbb"-style text, only for type "color". */
  colorValue?: string;
  start: Position;
  end: Position;
}

const UNIT_SUFFIXES = ["mm", "cm", "ft", "in", "deg", "rad", "m"] as const;

// Character classes by code, not by regex over a one-character string: a
// generated `props.world` is megabytes, and these run on every character of it.
// `charCodeAt` past the end gives NaN, which fails every comparison below —
// the same answer the old `source[i] ?? ""` gave.
const enum Ch {
  Tab = 9,
  Newline = 10,
  Return = 13,
  Space = 32,
  Quote = 34,
  Hash = 35,
  Comma = 44,
  Minus = 45,
  Dot = 46,
  Slash = 47,
  Zero = 48,
  Nine = 57,
  Colon = 58,
  UpperA = 65,
  UpperF = 70,
  UpperZ = 90,
  Backslash = 92,
  Underscore = 95,
  LowerA = 97,
  LowerF = 102,
  LowerZ = 122,
  LBrace = 123,
  RBrace = 125,
}

function isIdentStart(c: number): boolean {
  return (c >= Ch.UpperA && c <= Ch.UpperZ) || (c >= Ch.LowerA && c <= Ch.LowerZ) || c === Ch.Underscore;
}
function isIdentPart(c: number): boolean {
  return isIdentStart(c) || isDigit(c) || c === Ch.Minus;
}
function isDigit(c: number): boolean {
  return c >= Ch.Zero && c <= Ch.Nine;
}
function isHex(c: number): boolean {
  return isDigit(c) || (c >= Ch.LowerA && c <= Ch.LowerF) || (c >= Ch.UpperA && c <= Ch.UpperF);
}

export function tokenize(source: string, file = "<world>"): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];

  let i = 0;
  let line = 1;
  let col = 1;
  const len = source.length;

  function pos(): Position {
    return { file, line, col, offset: i };
  }

  function advance(): string {
    const ch = source[i]!;
    i++;
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  }

  function peek(offset = 0): string {
    return source[i + offset] ?? "";
  }

  /** The character code at `i + offset`; NaN past the end. */
  function code(offset = 0): number {
    return source.charCodeAt(i + offset);
  }

  /** Take `n` characters known to hold no newline, as one column jump. */
  function skip(n: number): void {
    i += n;
    col += n;
  }

  while (i < len) {
    const c0 = code();

    // Whitespace (not newline-significant at the token level).
    if (c0 === Ch.Space || c0 === Ch.Tab || c0 === Ch.Return || c0 === Ch.Newline) {
      advance();
      continue;
    }

    const startPos = pos();

    // Line comments: "//"
    if (c0 === Ch.Slash && code(1) === Ch.Slash) {
      while (i < len && code() !== Ch.Newline) {
        skip(1);
      }
      continue;
    }

    // Punctuation
    if (c0 === Ch.LBrace) {
      skip(1);
      tokens.push({ type: "lbrace", text: "{", start: startPos, end: pos() });
      continue;
    }
    if (c0 === Ch.RBrace) {
      skip(1);
      tokens.push({ type: "rbrace", text: "}", start: startPos, end: pos() });
      continue;
    }
    if (c0 === Ch.Colon) {
      skip(1);
      tokens.push({ type: "colon", text: ":", start: startPos, end: pos() });
      continue;
    }
    if (c0 === Ch.Comma) {
      skip(1);
      tokens.push({ type: "comma", text: ",", start: startPos, end: pos() });
      continue;
    }

    // Strings
    if (c0 === Ch.Quote) {
      advance();
      let value = "";
      let closed = false;
      while (i < len) {
        const c = code();
        if (c === Ch.Quote) {
          advance();
          closed = true;
          break;
        }
        if (c === Ch.Newline) {
          break;
        } // unterminated — stop at line end
        if (c === Ch.Backslash) {
          advance();
          const esc = peek();
          if (esc === "n") {
            value += "\n";
          } else if (esc === "t") {
            value += "\t";
          } else if (esc === '"' || esc === "\\") {
            value += esc;
          } else {
            value += esc;
          } // unknown escape: pass through literally
          if (i < len) {
            advance();
          }
          continue;
        }
        value += advance();
      }
      const endPos = pos();
      if (!closed) {
        diagnostics.push(error("unterminated string literal", { start: startPos, end: endPos }, "unterminated-string"));
      }
      tokens.push({ type: "string", text: source.slice(startPos.offset, endPos.offset), strValue: value, start: startPos, end: endPos });
      continue;
    }

    // Colors: "#" + hex digits. Fall back to a "#" line comment if the
    // hex run doesn't land on a valid color length (3, 4, 6, or 8).
    if (c0 === Ch.Hash) {
      const from = i;
      const fromCol = col;
      skip(1); // consume '#'
      while (i < len && isHex(code())) {
        skip(1);
      }
      const hexLength = i - from - 1;
      // `\s` is wider than the four spaces the tokenizer itself skips, so the
      // boundary stays a regex; it runs once per literal, not per character.
      const boundary = i >= len || /[\s,}]/.test(peek());
      if (boundary && (hexLength === 3 || hexLength === 4 || hexLength === 6 || hexLength === 8)) {
        const text = source.slice(from, i);
        const endPos = pos();
        tokens.push({
          type: "color",
          text,
          colorValue: text.toLowerCase(),
          start: startPos,
          end: endPos,
        });
        continue;
      }
      // Not a valid color literal — treat the rest of the line as a comment.
      i = from;
      col = fromCol;
      while (i < len && code() !== Ch.Newline) {
        skip(1);
      }
      continue;
    }

    // Numbers: optional leading '-', digits, optional '.', digits, optional unit suffix.
    if (isDigit(c0) || (c0 === Ch.Minus && isDigit(code(1)))) {
      const from = i;
      if (c0 === Ch.Minus) {
        skip(1);
      }
      while (i < len && isDigit(code())) {
        skip(1);
      }
      if (code() === Ch.Dot && isDigit(code(1))) {
        skip(1); // '.'
        while (i < len && isDigit(code())) {
          skip(1);
        }
      }
      const numValue = Number(source.slice(from, i));

      let unit: string | undefined;
      for (const candidate of UNIT_SUFFIXES) {
        if (source.startsWith(candidate, i)) {
          // Don't swallow the start of a longer identifier, e.g. "4min".
          if (!isIdentPart(source.charCodeAt(i + candidate.length))) {
            unit = candidate;
            skip(candidate.length);
            break;
          }
        }
      }

      const endPos = pos();
      tokens.push({
        type: "number",
        text: source.slice(startPos.offset, endPos.offset),
        numValue,
        unit,
        start: startPos,
        end: endPos,
      });
      continue;
    }

    // Identifiers / keywords
    if (isIdentStart(c0)) {
      const from = i;
      skip(1);
      while (i < len && isIdentPart(code())) {
        skip(1);
      }
      const endPos = pos();
      tokens.push({ type: "ident", text: source.slice(from, i), start: startPos, end: endPos });
      continue;
    }

    if (c0 === Ch.Dot) {
      skip(1);
      tokens.push({ type: "dot", text: ".", start: startPos, end: pos() });
      continue;
    }

    // Unknown character: report and skip it so the rest of the file still parses.
    const unexpected = peek();
    advance();
    diagnostics.push(error(`unexpected character "${unexpected}"`, { start: startPos, end: pos() }, "unexpected-char"));
  }

  const eofPos = pos();
  tokens.push({ type: "eof", text: "", start: eofPos, end: eofPos });

  return { tokens, diagnostics };
}
