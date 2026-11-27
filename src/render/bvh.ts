/**
 * A bounding volume hierarchy over the extracted mesh's triangles, for the beauty render's secondary rays. The field
 * is the model at full sharpness and every hit the renderer shades is confirmed on it (rays.ts); the mesh only tells
 * a ray where, far from where it started, it is worth marching the field, for the cost of a dozen box tests and a few
 * triangles instead of dozens of field evaluations.
 *
 * Built once per mesh in flat typed arrays, which may live in SharedArrayBuffers so workers read them without a copy:
 * binned surface-area heuristic over 12 bins, at most four triangles a leaf, children stored side by side. The
 * triangles are reordered into the leaves as a vertex and two edges each (nine floats), so a leaf's triangles are read
 * in order. Each triangle carries a glass flag (its material lets light through) and each node says whether its
 * subtree holds opaque triangles, glass ones or both, so a shadow ray can skip glass and a glass query can skip the
 * rest.
 *
 * Deterministic: the build is a pure function of the mesh (ties broken by index), and a closest hit cannot depend on
 * the order the traversal meets triangles: equal distances go to the lower triangle index of the mesh. Traversal is
 * iterative over a preallocated stack and allocates nothing.
 */
import type { Mesh } from "../mesh/mesh.js";

const LEAF = 4;
const BINS = 12;

/** Node flags: the subtree holds at least one opaque triangle, at least one glass triangle. */
export const NODE_OPAQUE = 1;
export const NODE_GLASS = 2;

/** Which triangles a query sees. */
export const ALL = NODE_OPAQUE | NODE_GLASS;
export const OPAQUE = NODE_OPAQUE;
export const GLASS = NODE_GLASS;

export interface BvhData {
  /** Six floats per node: min x, y, z, max x, y, z. */
  bounds: Float32Array;
  /** Per node: for an inner node the index of its first child (the second follows it); for a leaf its first triangle. */
  first: Int32Array;
  /** Per node: triangles in a leaf, 0 for an inner node. */
  count: Int32Array;
  /** Per node: NODE_OPAQUE and NODE_GLASS for what its subtree holds. */
  flags: Uint8Array;
  /** Nine floats per triangle in leaf order: a vertex and the two edges from it. */
  tri: Float32Array;
  /** The mesh's own index of each triangle in leaf order. */
  triId: Int32Array;
  /** Per triangle in leaf order: 1 when its material lets light through (two of its three vertices' materials do). */
  glass: Uint8Array;
  nodes: number;
  /** The deepest leaf's depth (the root is 0): a tracer's stack needs one more entry than this. */
  depth: number;
  /** Some triangle is glass. */
  anyGlass: boolean;
}

/** A triangle's material lets light through: two of its three vertices' materials do. */
export function triangleIsGlass(mesh: Mesh, t: number): boolean {
  const I = mesh.indices, M = mesh.materialIndex, mats = mesh.materials;
  let n = 0;
  for (let k = 0; k < 3; k++) if (mats[M[I[t * 3 + k]]].transmit > 0) n++;
  return n >= 2;
}

