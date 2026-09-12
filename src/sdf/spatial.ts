/**
 * A uniform grid over a set of boxed pieces, so a distance query touches
 * only the pieces near the point. Built once per shape from the pieces'
 * bounding boxes (each grown so it contains the piece's whole surface).
 *
 * Each cell lists the pieces whose box comes within a cell of it, and
 * carries a floor: the smallest distance from anywhere in the cell to the
 * box of any piece NOT listed. A query evaluates the listed pieces, and
 * only if the floor is below the best so far (an unlisted piece could
 * still be nearer) scans the unlisted ones with the ordinary box cull. The
 * result is therefore exact everywhere, and cheap where it matters: near
 * the surface the floor is far above the best and the scan never runs.
 * A first version returned the floor itself as a lower bound instead of
 * scanning; that is sign-exact and never overestimates, which extraction
 * accepts, but the beauty render's soft shadows read the cell-shaped
 * shortfall as nearby geometry and drew the grid on the floor.
 */
export type PieceDist = (i: number, x: number, y: number, z: number) => number;

export interface SpatialIndex {
  /** The exact minimum over all pieces of `piece(i, x, y, z)`, using `boxDist` (a lower bound per piece) to skip. */
  min(x: number, y: number, z: number, piece: PieceDist, boxDist: PieceDist, init: number): number;
  inside(x: number, y: number, z: number): boolean;
  /** Cell index for a point inside the grid. */
  cell(x: number, y: number, z: number): number;
  /** Start and end offsets into `items` for a cell. */
  start: Int32Array;
  items: Int32Array;
  floor: Float64Array;
}

/**
 * Build over pieces with boxes `bmin`/`bmax` (xyz per piece), covering
 * `cover` (min, max) with about `cellsPerAxis` cells on the longest side.
 */
