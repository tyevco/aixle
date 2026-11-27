import { move, rotateBy, surfacePoint } from "./ops.js";
import { boundsSize, boundsUnion, isEmpty, type Bounds, type Shape3 } from "./types.js";
import { rotAxis, type Vec3 } from "../core/vec.js";

/**
 * Whether any point of `shape`'s surface lies inside `region`: what a decal needs to paint anything. Sampled on a
 * lattice over the region's box, each sample slid onto the surface (round 8: a tag region beside the wrong part
 * painted nothing and nothing said so). A sample outside the region is first slid onto the region's own surface:
 * a region of two bands 0.06 tall and 1.6 apart has a box whose 13 lattice planes fall 0.14 apart, none of them
 * inside a band, and was said to paint nothing while it painted both (round 11, 32 times on one bookcase). That
 * slide moves along the shape's normal, which keeps to a band's face where the band crosses a flat spine square on
 * but leaves it where the surface curves away under the band (two thin bands round a ball were still said to paint
 * nothing), so the few points that came nearest the region are then walked along the shape's surface down the
 * region's field, as clearance() walks its best points: the surface reaches into the region if they get there.
 * Bounded: a lattice and four walks of a fixed number of steps.
 */
export function regionTouches(shape: Shape3, region: Shape3, n = 12): boolean {
  if (isEmpty(shape.bounds) || isEmpty(region.bounds)) return false;
  for (let k = 0; k < 3; k++) if (region.bounds.max[k] < shape.bounds.min[k] || region.bounds.min[k] > shape.bounds.max[k]) return false;
  const bb = region.bounds, size = boundsSize(bb);
  const longest = Math.max(size[0], size[1], size[2], 1e-6);
  const tol = longest * 0.02;
  const edge = longest * 1e-6;
  const onShape = (q: Vec3) => Math.abs(shape.dist(q[0], q[1], q[2])) <= tol;
  const seeds: { d: number; p: Vec3 }[] = [];
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++)
        for (let k = 0; k <= n; k++) {
          const x = bb.min[0] + (size[0] * i) / n, y = bb.min[1] + (size[1] * j) / n, z = bb.min[2] + (size[2] * k) / n;
          const inside = region.dist(x, y, z) <= 0;
          if (inside !== (pass === 0)) continue;
          const q = pass === 0 ? surfacePoint(shape, x, y, z) : surfacePoint(shape, ...surfacePoint(region, x, y, z));
          if (!onShape(q)) continue;
          const d = region.dist(q[0], q[1], q[2]);
          if (d <= edge) return true;
          if (pass === 1 && (seeds.length < 4 || d < seeds[3].d)) {
            seeds.push({ d, p: q });
            seeds.sort((a, b) => a.d - b.d);
            seeds.length = Math.min(seeds.length, 4);
          }
        }
  const scale = Math.max(longest, ...boundsSize(shape.bounds));
  for (const s of seeds) {
    const r = descend(shape, region, s.p, s.d, longest / n, scale);
    if (r.d <= edge && onShape(r.p)) return true;
  }
  return false;
}

/**
 * The box two boxes share, or undefined when they do not meet. With `touch`, a shared box thinner than that on any
 * side is a touch, not a meeting: a book ground()ed onto a board whose top is 0.8000000000000002 shares a box 1e-16
 * tall (round 11), which holds no volume worth sampling, and a lattice one cell across it measures nothing.
 */
function sharedBox(a: Shape3, b: Shape3, touch = 0): { min: Vec3; max: Vec3 } | undefined {
  if (isEmpty(a.bounds) || isEmpty(b.bounds)) return undefined;
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    min[k] = Math.max(a.bounds.min[k], b.bounds.min[k]);
    max[k] = Math.min(a.bounds.max[k], b.bounds.max[k]);
    if (!(max[k] - min[k] > touch)) return undefined;
  }
  return { min, max };
}

/** Floating point's reach at the size of two parts: a shared box thinner than this is two faces that meet. */
function touchTolerance(a: Shape3, b: Shape3): number {
  return 1e-9 * Math.max(1, ...boundsSize(a.bounds), ...boundsSize(b.bounds));
}

/**
 * The volume the two shapes share, sampled on a lattice of `n` cells along the longest side of the box they
 * share: zero when they only touch, the sunk-in volume when one is pressed into the other (round 8, asked for:
 * a frog's belly blended into its pad, a mug's handle reaching into the cup). Cubic in n, so keep it to parts.
 */
/**
 * A lattice cell for a box: `n` cells along its longest side, then halved while the sample count stays within
 * the budget, and never coarser than a quarter of the shortest side unless the budget forbids it. A rim sunk 0.02
 * into a base shares a box the height of the rim's cut but overlaps it in a ring 0.02 tall, which 24 cells miss
 * (round 10); 200k samples cost well under a second. The count never exceeds the budget, whatever the box: a side
 * thinner than the cell is one cell across however fine the cell, so scaling the cell by the cube root of the
 * excess undershoots, and a box 1e-16 tall asked for seven billion samples (round 11: check ran for twelve
 * minutes on a book resting on a shelf). The cell is then searched for between the two, a bounded bisection.
 */
export function latticeCell(size: Vec3, n: number, budget = 200000): number {
  const longest = Math.max(size[0], size[1], size[2]), shortest = Math.max(1e-9, Math.min(size[0], size[1], size[2]));
  if (!(longest > 0) || !Number.isFinite(longest)) return longest;
  const count = (c: number) => Math.ceil(size[0] / c) * Math.ceil(size[1] / c) * Math.ceil(size[2] / c);
  let cell = longest / n;
  while (count(cell) > budget) cell *= 2;
  while (count(cell / 2) <= budget) cell /= 2;
  if (cell > shortest / 4) {
    const coarse = cell;
    cell = shortest / 4;
    if (count(cell) > budget) cell *= Math.cbrt(count(cell) / budget);
    if (count(cell) > budget) {
      // Within budget at `coarse`, over it at `cell`: the finest cell that keeps to it lies between.
      let lo = cell, hi = coarse;
      for (let i = 0; i < 60 && hi - lo > hi * 1e-6; i++) { const mid = (lo + hi) / 2; if (count(mid) > budget) lo = mid; else hi = mid; }
      cell = hi;
    }
  }
  return cell;
}

