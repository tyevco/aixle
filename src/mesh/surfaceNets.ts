/**
 * Surface extraction by naive surface nets.
 *
 * The field is sampled on a lattice over the shape's bounds (plus a margin so
 * the surface never touches the edge). Every cell whose corners disagree on
 * sign gets one vertex, placed at the mean of the sign changes along its
 * edges; every lattice edge with a sign change becomes a quad joining the
 * four cells around it. The result is closed and manifold for any field, and
 * unlike marching cubes it has no lookup table to get wrong. Vertex normals
 * come from the field's gradient, and the material query runs once per
 * vertex, which is where the render and the exporters get their colours.
 *
 * `resolution` is the number of cells along the longest side; the cell is
 * cubic. Detail thinner than a cell is lost, so a report line says what the
 * cell size was.
 */
import { boundsGrow, boundsSize, isEmpty, type Material, type Shape3 } from "../sdf/types.js";
import type { Mesh } from "./mesh.js";

export interface NetsOptions {
  resolution: number;
  /** Extra cells around the bounds, default 2. */
  margin?: number;
  /** Cap on cells along any side, default 512. */
  maxCells?: number;
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
  if (isEmpty(shape.bounds)) return empty();
  const size = boundsSize(shape.bounds);
  const longest = Math.max(size[0], size[1], size[2]);
  if (!(longest > 0)) return empty();
  const margin = opts.margin ?? 2;
  const cell = longest / opts.resolution;
  const grown = boundsGrow(shape.bounds, cell * margin);
  const maxCells = opts.maxCells ?? 512;
  const nx = Math.min(maxCells, Math.ceil((grown.max[0] - grown.min[0]) / cell));
  const ny = Math.min(maxCells, Math.ceil((grown.max[1] - grown.min[1]) / cell));
  const nz = Math.min(maxCells, Math.ceil((grown.max[2] - grown.min[2]) / cell));
  const ox = grown.min[0], oy = grown.min[1], oz = grown.min[2];
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

  // One vertex per crossing cell.
  const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [];
  const cellIndex = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  const EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], // along x
    [0, 2], [1, 3], [4, 6], [5, 7], // along y
    [0, 4], [1, 5], [2, 6], [3, 7], // along z
  ];
  const corner = new Float64Array(8);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 0xff) continue;
        let px = 0, py = 0, pz = 0, count = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1;
          const bx = b & 1, by = (b >> 1) & 1, bz = (b >> 2) & 1;
          px += ax + (bx - ax) * t;
          py += ay + (by - ay) * t;
          pz += az + (bz - az) * t;
          count++;
        }
        cellVertex[cellIndex(i, j, k)] = positions.length / 3;
        positions.push(ox + (i + px / count) * cell, oy + (j + py / count) * cell, oz + (k + pz / count) * cell);
      }

  // One quad per crossing lattice edge, wound so the normal points from inside to outside.
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
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
  const eps = cell * 0.5;
  for (let v = 0; v < n; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let gx = dist(x + eps, y, z) - dist(x - eps, y, z);
    let gy = dist(x, y + eps, z) - dist(x, y - eps, z);
    let gz = dist(x, y, z + eps) - dist(x, y, z - eps);
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    gx /= l; gy /= l; gz /= l;
    normals[v * 3] = gx; normals[v * 3 + 1] = gy; normals[v * 3 + 2] = gz;
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

  // Fix the winding against the normals where the quad orientation and the
  // gradient disagree (they should agree everywhere, but a degenerate cell
  // can produce a sliver the other way; the cheap check keeps exports clean).
  const ix = new Uint32Array(indices);
  const p = positions;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx_ = normals[a] + normals[b] + normals[c];
    const ny_ = normals[a + 1] + normals[b + 1] + normals[c + 1];
    const nz_ = normals[a + 2] + normals[b + 2] + normals[c + 2];
    if (fx * nx_ + fy * ny_ + fz * nz_ < 0) {
      const tmp = ix[t + 1];
      ix[t + 1] = ix[t + 2];
      ix[t + 2] = tmp;
    }
  }

  return {
    mesh: { positions: new Float32Array(positions), normals, local, materialIndex, materials, indices: ix },
    cellSize: cell,
    dims: [nx, ny, nz],
    samples: field.length,
    nanSamples,
  };
}
