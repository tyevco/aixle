/**
 * Shapes that follow a path or change along their length: tubes and swept
 * profiles along a polyline, and lofts between two profiles. A polyline can
 * be smoothed into a curve (Catmull-Rom through the given points) before
 * use, so a handle is four points and `smooth=8`.
 */
import { length2, length3, normalize, cross, type Vec3 } from "../core/vec.js";
import { primitive } from "./primitives.js";
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

/** A round tube of radius `r` along the polyline, joins rounded: a chain of capsules, exact. */
export function tube(points: Vec3[], r: number): Shape3 {
  const segs = segments(points);
  if (segs.length === 0) return primitive(() => 1e6, EMPTY_BOUNDS, 0);
  const n = segs.length;
  const ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
  const dx = new Float64Array(n), dy = new Float64Array(n), dz = new Float64Array(n), l2 = new Float64Array(n);
  segs.forEach((s, i) => {
    ax[i] = s.a[0]; ay[i] = s.a[1]; az[i] = s.a[2];
    dx[i] = s.d[0]; dy[i] = s.d[1]; dz[i] = s.d[2]; l2[i] = s.len2;
  });
  const bounds = boundsGrow(boundsFromPoints(points), r);
  return primitive((x, y, z) => {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const px = x - ax[i], py = y - ay[i], pz = z - az[i];
      let t = (px * dx[i] + py * dy[i] + pz * dz[i]) / l2[i];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - dx[i] * t, qy = py - dy[i] * t, qz = pz - dz[i] * t;
      const d2 = qx * qx + qy * qy + qz * qz;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best) - r;
  }, bounds, n);
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
 */
export function sweep(profile: Shape2, points: Vec3[]): Shape3 {
  const segs = segments(points);
  if (segs.length === 0 || isEmpty2(profile.bounds)) return primitive(() => 1e6, EMPTY_BOUNDS, 0);
  const pd = profile.dist;
  const b = profile.bounds;
  const reach = Math.max(length2(b.min[0], b.min[1]), length2(b.max[0], b.max[1]), length2(b.min[0], b.max[1]), length2(b.max[0], b.min[1]));
  const bounds = boundsGrow(boundsFromPoints(points), reach);
  const n = segs.length;
  // Mitre plane normal at the join after segment i (points along the path).
  const mitre: Vec3[] = [];
  for (let i = 0; i < n - 1; i++) {
    const t0 = normalize(segs[i].d), t1 = normalize(segs[i + 1].d);
    let m = normalize([t0[0] + t1[0], t0[1] + t1[1], t0[2] + t1[2]]);
    if (!Number.isFinite(m[0]) || (m[0] === 0 && m[1] === 0 && m[2] === 0)) m = t0;
    mitre.push(m);
  }
  return primitive((x, y, z) => {
    let best = 1e6;
    for (let i = 0; i < n; i++) {
      const s = segs[i];
      const px = x - s.a[0], py = y - s.a[1], pz = z - s.a[2];
      const len = Math.sqrt(s.len2);
      const along = (px * s.d[0] + py * s.d[1] + pz * s.d[2]) / len;
      const u = px * s.u[0] + py * s.u[1] + pz * s.u[2];
      const v = px * s.v[0] + py * s.v[1] + pz * s.v[2];
      const d2 = pd(u, v);
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
      const d = cap > 0 ? (d2 > 0 ? length2(d2, cap) : cap) : d2;
      if (d < best) best = d;
    }
    return best;
  }, bounds, n * profile.cost);
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
