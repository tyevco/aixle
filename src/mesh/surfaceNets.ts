/**
 * Surface extraction by surface nets, with dual contouring for sharp edges.
 *
 * The field is sampled on a lattice over the shape's bounds (plus a margin so
 * the surface never touches the edge). Every cell whose corners disagree on
 * sign gets one vertex; every lattice edge with a sign change becomes a quad
 * joining the four cells around it. The result is closed and manifold for
 * any field, and unlike marching cubes it has no lookup table to get wrong.
 *
 * Vertex placement is where the two methods differ. Naive surface nets put
 * the vertex at the mean of the edge crossings, which rounds every edge to
 * about a cell. With `sharp` (the default) the vertex minimises the squared
 * distance to the tangent planes at the crossings (the gradient at each
 * crossing is the plane's normal), which puts a box's vertex exactly on its
 * corner and a gear tooth's on its edge. The solve is regularised towards
 * the mean and clamped to the cell, so it cannot wander.
 *
 * Vertex normals come from the field's gradient, and the material query runs
 * once per vertex, which is where the render and the exporters get colours.
 *
 * `resolution` is the number of cells along the longest side; the cell is
 * cubic. Detail thinner than a cell is lost, so a report line says what the
 * cell size was.
 */
import { boundsGrow, boundsSize, isEmpty, type Material, type Shape3, type Bounds } from "../sdf/types.js";
import type { Mesh } from "./mesh.js";

export interface NetsOptions {
  resolution: number;
  /** Extra cells around the bounds, default 2. */
  margin?: number;
  /** Cap on cells along any side, default 512. */
  maxCells?: number;
  /** Place vertices by the tangent-plane fit (dual contouring). Default true. */
  sharp?: boolean;
  /** Extract over this box instead of the shape's bounds: a tighter box found from a coarse pass, or a close-up region. */
  bounds?: Bounds;
}

export interface NetsResult {
  mesh: Mesh;
  cellSize: number;
  dims: [number, number, number];
  samples: number;
  /** Samples that were NaN: a sign of a zero blend radius or scale somewhere. */
  nanSamples: number;
}