export function overlapVolume(a: Shape3, b: Shape3, n = 24): number {
  const box = sharedBox(a, b, touchTolerance(a, b));
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
  const box = sharedBox(a, b, touchTolerance(a, b));
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
  const size = boundsSize(a.bounds);
  const count = (cell: number) => {
    const bb = a.bounds;
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
    return { all, within };
  };
  const first = count(Math.max(size[0], size[1], size[2]) / n);
  if (!first.all) return 0;
  // A 0 is what a promise that a part stays out is made of, and a skin thinner than the lattice gives it falsely: a
  // 3.6 cable along a 3 slot, 0.3 into both walls, read 0 (round 11), its box 3.6 across sampled twice. When b's
  // solid is inside a after all, found as void() finds it, walking the surface, the fraction is read again on the
  // finer lattice overlap() uses, and is never 0: a skin no finer lattice sees reads as half a sample. A 1 is left
  // as the lattice reads it: a flame blended into a smooth union bulges 0.003 below the floor of the hearth it
  // must sit in (round 9), and a promise that a part stays in is judged by its volume, not by such a sliver.
  if (first.within > 0 || voidWitness(a, b, n) === undefined) return first.within / first.all;
  const fine = count(latticeCell(size, n));
  return Math.max(fine.all ? fine.within / fine.all : 0, 0.5 / Math.max(fine.all, first.all));
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
 * The point of `a` deepest inside `b` on the lattice outsideWitness() reads, or a point of b's surface inside a when
 * the overlap is a skin thinner than the lattice: for a failed inside() that should have been 0.
 */
export function insideWitness(a: Shape3, b: Shape3, n = 24): Vec3 | undefined {
  if (isEmpty(a.bounds) || isEmpty(b.bounds)) return undefined;
  const bb = a.bounds, size = boundsSize(bb);
  let best: Vec3 | undefined, bd = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        const x = bb.min[0] + ((i + 0.5) * size[0]) / n, y = bb.min[1] + ((j + 0.5) * size[1]) / n, z = bb.min[2] + ((k + 0.5) * size[2]) / n;
        const d = Math.max(a.dist(x, y, z), b.dist(x, y, z));
        if (d < bd) { bd = d; best = [x, y, z]; }
      }
  return best ?? voidWitness(a, b, n);
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
  // The region's own boundary does not count: a cavity's wall is the cup's inner surface, exactly on it. That is a
  // matter of floating point and of how close a projection lands, not of the region's size: at half a percent of the
  // region's longest side, a cable probe 77 long let a 3 slot press 0.3 into it for 60 along its length and held
  // (round 11), the skin lying inside the band taken for the boundary.
  const tol = Math.max(size[0], size[1], size[2], 0.1) * 1e-5;
  let best: Vec3 | undefined, bd = -tol;
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

/**
 * The smallest distance between two shapes' surfaces, from the fields: the least that a point of either surface
 * reads in the other's field. Zero when they touch; when they overlap, negative by the depth of the deepest point
 * either surface reaches inside the other, measured to the other's surface: the distance they must be moved
 * apart to only touch, for a face sunk into a face or a round part pressed into another. Symmetric: a book whose
 * top is 0.15 into a 0.2 board reads -0.15 from either side, though the board's own field at the book's top face
 * says 0.05 (the nearer way out of the board is up through its top; round 11 read -0.058 there, from whichever
 * side's seeds happened to land). What "the handle must clear the rim" needs as a number (roadmap 6).
 *
 * Seeds are a lattice over each shape's box and over the box where the two meet (or the gap between their boxes),
 * `n` per side, projected onto each surface along its gradient; a part thinner than the lattice still gets seeds,
 * since every lattice point projects. The best seeds on each surface are then walked downhill along that
 * surface: first by sliding onto the other surface and back, which closes the gap between two faces that face
 * each other in a step, then by the other field's gradient along the surface, which finds the lowest line of a
 * rounded edge resting on a plane or the corner of a turned box on a face, where sliding back and forth creeps
 * (round 11: a rounded book on its shelf read 0.0037 for 0, and a leaning corner on its neighbour 0.009). A
 * feature narrower than the lattice spacing away from where the two meet can still be missed, so a tight promise
 * is better made with the parts themselves than with a whole model.
 */
export function clearance(a: Shape3, b: Shape3, n = 12): number {
  return clearanceAt(a, b, n).d;
}

const CLEARANCES = new WeakMap<Shape3, WeakMap<Shape3, Map<number, { d: number; at?: Vec3 }>>>();

/** The gradient of a field at a point by central differences, unnormalised. */
function fieldGradient(s: Shape3, x: number, y: number, z: number, e: number): Vec3 {
  return [s.dist(x + e, y, z) - s.dist(x - e, y, z), s.dist(x, y + e, z) - s.dist(x, y - e, z), s.dist(x, y, z + e) - s.dist(x, y, z - e)];
}

/**
 * The lowest reading of `into`'s field on `from`'s surface near `p`: slid between the surfaces while that helps,
 * then walked along `from`'s surface against `into`'s gradient with a step that grows on success and halves on
 * failure. Bounded: a fixed number of iterations whatever the geometry.
 */
function descend(from: Shape3, into: Shape3, p: Vec3, d: number, step: number, scale: number): { d: number; p: Vec3 } {
  const onSurface = Math.max(scale * 1e-6, 2e-7, Math.abs(from.dist(p[0], p[1], p[2])));
  for (let i = 0; i < 12; i++) {
    const onInto = surfacePoint(into, p[0], p[1], p[2]);
    const back = surfacePoint(from, onInto[0], onInto[1], onInto[2]);
    if (Math.abs(from.dist(back[0], back[1], back[2])) > onSurface) break;
    const nd = into.dist(back[0], back[1], back[2]);
    if (nd >= d - 1e-12 * scale) break;
    d = nd; p = back;
  }
  const e = Math.max(1e-9, scale * 1e-6);
  let alpha = step * 0.5;
  for (let i = 0; i < 80 && alpha > scale * 1e-8; i++) {
    const gi = fieldGradient(into, p[0], p[1], p[2], e), gf = fieldGradient(from, p[0], p[1], p[2], e);
    const fl = Math.hypot(gf[0], gf[1], gf[2]);
    if (!(fl > 0)) break;
    const nx = gf[0] / fl, ny = gf[1] / fl, nz = gf[2] / fl;
    const along = gi[0] * nx + gi[1] * ny + gi[2] * nz;
    let tx = gi[0] - along * nx, ty = gi[1] - along * ny, tz = gi[2] - along * nz;
    const tl = Math.hypot(tx, ty, tz);
    // Flat against the other field (a face parallel to the face it reads): this is as low as it goes here.
    if (!(tl > 1e-9 * Math.hypot(gi[0], gi[1], gi[2]))) break;
    tx /= tl; ty /= tl; tz /= tl;
    const q = surfacePoint(from, p[0] - alpha * tx, p[1] - alpha * ty, p[2] - alpha * tz);
    const qd = Math.abs(from.dist(q[0], q[1], q[2])) <= onSurface ? into.dist(q[0], q[1], q[2]) : Infinity;
    if (qd < d - 1e-12 * scale) { d = qd; p = q; alpha *= 2; } else alpha *= 0.5;
  }
  return { d, p };
}

/** The clearance and the point on `a` or `b` where it was measured: the closest approach, or the deepest overlap. */
export function clearanceAt(a: Shape3, b: Shape3, n = 12): { d: number; at?: Vec3 } {
  if (isEmpty(a.bounds) || isEmpty(b.bounds)) return { d: Infinity };
  // An assert asks twice, once for the number and once for where (its failure says), so the reading is kept.
  const memo = CLEARANCES.get(a)?.get(b)?.get(n);
  if (memo) return memo;
  const scale = Math.max(1e-6, ...boundsSize(a.bounds), ...boundsSize(b.bounds));
  // The best seed on each surface, read in the other's field: one the projection put on the surface, or, for a field
  // that is only a bound and stalls (a cut's field on the ridge between two of its faces), the best that came within
  // a twentieth of the lattice step of it. A stalled point read in the other field is off by as far as it stalled:
  // a cable probe read -1.3 for a 0.3 intrusion from a point stalled 0.5 above a groove.
  const onSurface = Math.max(scale * 1e-6, 2e-7);
  const best: { d: number; p?: Vec3; step: number }[] = [{ d: Infinity, step: 0 }, { d: Infinity, step: 0 }];
  const loose: { d: number; p?: Vec3; step: number }[] = [{ d: Infinity, step: 0 }, { d: Infinity, step: 0 }];
  const shapes: [Shape3, Shape3][] = [[a, b], [b, a]];
  const tryAt = (side: number, x: number, y: number, z: number, step: number) => {
    const [from, into] = shapes[side];
    const q = surfacePoint(from, x, y, z);
    const off = Math.abs(from.dist(q[0], q[1], q[2]));
    const into_ = off <= onSurface ? best : off <= step * 0.05 ? loose : undefined;
    if (!into_) return;
    const d = into.dist(q[0], q[1], q[2]);
    if (d < into_[side].d) into_[side] = { d, p: q, step };
  };
  const lattice = (box: { min: ArrayLike<number>; max: ArrayLike<number> }, visit: (x: number, y: number, z: number) => void) => {
    const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++)
        for (let k = 0; k <= n; k++) visit(box.min[0] + (size[0] * i) / n, box.min[1] + (size[1] * j) / n, box.min[2] + (size[2] * k) / n);
  };
  const seed = (side: number) => {
    const from = shapes[side][0];
    const bb = from.bounds, size = boundsSize(bb);
    const step = Math.max(size[0], size[1], size[2]) / n;
    const near = step * 1.5;
    // Lattice points within reach of the surface first; if the part is thinner than the lattice none may be, so
    // then every point is projected.
    let any = false;
    lattice(bb, (x, y, z) => { if (Math.abs(from.dist(x, y, z)) > near) return; any = true; tryAt(side, x, y, z, step); });
    if (!any) lattice(bb, (x, y, z) => tryAt(side, x, y, z, step));
  };
  seed(0);
  seed(1);
  // Where the two meet: the box they share, or the gap between their boxes on an axis where they do not, so a
  // small part against a large one (a book under a long board) is seeded at its own scale on both surfaces.
  const lo: Vec3 = [0, 0, 0], hi: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const l = Math.max(a.bounds.min[k], b.bounds.min[k]), h = Math.min(a.bounds.max[k], b.bounds.max[k]);
    lo[k] = Math.min(l, h); hi[k] = Math.max(l, h);
  }
  const contactStep = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / n;
  if (contactStep > 0) lattice({ min: lo, max: hi }, (x, y, z) => { tryAt(0, x, y, z, contactStep); tryAt(1, x, y, z, contactStep); });
  let out: { d: number; at?: Vec3 } = { d: Infinity };
  for (let side = 0; side < 2; side++) {
    const s0 = best[side].p ? best[side] : loose[side];
    if (!s0.p) continue;
    const [from, into] = shapes[side];
    const r = descend(from, into, s0.p, s0.d, Math.max(s0.step, contactStep), scale);
    if (r.d < out.d) out = { d: r.d, at: r.p };
  }
  const byB = CLEARANCES.get(a) ?? new WeakMap();
  CLEARANCES.set(a, byB);
  const byN = byB.get(b) ?? new Map();
  byB.set(b, byN);
  byN.set(n, out);
  return out;
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

