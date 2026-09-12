/**
 * Operators on 3D shapes: booleans, transforms, modifiers and repetition.
 *
 * Each returns a new Shape3 wrapping its inputs. Hard unions cull children by
 * bounding box, which is exact (a child whose box is farther than the best
 * distance so far cannot win the min), and is what keeps a model of a few
 * hundred parts cheap to extract.
 */
import { fbm3 } from "../core/noise.js";
import { apply, length2, rad, rotXYZ, transpose, type Mat3, type Vec3 } from "../core/vec.js";
import { DEFAULT_MATERIAL } from "./materials.js";
import { primitive } from "./primitives.js";
import { buildSpatialIndex, cellsFor } from "./spatial.js";
import { smax, smin } from "./shapes2d.js";
import {
  boundsCenter,
  boundsCorners,
  boundsSize,
  boundsDistance,
  boundsFromPoints,
  boundsGrow,
  boundsIntersect,
  boundsUnion,
  EMPTY_BOUNDS,
  FAR,
  isEmpty,
  type Bounds,
  type Hit,
  type JointState,
  type Material,
  type Placement,
  type Shape3,
} from "./types.js";

export function empty3(): Shape3 {
  return primitive(() => FAR, EMPTY_BOUNDS, 0);
}

// --- booleans ---------------------------------------------------------------

