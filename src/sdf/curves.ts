/**
 * Exact curves for tubes and sweeps: a chain of cubic Bezier segments, and
 * the shapes that follow it by finding the nearest point on the curve for
 * every query, so the surface is the true offset of the curve rather than
 * of a polyline through it. A tube along a curve is then exact (distance to
 * the curve minus the radius) and a swept profile is measured in the normal
 * plane at the nearest point, which is the plane the profile lies in there.
 *
 * The nearest parameter is found per segment by a coarse scan and a few
 * Newton steps on (B(t) - p) · B'(t) = 0, in scalars only: the distance
 * function is the hot path and must not allocate. The frame along the curve
 * (u across, v up) is rotation-minimising, sampled at build time and
 * re-orthogonalised against the exact tangent at the query.
 */
import { cross, length2, normalize, type Vec3 } from "../core/vec.js";
import { primitive } from "./primitives.js";
import { boundsGrow, EMPTY_BOUNDS, isEmpty2, type Bounds, type Shape2, type Shape3 } from "./types.js";

export interface Curve {
  kind: "curve";
  /** Control points, flat x, y, z: 3 * segments + 1 points. */
  ctrl: Float64Array;
  segments: number;
  /** Bounds of the control points, which contain the curve. */
  bounds: Bounds;
  /** Total arc length (from the samples). */
  total: number;
  /** Samples per segment for the frame and the arc length. */
  samples: number;
  /** Cumulative arc length at each sample, segments * (samples + 1) long. */
  arc: Float64Array;
  /** The across vector at each sample. */
  ux: Float64Array;
  uy: Float64Array;
  uz: Float64Array;
}

export const isCurve = (v: unknown): v is Curve => typeof v === "object" && v !== null && (v as Curve).kind === "curve";

const SAMPLES = 24;

/**
 * A curve from cubic Bezier control points: an anchor, then two handles and
 * an anchor for each segment, so 4, 7, 10, ... points.
 */
export function bezierCurve(points: Vec3[]): Curve {
  if (points.length < 4 || (points.length - 1) % 3 !== 0)
    throw new Error(`bezier needs an anchor then two handles and an anchor per segment (4, 7, 10, ... points), got ${points.length}`);
  return build(points);
}

/**
 * A curve through the points (Catmull-Rom tangents turned into Bezier
 * handles), so the same points that `spline` takes give an exact curve.
 */
export function curveThrough(points: Vec3[]): Curve {
  if (points.length < 2) throw new Error(`curve needs at least two points, got ${points.length}`);
  const n = points.length;
  const tangent = (i: number): Vec3 => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    const f = i === 0 || i === n - 1 ? 1 : 0.5;
    return [(b[0] - a[0]) * f, (b[1] - a[1]) * f, (b[2] - a[2]) * f];
  };
  const ctrl: Vec3[] = [points[0]];
  for (let i = 0; i < n - 1; i++) {
    const p = points[i], q = points[i + 1], mp = tangent(i), mq = tangent(i + 1);
    ctrl.push([p[0] + mp[0] / 3, p[1] + mp[1] / 3, p[2] + mp[2] / 3]);
    ctrl.push([q[0] - mq[0] / 3, q[1] - mq[1] / 3, q[2] - mq[2] / 3]);
    ctrl.push(q);
  }
  return build(ctrl);
}

