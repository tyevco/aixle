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

/** The box two boxes share, or undefined when they do not meet. */
function sharedBox(a: Shape3, b: Shape3): { min: Vec3; max: Vec3 } | undefined {
  if (isEmpty(a.bounds) || isEmpty(b.bounds)) return undefined;
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    min[k] = Math.max(a.bounds.min[k], b.bounds.min[k]);
    max[k] = Math.min(a.bounds.max[k], b.bounds.max[k]);
    if (max[k] <= min[k]) return undefined;
  }
  return { min, max };
}

/**
 * The volume the two shapes share, sampled on a lattice of `n` cells along the longest side of the box they
 * share: zero when they only touch, the sunk-in volume when one is pressed into the other (round 8, asked for:
 * a frog's belly blended into its pad, a mug's handle reaching into the cup). Cubic in n, so keep it to parts.
 */
export function overlapVolume(a: Shape3, b: Shape3, n = 24): number {
  const box = sharedBox(a, b);
  if (!box) return 0;
  const size = boundsSize(box);
  const cell = Math.max(size[0], size[1], size[2]) / n;
  const nx = Math.max(1, Math.ceil(size[0] / cell)), ny = Math.max(1, Math.ceil(size[1] / cell)), nz = Math.max(1, Math.ceil(size[2] / cell));
  const dx = size[0] / nx, dy = size[1] / ny, dz = size[2] / nz;
  let count = 0;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const x = box.min[0] + (i + 0.5) * dx, y = box.min[1] + (j + 0.5) * dy, z = box.min[2] + (k + 0.5) * dz;
        if (a.dist(x, y, z) < 0 && b.dist(x, y, z) < 0) count++;
      }
  return count * dx * dy * dz;
}

/** The point deepest inside both shapes, or undefined when no sample is in both: where an overlap is, for a failure. */
export function overlapWitness(a: Shape3, b: Shape3, n = 24): Vec3 | undefined {
  const box = sharedBox(a, b);
  if (!box) return undefined;
  const size = boundsSize(box);
  let best: Vec3 | undefined, bd = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        const x = box.min[0] + ((i + 0.5) * size[0]) / n, y = box.min[1] + ((j + 0.5) * size[1]) / n, z = box.min[2] + ((k + 0.5) * size[2]) / n;
        const d = Math.max(a.dist(x, y, z), b.dist(x, y, z));
        if (d < bd) { bd = d; best = [x, y, z]; }
      }
  return best;
}

/**
 * The fraction of `a`'s volume that lies inside `b`, 0 to 1, sampled over a's box: 1 for a spring that must stay
 * in its box, 0 for a handle that must stay out of the cup.
 */
export function insideFraction(a: Shape3, b: Shape3, n = 24): number {
  if (isEmpty(a.bounds)) return 0;
  const bb = a.bounds, size = boundsSize(bb);
  const cell = Math.max(size[0], size[1], size[2]) / n;
  const nx = Math.max(1, Math.ceil(size[0] / cell)), ny = Math.max(1, Math.ceil(size[1] / cell)), nz = Math.max(1, Math.ceil(size[2] / cell));
  let all = 0, within = 0;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const x = bb.min[0] + ((i + 0.5) * size[0]) / nx, y = bb.min[1] + ((j + 0.5) * size[1]) / ny, z = bb.min[2] + ((k + 0.5) * size[2]) / nz;
        if (a.dist(x, y, z) >= 0) continue;
        all++;
        if (isEmpty(b.bounds) ? false : b.dist(x, y, z) < 0) within++;
      }
  return all ? within / all : 0;
}

/** The point of `a` farthest outside `b`, or undefined when every sample of `a` is inside `b`: for a failed inside(). */
export function outsideWitness(a: Shape3, b: Shape3, n = 24): Vec3 | undefined {
  if (isEmpty(a.bounds)) return undefined;
  const bb = a.bounds, size = boundsSize(bb);
  let best: Vec3 | undefined, bd = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        const x = bb.min[0] + ((i + 0.5) * size[0]) / n, y = bb.min[1] + ((j + 0.5) * size[1]) / n, z = bb.min[2] + ((k + 0.5) * size[2]) / n;
        if (a.dist(x, y, z) >= 0) continue;
        const d = isEmpty(b.bounds) ? Infinity : b.dist(x, y, z);
        if (d >= 0 && (best === undefined || d > bd)) { bd = d; best = [x, y, z]; }
      }
  return best;
}

/**
 * Whether `region` holds no solid of `shape` at all: no lattice sample inside both, and no point of the shape's
 * surface inside the region (which catches an intrusion thinner than the lattice). For `assert void(cavity, mug)`.
 */
export function isVoid(region: Shape3, shape: Shape3, n = 24): boolean {
  return voidWitness(region, shape, n) === undefined;
}

/**
 * Where `shape` is solid inside `region`: the deepest solid lattice sample, or a surface point of the shape inside
 * the region when the solid is thinner than the lattice; undefined when the region is void.
 */
export function voidWitness(region: Shape3, shape: Shape3, n = 24): Vec3 | undefined {
  if (isEmpty(region.bounds) || isEmpty(shape.bounds)) return undefined;
  if (!sharedBox(region, shape)) return undefined;
  const bb = region.bounds, size = boundsSize(bb);
  // The region's own boundary does not count: a cavity's wall is the cup's inner surface, exactly on it.
  const tol = Math.max(size[0], size[1], size[2], 1e-6) * 0.005;
  let best: Vec3 | undefined, bd = 0;
  let thin: Vec3 | undefined;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++)
      for (let k = 0; k <= n; k++) {
        const x = bb.min[0] + (size[0] * i) / n, y = bb.min[1] + (size[1] * j) / n, z = bb.min[2] + (size[2] * k) / n;
        if (region.dist(x, y, z) >= -tol) continue;
        const d = shape.dist(x, y, z);
        if (d < 0) { if (d < bd) { bd = d; best = [x, y, z]; } continue; }
        if (thin) continue;
        // A sample in the void slid onto the shape's surface: solid inside the region thinner than the lattice.
        const q = surfacePoint(shape, x, y, z);
        if (Math.abs(shape.dist(q[0], q[1], q[2])) <= tol && region.dist(q[0], q[1], q[2]) < -tol) thin = q;
      }
  return best ?? thin;
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
