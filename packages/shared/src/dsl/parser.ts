// Recursive-descent parser for the .world DSL.
//
// Design choices that matter for an AI author:
//  - Errors are collected, not thrown. A single `pnpm check` run should show
//    every syntax problem in the file, not just the first one.
//  - A property's value list ends at a comma, `}`, EOF, or a line break —
//    whichever comes first — so `size: 6 4.5` is one vector and the next
//    property never gets swallowed into it. Same-line properties must be
//    comma-separated (see worlds/AUTHORING.md).

import type {
  BoolValue,
  ColorValue,
  IncludeNode,
  NumberValue,
  ObjectNode,
  PropertyNode,
  RefValue,
  Span,
  Statement,
  StringValue,
  Value,
  WorldFile,
} from "./ast.js";
import type { Diagnostic } from "./diagnostics.js";
import { error } from "./diagnostics.js";
import { tokenize, type Token, type TokenType } from "./tokenizer.js";

const BOOL_WORDS: Record<string, boolean> = { true: true, on: true, false: false, off: false };

class Parser {
  private pos = 0;
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly tokens: Token[]) {}

  private current(): Token {
    return this.tokens[this.pos]!;
  }

  private peekAhead(offset: number): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private advance(): Token {
    const t = this.current();
    if (t.type !== "eof") {
      this.pos++;
    }
    return t;
  }

  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  /** Skip forward until we reach a plausible statement boundary, to keep collecting diagnostics. */
  private recover(): void {
    while (!this.check("eof") && !this.check("comma") && !this.check("rbrace")) {
      this.advance();
    }
  }

  parseFile(): Statement[] {
    return this.parseStatements(false);
  }

  private parseStatements(stopAtRbrace: boolean): Statement[] {
    const statements: Statement[] = [];
    for (;;) {
      while (this.check("comma")) {
        this.advance();
      }

      if (this.check("eof")) {
        break;
      }
      if (stopAtRbrace && this.check("rbrace")) {
        break;
      }

      if (this.check("ident")) {
        if (this.current().text === "include") {
          statements.push(this.parseInclude());
        } else if (this.peekAhead(1).type === "colon") {
          statements.push(this.parseProperty());
        } else {
          statements.push(this.parseNode());
        }
        continue;
      }

      const bad = this.current();
      this.diagnostics.push(
        error(`expected a property, node, or "include", found ${describeToken(bad)}`, { start: bad.start, end: bad.end }, "unexpected-token"),
      );
      this.advance();
      this.recover();
    }
    return statements;
  }

  private parseInclude(): IncludeNode {
    const kw = this.advance(); // 'include'
    if (!this.check("string")) {
      const bad = this.current();
      this.diagnostics.push(
        error(`expected a quoted path after "include", found ${describeToken(bad)}`, { start: bad.start, end: bad.end }, "expected-string"),
      );
      this.recover();
      return {
        kind: "include",
        path: "",
        pathSpan: { start: bad.start, end: bad.end },
        span: { start: kw.start, end: bad.end },
      };
    }
    const strTok = this.advance();
    return {
      kind: "include",
      path: strTok.strValue ?? "",
      pathSpan: { start: strTok.start, end: strTok.end },
      span: { start: kw.start, end: strTok.end },
    };
  }

  private parseProperty(): PropertyNode {
    const keyTok = this.advance(); // ident
    const keySpan: Span = { start: keyTok.start, end: keyTok.end };
    let end = keyTok.end;

    if (!this.check("colon")) {
      const bad = this.current();
      this.diagnostics.push(
        error(`expected ":" after property "${keyTok.text}", found ${describeToken(bad)}`, { start: bad.start, end: bad.end }, "expected-colon"),
      );
      return { kind: "property", key: keyTok.text, keySpan, values: [], span: { start: keyTok.start, end } };
    }
    const colonTok = this.advance();
    end = colonTok.end;

    const values: Value[] = [];
    if (canStartValue(this.current())) {
      const first = this.parseValue();
      if (first) {
        values.push(first);
        end = first.span.end;
        const firstLine = first.span.start.line;
        while (canStartValue(this.current()) && this.current().start.line === firstLine) {
          const v = this.parseValue();
          if (!v) {
            break;
          }
          values.push(v);
          end = v.span.end;
        }
      }
    } else {
      const bad = this.current();
      this.diagnostics.push(
        error(`expected a value after "${keyTok.text}:", found ${describeToken(bad)}`, { start: bad.start, end: bad.end }, "expected-value"),
      );
    }

    return { kind: "property", key: keyTok.text, keySpan, values, span: { start: keyTok.start, end } };
  }

  private parseValue(): Value | undefined {
    const tok = this.current();
    const span: Span = { start: tok.start, end: tok.end };

    if (tok.type === "number") {
      this.advance();
      const v: NumberValue = { kind: "number", value: tok.numValue ?? 0, unit: tok.unit, span };
      return v;
    }
    if (tok.type === "string") {
      this.advance();
      const v: StringValue = { kind: "string", value: tok.strValue ?? "", span };
      return v;
    }
    if (tok.type === "color") {
      this.advance();
      const v: ColorValue = { kind: "color", value: tok.colorValue ?? tok.text, span };
      return v;
    }
    if (tok.type === "ident") {
      if (tok.text in BOOL_WORDS) {
        this.advance();
        const v: BoolValue = { kind: "bool", value: BOOL_WORDS[tok.text]!, span };
        return v;
      }
      // Ref / bare identifier: IDENT ("." IDENT)*
      const path = [this.advance().text];
      let end = tok.end;
      while (this.check("dot")) {
        this.advance();
        if (!this.check("ident")) {
          const bad = this.current();
          this.diagnostics.push(
            error(`expected an identifier after "." in reference, found ${describeToken(bad)}`, { start: bad.start, end: bad.end }, "expected-ident"),
          );
          break;
        }
        const seg = this.advance();
        path.push(seg.text);
        end = seg.end;
      }
      const v: RefValue = { kind: "ref", path, span: { start: span.start, end } };
      return v;
    }

    return undefined;
  }

  private parseNode(): ObjectNode {
    const typeTok = this.advance(); // ident
    const typeSpan: Span = { start: typeTok.start, end: typeTok.end };
    let end = typeTok.end;

    let name: string | undefined;
    let nameSpan: Span | undefined;
    if (this.check("ident") && this.current().start.line === typeTok.start.line) {
      const nameTok = this.advance();
      name = nameTok.text;
      nameSpan = { start: nameTok.start, end: nameTok.end };
      end = nameTok.end;
    }

    let body: Statement[] = [];
    if (this.check("lbrace")) {
      this.advance();
      body = this.parseStatements(true);
      if (this.check("rbrace")) {
        end = this.advance().end;
      } else {
        const bad = this.current();
        this.diagnostics.push(
          error(
            `expected "}" to close ${typeTok.text}${name ? " " + name : ""}, found ${describeToken(bad)}`,
            { start: bad.start, end: bad.end },
            "expected-rbrace",
          ),
        );
      }
    }

    return { kind: "node", type: typeTok.text, typeSpan, name, nameSpan, body, span: { start: typeTok.start, end } };
  }
}

