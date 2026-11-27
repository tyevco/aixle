/**
 * Mesh decimation by quadric error, for a budget a target enforces (a
 * Roblox rigid accessory: four thousand triangles; a MeshPart: ten; the web
 * export's cap).
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
 * A material seam is a band of triangles whose corners are of two
 * materials. Collapses along it stretch those triangles along the seam, so
 * the atlas baker paints such a triangle from the surface under each texel,
 * not from its corners (see atlas.ts).
 *
 * Several meshes share one budget through one queue: the cheapest collapse
 * anywhere goes first, so a flat wall gives up its triangles before a
 * curved stud gives up any (round 11: each mesh gave up the same share,
 * and a flat wall kept 35196 of 54996). Each mesh keeps at least four.
 *
 * The mesher splits vertices at creases, so the mesh is welded by position
 * first and the result re-split by the same rule, each copy taking its
 * side's mean face normal. Every layer here is pure.
 */
import { splitCreases } from "./creases.js";
import { weldIndices, type Mesh } from "./mesh.js";

export function decimate(mesh: Mesh, targetTriangles: number, creaseAngle = 35): Mesh {
  return decimateMeshes([mesh], targetTriangles, creaseAngle).meshes[0];
}

/** The fewest triangles a mesh keeps under a shared budget: a closed mesh cannot go below a tetrahedron. */
const MIN_TRIANGLES = 4;

/**
 * A collapse costs nothing when the vertex stays on every plane of its faces to within this share of an edge: a flat
 * face's own triangles, which the mesher lays exactly on the plane (to float precision, a ten-millionth of an edge),
 * where a vertex on a curve three cells round moves a sixth of an edge off it.
 */
const FLAT = 1e-4;

export interface Decimated {
  /** Per mesh given, the decimated mesh, or the same object when the queue never reached it. */
  meshes: Mesh[];
  /**
   * How many triangles merging only flat faces (collapses that cost nothing, by FLAT) comes to: a cap at or above
   * it loses nothing to decimation but what the mesher already lost. Counted past the target without keeping those
   * collapses, so a reader can see how far the cap could come down for free.
   */
  flat: number;
}

/**
 * Decimate meshes to at most `targetTriangles` in all, by one queue over all of them: the flattest parts go first,
 * wherever they are. A mesh already under the budget with the rest comes back as it was (the same object); so does
 * every mesh when the total is under it.
 */
