/** Syntax tree for .aix programs. Every node carries the line it came from for error messages. */

export interface Num { type: "num"; value: number; line: number }
export interface Str { type: "str"; value: string; line: number }
export interface Ident { type: "ident"; name: string; line: number }
export interface List { type: "list"; items: Expr[]; line: number }
export interface Unary { type: "unary"; op: "-"; arg: Expr; line: number }
export interface Binary { type: "binary"; op: "+" | "-" | "*" | "/" | "%" | "^" | "&"; left: Expr; right: Expr; line: number }
export interface Arg { name?: string; value: Expr }
export interface Call { type: "call"; callee: string; args: Arg[]; line: number }
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

export type Stmt = Assign | Def | For | Show | Scene | Set | ExprStmt;

export interface Program {
  body: Stmt[];
}
