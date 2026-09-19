/**
 * The value types the language manipulates.
 *
 * A Shape3 is a signed distance function plus a bounding box and a material
 * query. `dist` is the hot path: it is called millions of times when the
 * surface is extracted, so it takes three numbers and returns one, and must
 * not allocate. `hit` is called once per mesh vertex and once per slice pixel
 * and may allocate; it says which material the nearest surface carries and
 * the point in that material's own frame, so procedural patterns move with
 * the part they were painted on.
 *
 * Distances outside the surface are exact for primitives and hard booleans
 * and conservative (never larger than the truth) after smooth blends,
 * twists, bends and displacement. Surface extraction only needs the sign and
 * values near zero, so that is enough.
 */
import type { Vec3 } from "../core/vec.js";

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface Bounds2 {
  min: [number, number];
  max: [number, number];
}

export type PatternKind =
  | "solid"
  | "checker"
  | "stripes"
  | "wood"
  | "marble"
  | "noise"
  | "speckle"
  | "brick"
  | "tiles"
  | "dots";

export interface Material {
  name: string;
  /** Base colour, linear-ish 0..1. */
  color: Vec3;
  /** Second colour for two-tone patterns. */
  color2: Vec3;
  pattern: PatternKind;
  /** Pattern feature size in model units. */
  scale: number;
  /** 0 = dielectric, 1 = metal: tints the highlight and darkens diffuse. */
  metal: number;
  /** 0 = mirror, 1 = matte. */
  rough: number;
  /** 0 = opaque, 1 = clear glass: the beauty render refracts and reflects; other outputs treat it as opaque. */
  transmit: number;
  seed: number;
  /** The axis a pattern is stacked along or oriented by: stripes cross it, wood grain and brick courses run along it. Default "y". */
  axis: "x" | "y" | "z";
  /** Light the surface gives off, 0..2: a flame, a lamp, a screen; added in the renders, unshadowed. */
  glow: number;
}

export interface Hit {
  d: number;
  mat: Material;
  lx: number;
  ly: number;
  lz: number;
}

export type DistFn3 = (x: number, y: number, z: number) => number;
export type HitFn3 = (x: number, y: number, z: number) => Hit;

export interface Shape3 {
  kind: "shape3";
  dist: DistFn3;
  hit: HitFn3;
  bounds: Bounds;
  /** Number of primitive evaluations one `dist` call can cost, for the report. */
  cost: number;
  /** For a hard union: its children, so a union of unions flattens into one culled list. */
  parts?: Shape3[];
  /** For any wrapper (transform, modifier, paint, boolean): the shapes it was built from, so a tree can be walked. */
  inner?: Shape3[];
  /**
   * The thinnest feature the shape is known to carry, in model units: a
   * shell's wall, a tube's diameter, a stroke's weight. Bounds cannot see
   * these, so the thin-part warning reads this instead.
   */
  feature?: number;
  /** The narrowest gap the shape is known to contain (a letter's counters, a slot), in model units: closes up under a cell. */
  gap?: number;
  /** What the narrowest gap is, for the warning: "the counter of 'A'", "the space between F and A". */
  gapWhat?: string;
  /** Set by paint() and decal(): the whole shape has a material of its own. Read structurally by the paint check. */
  painted?: boolean;
  /** Set by move, rotate and scale: below this node the shapes are in another frame, so they are not where they end up. */
  transform?: boolean;
  /** For a transform or warp: the world point in the child's frame, so a point can be attributed to the innermost named step. */
  unwarp?: (x: number, y: number, z: number) => Vec3;
  /** For a rigid transform or a joint: where a point of the child lands, so a step inside a posed joint can be framed where it is. */
  warp?: (x: number, y: number, z: number) => Vec3;
  /** For an import: the cell its mesh was sampled at, so a render finer than that can say what the import cannot show. */
  sampledAt?: number;
  /** Things a constructor noticed that will mesh badly (a curve bent tighter than its tube); the pipeline warns once per named step. */
  notes?: string[];
  /** Named points on the shape, in its own frame, set by anchor(); anchorsOf() carries them through the tree. */
  anchors?: Record<string, Vec3>;
  /** Set by a rotation or a warp: this box is the box of a turned box, and the surface's own extent is worth measuring. */
  loose?: boolean;
  /** Set by difference and intersection: only the first inner shape contributes its surface's material. */
  cut?: boolean;
  /** For a joint: its name, pivot (world), the shape it turns, and its live state. */
  joint?: JointState;
  /** For a placed shape: the base and where its copies go; while `hidden`, the whole set reads as empty (the exporter meshes its parent without it). */
  instanced?: { base: Shape3; placements: Placement[]; hidden?: boolean };
}

