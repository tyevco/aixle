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
 *   primary    number, string, name, call, list, record, ( expr ), then any [i] or .name
 *
 *   record    := '{' (NAME ':' expr | '...' expr) (',' ...)* ','? '}'
 */
import { COMPARE_OPS, exprText, type Arg, type CompareOp, type Expr, type Program, type RecordEntry, type Stmt } from "./ast.js";
import { SyntaxError, tokenize, type Token } from "./lexer.js";

const KEYWORDS = new Set(["def", "for", "in", "show", "scene", "set", "use", "assert"]);

class Parser {
  private pos = 0;

  private readonly warnings: string[] = [];

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const body: Stmt[] = [];
    this.skipNewlines();
    while (!this.at("eof")) {
      body.push(this.statement());
      this.endStatement();
    }
    return { body, warnings: this.warnings };
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
    if (KEYWORDS.has(t.value)) throw new SyntaxError(`'${t.value}' is a keyword and cannot be ${what}`, t.line);
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
      // A bare word alone after the key is a name even when it is a keyword: `set units in`.
      const w = this.peek();
      if (w.type === "ident" && KEYWORDS.has(w.value) && (this.peek(1).type === "newline" || this.peek(1).type === "eof")) {
        this.next();
        return { type: "set", key, value: { type: "ident", name: w.value, line: w.line }, line: t.line };
      }
      const value = this.expr();
      // More than one value is a list: `set bed 220 220 250` (commas allowed between them). The values end where the
      // statement does, at a newline or at the `}` closing a one-line loop (`for i in [1] { set grid 64 }`).
      const more: Expr[] = [];
      while (!this.at("newline") && !this.at("eof") && !this.atOp("}")) {
        if (this.atOp(",")) this.next();
        more.push(this.expr());
      }
      return more.length ? { type: "set", key, value, values: [value, ...more], line: t.line } : { type: "set", key, value, line: t.line };
    }
    if (t.type === "ident" && t.value === "use") {
      this.next();
      const pathTok = this.peek();
      if (pathTok.type !== "str") throw new SyntaxError(`use needs the library's path as a string: use "parts/hardware.aix" or use "std/furniture" as f`, t.line);
      this.next();
      let alias: string | undefined;
      if (this.at("ident") && this.peek().value === "as") {
        this.next().role = "keyword";
        alias = this.expectIdent("a name for the library after 'as'").value;
      }
      return { type: "use", path: pathTok.value, alias, line: t.line };
    }
    if (t.type === "ident" && t.value === "assert") {
      this.next();
      const test = this.expr();
      let message: Expr | undefined;
      let pose: string | undefined;
      // Then a message, a pose or both, in either order: `assert tall(m) < 2, "closed", pose=shut`.
      while (this.atOp(",")) {
        this.next();
        const k = this.peek();
        if (k.type === "ident" && k.value === "pose" && this.peek(1).type === "op" && this.peek(1).value === "=") {
          this.next(); this.next().role = "named";
          const v = this.next();
          if (v.type !== "ident" && v.type !== "str") throw new SyntaxError(`assert's pose= names a pose, as a bare word or a string`, v.line);
          pose = v.value;
        } else if (message === undefined) message = this.expr();
        else throw new SyntaxError(`assert takes a test, then a message and pose=name`, k.line);
      }
      return { type: "assert", test, message, pose, line: t.line };
    }
    // `p.x = 2`: a record, like everything else, is never changed in place; a new one is made from it.
    if (t.type === "ident" && this.peek(1).type === "op" && this.peek(1).value === ".") {
      let k = 1;
      while (this.peek(k).type === "op" && this.peek(k).value === "." && this.peek(k + 1).type === "ident") k += 2;
      if (k > 1 && this.peek(k).type === "op" && this.peek(k).value === "=") {
        const path = Array.from({ length: (k - 1) / 2 }, (_, j) => this.peek(2 + j * 2).value);
        const change = path.reduceRight((inner, key, j) => `{...${[t.value, ...path.slice(0, j)].join(".")}, ${key}: ${inner}}`, "value");
        throw new SyntaxError(`${[t.value, ...path].join(".")} = ...: a record's fields cannot be changed; make a new record with the change, ${t.value} = ${change}`, t.line);
      }
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
      if (this.atOp("=")) { this.next().role = "named"; def = this.expr(); }
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
    return this.comparison();
  }

  // Loosest of all: `a + b < c` compares the sum. The result is a number, 1 or 0, for `assert`.
  private comparison(): Expr {
    let left = this.additive();
    while (COMPARE_OPS.some((op) => this.atOp(op))) {
      const t = this.next();
      const right = this.additive();
      left = { type: "binary", op: t.value as CompareOp, left, right, line: t.line };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.intersection();
    while (this.atOp("+") || this.atOp("-")) {
      const t = this.next();
      const right = this.intersection();
      // `a + b | move(...)` moves b alone, since '|' binds tighter than '+'. The paint case has a runtime warning
      // (a beige lid); a transform has no visible sign but a part that is not where it was meant to be (round 5: a
      // pedal moved without its crank). Parentheses on the right side mean it was meant.
      if (right.type === "call" && right.piped && !right.grouped && PLACING.has(right.callee) && pipeBase(right).type === "ident")
        this.warnings.push(`line ${t.line}: '${t.value} ... | ${right.callee}(...)' applies ${right.callee} to the right side only, since '|' binds tighter than '${t.value}'; wrap the union in parentheses, (a ${t.value} b) | ${right.callee}(...), if the whole should move`);
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
      t.role = "unary";
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
      const callee = this.dotted(this.expectIdent("a function name after '|'").value);
      const args: Arg[] = [{ value: left }];
      if (this.atOp("(")) args.push(...this.args(callee));
      left = { type: "call", callee, args, line: t.line, piped: true };
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
        this.next().role = "named";
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

  /** `hardware.hex_bolt`: a name in a used library, kept as one dotted name; the interpreter splits it. */
  private dotted(name: string): string {
    while (this.atOp(".") && this.peek(1).type === "ident") {
      this.next();
      name += "." + this.next().value;
    }
    return name;
  }

  /**
   * A primary followed by any number of `[i]` indexes and `.name` fields: `angle("boom")[0]`, `pts[len(pts) - 1]`,
   * `legs[0].x`, `dims().w`. A field straight after a name was already taken into the name by `dotted`.
   */
  private primary(): Expr {
    let e = this.atom();
    for (;;) {
      if (this.atOp("[")) {
        const t = this.next();
        t.role = "index";
        const index = this.expr();
        this.expectOp("]");
        e = { type: "index", target: e, index, line: t.line };
      } else if (this.atOp(".") && this.peek(1).type === "ident" && e.type !== "num" && e.type !== "str") {
        const t = this.next();
        e = { type: "field", target: e, name: this.next().value, line: t.line };
        // A call is on a name (r.f(1) is the name r.f); after an index or a call there is none to call.
        if (this.atOp("("))
          throw new SyntaxError(e.target.type === "ident"
            ? `'(${exprText(e.target)}).${e.name}(...)': only a name is called; write ${exprText(e)}(...), without the parentheses`
            : `'${exprText(e)}(...)': only a name is called, as r.f(1) is; name it first, ${e.name} = ${exprText(e)}, then ${e.name}(...)`, t.line);
      } else break;
    }
    // `p.0` lexes as a name and the number .0: a field is a name, an item is an index.
    if (this.at("num") && this.peek().value.startsWith(".") && this.peek().line === this.tokens[this.pos - 1].line && this.peek().start === this.tokens[this.pos - 1].end)
      throw new SyntaxError(`'${exprText(e)}${this.peek().value}': a field is read by name (p.x); an item of a list by its index, ${exprText(e)}[${this.peek().value.slice(1)}]`, this.peek().line);
    return e;
  }

  private atom(): Expr {
    const t = this.peek();
    if (t.type === "num") { this.next(); return { type: "num", value: Number(t.value), line: t.line }; }
    if (t.type === "str") { this.next(); return { type: "str", value: t.value, line: t.line }; }
    if (t.type === "ident") {
      if (KEYWORDS.has(t.value)) throw new SyntaxError(`unexpected keyword '${t.value}'`, t.line);
      this.next();
      const name = this.dotted(t.value);
      if (this.atOp("(")) return { type: "call", callee: name, args: this.args(name), line: t.line };
      return { type: "ident", name, line: t.line };
    }
    if (t.type === "op" && t.value === "(") {
      this.next();
      const e = this.expr();
      this.expectOp(")");
      if (e.type === "call") e.grouped = true;
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
    if (t.type === "op" && t.value === "{") return this.record();
    throw new SyntaxError(`expected a value but found ${describe(t)}`, t.line);
  }

  /**
   * `{x: 1, y: 2}`, `{...p, x: 2}`. Line breaks between entries are allowed (the lexer only drops them inside
   * parentheses and brackets, and a brace also opens a loop's body, so they are skipped here).
   */
  private record(): Expr {
    const open = this.next();
    open.role = "record";
    const entries: RecordEntry[] = [];
    const keys = new Set<string>();
    this.skipNewlines();
    while (!this.atOp("}")) {
      if (this.at("eof")) throw new SyntaxError(`the record opened on line ${open.line} is never closed: missing '}'`, open.line);
      if (this.atOp("...")) {
        this.next();
        entries.push({ value: this.expr(), spread: true });
      } else {
        const k = this.peek();
        if (k.type !== "ident" || !(this.peek(1).type === "op" && this.peek(1).value === ":"))
          throw new SyntaxError(`a record's entries are name: value (or ...other to take another record's fields), found ${describe(k)}`, k.line);
        const key = this.expectIdent("a field name").value;
        if (keys.has(key)) throw new SyntaxError(`the record has '${key}' twice; a field is given once (to change one of another record's, {...p, ${key}: value})`, k.line);
        keys.add(key);
        this.next();
        entries.push({ key, value: this.expr() });
      }
      this.skipNewlines();
      if (this.atOp(",")) { this.next(); this.skipNewlines(); }
      else if (this.at("eof")) throw new SyntaxError(`the record opened on line ${open.line} is never closed: missing '}'`, open.line);
      else if (!this.atOp("}")) throw new SyntaxError(`expected ',' or '}' in the record opened on line ${open.line}, found ${describe(this.peek())}`, this.peek().line);
    }
    this.next().role = "record";
    return { type: "record", entries, line: open.line };
  }
}

/** The leftmost value of a pipeline: `b` in `b | rotate(...) | move(...)`. A named step there, moved alone after a
 * '+', is the mistake; a fresh primitive (`+ sphere(0.2) | move(...)`) is the ordinary way to place one. */
function pipeBase(e: Expr): Expr {
  let cur: Expr = e;
  while (cur.type === "call" && cur.piped && cur.args.length) cur = cur.args[0].value;
  return cur;
}

/** Transforms and placements whose result on the right of '+' alone is rarely meant. */
const PLACING = new Set(["move", "rotate", "scale", "flip", "mirror", "ground", "center", "attach", "twist", "bend", "wrap"]);

function describe(t: Token): string {
  if (t.type === "eof") return "end of file";
  if (t.type === "newline") return "end of line";
  if (t.type === "str") return `string "${t.value}"`;
  return `'${t.value}'`;
}

export function parse(source: string): Program {
  return new Parser(tokenize(source)).parseProgram();
}

/** The program and its tokens, each with the role the parser gave it: what `aixle fmt` lays out. */
export function parseTokens(source: string): { program: Program; tokens: Token[] } {
  const tokens = tokenize(source);
  return { program: new Parser(tokens).parseProgram(), tokens };
}