// --- placing by contact: rest() and lean() -------------------------------------

/**
 * A rigid motion with one parameter, t: a move along a unit direction (t in units) or a turn about a line (t in
 * degrees). What rest() and lean() search along: the part at t, where its points go, and how fast they go there.
 */
interface Motion {
  /** The part at t. */
  place(t: number): Shape3;
  /** Where the part's point p is at t, or, with `inverse`, where the world point p is in the part's own frame at t. */
  map(p: Vec3, t: number, inverse: boolean, out: Vec3): void;
  /** The fastest any point of the part moves, units per unit of t: a gap g cannot close in less than g / maxSpeed. */
  maxSpeed: number;
}

/** What rest() and lean() found: the part in contact, how far it went, and the gap the contact leaves. */
export interface Contact {
  /** The part moved or turned into contact, then sunk by `sink` (rest only). */
  shape: Shape3;
  /** How far it moved along the direction (units) or turned about the axis (degrees); negative when it was backed out. */
  amount: number;
  /** clearance(part, on) at the contact, before any sink: within a ten-millionth of the part's size of zero, or clear by up to a millionth. */
  gap: number;
  /** True when the part started inside `on` and was backed out against the motion to where it only touches. */
  backed: boolean;
  /** How deep a sliver of `on` the part started in and was lifted out of first (0 for none). */
  lifted: number;
  /** How many clearance() readings the search took (one per nearby part of a union), for measuring. */
  readings: number;
}

