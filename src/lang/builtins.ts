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
import { albedo, customMaterial, materialFromString, PATTERNS, parseColor, preset } from "../sdf/materials.js";
import * as O from "../sdf/ops.js";
import * as P from "../sdf/primitives.js";
import * as S from "../sdf/shapes2d.js";
import * as W from "../sdf/sweeps.js";
import { bezierCurve, curveThrough, sweepCurve, tubeCurve, type Curve } from "../sdf/curves.js";
import { textProfile, textWidth } from "../sdf/font.js";
import type { Material, PatternKind, Placement, Shape2, Shape3 } from "../sdf/types.js";
import { isMaterial, isShape2, isShape3, type Builtin, type Overload, type Param, type Value } from "./values.js";

/** The pose being evaluated, set by the interpreter before a run so angle() can read it. */
export const CURRENT_ANGLES = new Map<string, [number, number, number]>();

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
  const first = args[0] as string;
  const pattern = args[1] as string, c2text = args[2] as string;
  const scale = n(args[3]), metal = n(args[4]), rough = n(args[5]), seed = n(args[6]), transmit = n(args[7]);
  const axisText = args[8] as string, glow = n(args[9]);
  if (axisText !== "" && !["x", "y", "z"].includes(axisText)) throw new Error(`material(): axis must be "x", "y" or "z"`);
  const axis = axisText === "" ? undefined : (axisText as "x" | "y" | "z");
  const given = (v: number) => !Number.isNaN(v);
  // A preset name: start from it and override only what was given.
  const base = preset(first);
  if (base) {
    if (pattern !== "" && !PATTERNS.includes(pattern as PatternKind)) throw new Error(`material(): unknown pattern "${pattern}"; one of ${PATTERNS.join(", ")}`);
    const color2 = c2text === "" ? undefined : parseColor(c2text);
    if (c2text !== "" && !color2) throw new Error(`material(): "${c2text}" is not a colour`);
    return customMaterial({
      name: `${base.name}*`,
      color: base.color,
      color2: color2 ?? base.color2,
      pattern: pattern === "" ? base.pattern : (pattern as PatternKind),
      scale: given(scale) ? scale : base.scale,
      metal: given(metal) ? metal : base.metal,
      rough: given(rough) ? rough : base.rough,
      seed: given(seed) ? seed : base.seed,
      transmit: given(transmit) ? transmit : base.transmit,
      axis: axis ?? base.axis,
      glow: given(glow) ? glow : base.glow,
    });
  }
  const color = parseColor(first);
  if (!color) throw new Error(`material(): "${first}" is not a preset or a colour (use a preset like "granite", "#rrggbb", or a colour name)`);
  const pat = pattern === "" ? "solid" : pattern;
  if (!PATTERNS.includes(pat as PatternKind)) throw new Error(`material(): unknown pattern "${pat}"; one of ${PATTERNS.join(", ")}`);
  const color2 = c2text === "" ? undefined : parseColor(c2text);
  if (c2text !== "" && !color2) throw new Error(`material(): "${c2text}" is not a colour`);
  return customMaterial({ color, color2, pattern: pat as PatternKind, scale: given(scale) ? scale : 1, metal: given(metal) ? metal : 0, rough: given(rough) ? rough : 0.6, seed: given(seed) ? seed : 0, transmit: given(transmit) ? transmit : 0, axis, glow: given(glow) ? glow : 0 });
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

  def("text", "2D profiles", "Lettering as a 2D profile from a single-stroke font (A-Z, a-z, 0-9, punctuation), laid out from x = 0 on the baseline y = 0; face=\"serif\" adds slab serifs. `size` is the cap height, `weight` the stroke width (the profile's box reaches half the weight past the strokes, so the lettering stands `size` plus `weight` tall, and a line of n characters is about 0.8 × n × size wide, 0.93 with serifs); `align` is \"left\", \"center\" or \"right\". Extrude it for a sign, subtract it for engraving. check warns when the weight is under a grid cell.",
    ov([str("text"), num("size", "cap height", 1), num("weight", "stroke width", 0.15), str("align", "", "left"), num("spacing", "extra gap between letters", 0), num("arc", "bend onto a circle of this radius, centred on the origin: positive reads over the top, negative under the bottom", 0), str("face", "\"sans\" or \"serif\" (slab serifs on the same letters, set a little wider)", "sans")], "shape2",
      (a) => {
        const t = a[0] as string, size = n(a[1]), spacing = n(a[4]), arc = n(a[5]);
        const face = a[6] as string;
        if (face !== "sans" && face !== "serif") throw new Error(`face must be "sans" or "serif"`);
        if (arc !== 0) return textProfile(t, size, n(a[2]), spacing, arc, face);
        const w = textWidth(t, size, spacing, face);
        const align = a[3] as string;
        const shift = align === "center" ? -w / 2 : align === "right" ? -w : 0;
        return S.move2(textProfile(t, size, n(a[2]), spacing, 0, face), shift, 0);
      })),

  // --- 2D to 3D ---
  def("extrude", "2D to 3D", "Thicken a profile to height h, centred on its plane. axis=\"y\" (default): the profile lies flat, its x along world x and its y along world -z, thickened up. axis=\"z\": the profile stands facing +z, its x along x and its y along y. axis=\"x\": it stands facing +x, its x along world -z and its y along y.",
    ov([shape2(), num("h"), axis("axis", "", "y")], "shape", (a) => S.extrude(s2(a[0]), n(a[1]), a[2] as S.ExtrudeAxis))),
  def("revolve", "2D to 3D", "Spin a profile around y; its x is the radius (draw it on x >= 0), pushed out by `offset`. `angle` below 360 sweeps only that far, from +z towards +x, with flat ends: an arch, a cutaway.",
    ov([shape2(), num("offset", "", 0), num("angle", "degrees swept", 360)], "shape", (a) => S.revolve(s2(a[0]), n(a[1]), n(a[2])))),

  // --- paths ---
  def("tube", "Paths", "A round tube of radius r along a path of x, y, z points, joins rounded and the ends hemispheres unless cap=\"flat\". `smooth` > 0 curves the path through the points (8 is plenty); `taper` is the radius at the end relative to the start.",
    ov([num("r"), { name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }, num("smooth", "", 0), num("taper", "end radius / start radius", 1), str("cap", "\"round\" (hemispheres, reaching r past each end) or \"flat\" (cut at the ends)", "round")], "shape",
      (a) => {
        const cap = a[4] as string;
        if (cap !== "round" && cap !== "flat") throw new Error(`cap must be "round" or "flat"`);
        return W.tube(W.smoothPath(W.toPoints((a[1] as Value[]).map((v) => n(v)), "tube"), n(a[2])), n(a[0]), n(a[3]), cap);
      }),
    ov([num("r"), { name: "curve", type: "curve", doc: "a bezier() or curve()" }, num("taper", "end radius / start radius", 1), str("cap", "\"round\" or \"flat\"", "round")], "shape",
      (a) => {
        const cap = a[3] as string;
        if (cap !== "round" && cap !== "flat") throw new Error(`cap must be "round" or "flat"`);
        return tubeCurve(a[1] as Curve, n(a[0]), n(a[2]), cap);
      })),
  def("sweep", "Paths", "A 2D profile carried along a path of x, y, z points: its x runs across the path, its y up. `smooth` curves the path; `twist` turns the profile by that many degrees over the whole path; `taper` scales it to that factor by the end.",
    ov([shape2(), { name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }, num("smooth", "", 0), num("twist", "degrees over the path", 0), num("taper", "end scale", 1)], "shape",
      (a) => W.sweep(s2(a[0]), W.smoothPath(W.toPoints((a[1] as Value[]).map((v) => n(v)), "sweep"), n(a[2])), n(a[3]), n(a[4]))),
    ov([shape2(), { name: "curve", type: "curve", doc: "a bezier() or curve()" }, num("twist", "degrees over the curve", 0), num("taper", "end scale", 1)], "shape",
      (a) => sweepCurve(s2(a[0]), a[1] as Curve, n(a[2]), n(a[3])))),
  def("bezier", "Paths", "An exact curve from cubic Bezier control points: an anchor, then two handles and an anchor for each piece (4, 7, 10, ... points). A tube or sweep along it is the true offset of the curve, with no facets at any grid, and costs about as much per piece as a spline's.",
    ov([{ name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }], "curve", (a) => bezierCurve(W.toPoints((a[0] as Value[]).map((v) => n(v)), "bezier")))),
  def("curve", "Paths", "An exact smooth curve through the points, the same shape spline() draws, for tube() and sweep(): the surface follows the true curve rather than a polyline through it.",
    ov([{ name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }], "curve", (a) => curveThrough(W.toPoints((a[0] as Value[]).map((v) => n(v)), "curve")))),
  def("helix", "Paths", "A path list for a helix of radius r around y, for tube() or sweep(): it starts at (r, 0, 0) and rises from y = 0 to y = h over `turns` turns.",
    ov([num("r"), num("h"), num("turns"), num("per_turn", "points per turn", 16)], "list", (a) => W.helixPath(n(a[0]), n(a[1]), n(a[2]), n(a[3])))),
  def("spline", "Paths", "A smooth path through the points, subdivided until no piece turns more than `degrees`: a curve that shows no faceting in a tube or sweep, however tight.",
    ov([{ name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }, num("degrees", "largest turn between pieces", 3)], "list",
      (a) => W.splinePath(W.toPoints((a[0] as Value[]).map((v) => n(v)), "spline"), n(a[1])))),
  def("arc", "Paths", "A path list for an arc of radius r on the ground plane from `from` to `to` degrees (0 is +z, 90 is +x).",
    ov([num("r"), num("from", "", 0), num("to", "", 90), num("segments", "", 16)], "list", (a) => W.arcPath(n(a[0]), n(a[1]), n(a[2]), n(a[3])))),
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
  def("rotate", "Transforms", "Rotate by degrees about x, then y, then z, around the origin, right-handed: a positive x angle turns +y towards +z, a positive y angle turns +z towards +x, a positive z angle turns +x towards +y. rotate(shape, y=45) is the usual call. A profile takes one angle, counter-clockwise.",
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
  def("ground", "Transforms", "Move the shape so the lowest point of its surface rests on y = 0 (the surface, found by rays from below, not the bounding box, which a blend or a cut can leave loose).", ov([shape()], "shape", (a) => O.ground(s3(a[0])))),
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
  def("hollow", "Modifiers", "Hollow for printing: a shell `wall` thick with a drain hole of radius r (default the wall) cut through it at the drain point, usually on the bottom, so the void is open and resin or support can escape. hollow(cup, 0.1, 0, 0, 0) drains a model standing on y = 0 through its floor.",
    ov([shape(), num("wall"), num("x", "the drain point"), num("y"), num("z"), num("r", "drain radius", NaN)], "shape", (a) => O.hollow(s3(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), Number.isNaN(n(a[5])) ? n(a[1]) : n(a[5])))),
  def("shell", "Modifiers", "Hollow the shape leaving a wall t thick inside its surface. Subtract something to open it up. check warns when t is under a grid cell.",
    ov([shape(), num("t", "wall thickness")], "shape", (a) => O.shell(s3(a[0]), n(a[1]))),
    ov([shape2(), num("t")], "shape2", (a) => S.shell2(s2(a[0]), n(a[1])))),
  def("twist", "Modifiers", "Twist around y by `degrees` for every unit of height.", ov([shape(), num("degrees")], "shape", (a) => O.twist(s3(a[0]), n(a[1])))),
  def("bend", "Modifiers", "Bend about z: the shape's x axis becomes an arc of a circle of radius 57.3 / degrees centred above the origin at (0, R), curving up by `degrees` for every unit along x (negative bends down). A point at height y rides at radius R - y. Exact, so the box check prints is the bent shape's.", ov([shape(), num("degrees")], "shape", (a) => O.bend(s3(a[0]), n(a[1])))),
  def("wrap", "Modifiers", "Wrap around y: the shape's x axis goes round a cylinder of radius r, x = 0 landing on +z and reading left to right from the front; depth z rides at radius r + z. Standing lettering (extrude(text(...), h, \"z\")) wrapped this way is a label round a jar or a name round a rim: wrap(letters, 1.3) | move(0, y, 0).", ov([shape(), num("r", "the cylinder's radius")], "shape", (a) => O.wrap(s3(a[0]), n(a[1])))),
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

  // --- assembly ---
  def("place", "Assembly", "Copies of a shape at each x, y, z, yaw (degrees about y) in a flat list, optionally x, y, z, yaw, scale with `fields=5`. Rendered as a union; exported once with a node per copy.",
    ov([shape(), { name: "placements", type: "list", doc: "[x,y,z,yaw, x,y,z,yaw, ...]" }, num("fields", "4 for x,y,z,yaw or 5 to add a scale", 4)], "shape",
      (a) => {
        const list = (a[1] as Value[]).map((v) => {
          if (typeof v !== "number") throw new Error("placements must be numbers");
          return v;
        });
        const f = n(a[2]);
        if (f !== 4 && f !== 5) throw new Error("fields must be 4 or 5");
        if (list.length === 0 || list.length % f !== 0) throw new Error(`placements need groups of ${f} numbers, got ${list.length}`);
        const placements: Placement[] = [];
        for (let i = 0; i < list.length; i += f) placements.push({ x: list[i], y: list[i + 1], z: list[i + 2], yaw: list[i + 3], scale: f === 5 ? list[i + 4] : 1 });
        return O.place(s3(a[0]), placements);
      })),

  // --- queries ---
  def("height", "Queries", "The y of the highest surface of the shape above the point (x, z): where to set something down on a blended or roughened surface. An error when nothing is there.",
    ov([shape(), num("x"), num("z")], "number", (a) => {
      const y = O.heightAt(s3(a[0]), n(a[1]), n(a[2]));
      if (y === undefined) throw new Error(`no surface above (${n(a[1])}, ${n(a[2])})`);
      return y;
    })),
  def("top", "Queries", "The highest y of a shape's bounds (a bound, not necessarily a surface point); bottom(), left()... are the other faces of the box.",
    ov([shape()], "number", (a) => s3(a[0]).bounds.max[1])),
  def("bottom", "Queries", "The lowest y of a shape's bounds.", ov([shape()], "number", (a) => s3(a[0]).bounds.min[1])),
  def("width", "Queries", "The size of a shape's bounds along x.", ov([shape()], "number", (a) => s3(a[0]).bounds.max[0] - s3(a[0]).bounds.min[0])),
  def("depth", "Queries", "The size of a shape's bounds along z.", ov([shape()], "number", (a) => s3(a[0]).bounds.max[2] - s3(a[0]).bounds.min[2])),
  def("tall", "Queries", "The size of a shape's bounds along y.", ov([shape()], "number", (a) => s3(a[0]).bounds.max[1] - s3(a[0]).bounds.min[1])),

  // --- materials ---
  def("paint", "Materials", "Give the whole shape a material: a preset name, a colour (\"#rrggbb\" or a name), or material(...). Paint parts before combining them to keep several materials.",
    ov([shape(), mat()], "shape", (a) => O.paint(s3(a[0]), a[1] as Material))),
  def("decal", "Materials", "Paint only the part of the surface inside `region`, adding no geometry: a pupil on an eye (decal(eye, sphere(0.1) | move(...), \"black\")), a mouth line along a thin tube, a label on a jar. The region is any shape; its inside picks the material.",
    ov([shape(), shape("region", "the part of the surface inside this shape gets the material"), mat()], "shape", (a) => O.decal(s3(a[0]), s3(a[1]), a[2] as Material))),
  def("material", "Materials", "A custom material, from a colour or from a preset with some of its fields changed: material(\"granite\", scale=0.3). Patterns: " + PATTERNS.join(", ") + ". `scale` is the feature size in units; metal 0..1; rough 0..1; transmit 0..1 for glass; glow 0..2 for a flame or a lamp. Patterns are laid out in the frame the part is painted in, along `axis` (default y): stripes are bands stacked along it, wood rings and brick courses go round it, tiles and checks lie in the plane across it (floor tiles with the default y). Paint before moving the part, or set axis=\"x\" for stripes running the other way.",
    ov([str("color", "a colour, or a preset name to start from"), str("pattern", "", ""), str("color2", "second colour for two-tone patterns", ""), num("scale", "feature size in units", NaN), num("metal", "", NaN), num("rough", "", NaN), num("seed", "", NaN), num("transmit", "0 opaque .. 1 clear glass (beauty render only)", NaN), str("axis", "the pattern's axis: stripes stack along it, grain runs along it", ""), num("glow", "light the surface gives off, 0..2 (unshadowed, for flames and lamps)", NaN)], "material", makeMaterial)),
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
  def("angle", "Queries", "The current pose's angles for a joint, as [x, y, z] degrees (all zero at rest, or for a joint the pose does not set): what a member between two moving bodies (a hydraulic cylinder, a strut) needs to work out its end points with sin and cos. Nested joints' angles are relative to their parent.",
    ov([str("joint", "the joint's name")], "list", (a) => { const v = CURRENT_ANGLES.get(a[0] as string) ?? [0, 0, 0]; return [v[0], v[1], v[2]]; })),
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