export function buildSpatialIndex(n: number, bmin: Float64Array, bmax: Float64Array, cover: { min: number[]; max: number[] }, cellsPerAxis: number): SpatialIndex {
  const size = [cover.max[0] - cover.min[0], cover.max[1] - cover.min[1], cover.max[2] - cover.min[2]];
  const longest = Math.max(size[0], size[1], size[2], 1e-9);
  const cell = longest / cellsPerAxis;
  const nx = Math.max(1, Math.ceil(size[0] / cell)), ny = Math.max(1, Math.ceil(size[1] / cell)), nz = Math.max(1, Math.ceil(size[2] / cell));
  const ox = cover.min[0], oy = cover.min[1], oz = cover.min[2];
  const cells = nx * ny * nz;
  // Count, then fill (CSR).
  const count = new Int32Array(cells);
  // A piece is listed in every cell within one cell of its box, so any
  // point closer than a cell to a piece evaluates it exactly; the floor
  // then only stands in for pieces at least a cell away.
  const range = (i: number): [number, number, number, number, number, number] => [
    Math.max(0, Math.floor((bmin[i * 3] - ox) / cell) - 1), Math.min(nx - 1, Math.floor((bmax[i * 3] - ox) / cell) + 1),
    Math.max(0, Math.floor((bmin[i * 3 + 1] - oy) / cell) - 1), Math.min(ny - 1, Math.floor((bmax[i * 3 + 1] - oy) / cell) + 1),
    Math.max(0, Math.floor((bmin[i * 3 + 2] - oz) / cell) - 1), Math.min(nz - 1, Math.floor((bmax[i * 3 + 2] - oz) / cell) + 1),
  ];
  for (let i = 0; i < n; i++) {
    const [x0, x1, y0, y1, z0, z1] = range(i);
    for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) for (let ii = x0; ii <= x1; ii++) count[(k * ny + j) * nx + ii]++;
  }
  const start = new Int32Array(cells + 1);
  for (let c = 0; c < cells; c++) start[c + 1] = start[c] + count[c];
  const items = new Int32Array(start[cells]);
  const fill = new Int32Array(cells);
  for (let i = 0; i < n; i++) {
    const [x0, x1, y0, y1, z0, z1] = range(i);
    for (let k = z0; k <= z1; k++)
      for (let j = y0; j <= y1; j++)
        for (let ii = x0; ii <= x1; ii++) {
          const c = (k * ny + j) * nx + ii;
          items[start[c] + fill[c]++] = i;
        }
  }
  // Floors: distance from each cell's box to the nearest unlisted piece
  // box; and the NEAR nearest unlisted pieces, so a far-field scan tries
  // the likely winners first and the box cull rejects the rest.
  const NEAR = 8;
  const floor = new Float64Array(cells).fill(Infinity);
  const near = new Int32Array(cells * NEAR).fill(-1);
  const listed = new Uint8Array(n);
  const bestIds = new Int32Array(NEAR), bestDs = new Float64Array(NEAR);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let ii = 0; ii < nx; ii++) {
        const c = (k * ny + j) * nx + ii;
        for (let s = start[c]; s < start[c + 1]; s++) listed[items[s]] = 1;
        const cx0 = ox + ii * cell, cx1 = cx0 + cell, cy0 = oy + j * cell, cy1 = cy0 + cell, cz0 = oz + k * cell, cz1 = cz0 + cell;
        let found = 0;
        bestDs.fill(Infinity);
        bestIds.fill(-1);
        for (let i = 0; i < n; i++) {
          if (listed[i]) continue;
          const dx = Math.max(bmin[i * 3] - cx1, 0, cx0 - bmax[i * 3]);
          const dy = Math.max(bmin[i * 3 + 1] - cy1, 0, cy0 - bmax[i * 3 + 1]);
          const dz = Math.max(bmin[i * 3 + 2] - cz1, 0, cz0 - bmax[i * 3 + 2]);
          const d = dx * dx + dy * dy + dz * dz;
          if (d >= bestDs[NEAR - 1]) continue;
          // Insertion into the small sorted list.
          let pos = Math.min(found, NEAR - 1);
          while (pos > 0 && bestDs[pos - 1] > d) { bestDs[pos] = bestDs[pos - 1]; bestIds[pos] = bestIds[pos - 1]; pos--; }
          bestDs[pos] = d; bestIds[pos] = i;
          if (found < NEAR) found++;
        }
        floor[c] = Math.sqrt(bestDs[0]);
        for (let q = 0; q < NEAR; q++) near[c * NEAR + q] = bestIds[q];
        for (let s = start[c]; s < start[c + 1]; s++) listed[items[s]] = 0;
      }
  const inv = 1 / cell;
  const mark = new Uint8Array(n);
  const index: SpatialIndex = {
    inside: (x, y, z) => x >= ox && y >= oy && z >= oz && x < ox + nx * cell && y < oy + ny * cell && z < oz + nz * cell,
    cell: (x, y, z) => (Math.floor((z - oz) * inv) * ny + Math.floor((y - oy) * inv)) * nx + Math.floor((x - ox) * inv),
    start,
    items,
    floor,
    min: (x, y, z, piece, boxDist, init) => {
      let best = init;
      if (!index.inside(x, y, z)) {
        for (let i = 0; i < n; i++) {
          if (boxDist(i, x, y, z) >= best) continue;
          const d = piece(i, x, y, z);
          if (d < best) best = d;
        }
        return best;
      }
      const c = index.cell(x, y, z);
      const s0 = start[c], s1 = start[c + 1];
      for (let s = s0; s < s1; s++) {
        const i = items[s];
        if (boxDist(i, x, y, z) >= best) continue;
        const d = piece(i, x, y, z);
        if (d < best) best = d;
      }
      if (floor[c] >= best) return best;
      for (let s = s0; s < s1; s++) mark[items[s]] = 1;
      // The likely winners first, so the cull below has a tight bound.
      for (let q = 0; q < NEAR; q++) {
        const i = near[c * NEAR + q];
        if (i < 0) break;
        mark[i] = 1;
        if (boxDist(i, x, y, z) >= best) continue;
        const d = piece(i, x, y, z);
        if (d < best) best = d;
      }
      for (let i = 0; i < n; i++) {
        if (mark[i] || boxDist(i, x, y, z) >= best) continue;
        const d = piece(i, x, y, z);
        if (d < best) best = d;
      }
      for (let s = s0; s < s1; s++) mark[items[s]] = 0;
      for (let q = 0; q < NEAR; q++) { const i = near[c * NEAR + q]; if (i < 0) break; mark[i] = 0; }
      return best;
    },
  };
  return index;
}

/**
 * Cells per axis for `n` pieces: fine enough that the floor's slack (up to
 * a cell) is a few percent of the model, coarse enough that the build
 * (cells times pieces) stays in the tens of milliseconds.
 */
export function cellsFor(n: number): number {
  return Math.max(12, Math.min(40, Math.round(Math.cbrt(n) * 6)));
}
