import { surfacePoint } from "./ops.js";
import { boundsSize, isEmpty, type Shape3 } from "./types.js";
import type { Vec3 } from "../core/vec.js";

/**
 * The smallest distance between two shapes' surfaces, from the fields:
 * points on a's surface read in b's field and the other way round, the
 * best of them tightened by alternating projections. Negative when they
 * overlap, by how deep one surface sits inside the other; zero when they
 * touch. What "the handle must clear the rim" needs as a number, so a
 * program can assert it (roadmap 6).
 *
 * Seeds are a lattice over each shape's box, `n` per side, projected onto
 * that shape's surface along its gradient; a part thinner than the
 * lattice still gets seeds, since every lattice point projects, but a
 * feature narrower than the lattice spacing can be missed, so a tight
 * promise is better made with the parts themselves than with a whole
 * model.
 */
/**
 * Whether any point of `shape`'s surface lies inside `region`: what a decal needs to paint anything. Sampled on a
 * lattice over the region's box, each sample slid onto the surface (round 8: a tag region beside the wrong part
 * painted nothing and nothing said so).
 */
export function regionTouches(shape: Shape3, region: Shape3, n = 12): boolean {
  if (isEmpty(shape.bounds) || isEmpty(region.bounds)) return false;
  for (let k = 0; k < 3; k++) if (region.bounds.max[k] < shape.bounds.min[k] || region.bounds.min[k] > shape.bounds.max[k]) return false;
  const bb = region.bounds, size = boundsSize(bb);
  const tol = Math.max(size[0], size[1], size[2], 1e-6) * 0.02;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++)
      for (let k = 0; k <= n; k++) {
        const x = bb.min[0] + (size[0] * i) / n, y = bb.min[1] + (size[1] * j) / n, z = bb.min[2] + (size[2] * k) / n;
        if (region.dist(x, y, z) > 0) continue;
        const q = surfacePoint(shape, x, y, z);
        if (Math.abs(shape.dist(q[0], q[1], q[2])) <= tol && region.dist(q[0], q[1], q[2]) <= 0) return true;
      }
  return false;
}

export function clearance(a: Shape3, b: Shape3, n = 12): number {
  if (isEmpty(a.bounds) || isEmpty(b.bounds)) return Infinity;
  let best = Infinity;
  let bestPoint: Vec3 | undefined;
  let bestFrom: Shape3 = a, bestInto: Shape3 = b;
  const seed = (from: Shape3, into: Shape3) => {
    const bb = from.bounds, size = boundsSize(bb);
    const step = Math.max(size[0], size[1], size[2]) / n;
    const near = step * 1.5;
    // Lattice points within reach of the surface first; if the part is thinner than the lattice none may be, so
    // then every point is projected.
    const tryAt = (x: number, y: number, z: number) => {
      const q = surfacePoint(from, x, y, z);
      if (Math.abs(from.dist(q[0], q[1], q[2])) > step * 0.05) return;
      const d = into.dist(q[0], q[1], q[2]);
      if (d < best) { best = d; bestPoint = q; bestFrom = from; bestInto = into; }
    };
    let any = false;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++)
        for (let k = 0; k <= n; k++) {
          const x = bb.min[0] + (size[0] * i) / n, y = bb.min[1] + (size[1] * j) / n, z = bb.min[2] + (size[2] * k) / n;
          if (Math.abs(from.dist(x, y, z)) > near) continue;
          any = true;
          tryAt(x, y, z);
        }
    if (any) return;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++)
        for (let k = 0; k <= n; k++) tryAt(bb.min[0] + (size[0] * i) / n, bb.min[1] + (size[1] * j) / n, bb.min[2] + (size[2] * k) / n);
  };
  seed(a, b);
  seed(b, a);
  if (!bestPoint) return Infinity;
  // Tighten: slide the point onto the other surface and back, which walks down to the nearest pair when the two
  // surfaces face each other; each step is accepted only when it brings the distance down.
  let p = bestPoint;
  for (let i = 0; i < 12; i++) {
    const onInto = surfacePoint(bestInto, p[0], p[1], p[2]);
    const back = surfacePoint(bestFrom, onInto[0], onInto[1], onInto[2]);
    const d = bestInto.dist(back[0], back[1], back[2]);
    if (d >= best - 1e-9) break;
    best = d; p = back;
  }
  return best;
}