export function union(shapes: Shape3[], k = 0): Shape3 {
  // A hard union of hard unions is one flat list: `all = all + part` in a
  // loop then costs one box test per part instead of a chain of closures.
  const flat = k <= 0 ? shapes.flatMap((s) => s.parts ?? [s]) : shapes;
  const live = flat.filter((s) => !isEmpty(s.bounds));
  if (live.length === 0) return empty3();
  if (live.length === 1) return live[0];
  let bounds = EMPTY_BOUNDS;
  for (const s of live) bounds = boundsUnion(bounds, s.bounds);
  if (k > 0) bounds = boundsGrow(bounds, k / 2);
  const n = live.length;
  const fns = live.map((s) => s.dist);
  const hits = live.map((s) => s.hit);
  // Flattened child boxes for the cull test.
  const bmin = new Float64Array(n * 3), bmax = new Float64Array(n * 3);
  live.forEach((s, i) => {
    bmin.set(s.bounds.min, i * 3);
    bmax.set(s.bounds.max, i * 3);
  });
  const boxDist = (i: number, x: number, y: number, z: number): number => {
    const dx = Math.max(bmin[i * 3] - x, 0, x - bmax[i * 3]);
    const dy = Math.max(bmin[i * 3 + 1] - y, 0, y - bmax[i * 3 + 1]);
    const dz = Math.max(bmin[i * 3 + 2] - z, 0, z - bmax[i * 3 + 2]);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  const cost = live.reduce((c, s) => c + s.cost, 0);
  if (k <= 0) {
    // Many parts: a grid over their boxes, so a query touches only the parts near it.
    const size = boundsSize(bounds);
    const margin = Math.max(size[0], size[1], size[2]) * 0.1;
    const index = n > 12 ? buildSpatialIndex(n, bmin, bmax, { min: bounds.min.map((v) => v - margin), max: bounds.max.map((v) => v + margin) }, cellsFor(n)) : undefined;
    const piece = (i: number, x: number, y: number, z: number): number => fns[i](x, y, z);
    return {
      kind: "shape3",
      dist: (x, y, z) => {
        if (index) return index.min(x, y, z, piece, boxDist, FAR);
        let best = FAR;
        for (let i = 0; i < n; i++) {
          if (boxDist(i, x, y, z) >= best) continue;
          const d = fns[i](x, y, z);
          if (d < best) best = d;
        }
        return best;
      },
      hit: (x, y, z) => {
        let best: Hit | undefined;
        for (let i = 0; i < n; i++) {
          if (best && boxDist(i, x, y, z) >= best.d) continue;
          const h = hits[i](x, y, z);
          if (!best || h.d < best.d) best = h;
        }
        return best!;
      },
      bounds,
      cost,
      parts: live,
      inner: live,
      feature: minFeature(live),
    };
  }
  return {
    kind: "shape3",
    dist: (x, y, z) => {
      let best = FAR;
      for (let i = 0; i < n; i++) {
        if (boxDist(i, x, y, z) >= best + k) continue;
        best = smin(best, fns[i](x, y, z), k);
      }
      return best;
    },
    hit: (x, y, z) => {
      let best: Hit | undefined;
      let d = FAR;
      for (let i = 0; i < n; i++) {
        const h = hits[i](x, y, z);
        d = smin(d, h.d, k);
        if (!best || h.d < best.d) best = h;
      }
      return { ...best!, d };
    },
    bounds,
    cost,
    inner: live,
    feature: minFeature(live),
  };
}

/** The smallest known feature among shapes, or undefined when none carries one. */
function minFeature(shapes: Shape3[]): number | undefined {
  let f: number | undefined;
  for (const s of shapes) if (s.feature !== undefined && (f === undefined || s.feature < f)) f = s.feature;
  return f;
}

export function difference(a: Shape3, b: Shape3, k = 0): Shape3 {
  if (isEmpty(b.bounds)) return a;
  const da = a.dist, db = b.dist, ha = a.hit, hb = b.hit;
  return {
    kind: "shape3",
    dist: (x, y, z) => smax(da(x, y, z), -db(x, y, z), k),
    hit: (x, y, z) => {
      const h = ha(x, y, z);
      const d = smax(h.d, -hb(x, y, z).d, k);
      return { ...h, d };
    },
    bounds: a.bounds,
    cost: a.cost + b.cost,
    inner: [a, b],
    feature: a.feature,
  };
}

export function intersect(a: Shape3, b: Shape3, k = 0): Shape3 {
  const da = a.dist, db = b.dist, ha = a.hit, hb = b.hit;
  return {
    kind: "shape3",
    dist: (x, y, z) => smax(da(x, y, z), db(x, y, z), k),
    hit: (x, y, z) => {
      const p = ha(x, y, z), q = hb(x, y, z);
      const d = smax(p.d, q.d, k);
      return { ...(p.d >= q.d ? p : q), d };
    },
    bounds: boundsIntersect(a.bounds, b.bounds),
    cost: a.cost + b.cost,
    inner: [a, b],
    feature: a.feature,
  };
}

// --- transforms --------------------------------------------------------------

export function move(s: Shape3, dx: number, dy: number, dz: number): Shape3 {
  const d = s.dist, h = s.hit;
  const b = s.bounds;
  return {
    kind: "shape3",
    dist: (x, y, z) => d(x - dx, y - dy, z - dz),
    hit: (x, y, z) => h(x - dx, y - dy, z - dz),
    bounds: isEmpty(b) ? b : { min: [b.min[0] + dx, b.min[1] + dy, b.min[2] + dz], max: [b.max[0] + dx, b.max[1] + dy, b.max[2] + dz] },
    cost: s.cost,
    inner: [s],
    feature: s.feature,
  };
}

/** Rotate by a matrix `m` (applied to the shape); points are pulled back by its transpose. */
export function rotateBy(s: Shape3, m: Mat3): Shape3 {
  const t = transpose(m);
  const d = s.dist, h = s.hit;
  const bounds = isEmpty(s.bounds) ? s.bounds : boundsFromPoints(boundsCorners(s.bounds).map((c) => apply(m, c)));
  const [a, b, c, e, f, g, i, j, l] = t;
  return {
    kind: "shape3",
    dist: (x, y, z) => d(a * x + b * y + c * z, e * x + f * y + g * z, i * x + j * y + l * z),
    hit: (x, y, z) => h(a * x + b * y + c * z, e * x + f * y + g * z, i * x + j * y + l * z),
    bounds,
    cost: s.cost,
    inner: [s],
    feature: s.feature,
  };
}

/** Rotate by degrees about x, then y, then z. */
export function rotate(s: Shape3, rx: number, ry: number, rz: number): Shape3 {
  if (rx === 0 && ry === 0 && rz === 0) return s;
  return rotateBy(s, rotXYZ(rx, ry, rz));
}

/** Scale per axis. Non-uniform scale keeps a conservative distance (divided by the smallest factor). */
export function scale(s: Shape3, sx: number, sy: number, sz: number): Shape3 {
  const d = s.dist, h = s.hit;
  const m = Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sz));
  const b = s.bounds;
  const bounds: Bounds = isEmpty(b)
    ? b
    : boundsFromPoints(boundsCorners(b).map((c) => [c[0] * sx, c[1] * sy, c[2] * sz] as Vec3));
  return {
    kind: "shape3",
    dist: (x, y, z) => d(x / sx, y / sy, z / sz) * m,
    hit: (x, y, z) => {
      const r = h(x / sx, y / sy, z / sz);
      return { ...r, d: r.d * m };
    },
    bounds,
    cost: s.cost,
    inner: [s],
    feature: s.feature === undefined ? undefined : s.feature * m,
  };
}

