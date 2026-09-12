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

/** Quintic fade: zero first and second derivatives at the lattice, so no creases show along cell faces. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** The dot product of a pseudo-random unit-ish gradient at a lattice point with the offset from it. */
function grad(ix: number, iy: number, iz: number, seed: number, dx: number, dy: number, dz: number): number {
  // Twelve edge directions of a cube, picked by the hash: the classic set, so no direction is favoured.
  const h = (hash(ix, iy, iz, seed) * 12) | 0;
  const u = h < 8 ? dx : dy;
  const v = h < 4 ? dy : h === 12 || h === 14 ? dx : dz;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/**
 * Gradient (Perlin) noise in [0, 1], centred on 0.5, period-free, with
 * features about one unit across. Value noise before this: its blotches
 * sat on the lattice and read as patches on a lily pad's skin and bands
 * in a marble's veins (measured on the round-4 frog's atlas); gradient
 * noise has no value at the lattice points to show.
 */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const dx = x - ix, dy = y - iy, dz = z - iz;
  const fx = fade(dx), fy = fade(dy), fz = fade(dz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const n000 = grad(ix, iy, iz, seed, dx, dy, dz), n100 = grad(ix + 1, iy, iz, seed, dx - 1, dy, dz);
  const n010 = grad(ix, iy + 1, iz, seed, dx, dy - 1, dz), n110 = grad(ix + 1, iy + 1, iz, seed, dx - 1, dy - 1, dz);
  const n001 = grad(ix, iy, iz + 1, seed, dx, dy, dz - 1), n101 = grad(ix + 1, iy, iz + 1, seed, dx - 1, dy, dz - 1);
  const n011 = grad(ix, iy + 1, iz + 1, seed, dx, dy - 1, dz - 1), n111 = grad(ix + 1, iy + 1, iz + 1, seed, dx - 1, dy - 1, dz - 1);
  const v = l(
    l(l(n000, n100, fx), l(n010, n110, fx), fy),
    l(l(n001, n101, fx), l(n011, n111, fx), fy),
    fz,
  );
  // Gradient noise with these directions stays within about +-1; map to 0..1 about the middle.
  return Math.max(0, Math.min(1, 0.5 + v * 0.5));
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
