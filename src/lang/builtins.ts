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
import { albedo, customMaterial, materialFromString, PATTERNS, parseColor, preset, RUST_COLOR } from "../sdf/materials.js";
import * as O from "../sdf/ops.js";
import * as P from "../sdf/primitives.js";
import * as S from "../sdf/shapes2d.js";
import * as W from "../sdf/sweeps.js";
import { bezierCurve, curveThrough, sweepCurve, tubeCurve, type Curve } from "../sdf/curves.js";
import { bezier2, curve2 } from "../sdf/curves2d.js";
import { textProfile, textWidth } from "../sdf/font.js";
import { clearance, insideFraction, isVoid, leanOn, overlapVolume, restOn, type Contact, type NoContact } from "../sdf/measure.js";
import { countPieces, overhangFraction, standing } from "../mesh/pieces.js";
import { BRIDGE_MM, supportOf, thinnestWall } from "../mesh/print.js";
import type { Material, PatternKind, Placement, Shape2, Shape3 } from "../sdf/types.js";
import { boundsCenter, isEmpty } from "../sdf/types.js";
import { isMaterial, isRecord, isShape2, isShape3, type Builtin, type CallContext, type Overload, type Param, type Value } from "./values.js";

/** The pose being evaluated, set by the interpreter before a run so angle() can read it. */
export const CURRENT_ANGLES = new Map<string, [number, number, number]>();
/** The whole pose per joint (angles, move, scale) being evaluated, for joint_move() and joint_scale(). */
export const CURRENT_POSES = new Map<string, { angles: [number, number, number]; move: [number, number, number]; scale: [number, number, number] }>();

const num = (name: string, doc?: string, def?: number): Param => (def === undefined ? { name, type: "number", doc } : { name, type: "number", default: def, doc });
const str = (name: string, doc?: string, def?: string): Param => (def === undefined ? { name, type: "string", doc } : { name, type: "string", default: def, doc });
const shape = (name = "shape", doc?: string): Param => ({ name, type: "shape", doc });
const shape2 = (name = "profile", doc?: string): Param => ({ name, type: "shape2", doc });
const axis = (name = "axis", doc?: string, def?: string): Param => (def === undefined ? { name, type: "axis", doc } : { name, type: "axis", default: def, doc });
const mat = (name = "material", doc?: string): Param => ({ name, type: "material", doc });

const n = (v: Value): number => v as number;
/** The numbers in a list, nested lists flattened, so `[hip, knee]` with points as lists is a path (round 4 asked). */
const nums = (v: Value): number[] => {
  if (Array.isArray(v)) return v.flatMap(nums);
  // A record is not a point, though [p.x, p.y, p.z] is: say so rather than read the record as a number.
  if (isRecord(v)) throw new Error(`a record in a list of numbers; write out its fields, [p.${[...v.fields.keys()].slice(0, 3).join(", p.")}]`);
  return [n(v)];
};
const s3 = (v: Value): Shape3 => v as Shape3;
const s2 = (v: Value): Shape2 => v as Shape2;

function ov(params: Param[], returns: Overload["returns"], impl: Overload["impl"]): Overload {
  return { params, returns, impl };
}

function def(name: string, group: string, doc: string, ...overloads: Overload[]): Builtin {
  return { name, group, doc, overloads };
}

const deg = (v: number): number => (v * 180) / Math.PI;

/** A direction or an axis given as [x, y, z]: three numbers, not all zero. */
function direction(v: Value, what: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error(`${what} is a direction, [x, y, z]: three numbers`);
  const [x, y, z] = v as number[];
  const len = Math.hypot(x, y, z);
  if (!(len > 0)) throw new Error(`${what} is [0, 0, 0], which points nowhere`);
  return [x / len, y / len, z / len];
}

/** A direction as the program would write it: [0, -1, 0]. */
export function vecText(v: readonly number[]): string {
  return `[${v.map((x) => { const t = String(Number(x.toPrecision(4))); return t === "-0" ? "0" : t; }).join(", ")}]`;
}

/** A box as check prints a step's: x -1..1  y 0..2  z -1..1. */
function boxText(b: { min: ArrayLike<number>; max: ArrayLike<number> }): string {
  const f = (v: number) => { const t = String(Number(v.toPrecision(3))); return t === "-0" ? "0" : t; };
  return ["x", "y", "z"].map((k, i) => `${k} ${f(b.min[i])}..${f(b.max[i])}`).join("  ");
}

/** The part's and the target's names as the program wrote them, for a message: `bowl` and `plate`. */
function partNames(ctx: CallContext | undefined): { part: string; on: string } {
  const clip = (t: string | undefined, fallback: string) => (t === undefined ? fallback : t.length > 48 ? `${t.slice(0, 45)}...` : t);
  return { part: clip(ctx?.text?.("part"), "the part"), on: clip(ctx?.text?.("on"), "the target") };
}

/** An empty part or target, named: its box would print as Infinity..-Infinity. */
function emptyCheck(part: Shape3, on: Shape3, names: { part: string; on: string }, verb: string): void {
  if (isEmpty(part.bounds)) throw new Error(`${names.part} is empty: there is nothing to ${verb}`);
  if (isEmpty(on.bounds)) throw new Error(`${names.on} is empty: there is nothing for the part to touch`);
}