export type Axis = "x" | "y" | "z";

export function flip(s: Shape3, axis: Axis): Shape3 {
  return scale(s, axis === "x" ? -1 : 1, axis === "y" ? -1 : 1, axis === "z" ? -1 : 1);
}

/** The shape together with its reflection across the plane perpendicular to `axis`. */
export function mirror(s: Shape3, axis: Axis): Shape3 {
  return union([s, flip(s, axis)]);
}

// --- modifiers ---------------------------------------------------------------

/** Grow the surface outward by `r` (rounding edges); negative shrinks. */
export function offset(s: Shape3, r: number): Shape3 {
  const d = s.dist, h = s.hit;
  return {
    kind: "shape3",
    dist: (x, y, z) => d(x, y, z) - r,
    hit: (x, y, z) => { const q = h(x, y, z); return { ...q, d: q.d - r }; },
    bounds: boundsGrow(s.bounds, Math.max(r, 0)),
    cost: s.cost,
    inner: [s],
    feature: s.feature,
  };
}

/** Hollow the shape, keeping a wall `t` thick inside its surface. Cut an opening to see in. */
export function shell(s: Shape3, t: number): Shape3 {
  const d = s.dist, h = s.hit;
  return {
    kind: "shape3",
    dist: (x, y, z) => { const v = d(x, y, z); return Math.max(v, -v - t); },
    hit: (x, y, z) => { const q = h(x, y, z); return { ...q, d: Math.max(q.d, -q.d - t) }; },
    bounds: s.bounds,
    cost: s.cost,
    inner: [s],
    feature: s.feature === undefined ? t : Math.min(s.feature, t),
  };
}

/** Twist about y by `degPerUnit` degrees for each unit of height. */
export function twist(s: Shape3, degPerUnit: number): Shape3 {
  const k = rad(degPerUnit);
  const d = s.dist, h = s.hit;
  const b = s.bounds;
  let bounds = b;
  if (!isEmpty(b)) {
    const r = Math.max(...boundsCorners(b).map((c) => length2(c[0], c[2])));
    bounds = { min: [-r, b.min[1], -r], max: [r, b.max[1], r] };
  }
  const warp = (x: number, y: number, z: number): Vec3 => {
    const a = -k * y, c = Math.cos(a), sn = Math.sin(a);
    return [c * x - sn * z, y, sn * x + c * z];
  };
  return {
    kind: "shape3",
    dist: (x, y, z) => { const p = warp(x, y, z); return d(p[0], p[1], p[2]); },
    hit: (x, y, z) => { const p = warp(x, y, z); return h(p[0], p[1], p[2]); },
    bounds,
    cost: s.cost,
    inner: [s],
    feature: s.feature,
  };
}

