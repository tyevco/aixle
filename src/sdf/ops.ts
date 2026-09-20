/**
 * Operators on 3D shapes: booleans, transforms, modifiers and repetition.
 *
 * Each returns a new Shape3 wrapping its inputs. Hard unions cull children by
 * bounding box, which is exact (a child whose box is farther than the best
 * distance so far cannot win the min), and is what keeps a model of a few
 * hundred parts cheap to extract.
 */
import { fbm3 } from "../core/noise.js";
import { apply, length2, rad, rotAxis, rotXYZ, transpose, type Mat3, type Vec3 } from "../core/vec.js";
import { DEFAULT_MATERIAL } from "./materials.js";
import { primitive, cylinder } from "./primitives.js";
import { buildSpatialIndex, cellsFor } from "./spatial.js";
import { smax, smin } from "./shapes2d.js";
import { boundsCenter, boundsCorners, boundsSize, boundsDistance, boundsFromPoints, boundsGrow, boundsIntersect, boundsUnion, EMPTY_BOUNDS, FAR, isEmpty, type Bounds, type Hit, type JointState, type Material, type Placement, type Shape3 } from "./types.js";

export function empty3(): Shape3 {
  return primitive(() => FAR, EMPTY_BOUNDS, 0);
}

// --- booleans ---------------------------------------------------------------

export function union(shapes: Shape3[], k = 0): Shape3 {
  // A hard union of hard unions is one flat list: `all = all + part` in a
  // loop then costs one box test per part instead of a chain of closures.
  // A placed set stays one part: flattening it into its copies would lose the set (its per-copy nodes in the
  // export, its hidden switch) and the pawns of a `board + pawns` became one mesh (measured).
  const flat = k <= 0 ? shapes.flatMap((s) => (s.parts && !s.instanced ? s.parts : [s])) : shapes;
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
    gap: minGap(live),
    gapWhat: minGapWhat(live),
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
    gap: minGap(live),
    gapWhat: minGapWhat(live),
  };
}

/** The narrowest known gap among shapes, or undefined when none carries one. */
function minGap(shapes: Shape3[]): number | undefined {
  let g: number | undefined;
  for (const s of shapes) if (s.gap !== undefined && (g === undefined || s.gap < g)) g = s.gap;
  return g;
}

function minGapWhat(shapes: Shape3[]): string | undefined {
  let g: number | undefined, what: string | undefined;
  for (const s of shapes) if (s.gap !== undefined && (g === undefined || s.gap < g)) { g = s.gap; what = s.gapWhat; }
  return what;
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
    cut: true,
    feature: a.feature,
    gap: a.gap,
    gapWhat: a.gapWhat,
  };
}

export function intersect(a: Shape3, b: Shape3, k = 0): Shape3 {
  const da = a.dist, db = b.dist, ha = a.hit, hb = b.hit;
  return {
    kind: "shape3",
    dist: (x, y, z) => smax(da(x, y, z), db(x, y, z), k),
    hit: (x, y, z) => {
      // Like difference, the first shape's material shows everywhere: `a & b` keeps a's paint on the faces b cut
      // (measured: a painted lemon row intersected with a box came out in the box's default grey on the cut faces).
      const p = ha(x, y, z);
      const d = smax(p.d, hb(x, y, z).d, k);
      return { ...p, d };
    },
    bounds: boundsIntersect(a.bounds, b.bounds),
    cost: a.cost + b.cost,
    inner: [a, b],
    cut: true,
    feature: a.feature,
    gap: a.gap,
    gapWhat: a.gapWhat,
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
    transform: true,
    unwarp: (x, y, z) => [x - dx, y - dy, z - dz],
    warp: (x, y, z) => [x + dx, y + dy, z + dz],
    feature: s.feature,
    gap: s.gap,
    gapWhat: s.gapWhat,
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
    transform: true,
    unwarp: (x, y, z) => [a * x + b * y + c * z, e * x + f * y + g * z, i * x + j * y + l * z],
    warp: (x, y, z) => apply(m, [x, y, z]),
    loose: true,
    feature: s.feature,
    gap: s.gap,
    gapWhat: s.gapWhat,
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
    transform: true,
    unwarp: (x, y, z) => [x / sx, y / sy, z / sz],
    warp: (x, y, z) => [x * sx, y * sy, z * sz],
    feature: s.feature === undefined ? undefined : s.feature * m,
    gap: s.gap === undefined ? undefined : s.gap * m,
    gapWhat: s.gapWhat,
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
    gap: s.gap,
    gapWhat: s.gapWhat,
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
    gap: s.gap,
    gapWhat: s.gapWhat,
  };
}