/** What rest() and lean() hand back: the part in contact, said to check; an error naming both when there is none. */
function contactResult(r: Contact | NoContact, ctx: CallContext | undefined, note: (r: Contact) => Parameters<NonNullable<CallContext["placed"]>>[0], never: () => string, stuck: (depth: number) => string): Shape3 {
  if (!r.shape) throw new Error(r.inside !== undefined ? stuck(r.inside) : never());
  ctx?.placed?.(note(r));
  return r.shape;
}

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
  const bump = n(args[10]), bumpScale = n(args[11]), wear = n(args[12]);
  if (axisText !== "" && !["x", "y", "z"].includes(axisText)) throw new Error(`material(): axis must be "x", "y" or "z"`);
  const axis = axisText === "" ? undefined : (axisText as "x" | "y" | "z");
  const given = (v: number) => !Number.isNaN(v);
  if (given(bump) && bump < 0) throw new Error(`material(): bump is a height, 0 or more`);
  if (given(bumpScale) && !(bumpScale > 0)) throw new Error(`material(): bump_scale is the bumps' size, more than 0`);
  if (given(wear) && (wear < 0 || wear > 1)) throw new Error(`material(): wear is 0 (new) to 1 (worn hard)`);
  // A preset name: start from it and override only what was given.
  const base = preset(first);
  if (base) {
    if (pattern !== "" && !PATTERNS.includes(pattern as PatternKind)) throw new Error(`material(): unknown pattern "${pattern}"; one of ${PATTERNS.join(", ")}`);
    const color2 = c2text === "" ? undefined : parseColor(c2text);
    if (c2text !== "" && !color2) throw new Error(`material(): "${c2text}" is not a colour`);
    return customMaterial({
      name: `${base.name}*`,
      color: base.color,
      // A preset turned to rust takes the oxide colour, not its own colour twice.
      color2: color2 ?? (pattern === "rust" && base.pattern !== "rust" ? RUST_COLOR : base.color2),
      pattern: pattern === "" ? base.pattern : (pattern as PatternKind),
      scale: given(scale) ? scale : base.scale,
      metal: given(metal) ? metal : base.metal,
      rough: given(rough) ? rough : base.rough,
      seed: given(seed) ? seed : base.seed,
      transmit: given(transmit) ? transmit : base.transmit,
      axis: axis ?? base.axis,
      glow: given(glow) ? glow : base.glow,
      bump: given(bump) ? bump : base.bump,
      bumpScale: given(bumpScale) ? bumpScale : base.bumpScale,
      wear: given(wear) ? wear : base.wear,
    });
  }
  const color = parseColor(first);
  if (!color) throw new Error(`material(): "${first}" is not a preset or a colour (use a preset like "granite", "#rrggbb", or a colour name)`);
  const pat = pattern === "" ? "solid" : pattern;
  if (!PATTERNS.includes(pat as PatternKind)) throw new Error(`material(): unknown pattern "${pat}"; one of ${PATTERNS.join(", ")}`);
  const color2 = c2text === "" ? undefined : parseColor(c2text);
  if (c2text !== "" && !color2) throw new Error(`material(): "${c2text}" is not a colour`);
  return customMaterial({ color, color2, pattern: pat as PatternKind, scale: given(scale) ? scale : 1, metal: given(metal) ? metal : 0, rough: given(rough) ? rough : 0.6, seed: given(seed) ? seed : 0, transmit: given(transmit) ? transmit : 0, axis, glow: given(glow) ? glow : 0, bump: given(bump) ? bump : 0, bumpScale: given(bumpScale) ? bumpScale : undefined, wear: given(wear) ? wear : 0 });
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
    ov([{ name: "points", type: "list" }], "shape2", (a) => S.polygon(nums(a[0]))),
    ov([{ name: "coords", type: "number", rest: true }], "shape2", (_a, rest) => S.polygon(rest.map((v) => n(v))))),
  def("curve2", "2D profiles", "A closed smooth profile through x, y pairs, closed back to the first point, with the exact distance to it, so a revolve or an extrude has no facets at any grid. A point given twice in a row is a sharp corner, and the run between two corners is straight: give a revolve's points on the axis and the edge of a foot twice. The list may end on its first point again, which only closes it. The tangent at a point comes from its two neighbours, each side's handle as long as that side's chord allows (a centripetal Catmull-Rom spline: the curve curve() draws when the points are evenly spaced), so a short piece beside a long one cannot loop; a run meant to be straight still ends in a corner. `wall` > 0 leaves the curve open and makes the profile the band that wide centred on it, ends rounded: a vase's wall drawn as one line, revolved.",
    ov([{ name: "points", type: "list", doc: "a flat list [x,y, x,y, ...], at least 3 different points (2 with a wall)" }, num("wall", "0 for the enclosed outline; more for an open band that wide", 0)], "shape2", (a) => curve2(nums(a[0]), n(a[1])))),
  def("bezier2", "2D profiles", "A closed profile from cubic Bezier anchors and handles, laid out as bezier() takes them: an anchor, then two handles and an anchor for each piece (4, 7, 10, ... x, y pairs). The last anchor should be the first; when it is not, a straight edge runs from it back to the first, which closes an outline drawn from a revolve's axis round to the axis. Handles 0.5523 r along the tangents make a quarter circle of radius r; a corner is two handles that do not line up. Exact distance, like curve2. `wall` > 0 leaves it open: the band that wide along the curve, ends rounded.",
    ov([{ name: "points", type: "list", doc: "a flat list [x,y, x,y, ...]: anchor, handle, handle, anchor, ..." }, num("wall", "0 for the enclosed outline; more for an open band that wide", 0)], "shape2", (a) => bezier2(nums(a[0]), n(a[1])))),

  def("text", "2D profiles", "Lettering as a 2D profile from a single-stroke font (A-Z, a-z, 0-9, punctuation), laid out from x = 0 on the baseline y = 0; face=\"serif\" adds slab serifs. `size` is the cap height, `weight` the stroke width (the profile's box reaches half the weight past the strokes, so the lettering stands `size` plus `weight` tall, and a line of n characters is about 0.8 × n × size wide, 0.93 with serifs); `align` is \"left\", \"center\" or \"right\". Extrude it for a sign, subtract it for engraving. check warns when the weight is under a grid cell, and for text on an arc prints the radii the lettering spans from the origin (`r 0.255..0.385`), which is what meets a rim.",
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
        return W.tube(W.smoothPath(W.toPoints(nums(a[1]), "tube"), n(a[2])), n(a[0]), n(a[3]), cap);
      }),
    ov([num("r"), { name: "curve", type: "curve", doc: "a bezier() or curve()" }, num("taper", "end radius / start radius", 1), str("cap", "\"round\" or \"flat\"", "round")], "shape",
      (a) => {
        const cap = a[3] as string;
        if (cap !== "round" && cap !== "flat") throw new Error(`cap must be "round" or "flat"`);
        return tubeCurve(a[1] as Curve, n(a[0]), n(a[2]), cap);
      })),
  def("sweep", "Paths", "A 2D profile carried along a path of x, y, z points: its x runs across the path, its y up. `smooth` curves the path; `twist` turns the profile by that many degrees over the whole path; `taper` scales it to that factor by the end.",
    ov([shape2(), { name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }, num("smooth", "", 0), num("twist", "degrees over the path", 0), num("taper", "end scale", 1)], "shape",
      (a) => W.sweep(s2(a[0]), W.smoothPath(W.toPoints(nums(a[1]), "sweep"), n(a[2])), n(a[3]), n(a[4]))),
    ov([shape2(), { name: "curve", type: "curve", doc: "a bezier() or curve()" }, num("twist", "degrees over the curve", 0), num("taper", "end scale", 1)], "shape",
      (a) => sweepCurve(s2(a[0]), a[1] as Curve, n(a[2]), n(a[3])))),
  def("bezier", "Paths", "An exact curve from cubic Bezier control points: an anchor, then two handles and an anchor for each piece (4, 7, 10, ... points). A tube or sweep along it is the true offset of the curve, with no facets at any grid, and costs about as much per piece as a spline's.",
    ov([{ name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }], "curve", (a) => bezierCurve(W.toPoints(nums(a[0]), "bezier")))),
  def("curve", "Paths", "An exact smooth curve through the points, the same shape spline() draws, for tube() and sweep(): the surface follows the true curve rather than a polyline through it.",
    ov([{ name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }], "curve", (a) => curveThrough(W.toPoints(nums(a[0]), "curve")))),
  def("helix", "Paths", "A path list for a helix of radius r around y, for tube() or sweep(): it starts at (r, 0, 0) and rises from y = 0 to y = h over `turns` turns.",
    ov([num("r"), num("h"), num("turns"), num("per_turn", "points per turn", 16)], "list", (a) => W.helixPath(n(a[0]), n(a[1]), n(a[2]), n(a[3])))),
  def("spline", "Paths", "A smooth path through the points, subdivided until no piece turns more than `degrees`: a curve that shows no faceting in a tube or sweep, however tight.",
    ov([{ name: "points", type: "list", doc: "a flat list [x,y,z, x,y,z, ...]" }, num("degrees", "largest turn between pieces", 3)], "list",
      (a) => W.splinePath(W.toPoints(nums(a[0]), "spline"), n(a[1])))),
  def("arc", "Paths", "A path list for an arc of radius r about `axis`: on the ground plane about y (0 is +z, 90 is +x); about x it stands in the yz plane (0 at +z, 90 at +y: a toe curling round a branch that lies along x); about z in the xy plane (0 at +y, 90 at +x).",
    ov([num("r"), num("from", "", 0), num("to", "", 90), num("segments", "", 16), str("axis", "y, x or z", "y")], "list", (a) => { const ax = String(a[4]); if (ax !== "x" && ax !== "y" && ax !== "z") throw new Error(`arc(): axis is x, y or z, not "${ax}"`); return W.arcPath(n(a[0]), n(a[1]), n(a[2]), n(a[3]), ax); })),
  def("loft", "Paths", "A solid h tall that is profile a at the bottom and profile b at the top, blending between them; centred on y = 0 like extrude (from -h/2 to h/2), each profile laid flat with its y along -z.",
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
  def("rest", "Transforms", "Move `part` along `dir` (straight down by default) until it touches `on`, then `sink` further: bowl | rest(plate) sets a bowl on its plate, book | rest(shelf) a book on its shelf, book | rest(prev, dir=[-1, 0, 0]) slides it along the shelf against its neighbour, all without the arithmetic. The contact is found from both surfaces' fields, the small parts of each at their own scale (a bowl's tab lands on a hook's lip 0.05 thick), and tightened on clearance(), so a promise of contact holds by construction: afterwards clearance(part, on) is within a millionth of the part's size of 0 (round 11's 33 books: 1.3e-6 at most) and overlap() reads 0, at any scale (the search runs at the part's own size, so a centimetre part in a model in metres places as a part of 1 does); on a displaced skin, whose field is not a distance, to about a ten-thousandth (round 3's frog on its pad: 3e-4). `on` may be several things joined with +: each is read on its own, so a shelf the part slides along does not pass for the neighbour it slides into. A part that starts inside `on` is first backed out against `dir` to the first place it is clear, so a part built at the origin rests on a shelf above it; one sunk a sliver into something (ground() leaves a turned part up to 5e-5 in the floor) is lifted out of it first; one that never touches `on` along `dir` is an error that says where both are. A face on a face meshes as one piece (pieces() reads 1 at every grid tried), but a corner on a face can mesh as two at some grids (a cube on its corner, at 128 cells): sink=0.02 pushes the part that far on into `on`, for a print or a promise of one piece, and a negative sink stops that far short (a gap between books). Anchors move with the part; check prints how far each call moved it. 10 to 60 ms a call for parts like these, one to two seconds for a frog with displaced skin",
    ov([shape("part"), shape("on", "what it comes to rest on: a shape, or several joined with +"), { name: "dir", type: "list", default: [0, -1, 0], doc: "the direction it moves in, [x, y, z]" }, num("sink", "how far to go on past the touch, into `on` (negative: stop that far short)", 0)], "shape", (a, _r, ctx) => {
      const dir = direction(a[2], "dir"), sink = n(a[3]);
      const names = partNames(ctx);
      emptyCheck(s3(a[0]), s3(a[1]), names, "move");
      return contactResult(restOn(s3(a[0]), s3(a[1]), dir, sink), ctx,
        (r) => ({ amount: r.amount, along: dir, gap: r.gap, backed: r.backed, lifted: r.lifted, sink }),
        () => `${names.part} (${boxText(s3(a[0]).bounds)}) never touches ${names.on} (${boxText(s3(a[1]).bounds)}) moving along ${vecText(dir)}: ${names.on} is not in its way. Move the part so ${names.on} is ahead of it along dir, or give the dir that leads there`,
        (depth) => `${names.part} starts ${Number(depth.toPrecision(2))} inside ${names.on}, and moving it back against dir ${vecText(dir)} does not free it (it is sunk into something it would slide along): leave that out of \`on\`, or move the part clear of it first`);
    })),
  def("lean", "Transforms", "Turn `part` about the line through `pivot` along `axis` until it touches `on`: book | lean(prev, pivot=\"heel\", axis=[0, 0, 1]) leans a book standing on its shelf against its neighbour, turned about its bottom edge. The pivot is a point [x, y, z] or the name of one of the part's anchors (a named one, or a free one: bottom, left, ...); a rounded edge stays on what it stands on when the pivot is its rounding's centre (0.02 in from both faces for round=0.02). It turns the right-handed way about `axis`, as rotate() turns about x, y and z: axis=[0, 0, 1] tips +y towards -x, so a book whose heel is its bottom-left edge leans left; axis=[0, 0, -1] turns the other way. Up to 180 degrees: an axis that turns the part away from `on` is an error, or a turn of more than a quarter, which check's line points out. The contact is tightened on clearance() as rest()'s is: clearance(part, on) afterwards is within a millionth of the part's size of 0 (round 11's three leaning books: 1.9e-6 at most, where the hand-worked placement left 0.0065 to 0.0076). A part that starts inside `on` is turned back the other way to the first angle it is clear. Anchors turn with the part; check prints the angle each call turned",
    ov([shape("part"), shape("on", "what it leans against"), { name: "pivot", type: "any", doc: "the point it turns about: [x, y, z], or the name of one of the part's anchors" }, { name: "axis", type: "list", doc: "the direction of the line it turns about, [x, y, z]; it turns the right-handed way about it" }], "shape", (a, _r, ctx) => {
      const part = s3(a[0]);
      const axisV = direction(a[3], "axis");
      emptyCheck(part, s3(a[1]), partNames(ctx), "turn");
      let pivot: [number, number, number];
      if (typeof a[2] === "string") {
        const p = O.anchorAt(part, a[2]);
        if (!p) throw new Error(`the part has no anchor "${a[2]}" to turn about; it has ${Object.keys(O.anchorsOf(part)).map((k) => `"${k}"`).join(", ") || "no named anchors"}, and every shape has ${O.FREE_ANCHORS.join(", ")}`);
        pivot = [p[0], p[1], p[2]];
      } else if (Array.isArray(a[2]) && a[2].length === 3 && a[2].every((x) => typeof x === "number")) pivot = a[2] as [number, number, number];
      else throw new Error(`pivot is a point [x, y, z] or the name of one of the part's anchors, "heel"`);
      const names = partNames(ctx);
      return contactResult(leanOn(part, s3(a[1]), pivot, axisV), ctx,
        (r) => ({ amount: r.amount, along: axisV, pivot, gap: r.gap, backed: r.backed, lifted: r.lifted, sink: 0 }),
        () => `${names.part} (${boxText(part.bounds)}) turned about ${vecText(axisV)} through (${pivot.map((v) => Number(v.toPrecision(4))).join(", ")}) never touches ${names.on} (${boxText(s3(a[1]).bounds)}) in half a turn: it turns the right-handed way about the axis, so axis=${vecText(axisV.map((v) => -v))} turns it the other way`,
        (depth) => `${names.part} starts ${Number(depth.toPrecision(2))} inside ${names.on}, and turning it back about ${vecText(axisV)} does not free it: leave out of \`on\` what it is sunk into, or move the part clear of it first`);
    })),
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
  def("grid", "Repetition", "nx by nz copies on the ground plane, dx and dz apart, stepping from the original towards +x and +z (a negative step goes the other way).",
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
  def("pieces", "Queries", "How many separate pieces the shape meshes into at `resolution` cells on its longest side: the report's Pieces row at that grid (cavities and specks left out). With none given, the model's own cell: the shown model's longest side over the program's `set grid`, so a part is meshed as the report meshes it and costs no more than the model's mesh, but never under 64 cells across the part nor over the grid itself (64 cells across the part without a `set grid`); pieces(), overhang(), wall(), support(), islands() and stands() share that rule. For assert pieces(model) == 1. Meshes the shape, so it costs a moment (once per shape and resolution in a run: pieces() and overhang() on the same shape share the mesh); a whole scene wants the report instead. A failure names the smallest loose piece: its volume, in mm³ (or the declared unit's cube) with `set units`, else in cubic units, where it is, and the step it is made of.",
    ov([shape(), num("resolution", "cells on the longest side", 64)], "number", (a, _r, ctx) => countPieces(s3(a[0]), n(a[1]), ctx?.meshes))),
  def("overhang", "Queries", "The fraction of the shape's surface that faces down more than 45° (the faces resting on the floor left out), 0 to 1, at `resolution` cells on its longest side (by default the model's own cell, as pieces() takes it): the report's Overhangs row. For assert overhang(model) < 0.05 on a part to be printed without support. Meshes the shape, so it costs a moment, the same mesh pieces() reads.",
    ov([shape(), num("resolution", "cells on the longest side", 64)], "number", (a, _r, ctx) => overhangFraction(s3(a[0]), n(a[1]), ctx?.meshes))),
  def("wall", "Queries", "The thinnest wall of the shape: from every vertex of its mesh at `resolution` cells on its longest side (by default the model's own cell, as pieces() takes it), a ray inward through the field to the far side, counted where the far side faces back within 30° (a wall, not the tip of a corner): the report's Thinnest wall row. The number is in model units: with `set units mm`, assert wall(model) > 0.8 promises two lines of a 0.4 mm nozzle; with `set units cm` the same promise is wall(model) > 0.08. Measured through the field, so a wall thinner than a cell is still measured where the mesh has a vertex on it; a part with no surface in the mesh at all (empty, or thinner than a cell everywhere) reads 0, so the promise fails rather than holding of nothing. Meshes the shape, so it costs a moment; a failure says where the thinnest wall is and the innermost steps whose faces bound it on each side, as the report's row does (thinnest at (...) in 'word', through to (...) in 'slot').",
    ov([shape(), num("resolution", "cells on the longest side", 64)], "number", (a, _r, ctx) => thinnestWall(s3(a[0]), n(a[1]), ctx?.meshes).thickness)),
  def("support", "Queries", "The support volume the shape's overhangs need, in cubic model units (mm³ for a print with `set units mm`): the report's Supports row, from each face that faces down more than 45° above the floor a column straight down to the plate or to the model below, its height times the face's area in plan, leaving out the bridges. A bridge is a level ceiling that spans at most `span` millimetres (16 by default, through `set units`; a unit is a millimetre without it) to solid that stands on something on both sides, laid in one direction for each connected ceiling as a slicer lays it (the direction anchored at both ends over the most of it, whatever the span): a slab between posts or walls, a lettering groove closed at both ends, and a slope closed at both ends along its level, a pitched roof between gables, as PrusaSlicer takes a straight overhanging perimeter that lands on the layer below at both ends. A dome, a cantilever, a slope or a horizontal hole open along its level and a bridge longer than the span need support. span=0 counts every overhang, as a slicer with supports on that supports bridges too fills them (PrusaSlicer's own printer profiles turn its \"Don't support bridges\" off). A face the mesher bends past 45° at a sharp edge, where the shape itself faces down less, is left out. For assert support(stand) < 50, the support kept small in the unit a printer's user reads, where overhang() is a share of the whole surface that one flat bridge barely moves; a point that hangs lower than all around it needs a column too and is counted by islands(), not here. An upper estimate: a slicer fills support sparsely. Meshes the shape at `resolution` cells on its longest side (by default the model's own cell, the mesh pieces(), overhang() and wall() read); a failure says where the tallest column is and what it stands on, and how much more lies under bridges.",
    ov([shape(), num("resolution", "cells on the longest side", 64), num("span", "the longest bridge, in millimetres; 0 bridges nothing", BRIDGE_MM)], "number", (a, _r, ctx) => supportOf(s3(a[0]), n(a[1]), ctx?.meshes, n(a[2]) / (ctx?.mmPerUnit ?? 1)).volume)),
  def("islands", "Queries", "How many islands the shape has: points lower than all the surface around them, off the plate, whose first layer prints in the air whatever the angles of their faces, a cone hanging tip down, a keel whose ends hang free, a part floating free, each needing a column of support that no face asks for (a keel running level into a wall is a line, not a point, and is not counted). For assert islands(part) == 0 beside assert support(part) == 0 on a part to be printed without support: a cone hanging off a wall with its sides at 60° reads no support and one island. The lowest point of every part of the surface that hangs clear of what is lower by more than half a cell before it joins it, facing down with the solid above it, and not already over faces that need support (a ball's underside has support of its own); the mesher's dips on a displaced or lettered surface are a fraction of that. Meshes the shape at `resolution` cells on its longest side (by default the model's own cell, the mesh support() reads); a failure says where each island is, in which step, and how tall its column is.",
    ov([shape(), num("resolution", "cells on the longest side", 64)], "number", (a, _r, ctx) => supportOf(s3(a[0]), n(a[1]), ctx?.meshes, BRIDGE_MM / (ctx?.mmPerUnit ?? 1)).islands.length)),
  def("stands", "Queries", "Whether the shape stands on its own: the margin by which its centre of mass (uniform density), projected on the floor, lies inside its footprint, the hull of what rests within a cell and a half of its lowest point, in units, positive inside and negative outside: the report's Stands row. For assert stands(bookcase) > 0.5. A shape balanced on an edge or a point still has a footprint, the strip of cells along the contact, so it reads a small positive margin that shrinks with the cell (a cube on its edge: 0.025 at 64 cells, 0.008 at 200): promise a margin of several cells, not > 0. A shape with no surface at that cell reads -Infinity. Meshes the shape at `resolution` cells on its longest side (by default the model's own cell, the mesh pieces() reads); a failure says where the centre of mass is and which way the shape tips.",
    ov([shape(), num("resolution", "cells on the longest side", 64)], "number", (a, _r, ctx) => standing(s3(a[0]), n(a[1]), ctx?.meshes).margin)),
  def("void", "Queries", "1 when `region` holds no solid of `shape` at all, else 0: the cavity of a cup with nothing poking into it (assert void(cavity, mug)), a slot a lid must not fill. The region is a shape of its own, not the cutter: a cutter's volume is empty by construction, so `void(hole, plate)` holds whether or not the hole went through; for \"goes through\" use a thinner rod reaching past both faces (void(rod, plate)). Sampled on a lattice over the region's box and along the shape's surface, so an intrusion thinner than the lattice is still caught, down to a skin a hundred-thousandth of the region's longest side deep (a 3.6 cable pressed 0.3 into both walls of a 3 slot fails); a failure says where the solid is and in which step.",
    ov([shape("region"), shape()], "number", (a) => (isVoid(s3(a[0]), s3(a[1])) ? 1 : 0))),
  def("overlap", "Queries", "The volume two shapes share, in cubic units: zero when they only touch, the sunk-in volume when one is pressed into the other (a frog blended into its pad, a handle reaching into a cup). For assert overlap(frog, pad) < 0.001, or assert overlap(pin, base) > 0.0004 for a pin that is joined, not resting: a volume is small (a pin of radius 0.05 sunk 0.07 shares 0.00055), so take the threshold from the part's size. Sampled on a lattice over the shared box, 24 cells along its longest side and at least four across its shortest (a rim sunk 0.02 into a base) within a budget of 200 thousand samples, whatever the shared box: a corner on a face, or two faces that meet to within floating point (a box ground()ed onto a board whose top came out of arithmetic), read 0 at once. Measure parts, not a scene; a failure says where.",
    ov([shape("a"), shape("b")], "number", (a) => overlapVolume(s3(a[0]), s3(a[1])))),
  def("inside", "Queries", "The fraction of `a`'s volume that lies inside `b`, 0 to 1: assert inside(spring, box) == 1 for a part that must stay in its housing, assert inside(handle, cavity) == 0 for one that must stay out. `b` is the solid volume, not a hollow: a mantle hangs in the air inside a shelled shade, so inside(mantle, shade) is 0; keep the un-shelled shape as a step and test against that. A part built to fill a cavity and grown a cell into the wall is under 1; promise inside(liquid, cavity) > 0.9 then. Sampled at 24 cells along a's longest side; when that reads 0 the surfaces are walked as void() walks them, so a skin thinner than the lattice (a 3.6 cable 0.3 into both walls of a 3 slot) reads a small fraction, never 0. A sliver of `a` outside `b` thinner than the lattice can still read 1. A failure says where `a` is inside `b` and where it is outside.",
    ov([shape("a"), shape("b")], "number", (a) => insideFraction(s3(a[0]), s3(a[1])))),
  def("clearance", "Queries", "The smallest gap between two shapes' surfaces, zero when they touch. Negative when they overlap: minus the depth of the deepest point either surface reaches inside the other, measured to the other's surface, which for a face sunk into a face or a round part pressed into another is how far they must be moved apart to only touch (a book whose top is 0.15 into a 0.2 board reads -0.15, though the board's top is only 0.05 above it); the same either way round, and a part wholly inside another reads how deep its surface lies, less than the move that would free it. For assert clearance(handle, rim) > 0.05. Sampled from the fields (12 points per side of each shape's box and of the box where the two meet, the best walked down each surface, so a rounded edge resting on a plane reads its true gap), so measure parts rather than a whole scene.",
    ov([shape("a"), shape("b")], "number", (a) => clearance(s3(a[0]), s3(a[1])))),

  // --- materials ---
  def("paint", "Materials", "Give the whole shape a material: a preset name, a colour (\"#rrggbb\" or a name), or material(...). Paint parts before combining them to keep several materials.",
    ov([shape(), mat()], "shape", (a) => O.paint(s3(a[0]), a[1] as Material))),
  def("decal", "Materials", "Paint only the part of the surface inside `region`, adding no geometry: a pupil on an eye (decal(eye, sphere(0.1) | move(...), \"black\")), a mouth line along a thin tube, a label on a jar. The region is any shape; its inside picks the material. With `image=\"label.png\"` (a PNG beside the program) the picture is fitted to the region's box across its shortest side, its transparent texels leaving the base material: a label on a jar, a logo, a face.",
    ov([shape(), shape("region", "the part of the surface inside this shape gets the material"), mat()], "shape", (a) => O.decal(s3(a[0]), s3(a[1]), a[2] as Material)),
    ov([shape(), shape("region", "the box the picture is fitted to, across its shortest side"), str("image", "a PNG file, relative to the program")], "shape", () => { throw new Error("a picture cannot be loaded here"); })),
  def("material", "Materials", "A custom material, from a colour or from a preset with some of its fields changed: material(\"granite\", scale=0.3). Patterns: " + PATTERNS.join(", ") + ". `scale` is the feature size in units; metal 0..1; rough 0..1; transmit 0..1 for glass; glow 0..2 for a flame or a lamp; bump (a height) and bump_scale (a size) for a surface rougher than the mesh, a hammered or cast or pitted finish; wear 0..1 for edges rubbed bright and dirt in the hollows. The `rust` pattern eats patches of `scale` across into the base, rough and not metal (oxide colour unless color2 is given), and wear rubs them off the edges. Patterns are laid out in the frame the part is painted in, along `axis` (default y): stripes are bands stacked along it, wood is boards across it with the grain along it, brick courses go round it, tiles and checks lie in the plane across it (floor tiles with the default y). Paint before moving the part, or set axis=\"x\" for stripes running the other way.",
    ov([str("color", "a colour, or a preset name to start from"), str("pattern", "", ""), str("color2", "second colour for two-tone patterns", ""), num("scale", "feature size in units", NaN), num("metal", "", NaN), num("rough", "", NaN), num("seed", "", NaN), num("transmit", "0 opaque .. 1 clear glass (beauty render only)", NaN), str("axis", "the pattern's axis: stripes stack along it, grain runs along it", ""), num("glow", "light the surface gives off, 0..2 (unshadowed, for flames and lamps)", NaN), num("bump", "bumps finer than the mesh, this high either way, in units: shaded in the beauty render and baked into the GLB's normal map, no geometry added", NaN), num("bump_scale", "the bumps' feature size in units (default ten times bump)", NaN), num("wear", "0..1, how used it looks: convex edges lighter (bare metal on a metal) and smoother, cavities darker and rougher, read from the shape's curvature", NaN), str("image", "a PNG file, relative to the program, painted instead of a pattern: `scale` is its width in units, its height following its shape", ""), str("projection", "how the picture wraps the part, in the frame it is painted in: planar (flat across `axis`, centred on the origin, one copy), cylindrical (round `axis` by arc length, repeating) or spherical (one copy round the origin)", "")], "material", makeMaterial)),
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
  // --- anchors ---
  def("anchor", "Anchors", "Name a point on a shape, in the shape's own frame: anchor(post, \"top\", 0, 1, 0). Every move, rotate, scale, warp and posed joint above it carries the point along, so at() reads it wherever the part ends up, and a union keeps every part's anchors (the first part wins a repeated name).",
    ov([shape(), str("name"), num("x"), num("y"), num("z")], "shape", (a) => O.anchor(s3(a[0]), a[1] as string, n(a[2]), n(a[3]), n(a[4])))),
  def("at", "Anchors", "The world point of a shape's anchor as [x, y, z]: one named with anchor(), or a free one every shape has from its box: centre, top, bottom, front, back, left, right (the box's face centres). In a pose, a point inside a joint is where the pose put it.",
    ov([shape(), str("name")], "list", (a) => {
      const p = O.anchorAt(s3(a[0]), a[1] as string);
      if (!p) throw new Error(`at(): no anchor "${a[1]}"; this shape has ${Object.keys(O.anchorsOf(s3(a[0]))).map((k) => `"${k}"`).join(", ") || "no named anchors"}, and every shape has ${O.FREE_ANCHORS.join(", ")}`);
      return [p[0], p[1], p[2]];
    })),
  def("attach", "Anchors", "Move `part` so its anchor lands on the target's anchor: attach(arm, \"root\", post, \"top\") is a move with no numbers. Either anchor may be a named one or a free one (top, bottom, ...). Rotate the part first, then attach it; the anchors turn with it. Face on face is a touch, which meshes as one piece at any grid; a corner or an edge on a face touches at a point or a line and may mesh apart. `sink=0.02` pushes the part that far into the target, along the line from its anchor to its own centre, for an overlap a print or a promise needs.",
    ov([shape("part"), str("anchor", "the part's anchor"), shape("target"), str("targetAnchor", "the target's anchor"), num("sink", "how far to push the part into the target", 0)], "shape", (a) => {
      const part = s3(a[0]);
      const from = O.anchorAt(part, a[1] as string), to = O.anchorAt(s3(a[2]), a[3] as string);
      if (!from) throw new Error(`attach(): the part has no anchor "${a[1]}"; it has ${Object.keys(O.anchorsOf(part)).map((k) => `"${k}"`).join(", ") || "no named anchors"}, and every shape has ${O.FREE_ANCHORS.join(", ")}`);
      if (!to) throw new Error(`attach(): the target has no anchor "${a[3]}"; it has ${Object.keys(O.anchorsOf(s3(a[2]))).map((k) => `"${k}"`).join(", ") || "no named anchors"}, and every shape has ${O.FREE_ANCHORS.join(", ")}`);
      const sink = n(a[4]);
      let dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
      if (sink !== 0) {
        // Into the target is away from the part's own centre, seen from its anchor.
        const c = boundsCenter(part.bounds);
        const ux = c[0] - from[0], uy = c[1] - from[1], uz = c[2] - from[2];
        const len = Math.hypot(ux, uy, uz);
        if (!(len > 1e-9)) throw new Error("attach(): sink needs the anchor away from the part's centre, to know which way is in");
        dx -= (ux / len) * sink; dy -= (uy / len) * sink; dz -= (uz / len) * sink;
      }
      return O.move(part, dx, dy, dz);
    })),
  def("surface", "Queries", "The point on a shape's surface nearest to (x, y, z), as [x, y, z]: where a rod, a foot or a decal should meet a curved body. Found by sliding along the field, so it is exact on primitives and close on blends and warps.",
    ov([shape(), num("x"), num("y"), num("z")], "list", (a) => { const p = O.surfacePoint(s3(a[0]), n(a[1]), n(a[2]), n(a[3])); return [p[0], p[1], p[2]]; })),
  def("named", "Assembly", "A step of its own for a value made in a loop: `books = books + named(\"book_\" + n, bk)` registers the step `book_3` (or whatever the name reads) holding that iteration's value, and returns the value, so each copy has a name for steps.png, the callouts, `set slice` and `--slice`, `--focus`, `camera(focus=)` and the warnings, and can be read by that name below the loop. A name is letters, digits and _, and names one step: naming the same one twice, or a name the program already has, is an error. A name first assigned inside a loop is the loop's own and is no step at all; see the language guide's Statements.",
    ov([str("name", "the step's name, usually built from the loop's index: \"book_\" + n"), { name: "value", type: "any", doc: "the value it holds, returned as it is" }], "any", (a) => a[1])),
  def("xform", "Assembly", "A joint's pose in one value, for pose(): xform(rotate=[x, y, z] degrees or one angle about the joint's axis, move=[dx, dy, dz] in world units after the turn, scale=s or [sx, sy, sz] about the pivot). pose(\"hop\", body=xform(move=[0, 0.3, 0]), lungs=xform(scale=[1, 1.02, 1])); a plain [x, y, z] in a pose is still just the angles.",
    ov([{ name: "rotate", type: "any", doc: "[x, y, z] degrees, or one angle for a joint with axis=", default: [0, 0, 0] }, { name: "move", type: "list", doc: "[dx, dy, dz]", default: [0, 0, 0] }, { name: "scale", type: "any", doc: "one number or [sx, sy, sz]", default: 1 }], "transform", (a) => {
      const r = a[0], mv = a[1], sc = a[2];
      const triple = (v: Value, what: string, fill: number): [number, number, number] => {
        if (typeof v === "number") return what === "scale" ? [v, v, v] : [v, fill, fill];
        if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number")) return [v[0] as number, v[1] as number, v[2] as number];
        throw new Error(`${what} must be [x, y, z]${what === "rotate" ? " degrees, or one angle for a joint with axis=" : what === "scale" ? " or one number" : ""}`);
      };
      const single = typeof r === "number";
      return { kind: "xform", angles: triple(r, "rotate", 0), single, move: triple(mv, "move", 0), scale: triple(sc, "scale", 1) };
    })),
  def("angle", "Queries", "The current pose's angles for a joint, as [x, y, z] degrees (all zero at rest, or for a joint the pose does not set): what a member between two moving bodies (a hydraulic cylinder, a strut) needs to work out its end points with sin and cos. Nested joints' angles are relative to their parent.",
    ov([str("joint", "the joint's name")], "list", (a) => { const v = CURRENT_ANGLES.get(a[0] as string) ?? [0, 0, 0]; return [v[0], v[1], v[2]]; })),
  def("joint_move", "Queries", "The current pose's move for a joint, as [dx, dy, dz] (zeros at rest): with joint_scale(), what a part inside a joint a pose moves or scales needs to ride it or undo it (a clown whose spring stretches but whose head should not).",
    ov([str("joint", "the joint's name")], "list", (a) => { const v = CURRENT_POSES.get(a[0] as string)?.move ?? [0, 0, 0]; return [v[0], v[1], v[2]]; })),
  def("joint_scale", "Queries", "The current pose's scale for a joint, as [sx, sy, sz] (ones at rest).",
    ov([str("joint", "the joint's name")], "list", (a) => { const v = CURRENT_POSES.get(a[0] as string)?.scale ?? [1, 1, 1]; return [v[0], v[1], v[2]]; })),
  def("len", "Numbers", "Length of a list.", ov([{ name: "list", type: "list" }], "number", (a) => (a[0] as Value[]).length)),
  def("sin", "Numbers", "Sine of an angle in degrees.", ov([num("degrees")], "number", (a) => Math.sin(rad(n(a[0]))))),
  def("cos", "Numbers", "Cosine of an angle in degrees.", ov([num("degrees")], "number", (a) => Math.cos(rad(n(a[0]))))),
  def("tan", "Numbers", "Tangent of an angle in degrees.", ov([num("degrees")], "number", (a) => Math.tan(rad(n(a[0]))))),
  def("asin", "Numbers", "Arcsine, in degrees.", ov([num("x")], "number", (a) => deg(Math.asin(n(a[0]))))),
  def("acos", "Numbers", "Arccosine, in degrees.", ov([num("x")], "number", (a) => deg(Math.acos(n(a[0]))))),
  def("atan", "Numbers", "Arctangent of y/x, in degrees; atan(y, x) takes the quadrant into account.",
    ov([num("y"), num("x", "", NaN)], "number", (a) => deg(Number.isNaN(n(a[1])) ? Math.atan(n(a[0])) : Math.atan2(n(a[0]), n(a[1]))))),
  def("sqrt", "Numbers", "Square root.", ov([num("x")], "number", (a) => Math.sqrt(n(a[0])))),
  def("str", "Numbers", "A number as text, for a name built from a def's index: str(3) is \"3\" (\"gondola_\" + i joins the same way).", ov([num("x")], "string", (a) => String(n(a[0])))),
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
