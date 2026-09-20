/**
 * Evaluates a parsed program to a final shape, recording every top-level
 * assignment along the way. Those records are the "steps": the pipeline
 * renders each so an agent can see how the model was built up, and the
 * report says which steps ended up in the output.
 */
import type { Vec3 } from "../core/vec.js";
import { COMPARE_OPS, exprText, type Arg, type Expr, type Program, type Stmt } from "./ast.js";
import { BUILTIN_MAP, CONSTANTS, CURRENT_ANGLES, CURRENT_POSES, toMaterial } from "./builtins.js";
import { parse } from "./parser.js";
import { union, scale as scaleShape, allJoints, joint as jointShape, placedUnder } from "../sdf/ops.js";
import { regionTouches, voidWitness, outsideWitness, overlapWitness } from "../sdf/measure.js";
import { union2 } from "../sdf/shapes2d.js";
import { difference, intersect } from "../sdf/ops.js";
import { difference2, intersect2 } from "../sdf/shapes2d.js";
import { boundsSize, isEmpty, REST_POSE, type ImageTexture, type JointPose, type Material, type Shape3 } from "../sdf/types.js";
import { isCurve, isMaterial, isShape2, isShape3, isUserFn, isXform, typeName, type Builtin, type Overload, type Param, type UserFn, type Value } from "./values.js";

/** Settings whose value is a name: a bare word after `set` is taken as the name itself. */
const NAME_SETTINGS = new Set(["pose", "focus", "camera", "environment"]);
/** The beauty render's procedural skies; the renderer has the palettes, this list keeps the language pure. */
export const ENVIRONMENT_NAMES = ["studio", "overcast", "sunset", "night"];
const fmt3 = (v: number): string => { const t = v.toFixed(2).replace(/\.?0+$/, ""); return t === "-0" ? "0" : t; };
const dimsLabel = (b: { min: number[]; max: number[] }): string => [0, 1, 2].map((k) => fmt3(b.max[k] - b.min[k])).join(" × ");

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
  /** True when a shape was cut from another while this step was computed: its surface can be a cut face. */
  cuts?: boolean;
  /** The names subtracted while this step was computed: cuts below it, unless another step joins them. */
  cutDeps?: Set<string>;
  /** The steps this one moved (move, rotate, place, ground, ...): their surfaces are elsewhere in this step. */
  movedDeps?: Set<string>;
  /** The steps this one read as they are (joined, cut, painted, shelled, measured): their surface stays put. */
  keptDeps?: Set<string>;
  /** Assigned inside a loop: a number here is the last iteration's, not a size worth listing. */
  inLoop?: boolean;
}

/**
 * What a step is to the output: a `part` of its geometry, a `cut` (subtracted from a part, so its surface is a cut
 * face at most), or a `region` that only an assert, a decal or a camera reads. A step with no role is unused.
 */
export type StepRole = "part" | "cut" | "region";

export interface Settings {
  grid?: number;
  size?: number;
  [key: string]: number | string | undefined;
}

export interface EvalOptions {
  /** Resolve `import("file")` to a shape; the pipeline reads the file. Absent means imports are an error. */
  resolveImport?: (path: string, opts: { resolution: number }) => Shape3;
  /**
   * Resolve `use "path"` to a library's source: `from` is the file of the program doing the using (undefined for
   * the main program), so a library's own uses resolve beside it. Returns the source and an id for the file, which
   * is passed back as `from` for that library's uses. Absent means libraries cannot be used here.
   */
  resolveModule?: (path: string, from?: string) => { source: string; file: string };
  /** The file this program was read from, passed to resolveModule as `from`. */
  moduleFrom?: string;
  /** The pose per joint name for this evaluation. Joints not named are at rest. */
  jointPoses?: Record<string, JointPose>;
  /** The name of that pose, so an `assert ..., pose=name` knows whether this is its evaluation. */
  poseName?: string;
  /** Skip every assert (`--no-asserts`): a pieces() promise on a big rig can cost more than the render. */
  skipAsserts?: boolean;
  /** Load a picture for material(image=) and decal(image=): the file's pixels, or throw with why not. */
  resolveImage?: (path: string) => { width: number; height: number; rgba: Uint8Array };
}

/** A library brought in by `use`: what a program can call from it. */
export interface UsedModule {
  prefix: string;
  path: string;
  /** The exported names: defs and constants (materials, numbers, strings, lists); a library's shapes are its own. */
  names: string[];
}

export interface SceneObject {
  name: string;
  shape: Shape3;
}

/** A light in the beauty render, from `light()`. */
export interface Light {
  name: string;
  /** Degrees about y (0 is +z, the front; 90 is +x) and above the floor. */
  azimuth: number;
  elevation: number;
  /** Apparent size: 0.5 a lamp with crisp shadows, 3 a window. */
  size: number;
  color: [number, number, number];
  /** The colour as written, for the report. */
  colorName: string;
  /** 1 is the default key light's strength. */
  power: number;
  /** A point light: where it is; azimuth and elevation are then unused. */
  position?: [number, number, number];
  /** A point light's reach: its strength halves at this distance from it. */
  range?: number;
  line: number;
}

/** A named shot for the beauty render, from `camera()`; what it leaves out takes the render's own. */
export interface CameraShot {
  name: string;
  azimuth?: number;
  elevation?: number;
  zoom?: number;
  /** A step or object to frame, as `--focus` does. */
  focus?: string;
  dof?: number;
  line: number;
}

export interface Pose {
  name: string;
  /** Joint name to its angles (degrees about x, y, z), move and scale. */
  joints: Record<string, JointPose>;
  line: number;
}

export interface Animation {
  name: string;
  /** Pose names in order; keyframes evenly spaced over `seconds` unless `times` says otherwise. */
  poses: string[];
  seconds: number;
  /** When set, one time in seconds per pose, ascending from 0; the last is `seconds`. */
  times?: number[];
  /** 0 is linear between poses; 1 is a full ease in and out at every keyframe. */
  ease: number;
  /** The ease at the first and last keyframe alone: 0 runs straight through the ends of a loop or a one-shot. */
  easeEnds: number;
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
  /** The beauty render's lights, in order; none means the one default key light (or the light_* settings). */
  lights: Light[];
  /** Named shots for the beauty render, each written as beauty_<name>.png. */
  cameras: CameraShot[];
  /** What the output was called: the shown name(s), or the last assignment. */
  outputName: string;
  /** Names the output depends on, transitively (itself included): the parts and the cuts. */
  used: Set<string>;
  /** Each step's role; a step missing here is unused. */
  roles: Map<string, StepRole>;
  /** Steps every reader of which moved them (built at the origin, then placed): their surface is not where they are. */
  displaced: Set<string>;
  steps: Step[];
  /** The libraries this program uses, in order. */
  modules: UsedModule[];
  /** The program's own top-level defs, in order: what it exports when used as a library. */
  defs: UserFn[];
  settings: Settings;
  warnings: string[];
  /** Every assert the program ran, in order, passed or not; a used library's come first with its path. */
  asserts: AssertResult[];
  /** The pictures the program painted with, for the report. */
  images: ImageUse[];
}