/** Build over a mesh's triangles. `shared` puts every array in a SharedArrayBuffer, for workers. */
export function buildBvh(mesh: Mesh, shared = false): BvhData {
  const P = mesh.positions, I = mesh.indices;
  const n = I.length / 3;
  const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
  const bmin = new Float32Array(n * 3), bmax = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(P[a + k], P[b + k], P[c + k]), hi = Math.max(P[a + k], P[b + k], P[c + k]);
      bmin[t * 3 + k] = lo; bmax[t * 3 + k] = hi;
    }
    cx[t] = (bmin[t * 3] + bmax[t * 3]) * 0.5; cy[t] = (bmin[t * 3 + 1] + bmax[t * 3 + 1]) * 0.5; cz[t] = (bmin[t * 3 + 2] + bmax[t * 3 + 2]) * 0.5;
  }
  const isGlass = new Uint8Array(n);
  let anyGlass = false;
  for (let t = 0; t < n; t++) if (triangleIsGlass(mesh, t)) { isGlass[t] = 1; anyGlass = true; }
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const maxNodes = Math.max(1, 2 * n);
  const bounds = new Float32Array(maxNodes * 6);
  const first = new Int32Array(maxNodes), count = new Int32Array(maxNodes), parent = new Int32Array(maxNodes);
  const nodeDepth = new Int32Array(maxNodes);
  parent[0] = -1;
  let nodes = 1, depth = 0;
  // An explicit work list: node index, range start, range end.
  const work: number[] = [0, 0, n];
  const binCount = new Int32Array(BINS * 3);
  const binMin = new Float64Array(BINS * 9), binMax = new Float64Array(BINS * 9);
  const leftArea = new Float64Array(BINS), leftCount = new Int32Array(BINS);
  const cent = [cx, cy, cz];
  while (work.length) {
    const end = work.pop()!, start = work.pop()!, node = work.pop()!;
    if (nodeDepth[node] > depth) depth = nodeDepth[node];
    // The node's box and its centroids' box.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let c0x = Infinity, c0y = Infinity, c0z = Infinity, c1x = -Infinity, c1y = -Infinity, c1z = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i];
      if (bmin[t * 3] < x0) x0 = bmin[t * 3]; if (bmin[t * 3 + 1] < y0) y0 = bmin[t * 3 + 1]; if (bmin[t * 3 + 2] < z0) z0 = bmin[t * 3 + 2];
      if (bmax[t * 3] > x1) x1 = bmax[t * 3]; if (bmax[t * 3 + 1] > y1) y1 = bmax[t * 3 + 1]; if (bmax[t * 3 + 2] > z1) z1 = bmax[t * 3 + 2];
      if (cx[t] < c0x) c0x = cx[t]; if (cy[t] < c0y) c0y = cy[t]; if (cz[t] < c0z) c0z = cz[t];
      if (cx[t] > c1x) c1x = cx[t]; if (cy[t] > c1y) c1y = cy[t]; if (cz[t] > c1z) c1z = cz[t];
    }
    bounds[node * 6] = x0; bounds[node * 6 + 1] = y0; bounds[node * 6 + 2] = z0;
    bounds[node * 6 + 3] = x1; bounds[node * 6 + 4] = y1; bounds[node * 6 + 5] = z1;
    const m = end - start;
    if (m <= LEAF) { first[node] = start; count[node] = m; continue; }
    // Binned SAH on each axis; the cheapest split wins (axis order breaks ties). One pass bins every axis.
    let bestCost = Infinity, bestAxis = -1, bestBin = -1;
    const ex = c1x - c0x, ey = c1y - c0y, ez = c1z - c0z;
    const sx = ex > 1e-12 ? BINS / ex : 0, sy = ey > 1e-12 ? BINS / ey : 0, sz = ez > 1e-12 ? BINS / ez : 0;
    binCount.fill(0); binMin.fill(Infinity); binMax.fill(-Infinity);
    for (let i = start; i < end; i++) {
      const t = order[i], t3 = t * 3;
      const x0 = bmin[t3], y0 = bmin[t3 + 1], z0 = bmin[t3 + 2], x1 = bmax[t3], y1 = bmax[t3 + 1], z1 = bmax[t3 + 2];
      for (let axis = 0; axis < 3; axis++) {
        const sc = axis === 0 ? sx : axis === 1 ? sy : sz;
        if (sc === 0) continue;
        const cc = axis === 0 ? cx[t] - c0x : axis === 1 ? cy[t] - c0y : cz[t] - c0z;
        const b = axis * BINS + Math.min(BINS - 1, Math.floor(cc * sc));
        binCount[b]++;
        const o = b * 3;
        if (x0 < binMin[o]) binMin[o] = x0;
        if (y0 < binMin[o + 1]) binMin[o + 1] = y0;
        if (z0 < binMin[o + 2]) binMin[o + 2] = z0;
        if (x1 > binMax[o]) binMax[o] = x1;
        if (y1 > binMax[o + 1]) binMax[o + 1] = y1;
        if (z1 > binMax[o + 2]) binMax[o + 2] = z1;
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      if ((axis === 0 ? sx : axis === 1 ? sy : sz) === 0) continue;
      const base = axis * BINS;
      // Sweep from the left, then from the right.
      let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity, cnt = 0;
      for (let b = 0; b < BINS - 1; b++) {
        const o = (base + b) * 3;
        if (binCount[base + b]) {
          ax0 = Math.min(ax0, binMin[o]); ay0 = Math.min(ay0, binMin[o + 1]); az0 = Math.min(az0, binMin[o + 2]);
          ax1 = Math.max(ax1, binMax[o]); ay1 = Math.max(ay1, binMax[o + 1]); az1 = Math.max(az1, binMax[o + 2]);
        }
        cnt += binCount[base + b];
        leftCount[b] = cnt;
        const dx = ax1 - ax0, dy = ay1 - ay0, dz = az1 - az0;
        leftArea[b] = cnt ? dx * dy + dy * dz + dz * dx : 0;
      }
      ax0 = Infinity; ay0 = Infinity; az0 = Infinity; ax1 = -Infinity; ay1 = -Infinity; az1 = -Infinity; cnt = 0;
      for (let b = BINS - 1; b > 0; b--) {
        const o = (base + b) * 3;
        if (binCount[base + b]) {
          ax0 = Math.min(ax0, binMin[o]); ay0 = Math.min(ay0, binMin[o + 1]); az0 = Math.min(az0, binMin[o + 2]);
          ax1 = Math.max(ax1, binMax[o]); ay1 = Math.max(ay1, binMax[o + 1]); az1 = Math.max(az1, binMax[o + 2]);
        }
        cnt += binCount[base + b];
        const dx = ax1 - ax0, dy = ay1 - ay0, dz = az1 - az0;
        const rightArea = cnt ? dx * dy + dy * dz + dz * dx : 0;
        const left = leftCount[b - 1];
        if (!left || !cnt) continue;
        const cost = leftArea[b - 1] * left + rightArea * cnt;
        if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestBin = b; }
      }
    }
    const lo = [c0x, c0y, c0z], hi = [c1x, c1y, c1z];
    let mid: number;
    if (bestAxis < 0) {
      // Every centroid in one place: split the range in half.
      mid = start + (m >> 1);
    } else {
      const c = cent[bestAxis], l = lo[bestAxis], scale = BINS / (hi[bestAxis] - l);
      let i = start, j = end - 1;
      while (i <= j) {
        const b = Math.min(BINS - 1, Math.floor((c[order[i]] - l) * scale));
        if (b < bestBin) i++;
        else { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--; }
      }
      mid = i;
      if (mid === start || mid === end) mid = start + (m >> 1);
    }
    const left = nodes;
    nodes += 2;
    first[node] = left; count[node] = 0;
    parent[left] = node; parent[left + 1] = node;
    nodeDepth[left] = nodeDepth[left + 1] = nodeDepth[node] + 1;
    work.push(left + 1, mid, end, left, start, mid);
  }
  const alloc = (len: number, bytes: number) => (shared ? new SharedArrayBuffer(len * bytes) : new ArrayBuffer(len * bytes));
  // Every box grown by four float32 steps of the largest coordinate: a ray through a vertex on a box's face, or a
  // hit at the very distance a box is entered, is never lost to rounding, so ties reach the tie rule.
  let big = 0;
  for (let k = 0; k < P.length; k++) big = Math.max(big, Math.abs(P[k]));
  const pad = big * 4.8e-7 + 1e-30;
  const outBounds = new Float32Array(alloc(nodes * 6, 4));
  for (let k = 0; k < nodes * 6; k++) outBounds[k] = k % 6 < 3 ? bounds[k] - pad : bounds[k] + pad;
  const outFirst = new Int32Array(alloc(nodes, 4)); outFirst.set(first.subarray(0, nodes));
  const outCount = new Int32Array(alloc(nodes, 4)); outCount.set(count.subarray(0, nodes));
  const flags = new Uint8Array(alloc(nodes, 1));
  const tri = new Float32Array(alloc(n * 9, 4));
  const triId = new Int32Array(alloc(n, 4));
  const glass = new Uint8Array(alloc(n, 1));
  for (let i = 0; i < n; i++) {
    const t = order[i];
    triId[i] = t;
    glass[i] = isGlass[t];
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    tri[i * 9] = P[a]; tri[i * 9 + 1] = P[a + 1]; tri[i * 9 + 2] = P[a + 2];
    tri[i * 9 + 3] = P[b] - P[a]; tri[i * 9 + 4] = P[b + 1] - P[a + 1]; tri[i * 9 + 5] = P[b + 2] - P[a + 2];
    tri[i * 9 + 6] = P[c] - P[a]; tri[i * 9 + 7] = P[c + 1] - P[a + 1]; tri[i * 9 + 8] = P[c + 2] - P[a + 2];
  }
  // What each subtree holds: leaves from their triangles, then every parent from its children. A child always has a
  // larger index than its parent, so one pass from the last node up settles them.
  for (let node = nodes - 1; node >= 0; node--) {
    if (outCount[node] > 0) {
      let f = 0;
      for (let k = outFirst[node]; k < outFirst[node] + outCount[node]; k++) f |= glass[k] ? NODE_GLASS : NODE_OPAQUE;
      flags[node] |= f;
    }
    if (node > 0) flags[parent[node]] |= flags[node];
  }
  return { bounds: outBounds, first: outFirst, count: outCount, flags, tri, triId, glass, nodes, depth, anyGlass };
}