export function decimateMeshes(meshes: Mesh[], targetTriangles: number, creaseAngle = 35): Decimated {
  let tris = 0, nv = 0;
  for (const m of meshes) { tris += m.indices.length / 3; nv += m.positions.length / 3; }
  if (tris <= targetTriangles || tris === 0) return { meshes, flat: tris };
  // Weld each mesh's crease copies (one vertex per position, the first copy's attributes) and lay the meshes end to
  // end: a vertex index and a triangle index each run over all of them, and no edge joins two meshes.
  const P = new Float64Array(nv * 3);
  const T = new Int32Array(tris * 3);
  const alive = new Uint8Array(nv);
  const mat = new Int32Array(nv);
  const vStart: number[] = [], tStart: number[] = [];
  const triMesh = new Int32Array(tris);
  const matId = new Map<unknown, number>();
  {
    let vo = 0, to = 0;
    meshes.forEach((m, mi) => {
      vStart.push(vo); tStart.push(to);
      const welded = weldIndices(m);
      const n = m.positions.length / 3;
      for (let i = 0; i < n * 3; i++) P[vo * 3 + i] = m.positions[i];
      for (let v = 0; v < n; v++) {
        const mm = m.materials[m.materialIndex[v]];
        let id = matId.get(mm);
        if (id === undefined) { id = matId.size; matId.set(mm, id); }
        mat[vo + v] = id;
      }
      for (let i = 0; i < welded.length; i++) { T[to * 3 + i] = welded[i] + vo; alive[welded[i] + vo] = 1; }
      for (let t = 0; t < welded.length / 3; t++) triMesh[to + t] = mi;
      vo += n; to += welded.length / 3;
    });
    vStart.push(vo); tStart.push(to);
  }
  // Vertex to triangles.
  const star: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < tris; t++) for (let c = 0; c < 3; c++) star[T[t * 3 + c]].push(t);
  // Plane quadrics per vertex (a 4x4 symmetric matrix as ten numbers), area-weighted.
  const Q = new Float64Array(nv * 10);
  const faceNormal = (t: number, out: Float64Array): number => {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    const l = Math.hypot(out[0], out[1], out[2]);
    if (l > 0) { out[0] /= l; out[1] /= l; out[2] /= l; }
    return l / 2;
  };
  const n = new Float64Array(3);
  const q = new Float64Array(10);
  for (let t = 0; t < tris; t++) {
    const area = faceNormal(t, n);
    if (!(area > 0)) continue;
    const a = T[t * 3] * 3;
    const d = -(n[0] * P[a] + n[1] * P[a + 1] + n[2] * P[a + 2]);
    q[0] = n[0] * n[0]; q[1] = n[0] * n[1]; q[2] = n[0] * n[2]; q[3] = n[0] * d; q[4] = n[1] * n[1];
    q[5] = n[1] * n[2]; q[6] = n[1] * d; q[7] = n[2] * n[2]; q[8] = n[2] * d; q[9] = d * d;
    for (let c = 0; c < 3; c++) { const o = T[t * 3 + c] * 10; for (let k = 0; k < 10; k++) Q[o + k] += q[k] * area; }
  }
  const evalQ = (v: number, x: number, y: number, z: number): number => {
    const o = v * 10;
    return Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x + Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y + Q[o + 7] * z * z + 2 * Q[o + 8] * z + Q[o + 9];
  };
  // A binary heap of candidate collapses a -> b in typed arrays that double when full, with a stamp per vertex so a
  // stale entry is skipped. Swapping by destructuring allocated two arrays per step, and the decimation of a chest at
  // 459 thousand triangles took 7 s to reach 200 thousand (measured); the same heap moved by hand takes a fraction.
  const stamp = new Int32Array(nv);
  let cap = Math.max(16, tris * 3);
  let hCost = new Float64Array(cap), hA = new Int32Array(cap), hB = new Int32Array(cap), hStamp = new Int32Array(cap);
  let size = 0;
  const push = (cost: number, a: number, b: number): void => {
    if (size === cap) {
      cap *= 2;
      const c2 = new Float64Array(cap), a2 = new Int32Array(cap), b2 = new Int32Array(cap), s2 = new Int32Array(cap);
      c2.set(hCost); a2.set(hA); b2.set(hB); s2.set(hStamp);
      hCost = c2; hA = a2; hB = b2; hStamp = s2;
    }
    let i = size++;
    const st = stamp[a] + stamp[b];
    // Sift up: move parents down until this entry's place is found, then write it once.
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hCost[p] <= cost) break;
      hCost[i] = hCost[p]; hA[i] = hA[p]; hB[i] = hB[p]; hStamp[i] = hStamp[p];
      i = p;
    }
    hCost[i] = cost; hA[i] = a; hB[i] = b; hStamp[i] = st;
  };
  // The popped entry is left in topA, topB, topStamp, topCost; the heap shrinks by one.
  let topA = -1, topB = -1, topStamp = 0, topCost = 0;
  const pop = (): boolean => {
    if (size === 0) return false;
    topA = hA[0]; topB = hB[0]; topStamp = hStamp[0]; topCost = hCost[0];
    const last = --size;
    const cost = hCost[last], a = hA[last], b = hB[last], st = hStamp[last];
    // Sift down the last entry from the root, the smaller child moving up each step (the left one on a tie).
    let i = 0;
    while (true) {
      const l = 2 * i + 1, r = l + 1;
      let m = i, mc = cost;
      if (l < size && hCost[l] < mc) { m = l; mc = hCost[l]; }
      if (r < size && hCost[r] < mc) { m = r; mc = hCost[r]; }
      if (m === i) break;
      hCost[i] = hCost[m]; hA[i] = hA[m]; hB[i] = hB[m]; hStamp[i] = hStamp[m];
      i = m;
    }
    if (size > 0) { hCost[i] = cost; hA[i] = a; hB[i] = b; hStamp[i] = st; }
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

  // A free collapse's cost, from the meshes' mean edge: area (an edge squared) times the distance squared.
  let edgeSum = 0;
  for (let t = 0; t < tris; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3;
    edgeSum += Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
  }
  const edge = edgeSum / tris;
  const free = (FLAT * edge) ** 2 * edge * edge;
  let live = tris;
  const meshLive = meshes.map((m) => m.indices.length / 3);
  const before = new Float64Array(3), after = new Float64Array(3);
  // Scratch reused by every collapse: the triangles that move and die, and the survivor's neighbours in the order
  // first met (a mark per vertex instead of a Set per collapse).
  const moving: number[] = [], dying: number[] = [], around: number[] = [];
  const mark = new Int32Array(nv).fill(-1);
  let collapse = 0;
  // The live count when the first collapse that costs something was made: the flat faces' floor.
  let flat = -1;
  /** One collapse from the queue, if it is still valid; false when the queue is empty or `limit` stops it. */
  const step = (limit: number): boolean => {
    if (!pop()) return false;
    if (topCost > limit) return false;
    const a = topA, b = topB;
    if (topStamp !== stamp[a] + stamp[b] || !alive[a] || !alive[b] || a === b) return true;
    // The triangles that vanish share both ends; the rest of a's star moves to b, unless a face would fold.
    let folds = false;
    moving.length = 0; dying.length = 0;
    for (const t of star[a]) {
      if (T[t * 3] < 0) continue;
      const s0 = T[t * 3], s1 = T[t * 3 + 1], s2 = T[t * 3 + 2];
      if (s0 === b || s1 === b || s2 === b) { dying.push(t); continue; }
      faceNormal(t, before);
      if (s0 === a) T[t * 3] = b;
      if (s1 === a) T[t * 3 + 1] = b;
      if (s2 === a) T[t * 3 + 2] = b;
      const area = faceNormal(t, after);
      T[t * 3] = s0; T[t * 3 + 1] = s1; T[t * 3 + 2] = s2;
      if (!(area > 0) || before[0] * after[0] + before[1] * after[1] + before[2] * after[2] < 0.1) { folds = true; break; }
      moving.push(t);
    }
    if (folds) { stamp[a]++; return true; }
    // A mesh keeps a few triangles whatever the others need: the queue moves on to another collapse.
    const mi = dying.length ? triMesh[dying[0]] : -1;
    if (mi >= 0 && meshLive[mi] - dying.length < MIN_TRIANGLES) return true;
    if (flat < 0 && topCost > free) flat = live;
    for (const t of dying) { T[t * 3] = T[t * 3 + 1] = T[t * 3 + 2] = -1; live--; }
    if (mi >= 0) meshLive[mi] -= dying.length;
    const sb = star[b];
    for (const t of moving) { for (let c = 0; c < 3; c++) if (T[t * 3 + c] === a) T[t * 3 + c] = b; sb.push(t); }
    alive[a] = 0;
    star[a] = [];
    for (let k = 0; k < 10; k++) Q[b * 10 + k] += Q[a * 10 + k];
    stamp[a]++; stamp[b]++;
    // Fresh candidates round the survivor. Its star is compacted to its live triangles on the way, in order, so a
    // vertex that has taken in a large flat face does not walk every triangle it ever had at each collapse.
    around.length = 0;
    const id = collapse++;
    let w = 0;
    for (let i = 0; i < sb.length; i++) {
      const t = sb[i];
      if (T[t * 3] < 0) continue;
      sb[w++] = t;
      for (let c = 0; c < 3; c++) { const v = T[t * 3 + c]; if (v !== b && mark[v] !== id) { mark[v] = id; around.push(v); } }
    }
    sb.length = w;
    for (const v of around) { offer(v, b); offer(b, v); }
    return true;
  };
  while (live > targetTriangles && step(Infinity)) { /* collapse */ }
  // The meshes as the cap leaves them; past it, only to count how far the free collapses alone would go.
  const kept = T.slice();
  const keptLive = meshLive.slice();
  if (flat < 0) {
    while (step(free)) { /* count */ }
    flat = live;
  }
  T.set(kept);

  // Each mesh compacted on its own: its live vertices and triangles, then the crease split for normals per side. A
  // mesh the queue never touched comes back as it was.
  const out = meshes.map((mesh, mi) => {
    if (keptLive[mi] === mesh.indices.length / 3) return mesh;
    const vo = vStart[mi];
    const remap = new Map<number, number>();
    const positions: number[] = [], local: number[] = [], materialIndex: number[] = [];
    const indices: number[] = [];
    for (let t = tStart[mi]; t < tStart[mi + 1]; t++) {
      if (T[t * 3] < 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = T[t * 3 + c];
        let r = remap.get(v);
        if (r === undefined) {
          r = positions.length / 3;
          remap.set(v, r);
          const lv = v - vo;
          positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          local.push(mesh.local[lv * 3], mesh.local[lv * 3 + 1], mesh.local[lv * 3 + 2]);
          materialIndex.push(mesh.materialIndex[lv]);
        }
        indices.push(r);
      }
    }
    return resplit(mesh, positions, local, materialIndex, indices, creaseAngle);
  });
  return { meshes: out, flat };
}