/**
 * Hollow for printing: a shell with a drain hole of radius `r` cut through
 * the wall at the drain point (on the bottom, usually), so resin or
 * support can escape and the void is not an enclosed cavity.
 */
export function hollow(s: Shape3, wall: number, dx: number, dy: number, dz: number, r = wall): Shape3 {
  const shelled = shell(s, wall);
  const hole = move(cylinder(r, wall * 6), dx, dy, dz);
  const out = difference(shelled, hole);
  return out;
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
    unwarp: warp,
    warp: (x, y, z) => { const a = k * y, c = Math.cos(a), sn = Math.sin(a); return [c * x - sn * z, y, sn * x + c * z]; },
    loose: true,
    feature: s.feature,
    gap: s.gap,
    gapWhat: s.gapWhat,
  };
}

/**
 * Bend about z: the shape's x axis becomes an arc of a circle of radius
 * R = 1 / k (k in radians per unit) centred at (0, R), so the shape curves
 * upward by `degPerUnit` degrees for each unit along x; a point at height y
 * rides at radius R - y. Exact (an isometry along the arc, a mild stretch
 * across it), so a bent bar's box can be computed from its corners and
 * `check` can place it. Negative degrees bend downward. Earlier this was a
 * rotate-by-x warp with no circle to reason about (measured: an agent could
 * not find where bent text had gone).
 */
export function bend(s: Shape3, degPerUnit: number): Shape3 {
  if (degPerUnit === 0) return s;
  const k = rad(degPerUnit);
  const R = 1 / k;
  const d = s.dist, h = s.hit;
  const b = s.bounds;
  let bounds = b;
  if (!isEmpty(b)) {
    // Sample the box's outline along x at both y extremes and take the mapped hull, grown a little for the arc between samples.
    bounds = EMPTY_BOUNDS;
    const n = 64;
    const pts: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const x = b.min[0] + ((b.max[0] - b.min[0]) * i) / n;
      const a = k * x;
      for (const y of [b.min[1], b.max[1]]) {
        const r = R - y;
        for (const z of [b.min[2], b.max[2]]) pts.push([r * Math.sin(a), R - r * Math.cos(a), z]);
      }
    }
    bounds = boundsFromPoints(pts);
    const step = (k * (b.max[0] - b.min[0])) / n;
    bounds = boundsGrow(bounds, Math.max(Math.abs(R - b.min[1]), Math.abs(R - b.max[1])) * (1 - Math.cos(step / 2)) + 1e-9);
  }
  // Inverse: the angle of the point about the circle's centre gives x, its distance from the centre gives y.
  // Measured from the point to the centre; with a negative R the centre is below and the angle is read the other way.
  const sg = Math.sign(R);
  const unwarp = (x: number, y: number, z: number): Vec3 => {
    const dx = x, dy = R - y;
    const a = Math.atan2(dx * sg, dy * sg);
    return [a * R, R - Math.hypot(dx, dy) * sg, z];
  };
  // Forward: a point at (u, v) in the flat shape rides the arc at angle u / R, radius R - v from the centre.
  const warp = (u: number, v: number, w: number): Vec3 => {
    const a = u / R, rho = (R - v) * sg;
    return [rho * Math.sin(a) * sg, R - rho * Math.cos(a) * sg, w];
  };
  return {
    kind: "shape3",
    dist: (x, y, z) => { const p = unwarp(x, y, z); return d(p[0], p[1], p[2]); },
    hit: (x, y, z) => { const p = unwarp(x, y, z); return h(p[0], p[1], p[2]); },
    bounds,
    cost: s.cost,
    inner: [s],
    unwarp,
    warp,
    loose: true,
    feature: s.feature,
    gap: s.gap,
    gapWhat: s.gapWhat,
  };
}

/**
 * Wrap around y: the shape's x axis becomes the circumference of a cylinder
 * of radius `r` about y, its +z face outward, x = 0 landing on +z and
 * positive x going towards +x (reading left to right when seen from the
 * front). A point at depth z rides at radius r + z. Standing lettering
 * (extrude(text, h, "z")) wrapped this way is a label round a jar or a
 * name round a cup's rim: the request that every agent made by hand.
 */