function build(points: Vec3[]): Curve {
  const segments = (points.length - 1) / 3;
  const ctrl = new Float64Array(points.length * 3);
  points.forEach((p, i) => ctrl.set(p, i * 3));
  const bounds: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      bounds.min[k] = Math.min(bounds.min[k], p[k]);
      bounds.max[k] = Math.max(bounds.max[k], p[k]);
    }
  const per = SAMPLES + 1;
  const arc = new Float64Array(segments * per);
  const ux = new Float64Array(segments * per), uy = new Float64Array(segments * per), uz = new Float64Array(segments * per);
  // Rotation-minimising frame by double reflection, walked over the whole chain.
  let prevP: Vec3 | undefined, prevT: Vec3 | undefined, prevU: Vec3 | undefined;
  let length = 0;
  for (let s = 0; s < segments; s++) {
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const p = pointAt(ctrl, s, t);
      let tan = tangentAt(ctrl, s, t);
      if (!Number.isFinite(tan[0]) || (tan[0] === 0 && tan[1] === 0 && tan[2] === 0)) tan = prevT ?? [0, 1, 0];
      let u: Vec3;
      if (!prevU || !prevP || !prevT) {
        const ref: Vec3 = Math.abs(tan[1]) < 0.9 ? [0, 1, 0] : [0, 0, -1];
        u = normalize(cross(ref, tan));
        if (!Number.isFinite(u[0]) || (u[0] === 0 && u[1] === 0 && u[2] === 0)) u = normalize(cross([0, 0, 1], tan));
      } else {
        const v1: Vec3 = [p[0] - prevP[0], p[1] - prevP[1], p[2] - prevP[2]];
        const c1 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2];
        if (c1 < 1e-18) u = prevU;
        else {
          const rl = ((v1[0] * prevU[0] + v1[1] * prevU[1] + v1[2] * prevU[2]) * 2) / c1;
          const rt = ((v1[0] * prevT[0] + v1[1] * prevT[1] + v1[2] * prevT[2]) * 2) / c1;
          const uL: Vec3 = [prevU[0] - rl * v1[0], prevU[1] - rl * v1[1], prevU[2] - rl * v1[2]];
          const tL: Vec3 = [prevT[0] - rt * v1[0], prevT[1] - rt * v1[1], prevT[2] - rt * v1[2]];
          const v2: Vec3 = [tan[0] - tL[0], tan[1] - tL[1], tan[2] - tL[2]];
          const c2 = v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2];
          if (c2 < 1e-18) u = uL;
          else {
            const r2 = ((v2[0] * uL[0] + v2[1] * uL[1] + v2[2] * uL[2]) * 2) / c2;
            u = [uL[0] - r2 * v2[0], uL[1] - r2 * v2[1], uL[2] - r2 * v2[2]];
          }
          // Keep u exactly perpendicular to the tangent and unit length.
          const d = u[0] * tan[0] + u[1] * tan[1] + u[2] * tan[2];
          u = normalize([u[0] - d * tan[0], u[1] - d * tan[1], u[2] - d * tan[2]]);
        }
        length += Math.sqrt(c1);
      }
      const k = s * per + i;
      arc[k] = length;
      ux[k] = u[0]; uy[k] = u[1]; uz[k] = u[2];
      prevP = p; prevT = tan; prevU = u;
    }
  }
  return { kind: "curve", ctrl, segments, bounds, total: length || 1, samples: SAMPLES, arc, ux, uy, uz };
}

function pointAt(ctrl: Float64Array, s: number, t: number): Vec3 {
  const o = s * 9, m = 1 - t;
  const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
  return [
    a * ctrl[o] + b * ctrl[o + 3] + c * ctrl[o + 6] + d * ctrl[o + 9],
    a * ctrl[o + 1] + b * ctrl[o + 4] + c * ctrl[o + 7] + d * ctrl[o + 10],
    a * ctrl[o + 2] + b * ctrl[o + 5] + c * ctrl[o + 8] + d * ctrl[o + 11],
  ];
}

function tangentAt(ctrl: Float64Array, s: number, t: number): Vec3 {
  const o = s * 9, m = 1 - t;
  const a = 3 * m * m, b = 6 * m * t, c = 3 * t * t;
  return normalize([
    a * (ctrl[o + 3] - ctrl[o]) + b * (ctrl[o + 6] - ctrl[o + 3]) + c * (ctrl[o + 9] - ctrl[o + 6]),
    a * (ctrl[o + 4] - ctrl[o + 1]) + b * (ctrl[o + 7] - ctrl[o + 4]) + c * (ctrl[o + 10] - ctrl[o + 7]),
    a * (ctrl[o + 5] - ctrl[o + 2]) + b * (ctrl[o + 8] - ctrl[o + 5]) + c * (ctrl[o + 11] - ctrl[o + 8]),
  ]);
}

