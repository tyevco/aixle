/**
 * Smooth 2D profiles: a chain of cubic Bezier pieces in the plane, drawn
 * through points (`curve2`, the curve `curve()` draws, closed) or from
 * anchors and handles (`bezier2`). Closed, the chain is an outline and the
 * profile is what it encloses; with a wall, the chain is left open and the
 * profile is the band that wide along it, for a vase drawn as one line.
 *
 * The distance is exact: the nearest point on each piece, found as
 * curves.ts finds it in 3D (a coarse scan, then Newton on
 * (B(t) - p) . B'(t) = 0, kept inside the scan's bracket), with an upper
 * bound from points on the curve first so most pieces are culled by their
 * box. The sign is the even-odd count of the pieces a ray towards +x
 * crosses, solved on the y-monotone parts of each piece, so it flips
 * exactly on the curve and nowhere else; an outline that crosses itself is
 * filled as polygon fills one (where it overlaps itself, the overlap is a
 * hole). Everything in `dist` is scalar over typed arrays: it allocates
 * nothing.
 */
import { shape2 } from "./shapes2d.js";
import { buildSpatialIndex, cellsFor } from "./spatial.js";
import type { Shape2 } from "./types.js";

/** A chain of cubic pieces: control points flat, x, y, 8 numbers per piece; closed when the last piece ends on the first's start. */
export interface Chain2 {
  ctrl: Float64Array;
  pieces: number;
  closed: boolean;
}

/** Split a flat list into x, y pairs, with a count in the error. */
function pairs(flat: readonly number[], what: string): [number, number][] {
  if (flat.length % 2 !== 0) throw new Error(`${what} needs a list of x, y pairs, got ${flat.length} numbers (an odd count)`);
  const out: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) {
    if (!Number.isFinite(flat[i]) || !Number.isFinite(flat[i + 1])) throw new Error(`${what}: point ${i / 2 + 1} is not a finite number`);
    out.push([flat[i], flat[i + 1]]);
  }
  return out;
}

function tolerance(pts: [number, number][]): number {
  let m = 0;
  for (const p of pts) m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
  return 1e-9 * (1 + m);
}

const same = (a: [number, number], b: [number, number], tol: number): boolean => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

/**
 * A chain through the points with Catmull-Rom tangents turned into Bezier
 * handles, as curve() builds in 3D. A point given twice in a row is a sharp
 * corner: the curve arrives and leaves it with one-sided tangents, as an
 * open curve does at its ends, so a run between two corners is straight.
 * Closed, the list wraps; a last point equal to the first only closes it
 * (dropped, not a corner: give it twice to make one).
 */
export function chainThrough(flat: readonly number[], closed: boolean, what = "curve2"): Chain2 {
  let raw = pairs(flat, what);
  const tol = tolerance(raw);
  if (closed && raw.length > 1 && same(raw[raw.length - 1], raw[0], tol)) raw = raw.slice(0, -1);
  const pts: [number, number][] = [];
  const corner: boolean[] = [];
  for (const p of raw) {
    if (pts.length && same(p, pts[pts.length - 1], tol)) { corner[pts.length - 1] = true; continue; }
    pts.push(p);
    corner.push(false);
  }
  if (closed && pts.length > 1 && same(pts[pts.length - 1], pts[0], tol)) { pts.pop(); corner.pop(); corner[0] = true; }
  const m = pts.length;
  if (closed && m < 3) throw new Error(`${what} needs at least 3 different points for a closed outline, got ${m}`);
  if (!closed && m < 2) throw new Error(`${what} needs at least 2 different points, got ${m}`);
  // Outgoing and incoming tangents at each point.
  const outT: [number, number][] = [], inT: [number, number][] = [];
  for (let i = 0; i < m; i++) {
    const p = pts[i];
    const prev = closed ? pts[(i - 1 + m) % m] : pts[Math.max(0, i - 1)];
    const next = closed ? pts[(i + 1) % m] : pts[Math.min(m - 1, i + 1)];
    const end = !closed && (i === 0 || i === m - 1);
    if (corner[i] || end) {
      outT.push([next[0] - p[0], next[1] - p[1]]);
      inT.push([p[0] - prev[0], p[1] - prev[1]]);
    } else {
      const t: [number, number] = [(next[0] - prev[0]) / 2, (next[1] - prev[1]) / 2];
      outT.push(t);
      inT.push(t);
    }
  }
  const pieces = closed ? m : m - 1;
  const ctrl = new Float64Array(pieces * 8);
  for (let i = 0; i < pieces; i++) {
    const j = (i + 1) % m;
    const p = pts[i], q = pts[j];
    ctrl.set([p[0], p[1], p[0] + outT[i][0] / 3, p[1] + outT[i][1] / 3, q[0] - inT[j][0] / 3, q[1] - inT[j][1] / 3, q[0], q[1]], i * 8);
  }
  return { ctrl, pieces, closed };
}