/** A picture a material or a decal uses. */
export interface ImageUse {
  name: string;
  width: number;
  height: number;
  projection: ImageTexture["projection"];
  /** The picture's width (or height, wrapped) in units, or the box it was fitted to. */
  size: string;
  line: number;
}

export interface AssertResult {
  line: number;
  /** The tested expression as text: `clearance(handle, rim) > 0.05`. */
  text: string;
  /** For a comparison, the two sides as evaluated: `0.031 > 0.05`. */
  detail?: string;
  message?: string;
  passed: boolean;
  /** The library file the assert is in, when it is not the program's own. */
  file?: string;
  /** The pose the assert is for (`pose=name`); none for a promise about the model at rest. */
  pose?: string;
  /** True when this evaluation is not the assert's pose, so it was not tested here. */
  pending?: boolean;
  /** Where a void, inside or overlap query found the offending point, and in which step, for a failure. */
  where?: string;
}

/** One line for a failed assert, the same in `check`, the render's warnings and the report. */
export function assertLine(a: AssertResult): string {
  return `${a.file ? `${a.file}: ` : ""}assert (line ${a.line})${a.pose ? ` in pose ${a.pose}` : ""} fails: ${a.text}${a.detail ? ` is ${a.detail}` : ""}${a.where ? `, ${a.where}` : ""}${a.message ? `: ${a.message}` : ""}`;
}

/** The builtins that move a shape's surface somewhere else: a step read only through one is not where it was built. */
const MOVERS = new Set(["move", "rotate", "scale", "array", "grid", "ring", "ground", "center", "place", "attach", "twist", "bend", "wrap"]);

/** The builtins that measure a shape, so in a pose they read a nested step where the pose put it. */
const POSED_QUERIES = new Set(["height", "top", "bottom", "width", "depth", "tall", "clearance", "void", "overlap", "inside", "at", "surface", "pieces", "overhang"]);

/** One line for a passing assert with the numbers it saw, for `check`. */
export function assertPassLine(a: AssertResult): string {
  return `${a.file ? `${a.file}: ` : ""}assert (line ${a.line})${a.pose ? ` in pose ${a.pose}` : ""} holds: ${a.text}${a.detail ? ` is ${a.detail}` : ""}${a.message ? `: ${a.message}` : ""}`;
}

const MAX_LOOP = 20000;
const MAX_DEPTH = 64;