/** What a pose gives one joint: degrees about x, y, z (or about its axis, angles[0]), a move in world units, and a scale about the pivot. */
export interface JointPose {
  angles: Vec3;
  move: Vec3;
  scale: Vec3;
}

export const REST_POSE: JointPose = { angles: [0, 0, 0], move: [0, 0, 0], scale: [1, 1, 1] };

export interface JointState {
  name: string;
  pivot: Vec3;
  child: Shape3;
  /** The rotation this joint was built with, degrees about x, y, z (applied x, then y, then z); with an axis, angles[0] about it. */
  angles: Vec3;
  /** The move this joint was built with, after the turn, in world units; and the scale about the pivot, before it. */
  move: Vec3;
  scale: Vec3;
  /** When set, the joint turns about this one axis through the pivot and a pose gives it one angle (a steering column, a slanted hinge). */
  axis?: Vec3;
  /** When true the joint's whole subtree reads as empty, so a parent's own geometry can be meshed alone. */
  hidden: boolean;
}

/** One copy of an instanced shape: position and a yaw about y in degrees, with a uniform scale. */
export interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

export type DistFn2 = (x: number, y: number) => number;

export interface Shape2 {
  kind: "shape2";
  dist: DistFn2;
  bounds: Bounds2;
  cost: number;
  parts?: Shape2[];
  /** The thinnest feature the profile is known to carry (a stroke's weight, a 2D shell's wall); see Shape3.feature. */
  feature?: number;
  /** The narrowest gap the profile is known to contain; see Shape3.gap. */
  gap?: number;
  /** What that gap is; see Shape3.gapWhat. */
  gapWhat?: string;
}

export const EMPTY_BOUNDS: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
export const EMPTY_BOUNDS2: Bounds2 = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };

/** A distance to hand back for nothing at all: finite so smooth blends stay finite. */
export const FAR = 1e6;

export const isEmpty = (b: Bounds): boolean => b.min[0] > b.max[0] || b.min[1] > b.max[1] || b.min[2] > b.max[2];
export const isEmpty2 = (b: Bounds2): boolean => b.min[0] > b.max[0] || b.min[1] > b.max[1];

export function boundsUnion(a: Bounds, b: Bounds): Bounds {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function boundsIntersect(a: Bounds, b: Bounds): Bounds {
  if (isEmpty(a) || isEmpty(b)) return EMPTY_BOUNDS;
  return {
    min: [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])],
    max: [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])],
  };
}

export function boundsGrow(b: Bounds, r: number): Bounds {
  if (isEmpty(b)) return b;
  return {
    min: [b.min[0] - r, b.min[1] - r, b.min[2] - r],
    max: [b.max[0] + r, b.max[1] + r, b.max[2] + r],
  };
}

export function boundsFromPoints(points: Vec3[]): Bounds {
  let out = EMPTY_BOUNDS;
  for (const p of points) out = boundsUnion(out, { min: p, max: p });
  return out;
}

export function boundsCorners(b: Bounds): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++)
    out.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
  return out;
}

export function boundsSize(b: Bounds): Vec3 {
  if (isEmpty(b)) return [0, 0, 0];
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function boundsCenter(b: Bounds): Vec3 {
  if (isEmpty(b)) return [0, 0, 0];
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

/** Distance from a point to a box, zero inside: a lower bound on any shape inside that box. */
export function boundsDistance(b: Bounds, x: number, y: number, z: number): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function bounds2Union(a: Bounds2, b: Bounds2): Bounds2 {
  if (isEmpty2(a)) return b;
  if (isEmpty2(b)) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1])],
  };
}

export function bounds2Intersect(a: Bounds2, b: Bounds2): Bounds2 {
  if (isEmpty2(a) || isEmpty2(b)) return EMPTY_BOUNDS2;
  return {
    min: [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1])],
    max: [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1])],
  };
}

export function bounds2Grow(b: Bounds2, r: number): Bounds2 {
  if (isEmpty2(b)) return b;
  return { min: [b.min[0] - r, b.min[1] - r], max: [b.max[0] + r, b.max[1] + r] };
}
