/**
 * 2D profiles and the two ways to make them solid. A profile lives in the
 * x/y plane; `revolve` spins it around the y axis (x is the radius) and
 * `extrude` thickens it along an axis. Together they cover most turned and
 * cut-out shapes: vases, columns, gears, brackets, lettering.
 */
import { length2, rad } from "../core/vec.js";
import { primitive } from "./primitives.js";
import {
  bounds2Grow,
  bounds2Intersect,
  bounds2Union,
  EMPTY_BOUNDS2,
  FAR,
  isEmpty2,
  type Bounds2,
  type DistFn2,
  type Shape2,
  type Shape3,
} from "./types.js";

export function shape2(dist: DistFn2, bounds: Bounds2, cost = 1): Shape2 {
  return { kind: "shape2", dist, bounds, cost };
}

const sym2 = (hx: number, hy: number): Bounds2 => ({ min: [-hx, -hy], max: [hx, hy] });

export function circle(r: number): Shape2 {
  return shape2((x, y) => length2(x, y) - r, sym2(r, r));
}

export function rect(w: number, h: number, round = 0): Shape2 {
  const hx = Math.max(w / 2 - round, 0), hy = Math.max(h / 2 - round, 0);
  return shape2((x, y) => {
    const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy;
    return length2(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - round;
  }, sym2(w / 2, h / 2));
}

export function ellipse(rx: number, ry: number): Shape2 {
  return shape2((x, y) => {
    const k0 = length2(x / rx, y / ry);
    const k1 = length2(x / (rx * rx), y / (ry * ry));
    return k1 === 0 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1;
  }, sym2(rx, ry));
}

/** An arbitrary simple polygon from a flat list of x, y pairs. Exact distance, O(n). */
export function polygon(points: readonly number[]): Shape2 {
  const n = Math.floor(points.length / 2);
  if (n < 3) throw new Error(`polygon needs at least 3 points, got ${n}`);
  const vx = new Float64Array(n), vy = new Float64Array(n);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    vx[i] = points[i * 2];
    vy[i] = points[i * 2 + 1];
    minx = Math.min(minx, vx[i]); maxx = Math.max(maxx, vx[i]);
    miny = Math.min(miny, vy[i]); maxy = Math.max(maxy, vy[i]);
  }
  return shape2((px, py) => {
    let d = (px - vx[0]) * (px - vx[0]) + (py - vy[0]) * (py - vy[0]);
    let s = 1;
    for (let i = 0, j = n - 1; i < n; j = i, i++) {
      const ex = vx[j] - vx[i], ey = vy[j] - vy[i];
      const wx = px - vx[i], wy = py - vy[i];
      const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
      const bx = wx - ex * t, by = wy - ey * t;
      d = Math.min(d, bx * bx + by * by);
      const c1 = py >= vy[i], c2 = py < vy[j], c3 = ex * wy > ey * wx;
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    }
    return s * Math.sqrt(d);
  }, { min: [minx, miny], max: [maxx, maxy] }, n);
}

/** A regular polygon with `sides` sides and circumradius `r`, a vertex on +y. */
export function ngon(sides: number, r: number): Shape2 {
  const n = Math.max(3, Math.round(sides));
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(r * Math.sin(a), r * Math.cos(a));
  }
  return polygon(pts);
}

/** A star with `points` points, outer radius `r1`, inner radius `r2`, a point on +y. */
export function star(points: number, r1: number, r2: number): Shape2 {
  const n = Math.max(3, Math.round(points));
  const pts: number[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? r1 : r2;
    pts.push(r * Math.sin(a), r * Math.cos(a));
  }
  return polygon(pts);
}

export function empty2(): Shape2 {
  return shape2(() => FAR, EMPTY_BOUNDS2, 0);
}

// --- booleans ---------------------------------------------------------------

export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k);

