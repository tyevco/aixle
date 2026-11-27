/** Syntax tree for .aix programs. Every node carries the line it came from for error messages. */

export interface Num { type: "num"; value: number; line: number }
export interface Str { type: "str"; value: string; line: number }
export interface Ident { type: "ident"; name: string; line: number }
export interface List { type: "list"; items: Expr[]; line: number }
export interface Unary { type: "unary"; op: "-"; arg: Expr; line: number }
export type CompareOp = "<" | ">" | "<=" | ">=" | "==" | "!=";
export const COMPARE_OPS: readonly CompareOp[] = ["<", ">", "<=", ">=", "==", "!="];
export interface Binary { type: "binary"; op: "+" | "-" | "*" | "/" | "%" | "^" | "&" | CompareOp; left: Expr; right: Expr; line: number }
export interface Arg { name?: string; value: Expr }
export interface Call {
  type: "call";
  callee: string;
  args: Arg[];
  line: number;
  /** Made by `x | f(...)`, and not wrapped in parentheses: the parser uses this to notice `a + b | move(...)`. */
  piped?: boolean;
  grouped?: boolean;
}
/** `list[i]`: one item of a list, 0-based; negative counts from the end. */
export interface Index { type: "index"; target: Expr; index: Expr; line: number }
/** One entry of a record literal: `key: value`, or `...value` to take every field of another record. */
export interface RecordEntry { key?: string; value: Expr; spread?: boolean }
/** `{x: 1, y: 2, name: "lid"}`, or `{...p, x: 2}`: named values, read back as `p.x`. */
export interface RecordExpr { type: "record"; entries: RecordEntry[]; line: number }
/**
 * `expr.name` on anything but a plain name: `legs[0].x`, `dims().w`. A plain `p.x` is an Ident named "p.x",
 * since only the interpreter knows whether `p` is a record or a used library.
 */
export interface Field { type: "field"; target: Expr; name: string; line: number }

export type Expr = Num | Str | Ident | List | Unary | Binary | Call | Index | RecordExpr | Field;

export interface Assign { type: "assign"; name: string; value: Expr; line: number }
export interface Def { type: "def"; name: string; params: { name: string; default?: Expr }[]; body: Expr; line: number }
export interface For { type: "for"; name: string; iterable: Expr; body: Stmt[]; line: number }
export interface Show { type: "show"; values: Expr[]; line: number }
export interface Scene { type: "scene"; values: Expr[]; line: number }
/** `set key value`; `values` holds every value when there are several (`set bed 220 220 250`), the first being `value`. */
export interface Set { type: "set"; key: string; value: Expr; values?: Expr[]; line: number }
export interface ExprStmt { type: "expr"; value: Expr; line: number }
/** `use "parts/hardware.aix"` or `use "std/furniture" as f`: a library's defs under a prefix. */
export interface Use { type: "use"; path: string; alias?: string; line: number }
/** `assert test, "message", pose=name`: a promise the model makes about itself, checked at rest or in the named pose. */
export interface Assert { type: "assert"; test: Expr; message?: Expr; pose?: string; line: number }

export type Stmt = Assign | Def | For | Show | Scene | Set | ExprStmt | Use | Assert;

export interface Program {
  body: Stmt[];
  /** Things the parser noticed that are legal but probably not meant; the interpreter reports them with its own. */
  warnings?: string[];
  /** Every comment written after code on its line, for the interpreter to read for code pasted into one. */
  trailingComments?: { line: number; text: string }[];
}

/**
 * How tightly an expression binds, as the parser reads it, loosest first: a comparison, `+ -`, `&`, `* / %`, a
 * unary minus, `^`, a pipeline, then everything that is one primary (a name, a call, a literal, `a[i]`, `a.x`).
 */
function precedence(e: Expr): number {
  if (e.type === "binary") {
    if (e.op === "+" || e.op === "-") return 2;
    if (e.op === "&") return 3;
    if (e.op === "*" || e.op === "/" || e.op === "%") return 4;
    if (e.op === "^") return 6;
    return 1;
  }
  if (e.type === "unary") return 5;
  // A pipeline the author wrote in parentheses keeps them (`a + (b | move(...))` reads as meant), so it is a primary.
  if (e.type === "call" && e.piped && e.args.length && !e.grouped) return 7;
  return 8;
}

/**
 * An expression as source text, for a message that quotes what was
 * tested (`clearance(handle, rim) > 0.05`): the shape of the expression,
 * not the original spacing, with the parentheses its precedence needs, so
 * the text parses back to the same tree (round 11: `F * (stack_y > 0) * c`
 * printed without them read as another comparison).
 */
export function exprText(e: Expr): string {
  /** `x` as text, in parentheses when it binds looser than `min`. */
  const at = (x: Expr, min: number): string => (precedence(x) < min ? `(${exprText(x)})` : exprText(x));
  switch (e.type) {
    case "num": return String(e.value);
    case "str": return JSON.stringify(e.value);
    case "ident": return e.name;
    case "list": return `[${e.items.map(exprText).join(", ")}]`;
    // The operand of a minus is read as another unary, so a power (`-a ^ 2` is -(a ^ 2)) needs none.
    case "unary": return `-${at(e.arg, 5)}`;
    case "binary": {
      const p = precedence(e);
      // `^` groups to the right and takes a pipeline below it, a unary to its right; the rest group to the left.
      if (e.op === "^") return `${at(e.left, 7)} ^ ${at(e.right, 5)}`;
      return `${at(e.left, p)} ${e.op} ${at(e.right, p + 1)}`;
    }
    case "index": return `${at(e.target, 8)}[${exprText(e.index)}]`;
    case "record": return `{${e.entries.map((en) => (en.spread ? `...${exprText(en.value)}` : `${en.key}: ${exprText(en.value)}`)).join(", ")}}`;
    case "field": return `${at(e.target, 8)}.${e.name}`;
    case "call": {
      const arg = (a: Arg) => (a.name ? `${a.name}=${exprText(a.value)}` : exprText(a.value));
      if (e.piped && e.args.length) {
        const rest = e.args.slice(1);
        // The left of `|` is one primary or another pipeline: `(a + b) | move(...)` keeps its parentheses.
        const text = `${at(e.args[0].value, 7)} | ${e.callee}${rest.length ? `(${rest.map(arg).join(", ")})` : ""}`;
        return e.grouped ? `(${text})` : text;
      }
      return `${e.callee}(${e.args.map(arg).join(", ")})`;
    }
  }
}
