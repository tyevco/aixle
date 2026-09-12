/**
 * Evaluates a parsed program to a final shape, recording every top-level
 * assignment along the way. Those records are the "steps": the pipeline
 * renders each so an agent can see how the model was built up, and the
 * report says which steps ended up in the output.
 */
import type { Arg, Expr, Program, Stmt } from "./ast.js";
import { BUILTIN_MAP, CONSTANTS, toMaterial } from "./builtins.js";
import { union, scale as scaleShape, allJoints, joint as jointShape } from "../sdf/ops.js";
import { union2 } from "../sdf/shapes2d.js";
import { difference, intersect } from "../sdf/ops.js";
import { difference2, intersect2 } from "../sdf/shapes2d.js";
import type { Shape3 } from "../sdf/types.js";
import { isCurve, isShape2, isShape3, isUserFn, typeName, type Builtin, type Overload, type Param, type UserFn, type Value } from "./values.js";

/** Settings whose value is a name: a bare word after `set` is taken as the name itself. */
const NAME_SETTINGS = new Set(["pose", "focus"]);

export class RuntimeError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
    this.name = "RuntimeError";
  }
}

export interface Step {
  name: string;
  value: Value;
  line: number;
  /** Names this step's expression read, directly. */
  deps: Set<string>;
}

export interface Settings {
  grid?: number;
  size?: number;
  [key: string]: number | string | undefined;
}

export interface EvalOptions {
  /** Resolve `import("file")` to a shape; the pipeline reads the file. Absent means imports are an error. */
  resolveImport?: (path: string, opts: { resolution: number }) => Shape3;
  /** Angles per joint name for this evaluation: a pose. Joints not named are at rest. */
  jointAngles?: Record<string, [number, number, number]>;
}

export interface SceneObject {
  name: string;
  shape: Shape3;
}

export interface Pose {
  name: string;
  /** Joint name to degrees about x, y, z. */
  angles: Record<string, [number, number, number]>;
  line: number;
}

export interface Animation {
  name: string;
  /** Pose names in order; keyframes evenly spaced over `seconds`. */
  poses: string[];
  seconds: number;
  loop: boolean;
  line: number;
}

export interface Evaluation {
  /** The shape to output, or undefined when the program made no 3D shape. */
  output?: Shape3;
  /** The named objects of a `scene`, or the single output as one object. */
  objects: SceneObject[];
  poses: Pose[];
  animations: Animation[];
  /** What the output was called: the shown name(s), or the last assignment. */
  outputName: string;
  /** Names the output depends on, transitively (itself included). */
  used: Set<string>;
  steps: Step[];
  settings: Settings;
  warnings: string[];
}

const MAX_LOOP = 20000;
const MAX_DEPTH = 64;

class Scope {
  private vars = new Map<string, Value>();
  constructor(private readonly parent?: Scope) {}
  get(name: string): Value | undefined {
    return this.vars.has(name) ? this.vars.get(name) : this.parent?.get(name);
  }
  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }
  set(name: string, value: Value): void {
    this.vars.set(name, value);
  }
}