/** Bend about z: the shape curves upward by `degPerUnit` degrees for each unit along x. */
export function bend(s: Shape3, degPerUnit: number): Shape3 {
  const k = rad(degPerUnit);
  const d = s.dist, h = s.hit;
  const b = s.bounds;
  let bounds = b;
  if (!isEmpty(b)) {
    const r = Math.max(...boundsCorners(b).map((c) => length2(c[0], c[1])));
    bounds = { min: [-r, -r, b.min[2]], max: [r, r, b.max[2]] };
  }
  const warp = (x: number, y: number, z: number): Vec3 => {
    const a = k * x, c = Math.cos(a), sn = Math.sin(a);
    return [c * x - sn * y, sn * x + c * y, z];
  };
  return {
    kind: "shape3",
    dist: (x, y, z) => { const p = warp(x, y, z); return d(p[0], p[1], p[2]); },
    hit: (x, y, z) => { const p = warp(x, y, z); return h(p[0], p[1], p[2]); },
    bounds,
    cost: s.cost,
    inner: [s],
    feature: s.feature,
  };
}

/**
 * Push the surface in and out by up to `amp` with fractal noise of feature
 * size `size`. The noise is only evaluated within a few `amp` of the
 * surface: farther away it cannot change the sign, and the undisplaced
 * distance is within `amp` of the truth, which is all extraction needs.
 */
export function displace(s: Shape3, amp: number, size = 1, seed = 0): Shape3 {
  const d = s.dist, h = s.hit;
  const f = 1 / Math.max(size, 1e-6);
  const a = Math.abs(amp);
  const near = a * 3;
  const n = (x: number, y: number, z: number) => amp * (fbm3(x * f, y * f, z * f, seed, 4) * 2 - 1);
  const apply = (v: number, x: number, y: number, z: number): number => (v > near || v < -near ? v : v + n(x, y, z));
  return {
    kind: "shape3",
    dist: (x, y, z) => apply(d(x, y, z), x, y, z),
    hit: (x, y, z) => { const q = h(x, y, z); return { ...q, d: apply(q.d, x, y, z) }; },
    bounds: boundsGrow(s.bounds, Math.abs(amp)),
    cost: s.cost + 8,
    inner: [s],
    feature: s.feature,
  };
}

// --- repetition ----------------------------------------------------------------

export function array(s: Shape3, count: number, dx: number, dy: number, dz: number): Shape3 {
  const n = Math.max(1, Math.round(count));
  const copies: Shape3[] = [];
  for (let i = 0; i < n; i++) copies.push(move(s, dx * i, dy * i, dz * i));
  return union(copies);
}

export function grid(s: Shape3, nx: number, nz: number, dx: number, dz: number): Shape3 {
  const copies: Shape3[] = [];
  for (let i = 0; i < Math.max(1, Math.round(nx)); i++)
    for (let j = 0; j < Math.max(1, Math.round(nz)); j++) copies.push(move(s, dx * i, 0, dz * j));
  return union(copies);
}

/** `count` copies around the y axis, each first pushed out to `radius` along +x. */
export function ring(s: Shape3, count: number, radius = 0, axis: Axis = "y"): Shape3 {
  const n = Math.max(1, Math.round(count));
  const copies: Shape3[] = [];
  const pushed = radius ? (axis === "x" ? move(s, 0, radius, 0) : move(s, radius, 0, 0)) : s;
  for (let i = 0; i < n; i++) {
    const a = (360 / n) * i;
    copies.push(rotate(pushed, axis === "x" ? a : 0, axis === "y" ? a : 0, axis === "z" ? a : 0));
  }
  return union(copies);
}

// --- placement helpers -------------------------------------------------------

/** Move so the lowest point sits on y = 0. */
export function ground(s: Shape3): Shape3 {
  if (isEmpty(s.bounds)) return s;
  return move(s, 0, -s.bounds.min[1], 0);
}

/** Move so the bounding box is centred on the origin. */
export function center(s: Shape3, axes: string = "xyz"): Shape3 {
  if (isEmpty(s.bounds)) return s;
  const c = boundsCenter(s.bounds);
  return move(s, axes.includes("x") ? -c[0] : 0, axes.includes("y") ? -c[1] : 0, axes.includes("z") ? -c[2] : 0);
}

// --- materials --------------------------------------------------------------

/** Give every surface of `s` the material `m`; patterns are anchored to this frame. */
export function paint(s: Shape3, m: Material): Shape3 {
  const d = s.dist;
  return {
    kind: "shape3",
    dist: d,
    hit: (x, y, z) => ({ d: d(x, y, z), mat: m, lx: x, ly: y, lz: z }),
    bounds: s.bounds,
    cost: s.cost,
    inner: [s],
    feature: s.feature,
  };
}

