import { surfacePoint } from "./ops.js";
import { boundsSize, isEmpty, type Bounds, type Shape3 } from "./types.js";
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
/**
 * A lattice cell for a box: `n` cells along its longest side, then halved while the sample count stays within
 * the budget, and never coarser than a quarter of the shortest side. A rim sunk 0.02 into a base shares a box the
 * height of the rim's cut but overlaps it in a ring 0.02 tall, which 24 cells miss (round 10); 200k samples cost
 * well under a second.
 */
function latticeCell(size: Vec3, n: number, budget = 200000): number {
  const longest = Math.max(size[0], size[1], size[2]), shortest = Math.max(1e-9, Math.min(size[0], size[1], size[2]));
  const count = (c: number) => Math.ceil(size[0] / c) * Math.ceil(size[1] / c) * Math.ceil(size[2] / c);
  let cell = longest / n;
  while (count(cell / 2) <= budget) cell /= 2;
  if (cell > shortest / 4) { cell = shortest / 4; if (count(cell) > budget) cell *= Math.cbrt(count(cell) / budget); }
  return cell;
}

export function overlapVolume(a: Shape3, b: Shape3, n = 24): number {
  const box = sharedBox(a, b);
  if (!box) return 0;
  const size = boundsSize(box);
  const cell = latticeCell(size, n);
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
  const cell = latticeCell(size, n);
  const nx = Math.max(1, Math.ceil(size[0] / cell)), ny = Math.max(1, Math.ceil(size[1] / cell)), nz = Math.max(1, Math.ceil(size[2] / cell));
  let best: Vec3 | undefined, bd = 0;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const x = box.min[0] + ((i + 0.5) * size[0]) / nx, y = box.min[1] + ((j + 0.5) * size[1]) / ny, z = box.min[2] + ((k + 0.5) * size[2]) / nz;
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
  return clearanceAt(a, b, n).d;
}

/** The clearance and the point on `a` or `b` where it was measured: the closest approach, or the deepest overlap. */
export function clearanceAt(a: Shape3, b: Shape3, n = 12): { d: number; at?: Vec3 } {
  if (isEmpty(a.bounds) || isEmpty(b.bounds)) return { d: Infinity };
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
  if (!bestPoint) return { d: Infinity };
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
  return { d: best, at: p };
}

/**
 * Where three cross-sections through a part go: through its solid's centroid on each axis, or, where a plane there
 * would cut less than half of the part's widest section along that axis (the hole of a ring, the air between a
 * post and the lantern it carries), through that widest section, the one nearest the centroid. Sampled on a
 * lattice of `n` cells along the box's longest side; undefined when no sample lies inside. The box's centre is
 * not used: a tree whose canopy leans or a lamp whose arm reaches out has its centre in the air (round 10: a
 * terrarium's slices showed a plant as a floating blob, its stem off every plane).
 */
export function sliceLevels(shape: Shape3, box: Bounds = shape.bounds, n = 40): { at: Vec3; centroid: Vec3; area: Vec3; widest: Vec3 } | undefined {
  if (isEmpty(box)) return undefined;
  const size = boundsSize(box);
  const longest = Math.max(size[0], size[1], size[2]);
  if (!(longest > 0)) return undefined;
  const dims = [0, 1, 2].map((k) => Math.max(2, Math.round((n * size[k]) / longest)));
  const step = [0, 1, 2].map((k) => size[k] / dims[k]);
  const counts = [0, 1, 2].map((k) => new Float64Array(dims[k]));
  const sum = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < dims[0]; i++) {
    const x = box.min[0] + (i + 0.5) * step[0];
    for (let j = 0; j < dims[1]; j++) {
      const y = box.min[1] + (j + 0.5) * step[1];
      for (let k = 0; k < dims[2]; k++) {
        const z = box.min[2] + (k + 0.5) * step[2];
        if (shape.dist(x, y, z) >= 0) continue;
        counts[0][i]++; counts[1][j]++; counts[2][k]++;
        sum[0] += x; sum[1] += y; sum[2] += z;
        total++;
      }
    }
  }
  if (total === 0) return undefined;
  const centroid = sum.map((v) => v / total) as Vec3;
  const at: Vec3 = [0, 0, 0], area: Vec3 = [0, 0, 0], widest: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const c = counts[a];
    let max = 0;
    for (const v of c) max = Math.max(max, v);
    const ic = Math.max(0, Math.min(dims[a] - 1, Math.floor((centroid[a] - box.min[a]) / step[a])));
    // The widest section nearest the centroid, for when the centroid's own is thin or empty.
    let best = ic, bd = Infinity;
    for (let i = 0; i < dims[a]; i++) if (c[i] >= max * 0.95 && Math.abs(i - ic) < bd) { bd = Math.abs(i - ic); best = i; }
    widest[a] = box.min[a] + (best + 0.5) * step[a];
    const cell = step[(a + 1) % 3] * step[(a + 2) % 3];
    if (c[ic] >= max * 0.5) { at[a] = centroid[a]; area[a] = c[ic] * cell; }
    else { at[a] = widest[a]; area[a] = c[best] * cell; }
  }
  return { at, centroid, area, widest };
}

