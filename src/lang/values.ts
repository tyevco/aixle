/** Runtime values and the shape of a builtin's signature (which also generates the reference). */
import type { Expr } from "./ast.js";
import type { Material, Shape2, Shape3 } from "../sdf/types.js";
import { isCurve, type Curve } from "../sdf/curves.js";

export interface UserFn {
  kind: "fn";
  name: string;
  params: { name: string; default?: Expr }[];
  body: Expr;
  /** The top-level scope of the program or library that defined it, so a library's def sees its own helpers, not the caller's names. Opaque here; the interpreter owns it. */
  closure?: unknown;
}

export type Value = number | string | Value[] | Shape3 | Shape2 | Material | UserFn | Curve;

export type ParamType = "number" | "string" | "shape" | "shape2" | "anyshape" | "material" | "list" | "curve" | "axis" | "any";

export interface Param {
  name: string;
  type: ParamType;
  /** Absent means required. */
  default?: Value;
  /** Collects every remaining positional argument of `type`. */
  rest?: boolean;
  doc?: string;
}

export interface Overload {
  params: Param[];
  returns: "number" | "string" | "shape" | "shape2" | "material" | "list" | "curve" | "any";
  impl: (args: Value[], rest: Value[]) => Value;
}

export interface Builtin {
  name: string;
  group: string;
  doc: string;
  overloads: Overload[];
}

export function typeName(v: Value): string {
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "list";
  const kind = (v as { kind?: string }).kind;
  if (kind === "shape3") return "shape";
  if (kind === "shape2") return "shape2";
  if (kind === "fn") return "function";
  if (kind === "curve") return "curve";
  return "material";
}

export const isShape3 = (v: Value): v is Shape3 => typeof v === "object" && !Array.isArray(v) && (v as Shape3).kind === "shape3";
export const isShape2 = (v: Value): v is Shape2 => typeof v === "object" && !Array.isArray(v) && (v as Shape2).kind === "shape2";
export const isMaterial = (v: Value): v is Material =>
  typeof v === "object" && !Array.isArray(v) && (v as Material).pattern !== undefined;
export const isUserFn = (v: Value): v is UserFn => typeof v === "object" && !Array.isArray(v) && (v as UserFn).kind === "fn";
export { isCurve };
