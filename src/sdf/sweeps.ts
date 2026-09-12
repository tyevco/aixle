/**
 * Shapes that follow a path or change along their length: tubes and swept
 * profiles along a polyline, and lofts between two profiles. A polyline can
 * be smoothed into a curve (Catmull-Rom through the given points) before
 * use, so a handle is four points and `smooth=8`.
 */
import { length2, length3, normalize, cross, type Vec3 } from "../core/vec.js";
import { primitive } from "./primitives.js";
import { buildSpatialIndex, cellsFor } from "./spatial.js";
import { boundsFromPoints, boundsGrow, EMPTY_BOUNDS, isEmpty2, type Shape2, type Shape3 } from "./types.js";

/** Split a flat list of numbers into points; throws with a helpful count. */
export function toPoints(flat: readonly number[], what: string): Vec3[] {
  if (flat.length < 6 || flat.length % 3 !== 0)
    throw new Error(`${what} needs a list of x, y, z triples (at least two points), got ${flat.length} numbers`);
  const out: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}

/** Catmull-Rom through the points, `segments` pieces between each pair; 0 returns the points as given. */
export function smoothPath(points: Vec3[], segments: number): Vec3[] {
  if (segments <= 0 || points.length < 3) return points;
  const out: Vec3[] = [];
  const n = points.length;
  const at = (i: number) => points[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < segments; s++) {
      const t = s / segments, t2 = t * t, t3 = t2 * t;
      const p: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++)
        p[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push(p);
    }
  }
  out.push(points[n - 1]);
  return out;
}

interface Segment {
  a: Vec3;
  d: Vec3; // b - a
  len2: number;
  /** Frame for a profile: u across, v up, both perpendicular to the segment. */
  u: Vec3;
  v: Vec3;
}

function segments(points: Vec3[]): Segment[] {
  const segs: Segment[] = [];
  let prevU: Vec3 | undefined;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    if (len2 < 1e-12) continue;
    const t = normalize(d);
    // Pick a reference so the profile's up (v) stays as close to world y as possible.
    let ref: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [0, 0, -1];
    if (prevU) ref = cross(t, prevU); // continuity of the frame along the path
    let u = normalize(cross(ref, t));
    if (!Number.isFinite(u[0]) || (u[0] === 0 && u[1] === 0 && u[2] === 0)) u = normalize(cross([0, 0, 1], t));
    const v = cross(t, u);
    if (prevU) prevU = u; else prevU = u;
    segs.push({ a, d, len2, u, v });
  }
  return segs;
}

/** Arc length from the path start to each point, and the total. */
function arcLengths(points: Vec3[]): { at: Float64Array; total: number } {
  const at = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    at[i] = at[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return { at, total: at[points.length - 1] || 1 };
}

/**
 * A round tube of radius `r` along the polyline, joins rounded: a chain of
 * capsules, exact. With `taper` the radius runs from `r` at the start to
 * `r * taper` at the end along the arc length (each piece is a round cone).
 */
export function tube(points: Vec3[], r: number, taper = 1): Shape3 {
  const segs = segments(points);
  if (segs.length === 0) return primitive(() => 1e6, EMPTY_BOUNDS, 0);
  const n = segs.length;
  const arcs = arcLengths(points);
  const ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
  const dx = new Float64Array(n), dy = new Float64Array(n), dz = new Float64Array(n), l2 = new Float64Array(n);
  const r0 = new Float64Array(n), r1 = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    if (len2 < 1e-12) continue;
    ax[k] = a[0]; ay[k] = a[1]; az[k] = a[2];
    dx[k] = d[0]; dy[k] = d[1]; dz[k] = d[2]; l2[k] = len2;
    r0[k] = r * (1 + (taper - 1) * (arcs.at[i] / arcs.total));
    r1[k] = r * (1 + (taper - 1) * (arcs.at[i + 1] / arcs.total));
    k++;
  }
  const bounds = boundsGrow(boundsFromPoints(points), Math.max(r, r * taper));
  // Per-piece boxes: a piece whose box is farther than the best distance so far cannot win.
  const bmin = new Float64Array(n * 3), bmax = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const rr = Math.max(r0[i], r1[i]);
    bmin[i * 3] = Math.min(ax[i], ax[i] + dx[i]) - rr; bmax[i * 3] = Math.max(ax[i], ax[i] + dx[i]) + rr;
    bmin[i * 3 + 1] = Math.min(ay[i], ay[i] + dy[i]) - rr; bmax[i * 3 + 1] = Math.max(ay[i], ay[i] + dy[i]) + rr;
    bmin[i * 3 + 2] = Math.min(az[i], az[i] + dz[i]) - rr; bmax[i * 3 + 2] = Math.max(az[i], az[i] + dz[i]) + rr;
  }
  const boxDist = (i: number, x: number, y: number, z: number): number => {
    const ex = Math.max(bmin[i * 3] - x, 0, x - bmax[i * 3]);
    const ey = Math.max(bmin[i * 3 + 1] - y, 0, y - bmax[i * 3 + 1]);
    const ez = Math.max(bmin[i * 3 + 2] - z, 0, z - bmax[i * 3 + 2]);
    return Math.sqrt(ex * ex + ey * ey + ez * ez);
  };
  const grown = Math.max(r, r * taper) * 3;
  const index = n > 8 ? buildSpatialIndex(n, bmin, bmax, { min: bounds.min.map((v) => v - grown), max: bounds.max.map((v) => v + grown) }, cellsFor(n)) : undefined;
  const capsule = (i: number, x: number, y: number, z: number): number => {
    const px = x - ax[i], py = y - ay[i], pz = z - az[i];
    let t = (px * dx[i] + py * dy[i] + pz * dz[i]) / l2[i];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = px - dx[i] * t, qy = py - dy[i] * t, qz = pz - dz[i] * t;
    return Math.sqrt(qx * qx + qy * qy + qz * qz) - r;
  };
  if (taper === 1) {
    return primitive((x, y, z) => {
      if (index) return index.min(x, y, z, capsule, boxDist, Infinity);
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (boxDist(i, x, y, z) >= best) continue;
        const d = capsule(i, x, y, z);
        if (d < best) best = d;
      }
      return best;
    }, bounds, n);
  }
  // Round cone per piece (Quilez), exact for a linearly varying radius.
  const cone = (i: number, x: number, y: number, z: number): number => {
    {
      const px = x - ax[i], py = y - ay[i], pz = z - az[i];
      const ra = r0[i], rb = r1[i];
      const l2i = l2[i];
      const rr = ra - rb;
      const a2 = l2i - rr * rr;
      const il2 = 1 / l2i;
      const yv = px * dx[i] + py * dy[i] + pz * dz[i];
      const zv = yv - l2i;
      const wx = px * l2i - dx[i] * yv, wy = py * l2i - dy[i] * yv, wz = pz * l2i - dz[i] * yv;
      const x2 = (wx * wx + wy * wy + wz * wz) * il2 * il2;
      const y2 = yv * yv * il2;
      const z2 = zv * zv * il2;
      const kk = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zv) * a2 * z2 > kk) return Math.sqrt(x2 + z2) * il2 * l2i - rb;
      if (Math.sign(yv) * a2 * y2 < kk) return Math.sqrt(x2 + y2) * il2 * l2i - ra;
      return (Math.sqrt(x2 * a2 * il2) + yv * rr * il2) - ra;
    }
  };
  return primitive((x, y, z) => {
    if (index) return index.min(x, y, z, cone, boxDist, Infinity);
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (boxDist(i, x, y, z) >= best) continue;
      const d = cone(i, x, y, z);
      if (d < best) best = d;
    }
    return best;
  }, bounds, n * 2);
}

