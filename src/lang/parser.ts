/**
 * Recursive-descent parser for .aix.
 *
 *   program   := statement*
 *   statement := 'def' NAME '(' params ')' '=' expr
 *              | 'for' NAME 'in' expr '{' statement* '}'
 *              | 'show' expr (',' expr)*
 *              | 'scene' expr (',' expr)*
 *              | 'set' NAME expr
 *              | NAME '=' expr
 *              | expr
 *
 * Expression precedence, loosest first:
 *   + -        union / difference on shapes, add / subtract on numbers
 *   &          intersection
 *   * / %      numbers
 *   unary -
 *   ^          power (right-assoc)
 *   |          pipeline: `a | f(x)` is `f(a, x)`
 *   primary    number, string, name, call, list, ( expr )
 */
import type { Arg, Expr, Program, Stmt } from "./ast.js";
import { SyntaxError, tokenize, type Token } from "./lexer.js";

const KEYWORDS = new Set(["def", "for", "in", "show", "scene", "set"]);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const body: Stmt[] = [];
    this.skipNewlines();
    while (!this.at("eof")) {
      body.push(this.statement());
      this.endStatement();
    }
    return { body };
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private at(type: Token["type"], value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private atOp(value: string): boolean {
    return this.at("op", value);
  }
  private expectOp(value: string): Token {
    if (!this.atOp(value)) throw new SyntaxError(`expected '${value}' but found ${describe(this.peek())}`, this.peek().line);
    return this.next();
  }
  private expectIdent(what: string): Token {
    if (!this.at("ident")) throw new SyntaxError(`expected ${what} but found ${describe(this.peek())}`, this.peek().line);
    const t = this.next();
    if (KEYWORDS.has(t.value)) throw new SyntaxError(`'${t.value}' is a keyword and cannot be a ${what}`, t.line);
    return t;
  }
  private skipNewlines(): void {
    while (this.at("newline")) this.pos++;
  }
  private endStatement(): void {
    if (this.at("eof") || this.atOp("}")) return;
    if (!this.at("newline")) throw new SyntaxError(`unexpected ${describe(this.peek())} after statement`, this.peek().line);
    this.skipNewlines();
  }

  private statement(): Stmt {
    const t = this.peek();
    if (t.type === "ident" && KEYWORDS.has(t.value) && this.peek(1).type === "op" && this.peek(1).value === "=")
      throw new SyntaxError(`'${t.value}' is a keyword and cannot be a name; call it ${t.value}_ or something else`, t.line);
    if (t.type === "ident" && t.value === "def") return this.def();
    if (t.type === "ident" && t.value === "for") return this.for();
    if (t.type === "ident" && t.value === "show") {
      this.next();
      const values = [this.expr()];
      while (this.atOp(",")) { this.next(); values.push(this.expr()); }
      return { type: "show", values, line: t.line };
    }
    if (t.type === "ident" && t.value === "scene") {
      this.next();
      const values = [this.expr()];
      while (this.atOp(",")) { this.next(); values.push(this.expr()); }
      return { type: "scene", values, line: t.line };
    }
    if (t.type === "ident" && t.value === "set") {
      this.next();
      const key = this.expectIdent("a setting name").value;
      return { type: "set", key, value: this.expr(), line: t.line };
    }
    if (t.type === "ident" && this.peek(1).type === "op" && this.peek(1).value === "=") {
      const name = this.expectIdent("a name").value;
      this.expectOp("=");
      return { type: "assign", name, value: this.expr(), line: t.line };
    }
    return { type: "expr", value: this.expr(), line: t.line };
  }

  private def(): Stmt {
    const line = this.next().line;
    const name = this.expectIdent("a function name").value;
    this.expectOp("(");
    const params: { name: string; default?: Expr }[] = [];
    while (!this.atOp(")")) {
      const p = this.expectIdent("a parameter name").value;
      let def: Expr | undefined;
      if (this.atOp("=")) { this.next(); def = this.expr(); }
      params.push(def ? { name: p, default: def } : { name: p });
      if (this.atOp(",")) this.next();
      else if (!this.atOp(")")) throw new SyntaxError(`expected ',' or ')' in parameters of ${name}`, this.peek().line);
    }
    this.expectOp(")");
    this.expectOp("=");
    return { type: "def", name, params, body: this.expr(), line };
  }

  private for(): Stmt {
    const line = this.next().line;
    const name = this.expectIdent("a loop variable").value;
    if (!this.at("ident", "in")) throw new SyntaxError(`expected 'in' after 'for ${name}'`, this.peek().line);
    this.next();
    const iterable = this.expr();
    this.expectOp("{");
    this.skipNewlines();
    const body: Stmt[] = [];
    while (!this.atOp("}")) {
      if (this.at("eof")) throw new SyntaxError(`'for' body opened on line ${line} is never closed`, line);
      body.push(this.statement());
      this.endStatement();
    }
    this.expectOp("}");
    return { type: "for", name, iterable, body, line };
  }

  // --- expressions ---

  expr(): Expr {
    return this.additive();
  }

  private additive(): Expr {
    let left = this.intersection();
    while (this.atOp("+") || this.atOp("-")) {
      const t = this.next();
      const right = this.intersection();
      left = { type: "binary", op: t.value as "+" | "-", left, right, line: t.line };
    }
    return left;
  }

  private intersection(): Expr {
    let left = this.multiplicative();
    while (this.atOp("&")) {
      const t = this.next();
      const right = this.multiplicative();
      left = { type: "binary", op: "&", left, right, line: t.line };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.unary();
    while (this.atOp("*") || this.atOp("/") || this.atOp("%")) {
      const t = this.next();
      const right = this.unary();
      left = { type: "binary", op: t.value as "*" | "/" | "%", left, right, line: t.line };
    }
    return left;
  }

  private unary(): Expr {
    if (this.atOp("-")) {
      const t = this.next();
      return { type: "unary", op: "-", arg: this.unary(), line: t.line };
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.pipeline();
    if (this.atOp("^")) {
      const t = this.next();
      const exp = this.unary();
      return { type: "binary", op: "^", left: base, right: exp, line: t.line };
    }
    return base;
  }

  private pipeline(): Expr {
    let left = this.primary();
    while (this.atOp("|")) {
      const t = this.next();
      const callee = this.expectIdent("a function name after '|'").value;
      const args: Arg[] = [{ value: left }];
      if (this.atOp("(")) args.push(...this.args(callee));
      left = { type: "call", callee, args, line: t.line };
    }
    return left;
  }

  private args(callee: string): Arg[] {
    const open = this.expectOp("(");
    const args: Arg[] = [];
    const where = (): string => (this.peek().line !== open.line ? ` (the call opened on line ${open.line})` : "");
    while (!this.atOp(")")) {
      // Inside parentheses the lexer drops line breaks, so a newline token here is the file's last one.
      if (this.at("eof") || this.at("newline")) throw new SyntaxError(`the call to ${callee} opened on line ${open.line} is never closed: missing ')'`, open.line);
      if (this.at("ident") && KEYWORDS.has(this.peek().value) && this.peek().line !== open.line)
        throw new SyntaxError(`the call to ${callee} opened on line ${open.line} is never closed: missing ')' before '${this.peek().value}' on line ${this.peek().line}`, open.line);
      if (this.at("ident") && this.peek(1).type === "op" && this.peek(1).value === "=") {
        const name = this.next().value;
        this.next();
        args.push({ name, value: this.expr() });
      } else {
        args.push({ value: this.expr() });
      }
      if (this.atOp(",")) this.next();
      else if (!this.atOp(")")) throw new SyntaxError(`expected ',' or ')' in call to ${callee}, found ${describe(this.peek())}${where()}`, this.peek().line);
    }
    this.expectOp(")");
    return args;
  }

  /** A primary followed by any number of `[i]` indexes: `angle("boom")[0]`, `pts[len(pts) - 1]`. */
  private primary(): Expr {
    let e = this.atom();
    while (this.atOp("[")) {
      const t = this.next();
      const index = this.expr();
      this.expectOp("]");
      e = { type: "index", target: e, index, line: t.line };
    }
    return e;
  }

  private atom(): Expr {
    const t = this.peek();
    if (t.type === "num") { this.next(); return { type: "num", value: Number(t.value), line: t.line }; }
    if (t.type === "str") { this.next(); return { type: "str", value: t.value, line: t.line }; }
    if (t.type === "ident") {
      if (KEYWORDS.has(t.value)) throw new SyntaxError(`unexpected keyword '${t.value}'`, t.line);
      this.next();
      if (this.atOp("(")) return { type: "call", callee: t.value, args: this.args(t.value), line: t.line };
      return { type: "ident", name: t.value, line: t.line };
    }
    if (t.type === "op" && t.value === "(") {
      this.next();
      const e = this.expr();
      this.expectOp(")");
      return e;
    }
    if (t.type === "op" && t.value === "[") {
      this.next();
      const items: Expr[] = [];
      while (!this.atOp("]")) {
        items.push(this.expr());
        if (this.atOp(",")) this.next();
        else if (!this.atOp("]")) throw new SyntaxError(`expected ',' or ']' in list`, this.peek().line);
      }
      this.expectOp("]");
      return { type: "list", items, line: t.line };
    }
    throw new SyntaxError(`expected a value but found ${describe(t)}`, t.line);
  }
}

function describe(t: Token): string {
  if (t.type === "eof") return "end of file";
  if (t.type === "newline") return "end of line";
  if (t.type === "str") return `string "${t.value}"`;
  return `'${t.value}'`;
}

export function parse(source: string): Program {
  return new Parser(tokenize(source)).parseProgram();
}
