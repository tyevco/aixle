/**
 * A signed distance field from a triangle mesh, so an imported model can be
 * a primitive: cut, blended, hollowed and painted like anything else.
 *
 * The field is sampled once onto a grid over the mesh (unsigned distance
 * by a bounding-volume hierarchy of point-triangle queries; sign by the
 * winding count of ray crossings along each grid line, which is right for closed
 * meshes and the best that can be done for open ones) and read back by
 * trilinear interpolation, clamped outside the grid to the distance to
 * its box. Detail finer than the grid softens; the grid follows the mesh's
 * longest side at `resolution` cells.
 */
import type { ImportedMesh } from "../import/obj.js";
import type { Bounds } from "../sdf/types.js";

interface Bvh {
  /** For each node: min xyz, max xyz. */
  bmin: Float64Array;
  bmax: Float64Array;
  /** Children (-1 for leaves) and leaf triangle ranges into `order`. */
  left: Int32Array;
  right: Int32Array;
  start: Int32Array;
  end: Int32Array;
  order: Int32Array;
}

function buildBvh(P: Float32Array, I: Uint32Array): Bvh {
  const nt = I.length / 3;
  const cx = new Float64Array(nt), cy = new Float64Array(nt), cz = new Float64Array(nt);
  const tmin = new Float64Array(nt * 3), tmax = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      const v0 = P[a + k], v1 = P[b + k], v2 = P[c + k];
      tmin[t * 3 + k] = Math.min(v0, v1, v2);
      tmax[t * 3 + k] = Math.max(v0, v1, v2);
    }
    cx[t] = (tmin[t * 3] + tmax[t * 3]) / 2; cy[t] = (tmin[t * 3 + 1] + tmax[t * 3 + 1]) / 2; cz[t] = (tmin[t * 3 + 2] + tmax[t * 3 + 2]) / 2;
  }
  const order = new Int32Array(nt);
  for (let t = 0; t < nt; t++) order[t] = t;
  const cap = 2 * nt;
  const bmin = new Float64Array(cap * 3), bmax = new Float64Array(cap * 3);
  const left = new Int32Array(cap).fill(-1), right = new Int32Array(cap).fill(-1), start = new Int32Array(cap), end = new Int32Array(cap);
  let count = 0;
  const build = (s: number, e: number): number => {
    const node = count++;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = s; i < e; i++) {
      const t = order[i];
      mnx = Math.min(mnx, tmin[t * 3]); mny = Math.min(mny, tmin[t * 3 + 1]); mnz = Math.min(mnz, tmin[t * 3 + 2]);
      mxx = Math.max(mxx, tmax[t * 3]); mxy = Math.max(mxy, tmax[t * 3 + 1]); mxz = Math.max(mxz, tmax[t * 3 + 2]);
    }
    bmin[node * 3] = mnx; bmin[node * 3 + 1] = mny; bmin[node * 3 + 2] = mnz;
    bmax[node * 3] = mxx; bmax[node * 3 + 1] = mxy; bmax[node * 3 + 2] = mxz;
    start[node] = s; end[node] = e;
    if (e - s <= 4) return node;
    // Split on the longest axis at the median centroid.
    const ex = mxx - mnx, ey = mxy - mny, ez = mxz - mnz;
    const axis = ex >= ey && ex >= ez ? cx : ey >= ez ? cy : cz;
    const sub = Array.from(order.subarray(s, e)).sort((p, q) => axis[p] - axis[q]);
    order.set(sub, s);
    const mid = (s + e) >> 1;
    left[node] = build(s, mid);
    right[node] = build(mid, e);
    return node;
  };
  build(0, nt);
  return { bmin, bmax, left, right, start, end, order };
}