export function union2(shapes: Shape2[], k = 0): Shape2 {
  const flat = k <= 0 ? shapes.flatMap((s) => s.parts ?? [s]) : shapes;
  const live = flat.filter((s) => !isEmpty2(s.bounds));
  if (live.length === 0) return empty2();
  if (live.length === 1 && k <= 0) return live[0];
  let bounds = EMPTY_BOUNDS2;
  for (const s of live) bounds = bounds2Union(bounds, s.bounds);
  if (k > 0) bounds = bounds2Grow(bounds, k / 2);
  const fns = live.map((s) => s.dist);
  const n = live.length;
  // Flattened boxes for culling, as in the 3D union.
  const bmin = new Float64Array(n * 2), bmax = new Float64Array(n * 2);
  live.forEach((s, i) => {
    bmin.set(s.bounds.min, i * 2);
    bmax.set(s.bounds.max, i * 2);
  });
  const boxDist = (i: number, x: number, y: number): number => {
    const dx = Math.max(bmin[i * 2] - x, 0, x - bmax[i * 2]);
    const dy = Math.max(bmin[i * 2 + 1] - y, 0, y - bmax[i * 2 + 1]);
    return Math.sqrt(dx * dx + dy * dy);
  };
  const out = shape2((x, y) => {
    let d = FAR;
    for (let i = 0; i < n; i++) {
      if (boxDist(i, x, y) >= d + k) continue;
      d = k > 0 ? smin(d, fns[i](x, y), k) : Math.min(d, fns[i](x, y));
    }
    return d;
  }, bounds, live.reduce((c, s) => c + s.cost, 0));
  if (k <= 0) out.parts = live;
  for (const s of live) if (s.feature !== undefined && (out.feature === undefined || s.feature < out.feature)) out.feature = s.feature;
  for (const s of live) if (s.gap !== undefined && (out.gap === undefined || s.gap < out.gap)) out.gap = s.gap;
  return out;
}

export function difference2(a: Shape2, b: Shape2, k = 0): Shape2 {
  const da = a.dist, db = b.dist;
  return keep(shape2((x, y) => smax(da(x, y), -db(x, y), k), a.bounds, a.cost + b.cost), a);
}

export function intersect2(a: Shape2, b: Shape2, k = 0): Shape2 {
  const da = a.dist, db = b.dist;
  return keep(shape2((x, y) => smax(da(x, y), db(x, y), k), bounds2Intersect(a.bounds, b.bounds), a.cost + b.cost), a);
}

/** The result carries the feature size of the shape it was built from (scaled by `by`). */
function keep(out: Shape2, from: Shape2, by = 1): Shape2 {
  if (from.feature !== undefined) out.feature = from.feature * by;
  if (from.gap !== undefined) out.gap = from.gap * by;
  return out;
}

// --- transforms and modifiers ------------------------------------------------

export function move2(s: Shape2, dx: number, dy: number): Shape2 {
  const d = s.dist;
  const b = s.bounds;
  return keep(shape2((x, y) => d(x - dx, y - dy), isEmpty2(b) ? b : { min: [b.min[0] + dx, b.min[1] + dy], max: [b.max[0] + dx, b.max[1] + dy] }, s.cost), s);
}

export function rotate2(s: Shape2, deg: number): Shape2 {
  const c = Math.cos(rad(deg)), sn = Math.sin(rad(deg));
  const d = s.dist;
  const b = s.bounds;
  let bounds = b;
  if (!isEmpty2(b)) {
    bounds = EMPTY_BOUNDS2;
    for (const [px, py] of [b.min, [b.max[0], b.min[1]], b.max, [b.min[0], b.max[1]]] as [number, number][]) {
      const rx = c * px - sn * py, ry = sn * px + c * py;
      bounds = bounds2Union(bounds, { min: [rx, ry], max: [rx, ry] });
    }
  }
  // Inverse rotation of the point.
  return keep(shape2((x, y) => d(c * x + sn * y, -sn * x + c * y), bounds, s.cost), s);
}

export function scale2(s: Shape2, sx: number, sy: number): Shape2 {
  const d = s.dist;
  const m = Math.min(Math.abs(sx), Math.abs(sy));
  const b = s.bounds;
  const bounds: Bounds2 = isEmpty2(b)
    ? b
    : {
        min: [Math.min(b.min[0] * sx, b.max[0] * sx), Math.min(b.min[1] * sy, b.max[1] * sy)],
        max: [Math.max(b.min[0] * sx, b.max[0] * sx), Math.max(b.min[1] * sy, b.max[1] * sy)],
      };
  return keep(shape2((x, y) => d(x / sx, y / sy) * m, bounds, s.cost), s, m);
}

export function flip2(s: Shape2, axis: "x" | "y"): Shape2 {
  return scale2(s, axis === "x" ? -1 : 1, axis === "y" ? -1 : 1);
}

export function mirror2(s: Shape2, axis: "x" | "y"): Shape2 {
  return union2([s, flip2(s, axis)]);
}