/** No contact along the motion, for the error the builtin words with the parts' names. */
export interface NoContact {
  shape?: undefined;
  /** The parameter the search went to, units or degrees. */
  reach: number;
  /** Set when the part started this deep inside `on` and moving back against the motion does not free it. */
  inside?: number;
}

const DEG = Math.PI / 180;

/**
 * The first t in (0, limit] at which the point p, carried by the motion (or, with `inverse`, the world point p seen
 * from the moving part), reaches `field`'s surface going in; Infinity when it does not by `limit` or `best`. Sphere
 * tracing: a step as long as the field reads, over the point's speed, cannot pass the surface. Near the surface a
 * short probe ahead says whether the point is going in; sliding along a face (a box slid along the ledge it stands
 * on, or 0.01 above it), steps of the field's reading would stall, so the step is at least `graze`. A probe or a
 * step that lands inside is bisected back to the surface. A feature thinner than `graze` that the point meets only
 * while sliding along a face can be stepped over; the seeds on the other surface, traced the other way, still meet
 * it.
 */
function traceContact(field: Shape3, p: Vec3, inverse: boolean, m: Motion, speed: number, limit: number, best: number, eps: number, graze: number, slack: number): number {
  const x: Vec3 = [0, 0, 0];
  const stop = Math.min(limit, best);
  // A seed the slide left a little off its own surface reads the other field that much off, either way.
  const inside = eps + slack;
  const probe = Math.max(eps * 1000, inside * 2);
  const read = (t: number) => { m.map(p, t, inverse, x); return field.dist(x[0], x[1], x[2]); };
  // The surface between a parameter outside and one inside: bisected to within eps of motion, and kept on the near
  // side by eps and the seed's own distance off its surface, so the contact it reports is clear, not a hair in.
  const cross = (lo: number, hi: number) => {
    for (let k = 0; k < 60 && (hi - lo) * speed > eps * 0.5; k++) {
      const mid = (lo + hi) / 2;
      if (read(mid) < eps + slack) hi = mid; else lo = mid;
    }
    return lo <= stop ? lo : Infinity;
  };
  let t = 0, tOut = 0;
  for (let i = 0; i < 600 && t <= stop; i++) {
    const d = read(t);
    if (d < -inside) return cross(tOut, t);
    tOut = t;
    if (d >= graze) { t += d / speed; continue; }
    // Near a surface. Going in, a short step ahead is inside (and the surface between); sliding along the face it
    // is not (an edge's gradient cannot tell these apart: the corner of a box standing on a ledge reads as going
    // in). Then a step of at least `graze`, so a face slid along does not stall the trace; one that lands inside
    // has the surface between too. The short step first, or a hook's lip as thick as `graze` was stepped clean
    // through by a tab dropped onto it, the step landing on its underside (round 11's mixer).
    const near = t + Math.max(d, probe) / speed;
    if (read(near) < -inside) return cross(t, near);
    const ahead = Math.min(t + Math.max(d, graze) / speed, stop + graze / speed);
    if (read(ahead) < -inside) return cross(near, ahead);
    t = ahead;
  }
  return Infinity;
}

/**
 * How far back along the motion (a negative t) the point p, inside `field`, first comes out of it: steps as long as
 * the field reads, which inside cannot pass the surface. -Infinity when it is still inside by `limit`.
 */
function traceExit(field: Shape3, p: Vec3, inverse: boolean, m: Motion, speed: number, limit: number, eps: number, slack: number): number {
  const x: Vec3 = [0, 0, 0];
  let t = 0;
  for (let i = 0; i < 200 && -t <= limit; i++) {
    m.map(p, t, inverse, x);
    const d = field.dist(x[0], x[1], x[2]);
    if (d >= -(eps + slack)) return t;
    t -= Math.max(-d - slack, eps) / speed;
  }
  return -Infinity;
}

/**
 * Points on a shape's surface for the contact search: a lattice of `n` per side over `box`, the points within a
 * step and a half of the surface slid onto it (as clearance() seeds), kept when the slide reached it or came within
 * a twentieth of the step. `keep` culls lattice points that cannot meet the other part along the motion.
 */
function contactSeeds(s: Shape3, box: Bounds, n: number, keep: (x: number, y: number, z: number, near: number) => boolean): { p: Vec3; off: number }[] {
  const size = boundsSize(box);
  const longest = Math.max(size[0], size[1], size[2]);
  if (!(longest > 0)) return [];
  const step = longest / n, near = step * 1.5;
  const out: { p: Vec3; off: number }[] = [];
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil(size[k] / step)));
  for (let i = 0; i <= dims[0]; i++)
    for (let j = 0; j <= dims[1]; j++)
      for (let k = 0; k <= dims[2]; k++) {
        const x = box.min[0] + (size[0] * i) / dims[0], y = box.min[1] + (size[1] * j) / dims[1], z = box.min[2] + (size[2] * k) / dims[2];
        if (Math.abs(s.dist(x, y, z)) > near || !keep(x, y, z, near)) continue;
        const q = surfacePoint(s, x, y, z);
        const off = Math.abs(s.dist(q[0], q[1], q[2]));
        if (off <= step * 0.05) out.push({ p: q, off });
      }
  return out;
}

/** How far apart two boxes are: 0 when they meet. */
function boxGap(a: Bounds, b: Bounds): number {
  let sq = 0;
  for (let k = 0; k < 3; k++) { const g = Math.max(a.min[k] - b.max[k], b.min[k] - a.max[k], 0); sq += g * g; }
  return Math.sqrt(sq);
}

/**
 * The leaves of `s` placed where `s` puts them: down through hard unions and the moves, turns, joints, paints,
 * decals and anchors above a part (nodes that keep their child's surface), each placed by the maps on its own path,
 * since a mirror's two halves are one node under two transforms. Undefined past `cap` leaves, when the shape is read
 * whole. What the contact search reads a part at a time and seeds a small part at a time.
 */