/** Points along the curve, `perSegment` per segment plus the end, for anything that wants a polyline. */
export function curvePoints(curve: Curve, perSegment = 16): Vec3[] {
  const out: Vec3[] = [];
  for (let s = 0; s < curve.segments; s++)
    for (let i = 0; i < perSegment; i++) out.push(pointAt(curve.ctrl, s, i / perSegment));
  out.push(pointAt(curve.ctrl, curve.segments - 1, 1));
  return out;
}

/**
 * The nearest-point machinery, shared by tubes and sweeps. `find` sets the
 * fields for the query point and returns the squared distance; everything
 * is scalar so the distance function allocates nothing.
 */
interface Nearest {
  find(x: number, y: number, z: number): number;
  /** After find: the segment and parameter, the curve point, the unit tangent, and the arc length there. */
  seg: number;
  t: number;
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
  arc: number;
  /** The frame at the nearest point, after frame(). */
  ux: number; uy: number; uz: number;
  vx: number; vy: number; vz: number;
  frame(): void;
}

function nearestOn(curve: Curve, reach: number): Nearest {
  const { ctrl, segments } = curve;
  const per = curve.samples + 1;
  // Per-segment boxes of the control points, grown by the reach, for culling.
  const bmin = new Float64Array(segments * 3), bmax = new Float64Array(segments * 3);
  for (let s = 0; s < segments; s++)
    for (let k = 0; k < 3; k++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < 4; i++) {
        const v = ctrl[s * 9 + i * 3 + k];
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      bmin[s * 3 + k] = lo - reach;
      bmax[s * 3 + k] = hi + reach;
    }
  const N: Nearest = {
    seg: 0, t: 0, px: 0, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, arc: 0, ux: 1, uy: 0, uz: 0, vx: 0, vy: 0, vz: 1,
    find(x, y, z) {
      let best = Infinity, bestSeg = 0, bestT = 0;
      for (let s = 0; s < segments; s++) {
        const ex = Math.max(bmin[s * 3] - x, 0, x - bmax[s * 3]);
        const ey = Math.max(bmin[s * 3 + 1] - y, 0, y - bmax[s * 3 + 1]);
        const ez = Math.max(bmin[s * 3 + 2] - z, 0, z - bmax[s * 3 + 2]);
        const box = ex * ex + ey * ey + ez * ez;
        // The box holds the curve grown by the reach; a point farther than that from the box cannot be nearest to this segment
        // unless everything is far, so cull on the distance to the ungrown curve box instead.
        if (box > 0 && Math.sqrt(box) + reach >= Math.sqrt(best)) continue;
        const o = s * 9;
        const p0x = ctrl[o], p0y = ctrl[o + 1], p0z = ctrl[o + 2];
        const p1x = ctrl[o + 3], p1y = ctrl[o + 4], p1z = ctrl[o + 5];
        const p2x = ctrl[o + 6], p2y = ctrl[o + 7], p2z = ctrl[o + 8];
        const p3x = ctrl[o + 9], p3y = ctrl[o + 10], p3z = ctrl[o + 11];
        // Coarse scan.
        let ct = 0, cd = Infinity;
        for (let i = 0; i <= 8; i++) {
          const t = i / 8, m = 1 - t;
          const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
          const dx = a * p0x + b * p1x + c * p2x + d * p3x - x;
          const dy = a * p0y + b * p1y + c * p2y + d * p3y - y;
          const dz = a * p0z + b * p1z + c * p2z + d * p3z - z;
          const q = dx * dx + dy * dy + dz * dz;
          if (q < cd) { cd = q; ct = t; }
        }
        // Newton on (B - p) . B' = 0.
        let t = ct;
        for (let it = 0; it < 5; it++) {
          const m = 1 - t;
          const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
          const dx = a * p0x + b * p1x + c * p2x + d * p3x - x;
          const dy = a * p0y + b * p1y + c * p2y + d * p3y - y;
          const dz = a * p0z + b * p1z + c * p2z + d * p3z - z;
          const a1 = 3 * m * m, b1 = 6 * m * t, c1 = 3 * t * t;
          const vx = a1 * (p1x - p0x) + b1 * (p2x - p1x) + c1 * (p3x - p2x);
          const vy = a1 * (p1y - p0y) + b1 * (p2y - p1y) + c1 * (p3y - p2y);
          const vz = a1 * (p1z - p0z) + b1 * (p2z - p1z) + c1 * (p3z - p2z);
          const a2 = 6 * m, b2 = 6 * t;
          const wx = a2 * (p2x - 2 * p1x + p0x) + b2 * (p3x - 2 * p2x + p1x);
          const wy = a2 * (p2y - 2 * p1y + p0y) + b2 * (p3y - 2 * p2y + p1y);
          const wz = a2 * (p2z - 2 * p1z + p0z) + b2 * (p3z - 2 * p2z + p1z);
          const f = dx * vx + dy * vy + dz * vz;
          const fp = vx * vx + vy * vy + vz * vz + dx * wx + dy * wy + dz * wz;
          if (fp <= 1e-18) break;
          const nt = t - f / fp;
          const clamped = nt < 0 ? 0 : nt > 1 ? 1 : nt;
          if (Math.abs(clamped - t) < 1e-7) { t = clamped; break; }
          t = clamped;
        }
        {
          const m = 1 - t;
          const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
          const dx = a * p0x + b * p1x + c * p2x + d * p3x - x;
          const dy = a * p0y + b * p1y + c * p2y + d * p3y - y;
          const dz = a * p0z + b * p1z + c * p2z + d * p3z - z;
          const q = dx * dx + dy * dy + dz * dz;
          if (q > cd) t = ct; // Newton wandered: keep the scan's point
          const bestHere = Math.min(q, cd);
          if (bestHere < best) { best = bestHere; bestSeg = s; bestT = t; }
        }
      }
      // Fill in the point, tangent and arc length at the winner.
      const s = bestSeg, t = bestT, o = s * 9, m = 1 - t;
      const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
      N.seg = s; N.t = t;
      N.px = a * ctrl[o] + b * ctrl[o + 3] + c * ctrl[o + 6] + d * ctrl[o + 9];
      N.py = a * ctrl[o + 1] + b * ctrl[o + 4] + c * ctrl[o + 7] + d * ctrl[o + 10];
      N.pz = a * ctrl[o + 2] + b * ctrl[o + 5] + c * ctrl[o + 8] + d * ctrl[o + 11];
      const a1 = 3 * m * m, b1 = 6 * m * t, c1 = 3 * t * t;
      let tx = a1 * (ctrl[o + 3] - ctrl[o]) + b1 * (ctrl[o + 6] - ctrl[o + 3]) + c1 * (ctrl[o + 9] - ctrl[o + 6]);
      let ty = a1 * (ctrl[o + 4] - ctrl[o + 1]) + b1 * (ctrl[o + 7] - ctrl[o + 4]) + c1 * (ctrl[o + 10] - ctrl[o + 7]);
      let tz = a1 * (ctrl[o + 5] - ctrl[o + 2]) + b1 * (ctrl[o + 8] - ctrl[o + 5]) + c1 * (ctrl[o + 11] - ctrl[o + 8]);
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-12) { tx /= tl; ty /= tl; tz /= tl; } else { tx = 0; ty = 1; tz = 0; }
      N.tx = tx; N.ty = ty; N.tz = tz;
      const f = t * curve.samples, i0 = Math.min(curve.samples - 1, Math.floor(f)), fr = f - i0;
      const k = s * per + i0;
      N.arc = curve.arc[k] + (curve.arc[k + 1] - curve.arc[k]) * fr;
      return best;
    },
    frame() {
      const s = N.seg, f = N.t * curve.samples, i0 = Math.min(curve.samples - 1, Math.floor(f)), fr = f - i0;
      const k = s * per + i0;
      let ux = curve.ux[k] + (curve.ux[k + 1] - curve.ux[k]) * fr;
      let uy = curve.uy[k] + (curve.uy[k + 1] - curve.uy[k]) * fr;
      let uz = curve.uz[k] + (curve.uz[k + 1] - curve.uz[k]) * fr;
      const dot = ux * N.tx + uy * N.ty + uz * N.tz;
      ux -= dot * N.tx; uy -= dot * N.ty; uz -= dot * N.tz;
      const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      ux /= l; uy /= l; uz /= l;
      N.ux = ux; N.uy = uy; N.uz = uz;
      // v = t x u
      N.vx = N.ty * uz - N.tz * uy;
      N.vy = N.tz * ux - N.tx * uz;
      N.vz = N.tx * uy - N.ty * ux;
    },
  };
  return N;
}