/**
 * The BVH a mesh's render uses: built once per mesh per run and kept in the run's cache (the pool package's
 * BeautyCache), so beauty.png, the camera shots and the strips of one run share it. `shared` builds it in
 * SharedArrayBuffers for the worker pool; a cached build that is not shared is replaced by one that is.
 */
export function bvhFor(mesh: Mesh, cache?: { bvh: WeakMap<Mesh, unknown> }, shared = false): BvhData {
  const had = cache?.bvh.get(mesh) as BvhData | undefined;
  if (had && (!shared || had.tri.buffer instanceof SharedArrayBuffer)) return had;
  const built = buildBvh(mesh, shared);
  cache?.bvh.set(mesh, built);
  return built;
}

/**
 * Where a ray enters node i's box, clamped to tmin, or Infinity when it misses the box or enters it beyond tmax
 * (slabs; a ray parallel to a slab gives infinities, which order correctly, or NaN from 0 times infinity when it
 * lies exactly on the slab's face, which no comparison takes, so the box is entered). Small enough that V8 inlines
 * it, so the number it returns is never boxed.
 */
function boxEntry(B: Float32Array, i: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tmin: number, tmax: number): number {
  const b = i * 6;
  let t0 = (B[b] - ox) * ix, t1 = (B[b + 3] - ox) * ix;
  let lo = t0 < t1 ? t0 : t1, hi = t0 < t1 ? t1 : t0;
  t0 = (B[b + 1] - oy) * iy; t1 = (B[b + 4] - oy) * iy;
  if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  t0 = (B[b + 2] - oz) * iz; t1 = (B[b + 5] - oz) * iz;
  if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  // NaN (a ray parallel to a face, exactly on it) reads as a hit on the box, so its triangles are still tested.
  if (lo > hi || hi < tmin || lo > tmax) return Infinity;
  return lo > tmin ? lo : tmin;
}