class Scope {
  private vars = new Map<string, Value>();
  /** On a root scope: the libraries its program used, so a library's defs reach the library's own uses. */
  modules?: Map<string, { path: string; exports: Map<string, Value> }>;
  constructor(private readonly parent?: Scope) {}
  root(): Scope {
    return this.parent ? this.parent.root() : this;
  }
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
  // angle(name) reads the pose being evaluated.
  CURRENT_ANGLES.clear();
  CURRENT_POSES.clear();
  for (const [name, v] of Object.entries(options.jointPoses ?? {})) { CURRENT_ANGLES.set(name, v.angles); CURRENT_POSES.set(name, v); }
  const global = new Scope();
  for (const [k, v] of Object.entries(CONSTANTS)) global.set(k, v);
  const steps = new Map<string, Step>();
  const settings: Settings = {};
  // Whether this evaluation is a pose: any joint given a pose that is not rest.
  const posed = Object.values(options.jointPoses ?? {}).some((j) => j.angles.some((v) => v !== 0) || j.move.some((v) => v !== 0) || j.scale.some((v) => v !== 1));
  // Inside an assert's test, where a query in a pose reads a step where the pose put it; geometry built from a
  // query keeps the step's own frame, since it is built inside that frame.
  let assertDepth = 0;
  // Names subtracted from a shape (`a - b`, difference(a, b)), and names only read as a region (an assert, a decal's
  // region, a camera's focus): they are not parts of the output and the unused warning leaves them alone.
  const cutNames = new Set<string>();
  const regionNames = new Set<string>();
  // The decal regions among them: a dep of a part through decal() is a region, not a part.
  const decalRegions = new Set<string>();
  // The step being computed at top level, to note a cut in it.
  let currentStep: Step | undefined;
  // How many loops the statement being run is inside.
  let loopDepth = 0;
  // Each top-level shape step by its value, so a transform of exactly that value is known to move the step.
  const stepOfValue = new Map<Shape3, string>();
  // Where the last void, inside or overlap query in an assert found its offending point.
  let witness: string | undefined;
  // The shown shape, set once the program has run; a root for placing a measured step.
  let output: Shape3 | undefined;
  const warnings: string[] = [...(program.warnings ?? [])];
  const asserts: AssertResult[] = [];
  const shadowed = new Set<string>();
  // "pose:joint" for every pose value given as one number rather than a triple.
  const singles = new Set<string>();
  let shown: { names: string[]; shapes: Shape3[]; scene: boolean } | undefined;
  const poses: Pose[] = [];
  const animations: Animation[] = [];
  const lights: Light[] = [];
  const cameras: CameraShot[] = [];
  const images: ImageUse[] = [];
  const imageCache = new Map<string, { width: number; height: number; rgba: Uint8Array }>();
  /** A picture by path, loaded once per evaluation. */
  const loadImage = (path: string, line: number): { width: number; height: number; rgba: Uint8Array } => {
    if (!options.resolveImage) throw new RuntimeError(`image "${path}": pictures cannot be loaded here`, line);
    let img = imageCache.get(path);
    if (!img) {
      try { img = options.resolveImage(path); } catch (err) { throw new RuntimeError(`image "${path}": ${(err as Error).message}`, line); }
      imageCache.set(path, img);
    }
    return img;
  };
  let lastShape: { name: string } | undefined;
  let depth = 0;
  let loops = 0;
  /** Libraries by prefix: each name maps to a def or a constant from the library's top level. */
  const modules = new Map<string, { path: string; exports: Map<string, Value> }>();
  global.modules = modules;
  const moduleList: UsedModule[] = [];
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
      case "index": {
        const target = evalExpr(e.target, scope);
        const i = evalExpr(e.index, scope);
        if (!Array.isArray(target)) throw new RuntimeError(`[...] indexes a list, not a ${typeName(target)}`, e.line);
        if (typeof i !== "number" || !Number.isInteger(i)) throw new RuntimeError(`a list index must be a whole number`, e.line);
        const k = i < 0 ? target.length + i : i;
        if (k < 0 || k >= target.length) throw new RuntimeError(`index ${i} is outside the list, which has ${target.length} item${target.length === 1 ? "" : "s"}`, e.line);
        return target[k];
      }
      case "ident": {
        if (e.name.includes(".")) return fromModule(e.name, e.line, scope);
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
      case "binary": {
        const l = evalExpr(e.left, scope), r = evalExpr(e.right, scope);
        if (currentStep) for (const v of [l, r]) if (isShape3(v)) { const nm = stepOfValue.get(v); if (nm) (currentStep.keptDeps ??= new Set()).add(nm); }
        if (e.op === "-" && isShape3(r)) { if (e.right.type === "ident") noteCut(e.right.name); if (currentStep) currentStep.cuts = true; }
        return binary(e.op, l, r, e.line);
      }
      case "call":
        return call(e.callee, e.args, scope, e.line);
    }
  }

  function binary(op: string, a: Value, b: Value, line: number): Value {
    if ((COMPARE_OPS as readonly string[]).includes(op)) return compare(op, a, b, line);
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
    // A name per copy from a def's index: "gondola_" + i (round 8).
    if (op === "+" && ((typeof a === "string" && typeof b === "number") || (typeof a === "number" && typeof b === "string"))) return String(a) + String(b);
    if (Array.isArray(a) && Array.isArray(b) && op === "+") return [...a, ...b];
    if (isShape3(a) && isShape3(b)) {
      switch (op) {
        case "+": return union([a, b]);
        case "-": return difference(a, b);
        case "&": {
          const r = intersect(a, b);
          // An intersection that removes everything is usually a precedence slip (`a | move(...) & b | move(...)`),
          // and nothing downstream will say so: the part is simply not there (measured on a crate of lemons).
          if (isEmpty(r.bounds) && !isEmpty(a.bounds) && !isEmpty(b.bounds))
            warnings.push(`line ${line}: '&' removed everything: the two shapes do not overlap (${dimsLabel(a.bounds)} at ${a.bounds.min.map(fmt3).join(", ")} and ${dimsLabel(b.bounds)} at ${b.bounds.min.map(fmt3).join(", ")}). '|' binds tighter than '&', so check the parentheses.`);
          return r;
        }
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

  // A comparison is a number, 1 or 0: what assert tests, and what min()/max() can weigh. Numbers compare as
  // numbers, strings as strings for == and !=; anything else is a mistake worth naming.
  function compare(op: string, a: Value, b: Value, line: number): number {
    if (typeof a === "number" && typeof b === "number") {
      switch (op) {
        case "<": return a < b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "==": return a === b ? 1 : 0;
        case "!=": return a !== b ? 1 : 0;
      }
    }
    if (typeof a === "string" && typeof b === "string" && (op === "==" || op === "!=")) return (a === b) === (op === "==") ? 1 : 0;
    throw new RuntimeError(`'${op}' compares two numbers${op === "==" || op === "!=" ? " or two strings" : ""}, not a ${typeName(a)} and a ${typeName(b)}${isShape3(a) || isShape3(b) ? "; measure the shape first (width, tall, pieces, clearance, ...)" : ""}`, line);
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
    if (!nameArg || typeof nameArg.value !== "string") throw new RuntimeError(`pose(): the first argument is the pose's name, a string; then joint = [x, y, z] degrees or joint = xform(...) per joint`, line);
    const joints: Record<string, JointPose> = {};
    // `from="reach"` starts from another pose's joints, so a grip closing at the end of a reach is one line rather
    // than the reach's joints written again (round 8: a pose rests every joint it does not name, so an animation
    // through a fingers-only pose swung the arm back to rest between its keys).
    const from = values.find((v) => v.name === "from");
    if (from) {
      if (typeof from.value !== "string") throw new RuntimeError(`pose("${nameArg.value}"): from= names a pose defined above, as a string`, line);
      const base = poses.find((p) => p.name === from.value);
      if (!base && from.value !== "rest") throw new RuntimeError(`pose("${nameArg.value}"): from="${from.value}" names no pose defined above${poses.length ? ` (poses so far: ${poses.map((p) => p.name).join(", ")})` : ""}`, line);
      if (base) for (const [j, jp] of Object.entries(base.joints)) joints[j] = { angles: [...jp.angles], move: [...jp.move], scale: [...jp.scale] };
      for (const key of [...singles]) if (base && key.startsWith(`${base.name}:`)) singles.add(`${nameArg.value}:${key.slice(base.name.length + 1)}`);
    }
    for (const v of values) {
      if (!v.name || v.name === "from") continue;
      const a = v.value;
      // One number is an angle about the joint's axis (a joint declared with axis=); it is checked against the joint below.
      if (typeof a === "number") { joints[v.name] = { ...REST_POSE, angles: [a, 0, 0] }; singles.add(`${nameArg.value}:${v.name}`); continue; }
      if (isXform(a)) {
        joints[v.name] = { angles: [...a.angles], move: [...a.move], scale: [...a.scale] };
        if (a.single) singles.add(`${nameArg.value}:${v.name}`);
        continue;
      }
      if (!Array.isArray(a) || a.length !== 3 || a.some((n) => typeof n !== "number"))
        throw new RuntimeError(`pose("${nameArg.value}"): ${v.name} must be [x, y, z] degrees, one angle for a joint with axis=, or xform(rotate=, move=, scale=)`, line);
      joints[v.name] = { ...REST_POSE, angles: [a[0] as number, a[1] as number, a[2] as number] };
    }
    const existing = poses.findIndex((p) => p.name === nameArg.value);
    const pose: Pose = { name: nameArg.value, joints, line };
    if (existing >= 0) poses[existing] = pose; else poses.push(pose);
    return nameArg.value;
  }

  function callWithImage(callee: string, builtin: Builtin, values: { name?: string; value: Value }[], line: number): Value {
    const path = values.find((v) => v.name === "image")!.value;
    if (typeof path !== "string") throw new RuntimeError(`${callee}(): image is a file name, a string`, line);
    const projArg = values.find((v) => v.name === "projection")?.value;
    const rest = values.filter((v) => v.name !== "image" && v.name !== "projection");
    const px = loadImage(path, line);
    const name = path.replace(/^.*[\\/]/, "");
    if (callee === "material") {
      if (projArg !== undefined && (typeof projArg !== "string" || !["planar", "cylindrical", "spherical"].includes(projArg))) throw new RuntimeError(`material(): projection is "planar", "cylindrical" or "spherical"`, line);
      const projection = (projArg as ImageTexture["projection"] | undefined) ?? "planar";
      const base = callBuiltin(builtin, rest, line) as Material;
      const image: ImageTexture = { name, width: px.width, height: px.height, rgba: px.rgba, projection, axis: base.axis, size: base.scale > 0 ? base.scale : 1 };
      images.push({ name, width: px.width, height: px.height, projection, size: `${image.size} units wide, along ${base.axis}`, line });
      return { ...base, name: `${name}`, pattern: "solid", image };
    }
    if (projArg !== undefined) throw new RuntimeError(`decal(): a picture on a decal is fitted to its region; there is no projection= here`, line);
    // decal(shape, region, image=): a white base the picture paints over, fitted to the region's box.
    const positional = rest.filter((v) => !v.name);
    if (positional.length < 2 || !isShape3(positional[0].value) || !isShape3(positional[1].value)) throw new RuntimeError(`decal(): decal(shape, region, image="file.png")`, line);
    const region = positional[1].value as Shape3;
    if (isEmpty(region.bounds)) throw new RuntimeError(`decal(): the region is empty, so there is nothing to fit the picture to`, line);
    const size3 = boundsSize(region.bounds);
    const image: ImageTexture = { name, width: px.width, height: px.height, rgba: px.rgba, projection: "box", axis: "y", size: 1, box: region.bounds };
    const white = toMaterial("white");
    const mat: Material = { ...white, name, image };
    images.push({ name, width: px.width, height: px.height, projection: "box", size: `fitted to a ${size3.map((v) => Number(v.toPrecision(3))).join(" × ")} region`, line });
    return callBuiltin(builtin, [positional[0], positional[1], { value: mat }], line);
  }

  function callLight(args: Arg[], scope: Scope, line: number): Value {
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    const nameArg = values.find((v) => !v.name);
    if (!nameArg || typeof nameArg.value !== "string") throw new RuntimeError(`light(): light(name, azimuth=-40, elevation=55, size=1, color="white", power=1), or light(name, position=[x, y, z], range=2, ...)`, line);
    const name = nameArg.value;
    for (const v of values) if (v.name && !["azimuth", "elevation", "size", "color", "power", "position", "range"].includes(v.name)) throw new RuntimeError(`light("${name}"): no parameter named '${v.name}'; it takes azimuth, elevation, size, color and power, or position and range for a point light`, line);
    const num = (key: string, def: number): number => {
      const v = values.find((x) => x.name === key)?.value ?? def;
      if (typeof v !== "number") throw new RuntimeError(`light("${name}"): ${key} is a number`, line);
      return v;
    };
    const azimuth = num("azimuth", -40), elevation = num("elevation", 55), size = num("size", 1), power = num("power", 1);
    if (size <= 0) throw new RuntimeError(`light("${name}"): size is the light's apparent size, above 0 (0.5 a lamp, 3 a window)`, line);
    if (power < 0) throw new RuntimeError(`light("${name}"): power is 0 or more (1 is the default key light)`, line);
    if (elevation < -90 || elevation > 90) throw new RuntimeError(`light("${name}"): elevation is degrees above the floor, -90 to 90`, line);
    const colorV = values.find((x) => x.name === "color")?.value ?? "white";
    let color: [number, number, number], colorName: string;
    try { const m = toMaterial(colorV); color = [m.color[0], m.color[1], m.color[2]]; colorName = typeof colorV === "string" ? colorV : m.name; } catch (err) { throw new RuntimeError(`light("${name}"): color: ${(err as Error).message}`, line); }
    // A point light: at a place, reaching `range`; a campfire's warmth on the stones round it (round 9 asked).
    const posV = values.find((x) => x.name === "position")?.value;
    let position: [number, number, number] | undefined, range: number | undefined;
    if (posV !== undefined) {
      if (!Array.isArray(posV) || posV.length !== 3 || !posV.every((v) => typeof v === "number")) throw new RuntimeError(`light("${name}"): position is [x, y, z]`, line);
      position = [posV[0] as number, posV[1] as number, posV[2] as number];
      range = num("range", 2);
      if (range <= 0) throw new RuntimeError(`light("${name}"): range is the distance at which the light's strength halves, above 0`, line);
      if (values.some((x) => x.name === "azimuth" || x.name === "elevation")) warnings.push(`light("${name}") (line ${line}): a point light is at its position; azimuth and elevation are ignored`);
    } else if (values.some((x) => x.name === "range")) throw new RuntimeError(`light("${name}"): range goes with position=[x, y, z]; a light with no position is a direction`, line);
    const lightDef: Light = { name, azimuth, elevation, size, color, colorName, power, position, range, line };
    const existing = lights.findIndex((l) => l.name === name);
    if (existing >= 0) lights[existing] = lightDef; else lights.push(lightDef);
    return name;
  }

  function callCamera(args: Arg[], scope: Scope, line: number): Value {
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    const nameArg = values.find((v) => !v.name);
    if (!nameArg || typeof nameArg.value !== "string") throw new RuntimeError(`camera(): camera(name, azimuth=35, elevation=25, zoom=1, focus="step", dof=0)`, line);
    const name = nameArg.value;
    for (const v of values) if (v.name && !["azimuth", "elevation", "zoom", "focus", "dof"].includes(v.name)) throw new RuntimeError(`camera("${name}"): no parameter named '${v.name}'; it takes azimuth, elevation, zoom, focus and dof`, line);
    const num = (key: string): number | undefined => {
      const v = values.find((x) => x.name === key)?.value;
      if (v !== undefined && typeof v !== "number") throw new RuntimeError(`camera("${name}"): ${key} is a number`, line);
      return v as number | undefined;
    };
    const shot: CameraShot = { name, azimuth: num("azimuth"), elevation: num("elevation"), zoom: num("zoom"), dof: num("dof"), line };
    if (shot.zoom !== undefined && shot.zoom <= 0) throw new RuntimeError(`camera("${name}"): zoom is above 0 (1 fits the model, 1.4 fills the frame)`, line);
    if (shot.dof !== undefined && shot.dof < 0) throw new RuntimeError(`camera("${name}"): dof is 0 or more`, line);
    const focus = values.find((x) => x.name === "focus")?.value;
    if (focus !== undefined) {
      if (typeof focus !== "string") throw new RuntimeError(`camera("${name}"): focus names a step or object, as a string`, line);
      shot.focus = focus;
    }
    const existing = cameras.findIndex((c) => c.name === name);
    if (existing >= 0) cameras[existing] = shot; else cameras.push(shot);
    return name;
  }

  function callAnimation(args: Arg[], scope: Scope, line: number): Value {
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    const positional = values.filter((v) => !v.name).map((v) => v.value);
    const name = positional[0];
    const list = positional[1] ?? values.find((v) => v.name === "poses")?.value;
    if (typeof name !== "string" || !Array.isArray(list) || list.some((p) => typeof p !== "string"))
      throw new RuntimeError(`animation(): animation(name, [pose, pose, ...], seconds=1, loop=1, times=[...], ease=0)`, line);
    for (const v of values) if (v.name && !["poses", "seconds", "loop", "times", "ease", "ease_ends"].includes(v.name)) throw new RuntimeError(`animation("${name}"): no parameter named '${v.name}'; it takes poses, seconds, loop, times, ease and ease_ends`, line);
    let seconds = values.find((v) => v.name === "seconds")?.value ?? positional[2] ?? 1;
    const loop = values.find((v) => v.name === "loop")?.value ?? 1;
    const ease = values.find((v) => v.name === "ease")?.value ?? 0;
    const easeEnds = values.find((v) => v.name === "ease_ends")?.value ?? ease;
    if (typeof seconds !== "number" || typeof loop !== "number") throw new RuntimeError(`animation("${name}"): seconds and loop must be numbers`, line);
    if (typeof ease !== "number" || ease < 0 || ease > 1) throw new RuntimeError(`animation("${name}"): ease is a number from 0 (linear) to 1 (a full ease in and out at every pose)`, line);
    if (typeof easeEnds !== "number" || easeEnds < 0 || easeEnds > 1) throw new RuntimeError(`animation("${name}"): ease_ends is a number from 0 to 1, the ease at the first and last pose (ease by default)`, line);
    let times: number[] | undefined;
    const t = values.find((v) => v.name === "times")?.value;
    if (t !== undefined) {
      if (!Array.isArray(t) || t.some((x) => typeof x !== "number")) throw new RuntimeError(`animation("${name}"): times must be a list of seconds, one per pose`, line);
      times = t as number[];
      if (times.length !== list.length) throw new RuntimeError(`animation("${name}"): times has ${times.length} entries for ${list.length} poses; it needs one per pose`, line);
      if (times[0] !== 0) throw new RuntimeError(`animation("${name}"): times must start at 0 (the first pose is the start)`, line);
      for (let i = 1; i < times.length; i++) if (times[i] <= times[i - 1]) throw new RuntimeError(`animation("${name}"): times must increase; ${times[i - 1]} is followed by ${times[i]}`, line);
      // The last time is the length: seconds= is not needed with times=, and must agree when given.
      const last = times[times.length - 1];
      if (values.some((v) => v.name === "seconds") || positional[2] !== undefined) {
        if (Math.abs((seconds as number) - last) > 1e-9) throw new RuntimeError(`animation("${name}"): seconds=${seconds} but times ends at ${last}; with times= the last time is the length, so leave seconds out`, line);
      }
      seconds = last;
    }
    if ((seconds as number) <= 0) throw new RuntimeError(`animation("${name}"): seconds must be positive`, line);
    const anim: Animation = { name, poses: list as string[], seconds: seconds as number, times, ease, easeEnds, loop: loop !== 0, line };
    const existing = animations.findIndex((a) => a.name === name);
    if (existing >= 0) animations[existing] = anim; else animations.push(anim);
    return name;
  }

  function callJoint(args: Arg[], scope: Scope, line: number): Value {
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    const order = ["part", "name", "x", "y", "z", "axis"];
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
    const jp = options.jointPoses?.[name] ?? REST_POSE;
    let axis: [number, number, number] | undefined;
    if (got.axis !== undefined) {
      const ax = got.axis;
      if (!Array.isArray(ax) || ax.length !== 3 || ax.some((n) => typeof n !== "number") || Math.hypot(...(ax as number[])) === 0)
        throw new RuntimeError(`joint("${name}"): axis must be a direction [x, y, z] (e.g. [cos(72), sin(72), 0] for a head tube raked 18 degrees)`, line);
      axis = [ax[0] as number, ax[1] as number, ax[2] as number];
    }
    return jointShape(part as Shape3, name, got.x as number, got.y as number, got.z as number, jp.angles, axis, jp.move, jp.scale);
  }

  /** `prefix.name` from a used library: its def or constant, with the message naming what the library has. */
  function fromModule(dotted: string, line: number, scope: Scope): Value {
    const dot = dotted.indexOf(".");
    const prefix = dotted.slice(0, dot), name = dotted.slice(dot + 1);
    // Resolved against the libraries of the program the code was written in: a library's def, called from a
    // program that used it under another name, still finds the library's own uses.
    const table = scope.root().modules ?? modules;
    const mod = table.get(prefix);
    if (!mod) {
      const known = [...table.keys()];
      throw new RuntimeError(`'${prefix}' is not a used library${known.length ? ` (used: ${known.join(", ")})` : ""}; add use "${prefix}.aix" or use "std/${prefix}" first`, line);
    }
    const v = mod.exports.get(name);
    if (v === undefined) throw new RuntimeError(`'${mod.path}' has no '${name}'; it has ${[...mod.exports.keys()].join(", ") || "nothing exported"}`, line);
    reads?.add(dotted);
    return v;
  }

  function call(callee: string, args: Arg[], scope: Scope, line: number): Value {
    if (callee.includes(".")) {
      const v = fromModule(callee, line, scope);
      if (!isUserFn(v)) throw new RuntimeError(`'${callee}' is a ${typeName(v)}, not a function`, line);
      return callUser(v, args, scope, line);
    }
    if (callee === "import") return callImport(args, scope, line);
    if (callee === "joint") return callJoint(args, scope, line);
    if (callee === "pose") return callPose(args, scope, line);
    if (callee === "animation") return callAnimation(args, scope, line);
    if (callee === "light") return callLight(args, scope, line);
    if (callee === "camera") return callCamera(args, scope, line);
    const user = scope.get(callee);
    if (user !== undefined && isUserFn(user)) return callUser(user, args, scope, line);
    const builtin = BUILTIN_MAP.get(callee);
    // A step called `top` and a call to top(...) in the same program read as one thing and are two; the call still
    // reaches the builtin, and the program says so once (round 4 asked; a name alone, never called, is fine).
    if (builtin && user !== undefined && !shadowed.has(callee)) {
      shadowed.add(callee);
      warnings.push(`line ${line}: ${callee}(...) calls the builtin, but '${callee}' is also a step in this program; rename the step so the two do not read as one.`);
    }
    if (!builtin) {
      if (user !== undefined) throw new RuntimeError(`'${callee}' is a ${typeName(user)}, not a function`, line);
      throw new RuntimeError(`unknown function '${callee}'${suggest(callee)}`, line);
    }
    const values = args.map((a) => ({ name: a.name, value: evalExpr(a.value, scope) }));
    // A step built at the origin and moved into place by a later step has its surface there, not at its own
    // place: noted per reader, so the callouts label the placed step and not the campfire that happens to sit
    // where the unplaced one was (round 9).
    if (currentStep) {
      for (const v of values) {
        if (!isShape3(v.value)) continue;
        if (MOVERS.has(callee) && v === values[0]) {
          // Every step inside what is moved goes with it: `(seat + feet) | move(...)` moves the seat, which the
          // union had just read as it is.
          const step = currentStep;
          const seen = new Set<Shape3>();
          const walk = (s: Shape3, depth: number) => {
            if (seen.has(s) || depth > 64) return;
            seen.add(s);
            const name = stepOfValue.get(s);
            if (name) { (step.movedDeps ??= new Set()).add(name); step.keptDeps?.delete(name); }
            for (const c of s.inner ?? []) walk(c, depth + 1);
          };
          walk(v.value, 0);
        } else {
          const name = stepOfValue.get(v.value);
          if (name) (currentStep.keptDeps ??= new Set()).add(name);
        }
      }
    }
    if (callee === "difference" && args.length >= 2 && !args[1].name && args[1].value.type === "ident") noteCut(args[1].value.name);
    if (callee === "difference" && currentStep) currentStep.cuts = true;
    if (callee === "decal" && args.length >= 2 && !args[1].name && args[1].value.type === "ident") { regionNames.add(args[1].value.name); decalRegions.add(args[1].value.name); }
    if (assertDepth > 0) for (const a of args) if (!a.name && a.value.type === "ident") regionNames.add(a.value.name);
    // A picture on a material: material(..., image="label.png", projection="planar") loads the file and paints it
    // in place of a pattern; decal(shape, region, image="logo.png") fits it to the region's box.
    if ((callee === "material" || callee === "decal") && values.some((v) => v.name === "image")) return callWithImage(callee, builtin, values, line);
    // In a pose, a query measures a step where the pose put it: the shape is read through the joints and transforms
    // above it in the output, or in the newest step that holds it (round 8: clearance on a nested wrist in a tucked
    // pose measured the rest position and the promise passed for the wrong reason).
    if (POSED_QUERIES.has(callee) && posed && assertDepth > 0) {
      const roots = [...(output ? [output] : []), ...[...steps.values()].map((st) => st.value).filter(isShape3).reverse()];
      for (const v of values) if (isShape3(v.value)) v.value = placedUnder(roots, v.value);
    }
    // pieces() counts at the program's grid unless told otherwise, so a promise made at rest and the report's Pieces
    // row see the same cells (round 8: the default 64 flipped a promise the report at grid 220 did not).
    if ((callee === "pieces" || callee === "overhang") && values.length === 1 && typeof settings.grid === "number") values.push({ name: "resolution", value: settings.grid });
    const result = callBuiltin(builtin, values, line);
    // A failing void, inside or overlap says where (round 9: three agents bisected a bare 0 by hand).
    if (assertDepth > 0 && (callee === "void" || callee === "inside" || callee === "overlap") && values.length >= 2 && isShape3(values[0].value) && isShape3(values[1].value)) {
      const a = values[0].value, b = values[1].value;
      const p = callee === "void" ? voidWitness(a, b) : callee === "inside" ? outsideWitness(a, b) : result === 0 ? undefined : overlapWitness(a, b);
      if (p) {
        const at = `(${p.map(fmt3).join(", ")})`;
        const first = args[0].value, second = args[1].value;
        const what = callee === "void" ? `solid at ${at}${stepAt(p, [a, b])}` : callee === "inside" ? `${exprText(first)} is outside ${exprText(second)} at ${at}` : `they overlap at ${at}`;
        witness = what;
      }
    }
    // A decal whose region misses the surface paints nothing, and a picture cannot say why (round 8: a tag region
    // beside the wrong part).
    if (callee === "decal" && values.length >= 2 && isShape3(values[0].value) && isShape3(values[1].value) && !regionTouches(values[0].value, values[1].value))
      warnings.push(`line ${line}: decal(): the region \`${exprText(args[1].value)}\` touches none of the shape's surface, so it paints nothing; the region must cross the surface (a sphere centred on the skin, a box through it)`);
    return result;
  }

  function callUser(fn: UserFn, args: Arg[], scope: Scope, line: number): Value {
    if (depth >= MAX_DEPTH) throw new RuntimeError(`'${fn.name}' recursed more than ${MAX_DEPTH} deep`, line);
    const local = new Scope((fn.closure as Scope | undefined) ?? global);
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
        const msg = (err as Error).message;
        throw new RuntimeError(msg.startsWith(`${b.name}(): `) ? msg : `${b.name}(): ${msg}`, line);
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

  /** A name subtracted from a shape: a cut for the step being computed, and never named as where a void failed. */
  function noteCut(name: string): void {
    cutNames.add(name);
    if (!currentStep) return;
    currentStep.cuts = true;
    (currentStep.cutDeps ??= new Set()).add(name);
  }

  /** The innermost named part with solid at `p`, as " in 'name'", for a failed void; none when no step holds it. */
  function stepAt(p: Vec3, exclude: Shape3[]): string {
    const roots = posed ? [...(output ? [output] : []), ...[...steps.values()].map((st) => st.value).filter(isShape3).reverse()] : [];
    let best: string | undefined, bv = Infinity;
    for (const st of steps.values()) {
      if (!isShape3(st.value) || exclude.includes(st.value) || cutNames.has(st.name) || regionNames.has(st.name) || isEmpty(st.value.bounds)) continue;
      const s = posed ? placedUnder(roots, st.value) : st.value;
      const b = s.bounds;
      if (p[0] < b.min[0] || p[0] > b.max[0] || p[1] < b.min[1] || p[1] > b.max[1] || p[2] < b.min[2] || p[2] > b.max[2]) continue;
      if (s.dist(p[0], p[1], p[2]) > 0) continue;
      const v = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
      if (v < bv) { bv = v; best = st.name; }
    }
    return best ? ` in '${best}'` : "";
  }

  function exec(stmt: Stmt, scope: Scope, topLevel: boolean): void {
    switch (stmt.type) {
      case "assign": {
        const collecting = topLevel && reads === undefined;
        if (collecting) reads = new Set();
        // A cut made while this step is computed (inside a def it calls too) marks the step: its surface can be a cut face.
        const outerStep = currentStep;
        const here: Step = { name: stmt.name, value: 0, line: stmt.line, deps: new Set() };
        if (topLevel) currentStep = here;
        let value: Value;
        try { value = evalExpr(stmt.value, scope); } finally { currentStep = outerStep; }
        const cutHere = topLevel && here.cuts === true;
        const cutDeps = topLevel ? here.cutDeps : undefined;
        const movedDeps = topLevel ? here.movedDeps : undefined;
        const keptDeps = topLevel ? here.keptDeps : undefined;
        // A material made by material(...) takes the name it is assigned to, so the report's materials row and the
        // exports say "body" rather than "custom" or "#e9b125" (round 4 asked).
        if (topLevel && isMaterial(value) && (value.name === "custom" || value.name.endsWith("*") || value.name.startsWith("#")) && !steps.has(stmt.name))
          value = { ...value, name: stmt.name };
        scope.set(stmt.name, value);
        if (topLevel) {
          const prev = steps.get(stmt.name);
          const deps = new Set(prev?.deps ?? []);
          for (const r of reads ?? []) if (r !== stmt.name) deps.add(r);
          if (prev) {
            prev.value = value;
            prev.deps = deps;
            if (cutHere) prev.cuts = true;
            if (cutDeps) prev.cutDeps = new Set([...(prev.cutDeps ?? []), ...cutDeps]);
            if (movedDeps) prev.movedDeps = new Set([...(prev.movedDeps ?? []), ...movedDeps]);
            if (keptDeps) prev.keptDeps = new Set([...(prev.keptDeps ?? []), ...keptDeps]);
            if (loopDepth > 0) prev.inLoop = true;
          } else {
            steps.set(stmt.name, { name: stmt.name, value, line: stmt.line, deps, cuts: cutHere || undefined, cutDeps, movedDeps, keptDeps, inLoop: loopDepth > 0 || undefined });
          }
          if (isShape3(value)) { lastShape = { name: stmt.name }; stepOfValue.set(value, stmt.name); }
        }
        if (collecting) reads = undefined;
        return;
      }
      case "def":
        scope.set(stmt.name, { kind: "fn", name: stmt.name, params: stmt.params, body: stmt.body, closure: global });
        return;
      case "use": {
        if (!topLevel) throw new RuntimeError(`use belongs at the top of the program, not inside a loop`, stmt.line);
        if (!options.resolveModule) throw new RuntimeError(`use "${stmt.path}": libraries cannot be used here`, stmt.line);
        const prefix = stmt.alias ?? stmt.path.replace(/\.aix$/, "").replace(/^.*\//, "");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new RuntimeError(`use "${stmt.path}": '${prefix}' is not a name; give the library one with as`, stmt.line);
        if (modules.has(prefix)) throw new RuntimeError(`use "${stmt.path}": '${prefix}' is already a used library; give this one another name with as`, stmt.line);
        if (BUILTIN_MAP.has(prefix) || global.has(prefix)) warnings.push(`line ${stmt.line}: library '${prefix}' has the same name as a ${BUILTIN_MAP.has(prefix) ? "builtin" : "step"}; ${prefix}.name still reaches the library, but read it as such`);
        let resolved: { source: string; file: string };
        try {
          resolved = options.resolveModule(stmt.path, options.moduleFrom);
        } catch (err) {
          throw new RuntimeError(`use "${stmt.path}": ${(err as Error).message}`, stmt.line);
        }
        // The library runs on its own, in its own scope, with its own uses resolved beside it; its defs keep that
        // scope as their closure, so a library def sees its helpers and constants and nothing of the caller's.
        let lib: Evaluation;
        try {
          lib = evaluate(parse(resolved.source), { ...options, moduleFrom: resolved.file, jointPoses: options.jointPoses });
        } catch (err) {
          throw new RuntimeError(`use "${stmt.path}" (${resolved.file}): ${(err as Error).message}`, stmt.line);
        }
        for (const [name, v] of Object.entries(options.jointPoses ?? {})) { CURRENT_ANGLES.set(name, v.angles); CURRENT_POSES.set(name, v); }
        const exports = new Map<string, Value>();
        for (const st of lib.steps) if (!isShape3(st.value) && !isShape2(st.value)) exports.set(st.name, st.value);
        for (const d of lib.defs) exports.set(d.name, d);
        for (const a of lib.asserts) asserts.push({ ...a, file: a.file ?? stmt.path });
        modules.set(prefix, { path: stmt.path, exports });
        moduleList.push({ prefix, path: stmt.path, names: [...exports.keys()] });
        return;
      }
      case "for": {
        const iterable = evalExpr(stmt.iterable, scope);
        if (!Array.isArray(iterable)) throw new RuntimeError(`'for' needs a list (use range(n)), got a ${typeName(iterable)}`, stmt.line);
        loopDepth++;
        try {
          for (const item of iterable) {
            if (++loops > MAX_LOOP) throw new RuntimeError(`more than ${MAX_LOOP} loop iterations`, stmt.line);
            scope.set(stmt.name, item);
            for (const s of stmt.body) exec(s, scope, topLevel);
          }
        } finally {
          loopDepth--;
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
      case "assert": {
        if (options.skipAsserts) return;
        // A promise about a pose is tested in that pose's evaluation and only noted in any other.
        if (stmt.pose && stmt.pose !== (options.poseName ?? "rest")) { asserts.push({ line: stmt.line, text: exprText(stmt.test), passed: true, pose: stmt.pose, pending: true }); return; }
        // A comparison is evaluated side by side, so a failure can say what the two numbers were.
        const t = stmt.test;
        let value: Value, detail: string | undefined;
        assertDepth++;
        witness = undefined;
        try {
        if (t.type === "binary" && (COMPARE_OPS as readonly string[]).includes(t.op)) {
          const a = evalExpr(t.left, scope), b = evalExpr(t.right, scope);
          value = compare(t.op, a, b, t.line);
          const show = (v: Value) => (typeof v === "number" ? String(Number(v.toPrecision(4))) : typeof v === "string" ? JSON.stringify(v) : typeName(v));
          detail = `${show(a)} ${t.op} ${show(b)}`;
        } else value = evalExpr(t, scope);
        } finally {
          assertDepth--;
        }
        if (typeof value !== "number") throw new RuntimeError(`assert tests a number (a comparison such as width(m) < 5, or 1 and 0), not a ${typeName(value)}`, stmt.line);
        let message: string | undefined;
        if (stmt.message) {
          const m = evalExpr(stmt.message, scope);
          if (typeof m !== "string") throw new RuntimeError(`assert's message is a string`, stmt.line);
          message = m;
        }
        asserts.push({ line: stmt.line, text: exprText(t), detail, message, passed: value !== 0, pose: stmt.pose, where: value === 0 ? witness : undefined });
        return;
      }
    }
  }

  let showDeps: Set<string> = new Set();
  for (const stmt of program.body) exec(stmt, global, true);

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
    const jointList = allJoints(output);
    const jointNames = new Set(jointList.map((j) => j.joint!.name));
    const axisJoints = new Set(jointList.filter((j) => j.joint!.axis).map((j) => j.joint!.name));
    for (const p of poses)
      for (const j of Object.keys(p.joints)) {
        if (!jointNames.has(j)) { warnings.push(`pose "${p.name}" (line ${p.line}) sets joint "${j}", which is not in the output${jointNames.size ? `; joints: ${[...jointNames].join(", ")}` : ""}`); continue; }
        // A single angle belongs to an axis joint; an [x, y, z] triple to one without; the wrong kind is a mistake to name.
        const single = singles.has(`${p.name}:${j}`);
        if (single && !axisJoints.has(j)) warnings.push(`pose "${p.name}" (line ${p.line}): ${j} is one number, but joint "${j}" has no axis=, so it takes [x, y, z] degrees`);
        if (!single && axisJoints.has(j) && (p.joints[j].angles[1] !== 0 || p.joints[j].angles[2] !== 0)) warnings.push(`pose "${p.name}" (line ${p.line}): joint "${j}" turns about its axis, so it takes one angle, not [x, y, z]; only the first number is used`);
      }
    for (const a of asserts)
      if (a.pose && a.pose !== "rest" && !poses.some((p) => p.name === a.pose)) warnings.push(`assert (line ${a.line}) is for pose "${a.pose}", which is not defined${poses.length ? `; poses: ${poses.map((p) => p.name).join(", ")}` : ""}; it is never tested`);
    // "rest" is every joint at zero and needs no pose() of its own; a missing pose is named once per animation.
    // A sky the renderer has, a shot the program declared.
    if (settings.environment !== undefined && !ENVIRONMENT_NAMES.includes(String(settings.environment))) warnings.push(`set environment ${settings.environment}: no such environment; the skies are ${ENVIRONMENT_NAMES.join(", ")} (studio is the default)`);
    if (typeof settings.camera === "string" && !cameras.some((c) => c.name === settings.camera)) warnings.push(`set camera ${settings.camera}: no such camera${cameras.length ? `; cameras: ${cameras.map((c) => c.name).join(", ")}` : " (declare one with camera(name, ...))"}; the render uses its own view`);
    for (const c of cameras) if (c.focus && !steps.has(c.focus) && !(shown?.names ?? []).includes(c.focus)) warnings.push(`camera "${c.name}" (line ${c.line}): focus="${c.focus}" names no step or object; the shot frames the whole model`);
    for (const a of animations) {
      // Two keys are both ends: ease_ends=0 leaves nothing eased (round 8: a flick expected to settle ran linear).
      if (a.poses.length === 2 && a.easeEnds === 0 && a.ease > 0) warnings.push(`animation "${a.name}" (line ${a.line}): with two keys both are ends, so ease_ends=0 leaves nothing for ease=${a.ease} to do; hold the last pose as a third key (["${a.poses[0]}", "${a.poses[1]}", "${a.poses[1]}"], times=[0, t, seconds]) to leave at once and settle, or drop ease_ends`);
    }
    for (const a of animations)
      for (const pn of new Set(a.poses))
        if (pn !== "rest" && !poses.some((p) => p.name === pn)) warnings.push(`animation "${a.name}" (line ${a.line}) uses pose "${pn}", which is not defined${poses.length ? `; poses: ${poses.map((p) => p.name).join(", ")}` : ""}`);
  }
  // Roles: a part is anything the output is built from; below a cut name the subtree is a cut; a name only an
  // assert, a decal or a camera reads is a region. A part stays a part however else it is read.
  for (const c of cameras) if (c.focus) regionNames.add(c.focus);
  const roles = new Map<string, StepRole>();
  const rank = (r: StepRole | undefined) => (r === "part" ? 3 : r === "cut" ? 2 : r === "region" ? 1 : 0);
  const visit = (nme: string, role: StepRole) => {
    if (rank(roles.get(nme)) >= rank(role)) return;
    roles.set(nme, role);
    const st = steps.get(nme);
    if (st) for (const d of st.deps) visit(d, role === "region" ? role : st.cutDeps?.has(d) ? "cut" : decalRegions.has(d) ? "region" : role);
  };
  for (const r of roots) visit(r, "part");
  for (const r of regionNames) visit(r, "region");
  const used = new Set<string>([...roles.entries()].filter(([, r]) => r !== "region").map(([n]) => n));
  const stepList = [...steps.values()];
  // A step is displaced when every step that reads it moves it, and nothing shows it as it is.
  const readers = new Map<string, Step[]>();
  for (const st of stepList) for (const d of st.deps) { const l = readers.get(d) ?? []; l.push(st); readers.set(d, l); }
  const displaced = new Set<string>();
  for (const st of stepList) {
    if (!isShape3(st.value) || roots.has(st.name)) continue;
    const rs = readers.get(st.name) ?? [];
    if (rs.length && rs.every((r) => r.movedDeps?.has(st.name) && !r.keptDeps?.has(st.name))) displaced.add(st.name);
  }
  for (const st of stepList)
    if (isShape3(st.value) && !roles.has(st.name) && output)
      warnings.push(`'${st.name}' (line ${st.line}) is not part of the output; add it to the model or remove it`);

  const defs: UserFn[] = [];
  for (const st of program.body) if (st.type === "def") { const v = global.get(st.name); if (v !== undefined && isUserFn(v)) defs.push(v); }
  return { output, outputName, objects, poses, animations, lights, cameras, used, roles, displaced, steps: stepList, settings, warnings, modules: moduleList, defs, asserts, images };
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