/**
 * A 2D profile carried along the polyline, its x across the path and its y
 * up. Each segment is an exact extrusion in its own frame, cut at each join
 * by the plane that bisects the angle there (a mitre), so neighbours meet
 * without a notch on the outside or a bump on the inside. The cut only
 * acts beyond its plane: inside the piece the value is the profile's own
 * distance, not the distance to the plane, or every join would read as a
 * dent to the extractor and the ray marcher. The two ends of the path are
 * cut flat. `smooth` keeps the angles small so the mitres are short.
 *
 * `twist` turns the profile by that many degrees over the whole path and
 * `taper` scales it from 1 at the start to `taper` at the end, both
 * continuously along the arc length, so a helix path with a twist is a
 * rope and a straight path with a taper is a horn.
 */
export function sweep(profile: Shape2, points: Vec3[], twist = 0, taper = 1): Shape3 {
  const segs = segments(points);
  if (segs.length === 0 || isEmpty2(profile.bounds)) return primitive(() => 1e6, EMPTY_BOUNDS, 0);
  const pd = profile.dist;
  const b = profile.bounds;
  const reach =
    Math.max(length2(b.min[0], b.min[1]), length2(b.max[0], b.max[1]), length2(b.min[0], b.max[1]), length2(b.max[0], b.min[1])) *
    Math.max(1, taper);
  const bounds = boundsGrow(boundsFromPoints(points), reach);
  const n = segs.length;
  // Arc length at each segment start, for twist and taper.
  const arcs = arcLengths(points);
  const segStart = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], c = points[i + 1];
    if ((c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2 + (c[2] - a[2]) ** 2 < 1e-12) continue;
    segStart[k++] = arcs.at[i];
  }
  const twistRate = (twist * Math.PI) / 180 / arcs.total;
  const taperRate = (taper - 1) / arcs.total;
  // Mitre plane normal at the join after segment i (points along the path).
  const mitre: Vec3[] = [];
  for (let i = 0; i < n - 1; i++) {
    const t0 = normalize(segs[i].d), t1 = normalize(segs[i + 1].d);
    let m = normalize([t0[0] + t1[0], t0[1] + t1[1], t0[2] + t1[2]]);
    if (!Number.isFinite(m[0]) || (m[0] === 0 && m[1] === 0 && m[2] === 0)) m = t0;
    mitre.push(m);
  }
  const plain = twist === 0 && taper === 1;
  // Per-piece boxes for culling: the segment grown by the profile's reach (and a little more for the mitre).
  const bmin = new Float64Array(n * 3), bmax = new Float64Array(n * 3);
  segs.forEach((s, i) => {
    const grow = reach * 1.5;
    for (let k = 0; k < 3; k++) {
      bmin[i * 3 + k] = Math.min(s.a[k], s.a[k] + s.d[k]) - grow;
      bmax[i * 3 + k] = Math.max(s.a[k], s.a[k] + s.d[k]) + grow;
    }
  });
  const boxDist = (i: number, x: number, y: number, z: number): number => {
    const ex = Math.max(bmin[i * 3] - x, 0, x - bmax[i * 3]);
    const ey = Math.max(bmin[i * 3 + 1] - y, 0, y - bmax[i * 3 + 1]);
    const ez = Math.max(bmin[i * 3 + 2] - z, 0, z - bmax[i * 3 + 2]);
    return Math.sqrt(ex * ex + ey * ey + ez * ez);
  };
  const index = n > 8 ? buildSpatialIndex(n, bmin, bmax, { min: bounds.min.map((v) => v - reach * 3), max: bounds.max.map((v) => v + reach * 3) }, cellsFor(n)) : undefined;
  const piece = (i: number, x: number, y: number, z: number): number => {
    {
      const s = segs[i];
      const px = x - s.a[0], py = y - s.a[1], pz = z - s.a[2];
      const len = Math.sqrt(s.len2);
      const along = (px * s.d[0] + py * s.d[1] + pz * s.d[2]) / len;
      let u = px * s.u[0] + py * s.u[1] + pz * s.u[2];
      let v = px * s.v[0] + py * s.v[1] + pz * s.v[2];
      let d2: number;
      if (plain) d2 = pd(u, v);
      else {
        const arc = segStart[i] + Math.max(0, Math.min(len, along));
        if (twistRate !== 0) {
          const a = twistRate * arc, c = Math.cos(a), sn = Math.sin(a);
          const ru = c * u + sn * v, rv = -sn * u + c * v;
          u = ru; v = rv;
        }
        const sc = Math.max(1e-6, 1 + taperRate * arc);
        d2 = pd(u / sc, v / sc) * sc;
      }
      // Start cap: flat at the path start, the mitre plane after a join.
      let capStart: number;
      if (i === 0) capStart = -along;
      else {
        const m = mitre[i - 1];
        capStart = -(px * m[0] + py * m[1] + pz * m[2]);
      }
      let capEnd: number;
      if (i === n - 1) capEnd = along - len;
      else {
        const m = mitre[i];
        const qx = px - s.d[0], qy = py - s.d[1], qz = pz - s.d[2];
        capEnd = qx * m[0] + qy * m[1] + qz * m[2];
      }
      const cap = Math.max(capStart, capEnd);
      return cap > 0 ? (d2 > 0 ? length2(d2, cap) : cap) : d2;
    }
  };
  return primitive((x, y, z) => {
    if (index) return index.min(x, y, z, piece, boxDist, 1e6);
    let best = 1e6;
    for (let i = 0; i < n; i++) {
      if (boxDist(i, x, y, z) >= best) continue;
      const d = piece(i, x, y, z);
      if (d < best) best = d;
    }
    return best;
  }, bounds, n * profile.cost);
}