/**
 * Whether a box can hold a point of the cone with apex o, unit axis a and half angle atan(tanA) whose distance along
 * the axis lies in [s0, s1]. A cone point at distance s along the axis is within s tanA of the axis point there, so
 * the box grown on every side by tanA times the farthest its points reach along the axis must hold that axis point:
 * a slab test of the axis against the grown box. Never false for a box the cone meets.
 */
function coneMeetsBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ox: number, oy: number, oz: number, ax: number, ay: number, az: number, aax: number, aay: number, aaz: number, ix: number, iy: number, iz: number, tanA: number, s0: number, s1: number): boolean {
  const sMax = ((x0 + x1) * 0.5 - ox) * ax + ((y0 + y1) * 0.5 - oy) * ay + ((z0 + z1) * 0.5 - oz) * az + ((x1 - x0) * aax + (y1 - y0) * aay + (z1 - z0) * aaz) * 0.5;
  if (sMax < s0) return false;
  const g = sMax * tanA;
  let t0 = (x0 - g - ox) * ix, t1 = (x1 + g - ox) * ix;
  let lo = t0 < t1 ? t0 : t1, hi = t0 < t1 ? t1 : t0;
  t0 = (y0 - g - oy) * iy; t1 = (y1 + g - oy) * iy;
  if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  t0 = (z0 - g - oz) * iz; t1 = (z1 + g - oz) * iz;
  if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  // NaN (an axis parallel to a face of the grown box, exactly on it) reads as a meeting: never a false clear.
  return !(lo > hi || hi < s0 || lo > s1);
}