/** Grow (r > 0) or shrink (r < 0) the profile by `r`, rounding convex corners. */
export function offset2(s: Shape2, r: number): Shape2 {
  const d = s.dist;
  return keep(shape2((x, y) => d(x, y) - r, bounds2Grow(s.bounds, Math.max(r, 0)), s.cost), s);
}

/** Keep only a band of width `t` inside the profile's outline. */
export function shell2(s: Shape2, t: number): Shape2 {
  const d = s.dist;
  const out = shape2((x, y) => { const v = d(x, y); return Math.max(v, -v - t); }, s.bounds, s.cost);
  out.feature = s.feature === undefined ? t : Math.min(s.feature, t);
  return out;
}

// --- to 3D ------------------------------------------------------------------

export type ExtrudeAxis = "x" | "y" | "z";

/**
 * Extrude a profile to thickness `h`, centred on the plane it lies in.
 * axis "y" (default): the profile lies flat, its y running towards -z, so the
 * top view matches the drawing. axis "z": the profile faces +z. axis "x": the
 * profile faces +x, its x running towards -z.
 */
export function extrude(profile: Shape2, h: number, axis: ExtrudeAxis = "y"): Shape3 {
  const d = profile.dist, hh = h / 2;
  const b = profile.bounds;
  const bounds = isEmpty2(b)
    ? { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] }
    : axis === "y"
      ? { min: [b.min[0], -hh, -b.max[1]] as [number, number, number], max: [b.max[0], hh, -b.min[1]] as [number, number, number] }
      : axis === "z"
        ? { min: [b.min[0], b.min[1], -hh] as [number, number, number], max: [b.max[0], b.max[1], hh] as [number, number, number] }
        : { min: [-hh, b.min[1], -b.max[0]] as [number, number, number], max: [hh, b.max[1], -b.min[0]] as [number, number, number] };
  const inner = (d2: number, along: number): number => {
    const wy = Math.abs(along) - hh;
    return Math.min(Math.max(d2, wy), 0) + length2(Math.max(d2, 0), Math.max(wy, 0));
  };
  const dist =
    axis === "y"
      ? (x: number, y: number, z: number) => inner(d(x, -z), y)
      : axis === "z"
        ? (x: number, y: number, z: number) => inner(d(x, y), z)
        : (x: number, y: number, z: number) => inner(d(-z, y), x);
  const out = primitive(dist, bounds, profile.cost);
  out.feature = profile.feature;
  out.gap = profile.gap;
  return out;
}

/**
 * Revolve a profile around the y axis: the profile's x is the radius, shifted
 * out by `offset`. Draw the profile on x >= 0; anything on x < 0 is folded over.
 */
export function revolve(profile: Shape2, offset = 0, angle = 360): Shape3 {
  const d = profile.dist;
  const b = profile.bounds;
  const R = isEmpty2(b) ? 0 : Math.max(Math.abs(b.min[0] + offset), Math.abs(b.max[0] + offset));
  const bounds = isEmpty2(b)
    ? { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] }
    : { min: [-R, b.min[1], -R] as [number, number, number], max: [R, b.max[1], R] as [number, number, number] };
  if (angle >= 360) {
    const full = primitive((x, y, z) => d(length2(x, z) - offset, y), bounds, profile.cost);
    full.feature = profile.feature;
    full.gap = profile.gap;
    return full;
  }
  // A partial revolve: the profile sweeps from +z (0 degrees) towards +x through `angle` degrees.
  // Outside the wedge the distance is to the nearer of the two end faces of the sweep.
  const half = (Math.max(0, angle) * Math.PI) / 360;
  const mid = half; // wedge centred on angle/2 so it starts at 0
  const out = primitive((x, y, z) => {
    // Angle of the point about y measured from +z towards +x, folded about the wedge's middle.
    const a = Math.atan2(x, z) - mid;
    const aa = Math.abs(((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
    const r = length2(x, z);
    if (aa <= half) return d(r - offset, y);
    // Rotate the point onto the nearer end plane and measure the profile there, plus the out-of-plane distance.
    const over = aa - half;
    const inPlane = r * Math.cos(over);
    const off = r * Math.sin(over);
    const d2 = d(inPlane - offset, y);
    return d2 > 0 ? length2(d2, off) : off > 0 ? off : d2;
  }, bounds, profile.cost);
  out.feature = profile.feature;
  out.gap = profile.gap;
  return out;
}
