/**
 * Physical checks on the extracted mesh, for the report: volume and mass,
 * the centre of mass, whether the model stands on its base, and whether it
 * is one piece.
 *
 * Everything is computed from the closed triangle mesh: volume and centroid
 * by the divergence theorem (exact for the mesh), contact as the vertices
 * within a cell of the lowest point, stability as the centre of mass
 * projected onto the floor lying inside the convex hull of those contacts,
 * and pieces as the connected components of the triangle graph, each with
 * its own volume so a speck can be told from a floating part.
 */
import type { Mesh } from "./mesh.js";

export interface Piece {
  triangles: number;
  /** Signed: negative for a closed shell whose normals point inward, which is a cavity inside another piece. */
  volume: number;
  /** Lowest y of the piece. */
  bottom: number;
  centre: [number, number, number];
  /** Longest side of the piece's box, to tell a small real part from a sliver. */
  size: number;
  /** True for an inward-facing shell: an enclosed void, not a loose part. */
  cavity: boolean;
}

export interface Physics {
  volume: number;
  /** Centre of mass, assuming uniform density. */
  centre: [number, number, number];
  /** Lowest point of the model. */
  floor: number;
  /** Contact footprint on the floor: the convex hull of the lowest vertices, as x, z pairs. */
  footprint: [number, number][];
  /** Whether the centre of mass projects inside the footprint (with a small margin). */
  stable: boolean;
  /** Distance from the projected centre of mass to the footprint's edge; negative when outside. */
  stabilityMargin: number;
  pieces: Piece[];
  /** Fraction of the surface area that faces down more steeply than 45 degrees and is clear of the floor: what a printer would need support under. */
  overhang: number;
}

function centroidAndVolume(mesh: Mesh, tris?: number[]): { volume: number; centre: [number, number, number] } {
  const p = mesh.positions, ix = mesh.indices;
  let v = 0, cx = 0, cy = 0, cz = 0;
  const each = (t: number) => {
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b], by = p[b + 1], bz = p[b + 2], cx_ = p[c], cy_ = p[c + 1], cz_ = p[c + 2];
    const det = ax * (by * cz_ - bz * cy_) - ay * (bx * cz_ - bz * cx_) + az * (bx * cy_ - by * cx_);
    v += det;
    cx += det * (ax + bx + cx_);
    cy += det * (ay + by + cy_);
    cz += det * (az + bz + cz_);
  };
  if (tris) for (const t of tris) each(t);
  else for (let t = 0; t < ix.length / 3; t++) each(t);
  const volume = v / 6;
  const k = v === 0 ? 0 : 1 / (4 * v);
  return { volume, centre: [cx * k, cy * k, cz * k] };
}

/** Convex hull of 2D points (monotone chain). */
export function hull2(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Signed distance from a point to a convex polygon's edge: positive inside. */
export function insideMargin(hull: [number, number][], x: number, z: number): number {
  if (hull.length < 3) return -Infinity;
  let m = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const len = Math.hypot(ex, ez) || 1;
    // Hull is counter-clockwise: inside is to the left of each edge.
    const d = (ex * (z - a[1]) - ez * (x - a[0])) / len;
    m = Math.min(m, d);
  }
  return m;
}

export function analyse(mesh: Mesh, cellSize: number): Physics {
  const { volume, centre } = centroidAndVolume(mesh);
  const p = mesh.positions;
  let floor = Infinity;
  for (let i = 1; i < p.length; i += 3) floor = Math.min(floor, p[i]);
  const contacts: [number, number][] = [];
  for (let i = 0; i < p.length; i += 3) if (p[i + 1] <= floor + cellSize * 1.5) contacts.push([p[i], p[i + 2]]);
  const footprint = hull2(contacts);
  const stabilityMargin = insideMargin(footprint, centre[0], centre[2]);
  // Connected components over shared vertices.
  const nv = p.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const ix = mesh.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const a = find(ix[t]), b = find(ix[t + 1]), c = find(ix[t + 2]);
    parent[a] = b; parent[find(b)] = find(c);
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < ix.length / 3; t++) {
    const r = find(ix[t * 3]);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t);
  }
  const pieces: Piece[] = [];
  for (const tris of groups.values()) {
    const cv = centroidAndVolume(mesh, tris);
    let bottom = Infinity;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of tris)
      for (let k = 0; k < 3; k++) {
        const o = ix[t * 3 + k] * 3;
        for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[o + a]); hi[a] = Math.max(hi[a], p[o + a]); }
      }
    bottom = lo[1];
    // The main body's winding gives a positive volume; a shell wound the other way is a void inside something.
    pieces.push({ triangles: tris.length, volume: cv.volume, bottom, centre: cv.centre, size: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), cavity: false });
  }
  pieces.sort((a, b) => Math.abs(b.volume) - Math.abs(a.volume));
  const sign = pieces.length ? Math.sign(pieces[0].volume) || 1 : 1;
  for (const pc of pieces) pc.cavity = Math.sign(pc.volume) === -sign && pc.volume !== 0;
  // Overhangs: area of faces whose normal points down more than 45 degrees, other than the faces resting on the floor.
  let area = 0, down = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) continue;
    area += len;
    const top = Math.max(p[a + 1], p[b + 1], p[c + 1]);
    if (ny / len < -Math.SQRT1_2 && top > floor + cellSize * 1.5) down += len;
  }
  return { volume, centre, floor, footprint, stable: stabilityMargin > 0, stabilityMargin, pieces, overhang: area > 0 ? down / area : 0 };
}
