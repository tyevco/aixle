/**
 * Every function the language offers, with its signature. The signatures do
 * double duty: the interpreter binds arguments by them (positional or by
 * name, with defaults and type checks) and `aixle doc` prints them as the
 * reference, so the documentation cannot drift from what runs.
 *
 * Angles are degrees everywhere, including sin/cos/tan, because rotate takes
 * degrees and one convention is kinder to a model writing code than two.
 */
import { rad } from "../core/vec.js";
import { albedo, customMaterial, materialFromString, PATTERNS, parseColor } from "../sdf/materials.js";
import * as O from "../sdf/ops.js";
import * as P from "../sdf/primitives.js";
import * as S from "../sdf/shapes2d.js";
import * as W from "../sdf/sweeps.js";
import type { Material, PatternKind, Shape2, Shape3 } from "../sdf/types.js";
import { isMaterial, isShape2, isShape3, type Builtin, type Overload, type Param, type Value } from "./values.js";

const num = (name: string, doc?: string, def?: number): Param => (def === undefined ? { name, type: "number", doc } : { name, type: "number", default: def, doc });
const str = (name: string, doc?: string, def?: string): Param => (def === undefined ? { name, type: "string", doc } : { name, type: "string", default: def, doc });
const shape = (name = "shape", doc?: string): Param => ({ name, type: "shape", doc });
const shape2 = (name = "profile", doc?: string): Param => ({ name, type: "shape2", doc });
const axis = (name = "axis", doc?: string, def?: string): Param => (def === undefined ? { name, type: "axis", doc } : { name, type: "axis", default: def, doc });
const mat = (name = "material", doc?: string): Param => ({ name, type: "material", doc });

const n = (v: Value): number => v as number;
const s3 = (v: Value): Shape3 => v as Shape3;
const s2 = (v: Value): Shape2 => v as Shape2;

function ov(params: Param[], returns: Overload["returns"], impl: Overload["impl"]): Overload {
  return { params, returns, impl };
}

function def(name: string, group: string, doc: string, ...overloads: Overload[]): Builtin {
  return { name, group, doc, overloads };
}

const deg = (v: number): number => (v * 180) / Math.PI;

export function toMaterial(v: Value): Material {
  if (isMaterial(v)) return v;
  if (typeof v === "string") {
    const m = materialFromString(v);
    if (m) return m;
    throw new Error(`"${v}" is not a material preset or a colour; try a preset like "wood" or a hex colour like "#a0522d"`);
  }
  throw new Error(`expected a material or a colour string`);
}

function makeMaterial(args: Value[]): Material {
  const color = parseColor(args[0] as string);
  if (!color) throw new Error(`material(): "${args[0]}" is not a colour (use "#rrggbb" or a colour name)`);
  const pattern = args[1] as string;
  if (!PATTERNS.includes(pattern as PatternKind))
    throw new Error(`material(): unknown pattern "${pattern}"; one of ${PATTERNS.join(", ")}`);
  const c2text = args[2] as string;
  const color2 = c2text === "" ? undefined : parseColor(c2text);
  if (c2text !== "" && !color2) throw new Error(`material(): "${c2text}" is not a colour`);
  return customMaterial({ color, color2, pattern: pattern as PatternKind, scale: n(args[3]), metal: n(args[4]), rough: n(args[5]), seed: n(args[6]) });
}

function hexOf(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return hexOf(f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255);
}

const shapesOf = (first: Value, rest: Value[]): Shape3[] => [first, ...rest].map(s3);
const shapes2Of = (first: Value, rest: Value[]): Shape2[] => [first, ...rest].map(s2);