export function surfaceNets(shape: Shape3, opts: NetsOptions): NetsResult {
  const empty = (): NetsResult => ({
    mesh: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      local: new Float32Array(0),
      materialIndex: new Uint16Array(0),
      materials: [],
      indices: new Uint32Array(0),
    },
    cellSize: 0,
    dims: [0, 0, 0],
    samples: 0,
    nanSamples: 0,
  });
  const box = opts.bounds ?? shape.bounds;
  if (isEmpty(box)) return empty();
  const size = boundsSize(box);
  const longest = Math.max(size[0], size[1], size[2]);
  if (!(longest > 0)) return empty();
  const margin = opts.margin ?? 2;
  const cell = longest / opts.resolution;
  const grown = boundsGrow(box, cell * margin);
  const maxCells = opts.maxCells ?? 512;
  const nx = Math.min(maxCells, Math.ceil((grown.max[0] - grown.min[0]) / cell));
  const ny = Math.min(maxCells, Math.ceil((grown.max[1] - grown.min[1]) / cell));
  const nz = Math.min(maxCells, Math.ceil((grown.max[2] - grown.min[2]) / cell));
  // The lattice starts 0.37 of a cell before the grown box rather than on it, so a face at a round coordinate
  // (a plank's edge at x = 3.94, a chess piece's base at y = 0.15) does not sit exactly on a sample plane, where
  // the extractor cannot resolve it and leaves open edges (measured on a bridge's re-import and a bicycle's tube).
  const ox = grown.min[0] - cell * 0.37, oy = grown.min[1] - cell * 0.37, oz = grown.min[2] - cell * 0.37;
  const sx = nx + 1, sy = ny + 1, sz = nz + 1;
  const field = new Float32Array(sx * sy * sz);
  const dist = shape.dist;
  let idx = 0;
  let nanSamples = 0;
  for (let k = 0; k < sz; k++) {
    const z = oz + k * cell;
    for (let j = 0; j < sy; j++) {
      const y = oy + j * cell;
      for (let i = 0; i < sx; i++) {
        const v = dist(ox + i * cell, y, z);
        if (v !== v) nanSamples++;
        field[idx++] = v;
      }
    }
  }
  const at = (i: number, j: number, k: number): number => field[(k * sy + j) * sx + i];

  const sharp = opts.sharp !== false;
  const eps = cell * 0.5;
  const gradient = (x: number, y: number, z: number, out: Float64Array, o: number): void => {
    let gx = dist(x + eps, y, z) - dist(x - eps, y, z);
    let gy = dist(x, y + eps, z) - dist(x, y - eps, z);
    let gz = dist(x, y, z + eps) - dist(x, y, z - eps);
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    out[o] = gx / l; out[o + 1] = gy / l; out[o + 2] = gz / l;
  };

  // Crossing point (and, for sharp placement, normal) per crossing lattice
  // edge, computed once and shared by the four cells around the edge.
  const edgeKey = (i: number, j: number, k: number, axis: number): number => ((k * sy + j) * sx + i) * 3 + axis;
  const crossings = new Map<number, number>();
  let cx: number[] = [], cy: number[] = [], cz: number[] = [];
  let cn = new Float64Array(0);
  const cnList: number[] = [];
  const crossing = (i: number, j: number, k: number, axis: number): number => {
    const key = edgeKey(i, j, k, axis);
    let id = crossings.get(key);
    if (id !== undefined) return id;
    const va = at(i, j, k);
    const vb = axis === 0 ? at(i + 1, j, k) : axis === 1 ? at(i, j + 1, k) : at(i, j, k + 1);
    const t = va / (va - vb);
    const x = ox + (i + (axis === 0 ? t : 0)) * cell;
    const y = oy + (j + (axis === 1 ? t : 0)) * cell;
    const z = oz + (k + (axis === 2 ? t : 0)) * cell;
    id = cx.length;
    cx.push(x); cy.push(y); cz.push(z);
    if (sharp) {
      const g = new Float64Array(3);
      gradient(x, y, z, g, 0);
      cnList.push(g[0], g[1], g[2]);
    }
    crossings.set(key, id);
    return id;
  };

  // One vertex per crossing cell.
  const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [];
  const cellIndex = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  // The 12 cell edges as (corner offset, axis).
  const EDGES: [number, number, number, number][] = [
    [0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 1, 1, 0],
    [0, 0, 0, 1], [1, 0, 0, 1], [0, 0, 1, 1], [1, 0, 1, 1],
    [0, 0, 0, 2], [1, 0, 0, 2], [0, 1, 0, 2], [1, 1, 0, 2],
  ];
  const ids: number[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) if (at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)) < 0) mask |= 1 << c;
        if (mask === 0 || mask === 0xff) continue;
        ids.length = 0;
        for (const [di, dj, dk, axis] of EDGES) {
          const ci = i + di, cj = j + dj, ck = k + dk;
          const va = at(ci, cj, ck);
          const vb = axis === 0 ? at(ci + 1, cj, ck) : axis === 1 ? at(ci, cj + 1, ck) : at(ci, cj, ck + 1);
          if ((va < 0) === (vb < 0)) continue;
          ids.push(crossing(ci, cj, ck, axis));
        }
        // Mass point.
        let mx = 0, my = 0, mz = 0;
        for (const id of ids) { mx += cx[id]; my += cy[id]; mz += cz[id]; }
        mx /= ids.length; my /= ids.length; mz /= ids.length;
        let px = mx, py = my, pz = mz;
        if (sharp) {
          // Minimise sum (n . (p - c))^2 + lambda |p - m|^2 : (N + lambda I) p = b + lambda m.
          const lambda = 0.05;
          let a00 = lambda, a01 = 0, a02 = 0, a11 = lambda, a12 = 0, a22 = lambda;
          let b0 = lambda * mx, b1 = lambda * my, b2 = lambda * mz;
          for (const id of ids) {
            const nx_ = cnList[id * 3], ny_ = cnList[id * 3 + 1], nz_ = cnList[id * 3 + 2];
            const d = nx_ * cx[id] + ny_ * cy[id] + nz_ * cz[id];
            a00 += nx_ * nx_; a01 += nx_ * ny_; a02 += nx_ * nz_;
            a11 += ny_ * ny_; a12 += ny_ * nz_; a22 += nz_ * nz_;
            b0 += nx_ * d; b1 += ny_ * d; b2 += nz_ * d;
          }
          const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
          if (Math.abs(det) > 1e-12) {
            const i00 = (a11 * a22 - a12 * a12) / det, i01 = (a02 * a12 - a01 * a22) / det, i02 = (a01 * a12 - a02 * a11) / det;
            const i11 = (a00 * a22 - a02 * a02) / det, i12 = (a02 * a01 - a00 * a12) / det, i22 = (a00 * a11 - a01 * a01) / det;
            px = i00 * b0 + i01 * b1 + i02 * b2;
            py = i01 * b0 + i11 * b1 + i12 * b2;
            pz = i02 * b0 + i12 * b1 + i22 * b2;
            // Keep it inside the cell (a hair of slack so a corner on the boundary is allowed).
            const x0 = ox + i * cell, y0 = oy + j * cell, z0 = oz + k * cell, slack = cell * 0.01;
            px = Math.max(x0 - slack, Math.min(x0 + cell + slack, px));
            py = Math.max(y0 - slack, Math.min(y0 + cell + slack, py));
            pz = Math.max(z0 - slack, Math.min(z0 + cell + slack, pz));
          }
        }
        cellVertex[cellIndex(i, j, k)] = positions.length / 3;
        positions.push(px, py, pz);
      }
  cn = new Float64Array(cnList);
  void cn;

  // One quad per crossing lattice edge, wound so the normal points from inside to outside.
  const indices: number[] = [];
  const dist2 = (p: number, q: number): number => {
    const dx = positions[p * 3] - positions[q * 3], dy = positions[p * 3 + 1] - positions[q * 3 + 1], dz = positions[p * 3 + 2] - positions[q * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  // Split each quad along its shorter diagonal, which keeps a quad that a
  // sharp corner has bent from folding over itself.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (dist2(a, c) <= dist2(b, d)) {
      if (flip) indices.push(a, c, b, a, d, c);
      else indices.push(a, b, c, a, c, d);
    } else {
      if (flip) indices.push(b, d, c, b, a, d);
      else indices.push(b, c, d, b, d, a);
    }
  };
  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++) {
        const v0 = at(i, j, k);
        const inside0 = v0 < 0;
        // Edge along x from (i,j,k) to (i+1,j,k): cells around it vary in j-1..j, k-1..k.
        if (i < nx && j > 0 && k > 0 && j < ny && k < nz) {
          const v1 = at(i + 1, j, k);
          if ((v1 < 0) !== inside0) {
            quad(
              cellVertex[cellIndex(i, j - 1, k - 1)],
              cellVertex[cellIndex(i, j, k - 1)],
              cellVertex[cellIndex(i, j, k)],
              cellVertex[cellIndex(i, j - 1, k)],
              !inside0,
            );
          }
        }
        // Edge along y.
        if (j < ny && i > 0 && k > 0 && i < nx && k < nz) {
          const v1 = at(i, j + 1, k);
          if ((v1 < 0) !== inside0) {
            quad(
              cellVertex[cellIndex(i - 1, j, k - 1)],
              cellVertex[cellIndex(i - 1, j, k)],
              cellVertex[cellIndex(i, j, k)],
              cellVertex[cellIndex(i, j, k - 1)],
              !inside0,
            );
          }
        }
        // Edge along z.
        if (k < nz && i > 0 && j > 0 && i < nx && j < ny) {
          const v1 = at(i, j, k + 1);
          if ((v1 < 0) !== inside0) {
            quad(
              cellVertex[cellIndex(i - 1, j - 1, k)],
              cellVertex[cellIndex(i, j - 1, k)],
              cellVertex[cellIndex(i, j, k)],
              cellVertex[cellIndex(i - 1, j, k)],
              !inside0,
            );
          }
        }
      }

  // Normals from the gradient, materials from the hit query.
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3);
  const local = new Float32Array(n * 3);
  const materialIndex = new Uint16Array(n);
  const materials: Material[] = [];
  const matIds = new Map<Material, number>();
  const g = new Float64Array(3);
  for (let v = 0; v < n; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    gradient(x, y, z, g, 0);
    normals[v * 3] = g[0]; normals[v * 3 + 1] = g[1]; normals[v * 3 + 2] = g[2];
    const h = shape.hit(x, y, z);
    local[v * 3] = h.lx; local[v * 3 + 1] = h.ly; local[v * 3 + 2] = h.lz;
    let id = matIds.get(h.mat);
    if (id === undefined) {
      id = materials.length;
      materials.push(h.mat);
      matIds.set(h.mat, id);
    }
    materialIndex[v] = id;
  }

  const ix = new Uint32Array(indices);

  return {
    mesh: { positions: new Float32Array(positions), normals, local, materialIndex, materials, indices: ix },
    cellSize: cell,
    dims: [nx, ny, nz],
    samples: field.length,
    nanSamples,
  };
}