/**
 * A chain from Bezier anchors and handles: an anchor, then two handles and
 * an anchor for each piece (4, 7, 10, ... pairs), the layout bezier() takes.
 * Closed, the last anchor should be the first; when it is not, a straight
 * piece runs from it back to the first, which is how an outline drawn from
 * the axis round to the axis is closed along the axis for a revolve.
 */
export function chainFromBezier(flat: readonly number[], closed: boolean, what = "bezier2"): Chain2 {
  const pts = pairs(flat, what);
  if (pts.length < 4 || (pts.length - 1) % 3 !== 0)
    throw new Error(`${what} needs an anchor, then two handles and an anchor for each piece: 4, 7, 10, ... x, y pairs (8, 14, 20, ... numbers), got ${pts.length} pair${pts.length === 1 ? "" : "s"}`);
  const tol = tolerance(pts);
  const last = pts.length - 1;
  const closing = closed && !same(pts[last], pts[0], tol);
  if (closed && !closing) pts[last] = pts[0];
  const pieces = (pts.length - 1) / 3 + (closing ? 1 : 0);
  const ctrl = new Float64Array(pieces * 8);
  for (let i = 0; i < (pts.length - 1) / 3; i++) {
    const o = i * 3;
    ctrl.set([pts[o][0], pts[o][1], pts[o + 1][0], pts[o + 1][1], pts[o + 2][0], pts[o + 2][1], pts[o + 3][0], pts[o + 3][1]], i * 8);
  }
  if (closing) {
    const p = pts[last], q = pts[0];
    ctrl.set([p[0], p[1], p[0] + (q[0] - p[0]) / 3, p[1] + (q[1] - p[1]) / 3, q[0] + (p[0] - q[0]) / 3, q[1] + (p[1] - q[1]) / 3, q[0], q[1]], (pieces - 1) * 8);
  }
  for (let i = 0; i < pieces; i++) {
    let moves = false;
    for (let k = 2; k < 8; k += 2) if (!same([ctrl[i * 8 + k], ctrl[i * 8 + k + 1]], [ctrl[i * 8], ctrl[i * 8 + 1]], tol)) moves = true;
    if (!moves) throw new Error(`${what}: piece ${i + 1} has all four points at (${ctrl[i * 8]}, ${ctrl[i * 8 + 1]}); every piece needs some length`);
  }
  return { ctrl, pieces, closed };
}

// --- one piece in power form: X(t) = ((A t + B) t + C) t + D --------------------

/** Power-basis coefficients of each piece, 8 per piece: Ax, Bx, Cx, Dx, Ay, By, Cy, Dy. */
function powerForm(ctrl: Float64Array, pieces: number): Float64Array {
  const co = new Float64Array(pieces * 8);
  for (let s = 0; s < pieces; s++)
    for (let k = 0; k < 2; k++) {
      const p0 = ctrl[s * 8 + k], p1 = ctrl[s * 8 + 2 + k], p2 = ctrl[s * 8 + 4 + k], p3 = ctrl[s * 8 + 6 + k];
      const o = s * 8 + k * 4;
      co[o] = -p0 + 3 * p1 - 3 * p2 + p3;
      co[o + 1] = 3 * p0 - 6 * p1 + 3 * p2;
      co[o + 2] = 3 * (p1 - p0);
      co[o + 3] = p0;
    }
  return co;
}

const cubic = (A: number, B: number, C: number, D: number, t: number): number => ((A * t + B) * t + C) * t + D;