/** Squared distance from a point to a triangle (Ericson). */
function triDist2(P: Float32Array, I: Uint32Array, t: number, px: number, py: number, pz: number): number {
  const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
  const acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = P[b]; qy = P[b + 1]; qz = P[b + 2]; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
      } else {
        const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = P[c]; qy = P[c + 1]; qz = P[c + 2]; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = P[b] + (P[c] - P[b]) * w; qy = P[b + 1] + (P[c + 1] - P[b + 1]) * w; qz = P[b + 2] + (P[c + 2] - P[b + 2]) * w;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

function boxDist2(bvh: Bvh, n: number, x: number, y: number, z: number): number {
  const dx = Math.max(bvh.bmin[n * 3] - x, 0, x - bvh.bmax[n * 3]);
  const dy = Math.max(bvh.bmin[n * 3 + 1] - y, 0, y - bvh.bmax[n * 3 + 1]);
  const dz = Math.max(bvh.bmin[n * 3 + 2] - z, 0, z - bvh.bmax[n * 3 + 2]);
  return dx * dx + dy * dy + dz * dz;
}

/** Unsigned distance from a point to the mesh. */
export function meshDistance(P: Float32Array, I: Uint32Array, bvh: Bvh, x: number, y: number, z: number): number {
  let best = Infinity;
  const stack = [0];
  while (stack.length) {
    const n = stack.pop()!;
    if (boxDist2(bvh, n, x, y, z) >= best) continue;
    if (bvh.left[n] < 0) {
      for (let i = bvh.start[n]; i < bvh.end[n]; i++) {
        const d = triDist2(P, I, bvh.order[i], x, y, z);
        if (d < best) best = d;
      }
    } else {
      // Nearer child first.
      const l = bvh.left[n], r = bvh.right[n];
      if (boxDist2(bvh, l, x, y, z) < boxDist2(bvh, r, x, y, z)) { stack.push(r, l); } else { stack.push(l, r); }
    }
  }
  return Math.sqrt(best);
}

export interface MeshField {
  /** Signed distance, trilinear inside the grid, box distance plus edge value outside. */
  dist: (x: number, y: number, z: number) => number;
  bounds: Bounds;
  cell: number;
  triangles: number;
  /** Fraction of grid lines whose crossing count was odd at the far end: nonzero means the mesh is not closed. */
  openness: number;
}

/**
 * The sampled grid as plain data: everything `fieldFromSamples` needs to read it back, and so what an import cache
 * stores. Samples are signed distances at `origin + (i, j, k) * cell`, x fastest.
 */
export interface MeshSamples {
  samples: Float32Array;
  dims: [number, number, number];
  origin: [number, number, number];
  cell: number;
  bounds: Bounds;
  triangles: number;
  openness: number;
}

/**
 * Bumped whenever a change here would sample the same mesh differently, so a cache of samples keyed by it never
 * serves a grid the current code would not have made.
 */
export const SAMPLER_VERSION = 1;

export function meshField(mesh: ImportedMesh, resolution = 96): MeshField {
  return fieldFromSamples(sampleMesh(mesh, resolution));
}

export function sampleMesh(mesh: ImportedMesh, resolution = 96): MeshSamples {
  const P = mesh.positions, I = mesh.indices;
  const nt = I.length / 3;
  const bounds: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) { bounds.min[k] = Math.min(bounds.min[k], P[i + k]); bounds.max[k] = Math.max(bounds.max[k], P[i + k]); }
  const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const longest = Math.max(size[0], size[1], size[2], 1e-9);
  const cell = longest / resolution;
  const margin = 2;
  // The grid origin is offset by an irrational fraction of a cell so no
  // grid line runs exactly through a vertex or along an edge of the mesh,
  // where a crossing count would be ambiguous.
  const jitter = 0.3819660112501051 * cell;
  const ox = bounds.min[0] - margin * cell - jitter, oy = bounds.min[1] - margin * cell - jitter * 0.7, oz = bounds.min[2] - margin * cell - jitter * 0.4;
  const nx = Math.ceil(size[0] / cell) + 2 * margin + 1, ny = Math.ceil(size[1] / cell) + 2 * margin + 1, nz = Math.ceil(size[2] / cell) + 2 * margin + 1;
  const bvh = buildBvh(P, I);
  const field = new Float32Array(nx * ny * nz);
  // Unsigned distances.
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) field[(k * ny + j) * nx + i] = meshDistance(P, I, bvh, ox + i * cell, oy + j * cell, oz + k * cell);
  // Sign by the winding count of crossings along z for each (i, j) line: each crossing adds the triangle's
  // orientation, and a point is inside where the count is not zero. Parity read a region covered by two closed
  // shells (a canopy overlapping its pole, an object sunk into the paving, as the tool's own GLB of a scene is
  // written) as outside, so a round trip split a terrace into five pieces (measured). The nonzero rule keeps the
  // overlap solid and reads a mesh wound either way; the openness measure stays the parity of the count.
  //
  // Each line used to test every triangle, which was nine tenths of the time on a large mesh (measured: the chest's
  // GLB, 459 thousand triangles at resolution 96, 31 of 34 s). Each triangle is now binned first into the lines its
  // xy box may cover, a line wider each way than rounding could need, in triangle order; a line then runs the same
  // exact tests over its own bin, so it finds the same crossings in the same order and the field is the same to the bit.
  const lines = nx * ny;
  const start = new Int32Array(lines + 1);
  const span = (t: number, out: Int32Array): boolean => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    out[0] = Math.max(0, Math.floor((Math.min(P[a], P[b], P[c]) - ox) / cell) - 1);
    out[1] = Math.min(nx - 1, Math.ceil((Math.max(P[a], P[b], P[c]) - ox) / cell) + 1);
    out[2] = Math.max(0, Math.floor((Math.min(P[a + 1], P[b + 1], P[c + 1]) - oy) / cell) - 1);
    out[3] = Math.min(ny - 1, Math.ceil((Math.max(P[a + 1], P[b + 1], P[c + 1]) - oy) / cell) + 1);
    return out[0] <= out[1] && out[2] <= out[3];
  };
  const box = new Int32Array(4);
  for (let t = 0; t < nt; t++) {
    if (!span(t, box)) continue;
    for (let j = box[2]; j <= box[3]; j++) for (let i = box[0]; i <= box[1]; i++) start[j * nx + i + 1]++;
  }
  for (let l = 0; l < lines; l++) start[l + 1] += start[l];
  const bin = new Int32Array(start[lines]);
  const fill = start.slice(0, lines);
  for (let t = 0; t < nt; t++) {
    if (!span(t, box)) continue;
    for (let j = box[2]; j <= box[3]; j++) for (let i = box[0]; i <= box[1]; i++) bin[fill[j * nx + i]++] = t;
  }
  let odd = 0;
  const crossings: number[] = [];
  const signs: number[] = [];
  const order: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = ox + i * cell, y = oy + j * cell;
      crossings.length = 0;
      signs.length = 0;
      for (let e = start[j * nx + i], end = start[j * nx + i + 1]; e < end; e++) {
        const t = bin[e];
        // Ray along +z from z = -inf: does the triangle's xy projection contain (x, y)? Then record its z there.
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cx = P[c], cy = P[c + 1];
        if (Math.min(ax, bx, cx) > x || Math.max(ax, bx, cx) < x || Math.min(ay, by, cy) > y || Math.max(ay, by, cy) < y) continue;
        const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(det) < 1e-18) continue;
        const l1 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / det;
        const l2 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / det;
        const l3 = 1 - l1 - l2;
        // Strictly inside only: a ray exactly on a shared edge then counts
        // zero for both triangles, which leaves the parity right.
        if (l1 <= 0 || l2 <= 0 || l3 <= 0) continue;
        crossings.push(l1 * P[a + 2] + l2 * P[b + 2] + l3 * P[c + 2]);
        signs.push(det > 0 ? 1 : -1);
      }
      order.length = crossings.length;
      for (let c = 0; c < crossings.length; c++) order[c] = c;
      order.sort((p, q) => crossings[p] - crossings[q]);
      if (crossings.length % 2 === 1) odd++;
      let depth = 0, ci = 0;
      for (let k = 0; k < nz; k++) {
        const z = oz + k * cell;
        while (ci < order.length && crossings[order[ci]] < z) { depth += signs[order[ci]]; ci++; }
        if (depth !== 0) field[(k * ny + j) * nx + i] *= -1;
      }
    }
  const openness = odd / (nx * ny);
  return { samples: field, dims: [nx, ny, nz], origin: [ox, oy, oz], cell, bounds, triangles: nt, openness };
}