function canStartValue(tok: Token): boolean {
  return tok.type === "number" || tok.type === "string" || tok.type === "color" || tok.type === "ident";
}

function describeToken(tok: Token): string {
  switch (tok.type) {
    case "eof":
      return "end of file";
    case "lbrace":
      return '"{"';
    case "rbrace":
      return '"}"';
    case "colon":
      return '":"';
    case "comma":
      return '","';
    case "dot":
      return '"."';
    case "string":
      return `string ${JSON.stringify(tok.strValue ?? "")}`;
    case "number":
      return `number "${tok.text}"`;
    case "color":
      return `color "${tok.text}"`;
    case "ident":
      return `"${tok.text}"`;
  }
}

export function parseWorldFile(source: string, filename = "<world>"): { ast: WorldFile; diagnostics: Diagnostic[] } {
  const { tokens, diagnostics: lexDiags } = tokenize(source, filename);
  const parser = new Parser(tokens);
  const statements = parser.parseFile();

  const first = tokens[0];
  const lastTok = tokens[tokens.length - 1];
  const zero = { file: filename, line: 1, col: 1, offset: 0 };
  const span: Span = {
    start: first ? first.start : zero,
    end: lastTok ? lastTok.end : zero,
  };

  const ast: WorldFile = { statements, span, source, filename };
  return { ast, diagnostics: [...lexDiags, ...parser.diagnostics] };
}