/** Cost estimate for the report: segments times the work of one nearest-point search. */
const COST_PER_SEGMENT = 14;

/**
 * A round tube along a curve: the distance to the curve minus the radius,
 * exact. `taper` scales the radius along the arc length; caps are
 * hemispheres, or flat at the curve's ends with cap="flat".
 */
export function tubeCurve(curve: Curve, r: number, taper = 1, cap: "round" | "flat" = "round"): Shape3 {
  const reach = Math.max(r, r * taper);
  const N = nearestOn(curve, reach);
  const total = curve.total;
  const rate = (taper - 1) / total;
  const ctrl = curve.ctrl, last = curve.segments * 9;
  const t0 = tangentAt(ctrl, 0, 0), t1 = tangentAt(ctrl, curve.segments - 1, 1);
  const flat = cap === "flat";
  const out = primitive((x, y, z) => {
    const d2 = N.find(x, y, z);
    const rad = r * (1 + rate * N.arc);
    let d = Math.sqrt(d2) - rad;
    if (flat) {
      const cs = -((x - ctrl[0]) * t0[0] + (y - ctrl[1]) * t0[1] + (z - ctrl[2]) * t0[2]);
      const ce = (x - ctrl[last]) * t1[0] + (y - ctrl[last + 1]) * t1[1] + (z - ctrl[last + 2]) * t1[2];
      const c = Math.max(cs, ce);
      if (c > 0) d = d > 0 ? Math.sqrt(d * d + c * c) : c;
    }
    return d;
  }, boundsGrow(curve.bounds, reach), curve.segments * COST_PER_SEGMENT);
  out.feature = 2 * r * Math.min(1, taper);
  return out;
}