// --- joints and instances ---------------------------------------------------

/**
 * A joint: `child` turned about `pivot` by `angles` (degrees about x, then
 * y, then z). A pose is applied by evaluating the program again with the
 * angles for each joint, so the joint is a plain rotation with exact
 * bounds; nested joints inside `child` are already turned by their own
 * angles when the parent is built, so they follow it. Declare a joint once
 * the part is in place (the pivot is a world point) and combine it with
 * `+` and `paint` afterwards, not `move`. While `hidden`, the whole
 * subtree reads as empty, which is how a parent's own geometry is meshed
 * without the parts that hang off it.
 */
export function joint(child: Shape3, name: string, px: number, py: number, pz: number, angles: Vec3 = [0, 0, 0]): Shape3 {
  const state: JointState = { name, pivot: [px, py, pz], child, angles: [angles[0], angles[1], angles[2]], hidden: false };
  const turned = angles[0] === 0 && angles[1] === 0 && angles[2] === 0 ? child : move(rotate(move(child, -px, -py, -pz), angles[0], angles[1], angles[2]), px, py, pz);
  const d = turned.dist, h = turned.hit;
  return {
    kind: "shape3",
    dist: (x, y, z) => (state.hidden ? FAR : d(x, y, z)),
    hit: (x, y, z) => (state.hidden ? { d: FAR, mat: DEFAULT_MATERIAL, lx: x, ly: y, lz: z } : h(x, y, z)),
    bounds: turned.bounds,
    cost: child.cost,
    inner: [child],
    joint: state,
    feature: child.feature,
  };
}

/** The joints anywhere inside a shape, outermost first, without descending into a joint's child. */
export function findJoints(s: Shape3): Shape3[] {
  const out: Shape3[] = [];
  const seen = new Set<Shape3>();
  const walk = (n: Shape3) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (n.joint) { out.push(n); return; }
    for (const i of n.inner ?? []) walk(i);
  };
  walk(s);
  return out;
}

/** Every joint in the tree, including nested ones. */
export function allJoints(s: Shape3): Shape3[] {
  const out: Shape3[] = [];
  const seen = new Set<Shape3>();
  const walk = (n: Shape3) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (n.joint) out.push(n);
    for (const i of n.inner ?? []) walk(i);
  };
  walk(s);
  return out;
}

/**
 * Copies of `base` at each placement (position, yaw about y, uniform
 * scale). For rendering it is the union of the copies; the exporters emit
 * the base once and a node per placement.
 */
export function place(base: Shape3, placements: Placement[]): Shape3 {
  const copies = placements.map((p) => {
    let s = base;
    if (p.scale !== 1) s = scale(s, p.scale, p.scale, p.scale);
    if (p.yaw !== 0) s = rotate(s, 0, p.yaw, 0);
    return move(s, p.x, p.y, p.z);
  });
  const u = union(copies);
  return { ...u, instanced: { base, placements } };
}

/**
 * The y of the highest surface of `s` above the point (x, z): a march down
 * from the top of the bounds. Undefined when nothing is there.
 */
export function heightAt(s: Shape3, x: number, z: number): number | undefined {
  if (isEmpty(s.bounds)) return undefined;
  const top = s.bounds.max[1], bottom = s.bounds.min[1];
  const span = Math.max(top - bottom, 1e-6);
  const eps = span * 1e-4;
  let y = top + eps;
  for (let i = 0; i < 512 && y >= bottom - eps; i++) {
    const d = s.dist(x, y, z);
    if (d < eps) {
      // Refine by bisection between the last outside point and here.
      let hi = y + Math.max(d, eps) * 2, lo = y;
      for (let k = 0; k < 24; k++) {
        const m = (hi + lo) / 2;
        if (s.dist(x, m, z) < 0) lo = m; else hi = m;
      }
      return hi;
    }
    y -= Math.max(d, eps);
  }
  return undefined;
}