export function wrap(s: Shape3, r: number): Shape3 {
  const d = s.dist, h = s.hit;
  const b = s.bounds;
  let bounds = b;
  if (!isEmpty(b)) {
    const outer = r + Math.max(b.max[2], 0) + 1e-9;
    const span = Math.abs(b.max[0] - b.min[0]) / r;
    if (span >= Math.PI * 2 - 1e-6) bounds = { min: [-outer, b.min[1], -outer], max: [outer, b.max[1], outer] };
    else {
      const pts: Vec3[] = [];
      const n = 64;
      for (let i = 0; i <= n; i++) {
        const a = (b.min[0] + ((b.max[0] - b.min[0]) * i) / n) / r;
        for (const z of [b.min[2], b.max[2]]) {
          const rr = r + z;
          for (const y of [b.min[1], b.max[1]]) pts.push([rr * Math.sin(a), y, rr * Math.cos(a)]);
        }
      }
      bounds = boundsGrow(boundsFromPoints(pts), outer * (1 - Math.cos(span / n / 2)) + 1e-9);
    }
  }
  const unwarp = (x: number, y: number, z: number): Vec3 => [Math.atan2(x, z) * r, y, Math.hypot(x, z) - r];
  const warp = (u: number, v: number, w: number): Vec3 => [(r + w) * Math.sin(u / r), v, (r + w) * Math.cos(u / r)];
  return {
    kind: "shape3",
    dist: (x, y, z) => { const p = unwarp(x, y, z); return d(p[0], p[1], p[2]); },
    hit: (x, y, z) => { const p = unwarp(x, y, z); return h(p[0], p[1], p[2]); },
    bounds,
    cost: s.cost,
    inner: [s],
    unwarp,
    warp,
    loose: true,
    feature: s.feature,
    gap: s.gap,
    gapWhat: s.gapWhat,
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
    gap: s.gap,
    gapWhat: s.gapWhat,
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

/**
 * The extent of the surface itself, as a box: rays marched inward from a
 * grid on each face of the bounds, the nearest hit on each face refined
 * within one ray spacing. Bounds are boxes: a smooth union pads them by its
 * blend, a difference keeps the box of what it cut away, a turned joint has
 * the box of a turned box, and ground() by bounds once lifted a frog whose
 * shins reached the pad by a tenth of a unit (measured). Rays see anything
 * at least a spacing thick in the two directions across them; a coarse
 * extraction pass, which this replaced, missed a plate thinner than its
 * cell that no sample plane fell inside (measured: a lily pad 0.12 thick
 * under a 4.4-unit frog came back 1.8 wide instead of 2.2). A face no ray
 * hits keeps the bounds' value.
 */
export function surfaceExtent(s: Shape3, rays = 48): Bounds {
  const b = s.bounds;
  if (isEmpty(b)) return b;
  const size = boundsSize(b);
  const longest = Math.max(size[0], size[1], size[2]);
  const eps = Math.max(1e-7, longest * 2e-5);
  const d = s.dist;
  const out: Bounds = { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
  // March from `start` along axis `a` in direction `dir` (+1 or -1) until the surface; Infinity when it runs out.
  const march = (p: Vec3, a: number, dir: number, limit: number): number => {
    let t = 0;
    const q: Vec3 = [p[0], p[1], p[2]];
    for (let i = 0; i < 200 && t <= limit; i++) {
      const v = d(q[0], q[1], q[2]);
      if (v < eps) return t;
      t += v;
      q[a] = p[a] + dir * t;
    }
    return Infinity;
  };
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3;
    for (const dir of [1, -1]) {
      const startA = (dir === 1 ? b.min[a] : b.max[a]) - dir * eps * 4;
      const limit = size[a] + eps * 8;
      let best = Infinity, bi = 0, bj = 0;
      for (let i = 0; i < rays; i++)
        for (let j = 0; j < rays; j++) {
          const p: Vec3 = [0, 0, 0];
          p[a] = startA;
          p[u] = b.min[u] + ((i + 0.5) / rays) * size[u];
          p[v] = b.min[v] + ((j + 0.5) / rays) * size[v];
          const t = march(p, a, dir, limit);
          if (t < best) { best = t; bi = i; bj = j; }
        }
      if (best === Infinity) continue;
      // Refine within one ray spacing of the best ray.
      const su = size[u] / rays, sv = size[v] / rays;
      const cu = b.min[u] + (bi + 0.5) * su, cv = b.min[v] + (bj + 0.5) * sv;
      for (let i = -6; i <= 6; i++)
        for (let j = -6; j <= 6; j++) {
          const p: Vec3 = [0, 0, 0];
          p[a] = startA;
          p[u] = cu + (i / 6) * su;
          p[v] = cv + (j / 6) * sv;
          const t = march(p, a, dir, limit);
          if (t < best) best = t;
        }
      const hit = startA + dir * best;
      if (dir === 1) out.min[a] = Math.max(b.min[a], Math.min(b.max[a], hit));
      else out.max[a] = Math.min(b.max[a], Math.max(b.min[a], hit));
    }
  }
  return out;
}

/** The lowest y of the surface itself (see surfaceExtent); the bounds' bottom when no ray from below hits. */
export function surfaceBottom(s: Shape3, rays = 48): number {
  return surfaceExtent(s, rays).min[1];
}

/** Move the shape so the lowest point of its surface rests on y = 0 (the surface, not the bounds: see surfaceBottom). */
export function ground(s: Shape3): Shape3 {
  if (isEmpty(s.bounds)) return s;
  return move(s, 0, -surfaceBottom(s), 0);
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
    gap: s.gap,
    gapWhat: s.gapWhat,
    painted: true,
  };
}

/**
 * Paint only the part of the surface that lies inside `region`: a pupil on
 * an eye, a mouth, a label, a stripe, with no geometry added. The shape is
 * unchanged; the material query answers `m` where the region's distance is
 * negative.
 */
export function decal(s: Shape3, region: Shape3, m: Material): Shape3 {
  const d = s.dist, h = s.hit, rd = region.dist;
  // Only a skin: deeper than a tenth of the region's smallest side the base material shows, so a cross-section
  // does not draw the region as a solid inside the part (measured: a frog's belly decal read as an organ).
  const rs = isEmpty(region.bounds) ? 1 : Math.max(1e-6, Math.min(...boundsSize(region.bounds)) * 0.1);
  return {
    kind: "shape3",
    dist: d,
    hit: (x, y, z) => {
      const v = d(x, y, z);
      return v > -rs && rd(x, y, z) <= 0 ? { d: v, mat: m, lx: x, ly: y, lz: z } : h(x, y, z);
    },
    bounds: s.bounds,
    cost: s.cost + region.cost,
    // The region is paint, not geometry: it stays out of the tree so nothing counts it as a part.
    inner: [s],
    feature: s.feature,
    gap: s.gap,
    gapWhat: s.gapWhat,
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
export function joint(child: Shape3, name: string, px: number, py: number, pz: number, angles: Vec3 = [0, 0, 0], axis?: Vec3, offset: Vec3 = [0, 0, 0], scl: Vec3 = [1, 1, 1]): Shape3 {
  const state: JointState = { name, pivot: [px, py, pz], child, angles: [angles[0], angles[1], angles[2]], move: [offset[0], offset[1], offset[2]], scale: [scl[0], scl[1], scl[2]], hidden: false, axis };
  // About one axis when given (a steering column raked 18 degrees is one number, not an Euler triple worked out
  // elsewhere: round 5), else x, then y, then z. A pose may also scale the part about the pivot (a breathing body)
  // and move it after the turn (a hop), the order a glTF node applies its scale, rotation and translation.
  const m = axis ? rotAxis(axis, angles[0]) : rotXYZ(angles[0], angles[1], angles[2]);
  const turns = axis ? angles[0] !== 0 : angles[0] !== 0 || angles[1] !== 0 || angles[2] !== 0;
  const scaled = scl[0] !== 1 || scl[1] !== 1 || scl[2] !== 1;
  const moved = offset[0] !== 0 || offset[1] !== 0 || offset[2] !== 0;
  let turned = child;
  if (turns || scaled || moved) {
    let inner = move(child, -px, -py, -pz);
    if (scaled) inner = scale(inner, scl[0], scl[1], scl[2]);
    if (turns) inner = rotateBy(inner, m);
    turned = move(inner, px + offset[0], py + offset[1], pz + offset[2]);
  }
  const d = turned.dist, h = turned.hit;
  const [a, b, c, e, f, g, i, j, l] = transpose(m);
  const [ox, oy, oz] = offset, [sx, sy, sz] = scl;
  return {
    kind: "shape3",
    dist: (x, y, z) => (state.hidden ? FAR : d(x, y, z)),
    hit: (x, y, z) => (state.hidden ? { d: FAR, mat: DEFAULT_MATERIAL, lx: x, ly: y, lz: z } : h(x, y, z)),
    bounds: turned.bounds,
    cost: child.cost,
    inner: [child],
    // The child is authored in place; a world point on the posed part is pulled back through the move, the turn
    // about the pivot and the scale.
    unwarp: (x, y, z) => {
      const qx = x - px - ox, qy = y - py - oy, qz = z - pz - oz;
      return [(a * qx + b * qy + c * qz) / sx + px, (e * qx + f * qy + g * qz) / sy + py, (i * qx + j * qy + l * qz) / sz + pz];
    },
    warp: (x, y, z) => {
      const q = apply(m, [(x - px) * sx, (y - py) * sy, (z - pz) * sz]);
      return [q[0] + px + ox, q[1] + py + oy, q[2] + pz + oz];
    },
    loose: turned !== child,
    joint: state,
    feature: child.feature,
    gap: child.gap,
    gapWhat: child.gapWhat,
  };
}

/**
 * The point on a shape's surface nearest to (x, y, z), by sliding along the
 * field's gradient: each step moves by the signed distance against the
 * gradient, which lands on the surface in a few steps for an exact field
 * and settles close for a blended or warped one. What a rod that must
 * meet a curved body needs: the body's own surface point, not a guess
 * from its box (round 4: a hydraulic cylinder's foot was placed by eye).
 */
export function surfacePoint(s: Shape3, x: number, y: number, z: number): Vec3 {
  let px = x, py = y, pz = z;
  const e = 1e-4;
  let d = s.dist(px, py, pz);
  // Each step moves against the gradient by the distance; a field that is only a bound (a loft, a blend) can
  // overshoot, so a step that does not bring the distance down is halved and retried (measured: a loft's field
  // left a cradle post's foot 0.07 off the hull panel).
  for (let i = 0; i < 40 && Math.abs(d) > 1e-7; i++) {
    let gx = s.dist(px + e, py, pz) - s.dist(px - e, py, pz);
    let gy = s.dist(px, py + e, pz) - s.dist(px, py - e, pz);
    let gz = s.dist(px, py, pz + e) - s.dist(px, py, pz - e);
    const len = Math.hypot(gx, gy, gz);
    if (len < 1e-12) break;
    gx /= len; gy /= len; gz /= len;
    let step = d;
    let moved = false;
    for (let k = 0; k < 6; k++) {
      const nx = px - step * gx, ny = py - step * gy, nz = pz - step * gz;
      const nd = s.dist(nx, ny, nz);
      if (Math.abs(nd) < Math.abs(d)) { px = nx; py = ny; pz = nz; d = nd; moved = true; break; }
      step *= 0.5;
    }
    if (!moved) break;
  }
  return [px, py, pz];
}

// --- anchors -----------------------------------------------------------------

/**
 * Name a point on a shape, in the shape's own frame. Every transform, warp
 * and posed joint above it carries the point along (anchorsOf walks the
 * tree with each node's forward map), so a part's anchors are where the
 * part is, and at() reads them after any number of moves. What every
 * dogfooding round did by hand: a hand at (0.5, 2.22, 0.38), a rod's end
 * from sin and cos, a star 0.1 above its post.
 */
export function anchor(s: Shape3, name: string, x: number, y: number, z: number): Shape3 {
  return {
    kind: "shape3",
    dist: s.dist,
    hit: s.hit,
    bounds: s.bounds,
    cost: s.cost,
    inner: [s],
    anchors: { ...anchorsOf(s), [name]: [x, y, z] },
    feature: s.feature,
    gap: s.gap,
    gapWhat: s.gapWhat,
  };
}

/**
 * The named anchors of a shape in its own frame: its own, or its
 * children's carried through the node's forward map. A union takes every
 * part's (the first part wins a name), a cut keeps the first shape's, a
 * placed set keeps none (there are many copies). A twist, bend or wrap
 * carries anchors along the warp, so the tip of a bent bar is the bent
 * tip. The result is cached on the node.
 */
export function anchorsOf(s: Shape3): Record<string, Vec3> {
  if (s.anchors) return s.anchors;
  let out: Record<string, Vec3> = {};
  if (s.instanced) out = {};
  else if (s.cut && s.inner?.length) out = { ...anchorsOf(s.inner[0]) };
  else {
    const kids = s.parts ?? s.inner ?? [];
    for (const k of kids) for (const [name, p] of Object.entries(anchorsOf(k))) if (!(name in out)) out[name] = s.warp ? s.warp(p[0], p[1], p[2]) : p;
  }
  s.anchors = out;
  return out;
}

/**
 * The world point of an anchor: a named one, or one of the free ones every
 * shape has from its box (centre, top, bottom, front, back, left, right,
 * the box's face centres). Undefined for a name the shape does not have.
 */
export function anchorAt(s: Shape3, name: string): Vec3 | undefined {
  const named = anchorsOf(s)[name];
  if (named) return named;
  if (isEmpty(s.bounds)) return undefined;
  const c = boundsCenter(s.bounds), b = s.bounds;
  switch (name) {
    case "centre": case "center": return c;
    case "top": return [c[0], b.max[1], c[2]];
    case "bottom": return [c[0], b.min[1], c[2]];
    case "front": return [c[0], c[1], b.max[2]];
    case "back": return [c[0], c[1], b.min[2]];
    case "right": return [b.max[0], c[1], c[2]];
    case "left": return [b.min[0], c[1], c[2]];
  }
  return undefined;
}

/** The free anchor names every shape answers to, for messages. */
export const FREE_ANCHORS = ["centre", "top", "bottom", "front", "back", "left", "right"];

/** Whether a rotation, a warp or a posed joint sits anywhere in the tree, so the box is the box of a turned box. */
export function hasLooseBounds(s: Shape3): boolean {
  const seen = new Set<Shape3>();
  const walk = (n: Shape3): boolean => {
    if (seen.has(n)) return false;
    seen.add(n);
    if (n.loose) return true;
    for (const k of n.parts ?? n.inner ?? []) if (walk(k)) return true;
    return n.instanced ? walk(n.instanced.base) : false;
  };
  return walk(s);
}

/**
 * Where a shape inside `root` ends up: its bounds carried through every
 * transform and posed joint on the path down to it. A step built at the
 * origin and moved, or a bucket inside a turned joint, is not where its
 * own box says (round 4: --focus in a pose framed the rest position).
 * Undefined when the shape is not under the root or a warp on the way has
 * no forward map.
 */
export function placedBounds(root: Shape3, target: Shape3, own: Bounds): Bounds | undefined {
  const maps = placementChain(root, target);
  if (!maps) return undefined;
  let pts = boundsCorners(own);
  for (let k = maps.length - 1; k >= 0; k--) pts = pts.map((p) => maps[k].warp!(p[0], p[1], p[2]));
  return boundsFromPoints(pts);
}

/** The transforms and joints on the path from `root` down to `target`, outermost first; undefined when not under the root or a map is one-way. */
function placementChain(root: Shape3, target: Shape3): Shape3[] | undefined {
  const chain: Shape3[] = [];
  const seen = new Set<Shape3>();
  const find = (n: Shape3): boolean => {
    if (n === target) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    chain.push(n);
    for (const k of n.parts ?? n.inner ?? []) if (find(k)) return true;
    if (n.instanced && find(n.instanced.base)) return true;
    chain.pop();
    return false;
  };
  if (!find(root)) return undefined;
  const maps = chain.filter((n) => n.unwarp || n.warp);
  return maps.some((n) => !n.warp || !n.unwarp) ? undefined : maps;
}

/**
 * The shape as it ends up under `root`: its field read through the inverses
 * of every transform and posed joint above it, so its surface can be
 * measured where the pose put it (round 5: a turned front wheel's posed
 * box was the box of a turned box, and whether it touched the floor was
 * not readable from it). Undefined when there is nothing between them.
 */
export function placedShape(root: Shape3, target: Shape3): Shape3 | undefined {
  const maps = placementChain(root, target);
  if (!maps || !maps.length) return undefined;
  const d = target.dist;
  const back = (x: number, y: number, z: number): Vec3 => {
    let p: Vec3 = [x, y, z];
    for (const m of maps) p = m.unwarp!(p[0], p[1], p[2]);
    return p;
  };
  return {
    kind: "shape3",
    dist: (x, y, z) => { const p = back(x, y, z); return d(p[0], p[1], p[2]); },
    hit: (x, y, z) => { const p = back(x, y, z); return target.hit(p[0], p[1], p[2]); },
    bounds: placedBounds(root, target, target.bounds) ?? target.bounds,
    cost: target.cost,
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
  const state = { base, placements, hidden: false };
  const d = u.dist, h = u.hit;
  return {
    ...u,
    dist: (x, y, z) => (state.hidden ? FAR : d(x, y, z)),
    hit: (x, y, z) => (state.hidden ? { d: FAR, mat: DEFAULT_MATERIAL, lx: x, ly: y, lz: z } : h(x, y, z)),
    instanced: state,
  };
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
