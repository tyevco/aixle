/**
 * The visibility filter: a joint bilateral filter over each light's visibility, guided by what the primary rays saw
 * (depth, the field's normal, the material and whether a pixel is the model or the floor), so the eight rays an area
 * light takes per pixel read as a smooth penumbra and never blur across a silhouette or a crease.
 *
 * A neighbour within the radius counts when it has the centre's material and kind, is not an edge pixel, and its
 * normal is within acos(0.8) of the centre's; its weight is a Gaussian of the distance in pixels (sigma half the
 * radius), times exp(-(depth step / 2 cells)^2) (none past 6.9 cells), times the normals' dot to the 16th.
 *
 * It filters visibility only, a ratio between 0 and 1 per light. The light's unshadowed term (Lambert and the
 * highlight, with the bump's normal and the texture in it) is multiplied in after, at full resolution: filtering the
 * whole diffuse term washed the bump out of the door's stone (accel's door_v2_crop), since the guides see the field's
 * normal and not the bump's.
 *
 * Edge pixels, which take four subsamples of their own, neither give nor take. Sums run in a fixed order and every
 * row reads only the unfiltered input, so rows are independent and a split of the rows between threads cannot change
 * a value. Measured on one thread: 0.12 s at 384 and 0.95 s at 768 for one value a pixel, 1.2 s at 768 for three.
 */

/** The flags byte per pixel, as the filter reads it: bits 0 and 1 the kind, bit 2 an edge pixel. */
export const KIND_MASK = 0x03;
export const KIND_SKY = 0;
export const KIND_MODEL = 1;
export const KIND_FLOOR = 2;
export const FLAG_EDGE = 0x04;

/** What the primary rays saw, per pixel, that the filter is guided by. */
export interface FilterGuides {
  /** Distance along the camera ray. */
  depth: Float32Array | Float64Array;
  /** The field's unit normal, three per pixel (not a bump's). */
  normal: Float32Array | Float64Array;
  /** The material's id; the floor and the sky have their own. */
  mat: Int32Array;
  /** KIND_MASK and FLAG_EDGE as above; the kernel may keep its own bits in the rest. */
  flags: Uint8Array;
}

/** The filter's radius in pixels at a picture size: 3 at 384, 4 at 512, 6 at 768, never under 2. */
export function filterRadius(size: number): number {
  return Math.max(2, Math.round((3 * size) / 384));
}

/** Depth differences are measured in this many cells; normals must agree to this dot product and are weighted by its power. */
const DEPTH_CELLS = 2;
const NORMAL_MIN = 0.8;

/**
 * The depth weight exp(-q) for q = (depth step / 2 cells) squared, from a table: 64 entries a unit of q over [0, 12),
 * read between entries, and 0 beyond (exp(-12) is 6e-6). Math.exp per tap was most of the filter's time at 768.
 */
const DEPTH_STEPS = 64, DEPTH_MAX = 12;
const DEPTH_TABLE = (() => {
  const t = new Float64Array(DEPTH_MAX * DEPTH_STEPS + 2);
  for (let k = 0; k < t.length; k++) t[k] = Math.exp(-k / DEPTH_STEPS);
  return t;
})();

/**
 * Filter visibility V (`stride` values per pixel: one per light, or three per light for coloured shadows) into
 * `out` for rows [y0, y1). Every value of a pixel shares the pixel's weights. A sky or edge pixel is copied.
 */
export function filterVisibilityRows(V: Float32Array, stride: number, g: FilterGuides, size: number, cell: number, out: Float32Array, y0: number, y1: number, radius = filterRadius(size)): void {
  const R = radius, W = 2 * R + 1;
  const sigma = R / 2;
  const wsp = new Float64Array(W * W);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) wsp[(dy + R) * W + dx + R] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
  const acc = new Float64Array(stride);
  const depthScale = 1 / (cell * DEPTH_CELLS);
  const qMax = DEPTH_MAX * DEPTH_STEPS;
  const T = DEPTH_TABLE;
  const { depth, normal, mat, flags } = g;
  for (let y = y0; y < y1; y++) {
    const ya = y - R < 0 ? 0 : y - R, yb = y + R >= size ? size - 1 : y + R;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fi = flags[i];
      const kind = fi & KIND_MASK;
      if (kind === KIND_SKY || fi & FLAG_EDGE) {
        for (let c = 0; c < stride; c++) out[i * stride + c] = V[i * stride + c];
        continue;
      }
      const di = depth[i], nx = normal[i * 3], ny = normal[i * 3 + 1], nz = normal[i * 3 + 2], mi = mat[i];
      const xa = x - R < 0 ? 0 : x - R, xb = x + R >= size ? size - 1 : x + R;
      let wsum = 0, a0 = 0, a1 = 0, a2 = 0;
      if (stride > 3) acc.fill(0);
      for (let yy = ya; yy <= yb; yy++) {
        const row = yy * size, wrow = (yy - y + R) * W + R - x;
        for (let xx = xa; xx <= xb; xx++) {
          const j = row + xx;
          // The same material, and the same kind and not an edge (the kind's bits and the edge bit read together).
          if (mat[j] !== mi || (flags[j] & (KIND_MASK | FLAG_EDGE)) !== kind) continue;
          const nd = nx * normal[j * 3] + ny * normal[j * 3 + 1] + nz * normal[j * 3 + 2];
          if (nd < NORMAL_MIN) continue;
          const dd = (depth[j] - di) * depthScale;
          const q = dd * dd * DEPTH_STEPS;
          if (!(q < qMax)) continue;
          const k = q | 0;
          const n2 = nd * nd, n4 = n2 * n2, n8 = n4 * n4;
          const w = wsp[wrow + xx] * (T[k] + (T[k + 1] - T[k]) * (q - k)) * n8 * n8;
          wsum += w;
          const o = j * stride;
          if (stride === 1) a0 += V[o] * w;
          else if (stride === 2) { a0 += V[o] * w; a1 += V[o + 1] * w; }
          else if (stride === 3) { a0 += V[o] * w; a1 += V[o + 1] * w; a2 += V[o + 2] * w; }
          else for (let c = 0; c < stride; c++) acc[c] += V[o + c] * w;
        }
      }
      const o = i * stride;
      // The centre pixel counts with weight about 1 unless its normal is unset; then it keeps its own value.
      if (!(wsum > 0)) for (let c = 0; c < stride; c++) out[o + c] = V[o + c];
      else if (stride <= 3) {
        out[o] = a0 / wsum;
        if (stride > 1) out[o + 1] = a1 / wsum;
        if (stride > 2) out[o + 2] = a2 / wsum;
      } else for (let c = 0; c < stride; c++) out[o + c] = acc[c] / wsum;
    }
  }
}

/** filterVisibilityRows over the whole picture, into a new array (or `out`). */
export function filterVisibility(V: Float32Array, stride: number, g: FilterGuides, size: number, cell: number, out = new Float32Array(V.length), radius = filterRadius(size)): Float32Array {
  filterVisibilityRows(V, stride, g, size, cell, out, 0, size, radius);
  return out;
}
