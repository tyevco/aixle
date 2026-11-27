/** Runtime values and the shape of a builtin's signature (which also generates the reference). */
import type { Expr, Stmt } from "./ast.js";
import type { Material, Shape2, Shape3 } from "../sdf/types.js";
import { isCurve, type Curve } from "../sdf/curves.js";
import type { MeshCache } from "../mesh/pieces.js";

export interface UserFn {
  kind: "fn";
  name: string;
  params: { name: string; default?: Expr }[];
  /** The expression a `def name(...) = expr` makes; a block body has `block` instead, ending with its return. */
  body?: Expr;
  block?: Stmt[];
  /** The library the def is from, as its `use` wrote it, for an assert in its body and a shape's origin; none for the program's own. */
  file?: string;
  /** The top-level scope of the program or library that defined it, so a library's def sees its own helpers, not the caller's names. Opaque here; the interpreter owns it. */
  closure?: unknown;
}

/** What xform() makes: a joint's pose in one value, for pose("hop", body=xform(move=[0, 0.3, 0])). */
export interface Xform {
  kind: "xform";
  angles: [number, number, number];
  /** True when rotate= was one number: an angle about the joint's axis. */
  single: boolean;
  move: [number, number, number];
  scale: [number, number, number];
}

/**
 * `{x: 1, y: 2, name: "lid"}`: named values in the order written. The fields live in a map of their own, not as
 * properties, so no field name (`kind`, `pattern`) can make a record look like a shape or a material.
 */
export interface RecordValue {
  kind: "record";
  fields: ReadonlyMap<string, Value>;
}

export type Value = number | string | Value[] | Shape3 | Shape2 | Material | UserFn | Curve | Xform | RecordValue;

export const isRecord = (v: Value): v is RecordValue => typeof v === "object" && !Array.isArray(v) && (v as RecordValue).kind === "record";

export const isXform = (v: Value): v is Xform => typeof v === "object" && !Array.isArray(v) && (v as Xform).kind === "xform";

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

/** What a rest() or lean() call did, for check's line: how far the part moved or turned, and what the contact left. */
export interface ContactNote {
  /** Units moved along `along`, or degrees turned about it; negative when the part started inside and was backed out. */
  amount: number;
  /** The unit direction moved along, or the unit axis turned about. */
  along: [number, number, number];
  /** lean's pivot, a world point. */
  pivot?: [number, number, number];
  /** clearance(part, on) at the contact, before the sink. */
  gap: number;
  /** True when the part started inside `on`. */
  backed: boolean;
  /** How deep a sliver of `on` it started in and was lifted out of first. */
  lifted: number;
  sink: number;
}

/** What one evaluation lends a builtin: a mesh of a shape at a resolution, shared by every query that meshes it. */
export interface CallContext {
  meshes?: MeshCache;
  /** The source text of the argument bound to a parameter, for a message that names the part (rest, lean). */
  text?: (param: string) => string | undefined;
  /** Where a placing call says what it did, for check. */
  placed?: (note: ContactNote) => void;
}

export interface Overload {
  params: Param[];
  returns: "number" | "string" | "shape" | "shape2" | "material" | "list" | "curve" | "transform" | "any";
  impl: (args: Value[], rest: Value[], ctx?: CallContext) => Value;
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
  if (kind === "xform") return "transform";
  if (kind === "record") return "record";
  return "material";
}

export const isShape3 = (v: Value): v is Shape3 => typeof v === "object" && !Array.isArray(v) && (v as Shape3).kind === "shape3";
export const isShape2 = (v: Value): v is Shape2 => typeof v === "object" && !Array.isArray(v) && (v as Shape2).kind === "shape2";
export const isMaterial = (v: Value): v is Material =>
  typeof v === "object" && !Array.isArray(v) && (v as Material).pattern !== undefined;
export const isUserFn = (v: Value): v is UserFn => typeof v === "object" && !Array.isArray(v) && (v as UserFn).kind === "fn";
export { isCurve };