export function evaluate(program: Program, options: EvalOptions = {}): Evaluation {
  const global = new Scope();
  for (const [k, v] of Object.entries(CONSTANTS)) global.set(k, v);
  const steps = new Map<string, Step>();
  const settings: Settings = {};
  const warnings: string[] = [];
  let shown: { names: string[]; shapes: Shape3[]; scene: boolean } | undefined;
  const poses: Pose[] = [];
  const animations: Animation[] = [];
  let lastShape: { name: string } | undefined;
  let depth = 0;
  let loops = 0;
  /** Names read while evaluating the current top-level statement. */
  let reads: Set<string> | undefined;

  function lookup(name: string, line: number): Value {
    const v = global.get(name);
    if (v === undefined) throw new RuntimeError(`'${name}' is not defined`, line);
    return v;
  }

  function evalExpr(e: Expr, scope: Scope): Value {
    switch (e.type) {
      case "num":
        return e.value;
      case "str":
        return e.value;
      case "list":
        return e.items.map((it) => evalExpr(it, scope));
      case "ident": {
        const v = scope.get(e.name);
        if (v === undefined) throw new RuntimeError(`'${e.name}' is not defined`, e.line);
        reads?.add(e.name);
        return v;
      }
      case "unary": {
        const v = evalExpr(e.arg, scope);
        if (typeof v !== "number") throw new RuntimeError(`cannot negate a ${typeName(v)}`, e.line);
        return -v;
      }
      case "binary":
        return binary(e.op, evalExpr(e.left, scope), evalExpr(e.right, scope), e.line);
      case "call":
        return call(e.callee, e.args, scope, e.line);
    }
  }

  function binary(op: string, a: Value, b: Value, line: number): Value {
    if (typeof a === "number" && typeof b === "number") {
      switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "%": return ((a % b) + b) % b;
        case "^": return Math.pow(a, b);
        case "&": throw new RuntimeError(`'&' intersects shapes; it does not apply to numbers`, line);
      }
    }
    if (typeof a === "string" && typeof b === "string" && op === "+") return a + b;
    if (Array.isArray(a) && Array.isArray(b) && op === "+") return [...a, ...b];
    if (isShape3(a) && isShape3(b)) {
      switch (op) {
        case "+": return union([a, b]);
        case "-": return difference(a, b);
        case "&": return intersect(a, b);
      }
    }
    if (isShape2(a) && isShape2(b)) {
      switch (op) {
        case "+": return union2([a, b]);
        case "-": return difference2(a, b);
        case "&": return intersect2(a, b);
      }
    }
    if ((isShape3(a) && isShape2(b)) || (isShape2(a) && isShape3(b)))
      throw new RuntimeError(`cannot combine a 3D shape with a 2D profile; extrude or revolve the profile first`, line);
    throw new RuntimeError(`'${op}' does not apply to a ${typeName(a)} and a ${typeName(b)}`, line);
  }

  function callImport(args: Arg[], scope: Scope, line: number): Value {
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    const path = values.find((v) => !v.name)?.value ?? values.find((v) => v.name === "path")?.value;
    if (typeof path !== "string") throw new RuntimeError(`import(): the first argument is the file path, a string`, line);
    const res = values.find((v) => v.name === "resolution")?.value ?? 96;
    const size = values.find((v) => v.name === "size")?.value;
    if (typeof res !== "number") throw new RuntimeError(`import(): resolution must be a number`, line);
    if (size !== undefined && typeof size !== "number") throw new RuntimeError(`import(): size must be a number`, line);
    if (!options.resolveImport) throw new RuntimeError(`import(): files cannot be imported here`, line);
    let shape: Shape3;
    try {
      shape = options.resolveImport(path, { resolution: res });
    } catch (err) {
      throw new RuntimeError(`import("${path}"): ${(err as Error).message}`, line);
    }
    if (size !== undefined) {
      const b = shape.bounds;
      const longest = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      if (longest > 0) {
        const f = size / longest;
        shape = scaleShape(shape, f, f, f);
      }
    }
    return shape;
  }

  function callPose(args: Arg[], scope: Scope, line: number): Value {
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    const nameArg = values.find((v) => !v.name);
    if (!nameArg || typeof nameArg.value !== "string") throw new RuntimeError(`pose(): the first argument is the pose's name, a string; then joint = [x, y, z] degrees per joint`, line);
    const angles: Record<string, [number, number, number]> = {};
    for (const v of values) {
      if (!v.name) continue;
      const a = v.value;
      if (!Array.isArray(a) || a.length !== 3 || a.some((n) => typeof n !== "number"))
        throw new RuntimeError(`pose("${nameArg.value}"): ${v.name} must be [x, y, z] degrees`, line);
      angles[v.name] = [a[0] as number, a[1] as number, a[2] as number];
    }
    const existing = poses.findIndex((p) => p.name === nameArg.value);
    const pose: Pose = { name: nameArg.value, angles, line };
    if (existing >= 0) poses[existing] = pose; else poses.push(pose);
    return nameArg.value;
  }

  function callAnimation(args: Arg[], scope: Scope, line: number): Value {
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    const positional = values.filter((v) => !v.name).map((v) => v.value);
    const name = positional[0];
    const list = positional[1] ?? values.find((v) => v.name === "poses")?.value;
    if (typeof name !== "string" || !Array.isArray(list) || list.some((p) => typeof p !== "string"))
      throw new RuntimeError(`animation(): animation(name, [pose, pose, ...], seconds=1, loop=1)`, line);
    const seconds = values.find((v) => v.name === "seconds")?.value ?? positional[2] ?? 1;
    const loop = values.find((v) => v.name === "loop")?.value ?? 1;
    if (typeof seconds !== "number" || typeof loop !== "number") throw new RuntimeError(`animation(): seconds and loop must be numbers`, line);
    const anim: Animation = { name, poses: list as string[], seconds, loop: loop !== 0, line };
    const existing = animations.findIndex((a) => a.name === name);
    if (existing >= 0) animations[existing] = anim; else animations.push(anim);
    return name;
  }

  function callJoint(args: Arg[], scope: Scope, line: number): Value {
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    const order = ["part", "name", "x", "y", "z"];
    const got: Record<string, Value | undefined> = {};
    let pos = 0;
    for (const v of values) {
      if (v.name) { if (!order.includes(v.name)) throw new RuntimeError(`joint(): no parameter named '${v.name}'`, line); got[v.name] = v.value; }
      else { if (pos >= order.length) throw new RuntimeError(`joint(): too many arguments`, line); got[order[pos++]] = v.value; }
    }
    const part = got.part, name = got.name;
    if (!isShape3(part as Value)) throw new RuntimeError(`joint(): the first argument is the part, a 3D shape\nusage:\n  joint(part, name, x, y, z) -> shape`, line);
    if (typeof name !== "string") throw new RuntimeError(`joint(): name must be a string`, line);
    for (const k of ["x", "y", "z"]) if (typeof got[k] !== "number") throw new RuntimeError(`joint("${name}"): missing '${k}', the pivot in world units`, line);
    const a = options.jointAngles?.[name] ?? [0, 0, 0];
    return jointShape(part as Shape3, name, got.x as number, got.y as number, got.z as number, a);
  }

  function call(callee: string, args: Arg[], scope: Scope, line: number): Value {
    if (callee === "import") return callImport(args, scope, line);
    if (callee === "joint") return callJoint(args, scope, line);
    if (callee === "pose") return callPose(args, scope, line);
    if (callee === "animation") return callAnimation(args, scope, line);
    const user = scope.get(callee);
    if (user !== undefined && isUserFn(user)) return callUser(user, args, scope, line);
    const builtin = BUILTIN_MAP.get(callee);
    if (!builtin) {
      if (user !== undefined) throw new RuntimeError(`'${callee}' is a ${typeName(user)}, not a function`, line);
      throw new RuntimeError(`unknown function '${callee}'${suggest(callee)}`, line);
    }
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    return callBuiltin(builtin, values, line);
  }

  function callUser(fn: UserFn, args: Arg[], scope: Scope, line: number): Value {
    if (depth >= MAX_DEPTH) throw new RuntimeError(`'${fn.name}' recursed more than ${MAX_DEPTH} deep`, line);
    const local = new Scope(global);
    const positional = args.filter((a) => !a.name);
    const named = args.filter((a) => a.name);
    if (positional.length > fn.params.length)
      throw new RuntimeError(`'${fn.name}' takes ${fn.params.length} argument(s) but got ${positional.length}`, line);
    fn.params.forEach((p, i) => {
      const given = i < positional.length ? positional[i] : named.find((a) => a.name === p.name);
      if (given) local.set(p.name, evalExpr(given.value, scope));
      else if (p.default) local.set(p.name, evalExpr(p.default, local));
      else throw new RuntimeError(`'${fn.name}' needs '${p.name}'`, line);
    });
    for (const a of named) if (!fn.params.some((p) => p.name === a.name)) throw new RuntimeError(`'${fn.name}' has no parameter '${a.name}'`, line);
    depth++;
    try {
      return evalExpr(fn.body, local);
    } finally {
      depth--;
    }
  }

  function callBuiltin(b: Builtin, args: { name?: string; value: Value }[], line: number): Value {
    const failures: string[] = [];
    for (const ov of b.overloads) {
      const bound = bind(ov, args);
      if (typeof bound === "string") { failures.push(bound); continue; }
      try {
        return ov.impl(bound.values, bound.rest);
      } catch (err) {
        throw new RuntimeError(`${b.name}(): ${(err as Error).message}`, line);
      }
    }
    // Report only the overloads whose first parameter accepts the first argument (a shape versus a
    // profile), so the message does not also complain about the other kind.
    const first = args.find((a) => !a.name)?.value ?? args[0]?.value;
    const fits = b.overloads.map((o) => first === undefined || o.params.length === 0 || !("error" in coerce(o.params[0], first)));
    const relevant = fits.some(Boolean) ? b.overloads.filter((_, i) => fits[i]) : b.overloads;
    const relevantFailures = fits.some(Boolean) ? failures.filter((_, i) => fits[i]) : failures;
    const sigs = relevant.map((o) => `  ${signature(b.name, o)}`).join("\n");
    const reason = relevantFailures.length === 1 ? relevantFailures[0] : relevantFailures.map((f) => `- ${f}`).join("\n");
    throw new RuntimeError(`${b.name}(): ${reason}\nusage:\n${sigs}`, line);
  }

  /** Bind arguments to an overload's parameters; a string is the reason it does not fit. */
  function bind(ov: Overload, args: { name?: string; value: Value }[]): { values: Value[]; rest: Value[] } | string {
    const values: Value[] = new Array(ov.params.length);
    const rest: Value[] = [];
    const filled = new Array<boolean>(ov.params.length).fill(false);
    const restIndex = ov.params.findIndex((p) => p.rest);
    let pos = 0;
    for (const a of args) {
      if (a.name) {
        const i = ov.params.findIndex((p) => p.name === a.name);
        if (i < 0) return `no parameter named '${a.name}'`;
        const c = coerce(ov.params[i], a.value);
        if ("error" in c) return `${a.name}: ${c.error}`;
        values[i] = c.ok;
        filled[i] = true;
        continue;
      }
      while (pos < ov.params.length && filled[pos]) pos++;
      if (pos < ov.params.length && ov.params[pos].rest) {
        const c = coerce(ov.params[pos], a.value);
        if ("error" in c) {
          // A value of another type after the rest parameter goes to the next positional slot.
          const nextPos = ov.params.findIndex((p, i) => i > pos && !filled[i]);
          if (nextPos < 0) return `too many arguments: ${c.error}`;
          const c2 = coerce(ov.params[nextPos], a.value);
          if ("error" in c2) return `${ov.params[nextPos].name}: ${c2.error}`;
          values[nextPos] = c2.ok;
          filled[nextPos] = true;
          continue;
        }
        rest.push(c.ok);
        continue;
      }
      if (pos >= ov.params.length) return `too many arguments (${args.length} given)`;
      const c = coerce(ov.params[pos], a.value);
      if ("error" in c) return `${ov.params[pos].name}: ${c.error}`;
      values[pos] = c.ok;
      filled[pos] = true;
      pos++;
    }
    for (let i = 0; i < ov.params.length; i++) {
      if (filled[i] || i === restIndex) continue;
      const p = ov.params[i];
      if (p.default === undefined) return `missing '${p.name}'`;
      values[i] = p.default;
    }
    if (restIndex >= 0) values[restIndex] = rest;
    return { values, rest };
  }

  type Coerced = { ok: Value } | { error: string };
  function coerce(p: Param, v: Value): Coerced {
    const ok = (value: Value): Coerced => ({ ok: value });
    const error = (message: string): Coerced => ({ error: message });
    switch (p.type) {
      case "number": return typeof v === "number" ? ok(v) : error(`expected a number, got ${describe(v)}`);
      case "string": return typeof v === "string" ? ok(v) : error(`expected a string, got ${describe(v)}`);
      case "shape": return isShape3(v) ? ok(v) : error(`expected a 3D shape, got ${describe(v)}`);
      case "shape2": return isShape2(v) ? ok(v) : error(`expected a 2D profile, got ${describe(v)}`);
      case "anyshape": return isShape3(v) || isShape2(v) ? ok(v) : error(`expected a shape, got ${describe(v)}`);
      case "list": return Array.isArray(v) ? ok(v) : error(`expected a list, got ${describe(v)}`);
      case "curve": return isCurve(v) ? ok(v) : error(`expected a curve (bezier() or curve()), got ${describe(v)}`);
      case "axis":
        return typeof v === "string" && ["x", "y", "z"].includes(v) ? ok(v) : error(`expected "x", "y" or "z", got ${describe(v)}`);
      case "material":
        try {
          return ok(toMaterial(v));
        } catch (err) {
          return error((err as Error).message);
        }
      case "any": return ok(v);
    }
  }

  function describe(v: Value): string {
    if (typeof v === "number") return `the number ${v}`;
    if (typeof v === "string") return `the string "${v}"`;
    return `a ${typeName(v)}`;
  }

  function suggest(name: string): string {
    const names = [...BUILTIN_MAP.keys()];
    const close = names.filter((n) => n.startsWith(name.slice(0, 3)) || name.startsWith(n.slice(0, 3)));
    return close.length ? ` (did you mean ${close.slice(0, 3).join(", ")}?)` : "";
  }

  function exec(stmt: Stmt, scope: Scope, topLevel: boolean): void {
    switch (stmt.type) {
      case "assign": {
        const collecting = topLevel && reads === undefined;
        if (collecting) reads = new Set();
        const value = evalExpr(stmt.value, scope);
        scope.set(stmt.name, value);
        if (topLevel) {
          const prev = steps.get(stmt.name);
          const deps = new Set(prev?.deps ?? []);
          for (const r of reads ?? []) if (r !== stmt.name) deps.add(r);
          if (prev) {
            prev.value = value;
            prev.deps = deps;
          } else {
            steps.set(stmt.name, { name: stmt.name, value, line: stmt.line, deps });
          }
          if (isShape3(value)) lastShape = { name: stmt.name };
        }
        if (collecting) reads = undefined;
        return;
      }
      case "def":
        scope.set(stmt.name, { kind: "fn", name: stmt.name, params: stmt.params, body: stmt.body });
        return;
      case "for": {
        const iterable = evalExpr(stmt.iterable, scope);
        if (!Array.isArray(iterable)) throw new RuntimeError(`'for' needs a list (use range(n)), got a ${typeName(iterable)}`, stmt.line);
        for (const item of iterable) {
          if (++loops > MAX_LOOP) throw new RuntimeError(`more than ${MAX_LOOP} loop iterations`, stmt.line);
          scope.set(stmt.name, item);
          for (const s of stmt.body) exec(s, scope, topLevel);
        }
        return;
      }
      case "show":
      case "scene": {
        const names: string[] = [];
        const shapes: Shape3[] = [];
        reads = new Set();
        stmt.values.forEach((e, i) => {
          const v = evalExpr(e, scope);
          if (!isShape3(v)) throw new RuntimeError(`${stmt.type} needs a 3D shape, got a ${typeName(v)}`, stmt.line);
          shapes.push(v);
          names.push(e.type === "ident" ? e.name : stmt.type === "scene" ? `object_${i + 1}` : "model");
        });
        const showReads = reads;
        reads = undefined;
        shown = { names, shapes, scene: stmt.type === "scene" };
        showDeps = showReads;
        return;
      }
      case "set": {
        // `set pose reading` and `set focus lid` name things; a bare word there is the name, not a variable read.
        const v = stmt.value.type === "ident" && NAME_SETTINGS.has(stmt.key) ? stmt.value.name : evalExpr(stmt.value, scope);
        if (typeof v !== "number" && typeof v !== "string") throw new RuntimeError(`set ${stmt.key}: expected a number or a string`, stmt.line);
        settings[stmt.key] = v;
        return;
      }
      case "expr": {
        const v = evalExpr(stmt.value, scope);
        if (isShape3(v) || isShape2(v)) warnings.push(`line ${stmt.line}: this shape is computed and thrown away; assign it to a name (name = ...) to keep it`);
        return;
      }
    }
  }

  let showDeps: Set<string> = new Set();
  for (const stmt of program.body) exec(stmt, global, true);

  let output: Shape3 | undefined;
  let outputName = "model";
  let objects: SceneObject[] = [];
  const roots = new Set<string>();
  if (shown) {
    output = shown.shapes.length === 1 ? shown.shapes[0] : union(shown.shapes);
    outputName = shown.scene ? "scene" : shown.names.length === 1 ? shown.names[0] : shown.names.join("+");
    objects = shown.scene ? shown.names.map((name, i) => ({ name, shape: shown!.shapes[i] })) : [{ name: outputName, shape: output }];
    for (const d of showDeps) roots.add(d);
  } else if (lastShape) {
    output = steps.get(lastShape.name)!.value as Shape3;
    outputName = lastShape.name;
    objects = [{ name: outputName, shape: output }];
    roots.add(lastShape.name);
  }
  // Poses and animations must name real joints and poses.
  if (output) {
    const jointNames = new Set(allJoints(output).map((j) => j.joint!.name));
    for (const p of poses)
      for (const j of Object.keys(p.angles))
        if (!jointNames.has(j)) warnings.push(`pose "${p.name}" (line ${p.line}) sets joint "${j}", which is not in the output${jointNames.size ? `; joints: ${[...jointNames].join(", ")}` : ""}`);
    // "rest" is every joint at zero and needs no pose() of its own; a missing pose is named once per animation.
    for (const a of animations)
      for (const pn of new Set(a.poses))
        if (pn !== "rest" && !poses.some((p) => p.name === pn)) warnings.push(`animation "${a.name}" (line ${a.line}) uses pose "${pn}", which is not defined${poses.length ? `; poses: ${poses.map((p) => p.name).join(", ")}` : ""}`);
  }
  const used = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const nme = stack.pop()!;
    if (used.has(nme)) continue;
    used.add(nme);
    const st = steps.get(nme);
    if (st) for (const d of st.deps) stack.push(d);
  }
  const stepList = [...steps.values()];
  for (const st of stepList)
    if (isShape3(st.value) && !used.has(st.name) && output)
      warnings.push(`'${st.name}' (line ${st.line}) is not part of the output; add it to the model or remove it`);

  return { output, outputName, objects, poses, animations, used, steps: stepList, settings, warnings };
}

export function signature(name: string, ov: Overload): string {
  const parts = ov.params.map((p) => {
    const base = p.rest ? `${p.name}...` : p.name;
    if (p.default === undefined || p.rest) return base;
    const d = p.default;
    const shown =
      typeof d === "number" ? (d === -1 || d === -1e9 || Number.isNaN(d) ? undefined : String(d)) : typeof d === "string" ? `"${d}"` : undefined;
    return shown === undefined ? `${base}=?` : `${base}=${shown}`;
  });
  return `${name}(${parts.join(", ")}) -> ${ov.returns}`;
}

export type { Value };