/** The roots of A t^2 + B t + C strictly inside (lo, hi), ascending. */
function quadRoots(A: number, B: number, C: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  const scale = Math.max(Math.abs(A), Math.abs(B), Math.abs(C));
  if (scale === 0) return out;
  if (Math.abs(A) <= 1e-12 * scale) {
    if (Math.abs(B) > 1e-12 * scale) out.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      // The stable pair of formulas.
      const q = -0.5 * (B + (B >= 0 ? sq : -sq));
      out.push(q / A);
      if (q !== 0) out.push(C / q);
    }
  }
  return out.filter((t) => t > lo && t < hi).sort((a, b) => a - b);
}

/** The exact range of one coordinate of a piece over [t0, t1]: the ends and the turning points between. */
function rangeOf(A: number, B: number, C: number, D: number, t0: number, t1: number): [number, number] {
  let lo = Math.min(cubic(A, B, C, D, t0), cubic(A, B, C, D, t1)), hi = Math.max(cubic(A, B, C, D, t0), cubic(A, B, C, D, t1));
  for (const t of quadRoots(3 * A, 2 * B, C, t0, t1)) {
    const v = cubic(A, B, C, D, t);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return [lo, hi];
}

/**
 * A piece's exact extent on one axis (0 x, 1 y): its end points as given and its turning points between, kept inside
 * the hull of its control points (which holds the curve) so rounding cannot push a box past a point on the axis.
 */
function pieceRange(ctrl: Float64Array, co: Float64Array, s: number, k: number): [number, number] {
  const c = (i: number) => ctrl[s * 8 + i * 2 + k];
  let lo = Math.min(c(0), c(3)), hi = Math.max(c(0), c(3));
  const o = s * 8 + k * 4;
  for (const t of quadRoots(3 * co[o], 2 * co[o + 1], co[o + 2], 0, 1)) {
    const v = cubic(co[o], co[o + 1], co[o + 2], co[o + 3], t);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return [Math.max(lo, Math.min(c(0), c(1), c(2), c(3))), Math.min(hi, Math.max(c(0), c(1), c(2), c(3)))];
}

const SCAN = 8;
const STEP = 1 / SCAN;

/** Squared distance from (x, y) to piece `o` (an offset into the power form), exact up to a wrong basin the scan cannot see. */
function nearestSq(co: Float64Array, o: number, x: number, y: number): number {
  const Ax = co[o], Bx = co[o + 1], Cx = co[o + 2], Dx = co[o + 3] - x;
  const Ay = co[o + 4], By = co[o + 5], Cy = co[o + 6], Dy = co[o + 7] - y;
  let ct = 0, cd = Infinity;
  for (let i = 0; i <= SCAN; i++) {
    const t = i * STEP;
    const X = ((Ax * t + Bx) * t + Cx) * t + Dx, Y = ((Ay * t + By) * t + Cy) * t + Dy;
    const q = X * X + Y * Y;
    if (q < cd) { cd = q; ct = t; }
  }
  // Newton on the derivative of the squared distance, kept inside the scan's bracket and bisecting when it leaves.
  let lo = ct > STEP ? ct - STEP : 0, hi = ct < 1 - STEP ? ct + STEP : 1;
  let t = ct;
  for (let it = 0; it < 10; it++) {
    const X = ((Ax * t + Bx) * t + Cx) * t + Dx, Y = ((Ay * t + By) * t + Cy) * t + Dy;
    const X1 = (3 * Ax * t + 2 * Bx) * t + Cx, Y1 = (3 * Ay * t + 2 * By) * t + Cy;
    const f = X * X1 + Y * Y1;
    if (f > 0) hi = t; else lo = t;
    const X2 = 6 * Ax * t + 2 * Bx, Y2 = 6 * Ay * t + 2 * By;
    const fp = X1 * X1 + Y1 * Y1 + X * X2 + Y * Y2;
    let nt = fp > 0 ? t - f / fp : -1;
    if (!(nt >= lo && nt <= hi)) nt = 0.5 * (lo + hi);
    if (Math.abs(nt - t) < 1e-11) { t = nt; break; }
    t = nt;
  }
  const X = ((Ax * t + Bx) * t + Cx) * t + Dx, Y = ((Ay * t + By) * t + Cy) * t + Dy;
  const q = X * X + Y * Y;
  return q < cd ? q : cd;
}

/** On a y-monotone part (power form at `o`, 12 numbers), the x where it reaches height y, which lies between its ends. */
function crossX(m: Float64Array, o: number, y: number): number {
  const Ay = m[o + 4], By = m[o + 5], Cy = m[o + 6], Dy = m[o + 7] - y;
  const up = m[o + 9] > m[o + 8];
  let lo = 0, hi = 1;
  const span = m[o + 9] - m[o + 8];
  let u = span !== 0 ? Math.min(1, Math.max(0, -Dy / span)) : 0.5;
  for (let it = 0; it < 40; it++) {
    const f = ((Ay * u + By) * u + Cy) * u + Dy;
    if (f === 0) break;
    if ((f > 0) === up) hi = u; else lo = u;
    const fp = (3 * Ay * u + 2 * By) * u + Cy;
    let nu = fp !== 0 ? u - f / fp : -1;
    if (!(nu > lo && nu < hi)) nu = 0.5 * (lo + hi);
    if (Math.abs(nu - u) < 1e-14) { u = nu; break; }
    u = nu;
  }
  return ((m[o] * u + m[o + 1]) * u + m[o + 2]) * u + m[o + 3];
}

/** The unit tangent leaving a piece's start (t = 0) or arriving at its end (t = 1), from the first handle that moves. */
function endTangent(ctrl: Float64Array, s: number, atEnd: boolean): [number, number] {
  const o = s * 8;
  const P = (i: number): [number, number] => [ctrl[o + i * 2], ctrl[o + i * 2 + 1]];
  const order = atEnd ? [[3, 2], [3, 1], [3, 0]] : [[1, 0], [2, 0], [3, 0]];
  for (const [a, b] of order) {
    const pa = P(a), pb = P(b);
    const dx = pa[0] - pb[0], dy = pa[1] - pb[1], l = Math.hypot(dx, dy);
    if (l > 1e-12) return [dx / l, dy / l];
  }
  return [1, 0];
}

/** Cost estimate for the report: pieces times the work of one nearest-point search. */
const COST_PER_PIECE = 14;

/**
 * The profile of a chain: closed, the region it encloses; with `wall` > 0,
 * the band `wall` wide centred on the chain (open or closed), its ends
 * rounded. Bounds are the curve's own extent (its turning points, not its
 * handles), grown by half the wall.
 */
export function chainProfile(chain: Chain2, wall = 0): Shape2 {
  const { ctrl, pieces } = chain;
  if (wall < 0) throw new Error(`wall must be 0 (a closed outline) or more, got ${wall}`);
  const half = wall / 2;
  const filled = half === 0;
  if (filled && !chain.closed) throw new Error(`an open curve needs a wall to be a profile`);
  const co = powerForm(ctrl, pieces);
  // Each piece's exact box, for culling and for the bounds.
  const box = new Float64Array(pieces * 4);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let s = 0; s < pieces; s++) {
    const [x0, x1] = pieceRange(ctrl, co, s, 0);
    const [y0, y1] = pieceRange(ctrl, co, s, 1);
    box[s * 4] = x0; box[s * 4 + 1] = y0; box[s * 4 + 2] = x1; box[s * 4 + 3] = y1;
    minx = Math.min(minx, x0); miny = Math.min(miny, y0); maxx = Math.max(maxx, x1); maxy = Math.max(maxy, y1);
  }
  // Which pieces are straight runs on x = 0: a revolve leaves them out (see Shape2.revolveDist).
  const tol = 1e-9 * (1 + Math.max(Math.abs(minx), Math.abs(maxx), Math.abs(miny), Math.abs(maxy)));
  const onAxis = (s: number) => [0, 2, 4, 6].every((k) => Math.abs(ctrl[s * 8 + k]) <= tol);
  // The y-monotone parts, for the crossing count: power form (8), the end heights (2, taken from the control points
  // and shared between neighbours so a vertex is counted once), and the exact x range (2).
  const parts: number[] = [];
  if (filled) {
    for (let s = 0; s < pieces; s++) {
      const o = s * 8;
      const A = [co[o], co[o + 4]], B = [co[o + 1], co[o + 5]], C = [co[o + 2], co[o + 6]], D = [co[o + 3], co[o + 7]];
      const splits = [0, ...quadRoots(3 * A[1], 2 * B[1], C[1], 1e-12, 1 - 1e-12), 1];
      const ys = splits.map((t, i) => (i === 0 ? ctrl[s * 8 + 1] : i === splits.length - 1 ? ctrl[s * 8 + 7] : cubic(A[1], B[1], C[1], D[1], t)));
      for (let i = 0; i + 1 < splits.length; i++) {
        const ta = splits[i], h = splits[i + 1] - ta;
        if (h <= 0 || ys[i] === ys[i + 1]) continue;
        const sub: number[] = [];
        for (let k = 0; k < 2; k++)
          sub.push(A[k] * h * h * h, (3 * A[k] * ta + B[k]) * h * h, (3 * A[k] * ta * ta + 2 * B[k] * ta + C[k]) * h, cubic(A[k], B[k], C[k], D[k], ta));
        const [xl, xh] = rangeOf(A[0], B[0], C[0], D[0], ta, splits[i + 1]);
        parts.push(...sub, ys[i], ys[i + 1], xl, xh);
      }
    }
  }
  const mono = new Float64Array(parts);
  const nparts = mono.length / 12;
  const bx0 = minx, by0 = miny, bx1 = maxx, by1 = maxy;
  // Over a few dozen parts, horizontal bands listing the parts whose heights reach into each, so the crossing count
  // reads only the parts at the query's height.
  const bands = nparts > 32 && by1 > by0 ? Math.min(256, Math.ceil(nparts / 2)) : 0;
  const bandH = bands ? (by1 - by0) / bands : 1;
  const bandStart = new Int32Array(bands + 1);
  let bandItems = new Int32Array(0);
  if (bands) {
    const lists: number[][] = Array.from({ length: bands }, () => []);
    for (let k = 0; k < nparts; k++) {
      const lo = Math.min(mono[k * 12 + 8], mono[k * 12 + 9]), hi = Math.max(mono[k * 12 + 8], mono[k * 12 + 9]);
      const b0 = Math.max(0, Math.floor((lo - by0) / bandH)), b1 = Math.min(bands - 1, Math.floor((hi - by0) / bandH));
      for (let b = b0; b <= b1; b++) lists[b].push(k);
    }
    for (let b = 0; b < bands; b++) bandStart[b + 1] = bandStart[b] + lists[b].length;
    bandItems = Int32Array.from(lists.flat());
  }
  /**
   * The field over the pieces listed in `use`: points on them (each piece's start and middle, and its end where no
   * listed piece starts) give an upper bound before any search, then a piece is searched only when its box is
   * nearer than the best so far; past two dozen pieces a grid picks the pieces to search.
   */
  const field = (use: number[]): ((x: number, y: number) => number) => {
    const idx = Int32Array.from(use);
    const n = idx.length;
    const on = new Set(use);
    const pts: number[] = [];
    for (const s of use) {
      const o = s * 8;
      pts.push(ctrl[o], ctrl[o + 1], cubic(co[o], co[o + 1], co[o + 2], co[o + 3], 0.5), cubic(co[o + 4], co[o + 5], co[o + 6], co[o + 7], 0.5));
      // The end is the next piece's start, unless there is no next piece in the list.
      const next = s + 1 < pieces ? s + 1 : chain.closed ? 0 : -1;
      if (!on.has(next)) pts.push(ctrl[o + 6], ctrl[o + 7]);
    }
    const up = new Float64Array(pts);
    const nu = up.length / 2;
    // Over a couple of dozen pieces, the grid the 3D sweeps use, laid flat (z = 0), so a query searches the pieces
    // near it and not every box.
    let index: ReturnType<typeof buildSpatialIndex> | undefined;
    if (n > 24) {
      const bmin = new Float64Array(n * 3), bmax = new Float64Array(n * 3);
      use.forEach((s, i) => {
        bmin[i * 3] = box[s * 4]; bmin[i * 3 + 1] = box[s * 4 + 1];
        bmax[i * 3] = box[s * 4 + 2]; bmax[i * 3 + 1] = box[s * 4 + 3];
      });
      const pad = Math.max(bx1 - bx0, by1 - by0) * 0.25 + half;
      index = buildSpatialIndex(n, bmin, bmax, { min: [bx0 - pad, by0 - pad, 0], max: [bx1 + pad, by1 + pad, 0] }, cellsFor(n));
    }
    const pieceD = (i: number, x: number, y: number): number => Math.sqrt(nearestSq(co, idx[i] * 8, x, y));
    const boxD = (i: number, x: number, y: number): number => {
      const o = idx[i] * 4;
      const ex = Math.max(box[o] - x, 0, x - box[o + 2]), ey = Math.max(box[o + 1] - y, 0, y - box[o + 3]);
      return Math.sqrt(ex * ex + ey * ey);
    };
    return (x: number, y: number): number => {
      let d: number;
      if (index) d = index.min(x, y, 0, pieceD, boxD, Infinity);
      else {
        let best = Infinity;
        for (let i = 0; i < nu; i++) {
          const dx = up[i * 2] - x, dy = up[i * 2 + 1] - y;
          const q = dx * dx + dy * dy;
          if (q < best) best = q;
        }
        for (let i = 0; i < n; i++) {
          const s = idx[i], o = s * 4;
          const ex = Math.max(box[o] - x, 0, x - box[o + 2]), ey = Math.max(box[o + 1] - y, 0, y - box[o + 3]);
          if (ex * ex + ey * ey >= best) continue;
          const q = nearestSq(co, s * 8, x, y);
          if (q < best) best = q;
        }
        d = Math.sqrt(best);
      }
      if (!filled) return d - half;
      if (x < bx0 || x > bx1 || y < by0 || y > by1) return d;
      let inside = false;
      let k0 = 0, k1 = nparts;
      if (bands) {
        const b = Math.min(bands - 1, Math.max(0, Math.floor((y - by0) / bandH)));
        k0 = bandStart[b]; k1 = bandStart[b + 1];
      }
      for (let j = k0; j < k1; j++) {
        const o = (bands ? bandItems[j] : j) * 12;
        const ya = mono[o + 8], yb = mono[o + 9];
        if (!((ya <= y && y < yb) || (yb <= y && y < ya))) continue;
        if (x >= mono[o + 11]) continue;
        if (x < mono[o + 10] || crossX(mono, o, y) > x) inside = !inside;
      }
      return inside ? -d : d;
    };
  };
  const all = Array.from({ length: pieces }, (_, s) => s);
  const dist = field(all);
  const out = shape2(dist, { min: [minx - half, miny - half], max: [maxx + half, maxy + half] }, pieces * COST_PER_PIECE);
  out.feature = filled ? thinnestWall(chain, co, dist, [minx, miny, maxx, maxy]) : wall;
  const off = all.filter((s) => !onAxis(s));
  if (filled && off.length < pieces && off.length > 0) out.revolveDist = field(off);
  return out;
}

/** Two sides face each other when their normals are within 10 degrees of opposite. */
const FACING = Math.cos((10 * Math.PI) / 180);

/**
 * The thinnest wall of a closed outline, for the thin-part warning: from
 * sixteen points on each piece, the distance along the inward normal to
 * the far side, counted where the two sides face each other (their normals
 * within 10 degrees of opposite, so the sides of a sharp tip do not count
 * until it is a needle) and neither end is within that distance of a sharp
 * corner. A straight run on x = 0 is skipped, from either end: it is the
 * axis a revolve spins about or a mirror reflects across, and the solid
 * there is twice what the profile shows. Undefined when no two sides face
 * each other.
 */
function thinnestWall(chain: Chain2, co: Float64Array, dist: (x: number, y: number) => number, b: number[]): number | undefined {
  const { ctrl, pieces } = chain;
  const size = Math.max(b[2] - b[0], b[3] - b[1]);
  // Corners: where one piece's end tangent and the next one's start tangent part by more than 10 degrees.
  const corners: [number, number][] = [];
  for (let s = 0; s < pieces; s++) {
    const n = (s + 1) % pieces;
    if (!chain.closed && n === 0) continue;
    const a = endTangent(ctrl, s, true), c = endTangent(ctrl, n, false);
    if (a[0] * c[0] + a[1] * c[1] < Math.cos((10 * Math.PI) / 180)) corners.push([ctrl[s * 8 + 6], ctrl[s * 8 + 7]]);
  }
  const nearCorner = (x: number, y: number, r: number) => corners.some((c) => Math.hypot(c[0] - x, c[1] - y) < r);
  const eps = size * 1e-6;
  const grad = (x: number, y: number): [number, number] => {
    const h = size * 1e-5;
    const gx = dist(x + h, y) - dist(x - h, y), gy = dist(x, y + h) - dist(x, y - h);
    const l = Math.hypot(gx, gy) || 1;
    return [gx / l, gy / l];
  };
  const onAxis = (s: number) => {
    for (let k = 0; k < 8; k += 2) if (Math.abs(ctrl[s * 8 + k]) > eps) return false;
    return true;
  };
  let best: number | undefined;
  // Sixteen points a piece, fewer on a long outline so the build stays well under a second.
  const PER = Math.max(2, Math.min(16, Math.floor(1600 / pieces)));
  for (let s = 0; s < pieces; s++) {
    if (onAxis(s)) continue;
    const o = s * 8;
    for (let i = 0; i < PER; i++) {
      const t = (i + 0.5) / PER;
      const px = cubic(co[o], co[o + 1], co[o + 2], co[o + 3], t), py = cubic(co[o + 4], co[o + 5], co[o + 6], co[o + 7], t);
      const tx = (3 * co[o] * t + 2 * co[o + 1]) * t + co[o + 2], ty = (3 * co[o + 4] * t + 2 * co[o + 5]) * t + co[o + 6];
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-12) continue;
      // The inward normal: whichever side of the tangent the field is negative on.
      let nx = -ty / tl, ny = tx / tl;
      if (dist(px + nx * eps * 10, py + ny * eps * 10) > 0) { nx = -nx; ny = -ny; }
      // March across the inside: the field is the distance to the nearest side, so a step of it never crosses one.
      let r = eps * 10, hit = false;
      for (let it = 0; it < 80; it++) {
        const d = dist(px + nx * r, py + ny * r);
        if (d > -eps) { hit = true; break; }
        r += -d;
        if (r > size * 2) break;
      }
      if (!hit) continue;
      const hx = px + nx * r, hy = py + ny * r;
      // Facing: the far side's outward normal points back along the ray.
      const g = grad(hx, hy);
      if (g[0] * nx + g[1] * ny < FACING) continue;
      if (nearCorner(px, py, r) || nearCorner(hx, hy, r)) continue;
      if (Math.abs(hx) < eps * 10 && Math.abs(px) > eps * 10 && axisAt(chain, hy, eps * 10)) continue;
      if (best === undefined || r < best) best = r;
    }
  }
  return best;
}