/** The crease split of a decimated mesh, each copy taking its side's mean face normal (area-weighted). */
function resplit(mesh: Mesh, positions: number[], local: number[], materialIndex: number[], indices: number[], creaseAngle: number): Mesh {
  const ix = new Uint32Array(indices);
  const split = splitCreases(positions, ix, creaseAngle > 0 ? creaseAngle : 180);
  const outN = split.positions.length / 3;
  const normals = new Float32Array(outN * 3);
  const outLocal = new Float32Array(outN * 3);
  const outMat = new Uint16Array(outN);
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

/**
 * The largest |field| at the centres of a mesh's faces, the mesh's positions offset by `origin` into the field's
 * frame: how far a mesh strays from the surface it was cut from where it strays most, which for a decimated mesh is
 * in the middle of its widest faces (its vertices are still the mesher's, on the surface). A field that is not an
 * exact distance (a blend, a twist) gives its own value there, which is near the distance close to the surface.
 */
export function faceDeviation(mesh: Mesh, dist: (x: number, y: number, z: number) => number, origin: readonly [number, number, number] = [0, 0, 0]): number {
  const p = mesh.positions, ix = mesh.indices;
  let worst = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const d = Math.abs(dist((p[a] + p[b] + p[c]) / 3 + origin[0], (p[a + 1] + p[b + 1] + p[c + 1]) / 3 + origin[1], (p[a + 2] + p[b + 2] + p[c + 2]) / 3 + origin[2]));
    if (d > worst) worst = d;
  }
  return worst;
}