function leafParts(s: Shape3, cap = 64): Shape3[] | undefined {
  const out: Shape3[] = [];
  type Map3 = (x: number, y: number, z: number) => Vec3;
  let over = false;
  const walk = (node: Shape3, depth: number, back: Map3[], fwd: Map3[]) => {
    if (over) return;
    if (depth > 48 || out.length >= cap) { over = true; return; }
    if (node.parts && !node.instanced) { for (const p of node.parts) walk(p, depth + 1, back, fwd); return; }
    const only = node.inner?.length === 1 ? node.inner[0] : undefined;
    if (only && !node.cut && node.unwarp && node.warp && (node.transform || node.joint)) { walk(only, depth + 1, [...back, node.unwarp], [node.warp, ...fwd]); return; }
    if (only && !node.cut && node.dist === only.dist) { walk(only, depth + 1, back, fwd); return; }
    if (isEmpty(node.bounds)) return;
    if (!back.length) { out.push(node); return; }
    const corners: Vec3[] = [];
    for (const x of [node.bounds.min[0], node.bounds.max[0]]) for (const y of [node.bounds.min[1], node.bounds.max[1]]) for (const z of [node.bounds.min[2], node.bounds.max[2]]) {
      let q: Vec3 = [x, y, z];
      for (const f of fwd) q = f(q[0], q[1], q[2]);
      corners.push(q);
    }
    const bounds: Bounds = { min: [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))) as Vec3, max: [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k]))) as Vec3 };
    const d = node.dist, h = node.hit;
    const pull = (x: number, y: number, z: number): Vec3 => { let q: Vec3 = [x, y, z]; for (const b of back) q = b(q[0], q[1], q[2]); return q; };
    out.push({ kind: "shape3", dist: (x, y, z) => { const q = pull(x, y, z); return d(q[0], q[1], q[2]); }, hit: (x, y, z) => { const q = pull(x, y, z); return h(q[0], q[1], q[2]); }, bounds, cost: node.cost, feature: node.feature });
  };
  walk(s, 0, [], []);
  return over ? undefined : out;
}

/**
 * The clearance from `part` to `on`, read a leaf of `on` at a time for the leaves whose boxes come within `margin`
 * of the part's, and capped at `margin`. A leaf farther than `margin` cannot make a reading under `margin`, so this
 * is the clearance to the whole wherever that is under `margin`, and the readings a contact search takes are all
 * near zero. Read whole, a union's clearance walks down from its best seed only, which for a book that slides along
 * the shelf it stands on is the shelf: a corner 3.5e-5 into the neighbour it slid against read +2.5e-7 (round 11's
 * bookcase, measured). Read a leaf at a time, each touch is walked on its own, and the lattices are over the leaves'
 * boxes, not the row's. Counts each reading in `count`.
 */
function clearanceNear(part: Shape3, on: Shape3, leaves: Shape3[] | undefined, margin: number, count: { n: number }): { d: number; at?: Vec3; leaf?: Shape3 } {
  if (!leaves) { count.n++; return { ...clearanceAt(part, on), leaf: on }; }
  let best: { d: number; at?: Vec3; leaf?: Shape3 } = { d: margin };
  for (const leaf of leaves) {
    if (boxGap(leaf.bounds, part.bounds) > margin) continue;
    count.n++;
    const r = clearanceAt(part, leaf);
    if (r.d < best.d) best = { ...r, leaf };
  }
  return best;
}

/**
 * The leaves of `s` too small for a lattice of `step` to seed: narrower than two steps across two sides of their box
 * (a tab, a lip, a peg, a rod; a board or a book is thin one way only, and its faces are met), or carrying a feature
 * that thin (a tube, a thin wall). A bowl 2.3 across seeds every 0.19, and its two tabs, 0.045 tall, lock under hooks
 * whose lips overlap them by 0.055 in plan: dropped onto the plate and the hooks together, it fell through the lips,
 * no seed on either (round 11's mixer). At most 32.
 */
function smallParts(leaves: Shape3[] | undefined, step: number): Shape3[] {
  return (leaves ?? []).filter((u) => { const size = boundsSize(u.bounds).sort((a, b) => a - b); return size[1] < 2 * step || (u.feature ?? Infinity) < 2 * step; }).slice(0, 32);
}

/**
 * The first contact of `part` with `on` along the motion, for t from 0 to `limit`: the part's surface points traced
 * through `on`'s field and `on`'s traced back through the part's, the earliest meeting taken, then tightened on
 * clearance(): a lattice can put no point on the corner that meets first (a box tilted onto a board went 0.0046
 * too far), and clearance() reads that overshoot as a negative gap, which brackets the contact for a search on it.
 * Touching is a clearance within a ten-millionth of the part's size of zero either way (a box standing on the ledge
 * it slides along reads -3e-17 there the whole way), and the search ends on the near side of the contact, within a
 * millionth of the part's size of motion. The search follows the leaf of `on` the part is pressed into, so a leaf it
 * only slides along, which reads zero all the way, cannot pass for the contact. A part that starts inside `on` is
 * first backed out against the motion to the first place it is clear, and that is the contact.
 */