/** Points of a helix of radius `r`, rising `h` over `turns` turns around y, `perTurn` points each turn. */
export function helixPath(r: number, h: number, turns: number, perTurn = 16): number[] {
  const n = Math.max(2, Math.round(turns * perTurn));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * Math.PI * 2;
    out.push(r * Math.cos(a), h * t, r * Math.sin(a));
  }
  return out;
}

/** Points of an arc of radius `r` in the x/z plane from `from` to `to` degrees, `segments` pieces. */
export function arcPath(r: number, from: number, to: number, segmentsCount = 16): number[] {
  const out: number[] = [];
  const n = Math.max(1, Math.round(segmentsCount));
  for (let i = 0; i <= n; i++) {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
    out.push(r * Math.sin(a), 0, r * Math.cos(a));
  }
  return out;
}

/**
 * A solid that is profile `a` at the bottom and `b` at the top, `h` tall,
 * the distance blended linearly between them. Sign-exact; the distance is
 * approximate between the ends.
 */
export function loft(a: Shape2, b: Shape2, h: number): Shape3 {
  const da = a.dist, db = b.dist, hh = h / 2;
  const minx = Math.min(a.bounds.min[0], b.bounds.min[0]), maxx = Math.max(a.bounds.max[0], b.bounds.max[0]);
  const miny = Math.min(a.bounds.min[1], b.bounds.min[1]), maxy = Math.max(a.bounds.max[1], b.bounds.max[1]);
  return primitive((x, y, z) => {
    const t = Math.max(0, Math.min(1, (y + hh) / h));
    const d2 = da(x, -z) * (1 - t) + db(x, -z) * t;
    const cap = Math.abs(y) - hh;
    return Math.min(Math.max(d2, cap), 0) + length2(Math.max(d2, 0), Math.max(cap, 0));
  }, { min: [minx, -hh, -maxy], max: [maxx, hh, -miny] }, a.cost + b.cost);
}

export { length3 };
