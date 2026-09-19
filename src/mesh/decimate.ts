/**
 * Mesh decimation by quadric error, for a budget a target enforces (a
 * Roblox rigid accessory: four thousand triangles; a MeshPart: ten).
 *
 * Half-edge collapses: an edge's two ends are candidates to move onto the
 * other, at the cost of the mover's quadric (the sum of its faces' plane
 * quadrics, area-weighted) evaluated at the survivor, so a vertex on a
 * flat face is free to go and a corner stays. Moving onto an existing
 * vertex rather than to a new optimum keeps every attribute exact: the
 * survivor's material and local point are still its own, which is what
 * the atlas baker needs. A collapse is refused when it would cross a
 * material boundary or fold a face over (a face's normal turning more
 * than a right angle), so seams and the outline survive.
 *
 * The mesher splits vertices at creases, so the mesh is welded by position
 * first and the result re-split by the same rule, each copy taking its
 * side's mean face normal. Every layer here is pure.
 */
import { splitCreases } from "./creases.js";
import { weldIndices, type Mesh } from "./mesh.js";

interface Heap { cost: number[]; a: number[]; b: number[]; stamp: number[] }

export function decimate(mesh: Mesh, targetTriangles: number, creaseAngle = 35): Mesh {
  const triCount = mesh.indices.length / 3;
  if (triCount <= targetTriangles || triCount === 0) return mesh;
  // Weld the crease copies: one vertex per position, the first copy's attributes.
  const welded = weldIndices(mesh);
  const nv = mesh.positions.length / 3;
  const P = new Float64Array(mesh.positions);
  const alive = new Uint8Array(nv);
  for (let i = 0; i < welded.length; i++) alive[welded[i]] = 1;
  const mat = mesh.materialIndex;
  // Triangles as mutable index triples; a dead triangle has -1.
  const T = Array.from(welded);
  const tris = triCount;
  // Vertex to triangles.
  const star: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < tris; t++) for (let c = 0; c < 3; c++) star[T[t * 3 + c]].push(t);
  // Plane quadrics per vertex (a 4x4 symmetric matrix as ten numbers), area-weighted.
  const Q = new Float64Array(nv * 10);
  const faceNormal = (t: number, out: number[]): number => {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    const l = Math.hypot(out[0], out[1], out[2]);
    if (l > 0) { out[0] /= l; out[1] /= l; out[2] /= l; }
    return l / 2;
  };
  const n = [0, 0, 0];
  for (let t = 0; t < tris; t++) {
    const area = faceNormal(t, n);
    if (!(area > 0)) continue;
    const a = T[t * 3] * 3;
    const d = -(n[0] * P[a] + n[1] * P[a + 1] + n[2] * P[a + 2]);
    const q = [n[0] * n[0], n[0] * n[1], n[0] * n[2], n[0] * d, n[1] * n[1], n[1] * n[2], n[1] * d, n[2] * n[2], n[2] * d, d * d];
    for (let c = 0; c < 3; c++) { const o = T[t * 3 + c] * 10; for (let k = 0; k < 10; k++) Q[o + k] += q[k] * area; }
  }
  const evalQ = (v: number, x: number, y: number, z: number): number => {
    const o = v * 10;
    return Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x + Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y + Q[o + 7] * z * z + 2 * Q[o + 8] * z + Q[o + 9];
  };
  // A binary heap of candidate collapses a -> b, with a stamp per vertex so a stale entry is skipped.
  const stamp = new Int32Array(nv);
  const heap: Heap = { cost: [], a: [], b: [], stamp: [] };
  const push = (cost: number, a: number, b: number): void => {
    const h = heap;
    let i = h.cost.length;
    h.cost.push(cost); h.a.push(a); h.b.push(b); h.stamp.push(stamp[a] + stamp[b]);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h.cost[p] <= h.cost[i]) break;
      [h.cost[p], h.cost[i]] = [h.cost[i], h.cost[p]]; [h.a[p], h.a[i]] = [h.a[i], h.a[p]]; [h.b[p], h.b[i]] = [h.b[i], h.b[p]]; [h.stamp[p], h.stamp[i]] = [h.stamp[i], h.stamp[p]];
      i = p;
    }
  };
  // The popped entry is left in `top`; the arrays shrink by one.
  const top = { a: -1, b: -1, stamp: 0 };
  const pop = (): boolean => {
    const h = heap;
    const last = h.cost.length - 1;
    if (last < 0) return false;
    top.a = h.a[0]; top.b = h.b[0]; top.stamp = h.stamp[0];
    h.cost[0] = h.cost[last]; h.a[0] = h.a[last]; h.b[0] = h.b[last]; h.stamp[0] = h.stamp[last];
    h.cost.pop(); h.a.pop(); h.b.pop(); h.stamp.pop();
    let i = 0;
    while (true) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.cost.length && h.cost[l] < h.cost[m]) m = l;
      if (r < h.cost.length && h.cost[r] < h.cost[m]) m = r;
      if (m === i) break;
      [h.cost[m], h.cost[i]] = [h.cost[i], h.cost[m]]; [h.a[m], h.a[i]] = [h.a[i], h.a[m]]; [h.b[m], h.b[i]] = [h.b[i], h.b[m]]; [h.stamp[m], h.stamp[i]] = [h.stamp[i], h.stamp[m]];
      i = m;
    }
    return true;
  };
  const offer = (a: number, b: number): void => {
    if (mat[a] !== mat[b]) return;
    push(evalQ(a, P[b * 3], P[b * 3 + 1], P[b * 3 + 2]), a, b);
  };
  const edgeSeen = new Set<number>();
  for (let t = 0; t < tris; t++)
    for (let c = 0; c < 3; c++) {
      const a = T[t * 3 + c], b = T[t * 3 + ((c + 1) % 3)];
      const key = a < b ? a * nv + b : b * nv + a;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      offer(a, b); offer(b, a);
    }

  let live = tris;
  const before = [0, 0, 0], after = [0, 0, 0];
  while (live > targetTriangles) {
    if (!pop()) break;
    const a = top.a, b = top.b;
    if (top.stamp !== stamp[a] + stamp[b] || !alive[a] || !alive[b] || a === b) continue;
    // The triangles that vanish share both ends; the rest of a's star moves to b, unless a face would fold.
    let folds = false;
    const moving: number[] = [], dying: number[] = [];
    for (const t of star[a]) {
      if (T[t * 3] < 0) continue;
      const has = T[t * 3] === b || T[t * 3 + 1] === b || T[t * 3 + 2] === b;
      if (has) { dying.push(t); continue; }
      faceNormal(t, before);
      const save = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
      for (let c = 0; c < 3; c++) if (T[t * 3 + c] === a) T[t * 3 + c] = b;
      const area = faceNormal(t, after);
      for (let c = 0; c < 3; c++) T[t * 3 + c] = save[c];
      if (!(area > 0) || before[0] * after[0] + before[1] * after[1] + before[2] * after[2] < 0.1) { folds = true; break; }
      moving.push(t);
    }
    if (folds) { stamp[a]++; continue; }
    for (const t of dying) { T[t * 3] = T[t * 3 + 1] = T[t * 3 + 2] = -1; live--; }
    for (const t of moving) { for (let c = 0; c < 3; c++) if (T[t * 3 + c] === a) T[t * 3 + c] = b; star[b].push(t); }
    alive[a] = 0;
    for (let k = 0; k < 10; k++) Q[b * 10 + k] += Q[a * 10 + k];
    stamp[a]++; stamp[b]++;
    // Fresh candidates round the survivor.
    const around = new Set<number>();
    for (const t of star[b]) if (T[t * 3] >= 0) for (let c = 0; c < 3; c++) { const v = T[t * 3 + c]; if (v !== b) around.add(v); }
    for (const v of around) { offer(v, b); offer(b, v); }
  }

  // Compact: the live vertices and triangles, then the crease split for normals per side.
  const remap = new Int32Array(nv).fill(-1);
  const positions: number[] = [], local: number[] = [], materialIndex: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < tris; t++) {
    if (T[t * 3] < 0) continue;
    for (let c = 0; c < 3; c++) {
      const v = T[t * 3 + c];
      if (remap[v] < 0) {
        remap[v] = positions.length / 3;
        positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
        local.push(mesh.local[v * 3], mesh.local[v * 3 + 1], mesh.local[v * 3 + 2]);
        materialIndex.push(mat[v]);
      }
      indices.push(remap[v]);
    }
  }
  const ix = new Uint32Array(indices);
  const split = splitCreases(positions, ix, creaseAngle > 0 ? creaseAngle : 180);
  const outN = split.positions.length / 3;
  const normals = new Float32Array(outN * 3);
  const outLocal = new Float32Array(outN * 3);
  const outMat = new Uint16Array(outN);
  // Mean face normals for every vertex (creases split, the rest area-weighted over their faces).
  const fn = new Float64Array(outN * 3);
  for (let t = 0; t < split.indices.length; t += 3) {
    const a = split.indices[t] * 3, b = split.indices[t + 1] * 3, c = split.indices[t + 2] * 3;
    const p = split.positions;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [split.indices[t], split.indices[t + 1], split.indices[t + 2]]) { fn[v * 3] += nx; fn[v * 3 + 1] += ny; fn[v * 3 + 2] += nz; }
  }
  for (let v = 0; v < outN; v++) {
    const l = Math.hypot(fn[v * 3], fn[v * 3 + 1], fn[v * 3 + 2]) || 1;
    normals[v * 3] = fn[v * 3] / l; normals[v * 3 + 1] = fn[v * 3 + 1] / l; normals[v * 3 + 2] = fn[v * 3 + 2] / l;
    const s = split.source[v];
    outLocal[v * 3] = local[s * 3]; outLocal[v * 3 + 1] = local[s * 3 + 1]; outLocal[v * 3 + 2] = local[s * 3 + 2];
    outMat[v] = materialIndex[s];
  }
  return { positions: split.positions, normals, local: outLocal, materialIndex: outMat, materials: mesh.materials, indices: split.indices };
}