/** The field over a sampled grid: trilinear inside it, clamped outside to the distance to its box plus the edge value. */
export function fieldFromSamples(s: MeshSamples): MeshField {
  const field = s.samples;
  const [nx, ny, nz] = s.dims;
  const [ox, oy, oz] = s.origin;
  const cell = s.cell;
  const sample = (i: number, j: number, k: number) => field[(k * ny + j) * nx + i];
  const dist = (x: number, y: number, z: number): number => {
    let fx = (x - ox) / cell, fy = (y - oy) / cell, fz = (z - oz) / cell;
    let outside = 0;
    const clampAxis = (f: number, n: number): number => {
      if (f < 0) { outside += f * f; return 0; }
      if (f > n - 1) { outside += (f - (n - 1)) * (f - (n - 1)); return n - 1; }
      return f;
    };
    fx = clampAxis(fx, nx); fy = clampAxis(fy, ny); fz = clampAxis(fz, nz);
    const i0 = Math.min(nx - 2, Math.floor(fx)), j0 = Math.min(ny - 2, Math.floor(fy)), k0 = Math.min(nz - 2, Math.floor(fz));
    const tx = fx - i0, ty = fy - j0, tz = fz - k0;
    const c00 = sample(i0, j0, k0) * (1 - tx) + sample(i0 + 1, j0, k0) * tx;
    const c10 = sample(i0, j0 + 1, k0) * (1 - tx) + sample(i0 + 1, j0 + 1, k0) * tx;
    const c01 = sample(i0, j0, k0 + 1) * (1 - tx) + sample(i0 + 1, j0, k0 + 1) * tx;
    const c11 = sample(i0, j0 + 1, k0 + 1) * (1 - tx) + sample(i0 + 1, j0 + 1, k0 + 1) * tx;
    const v = (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
    return outside > 0 ? v + Math.sqrt(outside) * cell : v;
  };
  return { dist, bounds: s.bounds, cell, triangles: s.triangles, openness: s.openness };
}