function firstContact(part: Shape3, on: Shape3, onLeaves: Shape3[] | undefined, m: Motion, limit: number, onBox: Bounds, keepPart: (x: number, y: number, z: number, near: number) => boolean, keepOn: (x: number, y: number, z: number, near: number) => boolean, speedOf: (p: Vec3) => number, start: { gap: number; leaf?: Shape3 }): Contact | NoContact {
  const scale = Math.max(1e-6, ...boundsSize(part.bounds));
  const tol = scale * 1e-6;
  const eps = scale * 1e-7;
  const count = { n: 0 };
  const margin = scale * 0.05;
  // The part at t, kept, so a second reading at the same t (one leaf's, after all of them) is the clearance's memo.
  const placedAt = new Map<number, Shape3>();
  const at = (t: number): Shape3 => { let p = placedAt.get(t); if (!p) { p = m.place(t); placedAt.set(t, p); } return p; };
  const readAt = (t: number) => clearanceNear(at(t), on, onLeaves, margin, count);
  const leafAt = (t: number, leaf: Shape3): number => { count.n++; return clearanceAt(at(t), leaf).d; };
  // clearance()'s own reading of a touch: -3e-17 for a face on the ledge it slides along, -5e-8 for an edge's
  // point that its walk left that far off the surface.
  const touch = scale * 1e-7;
  const clear = (c: number) => c >= -touch;
  const n = 12;
  const graze = scale / n / 4;
  // How far a gap g is from closing at the least: no point of the part moves faster than maxSpeed.
  const floor = (g: number) => Math.max(g, tol) / m.maxSpeed;
  const done = (t: number, c: number): Contact => ({ shape: at(t), amount: t, gap: c, backed: t < 0, lifted: 0, readings: count.n });
  // The boundary between a clear parameter and one inside, to within tol of motion, on the clearance to `key`, the
  // leaf the part is inside at `inT`: regula falsi, nearly linear near a contact, aimed at half of tol so the guess
  // that lands is clear and close enough, the Illinois rule halving the stale end's reading when one end keeps
  // moving, so a bent curve (a displaced frog's toes on its pad) converges in a few readings rather than bisecting
  // down. A guess inside another leaf follows that one instead.
  const settle = (clearT: number, inT: number, inC: number, key: Shape3 | undefined): Contact => {
    const keyed = (t: number, all: number) => (key && key !== on ? leafAt(t, key) : all);
    let clearC = keyed(clearT, Infinity);
    if (!Number.isFinite(clearC)) clearC = readAt(clearT).d;
    if (clearC <= tol) return done(clearT, clearC);
    const aim = tol * 0.5;
    let fa = clearC - aim, fb = inC - aim, side = 0;
    for (let i = 0; i < 40 && Math.abs(inT - clearT) * m.maxSpeed > tol; i++) {
      let mid = (clearT * fb - inT * fa) / (fb - fa);
      if (!(Number.isFinite(mid) && (mid - clearT) * (mid - inT) < 0)) mid = (clearT + inT) / 2;
      const r = readAt(mid);
      if (!clear(r.d)) {
        if (r.leaf && r.leaf !== key) { key = r.leaf; fa = keyed(clearT, Infinity) - aim; side = 0; }
        inT = mid; fb = r.d - aim;
        if (side < 0) fa *= 0.5;
        side = -1;
        continue;
      }
      const c = keyed(mid, r.d);
      // Clear, and within tol of touching what it was pressed into, is the contact, whatever the bracket's width.
      if (c <= tol) return done(mid, c);
      clearT = mid; fa = c - aim;
      if (side > 0) fb *= 0.5;
      side = 1;
    }
    return done(clearT, keyed(clearT, readAt(clearT).d));
  };
  // Points on both surfaces, each with the time it cannot meet the other surface before: its reading over its speed.
  type Seed = { p: Vec3; off: number; inverse: boolean; lb: number; speed: number; step: number };
  const seeds: Seed[] = [];
  const add = (p: Vec3, off: number, inverse: boolean, step: number, out: Seed[]) => {
    const sp = speedOf(p);
    if (sp > 0) out.push({ p, off, inverse, lb: ((inverse ? part : on).dist(p[0], p[1], p[2]) - off) / sp, speed: sp, step });
  };
  const partStep = Math.max(...boundsSize(part.bounds)) / n, onStep = isEmpty(onBox) ? 0 : Math.max(...boundsSize(onBox)) / n;
  for (const { p, off } of contactSeeds(part, part.bounds, n, keepPart)) add(p, off, false, partStep, seeds);
  if (!isEmpty(onBox)) for (const { p, off } of contactSeeds(on, onBox, n, keepOn)) add(p, off, true, onStep, seeds);
  // Each small part seeded at its own scale, on both sides: a tab, a hook's lip, a rail. A point of one that lies
  // inside the rest of its shape meets the other surface no sooner than the shape's surface does, so it is harmless.
  const fine = 8;
  for (const u of smallParts(leafParts(part), partStep)) {
    const st = Math.max(...boundsSize(u.bounds)) / fine;
    for (const { p, off } of contactSeeds(u, u.bounds, fine, keepPart)) add(p, Math.max(off, Math.abs(part.dist(p[0], p[1], p[2]))), false, st, seeds);
  }
  if (!isEmpty(onBox))
    for (const u of smallParts(onLeaves, onStep)) {
      const box = intersectBoxes(u.bounds, onBox);
      if (isEmpty(box)) continue;
      const st = Math.max(...boundsSize(box)) / fine;
      for (const { p, off } of contactSeeds(u, box, fine, keepOn)) add(p, Math.max(off, Math.abs(on.dist(p[0], p[1], p[2]))), true, st, seeds);
    }
  if (!clear(start.gap)) {
    // Started inside: back out against the motion. Every seed inside the other surface has at least as far to go as
    // its own way out, so the farthest of those is where to look first. Then steps of the depth over the fastest
    // point's speed: a move back shorter than the depth leaves the part inside (every point inside has that far to
    // go to the surface, and the first clear place is no nearer), so they never pass it. Once clear, settle between.
    let inT = 0, inC = start.gap, key = start.leaf;
    let out = 0;
    for (const sd of seeds) if (sd.lb * sd.speed < -(eps + sd.off)) out = Math.min(out, traceExit(sd.inverse ? part : on, sd.p, sd.inverse, m, sd.speed, limit, eps, sd.off));
    const tryAt = (t: number): Contact | undefined => {
      const r = readAt(t);
      if (clear(r.d)) return settle(t, inT, inC, key);
      inT = t; inC = r.d; key = r.leaf ?? key;
      return undefined;
    };
    if (out < 0 && Number.isFinite(out)) { const r = tryAt(out); if (r) return r; }
    for (let i = 0; i < 64; i++) {
      const t = inT - floor(-inC) * (i < 16 ? 1 : 2 ** (i - 15));
      if (-t > limit) return { reach: -limit, inside: -start.gap };
      const r = tryAt(t);
      if (r) return r;
    }
    return { reach: inT, inside: -start.gap };
  }
  // The coarse search: every seed traced along the motion, the nearest first, each stopping at the best so far.
  seeds.sort((a, b) => a.lb - b.lb);
  let best = Infinity;
  const hits: { t: number; s: Seed }[] = [];
  const traceAll = (list: Seed[]) => {
    for (const s of list) {
      if (s.lb > best) break;
      const t = traceContact(s.inverse ? part : on, s.p, s.inverse, m, s.speed, limit, best, eps, graze, s.off);
      if (Number.isFinite(t)) hits.push({ t, s });
      if (t < best) best = t;
    }
  };
  traceAll(seeds);
  // The lattice can put no seed on the corner that meets first: around the few earliest meetings, finer seeds, a
  // quarter of the spacing apart and then a sixteenth, slid onto their surface and traced the same way. A trace is
  // a few dozen readings of a field and a clearance tens of thousands, so this is what keeps the clearance readings
  // that follow to one or two.
  for (const frac of [0.25, 0.0625]) {
    if (!Number.isFinite(best)) break;
    hits.sort((a, b) => a.t - b.t);
    const around = hits.slice(0, 4).map((h) => h.s);
    const finer: Seed[] = [];
    for (const c of around) {
      const h = c.step * frac * 2, shape = c.inverse ? on : part;
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++)
          for (let k = -2; k <= 2; k++) {
            if (i === 0 && j === 0 && k === 0) continue;
            const q = surfacePoint(shape, c.p[0] + (i * h) / 2, c.p[1] + (j * h) / 2, c.p[2] + (k * h) / 2);
            const off = Math.abs(shape.dist(q[0], q[1], q[2]));
            if (off <= c.step * 0.05) add(q, off, c.inverse, c.step * frac, finer);
          }
    }
    finer.sort((a, b) => a.lb - b.lb);
    traceAll(finer);
  }
  let clearT = 0, clearC = start.gap;
  // The seeds found nothing (a contact narrower than their spacing, or none): conservative advancement on the
  // clearance alone, a few steps, each no longer than the gap can close in.
  if (!Number.isFinite(best)) {
    if (!(clearC > tol)) clearC = readAt(0).d;
    for (let i = 0; i < 24; i++) {
      const t = clearT + floor(clearC);
      if (t > limit) break;
      const r = readAt(t);
      if (!clear(r.d)) return settle(clearT, t, r.d, r.leaf);
      if (r.d <= tol) return done(t, r.d);
      clearT = t; clearC = r.d;
    }
    return { reach: limit };
  }
  // A traced contact is a point of one surface met by the other, so the part there is no farther from touching
  // than the trace's own slack: clear there is the contact. A gap left (a contact the clearance reads wider than
  // the trace) is closed by advancing on the clearance.
  let t = best, r = readAt(t);
  for (let i = 0; i < 24 && r.d > tol; i++) {
    clearT = t;
    t += floor(r.d);
    if (t > limit) return { reach: limit };
    r = readAt(t);
  }
  if (clear(r.d)) return r.d <= tol ? done(t, r.d) : { reach: limit };
  // Past the contact, by at least the depth over the fastest speed, and by that over the cosine of the contact's
  // slant to the motion: step back twice the depth, doubling, until clear, then settle between on the leaf the
  // part is inside.
  let inT = t, inC = r.d, key = r.leaf;
  for (let i = 0; i < 24; i++) {
    const back = inT - floor(-inC) * 2 ** (i + 1);
    if (back <= clearT) break;
    const rb = readAt(back);
    if (clear(rb.d)) { clearT = back; break; }
    inT = back; inC = rb.d; key = rb.leaf ?? key;
  }
  return settle(clearT, inT, inC, key);
}

