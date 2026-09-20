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

export type Expr = Num | Str | Ident | List | Unary | Binary | Call | Index;

export interface Assign { type: "assign"; name: string; value: Expr; line: number }
export interface Def { type: "def"; name: string; params: { name: string; default?: Expr }[]; body: Expr; line: number }
export interface For { type: "for"; name: string; iterable: Expr; body: Stmt[]; line: number }
export interface Show { type: "show"; values: Expr[]; line: number }
export interface Scene { type: "scene"; values: Expr[]; line: number }
export interface Set { type: "set"; key: string; value: Expr; line: number }
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
}

/**
 * An expression as source text, for a message that quotes what was
 * tested (`clearance(handle, rim) > 0.05`): the shape of the expression,
 * not the original spacing.
 */
export function exprText(e: Expr): string {
  switch (e.type) {
    case "num": return String(e.value);
    case "str": return JSON.stringify(e.value);
    case "ident": return e.name;
    case "list": return `[${e.items.map(exprText).join(", ")}]`;
    case "unary": return `-${exprText(e.arg)}`;
    case "binary": return `${exprText(e.left)} ${e.op} ${exprText(e.right)}`;
    case "index": return `${exprText(e.target)}[${exprText(e.index)}]`;
    case "call": {
      const arg = (a: Arg) => (a.name ? `${a.name}=${exprText(a.value)}` : exprText(a.value));
      if (e.piped && e.args.length) {
        const rest = e.args.slice(1);
        return `${exprText(e.args[0].value)} | ${e.callee}${rest.length ? `(${rest.map(arg).join(", ")})` : ""}`;
      }
      return `${e.callee}(${e.args.map(arg).join(", ")})`;
    }
  }
}
