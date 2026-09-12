/**
 * Seeded value noise and fractal sums. Used by the displace modifier and by
 * the procedural materials (wood grain, marble veins, speckle). Deterministic:
 * the same point and seed always give the same value, so renders are
 * reproducible byte for byte.
 */

function hash(ix: number, iy: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Value noise in [0, 1], smooth, period-free, with features about one unit across. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c000 = hash(ix, iy, iz, seed), c100 = hash(ix + 1, iy, iz, seed);
  const c010 = hash(ix, iy + 1, iz, seed), c110 = hash(ix + 1, iy + 1, iz, seed);
  const c001 = hash(ix, iy, iz + 1, seed), c101 = hash(ix + 1, iy, iz + 1, seed);
  const c011 = hash(ix, iy + 1, iz + 1, seed), c111 = hash(ix + 1, iy + 1, iz + 1, seed);
  return l(
    l(l(c000, c100, fx), l(c010, c110, fx), fy),
    l(l(c001, c101, fx), l(c011, c111, fx), fy),
    fz,
  );
}

/** Fractal (octave-summed) noise in [0, 1]. */
export function fbm3(x: number, y: number, z: number, seed = 0, octaves = 4): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** White noise in [0, 1) on the integer lattice; for speckle. */
export function white3(x: number, y: number, z: number, seed = 0): number {
  return hash(Math.floor(x), Math.floor(y), Math.floor(z), seed);
}