/**
 * Rays against a built BVH. One per thread: the stack, the ray and the last hit live on it.
 *
 * Nothing here allocates. V8 passes numbers to a call it does not inline as boxed heap numbers, so the traversals take
 * their ray from the `ray` register (a Float64Array) and leave their answer in `hit`, and return only small integers;
 * `closest()` and `occluded()` are the same calls with the ray as arguments, small enough to be inlined where they are
 * used.
 */
export class BvhTracer {
  /** The ray register: origin x, y, z, unit direction x, y, z, tmin, tmax; [8] a cone's half-angle tangent (coneClearRay). */
  readonly ray = new Float64Array(9);
  /** The last closest hit: its distance and the barycentric weights of its triangle's second and third vertices. */
  readonly hit = new Float64Array(3);
  /** The last closest hit's triangle: the mesh's index (-1 for none), and its place in leaf order (for its glass flag). */
  hitTri = -1;
  hitLeaf = -1;
  /** Rays traced and nodes visited, for the bench. */
  rays = 0;
  nodes = 0;
  private readonly stack: Int32Array;
  private readonly B: Float32Array;
  private readonly F: Int32Array;
  private readonly C: Int32Array;
  private readonly FL: Uint8Array;
  private readonly T: Float32Array;
  private readonly G: Uint8Array;
  private readonly ids: Int32Array;

  constructor(readonly data: BvhData) {
    this.B = data.bounds; this.F = data.first; this.C = data.count; this.FL = data.flags; this.T = data.tri; this.G = data.glass; this.ids = data.triId;
    this.stack = new Int32Array(Math.max(128, data.depth + 2));
  }