/** Whether the chain has a straight run on x = 0 that covers height y (the far side of a march that ended on the axis). */
function axisAt(chain: Chain2, y: number, tol: number): boolean {
  for (let s = 0; s < chain.pieces; s++) {
    const o = s * 8;
    let flat = true;
    for (let k = 0; k < 8; k += 2) if (Math.abs(chain.ctrl[o + k]) > tol) flat = false;
    if (!flat) continue;
    const y0 = Math.min(chain.ctrl[o + 1], chain.ctrl[o + 7]), y1 = Math.max(chain.ctrl[o + 1], chain.ctrl[o + 7]);
    if (y >= y0 - tol && y <= y1 + tol) return true;
  }
  return false;
}

/** A closed smooth profile through the points; `wall` > 0 leaves it open and takes the band that wide along it. */
export function curve2(points: readonly number[], wall = 0): Shape2 {
  return chainProfile(chainThrough(points, wall <= 0, "curve2"), wall);
}

/** A closed profile from Bezier anchors and handles; `wall` > 0 leaves it open and takes the band that wide along it. */
export function bezier2(points: readonly number[], wall = 0): Shape2 {
  return chainProfile(chainFromBezier(points, wall <= 0, "bezier2"), wall);
}

/** Points along a chain, `per` per piece plus the end, for tests and for anything that wants a polyline. */
export function chainPoints(chain: Chain2, per = 16): [number, number][] {
  const co = powerForm(chain.ctrl, chain.pieces);
  const out: [number, number][] = [];
  for (let s = 0; s < chain.pieces; s++)
    for (let i = 0; i < per; i++) {
      const t = i / per, o = s * 8;
      out.push([cubic(co[o], co[o + 1], co[o + 2], co[o + 3], t), cubic(co[o + 4], co[o + 5], co[o + 6], co[o + 7], t)]);
    }
  out.push([chain.ctrl[chain.pieces * 8 - 2], chain.ctrl[chain.pieces * 8 - 1]]);
  return out;
}