/** The box `b` moved by t along `d`. */
function boxAlong(b: Bounds, d: Vec3, t: number): Bounds {
  return { min: [b.min[0] + d[0] * t, b.min[1] + d[1] * t, b.min[2] + d[2] * t], max: [b.max[0] + d[0] * t, b.max[1] + d[1] * t, b.max[2] + d[2] * t] };
}

/** Whether the ray from p along d meets box b grown by `grow` on every side. */
function rayMeetsBox(p: Vec3, d: Vec3, b: Bounds, grow: number): boolean {
  let lo = -Infinity, hi = Infinity;
  for (let k = 0; k < 3; k++) {
    const mn = b.min[k] - grow, mx = b.max[k] + grow;
    if (Math.abs(d[k]) < 1e-12) { if (p[k] < mn || p[k] > mx) return false; continue; }
    const t1 = (mn - p[k]) / d[k], t2 = (mx - p[k]) / d[k];
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
  }
  return hi >= Math.max(lo, 0);
}

function intersectBoxes(a: Bounds, b: Bounds): Bounds {
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    min[k] = Math.max(a.min[k], b.min[k]);
    max[k] = Math.min(a.max[k], b.max[k]);
    if (min[k] > max[k]) return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  }
  return { min, max };
}

/**
 * A part sunk into `on` by a sliver, lifted out of it: ground() finds the lowest point by rays that stop within
 * 2e-5 of the part's size of the surface, which left a book turned 18 degrees 4.5e-5 into the shelf it then had to
 * slide along (round 11's bookcase), and backing it out along the slide never frees it. Each reading's deepest
 * point is pushed out along the normal of the surface it is inside, up to four times. A deeper overlap, or none,
 * leaves the part as it is.
 */
function liftSliver(part: Shape3, on: Shape3, leaves: Shape3[] | undefined, touch: number, sliver: number): { part: Shape3; lifted: number; gap: number; leaf?: Shape3; reads: number } {
  let p = part, lifted = 0, gap = Infinity;
  let leaf: Shape3 | undefined;
  const count = { n: 0 };
  const g: Vec3 = [0, 0, 0];
  const e = Math.max(touch, 1e-9);
  for (let i = 0; i < 5; i++) {
    // What the part is in or touches has a box that meets its box, so this reading of the nearby leaves is the
    // clearance's sign, and when negative its value: the contact search starts from it.
    const c = clearanceNear(p, on, leaves, sliver * 10, count);
    gap = c.d; leaf = c.leaf;
    if (i === 4 || !(c.d < -touch) || -c.d > sliver || !c.at) break;
    const at = c.at;
    // A point of the part inside `on` goes out along on's normal; a point of `on` inside the part, the part away from it.
    const inOn = on.dist(at[0], at[1], at[2]) < 0;
    const f = inOn ? on : p;
    g[0] = f.dist(at[0] + e, at[1], at[2]) - f.dist(at[0] - e, at[1], at[2]);
    g[1] = f.dist(at[0], at[1] + e, at[2]) - f.dist(at[0], at[1] - e, at[2]);
    g[2] = f.dist(at[0], at[1], at[2] + e) - f.dist(at[0], at[1], at[2] - e);
    const gl = Math.hypot(g[0], g[1], g[2]);
    if (!(gl > 0)) break;
    const k = ((inOn ? 1 : -1) * (-c.d + touch)) / gl;
    p = move(p, g[0] * k, g[1] * k, g[2] * k);
    lifted = Math.max(lifted, -c.d);
  }
  return { part: p, lifted, gap, leaf, reads: count.n };
}

/**
 * Move `part` along the unit direction `dir` until it touches `on`, then `sink` further: what a bowl on its plate
 * or a book on its shelf needs, without the arithmetic. A part that starts inside `on` is backed out against `dir`
 * to the first place it is clear (so a part built at the origin can be rested onto a shelf above it). The move
 * stops on the near side of the contact, at most a millionth of the part's size clear.
 */