/**
 * Where a step rests on the rest of the model, for slices through it: the lowest place where the model's surface
 * comes within `reach` of the step's own (two cells, say), or passes into it. A slice through a step is usually there
 * to show what the step stands on, and its centroid's planes can miss that: a book leaning 18 degrees has its
 * centroid's vertical plane in the air between two shelves (round 11). Sampled on a lattice of `n` cells along the
 * box's longest side: each sample near the step's surface slides onto it along the gradient, and is a contact when,
 * a little way out along the normal, something of `model` other than the step is nearer than the step is. The
 * contacts are grouped by lattice neighbours and the lowest group is taken (its centroid's height), since what a
 * part rests on is under it. `at` is that group's centroid moved a little into the step, so the planes cut the step
 * and what it rests on together; `normal` is the group's mean outward normal, zero for a contact all round (a stem
 * in its soil), which says which plane lies along the contact and is better left where it was.
 */
export function restingContact(step: Shape3, model: Shape3, reach: number, box: Bounds = step.bounds, n = 48): { at: Vec3; normal: Vec3; samples: number } | undefined {
  if (isEmpty(box) || !(reach > 0)) return undefined;
  const size = boundsSize(box);
  const longest = Math.max(size[0], size[1], size[2]);
  if (!(longest > 0)) return undefined;
  const h = longest / n;
  const dims = [0, 1, 2].map((k) => Math.max(2, Math.ceil(size[k] / h) + 2));
  const o = [0, 1, 2].map((k) => box.min[k] - h);
  const d = step.dist;
  const eps = h * 0.25;
  // The probe sits `out` beyond the surface; something else is in reach when it is nearer the probe than the step
  // is by a margin (so a step's own concave side, which is nearest itself, never counts).
  const out = reach * 0.6, margin = reach * 0.25;
  const hits = new Map<number, { p: Vec3; nrm: Vec3 }>();
  const key = (i: number, j: number, k: number) => (i * dims[1] + j) * dims[2] + k;
  for (let i = 0; i < dims[0]; i++)
    for (let j = 0; j < dims[1]; j++)
      for (let k = 0; k < dims[2]; k++) {
        const x = o[0] + i * h, y = o[1] + j * h, z = o[2] + k * h;
        const s = d(x, y, z);
        if (!(Math.abs(s) < h * 0.75)) continue;
        let gx = d(x + eps, y, z) - d(x - eps, y, z), gy = d(x, y + eps, z) - d(x, y - eps, z), gz = d(x, y, z + eps) - d(x, y, z - eps);
        const gl = Math.hypot(gx, gy, gz);
        if (!(gl > 0)) continue;
        gx /= gl; gy /= gl; gz /= gl;
        const p: Vec3 = [x - gx * s, y - gy * s, z - gz * s];
        const q: Vec3 = [p[0] + gx * out, p[1] + gy * out, p[2] + gz * out];
        if (d(q[0], q[1], q[2]) - model.dist(q[0], q[1], q[2]) > margin) hits.set(key(i, j, k), { p, nrm: [gx, gy, gz] });
      }
  if (!hits.size) return undefined;
  // Groups of lattice neighbours (26 round each), by a flood from each unvisited contact.
  const seen = new Set<number>();
  let best: { at: Vec3; normal: Vec3; samples: number; low: number } | undefined;
  for (const start of hits.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    const sum: Vec3 = [0, 0, 0], ns: Vec3 = [0, 0, 0];
    let count = 0;
    while (stack.length) {
      const c = stack.pop()!;
      const hit = hits.get(c)!;
      for (let a = 0; a < 3; a++) { sum[a] += hit.p[a]; ns[a] += hit.nrm[a]; }
      count++;
      const k = c % dims[2], j = Math.floor(c / dims[2]) % dims[1], i = Math.floor(c / (dims[1] * dims[2]));
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++)
          for (let dk = -1; dk <= 1; dk++) {
            const ii = i + di, jj = j + dj, kk = k + dk;
            if (ii < 0 || jj < 0 || kk < 0 || ii >= dims[0] || jj >= dims[1] || kk >= dims[2]) continue;
            const nk = key(ii, jj, kk);
            if (hits.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
          }
    }
    const centre: Vec3 = [sum[0] / count, sum[1] / count, sum[2] / count];
    // A group of a sample or two is noise at a corner; the lowest group of the rest wins, the larger of two at a height.
    if (count < 3) continue;
    if (best && (centre[1] > best.low + h || (Math.abs(centre[1] - best.low) <= h && count <= best.samples))) continue;
    const nl = Math.hypot(ns[0], ns[1], ns[2]) / count;
    const normal: Vec3 = nl > 0.2 ? [ns[0] / count / nl, ns[1] / count / nl, ns[2] / count / nl] : [0, 0, 0];
    // Into the step, so the planes cut it as well as what it rests on.
    const at: Vec3 = [centre[0] - normal[0] * reach, centre[1] - normal[1] * reach, centre[2] - normal[2] * reach];
    best = { at, normal, samples: count, low: centre[1] };
  }
  return best ? { at: best.at, normal: best.normal, samples: best.samples } : undefined;
}