export const BUILTINS: Builtin[] = [
  // --- 3D primitives ---
  def("box", "3D primitives", "A box centred on the origin. One size makes a cube. `round` rounds every edge.",
    ov([num("w", "width along x"), num("h", "height along y (defaults to w)", -1), num("d", "depth along z (defaults to w)", -1), num("round", "edge radius", 0)], "shape",
      (a) => P.box(n(a[0]), n(a[1]) < 0 ? n(a[0]) : n(a[1]), n(a[2]) < 0 ? n(a[0]) : n(a[2]), n(a[3])))),
  def("sphere", "3D primitives", "A sphere of radius r.", ov([num("r")], "shape", (a) => P.sphere(n(a[0])))),
  def("cylinder", "3D primitives", "A cylinder standing along y, centred on the origin.",
    ov([num("r"), num("h", "height"), num("round", "edge radius", 0)], "shape", (a) => P.cylinder(n(a[0]), n(a[1]), n(a[2])))),
  def("cone", "3D primitives", "A cone or frustum along y: radius r1 at the bottom, r2 at the top (0 for a point).",
    ov([num("r1"), num("r2"), num("h")], "shape", (a) => P.cone(n(a[0]), n(a[1]), n(a[2])))),
  def("capsule", "3D primitives", "A capsule (a cylinder with hemispherical ends) along y; h is the total height.",
    ov([num("r"), num("h")], "shape", (a) => P.capsule(n(a[0]), n(a[1])))),
  def("torus", "3D primitives", "A ring lying flat around y: R to the tube's centre, r the tube's radius.",
    ov([num("R"), num("r")], "shape", (a) => P.torus(n(a[0]), n(a[1])))),
  def("ellipsoid", "3D primitives", "An ellipsoid with radii rx, ry, rz.",
    ov([num("rx"), num("ry"), num("rz")], "shape", (a) => P.ellipsoid(n(a[0]), n(a[1]), n(a[2])))),
  def("octahedron", "3D primitives", "An octahedron with its points s from the centre.", ov([num("s")], "shape", (a) => P.octahedron(n(a[0])))),
  def("prism", "3D primitives", "A regular polygon (sides, circumradius r) extruded to height h along y, one flat facing +z.",
    ov([num("sides"), num("r"), num("h")], "shape", (a) => P.prism(n(a[0]), n(a[1]), n(a[2])))),
  def("empty", "3D primitives", "Nothing. The starting value for building up a shape in a loop.", ov([], "shape", () => O.empty3())),

  // --- 2D profiles ---
  def("circle", "2D profiles", "A circle of radius r in the x/y plane.", ov([num("r")], "shape2", (a) => S.circle(n(a[0])))),
  def("rect", "2D profiles", "A rectangle w by h, centred; `round` rounds its corners.",
    ov([num("w"), num("h", "defaults to w", -1), num("round", "", 0)], "shape2", (a) => S.rect(n(a[0]), n(a[1]) < 0 ? n(a[0]) : n(a[1]), n(a[2])))),
  def("ellipse", "2D profiles", "An ellipse with radii rx, ry.", ov([num("rx"), num("ry")], "shape2", (a) => S.ellipse(n(a[0]), n(a[1])))),
  def("ngon", "2D profiles", "A regular polygon with `sides` sides and circumradius r.", ov([num("sides"), num("r")], "shape2", (a) => S.ngon(n(a[0]), n(a[1])))),
  def("star", "2D profiles", "A star with `points` points, outer radius r1 and inner radius r2.",
    ov([num("points"), num("r1"), num("r2")], "shape2", (a) => S.star(n(a[0]), n(a[1]), n(a[2])))),
  def("polygon", "2D profiles", "A polygon from x, y pairs, either as numbers or one list: polygon(0,0, 2,0, 1,1.5).",
    ov([{ name: "points", type: "list" }], "shape2", (a) => S.polygon((a[0] as Value[]).map((v) => n(v)))),
    ov([{ name: "coords", type: "number", rest: true }], "shape2", (_a, rest) => S.polygon(rest.map((v) => n(v))))),

  // --- 2D to 3D ---
  def("extrude", "2D to 3D", "Thicken a profile to height h. Axis y (default) lays the profile flat, its y towards -z; z makes it face +z; x makes it face +x.",
    ov([shape2(), num("h"), axis("axis", "", "y")], "shape", (a) => S.extrude(s2(a[0]), n(a[1]), a[2] as S.ExtrudeAxis))),
  def("revolve", "2D to 3D", "Spin a profile around y; its x is the radius (draw it on x >= 0), pushed out by `offset`.",
    ov([shape2(), num("offset", "", 0)], "shape", (a) => S.revolve(s2(a[0]), n(a[1])))),

  // --- paths ---
  def("tube", "Paths", "A round tube of radius r along a path of x, y, z points, joins rounded. `smooth` > 0 curves the path through the points (8 is plenty).",
    ov([num("r"), { name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }, num("smooth", "", 0)], "shape",
      (a) => W.tube(W.smoothPath(W.toPoints((a[1] as Value[]).map((v) => n(v)), "tube"), n(a[2])), n(a[0])))),
  def("sweep", "Paths", "A 2D profile carried along a path of x, y, z points: its x runs across the path, its y up. `smooth` curves the path.",
    ov([shape2(), { name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }, num("smooth", "", 0)], "shape",
      (a) => W.sweep(s2(a[0]), W.smoothPath(W.toPoints((a[1] as Value[]).map((v) => n(v)), "sweep"), n(a[2]))))),
  def("loft", "Paths", "A solid h tall that is profile a at the bottom and profile b at the top, blending between them.",
    ov([shape2("a"), shape2("b"), num("h")], "shape", (a) => W.loft(s2(a[0]), s2(a[1]), n(a[2])))),

  // --- booleans ---
  def("union", "Booleans", "Everything in any of the shapes. `k` > 0 blends the joins smoothly over about k units. Same as a + b.",
    ov([shape("a"), { name: "shapes", type: "shape", rest: true }, num("k", "blend radius", 0)], "shape", (a, rest) => O.union(shapesOf(a[0], rest), n(a[2]))),
    ov([shape2("a"), { name: "profiles", type: "shape2", rest: true }, num("k", "blend radius", 0)], "shape2", (a, rest) => S.union2(shapes2Of(a[0], rest), n(a[2])))),
  def("difference", "Booleans", "a with b cut away. Same as a - b. The cut surface keeps a's material.",
    ov([shape("a"), shape("b"), num("k", "blend radius", 0)], "shape", (a) => O.difference(s3(a[0]), s3(a[1]), n(a[2]))),
    ov([shape2("a"), shape2("b"), num("k", "", 0)], "shape2", (a) => S.difference2(s2(a[0]), s2(a[1]), n(a[2])))),
  def("intersect", "Booleans", "Only where a and b overlap. Same as a & b.",
    ov([shape("a"), shape("b"), num("k", "blend radius", 0)], "shape", (a) => O.intersect(s3(a[0]), s3(a[1]), n(a[2]))),
    ov([shape2("a"), shape2("b"), num("k", "", 0)], "shape2", (a) => S.intersect2(s2(a[0]), s2(a[1]), n(a[2])))),

  // --- transforms ---
  def("move", "Transforms", "Translate by x, y, z (a profile takes x, y).",
    ov([shape(), num("x", "", 0), num("y", "", 0), num("z", "", 0)], "shape", (a) => O.move(s3(a[0]), n(a[1]), n(a[2]), n(a[3]))),
    ov([shape2(), num("x", "", 0), num("y", "", 0)], "shape2", (a) => S.move2(s2(a[0]), n(a[1]), n(a[2])))),
  def("rotate", "Transforms", "Rotate by degrees about x, then y, then z, around the origin. rotate(shape, y=45) is the usual call. A profile takes one angle.",
    ov([shape(), num("x", "", 0), num("y", "", 0), num("z", "", 0)], "shape", (a) => O.rotate(s3(a[0]), n(a[1]), n(a[2]), n(a[3]))),
    ov([shape2(), num("angle")], "shape2", (a) => S.rotate2(s2(a[0]), n(a[1])))),
  def("scale", "Transforms", "Scale about the origin: one factor for all axes, or one per axis.",
    ov([shape(), num("x"), num("y", "defaults to x", -1e9), num("z", "defaults to x", -1e9)], "shape",
      (a) => O.scale(s3(a[0]), n(a[1]), n(a[2]) === -1e9 ? n(a[1]) : n(a[2]), n(a[3]) === -1e9 ? n(a[1]) : n(a[3]))),
    ov([shape2(), num("x"), num("y", "defaults to x", -1e9)], "shape2", (a) => S.scale2(s2(a[0]), n(a[1]), n(a[2]) === -1e9 ? n(a[1]) : n(a[2])))),
  def("mirror", "Transforms", "The shape plus its reflection across the plane perpendicular to `axis` through the origin: model half, mirror the rest.",
    ov([shape(), axis()], "shape", (a) => O.mirror(s3(a[0]), a[1] as O.Axis)),
    ov([shape2(), axis()], "shape2", (a) => S.mirror2(s2(a[0]), a[1] as "x" | "y"))),
  def("flip", "Transforms", "Reflect across the plane perpendicular to `axis` (no copy kept).",
    ov([shape(), axis()], "shape", (a) => O.flip(s3(a[0]), a[1] as O.Axis)),
    ov([shape2(), axis()], "shape2", (a) => S.flip2(s2(a[0]), a[1] as "x" | "y"))),
  def("ground", "Transforms", "Move the shape so its lowest point rests on y = 0.", ov([shape()], "shape", (a) => O.ground(s3(a[0])))),
  def("center", "Transforms", "Move the shape so its bounding box is centred on the origin; `axes` picks which of x, y, z.",
    ov([shape(), str("axes", "", "xyz")], "shape", (a) => O.center(s3(a[0]), a[1] as string))),

  // --- modifiers ---
  def("round", "Modifiers", "Round every edge by growing the surface outward by r (on a number: round to the nearest integer).",
    ov([shape(), num("r")], "shape", (a) => O.offset(s3(a[0]), n(a[1]))),
    ov([shape2(), num("r")], "shape2", (a) => S.offset2(s2(a[0]), n(a[1]))),
    ov([num("x")], "number", (a) => Math.round(n(a[0])))),
  def("offset", "Modifiers", "Grow (r > 0) or shrink (r < 0) the surface by r.",
    ov([shape(), num("r")], "shape", (a) => O.offset(s3(a[0]), n(a[1]))),
    ov([shape2(), num("r")], "shape2", (a) => S.offset2(s2(a[0]), n(a[1])))),
  def("shell", "Modifiers", "Hollow the shape leaving a wall t thick inside its surface. Subtract something to open it up.",
    ov([shape(), num("t", "wall thickness")], "shape", (a) => O.shell(s3(a[0]), n(a[1]))),
    ov([shape2(), num("t")], "shape2", (a) => S.shell2(s2(a[0]), n(a[1])))),
  def("twist", "Modifiers", "Twist around y by `degrees` for every unit of height.", ov([shape(), num("degrees")], "shape", (a) => O.twist(s3(a[0]), n(a[1])))),
  def("bend", "Modifiers", "Bend around z: the shape curves up by `degrees` for every unit along x.", ov([shape(), num("degrees")], "shape", (a) => O.bend(s3(a[0]), n(a[1])))),
  def("displace", "Modifiers", "Roughen the surface with noise: in and out by up to `amp`, features about `size` across.",
    ov([shape(), num("amp"), num("size", "", 1), num("seed", "", 0)], "shape", (a) => O.displace(s3(a[0]), n(a[1]), n(a[2]), n(a[3])))),

  // --- repetition ---
  def("array", "Repetition", "`count` copies stepping by dx, dy, dz from the original.",
    ov([shape(), num("count"), num("dx", "", 0), num("dy", "", 0), num("dz", "", 0)], "shape", (a) => O.array(s3(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4])))),
  def("grid", "Repetition", "nx by nz copies on the ground plane, dx and dz apart.",
    ov([shape(), num("nx"), num("nz"), num("dx"), num("dz", "defaults to dx", -1e9)], "shape",
      (a) => O.grid(s3(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]) === -1e9 ? n(a[3]) : n(a[4])))),
  def("ring", "Repetition", "`count` copies evenly around `axis` (default y), each first pushed out to `radius` along +x.",
    ov([shape(), num("count"), num("radius", "", 0), axis("axis", "", "y")], "shape", (a) => O.ring(s3(a[0]), n(a[1]), n(a[2]), a[3] as O.Axis))),

  // --- materials ---
  def("paint", "Materials", "Give the whole shape a material: a preset name, a colour (\"#rrggbb\" or a name), or material(...). Paint parts before combining them to keep several materials.",
    ov([shape(), mat()], "shape", (a) => O.paint(s3(a[0]), a[1] as Material))),
  def("material", "Materials", "A custom material. Patterns: " + PATTERNS.join(", ") + ". `scale` is the feature size in units; metal 0..1; rough 0..1.",
    ov([str("color"), str("pattern", "", "solid"), str("color2", "second colour for two-tone patterns", ""), num("scale", "", 1), num("metal", "", 0), num("rough", "", 0.6), num("seed", "", 0)], "material", makeMaterial)),
  def("rgb", "Materials", "A colour string from red, green, blue in 0..255.", ov([num("r"), num("g"), num("b")], "string", (a) => hexOf(n(a[0]), n(a[1]), n(a[2])))),
  def("hsl", "Materials", "A colour string from hue in degrees, saturation and lightness in 0..1.", ov([num("h"), num("s"), num("l")], "string", (a) => hslToHex(n(a[0]), n(a[1]), n(a[2])))),

  // --- numbers ---
  def("range", "Numbers", "A list of integers: range(n) is 0..n-1; range(a, b) is a..b-1; range(a, b, step).",
    ov([num("a"), num("b", "", NaN), num("step", "", 1)], "list", (a) => {
      const start = Number.isNaN(n(a[1])) ? 0 : n(a[0]);
      const stop = Number.isNaN(n(a[1])) ? n(a[0]) : n(a[1]);
      const step = n(a[2]);
      if (step === 0) throw new Error("range(): step cannot be 0");
      const out: number[] = [];
      for (let v = start; step > 0 ? v < stop : v > stop; v += step) {
        out.push(v);
        if (out.length > 100000) throw new Error("range(): more than 100000 values");
      }
      return out;
    })),
  def("len", "Numbers", "Length of a list.", ov([{ name: "list", type: "list" }], "number", (a) => (a[0] as Value[]).length)),
  def("sin", "Numbers", "Sine of an angle in degrees.", ov([num("degrees")], "number", (a) => Math.sin(rad(n(a[0]))))),
  def("cos", "Numbers", "Cosine of an angle in degrees.", ov([num("degrees")], "number", (a) => Math.cos(rad(n(a[0]))))),
  def("tan", "Numbers", "Tangent of an angle in degrees.", ov([num("degrees")], "number", (a) => Math.tan(rad(n(a[0]))))),
  def("asin", "Numbers", "Arcsine, in degrees.", ov([num("x")], "number", (a) => deg(Math.asin(n(a[0]))))),
  def("acos", "Numbers", "Arccosine, in degrees.", ov([num("x")], "number", (a) => deg(Math.acos(n(a[0]))))),
  def("atan", "Numbers", "Arctangent of y/x, in degrees; atan(y, x) takes the quadrant into account.",
    ov([num("y"), num("x", "", NaN)], "number", (a) => deg(Number.isNaN(n(a[1])) ? Math.atan(n(a[0])) : Math.atan2(n(a[0]), n(a[1]))))),
  def("sqrt", "Numbers", "Square root.", ov([num("x")], "number", (a) => Math.sqrt(n(a[0])))),
  def("abs", "Numbers", "Absolute value.", ov([num("x")], "number", (a) => Math.abs(n(a[0])))),
  def("floor", "Numbers", "Round down.", ov([num("x")], "number", (a) => Math.floor(n(a[0])))),
  def("ceil", "Numbers", "Round up.", ov([num("x")], "number", (a) => Math.ceil(n(a[0])))),
  def("min", "Numbers", "Smallest of the numbers.", ov([num("a"), { name: "more", type: "number", rest: true }], "number", (a, rest) => Math.min(n(a[0]), ...rest.map(n)))),
  def("max", "Numbers", "Largest of the numbers.", ov([num("a"), { name: "more", type: "number", rest: true }], "number", (a, rest) => Math.max(n(a[0]), ...rest.map(n)))),
  def("pow", "Numbers", "x to the power y (also x ^ y).", ov([num("x"), num("y")], "number", (a) => Math.pow(n(a[0]), n(a[1])))),
  def("clamp", "Numbers", "x limited to lo..hi.", ov([num("x"), num("lo"), num("hi")], "number", (a) => Math.max(n(a[1]), Math.min(n(a[2]), n(a[0]))))),
  def("lerp", "Numbers", "a + (b - a) * t.", ov([num("a"), num("b"), num("t")], "number", (a) => n(a[0]) + (n(a[1]) - n(a[0])) * n(a[2]))),
  def("mod", "Numbers", "a modulo b, always in 0..b (also a % b).", ov([num("a"), num("b")], "number", (a) => ((n(a[0]) % n(a[1])) + n(a[1])) % n(a[1]))),
  def("rand", "Numbers", "A repeatable pseudo-random number in 0..1 for an integer seed (use the loop index).",
    ov([num("seed")], "number", (a) => {
      let h = (Math.floor(n(a[0])) * 374761393 + 668265263) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    })),
];

export const BUILTIN_MAP: ReadonlyMap<string, Builtin> = new Map(BUILTINS.map((b) => [b.name, b]));

/** Names available as plain values. */
export const CONSTANTS: Record<string, Value> = { pi: Math.PI, tau: Math.PI * 2 };

export { albedo, isShape2, isShape3 };