export function restOn(part: Shape3, on: Shape3, dir: Vec3, sink = 0): Contact | NoContact {
  if (isEmpty(part.bounds) || isEmpty(on.bounds)) return { reach: 0 };
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  const d: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  const size = Math.max(1e-6, ...boundsSize(part.bounds));
  const leaves = leafParts(on);
  const start = liftSliver(part, on, leaves, size * 1e-7, size * 1e-4);
  part = start.part;
  // Far enough that the part's box has passed the whole of on's along d, and back as far for a part inside it.
  const proj = (b: Bounds, sign: number) => {
    let best = -Infinity;
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) best = Math.max(best, sign * (x * d[0] + y * d[1] + z * d[2]));
    return best;
  };
  const limit = Math.max(0, proj(on.bounds, 1) + proj(part.bounds, -1)) + Math.max(...boundsSize(part.bounds)) * 1e-3;
  const m: Motion = {
    place: (t) => (t === 0 ? part : move(part, d[0] * t, d[1] * t, d[2] * t)),
    map: (p, t, inverse, out) => { const s = inverse ? -t : t; out[0] = p[0] + d[0] * s; out[1] = p[1] + d[1] * s; out[2] = p[2] + d[2] * s; },
    maxSpeed: 1,
  };
  const swept = boundsUnion(part.bounds, boxAlong(part.bounds, d, limit));
  const back: Vec3 = [-d[0], -d[1], -d[2]];
  const r = firstContact(part, on, leaves, m, limit, intersectBoxes(on.bounds, swept),
    (x, y, z, near) => rayMeetsBox([x, y, z], d, on.bounds, near),
    (x, y, z, near) => rayMeetsBox([x, y, z], back, part.bounds, near),
    () => 1, start);
  if (!r.shape) return r;
  const lifted = start.lifted, readings = r.readings + start.reads;
  if (sink === 0) return { ...r, lifted, readings };
  return { ...r, lifted, readings, shape: move(part, d[0] * (r.amount + sink), d[1] * (r.amount + sink), d[2] * (r.amount + sink)) };
}

/**
 * Turn `part` about the line through `pivot` along `axis`, the right-handed way (as rotate() turns about x, y or
 * z), until it touches `on`: a book leaned against its neighbour. Up to 180 degrees; a part that starts inside `on`
 * is turned back the other way to the first angle it is clear.
 */
export function leanOn(part: Shape3, on: Shape3, pivot: Vec3, axis: Vec3): Contact | NoContact {
  if (isEmpty(part.bounds) || isEmpty(on.bounds)) return { reach: 0 };
  const al = Math.hypot(axis[0], axis[1], axis[2]);
  const u: Vec3 = [axis[0] / al, axis[1] / al, axis[2] / al];
  const size = Math.max(1e-6, ...boundsSize(part.bounds));
  const leaves = leafParts(on);
  const start = liftSliver(part, on, leaves, size * 1e-7, size * 1e-4);
  part = start.part;
  const [cx, cy, cz] = pivot;
  // The farthest the part's box reaches from the axis: the fastest point's radius.
  let radius = 0, reach = 0;
  for (const x of [part.bounds.min[0], part.bounds.max[0]]) for (const y of [part.bounds.min[1], part.bounds.max[1]]) for (const z of [part.bounds.min[2], part.bounds.max[2]]) {
    const px = x - cx, py = y - cy, pz = z - cz;
    const a = px * u[0] + py * u[1] + pz * u[2];
    radius = Math.max(radius, Math.hypot(px - a * u[0], py - a * u[1], pz - a * u[2]));
    reach = Math.max(reach, Math.hypot(px, py, pz));
  }
  const rot = (deg: number, p: Vec3, out: Vec3) => {
    const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG), k = 1 - c;
    const px = p[0] - cx, py = p[1] - cy, pz = p[2] - cz;
    const dt = (u[0] * px + u[1] * py + u[2] * pz) * k;
    // Rodrigues: v cos + (u x v) sin + u (u . v)(1 - cos).
    out[0] = cx + px * c + (u[1] * pz - u[2] * py) * s + u[0] * dt;
    out[1] = cy + py * c + (u[2] * px - u[0] * pz) * s + u[1] * dt;
    out[2] = cz + pz * c + (u[0] * py - u[1] * px) * s + u[2] * dt;
  };
  const m: Motion = {
    place: (t) => (t === 0 ? part : move(rotateBy(move(part, -cx, -cy, -cz), rotAxis(u, t)), cx, cy, cz)),
    map: (p, t, inverse, out) => rot(inverse ? -t : t, p, out),
    maxSpeed: Math.max(radius, 1e-9) * DEG,
  };
  const speedOf = (p: Vec3) => {
    const px = p[0] - cx, py = p[1] - cy, pz = p[2] - cz;
    return Math.hypot(u[1] * pz - u[2] * py, u[2] * px - u[0] * pz, u[0] * py - u[1] * px) * DEG;
  };
  // Every point the turning part can reach lies within `reach` of the pivot.
  const around: Bounds = { min: [cx - reach, cy - reach, cz - reach], max: [cx + reach, cy + reach, cz + reach] };
  const near = (b: Bounds, x: number, y: number, z: number, g: number) => {
    // A point whose circle about the axis stays farther from the box than g cannot meet it: its distance from the
    // pivot is kept, so a box wholly nearer or farther than that misses.
    const r = Math.hypot(x - cx, y - cy, z - cz);
    let lo = 0, hi = 0;
    for (let k = 0; k < 3; k++) {
      const c = [cx, cy, cz][k];
      const dmin = Math.max(b.min[k] - g - c, 0, c - b.max[k] - g);
      const dmax = Math.max(Math.abs(b.min[k] - g - c), Math.abs(b.max[k] + g - c));
      lo += dmin * dmin; hi += dmax * dmax;
    }
    return r >= Math.sqrt(lo) && r <= Math.sqrt(hi);
  };
  const r = firstContact(part, on, leaves, m, 180, intersectBoxes(on.bounds, around),
    (x, y, z, g) => near(on.bounds, x, y, z, g),
    (x, y, z, g) => near(part.bounds, x, y, z, g),
    speedOf, start);
  return r.shape ? { ...r, lifted: start.lifted, readings: r.readings + start.reads } : r;
}