  /**
   * The nearest triangle along the ray register within (tmin, tmax) among those `which` selects (ALL, OPAQUE or
   * GLASS): the mesh's triangle index, or -1; `hit` gets its distance and barycentrics. Both faces count. Equal
   * distances go to the lower mesh index, so the answer is brute force's whatever order the boxes are met in.
   */
  closestRay(which = ALL): number {
    this.rays++;
    const R = this.ray;
    const ox = R[0], oy = R[1], oz = R[2], dx = R[3], dy = R[4], dz = R[5], tmin = R[6];
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const S = this.stack, B = this.B, F = this.F, C = this.C, T = this.T, FL = this.FL, G = this.G, ids = this.ids;
    const skipGlass = (which & NODE_GLASS) === 0, skipOpaque = (which & NODE_OPAQUE) === 0;
    let sp = 0, best = R[7], bestTri = -1, bestId = 0x7fffffff, bu = 0, bv = 0, visited = 0;
    this.hitTri = -1; this.hitLeaf = -1;
    if ((FL[0] & which) === 0 || boxEntry(B, 0, ox, oy, oz, ix, iy, iz, tmin, best) === Infinity) return -1;
    S[sp++] = 0;
    while (sp > 0) {
      const node = S[--sp];
      visited++;
      const cnt = C[node];
      if (cnt > 0) {
        const f = F[node];
        for (let k = f; k < f + cnt; k++) {
          if (G[k] ? skipGlass : skipOpaque) continue;
          const o = k * 9;
          const e1x = T[o + 3], e1y = T[o + 4], e1z = T[o + 5], e2x = T[o + 6], e2y = T[o + 7], e2z = T[o + 8];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-12 && det < 1e-12) continue;
          const inv = 1 / det;
          const sx = ox - T[o], sy = oy - T[o + 1], sz = oz - T[o + 2];
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > tmin && (t < best || (t === best && bestTri >= 0 && ids[k] < bestId))) { best = t; bestTri = k; bestId = ids[k]; bu = u; bv = v; }
        }
        continue;
      }
      // The children this query sees whose boxes the ray enters before the best hit so far, the nearer on top of the
      // stack; at a tie the first child goes first, and the tie rule above keeps the answer independent of the order.
      const l = F[node], r = l + 1;
      const tl = FL[l] & which ? boxEntry(B, l, ox, oy, oz, ix, iy, iz, tmin, best) : Infinity;
      const tr = FL[r] & which ? boxEntry(B, r, ox, oy, oz, ix, iy, iz, tmin, best) : Infinity;
      if (tl <= tr) {
        if (tr !== Infinity) S[sp++] = r;
        if (tl !== Infinity) S[sp++] = l;
      } else {
        if (tl !== Infinity) S[sp++] = l;
        S[sp++] = r;
      }
    }
    this.nodes += visited;
    if (bestTri < 0) return -1;
    this.hitTri = bestId; this.hitLeaf = bestTri;
    const H = this.hit;
    H[0] = best; H[1] = bu; H[2] = bv;
    return bestId;
  }

  /** True when a triangle `which` selects (OPAQUE by default: a shadow ray) lies along the ray register within (tmin, tmax). */
  occludedRay(which = OPAQUE): boolean {
    this.rays++;
    const R = this.ray;
    const ox = R[0], oy = R[1], oz = R[2], dx = R[3], dy = R[4], dz = R[5], tmin = R[6], tmax = R[7];
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const S = this.stack, B = this.B, F = this.F, C = this.C, T = this.T, FL = this.FL, G = this.G;
    const skipGlass = (which & NODE_GLASS) === 0, skipOpaque = (which & NODE_OPAQUE) === 0;
    let sp = 0, visited = 0;
    if ((FL[0] & which) === 0) return false;
    S[sp++] = 0;
    while (sp > 0) {
      const node = S[--sp];
      visited++;
      const b = node * 6;
      let t0 = (B[b] - ox) * ix, t1 = (B[b + 3] - ox) * ix;
      let lo = t0 < t1 ? t0 : t1, hi = t0 < t1 ? t1 : t0;
      t0 = (B[b + 1] - oy) * iy; t1 = (B[b + 4] - oy) * iy;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      if (t0 > lo) lo = t0;
      if (t1 < hi) hi = t1;
      t0 = (B[b + 2] - oz) * iz; t1 = (B[b + 5] - oz) * iz;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      if (t0 > lo) lo = t0;
      if (t1 < hi) hi = t1;
      if (lo > hi || hi < tmin || lo > tmax) continue;
      const cnt = C[node];
      if (cnt > 0) {
        const f = F[node];
        for (let k = f; k < f + cnt; k++) {
          if (G[k] ? skipGlass : skipOpaque) continue;
          const o = k * 9;
          const e1x = T[o + 3], e1y = T[o + 4], e1z = T[o + 5], e2x = T[o + 6], e2y = T[o + 7], e2z = T[o + 8];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-12 && det < 1e-12) continue;
          const inv = 1 / det;
          const sx = ox - T[o], sy = oy - T[o + 1], sz = oz - T[o + 2];
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > tmin && t < tmax) { this.nodes += visited; return true; }
        }
        continue;
      }
      const l = F[node];
      if (FL[l] & which) S[sp++] = l;
      if (FL[l + 1] & which) S[sp++] = l + 1;
    }
    this.nodes += visited;
    return false;
  }

  /**
   * True when no triangle can meet the cone of rays from the ray register's origin about its unit direction, of half
   * angle atan(ray[8]), over ray lengths [tmin, tmax]: every ray of the cone is then clear. Conservative (a
   * triangle's box, grown by the cone's radius where the box ends along the axis, against the axis), so a false
   * answer only means "trace the rays". The tangent comes in the register too: as an argument it was a heap number
   * made on every area-light call.
   */
  coneClearRay(): boolean {
    this.rays++;
    const R = this.ray;
    const ox = R[0], oy = R[1], oz = R[2], ax = R[3], ay = R[4], az = R[5], tanA = R[8];
    // A ray of the cone at length t lies at least t cos(alpha) along the axis.
    const s0 = R[6] / Math.sqrt(1 + tanA * tanA), s1 = R[7];
    const aax = ax < 0 ? -ax : ax, aay = ay < 0 ? -ay : ay, aaz = az < 0 ? -az : az;
    const ix = 1 / ax, iy = 1 / ay, iz = 1 / az;
    const S = this.stack, B = this.B, F = this.F, C = this.C, T = this.T;
    let sp = 0, visited = 0;
    // A mesh with no triangles (a shape thinner than a cell still gets a beauty render) has a root that is neither a
    // leaf (no triangles) nor an inner node: walking it would push its own index for ever.
    if (this.FL[0] === 0) return true;
    S[sp++] = 0;
    while (sp > 0) {
      const node = S[--sp];
      visited++;
      const b = node * 6;
      if (!coneMeetsBox(B[b], B[b + 1], B[b + 2], B[b + 3], B[b + 4], B[b + 5], ox, oy, oz, ax, ay, az, aax, aay, aaz, ix, iy, iz, tanA, s0, s1)) continue;
      const cnt = C[node];
      if (cnt > 0) {
        const f = F[node];
        for (let k = f; k < f + cnt; k++) {
          const o = k * 9;
          const x0 = T[o], y0 = T[o + 1], z0 = T[o + 2];
          const x1 = x0 + T[o + 3], y1 = y0 + T[o + 4], z1 = z0 + T[o + 5], x2 = x0 + T[o + 6], y2 = y0 + T[o + 7], z2 = z0 + T[o + 8];
          const lx = Math.min(x0, x1, x2), ly = Math.min(y0, y1, y2), lz = Math.min(z0, z1, z2);
          const hx = Math.max(x0, x1, x2), hy = Math.max(y0, y1, y2), hz = Math.max(z0, z1, z2);
          if (coneMeetsBox(lx, ly, lz, hx, hy, hz, ox, oy, oz, ax, ay, az, aax, aay, aaz, ix, iy, iz, tanA, s0, s1)) { this.nodes += visited; return false; }
        }
        continue;
      }
      S[sp++] = F[node]; S[sp++] = F[node] + 1;
    }
    this.nodes += visited;
    return true;
  }

  /** closestRay with the ray as arguments: the distance, or Infinity for none. */
  closest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmin: number, tmax: number, which = ALL): number {
    const R = this.ray;
    R[0] = ox; R[1] = oy; R[2] = oz; R[3] = dx; R[4] = dy; R[5] = dz; R[6] = tmin; R[7] = tmax;
    return this.closestRay(which) < 0 ? Infinity : this.hit[0];
  }

  /** occludedRay with the ray as arguments. */
  occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmin: number, tmax: number, which = OPAQUE): boolean {
    const R = this.ray;
    R[0] = ox; R[1] = oy; R[2] = oz; R[3] = dx; R[4] = dy; R[5] = dz; R[6] = tmin; R[7] = tmax;
    return this.occludedRay(which);
  }
}