/**
 * A 2D profile carried along a curve, measured in the normal plane at the
 * nearest point of the curve: its x across (u), its y up (v). `twist` turns
 * the profile over the whole arc length, `taper` scales it to that factor
 * by the end. The ends are cut flat.
 */
export function sweepCurve(profile: Shape2, curve: Curve, twist = 0, taper = 1): Shape3 {
  if (isEmpty2(profile.bounds)) return primitive(() => 1e6, EMPTY_BOUNDS, 0);
  const b = profile.bounds;
  const reach =
    Math.max(length2(b.min[0], b.min[1]), length2(b.max[0], b.max[1]), length2(b.min[0], b.max[1]), length2(b.max[0], b.min[1])) * Math.max(1, taper);
  const N = nearestOn(curve, reach);
  const pd = profile.dist;
  const total = curve.total;
  const twistRate = (twist * Math.PI) / 180 / total;
  const taperRate = (taper - 1) / total;
  const out = primitive((x, y, z) => {
    N.find(x, y, z);
    N.frame();
    const dx = x - N.px, dy = y - N.py, dz = z - N.pz;
    let u = dx * N.ux + dy * N.uy + dz * N.uz;
    let v = dx * N.vx + dy * N.vy + dz * N.vz;
    const along = dx * N.tx + dy * N.ty + dz * N.tz;
    if (twistRate !== 0) {
      const a = twistRate * N.arc, c = Math.cos(a), sn = Math.sin(a);
      const ru = c * u + sn * v, rv = -sn * u + c * v;
      u = ru; v = rv;
    }
    const sc = Math.max(1e-6, 1 + taperRate * N.arc);
    const d2 = pd(u / sc, v / sc) * sc;
    // Beyond an end the nearest parameter is clamped there and the point lies past the end plane.
    const cap = N.seg === 0 && N.t === 0 ? -along : N.seg === curve.segments - 1 && N.t === 1 ? along : -1;
    return cap > 0 ? (d2 > 0 ? Math.sqrt(d2 * d2 + cap * cap) : cap) : d2;
  }, boundsGrow(curve.bounds, reach), curve.segments * COST_PER_SEGMENT + profile.cost);
  out.feature = (profile.feature ?? Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1])) * Math.min(1, taper);
  return out;
}
